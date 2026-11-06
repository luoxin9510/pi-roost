import type { ConciergeAnswer, ConciergePolicy, ConciergeStatus, StandingOrder } from "./concierge.ts";
import type { RoostEvent } from "./events.ts";
import type { PrInfo } from "./pr.ts";
import type { UsageInfo } from "./usage.ts";
import type { BoardSummary, BoardTask } from "./board.ts";
import type { ProfileTerm } from "./profiles.ts";
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
	/** M24: what the session spent, as last reported (absent before it reports, or from older workers). */
	usage?: UsageInfo | null;
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
	/** M13: someone holds the parent session now (a foreground pi, or a job recorded for it). */
	parentOpen?: boolean;
	/** M18: the agent it runs as. */
	agent?: string | null;
	/** M16: the session's pull requests as gh last reported them. */
	prs?: PrInfo[];
	/** M10: the session's own git worktree (M26: and the commit it started from). */
	worktree?: { path: string; branch: string; base?: string } | null;
	/** M26: the sessions started together for one task with several models share this id. */
	fanout?: string | null;
	/** M29: the agent that runs it: "pi", "shell", or (M30) the name of the user's agent profile. */
	profile?: string;
	/** M39: the schedule that started it. */
	schedule?: string | null;
	/** M31: what its agent said it can do in its hello (absent: it never said). */
	capabilities?: string[];
	/** M44: the hub's own agent (not listed as a session; the hub shows its status line). */
	role?: "concierge" | null;
	/** M45: the concierge's suggested answer for a row that waits for one (the hub sends it with one key). */
	suggested?: { text: string; why: string | null; at: number } | null;
	/** M48: the task it was started on (one line, at most 200 characters), and the user replies waiting for it. */
	task?: string | null;
	queued?: number;
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
	/** delivered: handed to the running session; queued: it is busy starting; started: it was ended and starts again; duplicate (M43): the same text went to it a moment ago, not sent again */
	outcome: "delivered" | "queued" | "started" | "stopped" | "not running" | "duplicate";
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
	/** M24: absent from workers before 0.1.11. */
	usage?: UsageInfo | null;
	/** The worker reacts to the host's SIGUSR2 attach signal (AT-5). */
	attachSignal?: boolean;
	/** M14: on attach the worker sets the terminal up again and repaints itself (read by hosts before M21). */
	attachRepaint?: boolean;
	/** M9: the worker takes agent messages and reports (custom messages, per-item acks). */
	agentItems?: boolean;
	/** M11: when a phone (pi-mobile) last acted on this session (ms epoch): it is in use. */
	remoteAt?: number;
	/** M16: pull request URLs the session linked (gh output, branch lookups). */
	prLinks?: string[];
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
	/** M18: the agent (pi-subagents definition) the session runs as. */
	agent?: string;
	/** M20: how the worker's environment follows its workspace (absent: as carried). */
	workspaceEnv?: "shell" | "direnv" | "off";
	/** M20: names (or `PREFIX*`) a workspace's environment may not set. */
	envDeny?: string[];
	/** M20: names that pass envDeny (envAllowList). */
	envForce?: string[];
	origin: DispatchOrigin;
	piVersion?: string;
	/** M10: the worktree the dispatching side made for this session (cwd is inside it). */
	worktree?: { path: string; branch: string; repo: string; base: string };
	/** M26: one task, several models: the id the sessions share. */
	fanout?: string;
	/** M30: a level 0 agent from this profile (kind "shell"). */
	profile?: string;
	/** M30: how its screen is read and how replies are typed into it. */
	term?: ProfileTerm;
	/** M30: the argv that reopens it, when the profile has one. */
	resumeCommand?: string[];
	/** M30: the first task is in its argv (it has been given something to do). */
	taskInArgv?: boolean;
	/** M40: a profile with `resume`: a run of it cut short can carry on (autoResume). */
	resumable?: boolean;
	/** M31: a profile's agent that speaks the roost agent protocol. */
	protocol?: boolean;
	/** M36: a resend with the same id returns the job the first one made. */
	requestId?: string;
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

/** M31: the protocol version this daemon and these clients speak (docs/protocol.md). */
export const PROTOCOL_VERSION = 1;

/**
 * M31: what an agent can do, said in its hello. Unknown ones are ignored; the list only
 * grows with a protocol version.
 */
export const AGENT_CAPABILITIES = ["report", "replies", "steer", "usage", "context", "model-switch", "transcript", "peers", "agent-items"] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export interface HelloArgs {
	protocol: number;
	agent?: { name: string; version?: string };
	capabilities?: string[];
}
export interface HelloResult {
	protocol: number;
	daemon: { name: "roost"; version: string };
	/** What the daemon offers agents (the ops beyond report, ack and hello). */
	capabilities: string[];
}

/** M39: a schedule as the hub and the CLI show it. */
export interface ScheduleRow {
	name: string;
	when: string;
	task: string | null;
	/** M40: what each run is: "pi", "shell" (a command) or a profile's name. */
	agent: string;
	cwd: string;
	model: string | null;
	paused: boolean;
	catchUp: boolean;
	nextAt: number | null;
	lastRunAt: number | null;
	lastJob: string | null;
	lastSkip: { at: number; why: string } | null;
}

export interface OpArgs {
	ping: {};
	/** M39: scheduled tasks. */
	schedules: {};
	"schedule-add": { name: string; when: string; launch: DispatchArgs; task?: string; catchUp?: boolean };
	"schedule-rm": { name: string };
	"schedule-pause": { name: string; paused: boolean };
	"schedule-run": { name: string };
	/** M31: an agent says which protocol and capabilities it has, before it reports. */
	hello: HelloArgs;
	list: { all?: boolean; cwd?: string };
	dispatch: DispatchArgs;
	stop: { id: string };
	rm: { id: string };
	resolve: { query: string };
	status: {};
	shutdown: { keepWorkers?: boolean };
	subscribe: {};
	report: { id: string; token: string; report: WorkerReport };
	/** M28: a reply to a working session steers into its current work (pi's Enter) or waits for it to finish (Alt+Enter); absent: waits. */
	/** M36: `requestId` makes a resend safe: the same id is taken once (the first answer is given again). */
	reply: { id: string; text: string; mode?: ReplyMode; requestId?: string };
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
	/** M43: the event feed (what happened), with a cursor: `after` the seq last seen. */
	events: { after?: number; limit?: number; id?: string };
	/** M43, on a peer connection: tell me once when that session is next idle (done, or waiting for an answer) or has ended. */
	watch: { id: string; when: "idle" | "ended" };
	/**
	 * M44: the concierge: start it (a pi launch the hub built), stop it, or ask how it stands.
	 * M45: set the policy (`answer`, `act`), or undo the last answer it gave a session. The hub's only.
	 */
	concierge:
		| { action: "on"; launch?: DispatchArgs }
		| { action: "off" }
		| { action: "status" }
		| { action: "answer"; answer: ConciergeAnswer }
		| { action: "act"; act: boolean }
		| { action: "undo" };
	/** M44, from the hub: a question for the concierge (`? …`); its answer comes as a `concierge` event. */
	"concierge-ask": { text: string };
	/** M44, on the concierge's own connection: what it tells the user (hub_notify), or its answer to a question. */
	"concierge-say": { kind: "info" | "need" | "answer"; text: string };
	/** M45, on the concierge's connection: the policy in force (which of its tools it may use). */
	"concierge-policy": Record<string, never>;
	/** M45, on the concierge's connection: the answer it would give a session that waits for one, and why. */
	"concierge-suggest": { id: string; text: string; why?: string };
	/** M45, on the concierge's connection: an answer in the user's place; refused (`policy`) unless the policy allows. */
	"concierge-reply": { id: string; text: string; why?: string };
	/** M45, on the concierge's connection: stop, restart or start a session; refused (`policy`) unless `act`. */
	"concierge-act": { what: "stop" | "respawn"; id: string; why?: string } | { what: "dispatch"; launch: DispatchArgs; why?: string };
	/**
	 * M46: the standing orders: keep one (the hub's or the concierge's connection; `when` in M39's
	 * vocabulary puts it on a clock), drop one (the hub's; the concierge's own only), list them,
	 * mark one applied (the concierge's).
	 */
	"concierge-order": { action: "add"; text: string; when?: string } | { action: "rm"; id: number } | { action: "list" } | { action: "applied"; id: number; text?: string };
	/**
	 * M47: the shared task board (the hub's, the concierge's and the sessions' connections): list
	 * it, add a task, claim one (a session's; refused `conflict` when another live session holds
	 * it, `blocked` while one it waits on is not done), give one back, mark one done, drop one
	 * (the hub's, the concierge's), hand one to a session (a message there).
	 */
	task:
		// M52: the hub and the concierge name a project by a directory in its repository (a session's is where it works)
		| { action: "list"; project?: string }
		| { action: "add"; title: string; detail?: string; after?: number[]; project?: string | null }
		| { action: "claim"; id: number }
		| { action: "release"; id: number }
		| { action: "done"; id: number; result?: string }
		| { action: "drop"; id: number }
		| { action: "assign"; id: number; to: string }
		// M55: a task's own worktree and a session in it; review, merge into base locally
		| { action: "start"; id: number; workspace: { path: string; branch: string; baseRef: string; baseSha: string }; launch: DispatchArgs }
		| { action: "merge"; id: number; mode?: "ff" | "no-ff" }
		| { action: "back"; id: number; note?: string }
		| { action: "abort"; id: number }
		| { action: "commit"; id: number; message?: string };
}

export interface OpResults {
	ping: { pid: number; version: string };
	schedules: { schedules: ScheduleRow[] };
	"schedule-add": ScheduleRow;
	"schedule-rm": { name: string };
	"schedule-pause": ScheduleRow;
	"schedule-run": { name: string; id: string };
	hello: HelloResult;
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
	reply: { delivered: boolean; saved: boolean; stopped?: boolean; respawned?: boolean; error?: string; duplicate?: boolean };
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
	events: { events: RoostEvent[]; cursor: number };
	/** fired: it was already so; the notice went out at once. */
	watch: { id: string; name: string; when: "idle" | "ended"; fired: boolean };
	concierge: ConciergeStatus;
	"concierge-ask": { id: string };
	"concierge-say": {};
	"concierge-policy": ConciergePolicy;
	"concierge-suggest": { id: string; name: string };
	"concierge-reply": { id: string; name: string };
	"concierge-act": { id: string; name: string };
	"concierge-order": { orders: StandingOrder[]; order?: StandingOrder };
	/** M47: the board as it stands (and the task acted on; `sent`: how the hand-over message went). */
	task: { tasks: BoardTask[]; task?: BoardTask; sent?: SendResult["outcome"]; job?: { id: string; name: string }; note?: string };
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
	/** M44: the concierge's status changed (on, off, a notice, an answer, its budget). */
	| { event: "concierge"; status: ConciergeStatus }
	/** M47: the task board changed (its counts; `task list` has the tasks). */
	| { event: "board"; board: BoardSummary }
	/** Daemon → worker, on the connection the worker reports on. */
	| {
			event: "deliver";
			id: string;
			seq: number;
			text: string;
			/** M9: absent for user replies; agent items carry an envelope as text (M43: a notice is a watch that fired; M44: a digest wakes the concierge). */
			kind?: "reply" | "message" | "report" | "notice" | "digest";
			from?: string;
			relation?: string;
			/** M9: a report to a foreground peer, acknowledged with peer_ack. */
			ref?: string;
			/** M28: how a user reply joins a running turn. */
			mode?: ReplyMode;
	  };

/** M28: "steer" joins the work under way, after its current tool calls; "followUp" waits until it is done. */
export type ReplyMode = "steer" | "followUp";

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

/** M49: a line longer than this (in characters) is not a message of this protocol: the reader gives the stream up. */
export const LINE_MAX = 64 * 1024 * 1024;

export class LineTooLong extends Error {
	constructor(max: number) {
		super(`a line longer than ${max} characters`);
		this.name = "LineTooLong";
	}
}

/**
 * Splits a stream into lines. Only what just arrived is scanned for newlines (a long
 * line in progress is not read again on every chunk). A line past `max` throws
 * LineTooLong once; after that the reader takes nothing more.
 */
export class LineReader {
	private decoder = new StringDecoder("utf8");
	private partial = "";
	private dead = false;
	private readonly max: number;

	constructor(max = LINE_MAX) {
		this.max = max;
	}

	push(chunk: Buffer | string): string[] {
		if (this.dead) return [];
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		const lines: string[] = [];
		let start = 0;
		for (;;) {
			const nl = text.indexOf("\n", start);
			if (nl < 0) break;
			const line = this.partial + text.slice(start, nl);
			this.partial = "";
			start = nl + 1;
			if (line.length > this.max) return this.giveUp();
			lines.push(line);
		}
		this.partial += text.slice(start);
		if (this.partial.length > this.max) return this.giveUp();
		return lines;
	}

	private giveUp(): never {
		this.dead = true;
		this.partial = "";
		throw new LineTooLong(this.max);
	}
}

export function encodeLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
