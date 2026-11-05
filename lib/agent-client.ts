/**
 * M31: the TypeScript client of the roost agent protocol (docs/protocol.md): a job's
 * identity from its environment, reports (a full snapshot each time, coalesced, resent
 * after a daemon restart), replies delivered on the reporting connection and acked by
 * seq. pi's worker is built on it; so can any agent written in TypeScript. It imports
 * no agent's packages.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJobEnv } from "./identity.ts";
import { writeJsonAtomic } from "./atomic.ts";
import type { BoardTask } from "./board.ts";
import { DaemonClient } from "./client.ts";
import { type ArgsOf, type Event, type HelloArgs, type HelloResult, type Op, PROTOCOL_VERSION, type ResultOf, type WorkerReport } from "./protocol.ts";
import { sameUsage } from "./usage.ts";
import { SUMMARY_INTERVAL_MS, sameContext, stateChanged } from "./worker-state.ts";

/** A delivered reply or agent item (M9 adds the kind). */
export type DeliverItem = Pick<Extract<Event, { event: "deliver" }>, "seq" | "text" | "kind" | "from" | "relation" | "mode">;

export interface JobIdentity {
	id: string;
	token: string;
	socket: string;
}

const SAVED = Symbol.for("pi-roost.jobIdentity");

/**
 * Set in a worker's environment by the PTY host. The token is removed from the
 * environment once read (M9), so a /reload finds the identity kept in this process.
 */
export function jobIdentity(env: NodeJS.ProcessEnv = process.env): JobIdentity | undefined {
	const id = readJobEnv(env, "id");
	const token = readJobEnv(env, "token");
	const socket = readJobEnv(env, "socket");
	const g = globalThis as { [SAVED]?: JobIdentity };
	if (id && token && socket) {
		if (env === process.env) g[SAVED] = { id, token, socket };
		return { id, token, socket };
	}
	return env === process.env && g[SAVED]?.id === id ? g[SAVED] : undefined;
}

const REQUEST_TIMEOUT_MS = 4000;
const FINAL_FLUSH_MS = 500;

/**
 * Sends the latest report, one request at a time, reconnecting after daemon
 * restarts; never throws. State changes go out at once, row text at most
 * every SUMMARY_INTERVAL_MS.
 */
export class Reporter {
	private client: DaemonClient | undefined;
	private latest: WorkerReport | undefined;
	private sent: WorkerReport | undefined;
	private sentAt = 0;
	private urgentPending = false;
	private timer: NodeJS.Timeout | undefined;
	private dueAt = Number.POSITIVE_INFINITY;
	private inflight: Promise<void> | undefined;
	private retryMs = 500;
	/** M22: after a failed request nothing goes out before this (not even a state change). */
	private backoffUntil = 0;
	private closed = false;
	private job: JobIdentity;
	private onDeliver: (item: DeliverItem) => void;

	/** Row text and context use alone go out at most this often (tests shorten it). */
	private intervalMs: number;

	/** M31: said on every new connection before the first report. */
	private hello: HelloArgs | undefined;
	/** M31: what the daemon answered (undefined: no answer yet, or a daemon from before M31). */
	daemonHello: HelloResult | undefined;

	constructor(job: JobIdentity, onDeliver: (item: DeliverItem) => void = () => {}, intervalMs = SUMMARY_INTERVAL_MS, hello?: HelloArgs) {
		this.job = job;
		this.onDeliver = onDeliver;
		this.intervalMs = intervalMs;
		this.hello = hello;
	}

	/** `urgent`: send now even when only the row text changed (a model summary). */
	update(report: WorkerReport, urgent = false): void {
		this.latest = report;
		if (urgent) this.urgentPending = true;
		this.schedule();
	}

	/** Send what is pending (bounded wait), then disconnect. */
	async close(): Promise<void> {
		if (this.closed) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.latest && this.latest !== this.sent) {
			await Promise.race([this.drain(), new Promise((r) => setTimeout(r, FINAL_FLUSH_MS))]);
		}
		this.closed = true;
		clearTimeout(this.timer);
		this.client?.close();
		this.client = undefined;
	}

	private async drain(): Promise<void> {
		while (!this.closed && this.latest && this.latest !== this.sent) {
			await (this.inflight ?? this.send());
			if (this.latest !== this.sent) await new Promise((r) => setTimeout(r, 50));
		}
	}

	private schedule(): void {
		if (this.closed || this.inflight || !this.latest || this.latest === this.sent) return;
		const urgent = this.urgentPending || stateChanged(this.sent, this.latest);
		if (
			!urgent &&
			this.latest.summary === this.sent?.summary &&
			sameContext(this.latest.context, this.sent?.context) &&
			sameUsage(this.latest.usage, this.sent?.usage)
		)
			return;
		const due = Math.max(urgent ? Date.now() : Math.max(Date.now(), this.sentAt + this.intervalMs), this.backoffUntil);
		if (this.timer && due >= this.dueAt) return;
		clearTimeout(this.timer);
		this.dueAt = due;
		this.timer = setTimeout(() => void this.send(), due - Date.now());
		this.timer.unref?.();
	}

	private send(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dueAt = Number.POSITIVE_INFINITY;
		const report = this.latest;
		if (!report || this.closed) return Promise.resolve();
		this.urgentPending = false;
		this.inflight = this.request(report).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight.then(() => this.schedule());
	}

	/** Tell the daemon a reply reached pi; best effort, a lost ack means a resend that is deduplicated. */
	ack(seq: number, exact = false): void {
		this.client?.request("ack", { id: this.job.id, token: this.job.token, seq, ...(exact ? { exact } : {}) }).catch(() => {});
	}

	/**
	 * M9: a request on this worker's own connection, which the daemon knows as this job
	 * once a report went through on it.
	 */
	async call<O extends Op>(op: O, args: ArgsOf<O>): Promise<ResultOf<O>> {
		if (this.closed) throw new Error("this session is shutting down");
		if (!this.client || !this.sent) {
			if (this.inflight) await this.inflight;
			if ((!this.client || !this.sent) && this.latest) await this.request(this.latest);
		}
		const client = this.client;
		if (!client || !this.sent) throw new Error("the pi-roost background service is not reachable");
		return Promise.race([
			client.request(op, args),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${op} timed out`)), 15_000).unref?.()),
		]);
	}

	private async request(report: WorkerReport): Promise<void> {
		try {
			if (!this.client) {
				const fresh = await DaemonClient.connect(this.job.socket);
				// Replies come back on the connection this worker reports on.
				fresh.onEvent((e) => {
					if (e.event === "deliver" && e.id === this.job.id) this.onDeliver(e);
				});
				// A daemon restart drops the connection: report again at once so replies
				// can reach an idle worker that has nothing new to say.
				fresh.onClose(() => {
					if (this.client !== fresh) return;
					this.client = undefined;
					this.sent = undefined;
					this.schedule();
				});
				this.client = fresh;
				// M31: a daemon from before the protocol does not know hello: it reports all the same
				if (this.hello) {
					this.daemonHello = await Promise.race([
						fresh.request("hello", this.hello),
						new Promise<undefined>((r) => setTimeout(() => r(undefined), REQUEST_TIMEOUT_MS).unref?.()),
					]).catch(() => undefined);
				}
			}
			const client = this.client;
			await Promise.race([
				client.request("report", { id: this.job.id, token: this.job.token, report }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("report timed out")), REQUEST_TIMEOUT_MS).unref?.()),
			]);
			this.sent = report;
			this.sentAt = Date.now();
			this.retryMs = 500;
			this.backoffUntil = 0;
		} catch {
			const dead = this.client;
			this.client = undefined;
			dead?.close();
			if (this.closed) return;
			// The daemon may be restarting: try again with the newest report later.
			clearTimeout(this.timer);
			this.dueAt = Date.now() + this.retryMs;
			this.backoffUntil = this.dueAt;
			this.timer = setTimeout(() => void this.send(), this.retryMs);
			this.timer.unref?.();
			this.retryMs = Math.min(this.retryMs * 2, 5000);
		}
	}
}


/** M31: a reply as an agent sees it: once each, in order, acked when its handler returns. */
export interface AgentReply {
	seq: number;
	text: string;
	/** "steer": join the work under way; "followUp" or absent: after it. */
	mode?: "steer" | "followUp";
}

/** M31: the report an agent gives; what it leaves out is filled in (a full snapshot goes). */
export type AgentReport = Partial<WorkerReport> & Pick<WorkerReport, "state">;

export interface RoostAgentOptions {
	name: string;
	version?: string;
	/** What it can do (docs/protocol.md); "report" and "replies" are assumed. */
	capabilities?: string[];
	/** A user's reply; acked once this returns (or its promise settles). */
	onReply?: (reply: AgentReply) => void | Promise<void>;
	/** Defaults to this process's environment. */
	env?: NodeJS.ProcessEnv;
}

const STATUS_OF: Record<WorkerReport["state"], WorkerReport["status"]> = { working: "busy", blocked: "waiting", done: "idle", failed: "idle" };

/**
 * M31: the agent side of the protocol for an agent other than pi, in a few calls:
 *
 *     const agent = RoostAgent.fromEnv({ name: "my-agent", onReply: (r) => work(r.text) });
 *     agent?.report({ state: "working", summary: "reading the code" });
 *
 * fromEnv gives undefined outside a roost job. Replies are handed over one at a time, in
 * seq order, never twice (the daemon resends unacked ones after a reconnect).
 */
export class RoostAgent {
	private reporter: Reporter;
	/** Highest seq handed to the handler, and highest whose handler has returned (acked). */
	private handled = 0;
	private completed = 0;
	private queue: Promise<void> = Promise.resolve();
	private onReply: RoostAgentOptions["onReply"];

	/** M35: where the last finished seq is kept, so a restarted agent does not redo a reply whose ack was lost. */
	private mark: string | undefined;

	private constructor(job: JobIdentity, o: RoostAgentOptions, dir: string | undefined) {
		this.onReply = o.onReply;
		this.mark = dir ? join(dir, "agent.json") : undefined;
		if (this.mark) {
			try {
				const done = (JSON.parse(readFileSync(this.mark, "utf8")) as { handled?: unknown }).handled;
				if (typeof done === "number" && done > 0) this.handled = this.completed = done;
			} catch {}
		}
		const capabilities = [...new Set(["report", "replies", ...(o.capabilities ?? [])])];
		this.reporter = new Reporter(job, (item) => this.deliver(item), SUMMARY_INTERVAL_MS, {
			protocol: PROTOCOL_VERSION,
			agent: { name: o.name, ...(o.version ? { version: o.version } : {}) },
			capabilities,
		});
	}

	static fromEnv(o: RoostAgentOptions): RoostAgent | undefined {
		const env = o.env ?? process.env;
		const job = jobIdentity(env);
		return job ? new RoostAgent(job, o, readJobEnv(env, "dir")) : undefined;
	}

	/** Its state now; sent at once when the state changed, the row text at most every few seconds. */
	report(r: AgentReport): void {
		this.reporter.update(
			{
				status: STATUS_OF[r.state],
				waitingFor: r.state === "blocked" ? "question" : null,
				summary: null,
				question: null,
				choices: [],
				tool: null,
				error: null,
				name: null,
				model: null,
				...r,
			},
			false,
		);
	}

	/** The daemon's hello answer, once connected (undefined before, or from a daemon before M31). */
	get daemon(): HelloResult | undefined {
		return this.reporter.daemonHello;
	}

	/** Send what is pending, then disconnect. */
	close(): Promise<void> {
		return this.reporter.close();
	}

	/** M47: any op of the protocol (docs/protocol.md), as this job: answered, or refused by the daemon (an Error with its message). */
	call<O extends Op>(op: O, args: ArgsOf<O>): Promise<ResultOf<O>> {
		return this.reporter.call(op, args);
	}

	// M47: the shared task board (the `tasks` capability): open, blocked, claimed and done tasks

	/** The board, every task (open, claimed, done, dropped), oldest first. */
	async tasks(): Promise<BoardTask[]> {
		return (await this.call("task", { action: "list" })).tasks;
	}

	/** Take an open task: this job holds it until taskDone or releaseTask. Refused when another live session holds it (conflict), when it waits on tasks not done (blocked), or when it is done or dropped. */
	async claimTask(id: number): Promise<BoardTask> {
		return (await this.call("task", { action: "claim", id })).task!;
	}

	/** Mark the task this job holds done, with its result; tasks that waited on it become claimable. */
	async taskDone(id: number, result?: string): Promise<BoardTask> {
		return (await this.call("task", { action: "done", id, ...(result ? { result } : {}) })).task!;
	}

	/** Give the task this job holds back to the board (open again). */
	async releaseTask(id: number): Promise<BoardTask> {
		return (await this.call("task", { action: "release", id })).task!;
	}

	/** Put a task on the board for any session; after: task ids it waits on. */
	async addTask(title: string, opts: { detail?: string; after?: number[] } = {}): Promise<BoardTask> {
		return (await this.call("task", { action: "add", title, ...(opts.detail ? { detail: opts.detail } : {}), ...(opts.after?.length ? { after: opts.after } : {}) })).task!;
	}

	private deliver(item: DeliverItem): void {
		// agent items (peer messages) are pi's; a plain agent takes user replies only
		if (item.kind === "message" || item.kind === "report" || item.kind === "notice") return;
		if (item.seq <= this.handled) {
			// sent again (a reconnect): ack only what is finished; the rest is acked when it is
			if (item.seq <= this.completed) this.reporter.ack(item.seq);
			return;
		}
		this.handled = item.seq;
		const reply: AgentReply = { seq: item.seq, text: item.text, ...(item.mode ? { mode: item.mode } : {}) };
		this.queue = this.queue
			.then(async () => {
				try {
					await this.onReply?.(reply);
				} catch {}
			})
			.then(() => {
				this.completed = reply.seq;
				// kept before the ack: if the ack is lost with this process, the next one skips it
				if (this.mark) {
					try {
						// a process crash is what it guards against: atomic, no fsync
						writeJsonAtomic(this.mark, { handled: reply.seq }, false);
					} catch {}
				}
				this.reporter.ack(reply.seq);
			});
	}
}
