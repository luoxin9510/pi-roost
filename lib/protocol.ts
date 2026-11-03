import { StringDecoder } from "node:string_decoder";

export type JobStateName = "working" | "blocked" | "done" | "failed" | "stopped";
export type JobStatus = null | "busy" | "waiting" | "idle";
export type WaitingFor = null | "dialog" | "question" | "first-prompt";
export type DispatchOrigin = "bg" | "dispatch" | "adopt" | "fork";

/** M8: how full the session's context window is (pi's ctx.getContextUsage()). */
export interface ContextInfo {
	/** Estimated tokens in context; null right after a compaction, until the next reply. */
	tokens: number | null;
	window: number;
	/** 0–100; null when tokens is unknown. */
	percent: number | null;
}

export interface JobRow {
	id: string;
	cwd: string;
	kind: "pi" | "shell";
	startedAt: number;
	state: JobStateName;
	pid: number | null;
	status: JobStatus;
	waitingFor: WaitingFor;
	sessionFile: string;
	name: string;
	endedAt: number | null;
	/** Row text: a status sentence while working, the result or question after. */
	summary: string | null;
	question: string | null;
	choices: string[];
	model: string | null;
	/** M8: the worker's thinking level (or the one it was started with). */
	thinking: string | null;
	/** M8: context window use as last reported; null for shell jobs and before the first report. */
	context: ContextInfo | null;
	error: string | null;
	/** When the job entered its current state (for "waiting 3m"). */
	stateSince: number;
	/** DM-4: stopped for idleness; attaching or replying starts it again. */
	reaped: boolean;
	/** AV-K7: listed first and never reaped. */
	pinned: boolean;
	/** AV-K13: the user's position within its group, or null when never moved. */
	order: number | null;
	/** The section the order belongs to (a state group or `dir:<cwd>`); stale elsewhere. */
	orderKey: string | null;
	/** M9: the session that spawned this one (roost_spawn), and its tree's root. */
	parentSession?: string | null;
	rootSession?: string | null;
	/** M10: the session's own git worktree. */
	worktree?: { path: string; branch: string } | null;
}

/** M9: a session an agent may message (roost_agents). */
export interface PeerRow {
	id: string;
	name: string;
	relation: "parent" | "child" | "sibling" | "tree" | "external";
	role: "job" | "foreground";
	state: JobStateName | "live";
	status: JobStatus;
	waitingFor: WaitingFor;
	summary: string | null;
	question: string | null;
	cwd: string;
}

export interface SendResult {
	/** delivered: handed to the running session; queued: it is busy starting; started: it was ended and starts again */
	outcome: "delivered" | "queued" | "started" | "stopped" | "not running";
	id: string;
	name: string;
	relation: PeerRow["relation"];
	/** The target is waiting on a dialog; the message waits until it is answered. */
	dialog?: boolean;
}

export interface HandbackArgs {
	state: "done" | "blocked" | "failed";
	result: string | null;
	question: string | null;
	error: string | null;
}

/** What a worker reports about itself (full snapshot every time). */
export interface WorkerReport {
	state: "working" | "blocked" | "done" | "failed";
	status: Exclude<JobStatus, null>;
	waitingFor: WaitingFor;
	summary: string | null;
	question: string | null;
	choices: string[];
	tool: string | null;
	error: string | null;
	name: string | null;
	model: string | null;
	/** M8; absent from workers before 0.1.5. */
	thinking?: string | null;
	context?: ContextInfo | null;
	/** The worker reacts to the host's SIGUSR2 attach signal (AT-5). */
	attachSignal?: boolean;
	/** M9: the worker takes agent messages and reports (custom messages, per-item acks). */
	agentItems?: boolean;
}

export interface DispatchArgs {
	/** DI-6: "shell" runs `command` without pi (no session file). */
	kind?: "pi" | "shell";
	cwd: string;
	sessionFile: string;
	command: string[];
	env: Record<string, string>;
	name: string;
	model?: string;
	thinking?: string;
	origin: DispatchOrigin;
	piVersion?: string;
	/** M10: the worktree the dispatching side made for this session (cwd is inside it). */
	worktree?: { path: string; branch: string; repo: string; base: string };
}

export interface DaemonStatus {
	pid: number;
	version: string;
	socketDir: string;
	liveJobs: number;
	totalJobs: number;
	ptyError: string | null;
	startedAt: number;
}

export interface OpArgs {
	ping: {};
	list: { all?: boolean; cwd?: string };
	dispatch: DispatchArgs;
	stop: { id: string };
	rm: { id: string };
	resolve: { query: string };
	status: {};
	shutdown: { keepWorkers?: boolean };
	subscribe: {};
	report: { id: string; token: string; report: WorkerReport };
	reply: { id: string; text: string };
	/** Worker → daemon: the reply with this seq was handed to pi (exact: only that agent item). */
	ack: { id: string; token: string; seq: number; exact?: boolean };
	/** Start an ended job again from its session file; `restart` also restarts a live one. */
	respawn: { id?: string; all?: boolean; restart?: boolean; prompt?: string };
	pin: { id: string; pinned: boolean };
	rename: { id: string; name: string };
	/** AV-K13: these jobs, in this order (the rest of their group keeps its place). */
	reorder: { ids: string[]; key: string };
	/** M9: a foreground pi joins as a peer on this connection (pid owns the session's writer lock). */
	peer_register: { session?: string; name: string; cwd: string; pid: number };
	/** M9, on a peer connection: the sessions this peer may message. */
	peers: {};
	send: { to: string; message: string };
	spawn: { launch: DispatchArgs };
	/** M9, on a worker connection: the run it was spawned for (or a user turn) ended. */
	handback: HandbackArgs;
	/** M9, on a foreground peer connection: the report with this ref reached pi. */
	peer_ack: { ref: string };
}

export interface OpResults {
	ping: { pid: number; version: string };
	list: { jobs: JobRow[] };
	dispatch: { id: string; name: string };
	stop: { id: string };
	/** M10: what happened to the session's worktree. */
	rm: { id: string; worktree?: { path: string; branch: string; removed: boolean; branchKept: boolean; reason?: string } };
	resolve: { id: string };
	status: DaemonStatus;
	shutdown: {};
	subscribe: {};
	report: {};
	/** delivered: handed to the live worker; saved: kept for its next start (PK-5). */
	reply: { delivered: boolean; saved: boolean; stopped?: boolean; respawned?: boolean; error?: string };
	ack: {};
	respawn: { results: { id: string; started: boolean; error?: string }[] };
	pin: { id: string; pinned: boolean };
	rename: { id: string; name: string };
	reorder: {};
	peer_register: { id: string };
	peers: { peers: PeerRow[] };
	send: SendResult;
	spawn: { id: string; name: string };
	handback: { routed: boolean };
	peer_ack: {};
}

export type Op = keyof OpArgs;

export type RequestOf<O extends Op> = { id: number; op: O; args?: OpArgs[O] };
export type Request = { [O in Op]: RequestOf<O> }[Op];
export type ArgsOf<O extends Op> = OpArgs[O];
export type ResultOf<O extends Op> = OpResults[O];

export type OkResponse<O extends Op = Op> = { id: number; ok: true; result: OpResults[O] };
export type ErrResponse = { id: number; ok: false; error: string; code?: string };
export type Response<O extends Op = Op> = OkResponse<O> | ErrResponse;

export type Event =
	| { event: "job"; job: JobRow }
	| { event: "removed"; id: string }
	/** Daemon → worker, on the connection the worker reports on. */
	| {
			event: "deliver";
			id: string;
			seq: number;
			text: string;
			/** M9: absent for user replies; agent items carry an envelope as text. */
			kind?: "reply" | "message" | "report";
			from?: string;
			relation?: string;
			/** M9: a report to a foreground peer, acknowledged with peer_ack. */
			ref?: string;
	  };

/** A ContextInfo from untrusted JSON (a report, state.json), or null. */
export function contextFrom(v: unknown): ContextInfo | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
	const raw = num(o.window);
	const window = raw === null ? 0 : Math.round(raw);
	if (window <= 0) return null;
	const tokens = num(o.tokens);
	const percent = num(o.percent);
	return { tokens: tokens === null ? null : Math.round(tokens), window, percent: percent === null ? null : Math.min(percent, 999) };
}

export class LineReader {
	private decoder = new StringDecoder("utf8");
	private partial = "";

	push(chunk: Buffer | string): string[] {
		this.partial += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const parts = this.partial.split("\n");
		this.partial = parts.pop() ?? "";
		return parts;
	}
}

export function encodeLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
