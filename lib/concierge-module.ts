// M69: the daemon's concierge and its standing orders as a module: the resident agent's state
// (which job, the feed cursor, what it said), its wakes (coalesced, capped, budgeted, retried),
// its heartbeat, the ops it and the hub use, and the orders it keeps. Ports are narrow; time is
// the Clock's; the module reads no environment (the daemon passes the timings).
import { isAbsolute } from "node:path";
import { type Clock, systemClock, type Timer } from "./clock.ts";
import { THINKING_LEVELS } from "./dispatch-input.ts";
import {
	CONCIERGE_ANSWERS,
	CONCIERGE_NAME,
	CONCIERGE_ROLE_ENV,
	type ConciergeAnswer,
	type ConciergeConfig,
	type ConciergePolicy,
	type ConciergeStatus,
	conciergeText,
	digestText,
	firstMessage,
	heartbeatMs,
	ORDER_MAX,
	ORDER_TEXT_MAX,
	oneLineText,
	type StandingOrder,
	undoText,
	type WakeWhy,
} from "./concierge.ts";
import type { BoardTask } from "./board.ts";
import { clipText, EVENT_LOG_MAX, type RoostEvent } from "./events.ts";
import { OpError, str } from "./op.ts";
import type { DispatchArgs, Event, JobRow } from "./protocol.ts";
import { nextRun, parseWhen } from "./schedule.ts";
import type { JobRecord } from "./store.ts";
import { todayOf } from "./usage.ts";

/** Whatever the daemon calls a connected session: a job or a foreground pi. */
export interface ConciergePeer {
	kind: "job" | "fg";
	id: string;
}

/** The ops of the concierge's family (the daemon's routing is one line). */
export type ConciergeOp = "concierge" | "concierge-ask" | "concierge-say" | "concierge-policy" | "concierge-suggest" | "concierge-reply" | "concierge-act" | "concierge-order";
export const CONCIERGE_OPS: readonly ConciergeOp[] = ["concierge", "concierge-ask", "concierge-say", "concierge-policy", "concierge-suggest", "concierge-reply", "concierge-act", "concierge-order"];

/** The parts of a job's record the concierge's own launch is built from. */
export type ConciergeLaunchSource = Pick<JobRecord, "kind" | "command" | "env" | "workspaceEnv" | "envDeny" | "envForce" | "piVersion">;

/** Who is on the other end of a connection `C`. */
export interface ConciergeSessionsPort<C> {
	/** The connection's peer (throws what the daemon throws for a connection that is not one). */
	require(conn: C): ConciergePeer;
	/** The connection's peer, if it has one (none: the hub's). */
	optional(conn: C): ConciergePeer | undefined;
	/** Runs `what` on job `id` as the hub's op (the policy let the concierge). */
	asHub(conn: C, what: "stop" | "respawn", id: string): Promise<unknown>;
}

/** The jobs: sessions the daemon runs. */
export interface ConciergeJobsPort {
	exists(id: string): boolean;
	/** The job's worker is up. */
	live(id: string): boolean;
	row(id: string): JobRow | undefined;
	/** Every row (the digest's fleet; a target by name). */
	list(): JobRow[];
	/** The job's state name from its state file (a suggestion lives while the row is blocked). */
	stateOf(id: string): string | undefined;
	/** The record the concierge's own launch is built from. */
	launchOf(id: string): ConciergeLaunchSource | undefined;
	/** A session file some job already owns. */
	sessionFileUsed(file: string): boolean;
	/** The path exists on disk. */
	pathExists(path: string): boolean;
	dispatch(launch: DispatchArgs, extra?: { role: "concierge" }): Promise<{ id: string; name: string }>;
	respawn(id: string): Promise<unknown>;
	/** Stops the job's host. */
	terminate(id: string): Promise<void>;
	/** An answer as a reply (the user's, or by `by`). */
	reply(args: { id: string; text: string; mode?: string }, by?: { who: string; whoId: string | null }): Promise<{ delivered: boolean; saved: boolean; error?: string }>;
	/** The digest as an agent item to job `id`; `reached`: it is with the session, or kept for it. */
	deliver(id: string, text: string): Promise<{ outcome: string; reached: boolean }>;
	/** The job's row changed (the hub's line). */
	pushJob(id: string): void;
}

/** The event feed. */
export interface ConciergeEventsPort {
	since(q: { after: number; limit: number }): { events: RoostEvent[]; cursor: number };
	cursor(): number;
}

/** A file the module keeps (the daemon's writes atomically under the roost's home). */
export interface ConciergeStore {
	read(): unknown;
	write(v: unknown): void;
}

export interface ConciergeDeps<C> {
	sessions: ConciergeSessionsPort<C>;
	jobs: ConciergeJobsPort;
	events: ConciergeEventsPort;
	/** The state file (concierge.json) and the orders (orders.json). */
	store: ConciergeStore;
	ordersStore: ConciergeStore;
	record(e: Omit<RoostEvent, "seq" | "at">): void;
	/** To the hub's subscribers. */
	push(event: Event): void;
	log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
	/** The `concierge` setting, with its defaults. */
	config(): ConciergeConfig;
	/** The shared task board (the digest lists it). */
	board(): BoardTask[];
	/** The daemon is going down: nothing is woken. */
	shuttingDown(): boolean;
	clock?: Clock;
	/** A burst of events is one wake (default 5 s). */
	coalesceMs?: number;
	/** A wake held back by the hourly cap or a full queue is tried again after this (default 60 s). */
	retryMs?: number;
	/** How often the heartbeat looks (default 30 s). */
	tickMs?: number;
	/** Tests shorten the heartbeat below what the setting allows (default: the setting's). */
	heartbeatMs?: number;
}

interface ConciergeState {
	id: string | null;
	on: boolean;
	/** The feed's seq it was last woken up to. */
	cursor: number;
	onAt: number | null;
	lastWakeAt: number | null;
	/** When it was woken, the last hour. */
	wakes: number[];
	notice: ConciergeStatus["notice"];
	answer: ConciergeStatus["answer"];
	/** M45: the policy `/concierge answer|act` set (null: the setting's). */
	policy: ConciergePolicy | null;
	/** M45: its suggested answers, by the job that waits, with the question each was for. */
	suggestions: Record<string, { text: string; why: string | null; at: number; question: string | null }>;
	/** M45: the answers it gave sessions in the user's place, newest last (the last 20). */
	answered: NonNullable<ConciergeStatus["answered"]>[];
}

export interface Concierge<C> {
	/** Loads both files; call once the jobs are known (a suggestion for a row that no longer waits is dropped). */
	load(): void;
	/** Arms the heartbeat and nudges once (what happened while the service was off). */
	start(): void;
	/** Clears every timer. */
	stop(): void;
	/** An op of the family (args as the socket brings them). */
	op(name: ConciergeOp, conn: C, args: any): Promise<unknown>;
	/** Something happened: wake it once the burst is over. */
	nudge(): void;
	status(): ConciergeStatus;
	isConcierge(id: string | undefined | null): boolean;
	/** The peer is the concierge's own job. */
	isPeer(peer: ConciergePeer): boolean;
	/** An event of its own doing (not in its digests, not news to it). */
	own(e: Pick<RoostEvent, "id" | "whoId">): boolean;
	/** A name a session reports for itself: not the concierge's, unless it is the concierge. */
	safeName(id: string, name: string | null | undefined): string | null;
	/** The launch of a session the concierge starts (built from its own job's). */
	launch(launch: DispatchArgs): DispatchArgs;
	/** Whether the policy lets it start, stop and restart sessions. */
	mayAct(): boolean;
	/** `{ suggested }` for a row the concierge has a suggestion for (null: stale), else `{}`. */
	suggestionField(id: string, st: { state?: unknown; question?: unknown }): { suggested?: JobRow["suggested"] };
	/** A suggestion for the row is spent or stale; true when there was one. */
	dropSuggestion(id: string): boolean;
	/** A job was removed (call after its record goes): the concierge's is the concierge off; another's suggestion goes. */
	removed(id: string): void;
}

const HOUR_MS = 3600_000;

export function createConcierge<C>(deps: ConciergeDeps<C>): Concierge<C> {
	const { sessions, jobs, events, record, push, log } = deps;
	const clock = deps.clock ?? systemClock;
	const coalesceMs = deps.coalesceMs ?? 5000;
	const retryMs = deps.retryMs ?? 60_000;
	const tickMs = deps.tickMs ?? 30_000;
	const heartbeatOverride = deps.heartbeatMs ?? 0;
	const config = () => deps.config();

	let state: ConciergeState = { id: null, on: false, cursor: 0, onAt: null, lastWakeAt: null, wakes: [], notice: null, answer: null, policy: null, suggestions: {}, answered: [] };
	/** The coalesce wait or the retry wait (one at a time). */
	let wakeTimer: Timer | null = null;
	let ticker: Timer | null = null;
	let overBudget = false;
	/** One wake at a time; something that happened during one is a wake after it (a heartbeat, if `on` asked for one). */
	let waking = false;
	let nudged: false | WakeWhy = false;
	/** One `on` at a time. */
	let onPending: Promise<ConciergeStatus> | undefined;
	const orders = new Map<number, StandingOrder>();
	/** The next order's id: never one that was used (a dropped #5 is not the next order's). */
	let orderNext = 1;

	const isConcierge = (id: string | undefined | null): boolean => !!id && id === state.id;
	const isPeer = (peer: ConciergePeer): boolean => peer.kind === "job" && isConcierge(peer.id);
	const safeName = (id: string, name: string | null | undefined): string | null => (name === CONCIERGE_NAME && !isConcierge(id) ? null : (name ?? null));
	const own = (e: Pick<RoostEvent, "id" | "whoId">): boolean => !!state.id && (e.id === state.id || e.whoId === state.id);

	function load(): void {
		loadState();
		loadOrders();
	}

	function loadState(): void {
		const s = deps.store.read() as Partial<ConciergeState> | null | undefined;
		if (!s || typeof s !== "object") return;
		state = {
			id: str(s.id) ? s.id : null,
			on: s.on === true,
			cursor: typeof s.cursor === "number" ? s.cursor : 0,
			onAt: typeof s.onAt === "number" ? s.onAt : null,
			lastWakeAt: typeof s.lastWakeAt === "number" ? s.lastWakeAt : null,
			wakes: Array.isArray(s.wakes) ? s.wakes.filter((t): t is number => typeof t === "number") : [],
			notice: s.notice && typeof s.notice === "object" && str(s.notice.text) ? s.notice : null,
			answer: s.answer && typeof s.answer === "object" && str(s.answer.text) ? s.answer : null,
			policy:
				s.policy && typeof s.policy === "object" && (CONCIERGE_ANSWERS as readonly string[]).includes(String(s.policy.answer)) && typeof s.policy.act === "boolean"
					? { answer: s.policy.answer, act: s.policy.act }
					: null,
			// a suggestion for a row that no longer waits is stale
			suggestions: Object.fromEntries(
				Object.entries(s.suggestions && typeof s.suggestions === "object" ? s.suggestions : {})
					.filter(([id, v]) => jobs.exists(id) && v && typeof v === "object" && str((v as { text?: unknown }).text) && typeof (v as { at?: unknown }).at === "number" && jobs.stateOf(id) === "blocked")
					.map(([id, v]) => [id, { ...(v as object), question: str((v as { question?: unknown }).question) ? (v as { question: string }).question : null }]),
			) as ConciergeState["suggestions"],
			answered: Array.isArray(s.answered) ? s.answered.filter((a) => a && typeof a === "object" && str(a.id) && str(a.text) && typeof a.at === "number").slice(-20) : [],
		};
		// its job was removed while the service was off
		if (state.id && !jobs.exists(state.id)) {
			state.id = null;
			state.on = false;
		}
	}

	function save(): void {
		try {
			deps.store.write(state);
		} catch (err) {
			log("error", "concierge state not saved", { error: String(err) });
		}
	}

	function loadOrders(): void {
		const raw = deps.ordersStore.read() as StandingOrder[] | { next?: unknown; orders?: unknown } | null | undefined;
		// `{next, orders}`; a bare list (an older file, a hand-written one) is taken too
		const saved = Array.isArray(raw) ? raw : raw && Array.isArray(raw.orders) ? (raw.orders as StandingOrder[]) : null;
		if (!saved) return;
		const now = clock.now();
		for (const o of saved) {
			try {
				if (!o || typeof o !== "object" || !Number.isInteger(o.id) || o.id <= 0 || !str(o.text)) continue;
				const when = str(o.when) ? o.when : null;
				if (when) parseWhen(when);
				const at = Number.isFinite(o.at) ? o.at : now;
				orders.set(o.id, {
					id: o.id,
					text: oneLineText(o.text, ORDER_TEXT_MAX) || o.text.slice(0, ORDER_TEXT_MAX),
					when,
					by: o.by === "concierge" ? "concierge" : "user",
					at,
					lastAt: Number.isFinite(o.lastAt) ? o.lastAt : null,
					// a time that passed while the service was off is due now, once
					nextAt: when ? (Number.isFinite(o.nextAt) ? o.nextAt : nextRun(parseWhen(when), now, at)) : null,
					count: Number.isInteger(o.count) && o.count! > 0 ? o.count! : 0,
				});
			} catch (err) {
				log("warn", "standing order dropped", { id: o?.id, error: String(err) });
			}
		}
		const kept = !Array.isArray(raw) && Number.isInteger(raw?.next) ? (raw!.next as number) : 0;
		orderNext = Math.max(kept, Math.max(0, ...orders.keys()) + 1);
	}

	function saveOrders(): void {
		try {
			deps.ordersStore.write({ next: orderNext, orders: [...orders.values()] });
		} catch (err) {
			log("error", "standing orders not saved", { error: String(err) });
		}
	}

	/** The orders on a clock whose time has come. */
	function ordersDue(now: number): StandingOrder[] {
		return [...orders.values()].filter((o) => o.when && o.nextAt !== null && o.nextAt <= now);
	}

	/** Over its budget for the day? Said once when it changes (the hub shows it). */
	function budget(now: number): boolean {
		const cfg = config();
		const row = state.id ? jobs.row(state.id) : undefined;
		const spent = row?.usage ? todayOf(row.usage, now) : 0;
		const over = cfg.dailyBudgetUsd > 0 && spent >= cfg.dailyBudgetUsd;
		if (over !== overBudget) {
			overBudget = over;
			log("info", over ? "concierge over budget" : "concierge within budget", { spent, budget: cfg.dailyBudgetUsd });
			pushStatus();
		}
		return over;
	}

	/** A wake that could not go now (the cap, a full queue) is tried again later. */
	function retry(why: WakeWhy): void {
		if (wakeTimer || deps.shuttingDown()) return;
		wakeTimer = clock.timer(() => {
			wakeTimer = null;
			void wake(why).catch((err: unknown) => log("error", "concierge wake failed", { error: String(err) }));
		}, retryMs);
	}

	function status(): ConciergeStatus {
		const now = clock.now();
		const row = state.id ? jobs.row(state.id) : undefined;
		const cfg = config();
		const behind = state.on && state.id ? events.since({ after: state.cursor, limit: EVENT_LOG_MAX }).events.filter((e) => !own(e)).length : 0;
		return {
			on: state.on,
			id: state.id,
			state: row?.state ?? null,
			live: !!state.id && jobs.live(state.id),
			model: row?.model ?? null,
			wakesLastHour: state.wakes.filter((t) => now - t < HOUR_MS).length,
			lastWakeAt: state.lastWakeAt,
			behind,
			costToday: row?.usage ? todayOf(row.usage, now) : 0,
			budget: cfg.dailyBudgetUsd,
			overBudget,
			notice: state.notice,
			policy: policy(),
			orders: orders.size,
			answered: state.answered.at(-1) ?? null,
			answer: state.answer,
		};
	}

	/** M45: the policy in force: what `/concierge answer|act` set, else the setting. */
	function policy(): ConciergePolicy {
		if (state.policy) return state.policy;
		const cfg = config();
		return { answer: cfg.answer, act: cfg.act };
	}

	function suggestionField(id: string, st: { state?: unknown; question?: unknown }): { suggested?: JobRow["suggested"] } {
		if (!(id in state.suggestions)) return {};
		const s = state.suggestions[id];
		const question = typeof st.question === "string" && st.question ? st.question : null;
		if (!s || st.state !== "blocked" || question !== s.question) return { suggested: null };
		return { suggested: { text: s.text, why: s.why, at: s.at } };
	}

	function dropSuggestion(id: string): boolean {
		if (!(id in state.suggestions)) return false;
		delete state.suggestions[id];
		save();
		return true;
	}

	function pushStatus(): void {
		push({ event: "concierge", status: status() });
	}

	/** The `concierge` op (the hub's, never a session's): on (a launch from the hub, or the job it has), off, status. */
	async function conciergeOp(args: { action?: unknown; launch?: unknown } | undefined): Promise<ConciergeStatus> {
		const action = args?.action;
		if (action === "status") return status();
		if (action === "off") {
			state.on = false;
			wakeTimer?.clear();
			wakeTimer = null;
			nudged = false;
			save();
			if (state.id && jobs.live(state.id)) await jobs.terminate(state.id);
			log("info", "concierge off", { id: state.id });
			pushStatus();
			return status();
		}
		// M45: the policy, and the undo
		if (action === "answer") {
			const answer = args && "answer" in args ? (args as { answer?: unknown }).answer : undefined;
			if (!(CONCIERGE_ANSWERS as readonly string[]).includes(String(answer))) throw new OpError("bad_request", "answer must be never, routine or always");
			state.policy = { ...policy(), answer: answer as ConciergeAnswer };
			save();
			if (state.id) record({ kind: "concierge", id: state.id, name: CONCIERGE_NAME, who: "user", why: "policy", text: `answer: ${answer}` });
			log("info", "concierge policy", { ...state.policy });
			pushStatus();
			return status();
		}
		if (action === "act") {
			const act = args && "act" in args ? (args as { act?: unknown }).act : undefined;
			if (typeof act !== "boolean") throw new OpError("bad_request", "act must be true or false");
			state.policy = { ...policy(), act };
			save();
			if (state.id) record({ kind: "concierge", id: state.id, name: CONCIERGE_NAME, who: "user", why: "policy", text: `act: ${act ? "on" : "off"}` });
			log("info", "concierge policy", { ...state.policy });
			pushStatus();
			return status();
		}
		if (action === "undo") return undo();
		if (action !== "on") throw new OpError("bad_request", "action must be on, off, status, answer, act or undo");
		if (onPending) return onPending;
		onPending = on(args?.launch).finally(() => {
			onPending = undefined;
		});
		return onPending;
	}

	/**
	 * On: the job it has (its session is its memory), started again if it ended, or a new
	 * one from the hub's launch. What happened while it was off is not its concern: its
	 * first wake is the fleet as it stands, at once.
	 */
	async function on(launch: unknown): Promise<ConciergeStatus> {
		const now = clock.now();
		const had = state.id;
		// already on and running (another hub, say): as it is, its backlog kept
		if (had && jobs.exists(had) && state.on && jobs.live(had)) return status();
		if (had && jobs.exists(had)) {
			state = { ...state, on: true, onAt: now, cursor: events.cursor(), lastWakeAt: null };
			save();
			if (!jobs.live(had)) await jobs.respawn(had).catch((err: unknown) => log("warn", "concierge restart failed", { error: String(err) }));
			log("info", "concierge on", { id: had });
		} else {
			const l = launch as DispatchArgs | undefined;
			if (!l || typeof l !== "object" || l.kind === "shell" || l.profile) throw new OpError("bad_request", "the concierge is a pi session: the hub builds its launch");
			const r = await jobs.dispatch({ ...l, name: CONCIERGE_NAME, requestId: undefined }, { role: "concierge" });
			state = { ...state, id: r.id, on: true, cursor: events.cursor(), onAt: now, lastWakeAt: null, wakes: [], notice: null, answer: null };
			overBudget = false;
			save();
			log("info", "concierge started", { id: r.id });
		}
		pushStatus();
		void wake("heartbeat").catch((err: unknown) => log("error", "concierge first wake failed", { error: String(err) }));
		return status();
	}

	/** Something happened: wake the concierge once the burst is over (after the wake under way, if one is). */
	function nudge(): void {
		if (!state.on || !state.id || deps.shuttingDown()) return;
		if (waking) {
			nudged ||= "events";
			return;
		}
		if (wakeTimer) return;
		wakeTimer = clock.timer(() => {
			wakeTimer = null;
			void wake("events").catch((err: unknown) => log("error", "concierge wake failed", { error: String(err) }));
		}, coalesceMs);
		// the hub's line says how much is new
		pushStatus();
	}

	/**
	 * One wake: the events since its cursor (its own left out) and the fleet, as a digest
	 * delivered like an agent message (its queue; an ended concierge starts again for it).
	 * Held back while it is over its budget for the day, or over its wakes for the hour.
	 */
	async function wake(why: WakeWhy): Promise<boolean> {
		const id = state.id;
		if (!state.on || !id || !jobs.exists(id) || deps.shuttingDown()) return false;
		if (waking) {
			nudged = why !== "events" ? why : nudged || "events";
			return false;
		}
		const cfg = config();
		const { events: all, cursor } = events.since({ after: state.cursor, limit: EVENT_LOG_MAX });
		const evs = all.filter((e) => !own(e));
		const now = clock.now();
		// M46: the orders on a clock due now (carried by whatever wake comes first); an order wake
		// whose orders an earlier wake took meanwhile (a retry, a nudge) is an events wake
		const due = ordersDue(now);
		if (why === "order" && due.length === 0) why = "events";
		if (why === "events" && evs.length === 0) {
			if (cursor !== state.cursor) {
				state.cursor = cursor;
				save();
			}
			return false;
		}
		if (budget(now)) return false;
		state.wakes = state.wakes.filter((t) => now - t < HOUR_MS);
		if (state.wakes.length >= cfg.wakesPerHour) {
			log("info", "concierge wake held", { wakes: state.wakes.length, cap: cfg.wakesPerHour });
			retry(why);
			return false;
		}
		const rows = jobs.list().filter((r) => r.id !== id);
		const text = digestText({ why, events: evs, rows, sinceAt: state.lastWakeAt, now, orders: [...orders.values()], due, board: deps.board() });
		// an `on` during the wake starts it over (its cursor is not this wake's to set)
		const epoch = state.onAt;
		waking = true;
		let r: Awaited<ReturnType<ConciergeJobsPort["deliver"]>>;
		try {
			r = await jobs.deliver(id, text);
		} catch (err) {
			// its queue full, say: later (with whatever happened meanwhile)
			waking = false;
			nudged = false;
			log("warn", "concierge not woken", { why, error: String(err) });
			retry(why);
			return false;
		} finally {
			waking = false;
		}
		try {
			log("info", "concierge woken", { why, events: evs.length, outcome: r.outcome });
			if (!state.on || state.id !== id) {
				// turned off (or replaced) while the wake started it: not left running
				if (!state.on && jobs.live(id)) await jobs.terminate(id).catch(() => {});
				return false;
			}
			if (state.onAt !== epoch) return false;
			if (r.outcome === "stopped") {
				// the user stopped it: that is off
				state.on = false;
				save();
				pushStatus();
				return false;
			}
			if (!r.reached) return false;
			state.cursor = cursor;
			state.lastWakeAt = now;
			state.wakes.push(now);
			save();
			// the clock orders it was woken with move on to their next time (once each)
			if (due.length > 0) {
				for (const o of due) {
					try {
						o.nextAt = o.when ? nextRun(parseWhen(o.when), now, o.at) : null;
					} catch {
						o.nextAt = null;
					}
				}
				saveOrders();
			}
			pushStatus();
			return true;
		} finally {
			// what happened during the wake is the next one; an `on` meanwhile wants the fleet now
			const next = nudged;
			nudged = false;
			if (next && next !== "events") void wake(next).catch((err: unknown) => log("error", "concierge wake failed", { error: String(err) }));
			else if (next) nudge();
		}
	}

	/** The heartbeat: a wake when nothing woke it for a while, so a stuck fleet is noticed. */
	function tick(now = clock.now()): void {
		if (!state.on || !state.id || deps.shuttingDown() || wakeTimer || waking) return;
		// the budget is looked at here too, so the hub's flag is right across midnight
		if (budget(now)) return;
		// M46: a standing order on a clock that is due is a wake of its own
		if (ordersDue(now).length > 0) {
			void wake("order").catch((err: unknown) => log("error", "concierge order wake failed", { error: String(err) }));
			return;
		}
		const hb = heartbeatOverride || heartbeatMs(config());
		if (hb === null) return;
		const last = state.lastWakeAt ?? state.onAt ?? now;
		if (now - last >= hb) void wake("heartbeat").catch((err: unknown) => log("error", "concierge heartbeat failed", { error: String(err) }));
	}

	function arm(): void {
		// a chain of one-shot timers (a Clock has no interval): the next is armed first, so the
		// period is fixed and a tick that throws (logged; it was an uncaught exception) stops nothing
		ticker = clock.timer(() => {
			if (ticker) arm();
			try {
				tick();
			} catch (err) {
				log("error", "concierge tick failed", { error: String(err) });
			}
		}, tickMs);
	}

	/** `concierge-say` on the concierge's connection: what it tells the user, or its answer. */
	function say(conn: C, args: { kind?: unknown; text?: unknown } | undefined): {} {
		const peer = sessions.require(conn);
		if (!isPeer(peer)) throw new OpError("unsupported", "only the concierge says things to the hub");
		const kind = args?.kind;
		const text = typeof args?.text === "string" ? args.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, " ").trim() : "";
		if (!text) throw new OpError("bad_request", "empty text");
		if (kind !== "info" && kind !== "need" && kind !== "answer") throw new OpError("bad_request", "kind must be info, need or answer");
		const now = clock.now();
		if (kind === "answer") state.answer = { text: text.slice(0, 4000), at: now };
		else state.notice = { kind, text: text.slice(0, 500), at: now };
		record({ kind: "concierge", id: peer.id, name: CONCIERGE_NAME, who: CONCIERGE_NAME, whoId: peer.id, why: kind, text: clipText(text) });
		save();
		pushStatus();
		return {};
	}

	/** `concierge-ask` from the hub: the user's question, as a reply to the concierge's session. */
	async function ask(args: { text?: unknown } | undefined): Promise<{ id: string }> {
		const text = typeof args?.text === "string" ? args.text.trim() : "";
		if (!text) throw new OpError("bad_request", "empty question");
		if (!state.on || !state.id || !jobs.exists(state.id)) throw new OpError("unavailable", "the concierge is off (/concierge on)");
		await jobs.reply({ id: state.id, text });
		return { id: state.id };
	}

	// ---- M45: escalation and policy

	function requireConcierge(conn: C): ConciergePeer {
		const peer = sessions.require(conn);
		if (!isPeer(peer)) throw new OpError("unsupported", "only the concierge does this");
		return peer;
	}

	/** The job a concierge op names, by id or exact name; never the concierge itself. */
	function target(args: { id?: unknown } | undefined): JobRow {
		const id = typeof args?.id === "string" ? args.id.trim() : "";
		if (!id) throw new OpError("bad_request", "id required");
		const row = jobs.row(id) ?? jobs.list().find((r) => r.name === id);
		if (!row) throw new OpError("not_found", `no session ${id}`);
		if (isConcierge(row.id)) throw new OpError("bad_request", "that is you");
		return row;
	}

	/** `concierge-policy`: what it may do now (its tools follow it). */
	function policyOp(conn: C): ConciergePolicy {
		requireConcierge(conn);
		return policy();
	}

	/** `concierge-suggest`: the answer it would give a session that waits for one; on the row, for the hub. */
	function suggest(conn: C, args: { id?: unknown; text?: unknown; why?: unknown } | undefined): { id: string; name: string } {
		const peer = requireConcierge(conn);
		const row = target(args);
		const text = conciergeText(args?.text, 2000);
		if (!text) throw new OpError("bad_request", "empty suggestion");
		// the hub sends it as the user's reply with one key: plain text only
		if (text.startsWith("/") || text.startsWith("!")) throw new OpError("bad_request", "a suggestion is plain text, not a command");
		if (row.state !== "blocked") throw new OpError("bad_request", `${row.name} is not waiting for an answer (${row.state})`);
		const why = conciergeText(args?.why, 500) || null;
		state.suggestions[row.id] = { text, why, at: clock.now(), question: row.question ?? null };
		save();
		record({ kind: "concierge", id: row.id, name: row.name, who: CONCIERGE_NAME, whoId: peer.id, why: "suggest", text: clipText(text) });
		jobs.pushJob(row.id);
		return { id: row.id, name: row.name };
	}

	/** `concierge-reply`: an answer in the user's place, if the policy lets it; kept, so the user can undo it. */
	async function replyOp(conn: C, args: { id?: unknown; text?: unknown; why?: unknown } | undefined): Promise<{ id: string; name: string }> {
		const peer = requireConcierge(conn);
		const pol = policy();
		if (pol.answer === "never") throw new OpError("policy", "the user answers questions (answer: never): suggest the answer instead (hub_suggest)");
		const row = target(args);
		const text = conciergeText(args?.text, 4000);
		if (!text) throw new OpError("bad_request", "empty answer");
		if (text.startsWith("/") || text.startsWith("!")) throw new OpError("bad_request", "an answer is plain text, not a command");
		if (row.state !== "blocked" || row.waitingFor !== "question") throw new OpError("bad_request", `${row.name} is not waiting for an answer to a question (${row.state}${row.waitingFor ? `, ${row.waitingFor}` : ""})`);
		const r = await jobs.reply({ id: row.id, text }, { who: CONCIERGE_NAME, whoId: peer.id });
		if (!(r.delivered || r.saved)) throw new OpError("unavailable", `not delivered to ${row.name}${r.error ? `: ${r.error}` : ""}`);
		state.answered = [...state.answered, { id: row.id, name: row.name, text, at: clock.now(), undone: false }].slice(-20);
		delete state.suggestions[row.id];
		save();
		log("info", "concierge answered", { id: row.id, why: conciergeText(args?.why, 200) || undefined });
		jobs.pushJob(row.id);
		pushStatus();
		return { id: row.id, name: row.name };
	}

	/** `concierge {action: "undo"}`: the last answer it gave is withdrawn: the session is told to disregard it. */
	async function undo(): Promise<ConciergeStatus> {
		const found = [...state.answered].reverse().find((a) => !a.undone);
		if (!found) throw new OpError("not_found", "nothing to undo: the concierge has answered no session");
		// the one undone goes last: the status (and the hub) say which
		const last = { ...found, undone: true };
		state.answered = [...state.answered.filter((a) => a !== found), last];
		save();
		const row = jobs.row(last.id);
		// still waiting with the question it answered (the answer not taken yet): a reply after it;
		// at work: a steer; waiting on something else (a new question, a dialog), or ended: marked only
		const how = !row || !jobs.exists(last.id) ? null : row.state === "working" ? "steer" : row.state === "blocked" && row.waitingFor === "question" && row.stateSince <= last.at ? "reply" : null;
		if (how) {
			await jobs.reply({ id: last.id, text: undoText(last.text), ...(how === "steer" ? { mode: "steer" } : {}) }).catch((err: unknown) => log("warn", "concierge undo not delivered", { id: last.id, error: String(err) }));
		}
		record({ kind: "concierge", id: last.id, name: last.name, who: "user", why: "undo", text: clipText(last.text) });
		log("info", "concierge answer undone", { id: last.id, how });
		pushStatus();
		return status();
	}

	/**
	 * M59: a session the concierge starts runs what the concierge runs: the daemon builds its
	 * launch from the concierge's own job (its pi, its flags, its environment and policy) and
	 * takes from the concierge's only the task, the directory, a new session file, the name,
	 * and a model and thinking level of the right shape. Nothing else it sent is used.
	 */
	function launchFor(launch: DispatchArgs): DispatchArgs {
		const ownRec = state.id ? jobs.launchOf(state.id) : undefined;
		if (!ownRec || ownRec.kind === "shell" || !Array.isArray(ownRec.command) || ownRec.command.length < 4 || ownRec.command[2] !== "--session") throw new OpError("bad_request", "the concierge's own launch is unknown: it cannot start sessions now");
		if (!launch || typeof launch !== "object" || !Array.isArray(launch.command)) throw new OpError("bad_request", "launch required");
		if (launch.kind === "shell" || launch.profile || launch.worktree) throw new OpError("bad_request", "the concierge starts pi sessions only");
		if (!str(launch.cwd) || !isAbsolute(launch.cwd) || !jobs.pathExists(launch.cwd)) throw new OpError("bad_request", "launch: cwd must be a directory");
		const sf = launch.sessionFile;
		if (!str(sf) || !isAbsolute(sf) || !sf.endsWith(".jsonl") || jobs.pathExists(sf) || jobs.sessionFileUsed(sf)) throw new OpError("bad_request", "launch: a new session file");
		// the task: the argument after "--" (one, the last), plain text
		const task = firstMessage(launch.command) ?? null;
		const ownDash = ownRec.command.indexOf("--");
		const flags = ownRec.command.slice(4, ownDash >= 0 ? ownDash : undefined);
		const without = (args: string[], flag: string) => args.filter((x, i) => x !== flag && args[i - 1] !== flag && !x.startsWith(`${flag}=`));
		const model = typeof launch.model === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@\/-]+$/.test(launch.model) ? launch.model : undefined;
		const thinking = typeof launch.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(launch.thinking) ? launch.thinking : undefined;
		let args = flags;
		if (model) args = [...without(args, "--model"), "--model", model];
		if (thinking) args = [...without(args, "--thinking"), "--thinking", thinking];
		const env = Object.fromEntries(Object.entries(ownRec.env ?? {}).filter(([k]) => k !== CONCIERGE_ROLE_ENV && !/^(ROOST|PI_ROOST|PI)_(JOB|SOCKET)/.test(k)));
		return {
			kind: "pi",
			cwd: launch.cwd,
			sessionFile: sf,
			command: [ownRec.command[0]!, ownRec.command[1]!, "--session", sf, ...args, ...(task ? ["--", task] : [])],
			env,
			name: oneLineText(typeof launch.name === "string" ? launch.name : "", 80) || "session",
			origin: "dispatch",
			...(ownRec.workspaceEnv ? { workspaceEnv: ownRec.workspaceEnv } : {}),
			...(ownRec.envDeny ? { envDeny: ownRec.envDeny } : {}),
			...(ownRec.envForce ? { envForce: ownRec.envForce } : {}),
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			...(ownRec.piVersion ? { piVersion: ownRec.piVersion } : {}),
		};
	}

	/** `concierge-act`: stop, restart or start a session, if the policy lets it. */
	async function act(conn: C, args: { what?: unknown; id?: unknown; launch?: unknown; why?: unknown } | undefined): Promise<{ id: string; name: string }> {
		const peer = requireConcierge(conn);
		if (!policy().act) throw new OpError("policy", "the concierge may not start, stop or restart sessions (act: off): ask the user to");
		const what = args?.what;
		const why = conciergeText(args?.why, 200);
		if (what === "stop" || what === "respawn") {
			const row = target(args);
			// the policy let it: the op runs as the hub's (the concierge's own connection is a session's)
			await sessions.asHub(conn, what, row.id);
			record({ kind: "concierge", id: row.id, name: row.name, who: CONCIERGE_NAME, whoId: peer.id, why: "act", text: `${what === "stop" ? "stopped" : "restarted"} ${row.name}${why ? `: ${why}` : ""}` });
			return { id: row.id, name: row.name };
		}
		if (what === "dispatch") {
			// M59: a pi session like the concierge's own, built here (not a command, a profile, a worktree; not a concierge)
			const r = await jobs.dispatch(launchFor(args?.launch as DispatchArgs));
			record({ kind: "concierge", id: r.id, name: r.name, who: CONCIERGE_NAME, whoId: peer.id, why: "act", text: `started ${r.name}${why ? `: ${why}` : ""}` });
			return r;
		}
		throw new OpError("bad_request", "what must be stop, respawn or dispatch");
	}

	// ---- M46: standing orders
	//
	// Rules in the user's words the concierge keeps: in every digest; the ones on a clock
	// wake it when due. The daemon keeps them (orders.json); the model applies them.

	/** `concierge-order`: keep, drop, list, mark applied. */
	function orderOp(conn: C, args: { action?: unknown; text?: unknown; when?: unknown; id?: unknown } | undefined): { orders: StandingOrder[]; order?: StandingOrder } {
		const peer = sessions.optional(conn);
		const by: StandingOrder["by"] = peer ? "concierge" : "user";
		const action = args?.action;
		const all = () => [...orders.values()].sort((a, b) => a.id - b.id);
		if (action === "list") return { orders: all() };
		if (action === "add") {
			const text = oneLineText(args?.text, ORDER_TEXT_MAX);
			if (!text) throw new OpError("bad_request", "empty order");
			if (orders.size >= ORDER_MAX) throw new OpError("full", `${ORDER_MAX} standing orders at most; drop one first`);
			const whenText = typeof args?.when === "string" ? args.when.trim() : "";
			let when: string | null = null;
			if (whenText) {
				try {
					parseWhen(whenText);
					when = whenText;
				} catch (err) {
					throw new OpError("bad_request", `when: ${(err as Error).message}`);
				}
			}
			const now = clock.now();
			const id = orderNext++;
			const order: StandingOrder = { id, text, when, by, at: now, lastAt: null, nextAt: when ? nextRun(parseWhen(when), now, now) : null, count: 0 };
			orders.set(id, order);
			saveOrders();
			if (state.id) record({ kind: "concierge", id: state.id, name: CONCIERGE_NAME, who: by, whoId: peer?.id ?? null, why: "order-kept", text: clipText(`#${id} ${when ? `${when} · ` : ""}${text}`) });
			log("info", "standing order kept", { id, by, when });
			pushStatus();
			return { orders: all(), order };
		}
		const id = typeof args?.id === "number" ? args.id : Number(args?.id);
		if (!Number.isInteger(id) || !orders.has(id)) throw new OpError("not_found", `no standing order #${String(args?.id)}`);
		const order = orders.get(id)!;
		if (action === "rm") {
			// the user's orders are the user's to drop
			if (peer && order.by !== "concierge") throw new OpError("unsupported", `#${id} is the user's order: only the hub drops it`);
			orders.delete(id);
			saveOrders();
			if (state.id) record({ kind: "concierge", id: state.id, name: CONCIERGE_NAME, who: by, whoId: peer?.id ?? null, why: "order-dropped", text: clipText(`#${id} ${order.text}`) });
			log("info", "standing order dropped", { id, by });
			pushStatus();
			return { orders: all() };
		}
		if (action === "applied") {
			if (!peer) throw new OpError("unsupported", "the concierge marks an order applied");
			order.lastAt = clock.now();
			order.count += 1;
			saveOrders();
			record({ kind: "concierge", id: state.id ?? peer.id, name: CONCIERGE_NAME, who: CONCIERGE_NAME, whoId: peer.id, why: "order", text: clipText(`#${id} ${conciergeText(args?.text, 500) || order.text}`) });
			return { orders: all(), order };
		}
		throw new OpError("bad_request", "action must be add, rm, list or applied");
	}

	async function op(name: ConciergeOp, conn: C, args: any): Promise<unknown> {
		switch (name) {
			case "concierge":
				return conciergeOp(args);
			case "concierge-ask":
				return ask(args);
			case "concierge-say":
				return say(conn, args);
			case "concierge-policy":
				return policyOp(conn);
			case "concierge-suggest":
				return suggest(conn, args);
			case "concierge-reply":
				return replyOp(conn, args);
			case "concierge-act":
				return act(conn, args);
			case "concierge-order":
				return orderOp(conn, args);
		}
		throw new OpError("bad_request", `unknown op: ${String(name)}`);
	}

	return {
		load,
		start() {
			if (!ticker) arm();
			// what happened while the service was off
			nudge();
		},
		stop() {
			const t = ticker;
			ticker = null;
			t?.clear();
			wakeTimer?.clear();
			wakeTimer = null;
		},
		op,
		nudge,
		status,
		isConcierge,
		isPeer,
		own,
		safeName,
		launch: launchFor,
		mayAct: () => policy().act,
		suggestionField,
		dropSuggestion,
		removed(id) {
			if (isConcierge(id)) {
				state = { ...state, id: null, on: false };
				save();
				pushStatus();
			} else dropSuggestion(id);
		},
	};
}
