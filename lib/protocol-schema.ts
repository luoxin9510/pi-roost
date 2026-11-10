// M75 (docs/plans/protocol-schema.md): the protocol's ops, once. A schema (lib/schema.ts) per op's
// arguments and result is the source of the TypeScript types (lib/protocol.ts re-exports
// them), of the op reference in docs/protocol.md (npm run docs:protocol), and, from M76,
// of the daemon's entry check. Nothing here is checked at run time yet: the limits are
// documentation until then.
import { type Infer, type Schema, arr as arrS, bool as boolS, literal, nullable as nullableS, num as numS, obj as objS, oneOf as oneOfS, opaque, optional, rec, str as strS, union, empty } from "./schema.ts";
import type { BoardTask } from "./board.ts";
import { TASK_NOTE_MAX, TASK_TEXT_MAX, TASK_TITLE_MAX } from "./board.ts";
import { MESSAGE_MAX } from "./comms.ts";
import type { ConciergeStatus, StandingOrder } from "./concierge.ts";
import { ORDER_TEXT_MAX } from "./concierge.ts";
import type { RoostEvent } from "./events.ts";
import type { PrInfo } from "./pr.ts";
import type { UsageInfo } from "./usage.ts";

// -- helpers ------------------------------------------------------------------------------

type Opts = { description?: string };
const d = (description?: string) => (description ? { description } : {});
const str = (description?: string, o: { maxLength?: number; minLength?: number; pattern?: string } = {}) => strS({ ...d(description), min: o.minLength, max: o.maxLength, pattern: o.pattern });
const num = (description?: string) => numS(d(description));
const int = (description?: string, o: { min?: number } = {}) => numS({ ...d(description), int: true, min: o.min });
const bool = (description?: string) => boolS(d(description));
const nullable = <T extends Schema>(t: T, description?: string) => nullableS(t, d(description));
/** A string that is one of these (the doc lists the values). */
const oneOf = <const T extends string>(values: readonly T[], description?: string) => oneOfS(values, d(description));
const lit = literal;
const arr = <T extends Schema>(t: T, description?: string) => arrS(t, d(description));
const obj = <P extends Parameters<typeof objS>[0]>(properties: P, o: Opts = {}) => objS(properties, o);
const opt = optional;
/** A type another module owns (its interface stays there); the doc names it. */
const domain = <T>(title: string, description: string) => opaque<T>(title, description);

// -- shared values ------------------------------------------------------------------------

export const JOB_STATES = ["working", "blocked", "done", "failed", "stopped"] as const;
const JobStateNameS = oneOf(JOB_STATES);
const JobStatusS = nullable(oneOf(["busy", "waiting", "idle"]));
const WaitingForS = nullable(oneOf(["dialog", "question", "first-prompt"]));
const DispatchOriginS = oneOf(["bg", "dispatch", "adopt", "fork"]);
export type JobStateName = Infer<typeof JobStateNameS>;
export type JobStatus = Infer<typeof JobStatusS>;
export type WaitingFor = Infer<typeof WaitingForS>;
export type DispatchOrigin = Infer<typeof DispatchOriginS>;
export const REPLY_MODES = ["steer", "followUp"] as const;
/** M28: "steer" joins the work under way, after its current tool calls; "followUp" waits until it is done. */
const ReplyModeS = oneOf(REPLY_MODES, `"steer" joins the work under way, after its current tool calls; "followUp" waits until it is done`);
export type ReplyMode = Infer<typeof ReplyModeS>;
const SEND_OUTCOMES = ["delivered", "queued", "started", "stopped", "not running", "duplicate"] as const;

export const ContextInfoS = obj({
	tokens: nullable(num(), "Estimated tokens in context; null right after a compaction, until the next reply."),
	window: num(),
	percent: nullable(num(), "0-100; null when tokens is unknown."),
}, { description: "M8: how full the session's context window is (pi's ctx.getContextUsage())." });
export type ContextInfo = Infer<typeof ContextInfoS>;

const UsageInfoS = domain<UsageInfo>("UsageInfo", "M24: what a session spent (lib/usage.ts).");
const PrInfoS = domain<PrInfo>("PrInfo", "M16: a pull request as gh last reported it (lib/pr.ts).");

export const JobRowSchema = obj({
	id: str(),
	cwd: str(),
	kind: oneOf(["pi", "shell"]),
	startedAt: num(),
	state: JobStateNameS,
	pid: nullable(num()),
	status: JobStatusS,
	waitingFor: WaitingForS,
	sessionFile: str(),
	name: str(),
	endedAt: nullable(num()),
	summary: nullable(str(), "Row text: a status sentence while working, the result or question after."),
	question: nullable(str()),
	choices: arr(str()),
	model: nullable(str()),
	thinking: nullable(str(), "M8: the worker's thinking level (or the one it was started with)."),
	context: nullable(ContextInfoS, "M8: context window use as last reported; null for shell jobs and before the first report."),
	usage: opt(nullable(UsageInfoS, "M24: what the session spent, as last reported (absent before it reports, or from older workers).")),
	error: nullable(str()),
	stateSince: num("When the job entered its current state (for \"waiting 3m\")."),
	reaped: bool("DM-4: stopped for idleness; attaching or replying starts it again."),
	pinned: bool("AV-K7: listed first and never reaped."),
	order: nullable(num(), "AV-K13: the user's position within its group, or null when never moved."),
	orderKey: nullable(str(), "The section the order belongs to (a state group or `dir:<cwd>`); stale elsewhere."),
	parentSession: opt(nullable(str(), "M9: the session that spawned this one (roost_spawn).")),
	rootSession: opt(nullable(str(), "M9: its spawn tree's root.")),
	parentOpen: opt(bool("M13: someone holds the parent session now (a foreground pi, or a job recorded for it).")),
	agent: opt(nullable(str(), "M18: the agent it runs as.")),
	prs: opt(arr(PrInfoS, "M16: the session's pull requests as gh last reported them.")),
	worktree: opt(nullable(obj({ path: str(), branch: str(), base: opt(str()) }), "M10: the session's own git worktree (M26: and the commit it started from).")),
	fanout: opt(nullable(str(), "M26: the sessions started together for one task with several models share this id.")),
	profile: opt(str("M29: the agent that runs it: \"pi\", \"shell\", or (M30) the name of the user's agent profile.")),
	schedule: opt(nullable(str(), "M39: the schedule that started it.")),
	capabilities: opt(arr(str(), "M31: what its agent said it can do in its hello (absent: it never said).")),
	role: opt(nullable(oneOf(["concierge"]), "M44: the hub's own agent (not listed as a session; the hub shows its status line).")),
	suggested: opt(nullable(obj({ text: str(), why: nullable(str()), at: num() }), "M45: the concierge's suggested answer for a row that waits for one (the hub sends it with one key).")),
	task: opt(nullable(str(), "M48: the task it was started on (one line, at most 200 characters).")),
	queued: opt(num("M48: user replies waiting for it.")),
});
export type JobRow = Infer<typeof JobRowSchema>;

export const PeerRowSchema = obj({
	id: str(),
	name: str(),
	relation: oneOf(["parent", "child", "sibling", "tree", "external"]),
	role: oneOf(["job", "foreground"]),
	state: oneOf([...JOB_STATES, "live"]),
	status: JobStatusS,
	waitingFor: WaitingForS,
	summary: nullable(str()),
	question: nullable(str()),
	cwd: str(),
}, { description: "M9: a session an agent may message (roost_agents)." });
export type PeerRow = Infer<typeof PeerRowSchema>;

export const SendResultSchema = obj({
	outcome: oneOf(SEND_OUTCOMES, "delivered: handed to the running session; queued: it is busy starting; started: it was ended and starts again; duplicate (M43): the same text went to it a moment ago, not sent again"),
	id: str(),
	name: str(),
	relation: oneOf(["parent", "child", "sibling", "tree", "external"]),
	dialog: opt(bool("The target is waiting on a dialog; the message waits until it is answered.")),
});
export type SendResult = Infer<typeof SendResultSchema>;

export const HandbackArgsSchema = obj({
	state: oneOf(["done", "blocked", "failed"]),
	result: nullable(str()),
	question: nullable(str()),
	error: nullable(str()),
}, { description: "M9, on a worker connection: the run it was spawned for (or a user turn) ended." });
export type HandbackArgs = Infer<typeof HandbackArgsSchema>;

export const WorkerReportSchema = obj({
	state: oneOf(["working", "blocked", "done", "failed"]),
	status: oneOf(["busy", "waiting", "idle"]),
	waitingFor: WaitingForS,
	summary: nullable(str()),
	question: nullable(str()),
	choices: arr(str()),
	tool: nullable(str()),
	error: nullable(str()),
	name: nullable(str()),
	model: nullable(str()),
	thinking: opt(nullable(str(), "M8; absent from workers before 0.1.5.")),
	context: opt(nullable(ContextInfoS)),
	usage: opt(nullable(UsageInfoS, "M24: absent from workers before 0.1.11.")),
	attachSignal: opt(bool("The worker reacts to the host's SIGUSR2 attach signal (AT-5).")),
	attachRepaint: opt(bool("M14: on attach the worker sets the terminal up again and repaints itself (read by hosts before M21).")),
	agentItems: opt(bool("M9: the worker takes agent messages and reports (custom messages, per-item acks).")),
	remoteAt: opt(num("M11: when a phone (pi-mobile) last acted on this session (ms epoch): it is in use.")),
	prLinks: opt(arr(str(), "M16: pull request URLs the session linked (gh output, branch lookups).")),
}, { description: "What a worker reports about itself (full snapshot every time)." });
export type WorkerReport = Infer<typeof WorkerReportSchema>;

const ProfileTermS = obj({
	submit: str(),
	settleMs: num(),
	waiting: opt(str()),
	working: opt(str()),
	typeTask: opt(str("Typed once it first goes quiet (task \"type\", or a reply to an ended one).")),
});

export const DispatchArgsSchema = obj({
	kind: opt(oneOf(["pi", "shell"], "DI-6: \"shell\" runs `command` without pi (no session file).")),
	cwd: str(),
	sessionFile: str(),
	command: arr(str()),
	env: rec(str()),
	name: str(),
	model: opt(str()),
	thinking: opt(str()),
	agent: opt(str("M18: the agent (pi-subagents definition) the session runs as.")),
	workspaceEnv: opt(oneOf(["shell", "direnv", "off"], "M20: how the worker's environment follows its workspace (absent: as carried).")),
	envDeny: opt(arr(str(), "M20: names (or `PREFIX*`) a workspace's environment may not set.")),
	envForce: opt(arr(str(), "M20: names that pass envDeny (envAllowList).")),
	origin: DispatchOriginS,
	piVersion: opt(str()),
	worktree: opt(obj({ path: str(), branch: str(), repo: str(), base: str() }, { description: "M10: the worktree the dispatching side made for this session (cwd is inside it)." })),
	fanout: opt(str("M26: one task, several models: the id the sessions share.")),
	profile: opt(str("M30: a level 0 agent from this profile (kind \"shell\").")),
	term: opt(ProfileTermS),
	resumeCommand: opt(arr(str(), "M30: the argv that reopens it, when the profile has one.")),
	taskInArgv: opt(bool("M30: the first task is in its argv (it has been given something to do).")),
	resumable: opt(bool("M40: a profile with `resume`: a run of it cut short can carry on (autoResume).")),
	protocol: opt(bool("M31: a profile's agent that speaks the roost agent protocol.")),
	requestId: opt(str("M36: a resend with the same id returns the job the first one made (one not of this form is ignored).", { pattern: "^[A-Za-z0-9_.:-]{1,64}$" })),
}, { description: "A session to start (dispatch, spawn, a schedule's launch, a task's start)." });
export type DispatchArgs = Infer<typeof DispatchArgsSchema>;

export const DaemonStatusSchema = obj({
	pid: num(),
	version: str(),
	socketDir: str(),
	liveJobs: num(),
	totalJobs: num(),
	ptyError: nullable(str()),
	startedAt: num(),
});
export type DaemonStatus = Infer<typeof DaemonStatusSchema>;

export const HelloArgsSchema = obj({
	protocol: int("The highest protocol version the agent speaks.", { min: 1 }),
	agent: opt(obj({ name: str(), version: opt(str()) })),
	capabilities: opt(arr(str(), "What the agent can do (AGENT_CAPABILITIES); unknown ones are ignored.")),
}, { description: "M31: an agent says which protocol and capabilities it has, before it reports." });
export type HelloArgs = Infer<typeof HelloArgsSchema>;

export const HelloResultSchema = obj({
	protocol: int(),
	daemon: obj({ name: lit("roost"), version: str() }),
	capabilities: arr(str(), "What the daemon offers agents (the ops beyond report, ack and hello): DAEMON_CAPABILITIES."),
});
export type HelloResult = Infer<typeof HelloResultSchema>;

export const ScheduleRowSchema = obj({
	name: str(),
	when: str(),
	task: nullable(str()),
	agent: str("M40: what each run is: \"pi\", \"shell\" (a command) or a profile's name."),
	cwd: str(),
	model: nullable(str()),
	paused: bool(),
	catchUp: bool(),
	nextAt: nullable(num()),
	lastRunAt: nullable(num()),
	lastJob: nullable(str()),
	lastSkip: nullable(obj({ at: num(), why: str() })),
}, { description: "M39: a schedule as the hub and the CLI show it." });
export type ScheduleRow = Infer<typeof ScheduleRowSchema>;

const ConciergeAnswerS = oneOf(["never", "routine", "always"]);

// -- task ---------------------------------------------------------------------------------

const Id = int("a task's id (a positive integer)", { min: 1 });
const TaskComment = obj({ file: str(), line: int(), text: str(undefined, { maxLength: TASK_TEXT_MAX }), lineText: opt(str()), tip: opt(str()) });

/** M47: the shared task board. The hub and the concierge name a project by a directory in its repository (a session's is where it works). */
export const TaskArgsSchema = union([
	obj({ action: lit("list"), project: opt(str("M52: a directory in the project's repository (absolute).")) }, { description: "The lot (done and dropped ones too)." }),
	obj({ action: lit("add"), title: str(undefined, { maxLength: TASK_TITLE_MAX }), detail: opt(str(undefined, { maxLength: TASK_TEXT_MAX })), after: opt(arr(Id, "Tasks on the board it waits on.")), project: opt(nullable(str())) }, { description: "A new task, open." }),
	obj({ action: lit("cleanup"), dry: opt(bool("List only.")) }, { description: "M59: removes (dry: lists) worktrees and verify logs left behind. No id." }),
	obj({ action: lit("claim"), id: Id }, { description: "A session takes it." }),
	obj({ action: lit("release"), id: Id }, { description: "The owner gives it back." }),
	obj({ action: lit("done"), id: Id, result: opt(str(undefined, { maxLength: TASK_TEXT_MAX })) }, { description: "The owner marks it done." }),
	obj({ action: lit("drop"), id: Id }, { description: "Takes an open or claimed task off the board." }),
	obj({ action: lit("assign"), id: Id, to: str("A session's id or unique name.") }, { description: "Hands an open task to a session (a message there)." }),
	// M55: a task's own worktree and a session in it; review, merge into base locally
	// M65: the daemon makes the task's worktree (prepare: where), the client builds its launch there (start)
	obj({ action: lit("prepare"), id: Id }, { description: "M65: the daemon makes the task's worktree and says where." }),
	obj({ action: lit("start"), id: Id, launch: DispatchArgsSchema }, { description: "M55: starts a session in the prepared worktree." }),
	obj({ action: lit("merge"), id: Id, mode: opt(oneOf(["ff", "no-ff"])) }, { description: "M55: merges the task's branch into base, locally." }),
	obj({ action: lit("back"), id: Id, note: opt(str(undefined, { maxLength: TASK_NOTE_MAX })) }, { description: "M55: returns it to working and tells its holder." }),
	obj({ action: lit("abort"), id: Id }, { description: "M55: gives up a conflicted sync." }),
	obj({ action: lit("commit"), id: Id, message: opt(str()) }, { description: "M55: commits what its worktree holds." }),
	// M56: the repository's commands approved (dry: shown); verify again; a failure accepted
	obj({ action: lit("approve"), id: Id, dry: opt(bool("Show the commands only.")), hash: opt(str()) }, { description: "M56: approves the repository's commands." }),
	obj({ action: lit("verify"), id: Id }, { description: "M56: runs the verify command again." }),
	obj({ action: lit("pass"), id: Id }, { description: "M56: accepts a failure." }),
	// M58: a person's comments on lines of the task's diff (sent with back)
	obj({ action: lit("comment"), id: Id, comment: TaskComment }, { description: "M58: a review comment on a line of the task's diff." }),
	obj({ action: lit("uncomment"), id: Id, comment: obj({ file: str(), line: int(), at: num() }) }, { description: "M58: withdraws a review comment." }),
	// M59: put away (worktree removed, branch kept; start brings it back); leftovers removed (dry: listed)
	obj({ action: lit("shelve"), id: Id }, { description: "M59: removes a clean worktree, keeps the branch." }),
	// M60: push the branch and open a pull request (dry: what it would do; then with the tip shown as hash)
	obj({ action: lit("pr"), id: Id, dry: opt(bool("Say what it would do and the tip as `hash`.")), hash: opt(str("The tip shown by the dry run.")) }, { description: "M60: pushes the branch and opens a pull request." }),
]);
export type TaskArgs = Infer<typeof TaskArgsSchema>;

export const ConciergeArgsSchema = union([
	obj({ action: lit("on"), launch: opt(DispatchArgsSchema) }, { description: "Start it (a pi launch the hub built), or the job it had." }),
	obj({ action: lit("off") }, { description: "Stop it." }),
	obj({ action: lit("status") }, { description: "How it stands." }),
	obj({ action: lit("answer"), answer: ConciergeAnswerS }, { description: "M45: set the policy's answer." }),
	obj({ action: lit("act"), act: bool() }, { description: "M45: set the policy's act." }),
	obj({ action: lit("undo") }, { description: "M45: withdraw the last answer it gave a session." }),
]);
export type ConciergeArgs = Infer<typeof ConciergeArgsSchema>;

export const ConciergeActArgsSchema = union([
	obj({ what: oneOf(["stop", "respawn"]), id: str(), why: opt(str()) }),
	obj({ what: lit("dispatch"), launch: DispatchArgsSchema, why: opt(str()) }),
]);
export type ConciergeActArgs = Infer<typeof ConciergeActArgsSchema>;

/** M46: the standing orders. */
export const ConciergeOrderArgsSchema = union([
	obj({ action: lit("list") }, { description: "List them." }),
	obj({ action: lit("add"), text: str(undefined, { maxLength: ORDER_TEXT_MAX }), when: opt(str("M39's vocabulary (`every 30m`, `daily 18:00`, `weekdays 09:00`, `cron \"...\"`).")) }, { description: "Keep one (the hub's or the concierge's connection)." }),
	obj({ action: lit("rm"), id: int() }, { description: "Drop one (the hub's; the concierge's own only)." }),
	obj({ action: lit("applied"), id: int(), text: opt(str()) }, { description: "Mark one applied (the concierge's)." }),
]);
export type ConciergeOrderArgs = Infer<typeof ConciergeOrderArgsSchema>;

/** The literal values a union of objects discriminates on (the doc and the callers table read them). */
export function discriminants<const T extends string>(union: Schema, key: string): T[] {
	const members = (union as unknown as { anyOf: { properties: Record<string, { const?: string; enum?: string[] }> }[] }).anyOf;
	return members.flatMap((m) => {
		const p = m.properties[key];
		return p.const !== undefined ? [p.const as T] : (p.enum as T[]);
	});
}
export const TASK_ACTIONS: readonly TaskArgs["action"][] = discriminants(TaskArgsSchema, "action");
export const ORDER_ACTIONS: readonly ConciergeOrderArgs["action"][] = discriminants(ConciergeOrderArgsSchema, "action");

// -- the ops ------------------------------------------------------------------------------

const Empty = obj({});

/** Every op's arguments. */
export const ArgSchemas = {
	ping: Empty,
	schedules: obj({}, { description: "M39: scheduled tasks." }),
	"schedule-add": obj({ name: str(), when: str(), launch: DispatchArgsSchema, task: opt(str()), catchUp: opt(bool()) }),
	"schedule-rm": obj({ name: str() }),
	"schedule-pause": obj({ name: str(), paused: bool() }),
	"schedule-run": obj({ name: str() }),
	hello: HelloArgsSchema,
	list: obj({ all: opt(bool()), cwd: opt(str()) }),
	dispatch: DispatchArgsSchema,
	stop: obj({ id: str() }),
	rm: obj({ id: str() }),
	resolve: obj({ query: str() }),
	status: Empty,
	shutdown: obj({ keepWorkers: opt(bool()) }),
	subscribe: Empty,
	report: obj({ id: str(), token: str(), report: WorkerReportSchema }),
	reply: obj({
		id: str(),
		text: str(),
		mode: opt(ReplyModeS),
		requestId: opt(str("M36: makes a resend safe: the same id is taken once (the first answer is given again; one not of this form is ignored).", { pattern: "^[A-Za-z0-9_.:-]{1,64}$" })),
	}, { description: "M28: a reply to a working session steers into its current work (pi's Enter) or waits for it to finish (Alt+Enter); absent: waits." }),
	ack: obj({ id: str(), token: str(), seq: int(), exact: opt(bool()) }, { description: "Worker to daemon: the reply with this seq was handed to pi (exact: only that agent item)." }),
	respawn: obj({ id: opt(str()), all: opt(bool()), restart: opt(bool()), prompt: opt(str()) }, { description: "Start an ended job again from its session file; `restart` also restarts a live one." }),
	pin: obj({ id: str(), pinned: bool() }),
	rename: obj({ id: str(), name: str() }),
	reorder: obj({ ids: arr(str()), key: str() }, { description: "AV-K13: these jobs, in this order (the rest of their group keeps its place)." }),
	peer_register: obj({ session: opt(str()), name: str(), cwd: str(), pid: int("The pid that owns the session's writer lock.") }, { description: "M9: a foreground pi joins as a peer on this connection." }),
	peers: obj({}, { description: "M9, on a peer connection: the sessions this peer may message." }),
	send: obj({ to: str("A session's id or name (`peers` lists them)."), message: str(undefined, { maxLength: MESSAGE_MAX }) }),
	spawn: obj({ launch: DispatchArgsSchema }),
	handback: HandbackArgsSchema,
	peer_ack: obj({ ref: str() }, { description: "M9, on a foreground peer connection: the report with this ref reached pi." }),
	events: obj({ after: opt(int()), limit: opt(int()), id: opt(str()) }, { description: "M43: the event feed (what happened), with a cursor: `after` the seq last seen." }),
	watch: obj({ id: str(), when: oneOf(["idle", "ended"]) }, { description: "M43, on a peer connection: tell me once when that session is next idle (done, or waiting for an answer) or has ended." }),
	concierge: ConciergeArgsSchema,
	"concierge-ask": obj({ text: str() }, { description: "M44, from the hub: a question for the concierge (`? ...`); its answer comes as a `concierge` event." }),
	"concierge-say": obj({ kind: oneOf(["info", "need", "answer"]), text: str() }, { description: "M44, on the concierge's own connection: what it tells the user (hub_notify), or its answer to a question." }),
	"concierge-policy": empty({ description: "M45, on the concierge's connection: the policy in force (which of its tools it may use)." }),
	"concierge-suggest": obj({ id: str(), text: str(), why: opt(str()) }, { description: "M45, on the concierge's connection: the answer it would give a session that waits for one, and why." }),
	"concierge-reply": obj({ id: str(), text: str(), why: opt(str()) }, { description: "M45, on the concierge's connection: an answer in the user's place; refused (`policy`) unless the policy allows." }),
	"concierge-act": ConciergeActArgsSchema,
	"concierge-order": ConciergeOrderArgsSchema,
	task: TaskArgsSchema,
};

const ConciergePolicyS = obj({ answer: ConciergeAnswerS, act: bool() }, { description: "The policy in force: the setting, until `/concierge answer` or `act` changed it." });
const NameId = obj({ id: str(), name: str() });

/** Every op's result. */
export const ResultSchemas = {
	ping: obj({ pid: num(), version: str() }),
	schedules: obj({ schedules: arr(ScheduleRowSchema) }),
	"schedule-add": ScheduleRowSchema,
	"schedule-rm": obj({ name: str() }),
	"schedule-pause": ScheduleRowSchema,
	"schedule-run": obj({ name: str(), id: str() }),
	hello: HelloResultSchema,
	list: obj({ jobs: arr(JobRowSchema) }),
	dispatch: NameId,
	stop: obj({ id: str() }),
	rm: obj({ id: str(), worktree: opt(obj({ path: str(), branch: str(), removed: bool(), branchKept: bool(), reason: opt(str()) }, { description: "M10: what happened to the session's worktree." })) }),
	resolve: obj({ id: str() }),
	status: DaemonStatusSchema,
	shutdown: Empty,
	subscribe: Empty,
	report: Empty,
	reply: obj({
		delivered: bool("handed to the live worker"),
		saved: bool("kept for its next start (PK-5)"),
		stopped: opt(bool()),
		respawned: opt(bool()),
		error: opt(str()),
		duplicate: opt(bool()),
	}),
	ack: Empty,
	respawn: obj({ results: arr(obj({ id: str(), started: bool(), error: opt(str()) })) }),
	pin: obj({ id: str(), pinned: bool() }),
	rename: obj({ id: str(), name: str() }),
	reorder: Empty,
	peer_register: obj({ id: str() }),
	peers: obj({ peers: arr(PeerRowSchema) }),
	send: SendResultSchema,
	spawn: NameId,
	handback: obj({ routed: bool() }),
	peer_ack: Empty,
	events: obj({ events: arr(domain<RoostEvent>("RoostEvent", "An event of the feed (lib/events.ts).")), cursor: num() }),
	watch: obj({ id: str(), name: str(), when: oneOf(["idle", "ended"]), fired: bool("It was already so; the notice went out at once.") }),
	concierge: domain<ConciergeStatus>("ConciergeStatus", "How the concierge stands (lib/concierge.ts)."),
	"concierge-ask": obj({ id: str() }),
	"concierge-say": Empty,
	"concierge-policy": ConciergePolicyS,
	"concierge-suggest": NameId,
	"concierge-reply": NameId,
	"concierge-act": NameId,
	"concierge-order": obj({ orders: arr(domain<StandingOrder>("StandingOrder", "A standing order (lib/concierge.ts).")), order: opt(domain<StandingOrder>("StandingOrder", "The order acted on.")) }),
	task: obj({
		tasks: arr(domain<BoardTask>("BoardTask", "A task of the board (lib/board.ts)."), "M47: the board as it stands."),
		task: opt(domain<BoardTask>("BoardTask", "The task acted on.")),
		sent: opt(oneOf(SEND_OUTCOMES, "How the hand-over message went.")),
		job: opt(obj({ id: str(), name: str() })),
		note: opt(str()),
		hash: opt(str()),
		workspace: opt(obj({ path: str(), branch: str(), baseRef: str(), baseSha: str(), sourceDirty: opt(bool()) })),
	}),
};

export type OpArgs = { [O in keyof typeof ArgSchemas]: Infer<(typeof ArgSchemas)[O]> };
export type OpResults = { [O in keyof typeof ResultSchemas]: Infer<(typeof ResultSchemas)[O]> };
/** The names of the ops, in the order of the schemas. */
export const OPS = Object.keys(ArgSchemas) as (keyof typeof ArgSchemas)[];
