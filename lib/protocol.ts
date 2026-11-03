import { StringDecoder } from "node:string_decoder";

export type JobStateName = "working" | "blocked" | "done" | "failed" | "stopped";
export type JobStatus = null | "busy" | "waiting" | "idle";
export type WaitingFor = null | "dialog" | "question" | "first-prompt";
export type DispatchOrigin = "bg" | "dispatch" | "adopt" | "fork";

export interface JobRow {
	id: string;
	cwd: string;
	kind: "pi";
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
	/** The worker reacts to the host's SIGUSR2 attach signal (AT-5). */
	attachSignal?: boolean;
}

export interface DispatchArgs {
	cwd: string;
	sessionFile: string;
	command: string[];
	env: Record<string, string>;
	name: string;
	model?: string;
	thinking?: string;
	origin: DispatchOrigin;
	piVersion?: string;
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
	/** Worker → daemon: the reply with this seq was handed to pi. */
	ack: { id: string; token: string; seq: number };
	/** Start an ended job again from its session file; `restart` also restarts a live one. */
	respawn: { id?: string; all?: boolean; restart?: boolean; prompt?: string };
	pin: { id: string; pinned: boolean };
	rename: { id: string; name: string };
	/** AV-K13: these jobs, in this order (the rest of their group keeps its place). */
	reorder: { ids: string[]; key: string };
}

export interface OpResults {
	ping: { pid: number; version: string };
	list: { jobs: JobRow[] };
	dispatch: { id: string; name: string };
	stop: { id: string };
	rm: { id: string };
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
	| { event: "deliver"; id: string; seq: number; text: string };

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
