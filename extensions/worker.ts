import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { DaemonClient } from "../lib/client.ts";
import { hostControl } from "../lib/hostclient.ts";
import type { WorkerReport } from "../lib/protocol.ts";
import {
	CUSTOM_DIALOG_MS,
	FIRST_PROMPT_MS,
	SUMMARY_INTERVAL_MS,
	stateChanged,
	WorkerTracker,
} from "../lib/worker-state.ts";

export interface JobIdentity {
	id: string;
	token: string;
	socket: string;
}

/** Set in a worker's environment by the PTY host. */
export function jobIdentity(env: NodeJS.ProcessEnv = process.env): JobIdentity | undefined {
	const { PI_JOB_ID: id, PI_JOB_TOKEN: token, PI_DAEMON_SOCK: socket } = env;
	return id && token && socket ? { id, token, socket } : undefined;
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
	private timer: NodeJS.Timeout | undefined;
	private dueAt = Number.POSITIVE_INFINITY;
	private inflight: Promise<void> | undefined;
	private retryMs = 500;
	private closed = false;
	private job: JobIdentity;
	private onDeliver: (seq: number, text: string) => void;

	constructor(job: JobIdentity, onDeliver: (seq: number, text: string) => void = () => {}) {
		this.job = job;
		this.onDeliver = onDeliver;
	}

	update(report: WorkerReport): void {
		this.latest = report;
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
		const urgent = stateChanged(this.sent, this.latest);
		if (!urgent && this.latest.summary === this.sent?.summary) return;
		const due = urgent ? Date.now() : Math.max(Date.now(), this.sentAt + SUMMARY_INTERVAL_MS);
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
		this.inflight = this.request(report).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight.then(() => this.schedule());
	}

	/** Tell the daemon a reply reached pi; best effort, a lost ack means a resend that is deduplicated. */
	ack(seq: number): void {
		this.client?.request("ack", { id: this.job.id, token: this.job.token, seq }).catch(() => {});
	}

	private async request(report: WorkerReport): Promise<void> {
		try {
			if (!this.client) {
				const fresh = await DaemonClient.connect(this.job.socket);
				// Replies come back on the connection this worker reports on.
				fresh.onEvent((e) => {
					if (e.event === "deliver" && e.id === this.job.id) this.onDeliver(e.seq, e.text);
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
			}
			const client = this.client;
			await Promise.race([
				client.request("report", { id: this.job.id, token: this.job.token, report }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("report timed out")), REQUEST_TIMEOUT_MS).unref?.()),
			]);
			this.sent = report;
			this.sentAt = Date.now();
			this.retryMs = 500;
		} catch {
			const dead = this.client;
			this.client = undefined;
			dead?.close();
			if (this.closed) return;
			// The daemon may be restarting: try again with the newest report later.
			clearTimeout(this.timer);
			this.dueAt = Date.now() + this.retryMs;
			this.timer = setTimeout(() => void this.send(), this.retryMs);
			this.timer.unref?.();
			this.retryMs = Math.min(this.retryMs * 2, 5000);
		}
	}
}

const DOUBLE_PRESS_MS = 1000;

/** The host socket of this worker's own job; it sits next to the daemon socket. */
const hostSocketOf = (job: JobIdentity) => join(dirname(job.socket), `host-${job.id}.sock`);

/**
 * AT-3: keys that would leave or kill a worker detach the attached terminal
 * instead (← on an empty prompt, /exit, a double Ctrl+C or Ctrl+D).
 */
function registerDetachKeys(ctx: ExtensionContext, job: JobIdentity, dialogOpen: () => boolean): () => void {
	let lastCtrlC = 0;
	let lastCtrlD = 0;
	const detach = () => void hostControl(hostSocketOf(job), "detach").catch(() => {});
	return ctx.ui.onTerminalInput((data) => {
		if (isKeyRelease(data)) return undefined;
		// Listeners see keys before any focused component, but getEditorText() is always
		// the main editor: leave dialogs and overlays their keys.
		if (dialogOpen()) return undefined;
		if (matchesKey(data, Key.ctrl("c"))) {
			// pi clears a non-empty editor on the first press and exits on a second one
			// within 500 ms, whatever the editor held: always take the second press.
			const now = Date.now();
			const second = now - lastCtrlC < DOUBLE_PRESS_MS;
			lastCtrlC = second ? 0 : now;
			if (!second) return undefined;
			detach();
			return { consume: true };
		}
		const empty = ctx.ui.getEditorText().length === 0;
		if (matchesKey(data, Key.left) && empty) {
			detach();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter) && /^\/(?:exit|quit)$/.test(ctx.ui.getEditorText().trim())) {
			ctx.ui.setEditorText("");
			detach();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("d")) && empty) {
			// pi would exit on an empty prompt, which would end the background session
			const now = Date.now();
			if (now - lastCtrlD < DOUBLE_PRESS_MS) detach();
			else ctx.ui.notify("Ctrl+D again to detach (the session keeps running)", "info");
			lastCtrlD = now;
			return { consume: true };
		}
		return undefined;
	});
}

const RETRY_MS = 500;
const START_WAIT_MS = 10_000;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Replies from the agent view, handed to pi one at a time (PK-2, PK-4).
 * A prompt sent while idle starts a run asynchronously; the next reply waits
 * for that run to start and then joins as a follow-up, because a second
 * prompt before streaming begins would be rejected (and pi only logs it).
 */
export class ReplyQueue {
	private queue: { seq: number; text: string }[] = [];
	private lastSeq = 0;
	private awaitingStart = 0;
	private timer: NodeJS.Timeout | undefined;
	private pi: ExtensionAPI;
	private env: {
		ctx: () => ExtensionContext | undefined;
		running: () => boolean;
		dialogOpen: () => boolean;
		ack: (seq: number) => void;
	};

	constructor(pi: ExtensionAPI, env: ReplyQueue["env"]) {
		this.pi = pi;
		this.env = env;
	}

	add(seq: number, text: string): void {
		if (seq <= this.lastSeq || this.queue.some((q) => q.seq === seq)) return this.env.ack(seq); // a resend
		this.queue.push({ seq, text });
		this.queue.sort((a, b) => a.seq - b.seq);
		this.pump();
	}

	pump(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const ctx = this.env.ctx();
		while (ctx && this.queue.length > 0) {
			const next = this.queue[0]!;
			if (this.applySetting(ctx, next.text)) {
				this.done(next.seq);
				continue;
			}
			if (this.env.dialogOpen()) return; // resumed by ui_prompt_end
			const running = this.env.running();
			if (running) this.awaitingStart = 0;
			if (this.awaitingStart && Date.now() - this.awaitingStart < START_WAIT_MS) return this.retry();
			if (running) {
				void this.pi.sendUserMessage(next.text, { deliverAs: "followUp", expandPromptTemplates: true });
			} else if (ctx.isIdle()) {
				void this.pi.sendUserMessage(next.text, { expandPromptTemplates: true });
				this.awaitingStart = Date.now();
			} else return this.retry(); // compacting: prompts are refused until it ends
			this.done(next.seq);
		}
	}

	private done(seq: number): void {
		this.queue.shift();
		this.lastSeq = Math.max(this.lastSeq, seq);
		this.env.ack(seq);
	}

	private retry(): void {
		this.timer = setTimeout(() => this.pump(), RETRY_MS);
		this.timer.unref?.();
	}

	/** /name, /model, /thinking run immediately; true when the text was one of them. */
	private applySetting(ctx: ExtensionContext, text: string): boolean {
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		const warn = (m: string) => ctx.ui.notify(`pi-roost: ${m}`, "warning");
		if (cmd === "/name") {
			if (arg) this.pi.setSessionName(arg);
			else warn("/name needs a name");
			return true;
		}
		if (cmd === "/thinking") {
			if (THINKING.has(arg)) this.pi.setThinkingLevel(arg as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			else warn(`/thinking needs one of ${[...THINKING].join(", ")}`);
			return true;
		}
		if (cmd === "/model") {
			const slash = arg.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
			if (!model) warn(`unknown model "${arg}" (use provider/id)`);
			else void this.pi.setModel(model).catch((err: unknown) => warn(`cannot switch model: ${String(err)}`));
			return true;
		}
		return false;
	}
}

/** Worker role (PRD C6): report this session's state, take replies, detach keys. */
export function registerWorker(pi: ExtensionAPI, job: JobIdentity): void {
	const tracker = new WorkerTracker();
	let reporter: Reporter | undefined;
	let firstPromptTimer: NodeJS.Timeout | undefined;
	let customTimer: NodeJS.Timeout | undefined;
	let customPending = false;
	let stopKeys: (() => void) | undefined;
	let current: ExtensionContext | undefined;
	let dialogOpen = 0;
	const replies = new ReplyQueue(pi, {
		ctx: () => current,
		running: () => tracker.isRunning(),
		dialogOpen: () => dialogOpen > 0,
		ack: (seq) => reporter?.ack(seq),
	});
	const send = () => reporter?.update(tracker.report());

	pi.on("session_start", (event, ctx: ExtensionContext) => {
		current = ctx;
		dialogOpen = 0;
		stopKeys?.();
		stopKeys = ctx.hasUI ? registerDetachKeys(ctx, job, () => dialogOpen > 0) : undefined;
		reporter = new Reporter(job, (seq, text) => replies.add(seq, text));
		tracker.start({
			name: ctx.sessionManager.getSessionName() ?? null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			// a reload keeps the run going; any other start is a different conversation
			fresh: event.reason !== "reload",
		});
		send();
		clearTimeout(firstPromptTimer);
		firstPromptTimer = setTimeout(() => {
			tracker.firstPromptTimeout(ctx.sessionManager.getBranch().filter((e) => e.type === "message").length);
			send();
		}, FIRST_PROMPT_MS);
		firstPromptTimer.unref?.();
	});

	pi.on("agent_start", () => {
		tracker.agentStart();
		send();
		replies.pump();
	});
	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		tracker.toolStart(event.toolName);
		send();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		tracker.toolEnd();
		send();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		tracker.assistantMessage(event.message);
		send();
	});
	pi.on("agent_settled", (event) => {
		tracker.agentSettled(event.aborted);
		send();
		replies.pump();
	});
	pi.on("ui_prompt_start", (event) => {
		dialogOpen++;
		clearTimeout(customTimer);
		if (event.kind !== "custom") {
			tracker.dialogStart(event.kind, event.title);
			send();
			return;
		}
		// custom() is also used for non-blocking widgets: count it only once it lingers (R6)
		customPending = true;
		customTimer = setTimeout(() => {
			customPending = false;
			tracker.dialogStart(event.kind, event.title);
			send();
		}, CUSTOM_DIALOG_MS);
		customTimer.unref?.();
	});
	pi.on("ui_prompt_end", () => {
		dialogOpen = Math.max(0, dialogOpen - 1);
		clearTimeout(customTimer);
		if (customPending) customPending = false; // a short custom() was never counted
		else {
			tracker.dialogEnd();
			send();
		}
		if (dialogOpen === 0) replies.pump();
	});
	pi.on("session_info_changed", (event) => {
		tracker.rename(event.name);
		send();
	});
	pi.on("model_select", (event) => {
		tracker.setModel(`${event.model.provider}/${event.model.id}`);
		send();
	});
	pi.on("session_shutdown", async () => {
		current = undefined;
		stopKeys?.();
		stopKeys = undefined;
		clearTimeout(firstPromptTimer);
		clearTimeout(customTimer);
		const closing = reporter;
		reporter = undefined;
		await closing?.close();
	});
}
