// M63: who may do what. The daemon judges each connection a Caller (GLOSSARY.md: a Person,
// a Session, the Concierge, an Unregistered agent) and asks this table, once, before an op
// runs. Rules that need the daemon's state stay with the op (a job that was removed, who
// holds a task, the concierge's policy); this table is the caller's kind only.
//
// Every op of the protocol has a row (task and concierge-order: a row per action), so an op
// added without saying who may use it does not type-check. The refusals are the daemon's
// own words and codes, as they were before the table.
//
// Not here: the filter on a spawned session's first message (firstMessage in the daemon),
// a second guard of its own: it keeps a command out of a session's input, not a caller out
// of an op.
import type { Op } from "./protocol.ts";
import { ORDER_ACTIONS, TASK_ACTIONS } from "./protocol-schema.ts";

export type Caller =
	| { kind: "person" }
	| { kind: "unregistered" }
	| { kind: "concierge"; id: string }
	/** `job`: a session the daemon runs; `fg`: a foreground pi registered as a peer. */
	| { kind: "session"; form: "job" | "fg"; id: string };

export type CallerKind = Caller["kind"];

/**
 * The caller on a connection: an identified peer is a Session (the Concierge when its job
 * is the concierge's); a connection that said it is an agent but is not a peer (yet) is an
 * Unregistered agent; one that never said is the Person (the socket is the user's own).
 */
export function callerOf(conn: { peer?: { kind: "job" | "fg"; id: string }; agentSide?: boolean }, isConcierge: (jobId: string) => boolean): Caller {
	const p = conn.peer;
	if (!p) return conn.agentSide ? { kind: "unregistered" } : { kind: "person" };
	if (p.kind === "job" && isConcierge(p.id)) return { kind: "concierge", id: p.id };
	return { kind: "session", form: p.kind, id: p.id };
}

export interface Refusal {
	code: "unauthorized" | "unsupported";
	message: string;
}
type Rule = "allow" | Refusal;
/** A session's rule, or one for each form of session. */
type SessionRule = Rule | { job: Rule; fg: Rule };
export interface Policy {
	person: Rule;
	session: SessionRule;
	concierge: Rule;
	unregistered: Rule;
}

// The actions are the schemas' (lib/protocol-schema.ts): a new action there needs a row below.
export { ORDER_ACTIONS, TASK_ACTIONS };
type Expanded = "task" | "concierge-order";
export type PolicyKey =
	| Exclude<Op, Expanded>
	/** The op itself: an action not named (the op refuses it as a bad request). */
	| Expanded
	| `task.${(typeof TASK_ACTIONS)[number]}`
	| `concierge-order.${(typeof ORDER_ACTIONS)[number]}`;

const unsupported = (message: string): Refusal => ({ code: "unsupported", message });
const unauthorized = (message: string): Refusal => ({ code: "unauthorized", message });

const HUBS = unsupported("this is the hub's and the CLI's: a session has its own ops (send, spawn, watch, task)");
const NOT_PEER = unauthorized("this connection is not a peer (report as a worker, or peer_register)");
const ONLY_CONCIERGE = unsupported("only the concierge does this");
const BOARD_UNREGISTERED = unauthorized("a session acts on the board after its report is accepted");
const CONCIERGE_IS_HUBS = unsupported("the concierge is the hub's: a session cannot start, stop or ask it");
const ORDERS = unsupported("standing orders are the hub's and the concierge's");

const anyone: Policy = { person: "allow", session: "allow", concierge: "allow", unregistered: "allow" };
const personOnly: Policy = { person: "allow", session: HUBS, concierge: HUBS, unregistered: HUBS };
/** A peer's op: a Session's or the Concierge's. */
const peers: Policy = { person: NOT_PEER, session: "allow", concierge: "allow", unregistered: NOT_PEER };
const conciergeOnly = (refusal = ONLY_CONCIERGE): Policy => ({ person: NOT_PEER, session: refusal, concierge: "allow", unregistered: NOT_PEER });
const orders: Policy = { person: "allow", session: ORDERS, concierge: "allow", unregistered: ORDERS };
/** On the board: any caller but an Unregistered agent (the action's own rules follow). */
const board: Policy = { person: "allow", session: "allow", concierge: "allow", unregistered: BOARD_UNREGISTERED };
/** An action on a task's workspace: never a session's; the concierge as given. */
const workspace = (action: string, concierge: Rule): Policy => ({ person: "allow", session: unsupported(`/tasks ${action} is the hub's`), concierge, unregistered: BOARD_UNREGISTERED });
const personsWorkspace = (action: string) => workspace(action, unsupported(`/tasks ${action} is a person's (the hub's)`));
/** The hub and the concierge lead the board: a session refused. */
const lead = (refusal: Refusal): Policy => ({ ...board, session: refusal });

export const POLICY: Record<PolicyKey, Policy> = {
	// identifying: a worker's hello and report, a foreground peer's registration, a job's ack (each checks its token or lock)
	hello: anyone,
	report: anyone,
	peer_register: anyone,
	ack: anyone,
	// reading the roost
	ping: anyone,
	list: anyone,
	resolve: anyone,
	status: anyone,
	// the Person's: the hub and the CLI
	schedules: personOnly,
	"schedule-add": personOnly,
	"schedule-rm": personOnly,
	"schedule-pause": personOnly,
	"schedule-run": personOnly,
	dispatch: personOnly,
	subscribe: personOnly,
	stop: personOnly,
	rm: personOnly,
	respawn: personOnly,
	pin: personOnly,
	rename: personOnly,
	reorder: personOnly,
	reply: personOnly,
	shutdown: personOnly,
	events: { ...personOnly, session: unsupported("the event feed is read by the hub and the CLI, not by sessions"), concierge: "allow", unregistered: unsupported("the event feed is read by the hub and the CLI, not by sessions") },
	concierge: { person: "allow", session: CONCIERGE_IS_HUBS, concierge: CONCIERGE_IS_HUBS, unregistered: CONCIERGE_IS_HUBS },
	"concierge-ask": { person: "allow", session: CONCIERGE_IS_HUBS, concierge: CONCIERGE_IS_HUBS, unregistered: CONCIERGE_IS_HUBS },
	// a session's: messages, children, watches
	peers,
	send: peers,
	spawn: peers,
	watch: peers,
	handback: { ...peers, session: { job: "allow", fg: unsupported("only a background session reports back") } },
	peer_ack: { ...peers, session: { job: unsupported("only foreground peers acknowledge reports"), fg: "allow" }, concierge: unsupported("only foreground peers acknowledge reports") },
	// the Concierge's
	"concierge-say": conciergeOnly(unsupported("only the concierge says things to the hub")),
	"concierge-policy": conciergeOnly(),
	"concierge-suggest": conciergeOnly(),
	"concierge-reply": conciergeOnly(),
	"concierge-act": conciergeOnly(),
	// standing orders: the Person's and the Concierge's
	"concierge-order": orders,
	"concierge-order.list": orders,
	"concierge-order.add": orders,
	"concierge-order.rm": orders,
	"concierge-order.applied": orders,
	// the task board
	task: board,
	"task.list": board,
	"task.add": board,
	"task.release": board, // a session its own; the hub and the concierge any (the op checks who holds it)
	"task.done": board, // likewise
	"task.cleanup": { person: "allow", session: unsupported("cleanup is a person's (/tasks cleanup)"), concierge: unsupported("cleanup is a person's (/tasks cleanup)"), unregistered: BOARD_UNREGISTERED },
	"task.claim": {
		person: unsupported("a session claims a task (roost_task_claim); the hub hands one over (/tasks assign)"),
		session: "allow",
		concierge: unsupported("the concierge hands tasks over (hub_task_assign); it does not take them"),
		unregistered: BOARD_UNREGISTERED,
	},
	"task.drop": lead(unsupported("the hub and the concierge drop tasks; a session gives its back (roost_task_release)")),
	"task.assign": lead(unsupported("the hub and the concierge hand tasks over; a session claims one (roost_task_claim)")),
	// a task's workspace: the Person's; the Concierge starts one when its policy lets it act (the op checks), and sends one back
	"task.prepare": workspace("prepare", "allow"), // M65: the worktree a start goes into (the op checks the Concierge's act)
	"task.start": workspace("start", "allow"),
	"task.back": workspace("back", "allow"),
	"task.approve": workspace("approve", unsupported("a person approves a repository's commands (/tasks approve)")),
	"task.pr": workspace("pr", unsupported("a pull request is a person's (/tasks pr)")),
	"task.shelve": workspace("shelve", unsupported("shelving is a person's (/tasks shelve)")),
	"task.comment": workspace("comment", unsupported("review comments are a person's (the hub's review, the CLI)")),
	"task.uncomment": workspace("uncomment", unsupported("review comments are a person's (the hub's review, the CLI)")),
	"task.merge": personsWorkspace("merge"),
	"task.verify": personsWorkspace("verify"),
	"task.pass": personsWorkspace("pass"),
	"task.abort": personsWorkspace("abort"),
	"task.commit": personsWorkspace("commit"),
};

/** The row an op takes: task and concierge-order by their action (an action not in the table: the op's own row). */
export function policyKey(op: string, action?: unknown): PolicyKey | undefined {
	if (op === "task" || op === "concierge-order") {
		const k = typeof action === "string" ? `${op}.${action}` : "";
		return (Object.hasOwn(POLICY, k) ? k : op) as PolicyKey;
	}
	// an action's row is not an op's name ("task.merge" sent as an op is an unknown op)
	return !op.includes(".") && Object.hasOwn(POLICY, op) ? (op as PolicyKey) : undefined;
}

/** Whether the caller may do it: null, or the refusal. An op not in the table is the daemon's to refuse (unknown op). */
export function allow(caller: Caller, op: string, action?: unknown): Refusal | null {
	const key = policyKey(op, action);
	if (!key) return null;
	const p = POLICY[key];
	let rule: SessionRule = p[caller.kind];
	if (caller.kind === "session" && typeof rule === "object" && "job" in rule) rule = rule[caller.form];
	return rule === "allow" ? null : (rule as Refusal);
}
