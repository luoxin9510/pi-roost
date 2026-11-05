import { execFile, spawn } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { deferDurability, durable, readJson, setSyncErrorHandler, writeJsonAtomic } from "../lib/atomic.ts";
import { hostEntry } from "../lib/client.ts";
import {
	type AgentKind,
	DUPLICATE_WINDOW_MS,
	envelope,
	foregroundPeerId,
	isAgentKind,
	MAX_PENDING_AGENT,
	MAX_WATCHES,
	MESSAGE_MAX,
	MESSAGES_PER_MINUTE,
	noticeBody,
	RateLimiter,
	type Relation,
	relationOf,
	reportBody,
	sanitizeName,
	SPAWNS_PER_MINUTE,
	type TreeNode,
	WATCH_TTL_MS,
} from "../lib/comms.ts";
import { loadUserConfig } from "../lib/config.ts";
import { CONCIERGE_ANSWERS, CONCIERGE_DEFAULTS, CONCIERGE_NAME, CONCIERGE_ROLE_ENV, type ConciergeAnswer, type ConciergePolicy, type ConciergeStatus, digestText, heartbeatMs, undoText } from "../lib/concierge.ts";
import { clipText, EVENT_LOG_MAX, EventLog, type RoostEvent, stateMatters } from "../lib/events.ts";
import { checkTemplate, nextRun, parseWhen, runLaunch, runSlot, type Schedule, SCHEDULE_NAME, templateAgent } from "../lib/schedule.ts";
import { hostControl } from "../lib/hostclient.ts";
import { newJobId, newToken } from "../lib/ids.ts";
import { acquireDaemonLock, readWriterLock, releaseDaemonLock } from "../lib/locks.ts";
import { daemonLogPath, daemonSocketPath, ensureDirs, jobDir as jobDirOf, roostHome, rosterPath, runtimeDir } from "../lib/paths.ts";
import { isAlive, processStartToken, processStartTokenAsync, sameProcess } from "../lib/proc.ts";
import { JOB_ENV_NAMES } from "../lib/identity.ts";
import { telemetryFromEnv } from "../lib/telemetry.ts";
import {
	type DaemonStatus,
	type DispatchArgs,
	type Event,
	type HandbackArgs,
	type JobRow,
	type JobStateName,
	LineReader,
	type PeerRow,
	type SendResult,
	type WorkerReport,
	contextFrom,
	encodeLine,
	PROTOCOL_VERSION,
	type ScheduleRow,
} from "../lib/protocol.ts";
import { todayOf, usageFrom } from "../lib/usage.ts";
import {
	type JobRecord,
	type JobState,
	clearExit,
	clearWorker,
	createJob,
	listJobIds,
	readExit,
	readJob,
	readState,
	readWorkerPid,
	removeJob,
	isProfileJob,
	isProtocolJob,
	isTermJob,
	respawnCommand,
	screenPath,
	stateFile,
	termPath,
	updateState,
} from "../lib/store.ts";
import { termFrom } from "../lib/profiles.ts";
import { inferTermState, lastLine, readTermSignals } from "../lib/term-signals.ts";
import { type GhPr, isPrUrl, type PrInfo, prFromGh, prUrlsIn } from "../lib/pr.ts";
import { ROOST_VERSION } from "../lib/version.ts";
import { type CleanupResult, cleanupWorktree, isInside, validWorktree, type WorktreeInfo, worktreeLine, worktreeStatus } from "../lib/worktree.ts";

const WAIT_MS = 6000;
const CONTINUE = "Continue where you left off.";
/**
 * M38: automatic restarts of a run cut short, in a row, and the pause before each
 * (PI_ROOST_RESUME_DELAYS_MS="1000,5000,15000" changes them; tests shorten them).
 */
const RESUME_DELAYS_MS = (process.env.PI_ROOST_RESUME_DELAYS_MS ?? "1000,5000,15000")
	.split(",")
	.map(Number)
	.filter((n) => Number.isFinite(n) && n >= 0);
/** M38: a run interrupted longer ago than this (by the machine or the service) is not resumed by itself. */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;
/** DM-7: a run that last made progress within this long ago ended by surprise. */
const RECENT_MS = 48 * 60 * 60 * 1000;
const REAP_CHECK_MS = 30_000;
const CRASH_RESET_MS = 60_000;
/** DI-6: a finished shell job's row stays this long. */
const SHELL_KEEP_MS = Number(process.env.PI_ROOST_SHELL_KEEP_MS) || 5 * 60_000;

class OpError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

// M35: durable writes are synced in groups, off the loop; answers wait for them (onLine)
deferDurability(true);
setSyncErrorHandler((err) => log("error", "sync failed", { error: String(err) }));

// M34: spans and metrics where the daemon's time goes (ROOST_TELEMETRY=path; off by default)
const telemetry = telemetryFromEnv("daemon");
const metric = {
	events: telemetry.counter("roost.events"),
	replies: telemetry.counter("roost.replies"),
	ackLatency: telemetry.histogram("roost.reply.ack_latency"),
	deliverLatency: telemetry.histogram("roost.reply.deliver_latency"),
	reports: telemetry.counter("roost.reports"),
	stateChanges: telemetry.counter("roost.state_changes"),
	reaped: telemetry.counter("roost.reaped"),
	cleaned: telemetry.counter("roost.cleaned"),
	hostStart: telemetry.histogram("roost.host.start"),
};
/** M34: when each pending reply came in (job id → seq), for its deliver and ack latency. */
const replyAt = new Map<string, Map<number, { at: number; sent: boolean }>>();
function replyIn(id: string, seq: number, kind = "reply"): void {
	if (!telemetry.enabled) return;
	let m = replyAt.get(id);
	if (!m) replyAt.set(id, (m = new Map()));
	m.set(seq, { at: Date.now(), sent: false });
	metric.replies.add(1, { kind });
}
function replySent(id: string, seq: number): void {
	const r = replyAt.get(id)?.get(seq);
	if (!r || r.sent) return;
	r.sent = true;
	metric.deliverLatency.record(Date.now() - r.at);
}
function repliesAcked(id: string, gone: number[]): void {
	const m = replyAt.get(id);
	if (!m) return;
	const now = Date.now();
	for (const seq of gone) {
		const r = m.get(seq);
		if (!r) continue;
		metric.ackLatency.record(now - r.at);
		m.delete(seq);
	}
	if (m.size === 0) replyAt.delete(id);
}

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void {
	try {
		appendFileSync(daemonLogPath(), `${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
	} catch {}
}

process.on("uncaughtException", (err) => log("error", "uncaughtException", { error: String(err?.stack ?? err) }));
process.on("unhandledRejection", (err) => log("error", "unhandledRejection", { error: String(err) }));
process.on("SIGPIPE", () => {});

ensureDirs();
const lock = acquireDaemonLock({ version: ROOST_VERSION, socket: daemonSocketPath() });
if (!lock.ok) process.exit(0);

const startedAt = Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let ptyError: string | null = null;
try {
	await import("node-pty");
} catch (err) {
	ptyError = String((err as Error)?.message ?? err);
}

interface HostRef {
	hostPid: number;
	hostToken: string; // "" until the start token could be read
	/** M35: when the pid was last checked to still be this host (in memory only). */
	verifiedAt?: number;
}

/** M35: a live pid is checked to be its host again (one ps) at most this often. */
const HOST_VERIFY_MS = 30_000;

const recs = new Map<string, JobRecord>();
const roster = new Map<string, HostRef>();
const starting = new Set<string>();
const stopping = new Set<string>();
/** DM-4: being stopped for idleness; the row keeps its state. */
const reaping = new Set<string>();
/** M13: closing finished subagents (scheduleAutoClose). */
const AUTO_CLOSE_MS = Number(process.env.PI_ROOST_AUTO_CLOSE_MS) || 3000;
const closeTimers = new Map<string, NodeJS.Timeout>();
const respawning = new Set<string>();
const conns = new Set<Conn>();
/** The connection each live worker reports on; replies are pushed down it. */
const workerConns = new Map<string, Conn>();

/** M9: who is on the other end of a connection, once it has proved it. */
type PeerIdentity =
	| { kind: "job"; id: string }
	| { kind: "fg"; id: string; session?: string; name: string; cwd: string; pid: number };

interface Conn {
	sock: Socket;
	subscribed: boolean;
	peer?: PeerIdentity;
	/** M9: the worker on this connection takes agent items (older workers would inject them as user input). */
	agentItems?: boolean;
	/** M31: what the agent on this connection said in its hello. */
	hello?: { name: string; version: string | null; capabilities: string[] };
}

/** M9: connected foreground pi sessions, by peer id. */
const fgPeers = new Map<string, Conn>();
/** M10: rm could not stop the worker: its worktree is not cleaned up. */
const workerAlive = new Set<string>();
/** M9: jobs being removed (their end is reported as a removal, once). */
const removing = new Set<string>();
const messageLimiter = new RateLimiter(MESSAGES_PER_MINUTE);
const spawnLimiter = new RateLimiter(SPAWNS_PER_MINUTE);
/** M43: the last text each sender sent each session (an identical one soon after is dropped). */
const lastSent = new Map<string, { hash: string; at: number }>();
/** An agent item with this outcome is with the session, or kept for it. */
const reached = (outcome: SendResult["outcome"]) => outcome === "delivered" || outcome === "queued" || outcome === "started";

// ---- M43: the event feed ---------------------------------------------------------------

/** What happened, for the hub's /log, `pi-roost log` and (M44) the concierge; in roostHome. */
const eventLog = new EventLog(join(roostHome(), "events.jsonl"), { warn: (msg) => log("warn", msg) });

function record(e: Omit<RoostEvent, "seq" | "at">): void {
	eventLog.append(e);
	// M44: what the concierge itself caused is not news to it
	if (!(concierge.id && conciergeOwn(e))) nudgeConcierge();
}

// ---- M44: the concierge ---------------------------------------------------------------
//
// The hub's resident agent: an ordinary pi job (role "concierge") the hub starts, that the
// daemon wakes with a digest of what happened (coalesced, capped an hour, stopped by a
// daily budget) and a heartbeat. Its tools are ops on its own connection; it reaches
// every session. Its state (which job, the feed cursor, what it last said) is here.

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
const conciergePath = () => join(roostHome(), "concierge.json");
let concierge: ConciergeState = { id: null, on: false, cursor: 0, onAt: null, lastWakeAt: null, wakes: [], notice: null, answer: null, policy: null, suggestions: {}, answered: [] };
/** A burst of events is one wake. */
const CONCIERGE_COALESCE_MS = Number(process.env.PI_ROOST_CONCIERGE_COALESCE_MS) || 5000;
/** A wake held back by the hourly cap is tried again after this. */
const CONCIERGE_RETRY_MS = Number(process.env.PI_ROOST_CONCIERGE_RETRY_MS) || 60_000;
const CONCIERGE_TICK_MS = Number(process.env.PI_ROOST_CONCIERGE_TICK_MS) || 30_000;
/** Tests shorten the heartbeat below what the setting allows. */
const CONCIERGE_HEARTBEAT_MS = Number(process.env.PI_ROOST_CONCIERGE_HEARTBEAT_MS) || 0;
let conciergeTimer: NodeJS.Timeout | undefined;
let conciergeOverBudget = false;
/** One wake at a time; something that happened during one is a wake after it (a heartbeat, if `on` asked for one). */
let conciergeWaking = false;
let conciergeNudged: false | "events" | "heartbeat" = false;
/** One `on` at a time. */
let conciergeOnPending: Promise<ConciergeStatus> | undefined;

const conciergeConfig = () => loadUserConfig().concierge ?? CONCIERGE_DEFAULTS;
const isConcierge = (id: string | undefined | null): boolean => !!id && id === concierge.id;
const isConciergePeer = (peer: PeerIdentity): boolean => peer.kind === "job" && isConcierge(peer.id);
/** A name a session reports for itself (pi's /name): not the concierge's, unless it is the concierge. */
const conciergeSafeName = (id: string, name: string | null | undefined): string | null => (name === CONCIERGE_NAME && !isConcierge(id) ? null : (name ?? null));

function loadConcierge(): void {
	const s = readJson<Partial<ConciergeState>>(conciergePath());
	if (!s || typeof s !== "object") return;
	concierge = {
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
				.filter(([id, v]) => recs.has(id) && v && typeof v === "object" && str((v as { text?: unknown }).text) && typeof (v as { at?: unknown }).at === "number" && readState(id)?.state === "blocked")
				.map(([id, v]) => [id, { ...(v as object), question: str((v as { question?: unknown }).question) ? (v as { question: string }).question : null }]),
		) as ConciergeState["suggestions"],
		answered: Array.isArray(s.answered) ? s.answered.filter((a) => a && typeof a === "object" && str(a.id) && str(a.text) && typeof a.at === "number").slice(-20) : [],
	};
	// its job was removed while the service was off
	if (concierge.id && !recs.has(concierge.id)) {
		concierge.id = null;
		concierge.on = false;
	}
}

function saveConcierge(): void {
	try {
		writeJsonAtomic(conciergePath(), concierge);
	} catch (err) {
		log("error", "concierge state not saved", { error: String(err) });
	}
}

/** An event of the concierge's own doing: on its job, or caused by it (by id: a name can be shared). Not in its digests. */
function conciergeOwn(e: Pick<RoostEvent, "id" | "whoId">): boolean {
	return !!concierge.id && (e.id === concierge.id || e.whoId === concierge.id);
}

/** Over its budget for the day? Said once when it changes (the hub shows it). */
function conciergeBudget(now: number): boolean {
	const cfg = conciergeConfig();
	const row = concierge.id ? rowOf(concierge.id) : undefined;
	const spent = row?.usage ? todayOf(row.usage, now) : 0;
	const over = cfg.dailyBudgetUsd > 0 && spent >= cfg.dailyBudgetUsd;
	if (over !== conciergeOverBudget) {
		conciergeOverBudget = over;
		log("info", over ? "concierge over budget" : "concierge within budget", { spent, budget: cfg.dailyBudgetUsd });
		pushConcierge();
	}
	return over;
}

/** A wake that could not go now (the cap, a full queue) is tried again later. */
function conciergeRetry(why: "events" | "heartbeat"): void {
	if (conciergeTimer || shuttingDown) return;
	conciergeTimer = setTimeout(() => {
		conciergeTimer = undefined;
		void wakeConcierge(why).catch((err: unknown) => log("error", "concierge wake failed", { error: String(err) }));
	}, CONCIERGE_RETRY_MS);
	conciergeTimer.unref?.();
}

function conciergeStatus(): ConciergeStatus {
	const now = Date.now();
	const row = concierge.id ? rowOf(concierge.id) : undefined;
	const cfg = conciergeConfig();
	const behind = concierge.on && concierge.id ? eventLog.since({ after: concierge.cursor, limit: EVENT_LOG_MAX }).events.filter((e) => !conciergeOwn(e)).length : 0;
	return {
		on: concierge.on,
		id: concierge.id,
		state: row?.state ?? null,
		live: !!concierge.id && roster.has(concierge.id),
		model: row?.model ?? null,
		wakesLastHour: concierge.wakes.filter((t) => now - t < 3600_000).length,
		lastWakeAt: concierge.lastWakeAt,
		behind,
		costToday: row?.usage ? todayOf(row.usage, now) : 0,
		budget: cfg.dailyBudgetUsd,
		overBudget: conciergeOverBudget,
		notice: concierge.notice,
		policy: conciergePolicy(),
		answered: concierge.answered.at(-1) ?? null,
		answer: concierge.answer,
	};
}

/** M45: the policy in force: what `/concierge answer|act` set, else the setting. */
function conciergePolicy(): ConciergePolicy {
	if (concierge.policy) return concierge.policy;
	const cfg = conciergeConfig();
	return { answer: cfg.answer, act: cfg.act };
}

/** M45: the concierge's suggestion for a row, while the row waits with the question it was for. */
function suggestedFor(id: string, st: { state?: unknown; question?: unknown }): JobRow["suggested"] {
	const s = concierge.suggestions[id];
	if (!s || st.state !== "blocked" || (st.question ?? null) !== s.question) return null;
	return { text: s.text, why: s.why, at: s.at };
}

function dropSuggestion(id: string): boolean {
	if (!(id in concierge.suggestions)) return false;
	delete concierge.suggestions[id];
	saveConcierge();
	return true;
}

function pushConcierge(): void {
	push({ event: "concierge", status: conciergeStatus() });
}

/** The `concierge` op (the hub's, never a session's): on (a launch from the hub, or the job it has), off, status. */
async function conciergeOp(args: { action?: unknown; launch?: unknown } | undefined): Promise<ConciergeStatus> {
	const action = args?.action;
	if (action === "status") return conciergeStatus();
	if (action === "off") {
		concierge.on = false;
		clearTimeout(conciergeTimer);
		conciergeTimer = undefined;
		conciergeNudged = false;
		saveConcierge();
		if (concierge.id && roster.has(concierge.id)) await terminateHost(concierge.id);
		log("info", "concierge off", { id: concierge.id });
		pushConcierge();
		return conciergeStatus();
	}
	// M45: the policy, and the undo
	if (action === "answer") {
		const answer = args && "answer" in args ? (args as { answer?: unknown }).answer : undefined;
		if (!(CONCIERGE_ANSWERS as readonly string[]).includes(String(answer))) throw new OpError("bad_request", "answer must be never, routine or always");
		concierge.policy = { ...conciergePolicy(), answer: answer as ConciergeAnswer };
		saveConcierge();
		if (concierge.id) record({ kind: "concierge", id: concierge.id, name: CONCIERGE_NAME, who: "user", why: "policy", text: `answer: ${answer}` });
		log("info", "concierge policy", { ...concierge.policy });
		pushConcierge();
		return conciergeStatus();
	}
	if (action === "act") {
		const act = args && "act" in args ? (args as { act?: unknown }).act : undefined;
		if (typeof act !== "boolean") throw new OpError("bad_request", "act must be true or false");
		concierge.policy = { ...conciergePolicy(), act };
		saveConcierge();
		if (concierge.id) record({ kind: "concierge", id: concierge.id, name: CONCIERGE_NAME, who: "user", why: "policy", text: `act: ${act ? "on" : "off"}` });
		log("info", "concierge policy", { ...concierge.policy });
		pushConcierge();
		return conciergeStatus();
	}
	if (action === "undo") return conciergeUndo();
	if (action !== "on") throw new OpError("bad_request", "action must be on, off, status, answer, act or undo");
	if (conciergeOnPending) return conciergeOnPending;
	conciergeOnPending = conciergeOn(args?.launch).finally(() => {
		conciergeOnPending = undefined;
	});
	return conciergeOnPending;
}

/**
 * On: the job it has (its session is its memory), started again if it ended, or a new
 * one from the hub's launch. What happened while it was off is not its concern: its
 * first wake is the fleet as it stands, at once.
 */
async function conciergeOn(launch: unknown): Promise<ConciergeStatus> {
	const now = Date.now();
	const had = concierge.id;
	// already on and running (another hub, say): as it is, its backlog kept
	if (had && recs.has(had) && concierge.on && roster.has(had)) return conciergeStatus();
	if (had && recs.has(had)) {
		concierge = { ...concierge, on: true, onAt: now, cursor: eventLog.cursor(), lastWakeAt: null };
		saveConcierge();
		if (!roster.has(had)) await respawn(had).catch((err: unknown) => log("warn", "concierge restart failed", { error: String(err) }));
		log("info", "concierge on", { id: had });
	} else {
		const l = launch as DispatchArgs | undefined;
		if (!l || typeof l !== "object" || l.kind === "shell" || l.profile) throw new OpError("bad_request", "the concierge is a pi session: the hub builds its launch");
		const r = await dispatch({ ...l, name: CONCIERGE_NAME, requestId: undefined }, { role: "concierge" });
		concierge = { ...concierge, id: r.id, on: true, cursor: eventLog.cursor(), onAt: now, lastWakeAt: null, wakes: [], notice: null, answer: null };
		conciergeOverBudget = false;
		saveConcierge();
		log("info", "concierge started", { id: r.id });
	}
	pushConcierge();
	void wakeConcierge("heartbeat").catch((err: unknown) => log("error", "concierge first wake failed", { error: String(err) }));
	return conciergeStatus();
}

/** Something happened: wake the concierge once the burst is over (after the wake under way, if one is). */
function nudgeConcierge(): void {
	if (!concierge.on || !concierge.id || shuttingDown) return;
	if (conciergeWaking) {
		conciergeNudged ||= "events";
		return;
	}
	if (conciergeTimer) return;
	conciergeTimer = setTimeout(() => {
		conciergeTimer = undefined;
		void wakeConcierge("events").catch((err: unknown) => log("error", "concierge wake failed", { error: String(err) }));
	}, CONCIERGE_COALESCE_MS);
	conciergeTimer.unref?.();
	// the hub's line says how much is new
	pushConcierge();
}

/**
 * One wake: the events since its cursor (its own left out) and the fleet, as a digest
 * delivered like an agent message (its queue; an ended concierge starts again for it).
 * Held back while it is over its budget for the day, or over its wakes for the hour.
 */
async function wakeConcierge(why: "events" | "heartbeat"): Promise<boolean> {
	const id = concierge.id;
	if (!concierge.on || !id || !recs.has(id) || shuttingDown) return false;
	if (conciergeWaking) {
		conciergeNudged = why === "heartbeat" ? "heartbeat" : conciergeNudged || "events";
		return false;
	}
	const cfg = conciergeConfig();
	const { events: all, cursor } = eventLog.since({ after: concierge.cursor, limit: EVENT_LOG_MAX });
	const events = all.filter((e) => !conciergeOwn(e));
	if (why === "events" && events.length === 0) {
		if (cursor !== concierge.cursor) {
			concierge.cursor = cursor;
			saveConcierge();
		}
		return false;
	}
	const now = Date.now();
	if (conciergeBudget(now)) return false;
	concierge.wakes = concierge.wakes.filter((t) => now - t < 3600_000);
	if (concierge.wakes.length >= cfg.wakesPerHour) {
		log("info", "concierge wake held", { wakes: concierge.wakes.length, cap: cfg.wakesPerHour });
		conciergeRetry(why);
		return false;
	}
	const rows = list(undefined).filter((r) => r.id !== id);
	const text = digestText({ why, events, rows, sinceAt: concierge.lastWakeAt, now });
	// an `on` during the wake starts it over (its cursor is not this wake's to set)
	const epoch = concierge.onAt;
	conciergeWaking = true;
	let r: Awaited<ReturnType<typeof deliverAgent>>;
	try {
		r = await deliverAgent(recs.get(id)!.sessionFile, "digest", text, { from: "roost", relation: "external" });
	} catch (err) {
		// its queue full, say: later (with whatever happened meanwhile)
		conciergeWaking = false;
		conciergeNudged = false;
		log("warn", "concierge not woken", { why, error: String(err) });
		conciergeRetry(why);
		return false;
	} finally {
		conciergeWaking = false;
	}
	try {
		log("info", "concierge woken", { why, events: events.length, outcome: r.outcome });
		if (!concierge.on || concierge.id !== id) {
			// turned off (or replaced) while the wake started it: not left running
			if (!concierge.on && roster.has(id)) await terminateHost(id).catch(() => {});
			return false;
		}
		if (concierge.onAt !== epoch) return false;
		if (r.outcome === "stopped") {
			// the user stopped it: that is off
			concierge.on = false;
			saveConcierge();
			pushConcierge();
			return false;
		}
		if (!reached(r.outcome)) return false;
		concierge.cursor = cursor;
		concierge.lastWakeAt = now;
		concierge.wakes.push(now);
		saveConcierge();
		pushConcierge();
		return true;
	} finally {
		// what happened during the wake is the next one; an `on` meanwhile wants the fleet now
		const next = conciergeNudged;
		conciergeNudged = false;
		if (next === "heartbeat") void wakeConcierge("heartbeat").catch((err: unknown) => log("error", "concierge wake failed", { error: String(err) }));
		else if (next) nudgeConcierge();
	}
}

/** The heartbeat: a wake when nothing woke it for a while, so a stuck fleet is noticed. */
function conciergeTick(now = Date.now()): void {
	if (!concierge.on || !concierge.id || shuttingDown || conciergeTimer || conciergeWaking) return;
	// the budget is looked at here too, so the hub's flag is right across midnight
	if (conciergeBudget(now)) return;
	const hb = CONCIERGE_HEARTBEAT_MS || heartbeatMs(conciergeConfig());
	if (hb === null) return;
	const last = concierge.lastWakeAt ?? concierge.onAt ?? now;
	if (now - last >= hb) void wakeConcierge("heartbeat").catch((err: unknown) => log("error", "concierge heartbeat failed", { error: String(err) }));
}

/** `concierge-say` on the concierge's connection: what it tells the user, or its answer. */
function conciergeSay(conn: Conn, args: { kind?: unknown; text?: unknown } | undefined): {} {
	const peer = requirePeer(conn);
	if (!isConciergePeer(peer)) throw new OpError("unsupported", "only the concierge says things to the hub");
	const kind = args?.kind;
	const text = typeof args?.text === "string" ? args.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, " ").trim() : "";
	if (!text) throw new OpError("bad_request", "empty text");
	if (kind !== "info" && kind !== "need" && kind !== "answer") throw new OpError("bad_request", "kind must be info, need or answer");
	const now = Date.now();
	if (kind === "answer") concierge.answer = { text: text.slice(0, 4000), at: now };
	else concierge.notice = { kind, text: text.slice(0, 500), at: now };
	record({ kind: "concierge", id: peer.id, name: CONCIERGE_NAME, who: CONCIERGE_NAME, whoId: peer.id, why: kind, text: clipText(text) });
	saveConcierge();
	pushConcierge();
	return {};
}

/** `concierge-ask` from the hub: the user's question, as a reply to the concierge's session. */
async function conciergeAsk(args: { text?: unknown } | undefined): Promise<{ id: string }> {
	const text = typeof args?.text === "string" ? args.text.trim() : "";
	if (!text) throw new OpError("bad_request", "empty question");
	if (!concierge.on || !concierge.id || !recs.has(concierge.id)) throw new OpError("unavailable", "the concierge is off (/concierge on)");
	await reply({ id: concierge.id, text });
	return { id: concierge.id };
}

// ---- M45: escalation and policy ---------------------------------------------------------

function requireConcierge(conn: Conn): PeerIdentity {
	const peer = requirePeer(conn);
	if (!isConciergePeer(peer)) throw new OpError("unsupported", "only the concierge does this");
	return peer;
}

/** The job a concierge op names, by id or exact name; never the concierge itself. */
function conciergeTarget(args: { id?: unknown } | undefined): JobRow {
	const id = typeof args?.id === "string" ? args.id.trim() : "";
	if (!id) throw new OpError("bad_request", "id required");
	const row = rowOf(id) ?? list(undefined).find((r) => r.name === id);
	if (!row) throw new OpError("not_found", `no session ${id}`);
	if (isConcierge(row.id)) throw new OpError("bad_request", "that is you");
	return row;
}

const conciergeText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, max) : "");

/** `concierge-policy`: what it may do now (its tools follow it). */
function conciergePolicyOp(conn: Conn): ConciergePolicy {
	requireConcierge(conn);
	return conciergePolicy();
}

/** `concierge-suggest`: the answer it would give a session that waits for one; on the row, for the hub. */
function conciergeSuggest(conn: Conn, args: { id?: unknown; text?: unknown; why?: unknown } | undefined): { id: string; name: string } {
	const peer = requireConcierge(conn);
	const row = conciergeTarget(args);
	const text = conciergeText(args?.text, 2000);
	if (!text) throw new OpError("bad_request", "empty suggestion");
	// the hub sends it as the user's reply with one key: plain text only
	if (text.startsWith("/") || text.startsWith("!")) throw new OpError("bad_request", "a suggestion is plain text, not a command");
	if (row.state !== "blocked") throw new OpError("bad_request", `${row.name} is not waiting for an answer (${row.state})`);
	const why = conciergeText(args?.why, 500) || null;
	concierge.suggestions[row.id] = { text, why, at: Date.now(), question: row.question ?? null };
	saveConcierge();
	record({ kind: "concierge", id: row.id, name: row.name, who: CONCIERGE_NAME, whoId: peer.id, why: "suggest", text: clipText(text) });
	pushJob(row.id);
	return { id: row.id, name: row.name };
}

/** `concierge-reply`: an answer in the user's place, if the policy lets it; kept, so the user can undo it. */
async function conciergeReply(conn: Conn, args: { id?: unknown; text?: unknown; why?: unknown } | undefined): Promise<{ id: string; name: string }> {
	const peer = requireConcierge(conn);
	const policy = conciergePolicy();
	if (policy.answer === "never") throw new OpError("policy", "the user answers questions (answer: never): suggest the answer instead (hub_suggest)");
	const row = conciergeTarget(args);
	const text = conciergeText(args?.text, 4000);
	if (!text) throw new OpError("bad_request", "empty answer");
	if (text.startsWith("/") || text.startsWith("!")) throw new OpError("bad_request", "an answer is plain text, not a command");
	if (row.state !== "blocked" || row.waitingFor !== "question") throw new OpError("bad_request", `${row.name} is not waiting for an answer to a question (${row.state}${row.waitingFor ? `, ${row.waitingFor}` : ""})`);
	const r = await reply({ id: row.id, text }, { who: CONCIERGE_NAME, whoId: peer.id });
	if (!(r.delivered || r.saved)) throw new OpError("unavailable", `not delivered to ${row.name}${r.error ? `: ${r.error}` : ""}`);
	concierge.answered = [...concierge.answered, { id: row.id, name: row.name, text, at: Date.now(), undone: false }].slice(-20);
	delete concierge.suggestions[row.id];
	saveConcierge();
	log("info", "concierge answered", { id: row.id, why: conciergeText(args?.why, 200) || undefined });
	pushJob(row.id);
	pushConcierge();
	return { id: row.id, name: row.name };
}

/** `concierge {action: "undo"}`: the last answer it gave is withdrawn: the session is told to disregard it. */
async function conciergeUndo(): Promise<ConciergeStatus> {
	const found = [...concierge.answered].reverse().find((a) => !a.undone);
	if (!found) throw new OpError("not_found", "nothing to undo: the concierge has answered no session");
	// the one undone goes last: the status (and the hub) say which
	const last = { ...found, undone: true };
	concierge.answered = [...concierge.answered.filter((a) => a !== found), last];
	saveConcierge();
	const row = rowOf(last.id);
	// still waiting with the question it answered (the answer not taken yet): a reply after it;
	// at work: a steer; waiting on something else (a new question, a dialog), or ended: marked only
	const how = !row || !recs.has(last.id) ? null : row.state === "working" ? "steer" : row.state === "blocked" && row.waitingFor === "question" && row.stateSince <= last.at ? "reply" : null;
	if (how) {
		await reply({ id: last.id, text: undoText(last.text), ...(how === "steer" ? { mode: "steer" } : {}) }).catch((err: unknown) => log("warn", "concierge undo not delivered", { id: last.id, error: String(err) }));
	}
	record({ kind: "concierge", id: last.id, name: last.name, who: "user", why: "undo", text: clipText(last.text) });
	log("info", "concierge answer undone", { id: last.id, how });
	pushConcierge();
	return conciergeStatus();
}

/** `concierge-act`: stop, restart or start a session, if the policy lets it. */
async function conciergeAct(conn: Conn, args: { what?: unknown; id?: unknown; launch?: unknown; why?: unknown } | undefined): Promise<{ id: string; name: string }> {
	const peer = requireConcierge(conn);
	if (!conciergePolicy().act) throw new OpError("policy", "the concierge may not start, stop or restart sessions (act: off): ask the user to");
	const what = args?.what;
	const why = conciergeText(args?.why, 200);
	if (what === "stop" || what === "respawn") {
		const row = conciergeTarget(args);
		await handle(conn, what, { id: row.id });
		record({ kind: "concierge", id: row.id, name: row.name, who: CONCIERGE_NAME, whoId: peer.id, why: "act", text: `${what === "stop" ? "stopped" : "restarted"} ${row.name}${why ? `: ${why}` : ""}` });
		return { id: row.id, name: row.name };
	}
	if (what === "dispatch") {
		const launch = args?.launch as DispatchArgs | undefined;
		if (!launch || typeof launch !== "object" || !Array.isArray(launch.command)) throw new OpError("bad_request", "launch required");
		// a pi session like the hub's: not a command, not a profile, not a worktree; and not a concierge, nor this one's job
		if (launch.kind === "shell" || launch.profile || launch.worktree) throw new OpError("bad_request", "the concierge starts pi sessions only");
		const env = Object.fromEntries(Object.entries(launch.env ?? {}).filter(([k]) => k !== CONCIERGE_ROLE_ENV && !/^(ROOST|PI_ROOST|PI)_(JOB|SOCKET)/.test(k)));
		const r = await dispatch({ ...launch, env, origin: "dispatch", requestId: undefined });
		record({ kind: "concierge", id: r.id, name: r.name, who: CONCIERGE_NAME, whoId: peer.id, why: "act", text: `started ${r.name}${why ? `: ${why}` : ""}` });
		return r;
	}
	throw new OpError("bad_request", "what must be stop, respawn or dispatch");
}

/** The state each job was last seen in: a change into one that matters is recorded, and fires watches. */
const lastSeen = new Map<string, { state: JobStateName; waitingFor: JobRow["waitingFor"]; question: string | null }>();

/** A job's row went out: a state change that matters is an event (and may fire a watch). */
function noteState(job: JobRow): void {
	const prev = lastSeen.get(job.id);
	lastSeen.set(job.id, { state: job.state, waitingFor: job.waitingFor, question: job.question });
	if (!prev) return;
	// what a blocked session waits for changing (a question, then a dialog) matters; a row
	// going quiet (no worker: waitingFor null) or being restored is not a change
	const waits = job.state === "blocked" && prev.state === "blocked" && !!prev.waitingFor && !!job.waitingFor && prev.waitingFor !== job.waitingFor;
	// M45: a suggestion is for the question the row waited with (another question, the same wait, is another)
	if ((prev.state === "blocked" && job.state !== "blocked") || waits || (job.state === "blocked" && prev.question !== job.question)) dropSuggestion(job.id);
	if (prev.state === job.state && !waits) return;
	if (stateMatters(prev.state, job.state) || job.state === "blocked") {
		const text = job.state === "blocked" ? job.question : job.state === "failed" ? job.error : job.state === "done" ? job.summary : null;
		record({ kind: "state", id: job.id, name: job.name, state: job.state, from: prev.state, waitingFor: job.waitingFor, text: clipText(text) });
	}
	if (job.state !== "working") void fireWatches(job);
}

/** M43: a watch: tell `watcher` (a session key) once when job `id` is next idle, or has ended. */
interface Watch {
	watcher: string;
	watcherName: string;
	/** The watching job, when a job watches (null: a foreground session). */
	watcherId?: string | null;
	id: string;
	when: "idle" | "ended";
	at: number;
}
const watchesPath = () => join(roostHome(), "watches.json");
let watches: Watch[] = [];
const WATCH_TTL = Number(process.env.PI_ROOST_WATCH_TTL_MS) || WATCH_TTL_MS;

function loadWatches(): void {
	const saved = readJson<Watch[]>(watchesPath());
	if (!Array.isArray(saved)) return;
	const now = Date.now();
	watches = saved.filter((w) => w && str(w.watcher) && str(w.id) && (w.when === "idle" || w.when === "ended") && typeof w.at === "number" && now - w.at < WATCH_TTL && recs.has(w.id));
}

function saveWatches(): void {
	try {
		writeJsonAtomic(watchesPath(), watches);
	} catch (err) {
		log("error", "watches not saved", { error: String(err) });
	}
}

/** Watches that never fired expire; ones on removed jobs go. */
function sweepWatches(now = Date.now()): void {
	const before = watches.length;
	watches = watches.filter((w) => now - w.at < WATCH_TTL && recs.has(w.id));
	if (watches.length !== before) saveWatches();
}

/** idle: it stopped working (done, waiting, failed, stopped); ended: it failed, was stopped, or is gone. */
function watchFires(when: Watch["when"], state: JobStateName | "removed"): boolean {
	if (state === "removed") return true;
	if (when === "ended") return state === "failed" || state === "stopped";
	return state !== "working";
}

/** The job is in a state watches fire on: tell each watcher once, and forget the watch. */
async function fireWatches(job: JobRow | { id: string; name: string; state: "removed" }): Promise<void> {
	const due = watches.filter((w) => w.id === job.id && watchFires(w.when, job.state));
	if (due.length === 0) return;
	watches = watches.filter((w) => !due.includes(w));
	saveWatches();
	for (const w of due) await fireWatch(w, job);
}

async function fireWatch(w: Watch, job: JobRow | { id: string; name: string; state: "removed" }): Promise<void> {
	const removed = job.state === "removed";
	const row = removed ? undefined : (job as JobRow);
	const when: Watch["when"] = removed || row?.state === "failed" || row?.state === "stopped" ? "ended" : "idle";
	const body = noticeBody({
		when,
		state: job.state,
		waitingFor: row?.waitingFor ?? null,
		question: row?.question ?? null,
		summary: row?.summary ?? null,
		error: removed ? null : (row?.error ?? null),
	});
	// what the watched session is to the watcher
	const key = recs.get(job.id)?.sessionFile || `job:${job.id}`;
	const relation = relationOf(treeNode(w.watcher), treeNode(key));
	const text = envelope({ from: job.name, id: job.id, relation, kind: "notice", body });
	try {
		const r = await deliverAgent(w.watcher, "notice", text, { from: job.name, relation });
		log("info", "watch fired", { id: job.id, watcher: w.watcher, when: w.when, outcome: r.outcome });
		// a watcher that is gone (a closed pi, a stopped job) is not told: the notice is lost, as a message would be
		if (reached(r.outcome)) record({ kind: "notice", id: job.id, name: job.name, who: w.watcherName, whoId: w.watcherId ?? null, text: when === "ended" ? "ended" : "is idle" });
	} catch (err) {
		log("warn", "watch notice failed", { id: job.id, watcher: w.watcher, error: String(err) });
	}
}

/** M43: the `watch` op: a peer asks to be told once when a session is next idle, or has ended. */
async function addWatch(conn: Conn, args: { id?: unknown; when?: unknown } | undefined): Promise<{ id: string; name: string; when: Watch["when"]; fired: boolean }> {
	const peer = requirePeer(conn);
	const to = typeof args?.id === "string" ? args.id.trim() : "";
	const when = args?.when;
	if (!to) throw new OpError("bad_request", "id required");
	if (when !== "idle" && when !== "ended") throw new OpError("bad_request", "when must be idle or ended");
	const me = sessionKeyOf(peer);
	const target = findTarget(peer, to);
	if (target.key === me) throw new OpError("bad_request", "a session cannot watch itself");
	if (target.role !== "job") throw new OpError("unsupported", "a foreground session is not watched (it has no job state)");
	const row = rowOf(target.id);
	if (!row) throw new OpError("not_found", `no such job: ${target.id}`);
	const w: Watch = { watcher: me, watcherName: peerName(peer), watcherId: peer.kind === "job" ? peer.id : null, id: row.id, when, at: Date.now() };
	// already so: said at once, nothing kept
	if (watchFires(when, row.state)) {
		await fireWatch(w, row);
		return { id: row.id, name: row.name, when, fired: true };
	}
	const mine = watches.filter((x) => x.watcher === me);
	const same = mine.find((x) => x.id === row.id && x.when === when);
	if (same) watches = watches.filter((x) => x !== same);
	else if (mine.length >= MAX_WATCHES) throw new OpError("full", `at most ${MAX_WATCHES} watches at a time`);
	watches.push(w);
	saveWatches();
	log("info", "watch", { id: row.id, watcher: me, when });
	return { id: row.id, name: row.name, when, fired: false };
}

function persistRoster(): void {
	const obj: Record<string, HostRef> = {};
	for (const [id, ref] of roster) obj[id] = { hostPid: ref.hostPid, hostToken: ref.hostToken };
	try {
		writeJsonAtomic(rosterPath(), obj);
	} catch (err) {
		log("error", "roster write failed", { error: String(err) });
	}
}

function hostGone(ref: HostRef): boolean {
	if (!isAlive(ref.hostPid)) return true;
	if (!ref.hostToken) return false;
	// M35: a ps per job on every check blocked the daemon (50 jobs: 50 ps in a row); a
	// live pid is its host unless a recheck says otherwise (pid reuse is a rare, slow event)
	const now = Date.now();
	if (ref.verifiedAt !== undefined && now - ref.verifiedAt < HOST_VERIFY_MS) return false;
	const same = sameProcess(ref.hostPid, ref.hostToken);
	if (same) ref.verifiedAt = now;
	return !same;
}

// the worker pid each live row was last pushed with: a command that prints nothing, or a
// pi whose first report is late, still has to show (and attach) once its host is up
const shellPids = new Map<string, number | null>();

function rowOf(id: string): JobRow | undefined {
	const rec = recs.get(id);
	const st = readState(id);
	if (!rec || !st) return undefined;
	const live = roster.has(id);
	// M22: shown as the job that took the session (while that one is there)
	if (!live && hidden(st)) return undefined;
	const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
	return {
		id,
		cwd: rec.cwd,
		kind: rec.kind ?? "pi",
		startedAt: st.startedAt,
		state: st.state,
		pid: live ? (readWorkerPid(id) ?? null) : null,
		// status and waitingFor describe a live worker only (PRD §6.8)
		status: live ? ((st.status as JobRow["status"]) ?? null) : null,
		waitingFor: live ? ((st.waitingFor as JobRow["waitingFor"]) ?? null) : null,
		sessionFile: rec.sessionFile,
		name: text(st.displayName) ?? rec.name,
		endedAt: st.endedAt ?? null,
		summary: text(st.summary),
		question: text(st.question),
		choices: Array.isArray(st.choices) ? st.choices.filter((c): c is string => typeof c === "string") : [],
		model: text(st.model) ?? rec.model ?? null,
		thinking: text(st.thinking) ?? rec.thinking ?? null,
		context: rec.kind === "shell" && !isProtocolJob(rec) ? null : contextFrom(st.context),
		usage: rec.kind === "shell" && !isProtocolJob(rec) ? null : usageFrom(st.usage),
		error: text(st.error),
		stateSince: typeof st.stateSince === "number" ? st.stateSince : (st.endedAt ?? st.startedAt),
		reaped: !live && st.reaped === true,
		pinned: st.pinned === true,
		order: typeof st.order === "number" ? st.order : null,
		orderKey: typeof st.orderKey === "string" ? st.orderKey : null,
		parentSession: rec.parentSession ?? null,
		rootSession: rec.rootSession ?? null,
		parentOpen: rec.parentSession ? parentOpen(rec.parentSession) : false,
		agent: rec.agent ?? null,
		worktree: rec.worktree ? { path: rec.worktree.path, branch: rec.worktree.branch, base: rec.worktree.base } : null,
		fanout: rec.fanout ?? null,
		profile: rec.profile ?? (rec.kind === "shell" ? "shell" : "pi"),
		schedule: rec.schedule ?? null,
		...(agentCaps(st) ? { capabilities: agentCaps(st) } : {}),
		...(rec.role ? { role: rec.role } : {}),
		// M45: the concierge's suggested answer, while it waits for one
		...(id in concierge.suggestions ? { suggested: suggestedFor(id, st) } : {}),
		...(Array.isArray(st.prs) && st.prs.length > 0 ? { prs: st.prs as PrInfo[] } : {}),
	};
}

/** M31: the capabilities a job's agent said it has, from state.json. */
function agentCaps(st: JobState): string[] | undefined {
	const c = (st.agentInfo as { capabilities?: unknown } | undefined)?.capabilities;
	return Array.isArray(c) ? c.filter(str) : undefined;
}

const MAX_PR_LINKS = 20;

function mergeLinks(had: unknown, add: unknown[]): string[] {
	const out = new Set(Array.isArray(had) ? had.filter((u): u is string => typeof u === "string" && isPrUrl(u)) : []);
	for (const u of add) if (typeof u === "string" && isPrUrl(u) && out.size < MAX_PR_LINKS) out.add(u);
	return [...out];
}

// ---- M16: pull request status (Claude Code's #N label and "Ready for review") ----

const PR_POLL_MS = Number(process.env.PI_ROOST_PR_POLL_MS) || 60_000;
const PR_ACTIVE_MS = 7 * 24 * 60 * 60 * 1000;
const PR_FIELDS = "number,url,state,isDraft,reviewDecision,statusCheckRollup,title";
let lastPrPoll = 0;
let prPolling = false;
let ghMissingUntil = 0;
const GH = () => process.env.PI_ROOST_GH || "gh";

function gh(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((done) => {
		execFile(GH(), args, { cwd: existsSync(cwd) ? cwd : homedir(), timeout: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, out) => {
			if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
				if (ghMissingUntil < Date.now()) log("info", "gh not found: no pull request status");
				ghMissingUntil = Date.now() + 10 * 60_000;
			}
			done(err ? undefined : String(out));
		});
	});
}

const PR_LIST_MS = 10 * 60_000;
const PR_POLL_BUDGET_MS = 60_000;
let prCursor = 0;

/**
 * Look up linked pull requests (and a worktree branch's), store how they stand, push
 * changed rows. One gh call at a time, at most a minute a round; the next round starts
 * where this one stopped. State is read again after every await.
 */
async function pollPrs(): Promise<void> {
	const start = Date.now();
	if (prPolling || start - lastPrPoll < PR_POLL_MS || start < ghMissingUntil) return;
	prPolling = true;
	lastPrPoll = start;
	try {
		const ids = [...recs.keys()];
		for (let n = 0; n < ids.length; n++) {
			if (Date.now() - start > PR_POLL_BUDGET_MS || Date.now() < ghMissingUntil) break;
			const id = ids[(prCursor + n) % ids.length]!;
			prCursor = (prCursor + n + 1) % Math.max(1, ids.length);
			await pollJobPrs(id);
		}
	} finally {
		prPolling = false;
	}
}

async function pollJobPrs(id: string): Promise<void> {
	const rec = recs.get(id);
	const st = readState(id);
	if (!rec || !st || rec.kind === "shell") return;
	const now = Date.now();
	const active = Math.max(st.startedAt, typeof st.stateSince === "number" ? st.stateSince : 0, st.endedAt ?? 0);
	if (now - active > PR_ACTIVE_MS && !roster.has(id)) return;
	// a worktree's branch is the session's own: its pull request is the session's
	if (rec.worktree && mergeLinks(st.prLinks, []).length === 0 && now - (Number(st.prListAt) || 0) > PR_LIST_MS) {
		const out = await gh(rec.worktree.repo, ["pr", "list", `--head=${rec.worktree.branch}`, "--state", "all", "--limit", "5", "--json", "url", "--jq", ".[].url"]);
		const fresh = readState(id);
		if (!recs.has(id) || !fresh) return;
		updateState(id, { prListAt: Date.now(), ...(out ? { prLinks: mergeLinks(fresh.prLinks, prUrlsIn(out)) } : {}) });
	}
	const links = mergeLinks(readState(id)?.prLinks, []);
	if (links.length === 0) return;
	const before = Array.isArray(st.prs) ? (st.prs as PrInfo[]) : [];
	const next: PrInfo[] = [];
	const checked: Record<string, number> = st.prChecked && typeof st.prChecked === "object" ? { ...(st.prChecked as Record<string, number>) } : {};
	for (const url of links) {
		const known = before.find((p) => p.url === url);
		// merged and closed ones do not change back often: once an hour
		if (known && (known.status === "merged" || known.status === "closed") && now - (checked[url] ?? 0) < 60 * 60_000) {
			next.push(known);
			continue;
		}
		const out = await gh(rec.cwd, ["pr", "view", url, "--json", PR_FIELDS]);
		checked[url] = Date.now();
		let info: PrInfo | undefined;
		try {
			info = out ? prFromGh(JSON.parse(out) as GhPr) : undefined;
		} catch {}
		const kept = info ?? known;
		if (kept) next.push(kept);
	}
	if (!recs.has(id)) return;
	const changed = JSON.stringify(next) !== JSON.stringify(before);
	// only its own fields: the worker's reports may have come in meanwhile
	updateState(id, { prs: next, prChecked: checked });
	if (changed) pushJob(id);
}

/** M10: a child's report ends with where its work is. */
async function withWorktreeLine(id: string, body: string): Promise<string> {
	const w = recs.get(id)?.worktree;
	if (!w) return body;
	try {
		return `${body}\n\n${worktreeLine(w, await worktreeStatus(w))}`;
	} catch {
		return body;
	}
}

function send(conn: Conn, value: unknown): void {
	if (!conn.sock.destroyed) conn.sock.write(encodeLine(value));
}

function push(event: Event): void {
	let n = 0;
	for (const c of conns) {
		if (!c.subscribed) continue;
		send(c, event);
		n++;
	}
	if (n > 0) metric.events.add(n, { event: event.event });
}

function pushJob(id: string): void {
	const job = rowOf(id);
	if (!job) return;
	push({ event: "job", job });
	noteState(job);
}

/** rm: stop the job, drop its records, then its worktree when that holds no work (M10). */
async function removeRecord(id: string): Promise<{ id: string; worktree?: CleanupResult }> {
	// M38: a run waiting for its restart ends here; its parent hears of it as of any removal
	if (cancelResume(id) && !roster.has(id)) reportEnded(id, "removed by the user", true);
	// a live child's end is reported by finalize, as a removal
	if (roster.has(id)) removing.add(id);
	if (roster.has(id)) {
		await terminateHost(id);
		if (!(await waitGone([id], WAIT_MS))) {
			const ref = roster.get(id);
			log("warn", "host did not stop, killing", { id });
			const st = readState(id);
			for (const pid of [readWorkerPid(id), ref?.hostPid]) {
				if (typeof pid !== "number") continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			await waitGone([id], 2000);
			if (roster.has(id)) {
				// not gone even after SIGKILL: it may still be writing there, leave the worktree alone
				if (recs.get(id)?.worktree) workerAlive.add(id);
				finalize(id, "killed by rm");
			}
		}
	}
	const w = workerAlive.delete(id) ? undefined : recs.get(id)?.worktree;
	const file = recs.get(id)?.sessionFile;
	const name = rowOf(id)?.name ?? recs.get(id)?.name ?? id;
	// M43: before the record goes (a watcher is told, then the record and the row are gone)
	await fireWatches({ id, name, state: "removed" });
	record({ kind: "removed", id, name });
	lastSeen.delete(id);
	recs.delete(id);
	// M43: its own watches go with it when nothing holds its session any more
	if (file && !holderOf(file) && watches.some((w) => w.watcher === file)) {
		watches = watches.filter((w) => w.watcher !== file);
		saveWatches();
	}
	// M44: the concierge removed is the concierge off; M45: a suggestion for a removed row goes with it
	if (isConcierge(id)) {
		concierge = { ...concierge, id: null, on: false };
		saveConcierge();
		pushConcierge();
	} else dropSuggestion(id);
	replyAt.delete(id);
	shellPids.delete(id);
	stopping.delete(id);
	removing.delete(id);
	removeJob(id);
	log("info", "rm", { id });
	push({ event: "removed", id });
	pushChildrenOf(file); // M13: its children have no parent row now
	if (!w) return { id };
	// M10: remove what holds no work; never fail rm over it
	let worktree: CleanupResult;
	try {
		const inUse =
			[...recs.values()].some((r) => isInside(r.cwd, w.path)) || [...fgPeers.values()].some((c) => c.peer?.kind === "fg" && isInside(c.peer.cwd, w.path));
		worktree = await cleanupWorktree(w, inUse);
	} catch (err) {
		worktree = { path: w.path, branch: w.branch, removed: false, branchKept: true, reason: String(err) };
	}
	log("info", "rm worktree", { id, ...worktree });
	return { id, worktree };
}

const DAY_MS = 24 * 60 * 60 * 1000;
let lastCleanup = 0;

/*
 * M15 (Claude Code's cleanupPeriodDays): remove records of sessions that ended more than
 * cleanupDays ago. The session files stay (pi's /resume lists them). Kept: pinned ones,
 * ones waiting for an answer, with replies or reports waiting, parents of live children,
 * and ones whose worktree holds uncommitted work or unmerged commits (rm would leave
 * them with no record pointing at them).
 */
let cleaning = false;

/** Whether a record may go now (asked again after every await: anything may have changed). */
function cleanable(id: string, days: number, now: number): boolean {
	const rec = recs.get(id);
	// M30: an ended level 0 agent is cleaned up as a pi job is (a command's row expires by itself)
	if (!rec || (rec.kind === "shell" && !isProfileJob(rec)) || roster.has(id) || starting.has(id) || respawning.has(id) || stopping.has(id) || removing.has(id)) return false;
	const st = readState(id);
	if (!st || typeof st.endedAt !== "number" || now - st.endedAt < days * DAY_MS) return false;
	if (st.pinned === true || st.state === "blocked" || pendingReplies(id).length > 0 || heldReports(id).length > 0) return false;
	return !rec.sessionFile || ![...recs.values()].some((r) => r.parentSession === rec.sessionFile && roster.has(r.id));
}

async function cleanupOld(): Promise<void> {
	const days = Number(process.env.PI_ROOST_CLEANUP_DAYS ?? loadUserConfig().cleanupDays);
	if (!(days > 0) || cleaning) return;
	const now = Date.now();
	if (now - lastCleanup < (Number(process.env.PI_ROOST_CLEANUP_CHECK_MS) || 60 * 60 * 1000)) return;
	cleaning = true;
	lastCleanup = now;
	try {
		for (const id of [...recs.keys()]) {
			if (!cleanable(id, days, Date.now())) continue;
			const w = recs.get(id)?.worktree;
			if (w) {
				const ws = await worktreeStatus(w).catch(() => undefined);
				// uncommitted work, or commits only on its branch: the record says where they are
				if (!ws || (ws.exists && (ws.dirty || ws.ignored)) || (ws.ahead ?? 1) > 0) continue;
				if (!cleanable(id, days, Date.now())) continue;
			}
			const st = readState(id);
			log("info", "cleanup", { id, endedDaysAgo: Math.floor((Date.now() - Number(st?.endedAt)) / DAY_MS) });
			await removeRecord(id)
				.then(() => metric.cleaned.add(1))
				.catch((err: unknown) => log("warn", "cleanup failed", { id, error: String(err) }));
		}
	} finally {
		cleaning = false;
	}
}

/**
 * M13: a running pi holds the session (a foreground pi, or a live job): its subagent panel
 * shows the children and their reports reach it. A parent job that ended or was reaped
 * does not count, so a child that waits for an answer is listed in the agent view.
 */
function parentOpen(key: string): boolean {
	for (const c of fgPeers.values()) if (c.peer?.kind === "fg" && (c.peer.session ?? `peer:${c.peer.id}`) === key && !c.sock.destroyed) return true;
	for (const r of recs.values()) if (r.kind !== "shell" && r.sessionFile === key && roster.has(r.id)) return true;
	return false;
}

/** M13: the children of `key` changed whether they show in the agent view. */
function pushChildrenOf(key: string | undefined): void {
	if (!key) return;
	for (const r of recs.values()) if (r.parentSession === key) pushJob(r.id);
}

function finalize(id: string, why: string, opts: { startup?: boolean } = {}): void {
	roster.delete(id);
	clearTimeout(closeTimers.get(id));
	closeTimers.delete(id);
	pushChildrenOf(recs.get(id)?.sessionFile); // M13: its children's parent is gone
	// M13: a parent that waited for this child to end may close now
	const parentKey = recs.get(id)?.parentSession;
	if (parentKey) for (const r of recs.values()) if (r.sessionFile === parentKey && roster.has(r.id)) scheduleAutoClose(r.id);
	workerConns.delete(id);
	starting.delete(id);
	const st = readState(id);
	if (!st) {
		reaping.delete(id);
		persistRoster();
		return;
	}
	const ex = readExit(id);
	const reaped = reaping.has(id);
	reaping.delete(id);
	const stopReq = !reaped && (stopping.has(id) || st.stopRequested === true);
	const now = Date.now();
	const patch: Partial<JobState> = { endedAt: now, status: null, waitingFor: null, tool: null };
	patch.stateSince = now;
	let restart = false;
	// M38: why it restarts, for telemetry (a fixed set)
	let resumeWhy: "crash" | "host-gone" | "interrupted" = "crash";
	// M9: the daemon, not the worker, decided how this run ended
	let daemonEnded = false;
	if (recs.get(id)?.kind === "shell") {
		// DI-6: stopped, or the command's exit status; the row goes away a while later
		if (stopReq) patch.state = "stopped";
		else if (reaped && isProfileJob(recs.get(id))) {
			// M40: a scheduled run's agent closed once done: the row stays as it was
			patch.state = st.state === "working" ? "done" : st.state;
			patch.reaped = true;
			patch.stateSince = typeof st.stateSince === "number" ? st.stateSince : now;
		} else if (isProtocolJob(recs.get(id)) && ex?.code === 0 && st.state === "failed" && typeof st.reportedAt === "number") {
			// M31: an agent that said it failed and then exited cleanly failed
			patch.state = "failed";
		} else {
			patch.state = ex && !crashed(ex) ? "done" : "failed";
			if (patch.state === "failed") patch.error = ex ? exitText(ex, "exited") : "host vanished";
		}
		// M30: a level 0 agent's row stays, as an agent's does; a command's goes a while later
		const rec = recs.get(id);
		if (!isProfileJob(rec)) patch.removeAt = now + SHELL_KEEP_MS;
		else {
			patch.waitingFor = null;
			patch.question = null;
			patch.typeTask = null;
			// M40: an agent cut short mid-work carries on by itself, as a pi session does (M38):
			// a protocol agent takes "continue" as a reply; a terminal agent needs `resume`
			const progress = typeof st.reportedAt === "number" ? st.reportedAt : st.updatedAt;
			if (!stopReq && !ex && opts.startup) {
				// the machine or the service went away under it: what it was stands (a dialog
				// died with the process; a question stays, a reply starts it again)
				if (st.state !== "working") {
					const dialog = st.state === "blocked" && st.waitingFor !== "question";
					patch.state = dialog ? "done" : st.state;
					patch.error = null;
					if (st.state === "blocked" && !dialog) {
						patch.waitingFor = st.waitingFor;
						patch.question = st.question;
					}
				} else if (now - progress < RECENT_MS) patch.error = "it ended while it was working (machine restart?); reply or press Enter twice to resume";
				else {
					patch.state = "stopped";
					patch.error = "ended while the background service was off";
				}
			}
			if (patch.state === "failed" && st.state === "working" && !stopReq && (isProtocolJob(rec) || rec?.resumable === true)) {
				const mode = autoResume();
				if (ex ? crashed(ex) && mode !== "off" : mode === "interrupted" && (!opts.startup || now - progress < RESUME_WINDOW_MS)) {
					restart = true;
					resumeWhy = ex ? "crash" : opts.startup ? "interrupted" : "host-gone";
				}
			}
			// a reply waiting to be typed in never reached it: say so, not lose it quietly
			if (str(st.typeTask)) {
				const t = st.typeTask.length > 60 ? `${st.typeTask.slice(0, 59)}…` : st.typeTask;
				patch.error = `${patch.error ?? "it ended"} before this was typed in: ${t}`;
				if (patch.state === "done") patch.state = "failed";
			}
		}
		// the host flushed its screen on exit: the last output line is the result; a row
		// kept as it was (closed once done, or restored after the service was down) keeps its text
		const kept = reaped || (!ex && opts.startup === true && st.state !== "working");
		const line = isProfileJob(rec) ? (readTermSignals(termPath(id))?.title ?? lastScreenLine(id)) : lastScreenLine(id);
		// M31: a protocol agent's row keeps what it last said
		if (line && !kept && !(isProtocolJob(rec) && typeof st.reportedAt === "number")) patch.summary = line;
	} else if (reaped) {
		// DM-4: an idle worker stopped to save resources; the row stays as it was
		patch.state = st.state === "working" ? "done" : st.state;
		patch.reaped = true;
		patch.stateSince = typeof st.stateSince === "number" ? st.stateSince : now;
	} else if (stopReq) {
		patch.state = "stopped";
		daemonEnded = true;
	} else if (!ex && opts.startup) {
		// DM-7: the machine or the background service went away under a live worker
		if (st.state !== "working") patch.state = st.state === "blocked" && st.waitingFor !== "question" ? "done" : st.state;
		else {
			const progress = typeof st.reportedAt === "number" ? st.reportedAt : st.updatedAt;
			if (now - progress < RECENT_MS) {
				patch.state = "failed";
				patch.error = "the session ended while it was working (machine restart?); reply or press Enter twice to resume";
				// M38: a recent one carries on by itself
				if (autoResume() === "interrupted" && now - progress < RESUME_WINDOW_MS) {
					restart = true;
					resumeWhy = "interrupted";
				}
			} else {
				patch.state = "stopped";
				patch.error = "ended while the background service was off";
			}
		}
	} else if (!ex) {
		patch.state = "failed";
		patch.error = "host vanished";
		daemonEnded = true;
		// M38: a host gone under a working run (killed, out of memory) is a crash, not an end
		if (st.state === "working" && autoResume() === "interrupted") {
			restart = true;
			resumeWhy = "host-gone";
		}
	} else if (crashed(ex)) {
		// DM-5, M38: a worker that crashed mid-run restarts, a few times in a row at most
		restart = st.state === "working" && autoResume() !== "off";
		daemonEnded = !restart;
		patch.state = "failed";
		if (!st.error) patch.error = exitText(ex, "worker exited");
	} else if (st.state === "failed" || (st.state === "blocked" && st.waitingFor === "question")) {
		// The worker's last word stands for a failed turn or an open question (answered
		// by restarting the session); a dialog or a missing first prompt dies with it.
		patch.state = st.state;
	} else patch.state = "done";
	// M38: the restart budget: a run that keeps crashing stops being restarted
	let resumeIn: number | undefined;
	if (restart) {
		const n = typeof st.crashRestarts === "number" ? st.crashRestarts : 0;
		const why = patch.error ?? st.error ?? "it ended";
		if (n < RESUME_DELAYS_MS.length && !shuttingDown) {
			resumeIn = RESUME_DELAYS_MS[n]!;
			// still the user's run: working, not a failure to be told about
			patch.state = "working";
			patch.resumeAt = now + resumeIn;
			patch.error = `${why}; continuing in ${Math.ceil(resumeIn / 1000)} s (automatic restart ${n + 1} of ${RESUME_DELAYS_MS.length})`;
			daemonEnded = false;
		} else {
			restart = false;
			daemonEnded = true;
			if (n >= RESUME_DELAYS_MS.length) patch.error = `${why}; not restarted again after ${n} automatic restarts in a row (reply to continue)`;
		}
	}
	try {
		updateState(id, patch);
	} catch (err) {
		log("error", "finalize failed", { id, error: String(err) });
	}
	stopping.delete(id);
	persistRoster();
	log("info", "finalize", { id, why, state: patch.state, exit: ex ?? null, restart });
	pushJob(id);
	if (reaped && pendingReplies(id).length > 0 && !shuttingDown) {
		// a reply arrived while the idle worker was going away: start it again for it
		void respawn(id).catch((err: unknown) => log("error", "wake after reap failed", { id, error: String(err) }));
	}
	if (resumeIn !== undefined) scheduleResume(id, resumeIn, resumeWhy);
	if (daemonEnded && !shuttingDown && recs.get(id)?.parentSession) {
		const why = removing.has(id) ? "removed by the user" : patch.state === "stopped" ? "stopped" : `failed: ${patch.error ?? st.error ?? "unknown"}`;
		// a removal cleans the worktree up at the same time: its state would be stale
		const body = reportBody({ state: "ended", error: why });
		void (removing.has(id) ? Promise.resolve(body) : withWorktreeLine(id, body)).then((b) => routeReport(id, b));
	}
}

// ---- M38: automatic restarts -------------------------------------------------------

const autoResume = () => loadUserConfig().autoResume;
const resumeTimers = new Map<string, NodeJS.Timeout>();

/** Start the run again after `ms`, unless the user stopped, removed or restarted it meanwhile. */
function scheduleResume(id: string, ms: number, why: "crash" | "host-gone" | "interrupted" | "pending"): void {
	clearTimeout(resumeTimers.get(id));
	telemetry.counter("roost.auto_resume").add(1, { why });
	log("info", "resume scheduled", { id, ms, why });
	record({ kind: "resume", id, name: rowOf(id)?.name ?? id, why, text: clipText(rowOf(id)?.error) });
	const t = setTimeout(() => {
		resumeTimers.delete(id);
		if (shuttingDown || roster.has(id) || !recs.has(id) || typeof readState(id)?.resumeAt !== "number") return;
		void respawn(id, { prompt: CONTINUE, crash: true }).catch((err: unknown) => {
			log("error", "automatic restart failed", { id, error: String(err) });
			// it cannot run (a locked session, its directory gone): say why, stop trying
			if (!roster.has(id) && recs.has(id)) endWaiting(id, "failed", `could not restart it: ${(err as Error).message}`);
		});
	}, ms);
	t.unref?.();
	resumeTimers.set(id, t);
}

/** A waiting automatic restart is called off (stop, rm, a restart by other means). Whether one was. */
function cancelResume(id: string): boolean {
	const t = resumeTimers.get(id);
	if (t) clearTimeout(t);
	resumeTimers.delete(id);
	return typeof readState(id)?.resumeAt === "number";
}

/** The ended job's parent hears of it (M9), as finalize tells it. */
function reportEnded(id: string, why: string, removed = false): void {
	if (shuttingDown || !recs.get(id)?.parentSession) return;
	const body = reportBody({ state: "ended", error: why });
	// a removal: the record goes next (routeReport reads it at once), the worktree with it
	if (removed) void routeReport(id, body);
	else void withWorktreeLine(id, body).then((b) => routeReport(id, b));
}

/** A run waiting for its automatic restart ends here (stopped, or its restart failed). */
function endWaiting(id: string, state: "stopped" | "failed", error: string | null): void {
	cancelResume(id);
	const now = Date.now();
	try {
		updateState(id, { state, resumeAt: undefined, error, stateSince: now, endedAt: readState(id)?.endedAt ?? now });
	} catch (err) {
		log("error", "end of a waiting run failed", { id, error: String(err) });
	}
	pushJob(id);
	reportEnded(id, state === "stopped" ? "stopped" : `failed: ${error ?? "unknown"}`);
}

/**
 * M38: an exit that was not the program's own: a non-zero code, or a signal. node-pty
 * gives a process killed by a signal (SIGKILL: the out-of-memory killer, a kill -9) code
 * 0 and the signal's number, which read as a clean end before.
 */
function crashed(ex: { code: number | null; signal: string | null }): boolean {
	return ex.code !== 0 || (!!ex.signal && ex.signal !== "0");
}

function exitText(ex: { code: number | null; signal: string | null }, what: string): string {
	if (ex.signal && ex.signal !== "0") {
		const n = Number(ex.signal);
		const name = Number.isInteger(n) ? Object.entries(osConstants.signals).find(([, v]) => v === n)?.[0] : ex.signal;
		return `${what === "exited" ? "killed" : "worker killed"} by ${name ?? `signal ${ex.signal}`}`;
	}
	return `${what} with code ${ex.code}`;
}

// ---- M39: scheduled tasks ----------------------------------------------------------

/** The scheduler's own state; the daemon is its one writer. */
const schedulesPath = () => join(roostHome(), "schedules.json");
const schedules = new Map<string, Schedule>();
const SCHEDULE_TICK_MS = Number(process.env.PI_ROOST_SCHEDULE_TICK_MS) || 15_000;
/** Schedules whose run is being started (two requests at once start one). */
const startingRuns = new Set<string>();

function loadSchedules(): void {
	const saved = readJson<Schedule[]>(schedulesPath());
	if (!Array.isArray(saved)) return;
	for (const s of saved) {
		try {
			if (!s || !SCHEDULE_NAME.test(s.name)) continue;
			const when = parseWhen(s.when);
			checkTemplate(s.launch);
			// a file edited by hand: what is missing or not a number is made good
			const now = Date.now();
			if (!Number.isFinite(s.createdAt)) s.createdAt = now;
			if (!Number.isFinite(s.anchor)) s.anchor = s.createdAt;
			s.paused = s.paused === true;
			s.catchUp = s.catchUp !== false;
			if (s.paused) s.nextAt = null;
			else if (!Number.isFinite(s.nextAt)) s.nextAt = nextRun(when, now, s.anchor);
			schedules.set(s.name, s);
		} catch (err) {
			log("warn", "schedule dropped", { name: s?.name, error: String(err) });
		}
	}
}

function saveSchedules(): void {
	try {
		writeJsonAtomic(schedulesPath(), [...schedules.values()]);
	} catch (err) {
		log("error", "schedules not saved", { error: String(err) });
	}
}

function scheduleRow(s: Schedule): ScheduleRow {
	return {
		name: s.name,
		when: s.when,
		task: s.task ?? null,
		agent: templateAgent(s.launch),
		cwd: s.launch.cwd,
		model: s.launch.model ?? null,
		paused: s.paused,
		catchUp: s.catchUp,
		nextAt: s.nextAt,
		lastRunAt: s.lastRunAt ?? null,
		lastJob: s.lastJob ?? null,
		lastSkip: s.lastSkip ?? null,
	};
}

function scheduleOf(name: unknown): Schedule {
	const s = typeof name === "string" ? schedules.get(name) : undefined;
	if (!s) throw new OpError("not_found", `no schedule named ${String(name)}`);
	return s;
}

/**
 * Whether a schedule's previous run is still working (or starting, or about to restart).
 * A finished one may still have its worker up, idle until it is closed: that is not going.
 */
function stillRunning(id: string | undefined): boolean {
	if (!id || !recs.has(id)) return false;
	if (starting.has(id) || respawning.has(id)) return true;
	const st = readState(id);
	return st?.state === "working" && (roster.has(id) || typeof st.resumeAt === "number");
}

/**
 * One run of a schedule: a session like any other, named after it. A due run whose
 * previous one still runs is skipped (said in lastSkip), never stacked.
 */
async function runSchedule(s: Schedule, now: number, why: "due" | "catch-up" | "now"): Promise<string> {
	return telemetry.startSpan({ name: "roost.schedule.run", attributes: { schedule: s.name, why } }, async (span) => {
		// the next one first: an await below must not let a tick start this one twice
		// (and never one not ahead: it would run again on the next tick)
		if (why !== "now") {
			const next = nextRun(parseWhen(s.when), now, s.anchor);
			s.nextAt = next === null ? null : Math.max(next, now + 1000);
		}
		if (startingRuns.has(s.name)) throw new OpError("busy", "a run of it is starting");
		if (stillRunning(s.lastJob)) {
			s.lastSkip = { at: now, why: `the previous run (${s.lastJob}) is still going` };
			saveSchedules();
			span.setAttributes({ skipped: true });
			throw new OpError("busy", s.lastSkip.why);
		}
		startingRuns.add(s.name);
		try {
			const r = await dispatch({ ...runLaunch(s.launch, runSlot(now)), name: s.name, requestId: undefined }, { schedule: s.name });
			s.lastRunAt = now;
			s.lastJob = r.id;
			s.lastSkip = undefined;
			log("info", "schedule ran", { schedule: s.name, id: r.id, why });
			record({ kind: "schedule", id: r.id, name: r.name, who: s.name, why });
			return r.id;
		} catch (err) {
			s.lastSkip = { at: now, why: (err as Error).message };
			log("warn", "schedule run failed", { schedule: s.name, error: String(err) });
			throw err;
		} finally {
			startingRuns.delete(s.name);
			saveSchedules();
		}
	});
}

function scheduleTick(now = Date.now()): void {
	if (shuttingDown) return;
	for (const s of schedules.values()) {
		if (s.paused || s.nextAt === null || now < s.nextAt) continue;
		void runSchedule(s, now, "due").catch(() => {});
	}
}

/** At start: runs that fell due while the service was off: one now (catchUp), or the next. */
function catchUpSchedules(now = Date.now()): void {
	for (const s of schedules.values()) {
		if (s.paused || s.nextAt === null || s.nextAt > now) continue;
		if (s.catchUp) void runSchedule(s, now, "catch-up").catch(() => {});
		else {
			s.nextAt = nextRun(parseWhen(s.when), now, s.anchor);
			saveSchedules();
		}
	}
}

function scheduleOp(op: string, args: any): unknown {
	const now = Date.now();
	switch (op) {
		case "schedules":
			return { schedules: [...schedules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(scheduleRow) };
		case "schedule-add": {
			const name = args?.name;
			if (typeof name !== "string" || !SCHEDULE_NAME.test(name)) throw new OpError("bad_request", "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit");
			if (schedules.has(name)) throw new OpError("exists", `a schedule named ${name} exists (remove it first)`);
			if (schedules.size >= 100) throw new OpError("limit", "100 schedules at most");
			let when: ReturnType<typeof parseWhen>;
			try {
				when = parseWhen(String(args?.when ?? ""));
				checkTemplate(args?.launch);
			} catch (err) {
				throw new OpError("bad_request", (err as Error).message);
			}
			if (!isDir(args.launch.cwd)) throw new OpError("bad_request", `cwd is not a directory: ${args.launch.cwd}`);
			const s: Schedule = {
				name,
				when: String(args.when).trim(),
				launch: args.launch,
				...(typeof args.task === "string" ? { task: args.task.slice(0, 2000) } : {}),
				paused: false,
				catchUp: args.catchUp !== false,
				createdAt: now,
				anchor: now,
				nextAt: nextRun(when, now, now),
			};
			schedules.set(name, s);
			saveSchedules();
			log("info", "schedule added", { name, when: s.when, nextAt: s.nextAt });
			return scheduleRow(s);
		}
		case "schedule-rm": {
			const s = scheduleOf(args?.name);
			schedules.delete(s.name);
			saveSchedules();
			log("info", "schedule removed", { name: s.name });
			return { name: s.name };
		}
		case "schedule-pause": {
			const s = scheduleOf(args?.name);
			s.paused = args?.paused === true;
			// resumed: counted from now (an "every" does not fire at once for the time it was paused)
			if (!s.paused) s.anchor = now;
			s.nextAt = s.paused ? null : nextRun(parseWhen(s.when), now, s.anchor);
			saveSchedules();
			return scheduleRow(s);
		}
	}
	throw new OpError("bad_request", `unknown op: ${op}`);
}

function checkHosts(): void {
	for (const [id, ref] of [...roster]) {
		if (starting.has(id)) continue;
		if (hostGone(ref)) finalize(id, "host gone");
	}
}

function loadJobs(): void {
	for (const id of listJobIds()) {
		const rec = readJob(id);
		if (rec) recs.set(id, rec);
	}
	// M43: what each job was last in, so what changed while the service was off is an event, and no more
	for (const id of recs.keys()) {
		const st = readState(id);
		if (st && !hidden(st)) lastSeen.set(id, { state: st.state, waitingFor: st.endedAt === undefined ? ((st.waitingFor as JobRow["waitingFor"]) ?? null) : null, question: typeof st.question === "string" && st.question ? st.question : null });
	}
	loadWatches();
	loadConcierge();
	const saved = readJson<Record<string, HostRef>>(rosterPath()) ?? {};
	for (const [id, ref] of Object.entries(saved)) {
		if (!recs.has(id) || typeof ref?.hostPid !== "number") continue;
		if (ref.hostToken && sameProcess(ref.hostPid, ref.hostToken)) {
			roster.set(id, { hostPid: ref.hostPid, hostToken: ref.hostToken });
			log("info", "re-adopted", { id, hostPid: ref.hostPid });
		} else finalize(id, "host gone at startup", { startup: true });
	}
	for (const id of recs.keys()) {
		let st = readState(id);
		// M35: a state file a machine crash left empty or cut (reports are written without
		// fsync): the job is not lost with it; it shows as failed, to be started again
		if (!st) {
			const rec = recs.get(id)!;
			const now = Date.now();
			try {
				writeJsonAtomic(stateFile(id), { state: "failed", startedAt: rec.createdAt, updatedAt: now, endedAt: now, stateSince: now, jobToken: newToken(), error: "its state was lost in a crash; reply or press Enter twice to start it again" });
				st = readState(id);
				log("warn", "state recovered", { id });
			} catch (err) {
				log("error", "state recovery failed", { id, error: String(err) });
			}
		}
		if (st && st.endedAt === undefined && !roster.has(id)) finalize(id, "orphaned", { startup: true });
		// M38: a restart that was waiting when the service went down
		else if (st && typeof st.resumeAt === "number" && !roster.has(id)) {
			if (autoResume() === "off") {
				endWaiting(id, "failed", "the background service stopped before its automatic restart; reply to continue");
			} else scheduleResume(id, Math.max(0, Math.min(st.resumeAt - Date.now(), RESUME_DELAYS_MS.at(-1) ?? 0)), "pending");
		}
	}
	persistRoster();
}

async function terminateHost(id: string): Promise<void> {
	const ref = roster.get(id);
	if (!ref) return;
	reaping.delete(id); // a user's stop wins over an idle reap
	stopping.add(id);
	try {
		updateState(id, { stopRequested: true });
	} catch {}
	try {
		await hostControl(id, "terminate");
	} catch (err) {
		log("warn", "host control failed, sending SIGTERM", { id, error: String(err) });
		try {
			process.kill(ref.hostPid, "SIGTERM");
		} catch {}
	}
}

async function waitGone(ids: string[], ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	for (;;) {
		checkHosts();
		if (ids.every((id) => !roster.has(id))) return true;
		if (Date.now() > end) return false;
		await sleep(50);
	}
}

function spawnHost(rec: JobRecord): number {
	const env = { ...process.env };
	for (const k of Object.keys(env)) if (k.startsWith("PI_JOB_") || k.startsWith("ROOST_JOB_")) delete env[k];
	for (const k of JOB_ENV_NAMES) delete env[k];
	const entry = process.env.PI_ROOST_HOST_ENTRY || hostEntry();
	const child = spawn(process.execPath, [entry, rec.id], { detached: true, stdio: "ignore", cwd: rec.cwd, env });
	child.on("error", (err) => log("error", "host spawn error", { id: rec.id, error: String(err) }));
	child.on("exit", () => setImmediate(checkHosts));
	child.unref();
	if (child.pid === undefined) throw new OpError("spawn_failed", "could not start host process");
	return child.pid;
}

function str(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function realPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** M36: a request id: what a client may send to make a resend safe. */
const requestIdOf = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : undefined);

async function dispatch(a: DispatchArgs, extra: Partial<JobRecord> = {}): Promise<{ id: string; name: string }> {
	if (!a || typeof a !== "object") throw new OpError("bad_request", "missing args");
	// M36: the same request again (its answer was lost): the job it made, not a second one
	const rid = requestIdOf(a.requestId);
	if (a.requestId !== undefined && !rid) throw new OpError("bad_request", "requestId: 1-64 of A-Z a-z 0-9 _ . : -");
	if (rid) for (const r of recs.values()) if (r.requestId === rid) return { id: r.id, name: r.name };
	if (!str(a.cwd) || !isAbsolute(a.cwd) || !isDir(a.cwd)) throw new OpError("bad_request", `cwd is not a directory: ${a.cwd}`);
	if (!Array.isArray(a.command) || a.command.length === 0 || !a.command.every(str)) {
		throw new OpError("bad_request", "command must be a non-empty array of strings");
	}
	const shell = a.kind === "shell";
	// M30: a level 0 agent is a shell job with a profile: its screen says how it is
	const profile = shell && str(a.profile) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(a.profile) ? a.profile : undefined;
	if (a.profile !== undefined && !profile) throw new OpError("bad_request", "profile must be a name, on a shell-kind job");
	const term = profile ? termFrom(a.term ?? {}) : undefined;
	const resumeCommand = profile && Array.isArray(a.resumeCommand) && a.resumeCommand.length > 0 && a.resumeCommand.every(str) ? a.resumeCommand : undefined;
	if (!shell && (!str(a.sessionFile) || !isAbsolute(a.sessionFile))) throw new OpError("bad_request", "sessionFile must be an absolute path");
	const env: Record<string, string> = {};
	if (a.env && typeof a.env === "object") {
		for (const [k, v] of Object.entries(a.env)) if (typeof v === "string") env[k] = v;
	}
	// before the lock and roster checks: nothing may await between them and recs.set
	let worktree: WorktreeInfo | undefined;
	if (a.worktree !== undefined) {
		if (shell && !profile) throw new OpError("bad_request", "shell jobs run without a worktree");
		if (!(await validWorktree(a.worktree))) throw new OpError("bad_request", "worktree is not one pi-roost made");
		const w = a.worktree as WorktreeInfo;
		if (!isInside(realPath(a.cwd), realPath(w.path))) throw new OpError("bad_request", "cwd must be inside the worktree");
		worktree = { path: w.path, branch: w.branch, repo: w.repo, base: w.base };
	}

	if (!shell) {
		const holder = readWriterLock(a.sessionFile);
		if (holder) throw new OpError("locked", `session is in use by pid ${holder.pid}`);
		for (const id of roster.keys()) {
			if (recs.get(id)?.sessionFile === a.sessionFile) {
				throw new OpError("locked", `session is already running as job ${id}`);
			}
		}
	}

	// M36: checked again after the awaits above (a worktree check): the same request on
	// another connection may have made its job meanwhile
	if (rid) for (const r of recs.values()) if (r.requestId === rid) return { id: r.id, name: r.name };
	let id = newJobId();
	while (recs.has(id)) id = newJobId();
	const base = str(a.name) ? a.name : id;
	// M22: a job this one takes the session from gives up its name (one row per session)
	const taken = new Set([...recs.values()].filter((r) => !(!shell && foldsInto(r, a.sessionFile)) && !hiddenJob(r.id)).map((r) => r.name));
	// M44: the concierge's name is its own
	if (extra.role !== "concierge") taken.add(CONCIERGE_NAME);
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;

	const now = Date.now();
	const origin = a.origin === "bg" || a.origin === "adopt" || a.origin === "fork" ? a.origin : "dispatch";
	const rec: JobRecord = {
		id,
		name,
		cwd: a.cwd,
		sessionFile: shell ? "" : a.sessionFile,
		command: a.command,
		...(shell ? { kind: "shell" as const } : {}),
		...(profile ? { profile, term: { ...term!, typeTask: undefined }, ...(resumeCommand ? { resumeCommand } : {}), ...(a.protocol === true ? { agentProtocol: true } : {}), ...(a.resumable === true ? { resumable: true } : {}) } : {}),
		env,
		...(str(a.model) ? { model: a.model } : {}),
		...(str(a.thinking) ? { thinking: a.thinking } : {}),
		...(str(a.agent) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(a.agent) ? { agent: a.agent } : {}),
		...(str(a.fanout) && /^[A-Za-z0-9_-]{1,40}$/.test(a.fanout) ? { fanout: a.fanout } : {}),
		...(a.workspaceEnv === "shell" || a.workspaceEnv === "direnv" ? { workspaceEnv: a.workspaceEnv } : {}),
		...(Array.isArray(a.envDeny) ? { envDeny: a.envDeny.filter((d): d is string => typeof d === "string" && d !== "").slice(0, 256) } : {}),
		...(Array.isArray(a.envForce) ? { envForce: a.envForce.filter((d): d is string => typeof d === "string" && d !== "").slice(0, 256) } : {}),
		origin,
		createdAt: now,
		...(str(a.piVersion) ? { piVersion: a.piVersion } : {}),
		roostVersion: ROOST_VERSION,
		...(worktree ? { worktree } : {}),
		...(rid ? { requestId: rid } : {}),
		...extra,
	};
	createJob(rec, {
		state: "working",
		startedAt: now,
		updatedAt: now,
		jobToken: newToken(),
		...(shell ? { status: "busy" } : {}),
		// M30: a task given in argv counts as typed; one typed in waits for the first quiet
		// M31: a protocol agent gets it as its first reply instead
		...(profile && a.protocol !== true ? { termInputAt: now, termTyped: a.taskInArgv === true, ...(term!.typeTask ? { typeTask: term!.typeTask } : {}) } : {}),
		...(profile && a.protocol === true && term!.typeTask ? { replySeq: 1, pendingReplies: [{ seq: 1, text: term!.typeTask }] } : {}),
	});
	recs.set(id, rec);
	try {
		await startHost(rec);
	} catch (err) {
		recs.delete(id);
		shellPids.delete(id);
		removeJob(id);
		throw err;
	}
	log("info", "dispatch", { id, name, cwd: rec.cwd, origin });
	// M43: the feed starts the job as working; a schedule's run is recorded by the schedule
	lastSeen.set(id, { state: "working", waitingFor: null, question: null });
	if (!extra.schedule) {
		const parent = extra.parentSession ? holderOf(extra.parentSession) : undefined;
		record({ kind: "dispatch", id, name, who: parent ? holderName(parent) : "user", why: origin === "dispatch" ? null : origin, text: clipText(taskOf(a)) });
	}
	if (!shell) supersedeOthers(id);
	if (!shell) pushChildrenOf(rec.sessionFile); // M13: an adopted session's children have a parent row now
	return { id, name };
}

/** M43: the task a dispatch carries, for the feed: the argument after "--", or what a terminal agent is to be given. */
function taskOf(a: DispatchArgs): string | null {
	const i = a.command.indexOf("--");
	if (i >= 0 && str(a.command[i + 1])) return a.command[i + 1]!;
	return str(a.term?.typeTask) ? a.term.typeTask : null;
}

/** M22: a job whose session another job took over (while that one is there). */
function hidden(st: JobState): boolean {
	return str(st.supersededBy) && recs.has(st.supersededBy);
}
function hiddenJob(id: string): boolean {
	if (roster.has(id)) return false;
	const st = readState(id);
	return st ? hidden(st) : false;
}

/** M22: an ended pi job on this session (it gives way to the job that runs it now). */
function foldsInto(r: JobRecord, session: string | undefined): boolean {
	return !!session && r.kind !== "shell" && r.sessionFile === session && !roster.has(r.id);
}

/**
 * M22: one row per session. A job that runs a session again (moved to the background
 * from another pi window, reopened by a new dispatch) takes over the rows of the ended
 * jobs on it: they stop being listed (their records stay), and a pin carries over.
 */
function supersedeOthers(id: string): void {
	const rec = recs.get(id);
	if (!rec || rec.kind === "shell" || !rec.sessionFile) return;
	let pinned = false;
	for (const r of recs.values()) {
		if (r.id === id || !foldsInto(r, rec.sessionFile)) continue;
		const st = readState(r.id);
		if (!st || hidden(st)) continue;
		if (st.pinned === true) pinned = true;
		updateState(r.id, { supersededBy: id });
		push({ event: "removed", id: r.id });
		log("info", "superseded", { id: r.id, by: id });
	}
	if (pinned && readState(id)?.pinned !== true) {
		updateState(id, { pinned: true });
		pushJob(id);
	}
}

/**
 * M22: a pi in another window (herdr, tmux, a second terminal) opened a session whose job
 * ended waiting or failed: the question or the failure is that pi's now, so the row stops
 * asking for input.
 */
function continuedElsewhere(session: string): void {
	for (const r of recs.values()) {
		if (!foldsInto(r, session)) continue;
		const st = readState(r.id);
		if (!st || hidden(st) || (st.state !== "blocked" && st.state !== "failed")) continue;
		updateState(r.id, {
			state: "done",
			waitingFor: null,
			question: null,
			choices: [],
			error: null,
			summary: "continued in another pi window",
			stateSince: Date.now(),
		});
		pushJob(r.id);
		log("info", "continued elsewhere", { id: r.id });
	}
}

async function startHost(rec: JobRecord): Promise<void> {
	const t0 = Date.now();
	let ok = false;
	try {
		await startHostNow(rec);
		ok = true;
	} finally {
		metric.hostStart.record(Date.now() - t0, { kind: rec.kind ?? "pi", ok });
	}
}

async function startHostNow(rec: JobRecord): Promise<void> {
	const id = rec.id;
	starting.add(id);
	let hostPid: number;
	try {
		hostPid = spawnHost(rec);
	} catch (err) {
		starting.delete(id);
		throw err;
	}
	const ref: HostRef = { hostPid, hostToken: "" };
	roster.set(id, ref);
	pushChildrenOf(rec.sessionFile); // M13: its children's parent runs again
	for (let i = 0; i < 25 && !ref.hostToken; i++) {
		ref.hostToken = (await processStartTokenAsync(hostPid)) ?? "";
		if (!ref.hostToken) await sleep(20);
	}
	if (ref.hostToken) ref.verifiedAt = Date.now();
	try {
		updateState(id, { hostPid, hostToken: ref.hostToken });
	} catch {}
	persistRoster();
	starting.delete(id);
	pushJob(id);
	checkHosts();
}

/**
 * AT-1, DM-5, flow 5.7: start an ended job again from its session file. `restart`
 * stops a live one first (respawn --all after an upgrade).
 */
function respawn(id: string, opts: { prompt?: string; crash?: boolean; restart?: boolean } = {}): Promise<{ id: string; started: boolean }> {
	return telemetry.startSpan({ name: "roost.respawn", attributes: { job: id, crash: !!opts.crash, restart: !!opts.restart, prompt: !!opts.prompt } }, async (span) => {
		const r = await respawnNow(id, opts);
		span.setAttributes({ started: r.started });
		return r;
	});
}

async function respawnNow(
	id: string,
	opts: { prompt?: string; crash?: boolean; restart?: boolean } = {},
): Promise<{ id: string; started: boolean }> {
	const rec = recs.get(id);
	if (!rec) throw new OpError("not_found", `no such job: ${id}`);
	if (starting.has(id) || respawning.has(id)) return { id, started: false };
	respawning.add(id);
	try {
		// M38: an automatic restart waiting: this start takes its place (once it can start)
		const pendingResume = typeof readState(id)?.resumeAt === "number";
		const shell = rec.kind === "shell";
		// M30: a level 0 agent takes its prompt typed in, once it is up and quiet
		const typeTask = isTermJob(rec) && opts.prompt ? opts.prompt : undefined;
		let prompt = shell ? undefined : opts.prompt;
		// M38: started by other means (attach, Enter twice) while a restart waited: the run
		// still carries on; a reply waiting goes in instead
		if (!prompt && !shell && pendingResume && pendingReplies(id).length === 0) prompt = CONTINUE;
		if (roster.has(id)) {
			// a running command is never killed to be run again (respawn --all after an upgrade)
			if (!opts.restart || shell) return { id, started: false };
			// a turn cut short by the restart carries on in the new worker
			if (!prompt && readState(id)?.state === "working") prompt = CONTINUE;
			await terminateHost(id);
			if (!(await waitGone([id], WAIT_MS))) throw new OpError("busy", `job ${id} did not stop`);
		}
		if (ptyError) throw new OpError("no_pty", `node-pty is unavailable: ${ptyError}`);
		if (!shell) {
			const holder = readWriterLock(rec.sessionFile);
			if (holder) throw new OpError("locked", `session is in use by pid ${holder.pid}`);
		}
		if (!isDir(rec.cwd)) {
			throw new OpError(
				"bad_request",
				rec.worktree
					? `its worktree is gone: ${rec.worktree.path} (branch ${rec.worktree.branch}; git worktree add ${rec.worktree.path} ${rec.worktree.branch} brings it back)`
					: `cwd is gone: ${rec.cwd}`,
			);
		}
		if (!recs.has(id)) throw new OpError("not_found", `job ${id} was removed`);
		const st = readState(id);
		const written = !shell && existsSync(rec.sessionFile);
		// M8: the model and thinking level it last reported running win over the dispatch's;
		// before any report, the ones it was dispatched with (a hand-off's live values)
		if (isProfileJob(rec)) {
			// the last run's screen and signals would read as the new one's for a moment
			rmSync(termPath(id), { force: true });
			rmSync(screenPath(id), { force: true });
		}
		const command = isProfileJob(rec)
			? (rec.resumeCommand ?? rec.command)
			: respawnCommand(rec, written, prompt, { model: st?.model ?? rec.model, thinking: st?.thinking ?? rec.thinking });
		const now = Date.now();
		// nothing new to do: the worker shows where the session left off, so keep the row as is
		const restore = written && !prompt && pendingReplies(id).length === 0 && st?.state !== "working";
		// M31: a protocol agent takes the prompt as a reply, waiting for its first report
		// (queued only now: a start refused above must not leave it for the next one)
		if (isProtocolJob(rec) && opts.prompt) {
			const seq = (typeof st?.replySeq === "number" ? st.replySeq : 0) + 1;
			updateState(id, { replySeq: seq, pendingReplies: [...pendingReplies(id), { seq, text: opts.prompt }] });
		}
		// M38: it starts now: the waiting restart is spent (a failure above leaves it to run)
		clearTimeout(resumeTimers.get(id));
		resumeTimers.delete(id);
		clearExit(id);
		clearWorker(id);
		updateState(id, {
			...(restore
				? { stateSince: st?.stateSince }
				: { state: "working" as const, stateSince: now, summary: null, question: null, choices: [] }),
			// a shell job has no worker to report: it is busy until it exits
			status: rec.kind === "shell" ? "busy" : null,
			waitingFor: null,
			tool: null,
			error: null,

			reportedAt: undefined,
			endedAt: undefined,
			stopRequested: false,
			removeAt: undefined,
			reaped: false,
			supersededBy: undefined,
			attachSignal: false,
			attachRepaint: false,
			restartedAt: now,
			resumeAt: undefined,
			command,
			restore,
			// an automatic restart counts; one the user makes while one waited neither counts
			// nor gives the budget back (replies to a crash loop would keep it going)
			crashRestarts:
				opts.crash || pendingResume ? (typeof st?.crashRestarts === "number" ? st.crashRestarts : 0) + (opts.crash ? 1 : 0) : 0,
			...(isProfileJob(rec) ? { typeTask: typeTask ?? null, termInputAt: now, termTyped: typeTask ? false : st?.termTyped === true } : {}),
		});
		await startHost(rec);
		if (!shell) supersedeOthers(id);
		log("info", "respawn", { id, crash: !!opts.crash, restart: !!opts.restart, prompt: !!prompt });
		return { id, started: true };
	} finally {
		respawning.delete(id);
	}
}

/** DI-6: a shell job's row shows its latest output line; ended ones go after a while. */
function shellTick(): void {
	const now = Date.now();
	for (const [id, rec] of recs) {
		if (rec.kind !== "shell") {
			// M22: a worker that is up shows as such before its first report (or without one)
			if (!roster.has(id)) shellPids.delete(id);
			else {
				const pid = readWorkerPid(id) ?? null;
				if (shellPids.get(id) !== pid) {
					shellPids.set(id, pid);
					pushJob(id);
				}
			}
			continue;
		}
		const st = readState(id);
		if (!st) continue;
		if (!roster.has(id)) {
			if (typeof st.removeAt === "number" && now >= st.removeAt) {
				recs.delete(id);
				replyAt.delete(id);
				removeJob(id);
				log("info", "shell job expired", { id });
				push({ event: "removed", id });
			}
			shellPids.delete(id);
			continue;
		}
		if (isProfileJob(rec)) {
			// M31: a protocol agent's reports set its row; its terminal only until the first one
			if (isProtocolJob(rec) && typeof st.reportedAt === "number") {
				const pid = readWorkerPid(id) ?? null;
				if (shellPids.get(id) !== pid) {
					shellPids.set(id, pid);
					pushJob(id);
				}
			} else profileTick(id, rec, st, now);
			continue;
		}
		const line = lastScreenLine(id);
		const pid = readWorkerPid(id) ?? null;
		const changed = Boolean(line && line !== st.summary);
		if (changed) updateState(id, { summary: line });
		if (changed || shellPids.get(id) !== pid) {
			shellPids.set(id, pid);
			pushJob(id);
		}
	}
}

/** M30: replies typed into a level 0 agent at once (several could interleave in its input). */
const typing = new Set<string>();

/**
 * M30: a level 0 agent's row, from its host's term.json and its screen (inferTermState);
 * a task waiting to be typed goes in once it is quiet at a prompt.
 */
function profileTick(id: string, rec: JobRecord, st: JobState, now: number): void {
	const term = termFrom(rec.term);
	if (!term) return;
	let screen = "";
	try {
		screen = readFileSync(screenPath(id), "utf8");
	} catch {}
	const inputAt = typeof st.termInputAt === "number" ? st.termInputAt : st.startedAt;
	const typed = st.termTyped === true;
	let v = inferTermState(readTermSignals(termPath(id)), screen, term, { now, inputAt, typed });
	// M40: a scheduled run is unattended: an agent that notified and went quiet is done
	// (the notification is the row's text); a dialog it is stuck in is still a dialog
	if (v.state === "blocked" && v.waitingFor === "question" && recs.get(id)?.schedule) {
		v = { ...v, state: "done", status: "idle", waitingFor: null, question: null, summary: v.question ?? v.summary };
	}
	const pid = readWorkerPid(id) ?? null;
	// quiet at its prompt (a notification asks for input too); never into a dialog
	if (str(st.typeTask) && v.quiet && v.state !== "working" && v.waitingFor !== "dialog" && !typing.has(id)) {
		void typeInto(id, st.typeTask, term.submit).then((ok) => {
			if (ok) updateState(id, { typeTask: null });
		});
		return;
	}
	const patch: Partial<JobState> = {};
	if (st.state !== v.state) {
		patch.state = v.state;
		patch.stateSince = now;
	}
	if (st.status !== v.status) patch.status = v.status;
	if ((st.waitingFor ?? null) !== v.waitingFor) patch.waitingFor = v.waitingFor;
	if ((st.question ?? null) !== v.question) patch.question = v.question;
	if (v.summary && st.summary !== v.summary) patch.summary = v.summary;
	const moved = Object.keys(patch).length > 0;
	if (moved) updateState(id, patch);
	// M40: a scheduled run of a terminal agent goes once it is done (a reply starts it again)
	if (moved && v.state === "done" && recs.get(id)?.schedule) scheduleAutoClose(id);
	if (moved || shellPids.get(id) !== pid) {
		shellPids.set(id, pid);
		pushJob(id);
	}
}

/**
 * M30: text typed into a level 0 agent, then its submit key. Some agents take a burst of
 * input as a paste and keep a newline in it, so the submit goes a moment after.
 */
async function typeInto(id: string, text: string, submit: string): Promise<boolean> {
	if (typing.has(id)) return false;
	typing.add(id);
	try {
		const a = (await hostControl(id, "input", 3000, { data: text })) as { ok?: boolean } | undefined;
		if (a?.ok !== true) return false;
		// the text is in its input now: from here on it is never typed again, only submitted
		await new Promise((r) => setTimeout(r, 150));
		for (let tries = 0; tries < 2; tries++) {
			try {
				const b = (await hostControl(id, "input", 3000, { data: submit })) as { ok?: boolean } | undefined;
				if (b?.ok === true) break;
			} catch (err) {
				log("warn", "submitting into agent failed", { id, error: String(err) });
			}
		}
		const now = Date.now();
		updateState(id, { termInputAt: now, termTyped: true, state: "working", status: "busy", waitingFor: null, question: null, stateSince: now });
		pushJob(id);
		return true;
	} catch (err) {
		log("warn", "typing into agent failed", { id, error: String(err) });
		return false;
	} finally {
		typing.delete(id);
	}
}

function lastScreenLine(id: string): string | undefined {
	try {
		const lines = readFileSync(screenPath(id), "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const l = lines[i]!.trim();
			if (l) return l.slice(0, 200);
		}
	} catch {
		// not painted yet
	}
	return undefined;
}

/** When an idle job became idle, if it may be reaped now. */
function reapable(id: string, now: number, minutes: number): number | undefined {
	// M30: a level 0 agent's session lives in its process (a resume may not bring it back)
	if (isProfileJob(recs.get(id))) return undefined;
	const st = readState(id);
	if (!st || st.pinned === true || st.state === "working") return undefined;
	if (st.waitingFor === "dialog" || (st.status !== "idle" && st.status !== "waiting")) return undefined;
	if (pendingReplies(id).length > 0) return undefined;
	const idleSince = typeof st.stateSince === "number" ? st.stateSince : st.updatedAt;
	// M11: idle counts from the last time a phone used it, if that is later
	const since = typeof st.remoteAt === "number" ? Math.max(idleSince, st.remoteAt) : idleSince;
	return now - since < minutes * 60_000 ? undefined : since;
}

/**
 * M22: stop a worker only if nobody is attached, decided in the host itself: an attach
 * between asking for its status and terminating it would otherwise lose its session.
 * A host from before M22 does not know the op: it is terminated as before.
 */
async function terminateIfIdle(id: string): Promise<boolean> {
	try {
		const r = (await hostControl(id, "terminate-idle")) as { ok?: boolean; error?: string };
		if (r.error) await hostControl(id, "terminate");
		else if (r.ok !== true) {
			log("info", "not stopped: attached meanwhile", { id });
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** DM-4: stop workers that have been idle, unattached and unpinned for reapIdleMinutes. */
async function reapIdle(): Promise<void> {
	const minutes = Number(process.env.PI_ROOST_REAP_MINUTES) || loadUserConfig().reapIdleMinutes;
	if (!(minutes > 0)) return;
	const now = Date.now();
	for (const id of [...roster.keys()]) {
		if (starting.has(id) || stopping.has(id) || reaping.has(id) || respawning.has(id)) continue;
		const since = reapable(id, now, minutes);
		if (since === undefined) continue;
		reaping.add(id); // replies and stops see this while we ask the host
		let attached = true;
		try {
			attached = !!((await hostControl(id, "status")) as { attached?: boolean }).attached;
		} catch {
			// unknown: leave it
		}
		// anything may have happened during the await: decide again
		if (attached || !reaping.has(id) || !roster.has(id) || stopping.has(id) || reapable(id, Date.now(), minutes) === undefined) {
			reaping.delete(id);
			continue;
		}
		log("info", "reap", { id, idleMinutes: Math.round((now - since) / 60_000) });
		metric.reaped.add(1);
		if (!(await terminateIfIdle(id))) reaping.delete(id);
	}
}

function resolve(query: unknown): string {
	if (!str(query)) throw new OpError("bad_request", "query required");
	if (recs.has(query)) return query;
	// M22: jobs folded into another one's row are matched only when nothing listed is
	const shown = (ids: string[]) => {
		const v = ids.filter((id) => !hiddenJob(id));
		return v.length > 0 ? v : ids;
	};
	const byPrefix = shown([...recs.keys()].filter((id) => id.startsWith(query)));
	if (byPrefix.length === 1) return byPrefix[0]!;
	const q = query.toLowerCase();
	const matches = byPrefix.length > 1 ? byPrefix : shown([...recs.values()].filter((r) => r.name.toLowerCase().includes(q)).map((r) => r.id));
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) throw new OpError("not_found", `no job matches "${query}"`);
	const list = matches.map((id) => `${id} · ${recs.get(id)!.name}`).join(", ");
	throw new OpError("ambiguous", `"${query}" is ambiguous: ${list}`);
}

const REPORT_STATES = new Set(["working", "blocked", "done", "failed"]);
const REPORT_STATUS = new Set(["busy", "waiting", "idle"]);
const REPORT_WAITING = new Set([null, "dialog", "question", "first-prompt"]);

interface PendingReply {
	seq: number;
	text: string;
	/** M9: absent for user replies. */
	kind?: "reply" | AgentKind;
	/** M28: a user reply that steers. */
	mode?: "steer";
	from?: string;
	relation?: Relation;
}

const isAgentItem = (r: PendingReply) => isAgentKind(r.kind);

const MAX_PENDING = 50;

function pendingReplies(id: string): PendingReply[] {
	const p = readState(id)?.pendingReplies;
	return Array.isArray(p) ? p.filter((r): r is PendingReply => typeof r?.seq === "number" && str(r?.text)) : [];
}

/** (Re)send every reply the worker has not acknowledged; the worker drops seqs it has seen. */
function flushPending(id: string, conn: Conn): void {
	const pending = pendingReplies(id);
	for (const r of pending) if (!isAgentItem(r) || conn.agentItems) send(conn, deliverEvent(id, r));
	if (pending.length > 0) log("info", "delivered pending replies", { id, count: pending.length });
}

function acknowledge(args: { id?: unknown; token?: unknown; seq?: unknown } | undefined): void {
	const id = args?.id;
	if (!str(id) || !recs.has(id)) throw new OpError("not_found", `no such job: ${String(id)}`);
	const st = readState(id);
	if (!st || !str(args?.token) || st.jobToken !== args.token) throw new OpError("unauthorized", "bad job token");
	if (typeof args.seq !== "number") throw new OpError("bad_request", "seq required");
	const acked = args.seq;
	// user replies are acknowledged up to a seq; an agent item only by its own seq, once pi has it
	const exact = (args as { exact?: unknown }).exact === true;
	const before = pendingReplies(id);
	const after = before.filter((r) => (exact ? r.seq !== acked : r.seq > acked || isAgentItem(r)));
	// not durable: an ack lost in a crash means the reply is sent again, and dropped by seq
	updateState(id, { pendingReplies: after }, false);
	if (telemetry.enabled) repliesAcked(id, before.filter((r) => !after.includes(r)).map((r) => r.seq));
}

function deliverEvent(id: string, r: PendingReply): Event {
	replySent(id, r.seq);
	return {
		event: "deliver",
		id,
		seq: r.seq,
		text: r.text,
		...(r.kind ? { kind: r.kind } : {}),
		...(r.from ? { from: r.from } : {}),
		...(r.relation ? { relation: r.relation } : {}),
		...(r.mode ? { mode: r.mode } : {}),
	};
}

async function reply(
	args: { id?: unknown; text?: unknown; mode?: unknown } | undefined,
	// M45: the concierge answers in the user's place: the feed says so
	by: { who: string; whoId: string | null } = { who: "user", whoId: null },
): Promise<{ delivered: boolean; saved: boolean; stopped?: boolean; respawned?: boolean; error?: string; duplicate?: boolean }> {
	const id = requireJob(args);
	const recordReply = (text: string) => {
		record({ kind: "reply", id, name: rowOf(id)?.name ?? id, who: by.who, whoId: by.whoId, text: clipText(text) });
		// an answer reached it: the concierge's suggestion for it is spent
		if (dropSuggestion(id)) pushJob(id);
	};
	const text = typeof args?.text === "string" ? args.text.trim() : "";
	const steer = args?.mode === "steer";
	if (!text) throw new OpError("bad_request", "empty reply");
	// M36: a resend of a reply the daemon took (its answer was lost) is not taken twice
	const rawRid = (args as { requestId?: unknown } | undefined)?.requestId;
	const rid = requestIdOf(rawRid);
	if (rawRid !== undefined && !rid) throw new OpError("bad_request", "requestId: 1-64 of A-Z a-z 0-9 _ . : -");
	if (rid && seenRequest(id, rid)) {
		// taken before; an ended job it was to start (the daemon died in between) starts now
		if (!roster.has(id) && !starting.has(id) && !respawning.has(id) && pendingReplies(id).length > 0) {
			const r = await respawn(id).catch((err: unknown) => ({ error: (err as Error).message }));
			return { delivered: false, saved: true, duplicate: true, ...("error" in r ? { error: r.error } : { respawned: r.started }) };
		}
		return { delivered: false, saved: true, duplicate: true };
	}
	const live = roster.has(id);
	if (text === "/stop") {
		if (live) await terminateHost(id);
		else if (cancelResume(id)) {
			endWaiting(id, "stopped", null);
			return { delivered: false, saved: false, stopped: true };
		}
		return { delivered: live, saved: false, stopped: live };
	}
	if (text.startsWith("!")) throw new OpError("unsupported", "shell commands in replies are not supported yet; attach to run them");
	if (isTermJob(recs.get(id))) {
		const r = await replyToProfile(id, text, live);
		if (r.delivered || r.saved) recordReply(text);
		// typed in first, then kept: a crash in between types it again on a resend (not atomic)
		if (rid && (r.delivered || r.saved) && readState(id)) updateState(id, { requestIds: withRequest(readState(id), rid) });
		return r;
	}
	if (recs.get(id)?.kind === "shell" && !isProtocolJob(recs.get(id))) throw new OpError("unsupported", "a shell job takes no replies; attach to type into it");
	const conn = workerConns.get(id);
	const connected = live && !!conn && !conn.sock.destroyed;
	// PK-5: commands only make sense live; plain replies wait for the worker.
	if (live && !connected && text.startsWith("/")) return { delivered: false, saved: false };
	const pending = pendingReplies(id);
	if (pending.filter((r) => !isAgentItem(r)).length >= MAX_PENDING) {
		throw new OpError("full", `${MAX_PENDING} replies are already waiting for this session`);
	}
	// Every reply stays pending until the worker acknowledges it, so a dying connection loses nothing.
	const st = readState(id);
	const seq = (typeof st?.replySeq === "number" ? st.replySeq : 0) + 1;
	const item: PendingReply = { seq, text, ...(steer ? { mode: "steer" as const } : {}) };
	// the request id goes in the same write as the reply: both are kept, or neither
	updateState(id, { replySeq: seq, pendingReplies: [...pending, item], ...(rid ? { requestIds: withRequest(st, rid) } : {}) });
	replyIn(id, seq);
	recordReply(text);
	if (connected) {
		send(conn!, deliverEvent(id, item));
		return { delivered: true, saved: false };
	}
	log("info", "reply saved", { id, live });
	if (live) return { delivered: false, saved: true };
	// flow 5.7: a reply to an ended session starts it again; the worker picks the reply up
	try {
		const { started } = await respawn(id);
		// started: false means it is already coming up; the saved reply reaches it either way
		return { delivered: false, saved: true, respawned: started || starting.has(id) || roster.has(id) };
	} catch (err) {
		log("warn", "respawn for reply failed", { id, error: String(err) });
		return { delivered: false, saved: true, error: (err as Error).message };
	}
}

/**
 * M30: a reply to a level 0 agent is typed into its terminal (steer or follow-up does not
 * apply: it goes where its input is). An ended one starts again, by its resume argv when
 * the profile has one, and the reply is typed in once it is quiet.
 */
async function replyToProfile(id: string, text: string, live: boolean): Promise<{ delivered: boolean; saved: boolean; respawned?: boolean; error?: string }> {
	const term = termFrom(recs.get(id)?.term);
	if (!term) throw new OpError("unsupported", "this agent takes no replies; attach to type into it");
	// a task or reply waiting to be typed in goes first; a start under way has no input yet
	if (str(readState(id)?.typeTask)) throw new OpError("busy", "what it was last given is not typed in yet; try again in a moment");
	if (starting.has(id) || respawning.has(id)) throw new OpError("busy", "it is starting; try again in a moment");
	if (live) {
		if (typing.has(id)) throw new OpError("busy", "still typing the last reply");
		const ok = await typeInto(id, text, term.submit);
		if (!ok) throw new OpError("unsupported", "could not type into the agent; attach to type into it");
		return { delivered: true, saved: false };
	}
	try {
		const { started } = await respawn(id, { prompt: text });
		return { delivered: false, saved: true, respawned: started || starting.has(id) || roster.has(id) };
	} catch (err) {
		log("warn", "respawn for reply failed", { id, error: String(err) });
		return { delivered: false, saved: false, error: (err as Error).message };
	}
}

/** M31: what the daemon offers agents beyond report, ack and hello. */
const DAEMON_CAPABILITIES = ["replies", "steer", "agent-items", "peers", "spawn", "handback", "events", "watch"];

/**
 * M31: an agent's hello. Informational (a report is what proves a job): the daemon keeps
 * what the agent can do and answers with its own protocol and capabilities. A newer
 * protocol than this daemon's is answered with this one's: the agent decides.
 */
function hello(conn: Conn, args: { protocol?: unknown; agent?: unknown; capabilities?: unknown } | undefined): import("../lib/protocol.ts").HelloResult {
	if (typeof args?.protocol !== "number" || !Number.isInteger(args.protocol) || args.protocol < 1) throw new OpError("bad_request", "protocol must be a version number");
	const a = (args.agent && typeof args.agent === "object" ? args.agent : {}) as { name?: unknown; version?: unknown };
	const name = str(a.name) ? a.name.slice(0, 64) : "unknown";
	const caps = Array.isArray(args.capabilities) ? [...new Set(args.capabilities.filter(str).map((c) => c.slice(0, 40)))].slice(0, 32) : [];
	conn.hello = { name, version: str(a.version) ? a.version.slice(0, 40) : null, capabilities: caps };
	return { protocol: PROTOCOL_VERSION, daemon: { name: "roost", version: ROOST_VERSION }, capabilities: DAEMON_CAPABILITIES };
}

/** M36: request ids a job's replies came with, the last 100 (a resend comes soon after). */
const MAX_REQUEST_IDS = 100;
function seenRequest(id: string, rid: string): boolean {
	const ids = readState(id)?.requestIds;
	return Array.isArray(ids) && ids.includes(rid);
}
function withRequest(st: JobState | undefined, rid: string): string[] {
	const ids = Array.isArray(st?.requestIds) ? (st.requestIds as unknown[]).filter((x): x is string => typeof x === "string") : [];
	return [...ids, rid].slice(-MAX_REQUEST_IDS);
}

function acceptReport(conn: Conn, args: { id?: unknown; token?: unknown; report?: Partial<WorkerReport> } | undefined): void {
	const id = args?.id;
	if (!str(id) || !recs.has(id)) throw new OpError("not_found", `no such job: ${String(id)}`);
	const st = readState(id);
	if (!st || !str(args?.token) || st.jobToken !== args.token) throw new OpError("unauthorized", "bad job token");
	if (!roster.has(id) || stopping.has(id)) return; // ended or being stopped: the daemon owns the state now
	const takesAgentItems = (args.report as { agentItems?: unknown } | undefined)?.agentItems === true;
	const gained = takesAgentItems && !conn.agentItems && workerConns.get(id) === conn;
	conn.agentItems = takesAgentItems;
	if (gained) flushPending(id, conn);
	if (workerConns.get(id) !== conn) {
		workerConns.set(id, conn);
		conn.peer = { kind: "job", id };
		flushPending(id, conn);
		const session = recs.get(id)?.sessionFile;
		if (session) setImmediate(() => void retryReports(session));
	}
	const r = args.report;
	if (!r || !REPORT_STATES.has(r.state as string) || !REPORT_STATUS.has(r.status as string)) {
		throw new OpError("bad_request", "invalid report");
	}
	const opt = (v: unknown, max = 500) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
	const before = st.state;
	const waitingBefore = st.waitingFor ?? null;
	const waitingNow = REPORT_WAITING.has(r.waitingFor ?? null) ? (r.waitingFor ?? null) : null;
	updateState(id, {
		...(before !== r.state || waitingBefore !== waitingNow ? { stateSince: Date.now() } : {}),
		state: r.state,
		status: r.status,
		waitingFor: REPORT_WAITING.has(r.waitingFor ?? null) ? (r.waitingFor ?? null) : null,
		summary: opt(r.summary),
		question: opt(r.question, 2000),
		choices: Array.isArray(r.choices) ? r.choices.filter(str).slice(0, 20).map((c) => c.slice(0, 200)) : [],
		tool: opt(r.tool, 100),
		error: opt(r.error, 1000),
		// a rename the session has not taken yet keeps the daemon's name; the concierge's name is its own
		displayName: str(st.pendingName) && opt(r.name, 200) !== st.pendingName ? st.pendingName : conciergeSafeName(id, opt(r.name, 200)),
		...(str(st.pendingName) && opt(r.name, 200) === st.pendingName ? { pendingName: null } : {}),
		model: opt(r.model, 200),
		// M8: workers before 0.1.5 send neither; keep what is known then
		...(r.thinking !== undefined ? { thinking: opt(r.thinking, 20) } : {}),
		...(r.context !== undefined ? { context: contextFrom(r.context) } : {}),
		// M24: workers before 0.1.11 send none
		...(r.usage !== undefined ? { usage: usageFrom(r.usage) } : {}),
		// M11: a phone using the session keeps it from being reaped (never in the future)
		...(typeof r.remoteAt === "number" && Number.isFinite(r.remoteAt) ? { remoteAt: Math.min(r.remoteAt, Date.now()) } : {}),
		reportedAt: Date.now(),
		// M31: what its agent said it can do (kept from the hello on this connection)
		...(conn.hello ? { agentInfo: conn.hello } : {}),
		attachSignal: r.attachSignal === true,
		attachRepaint: r.attachRepaint === true,
		// M16: links only grow (a respawned worker starts with none)
		...(Array.isArray(r.prLinks) ? { prLinks: mergeLinks(st.prLinks, r.prLinks) } : {}),
		// a turn that ends normally clears the crash budget (DM-5)
		// (only once the worker has stayed up a while, so a crash loop stays bounded)
		// (written only when there is a count: a report is not otherwise a durable write)
		...(r.state !== "working" && typeof st.crashRestarts === "number" && st.crashRestarts > 0 && Date.now() - (typeof st.restartedAt === "number" ? st.restartedAt : 0) > CRASH_RESET_MS
			? { crashRestarts: 0 }
			: {}),
	});
	if (before !== r.state) log("info", "state", { id, from: before, to: r.state, waitingFor: r.waitingFor ?? null });
	metric.reports.add(1);
	if (before !== r.state) metric.stateChanges.add(1, { to: r.state ?? null });
	pushJob(id);
	// M13: a subagent that finished closes (each report while done and idle starts the wait again)
	if (r.state === "done" && r.status === "idle" && (recs.get(id)?.parentSession || recs.get(id)?.schedule)) scheduleAutoClose(id);
}

/** AV-K10: the row's name, the job's name for `attach <name>`, and the live session's name. */
function rename(args: { id?: unknown; name?: unknown } | undefined): { id: string; name: string } {
	const id = requireJob(args);
	const name = typeof args?.name === "string" ? args.name.replace(/\s+/g, " ").trim().slice(0, 200) : "";
	if (!name) throw new OpError("bad_request", "empty name");
	// M44: the concierge's name is its own (a session could pass for it otherwise)
	if (name === CONCIERGE_NAME && !isConcierge(id)) throw new OpError("bad_request", `${CONCIERGE_NAME} is the concierge's name`);
	const rec = recs.get(id)!;
	const next = { ...rec, name };
	writeJsonAtomic(`${jobDirOf(id)}/job.json`, next);
	recs.set(id, next);
	// M31: only pi takes /name; another agent's row is named by the daemon alone
	if (rec.kind === "shell") {
		updateState(id, { displayName: name }, true);
		pushJob(id);
		log("info", "rename", { id, name });
		return { id, name };
	}
	// The session takes the name too, whenever its worker next runs (now, or after a
	// respawn): until it reports that name, the daemon's name wins over the report.
	const st = readState(id);
	const seq = (typeof st?.replySeq === "number" ? st.replySeq : 0) + 1;
	const pending = pendingReplies(id).filter((r) => !r.text.startsWith("/name "));
	updateState(id, { displayName: name, pendingName: name, replySeq: seq, pendingReplies: [...pending, { seq, text: `/name ${name}` }] });
	const conn = workerConns.get(id);
	if (roster.has(id) && conn && !conn.sock.destroyed) send(conn, { event: "deliver", id, seq, text: `/name ${name}` });
	pushJob(id);
	log("info", "rename", { id, name });
	return { id, name };
}

function requireJob(args: unknown): string {
	const id = (args as { id?: unknown } | undefined)?.id;
	if (!str(id)) throw new OpError("bad_request", "id required");
	if (!recs.has(id)) throw new OpError("not_found", `no such job: ${id}`);
	return id;
}

function list(args: { cwd?: string } | undefined): JobRow[] {
	const cwd = args?.cwd;
	const prefix = cwd ? (cwd.endsWith("/") ? cwd : `${cwd}/`) : undefined;
	const rows: JobRow[] = [];
	for (const rec of recs.values()) {
		if (cwd && rec.cwd !== cwd && !rec.cwd.startsWith(prefix!)) continue;
		const row = rowOf(rec.id);
		if (row) rows.push(row);
	}
	return rows.sort((x, y) => y.startedAt - x.startedAt);
}

// ---------------------------------------------------------------- M9: agent messaging

function requirePeer(conn: Conn): PeerIdentity {
	if (!conn.peer) throw new OpError("unauthorized", "this connection is not a peer (report as a worker, or peer_register)");
	if (conn.peer.kind === "job" && !recs.has(conn.peer.id)) throw new OpError("not_found", "this job was removed");
	return conn.peer;
}

const fgKey = (p: { id: string; session?: string }) => p.session ?? `peer:${p.id}`;

function sessionKeyOf(peer: PeerIdentity): string {
	if (peer.kind === "fg") return fgKey(peer);
	const rec = recs.get(peer.id);
	if (!rec || rec.kind === "shell") throw new OpError("unsupported", "a shell job has no session");
	return rec.sessionFile;
}

/** Spawn links live on the job records of a session (any of them: ←, respawns keep the file). */
function treeNode(key: string): TreeNode {
	for (const r of recs.values()) {
		if (r.sessionFile === key && r.parentSession) return { key, parent: r.parentSession, root: r.rootSession ?? r.parentSession };
	}
	return { key, parent: null, root: key };
}

type Holder = { kind: "fg"; id: string; conn: Conn; name: string; cwd: string } | { kind: "job"; id: string };

/** Who answers for a session now: a connected foreground pi, else its live job, else its latest job. */
function holderOf(key: string): Holder | undefined {
	for (const [id, c] of fgPeers) {
		const p = c.peer;
		if (p?.kind === "fg" && fgKey(p) === key && !c.sock.destroyed) return { kind: "fg", id, conn: c, name: p.name, cwd: p.cwd };
	}
	let best: JobRecord | undefined;
	for (const r of recs.values()) {
		if (r.kind === "shell" || r.sessionFile !== key) continue;
		if (roster.has(r.id)) return { kind: "job", id: r.id };
		if (!best || r.createdAt > best.createdAt) best = r;
	}
	return best ? { kind: "job", id: best.id } : undefined;
}

function holderName(h: Holder): string {
	return h.kind === "fg" ? h.name : (rowOf(h.id)?.name ?? h.id);
}

function peerName(peer: PeerIdentity): string {
	return peer.kind === "fg" ? peer.name : (rowOf(peer.id)?.name ?? peer.id);
}

const EXTERNAL_RECENT_MS = 48 * 60 * 60 * 1000;

/** Text from another session, for a model or a terminal: no control characters. */
const plain = (v: string | null) => (v === null ? null : v.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]+/g, " "));

/** The sessions `peer` may reach, one row per session (its current holder). */
function peerRows(peer: PeerIdentity): (PeerRow & { key: string })[] {
	const me = sessionKeyOf(peer);
	const meNode = treeNode(me);
	// M44: the concierge reaches every session (it is the hub's); others, their tree
	const external = loadUserConfig().agentExternalMessages || isConciergePeer(peer);
	const keys = new Set<string>();
	for (const c of fgPeers.values()) if (c.peer?.kind === "fg") keys.add(fgKey(c.peer));
	for (const r of recs.values()) if (r.kind !== "shell" && r.sessionFile) keys.add(r.sessionFile);
	const rows: (PeerRow & { key: string })[] = [];
	const now = Date.now();
	for (const key of keys) {
		if (key === me) continue;
		const relation = relationOf(meNode, treeNode(key));
		if (relation === "external" && !external) continue;
		const h = holderOf(key);
		if (!h) continue;
		if (h.kind === "fg") {
			rows.push({ key, id: h.id, name: h.name, relation, role: "foreground", state: "live", status: null, waitingFor: null, summary: null, question: null, cwd: h.cwd });
			continue;
		}
		const row = rowOf(h.id);
		if (!row) continue;
		// outside the tree, only sessions that are running or recent
		if (relation === "external" && row.pid === null && now - (row.endedAt ?? row.startedAt) > EXTERNAL_RECENT_MS) continue;
		rows.push({
			key,
			id: row.id,
			name: row.name,
			relation,
			role: "job",
			state: row.state,
			status: row.status,
			waitingFor: row.waitingFor,
			summary: plain(row.summary),
			question: plain(row.question),
			cwd: row.cwd,
		});
	}
	const order: Record<string, number> = { parent: 0, child: 1, sibling: 2, tree: 3, external: 4 };
	return rows.sort((a, b) => order[a.relation]! - order[b.relation]! || a.name.localeCompare(b.name));
}

function findTarget(peer: PeerIdentity, to: string): PeerRow & { key: string } {
	const rows = peerRows(peer);
	const byId = rows.find((r) => r.id === to);
	if (byId) return byId;
	const byName = rows.filter((r) => r.name === to && (r.relation !== "external" || isConciergePeer(peer)));
	if (byName.length === 1) return byName[0]!;
	if (byName.length > 1) {
		throw new OpError("ambiguous", `"${to}" names ${byName.length} sessions: ${byName.map((r) => `${r.id} (${r.relation})`).join(", ")}; use the id`);
	}
	throw new OpError("not_found", `no reachable session "${to}" (roost_agents lists them; sessions outside your tree need their exact id and agentExternalMessages)`);
}

/**
 * Hand an agent item to whoever holds `key`: a connected foreground pi directly (nothing
 * is stored for it), a job through its reply queue (kept until acknowledged; an ended job
 * is started again, a stopped one is not).
 */
async function deliverAgent(
	key: string,
	kind: AgentKind,
	text: string,
	meta: { from: string; relation: Relation; ref?: string },
): Promise<Omit<SendResult, "relation">> {
	const h = holderOf(key);
	if (!h) return { outcome: "not running", id: "", name: "" };
	const name = holderName(h);
	if (h.kind === "fg") {
		send(h.conn, { event: "deliver", id: h.id, seq: 0, text, kind, from: sanitizeName(meta.from), relation: meta.relation, ...(meta.ref ? { ref: meta.ref } : {}) });
		return { outcome: "delivered", id: h.id, name };
	}
	const id = h.id;
	const live = roster.has(id);
	const st = readState(id);
	if (!live && st?.state === "stopped") return { outcome: "stopped", id, name };
	const pending = pendingReplies(id);
	if (pending.filter(isAgentItem).length >= MAX_PENDING_AGENT) {
		throw new OpError("full", `${MAX_PENDING_AGENT} agent messages are already waiting for ${name}`);
	}
	const seq = (typeof st?.replySeq === "number" ? st.replySeq : 0) + 1;
	const item: PendingReply = { seq, text, kind, from: sanitizeName(meta.from), relation: meta.relation };
	updateState(id, { replySeq: seq, pendingReplies: [...pending, item] });
	replyIn(id, seq, kind);
	const dialog = st?.waitingFor === "dialog" ? { dialog: true } : {};
	const conn = workerConns.get(id);
	if (live && conn && !conn.sock.destroyed) {
		// a worker from before M9 gets it after a respawn --all, not as user input now
		if (!conn.agentItems) return { outcome: "queued", id, name, ...dialog };
		send(conn, deliverEvent(id, item));
		return { outcome: "delivered", id, name, ...dialog };
	}
	if (live) return { outcome: "queued", id, name, ...dialog };
	try {
		await respawn(id);
		return { outcome: "started", id, name };
	} catch (err) {
		// the item stays queued for the session's next start
		log("warn", "respawn for agent message failed", { id, error: String(err) });
		return { outcome: "not running", id, name };
	}
}

async function sendMessage(conn: Conn, args: { to?: unknown; message?: unknown } | undefined): Promise<SendResult> {
	const peer = requirePeer(conn);
	const to = typeof args?.to === "string" ? args.to.trim() : "";
	const message = typeof args?.message === "string" ? args.message.trim() : "";
	if (!to) throw new OpError("bad_request", "to required");
	if (!message) throw new OpError("bad_request", "empty message");
	if (message.length > MESSAGE_MAX) throw new OpError("too_long", `a message is at most ${MESSAGE_MAX} characters`);
	const me = sessionKeyOf(peer);
	const target = findTarget(peer, to);
	if (target.key === me) throw new OpError("bad_request", "a session cannot message itself");
	// M43: the same text to the same session again within a minute is not sent twice (a
	// loop of two sessions repeating themselves stops here)
	const pair = `${me}\n${target.key}`;
	const hash = createHash("sha1").update(message).digest("hex");
	const last = lastSent.get(pair);
	const now = Date.now();
	if (last && last.hash === hash && now - last.at < DUPLICATE_WINDOW_MS) {
		log("info", "agent message dropped", { from: peer.id, to: target.id, why: "duplicate" });
		return { outcome: "duplicate", id: target.id, name: target.name, relation: target.relation };
	}
	if (!messageLimiter.take(me)) throw new OpError("rate_limited", `at most ${MESSAGES_PER_MINUTE} messages a minute`);
	// the receiver sees the sender from its own side of the tree
	const relation = relationOf(treeNode(target.key), treeNode(me));
	const from = peerName(peer);
	const text = envelope({ from, id: peer.id, relation, kind: "message", body: message });
	const r = await deliverAgent(target.key, "message", text, { from, relation });
	log("info", "agent message", { from: peer.id, to: r.id || target.id, outcome: r.outcome });
	if (reached(r.outcome)) {
		// only a message that went counts as sent: one refused may be sent again at once
		lastSent.set(pair, { hash, at: now });
		if (lastSent.size > 1000) for (const [k, v] of lastSent) if (now - v.at > DUPLICATE_WINDOW_MS) lastSent.delete(k);
		record({ kind: "message", id: r.id || target.id, name: r.name || target.name, who: from, whoId: peer.kind === "job" ? peer.id : null, text: clipText(message) });
	}
	return { ...r, id: r.id || target.id, name: r.name || target.name, relation: target.relation };
}

interface HeldReport {
	ref: string;
	body: string;
}

function heldReports(id: string): HeldReport[] {
	const h = readState(id)?.undeliveredReports;
	if (!Array.isArray(h)) return [];
	return h
		.map((x, i) => (typeof x === "string" ? { ref: `${id}:old${i}`, body: x } : x))
		.filter((x): x is HeldReport => !!x && typeof x.ref === "string" && typeof x.body === "string");
}

function setHeld(id: string, held: HeldReport[]): void {
	if (recs.has(id)) updateState(id, { undeliveredReports: held.slice(-5) });
}

let reportRefs = 0;

/**
 * A report for the parent of `childId`. A job parent keeps it in its queue; a foreground
 * parent has it until it acknowledges (peer_ack), so until then, or when nobody holds the
 * parent's session, it stays on the child and is sent again when the session is held.
 */
async function routeReport(childId: string, body: string, ref = `${childId}:${Date.now().toString(36)}${(reportRefs++).toString(36)}`): Promise<boolean> {
	const rec = recs.get(childId);
	const parentKey = rec?.parentSession;
	if (!rec || !parentKey) return false;
	const from = rowOf(childId)?.name ?? rec.name;
	const text = envelope({ from, id: childId, relation: "child", kind: "report", body });
	const hold = () => {
		const held = heldReports(childId).filter((x) => x.ref !== ref);
		setHeld(childId, [...held, { ref, body }]);
	};
	const h = holderOf(parentKey);
	if (h?.kind === "fg") hold(); // until the foreground pi has it
	try {
		const r = await deliverAgent(parentKey, "report", text, { from, relation: "child", ref });
		if (r.outcome !== "not running" && r.outcome !== "stopped") {
			log("info", "report", { from: childId, to: r.id, outcome: r.outcome });
			record({ kind: "report", id: childId, name: from, who: r.name, text: clipText(body.split("\n")[0]) });
			return true;
		}
	} catch (err) {
		log("warn", "report delivery failed", { id: childId, error: String(err) });
	}
	hold();
	log("info", "report held", { id: childId });
	return false;
}

/** Someone holds `parentKey` again: hand over the reports its children kept. */
async function retryReports(parentKey: string): Promise<void> {
	for (const rec of [...recs.values()]) {
		if (rec.parentSession !== parentKey) continue;
		for (const r of heldReports(rec.id)) await routeReport(rec.id, r.body, r.ref);
	}
}

/** A foreground pi has a report: forget the copy kept on the child. */
function peerAck(conn: Conn, args: { ref?: unknown } | undefined): {} {
	const peer = requirePeer(conn);
	if (peer.kind !== "fg") throw new OpError("unsupported", "only foreground peers acknowledge reports");
	const ref = typeof args?.ref === "string" ? args.ref : "";
	const childId = ref.split(":")[0] ?? "";
	if (recs.has(childId)) setHeld(childId, heldReports(childId).filter((x) => x.ref !== ref));
	return {};
}

async function handback(conn: Conn, args: Partial<HandbackArgs> | undefined): Promise<{ routed: boolean }> {
	const peer = requirePeer(conn);
	if (peer.kind !== "job") throw new OpError("unsupported", "only a background session reports back");
	if (!recs.get(peer.id)?.parentSession || stopping.has(peer.id)) return { routed: false };
	const state = args?.state;
	if (state !== "done" && state !== "blocked" && state !== "failed") throw new OpError("bad_request", "invalid state");
	const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
	const body = reportBody({ state, result: text(args?.result, 6000), question: text(args?.question, 2000), error: text(args?.error, 1000) });
	const routed = await routeReport(peer.id, await withWorktreeLine(peer.id, body));
	// M13: the report is routed or held on the record: the worker may go
	if (state === "done") scheduleAutoClose(peer.id);
	return { routed };
}


/**
 * M13: stop the worker of a child that finished, as a subagent ends in Claude Code. The
 * record stays (state done, reaped): a message from the parent or the user starts it
 * again from its session file. Like the idle reaper it leaves a pinned, attached, busy
 * or waiting child alone, and one with replies still queued.
 */
function scheduleAutoClose(id: string): void {
	const rec = recs.get(id);
	// M39: a scheduled run's worker goes once it is done, as a subagent's (it is started again by a reply)
	if (!rec || !((rec.parentSession && loadUserConfig().subagentAutoClose) || rec.schedule)) return;
	clearTimeout(closeTimers.get(id));
	const t = setTimeout(() => {
		closeTimers.delete(id);
		void autoClose(id);
	}, AUTO_CLOSE_MS);
	t.unref?.();
	closeTimers.set(id, t);
}

function closable(id: string): boolean {
	if (!roster.has(id) || starting.has(id) || stopping.has(id) || respawning.has(id)) return false;
	const st = readState(id);
	if (!st || st.pinned === true || st.state !== "done") return false;
	if (st.status !== "idle" || st.waitingFor) return false;
	// done for a moment: its report goes out right after the turn settles
	if (Date.now() - (typeof st.stateSince === "number" ? st.stateSince : 0) < AUTO_CLOSE_MS / 2) return false;
	// its own children still run and report to it: it would only be started again
	const file = recs.get(id)?.sessionFile;
	if (file && [...recs.values()].some((r) => r.parentSession === file && roster.has(r.id))) return false;
	return pendingReplies(id).length === 0;
}

async function autoClose(id: string): Promise<void> {
	if (reaping.has(id) || !closable(id)) return;
	reaping.add(id); // a stop sees this while we ask the host
	let attached = true;
	try {
		attached = !!((await hostControl(id, "status")) as { attached?: boolean }).attached;
	} catch {
		// unknown: leave it
	}
	// anything may have happened during the await: decide again
	if (attached || !reaping.has(id) || !closable(id)) {
		reaping.delete(id);
		return;
	}
	log("info", "auto-close", { id });
	if (!(await terminateIfIdle(id))) reaping.delete(id);
}

function peerRegister(conn: Conn, args: { session?: unknown; name?: unknown; cwd?: unknown; pid?: unknown } | undefined): { id: string } {
	if (conn.peer?.kind === "job") throw new OpError("bad_request", "a worker connection is already a peer");
	const name = typeof args?.name === "string" && args.name.trim() ? args.name.trim().slice(0, 200) : "pi";
	const cwd = typeof args?.cwd === "string" ? args.cwd : "";
	const pid = args?.pid;
	if (typeof pid !== "number" || !isAlive(pid)) throw new OpError("bad_request", "pid must be a live process");
	const session = typeof args?.session === "string" && args.session ? args.session : undefined;
	if (session) {
		if (!isAbsolute(session)) throw new OpError("bad_request", "session must be an absolute path");
		// only the pi that holds the session may receive its messages
		if (readWriterLock(session)?.pid !== pid) throw new OpError("unauthorized", "the session's writer lock is not held by that pid");
	}
	const previous = conn.peer;
	if (previous?.kind === "fg" && fgPeers.get(previous.id) === conn) fgPeers.delete(previous.id);
	const id =
		previous?.kind === "fg" && !previous.session && !session
			? previous.id
			: foregroundPeerId(session, (s) => createHash("sha1").update(s).digest("hex"), () => randomBytes(4).toString("hex"));
	conn.peer = { kind: "fg", id, session, name, cwd, pid };
	// the newest registration for a session wins (a pi re-opened on it)
	fgPeers.set(id, conn);
	if (previous?.kind === "fg" && previous.session !== session) pushChildrenOf(previous.session);
	pushChildrenOf(session);
	// after the response: the client only takes deliveries for the id it is told
	if (session) setImmediate(() => void retryReports(session));
	if (session) continuedElsewhere(session);
	return { id };
}

async function spawnChild(conn: Conn, args: { launch?: DispatchArgs } | undefined): Promise<{ id: string; name: string }> {
	const peer = requirePeer(conn);
	const launch = args?.launch;
	if (!launch || typeof launch !== "object") throw new OpError("bad_request", "launch required");
	if (launch.kind === "shell") throw new OpError("unsupported", "roost_spawn starts pi sessions");
	// a fresh session for the child, never one that exists or another job uses
	if (!str(launch.sessionFile) || existsSync(launch.sessionFile) || [...recs.values()].some((r) => r.sessionFile === launch.sessionFile)) {
		throw new OpError("bad_request", "a spawn needs a new session file");
	}
	const me = sessionKeyOf(peer);
	const node = treeNode(me);
	const cfg = loadUserConfig();
	let depth = 0;
	const seen = new Set<string>();
	for (let k: string | null = me; k && !seen.has(k); k = treeNode(k).parent) {
		seen.add(k);
		if (treeNode(k).parent) depth++;
	}
	if (depth + 1 > cfg.agentMaxDepth) throw new OpError("limit", `sessions may nest ${cfg.agentMaxDepth} deep (agentMaxDepth)`);
	const live = [...recs.values()].filter((r) => r.parentSession && roster.has(r.id));
	if (live.filter((r) => r.parentSession === me).length >= cfg.agentMaxChildren) {
		throw new OpError("limit", `at most ${cfg.agentMaxChildren} running children per session (agentMaxChildren)`);
	}
	if (live.filter((r) => (r.rootSession ?? r.parentSession) === node.root).length >= cfg.agentMaxTree) {
		throw new OpError("limit", `at most ${cfg.agentMaxTree} running sessions per tree (agentMaxTree)`);
	}
	if (live.length >= cfg.agentMaxTotal) throw new OpError("limit", `at most ${cfg.agentMaxTotal} running spawned sessions (agentMaxTotal)`);
	if (!spawnLimiter.take(node.root)) throw new OpError("rate_limited", `at most ${SPAWNS_PER_MINUTE} spawns a minute per tree`);
	const env = { ...(launch.env && typeof launch.env === "object" ? launch.env : {}), PI_ROOST_CHILD: "1" };
	const r = await dispatch({ ...launch, env, origin: "dispatch" }, { parentSession: me, rootSession: node.root });
	log("info", "spawn", { from: peer.id, id: r.id, depth: depth + 1 });
	return r;
}

let server: Server;
let shuttingDown = false;

async function shutdown(keepWorkers: boolean): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log("info", "shutdown", { keepWorkers });
	// M38: a waiting restart stays in the job's state (resumeAt); the next start takes it up
	for (const t of resumeTimers.values()) clearTimeout(t);
	resumeTimers.clear();
	clearInterval(watcher);
	clearInterval(scheduler);
	clearInterval(shellWatcher);
	clearInterval(reaper);
	clearInterval(conciergeTicker);
	clearTimeout(conciergeTimer);
	if (!keepWorkers) {
		const ids = [...roster.keys()];
		await Promise.all(ids.map((id) => terminateHost(id)));
		await waitGone(ids, WAIT_MS);
	}
	persistRoster();
	// M35: the last group of durable writes reaches the disk before the process goes
	await durable().catch(() => {});
	releaseDaemonLock();
	server.close();
	for (const c of conns) c.sock.destroy();
	try {
		unlinkSync(daemonSocketPath());
	} catch {}
	process.exit(0);
}

async function handle(conn: Conn, op: string, args: any): Promise<unknown> {
	switch (op) {
		case "ping":
			return { pid: process.pid, version: ROOST_VERSION };
		case "schedules":
		case "schedule-add":
		case "schedule-rm":
		case "schedule-pause":
			return scheduleOp(op, args);
		case "schedule-run": {
			const s = scheduleOf(args?.name);
			return { name: s.name, id: await runSchedule(s, Date.now(), "now") };
		}
		case "hello":
			return hello(conn, args);
		case "list":
			return { jobs: list(args) };
		case "dispatch":
			return dispatch(args);
		case "resolve":
			return { id: resolve(args?.query) };
		case "status": {
			const s: DaemonStatus = {
				pid: process.pid,
				version: ROOST_VERSION,
				socketDir: runtimeDir(),
				liveJobs: roster.size,
				totalJobs: recs.size,
				ptyError,
				startedAt,
			};
			return s;
		}
		case "subscribe":
			conn.subscribed = true;
			return {};
		case "stop": {
			const id = requireJob(args);
			if (roster.has(id)) {
				log("info", "stop", { id });
				await terminateHost(id);
			} else if (cancelResume(id)) {
				// M38: between a crash and its automatic restart
				log("info", "stop", { id, resume: "cancelled" });
				endWaiting(id, "stopped", null);
			}
			return { id };
		}
		case "rm":
			return removeRecord(requireJob(args));
		case "respawn": {
			if (args?.all === true) {
				const results: { id: string; started: boolean; error?: string }[] = [];
				for (const id of [...recs.keys()]) {
					// --all moves live jobs to the installed version; reaped ones pick it up when woken
					if (!roster.has(id) || recs.get(id)?.kind === "shell") continue;
					try {
						results.push(await respawn(id, { restart: true }));
					} catch (err) {
						results.push({ id, started: false, error: (err as Error).message });
					}
				}
				return { results };
			}
			const id = requireJob(args);
			const prompt = typeof args?.prompt === "string" && args.prompt.trim() ? args.prompt.trim() : undefined;
			return { results: [await respawn(id, { restart: args?.restart === true, prompt })] };
		}
		case "pin": {
			const id = requireJob(args);
			const pinned = args?.pinned === true;
			updateState(id, { pinned });
			pushJob(id);
			return { id, pinned };
		}
		case "rename":
			return rename(args);
		case "reorder": {
			const ids: unknown = args?.ids;
			const key: unknown = args?.key;
			if (!Array.isArray(ids) || !ids.every((v) => str(v) && recs.has(v))) throw new OpError("bad_request", "ids must be job ids");
			if (!str(key)) throw new OpError("bad_request", "key required");
			ids.forEach((id: string, i: number) => updateState(id, { order: i, orderKey: key }));
			for (const id of ids) pushJob(id);
			return {};
		}
		case "report":
			acceptReport(conn, args);
			return {};
		case "reply":
			return reply(args);
		case "ack":
			acknowledge(args);
			return {};
		case "shutdown":
			setTimeout(() => void shutdown(!!args?.keepWorkers), 20);
			return {};
		case "peer_register":
			return peerRegister(conn, args);
		case "peers":
			return { peers: peerRows(requirePeer(conn)).map(({ key: _key, ...row }) => row) };
		case "send":
			return sendMessage(conn, args);
		case "spawn":
			return spawnChild(conn, args);
		case "handback":
			return handback(conn, args);
		case "peer_ack":
			return peerAck(conn, args);
		case "events": {
			// the feed is the hub's and the CLI's: a session reads other trees' messages otherwise
			if (conn.peer && !isConciergePeer(conn.peer)) throw new OpError("unsupported", "the event feed is read by the hub and the CLI, not by sessions");
			const after = args?.after;
			const limit = args?.limit;
			const id = args?.id;
			if (after !== undefined && (typeof after !== "number" || !Number.isFinite(after))) throw new OpError("bad_request", "after must be a number");
			if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) throw new OpError("bad_request", "limit must be a number");
			if (id !== undefined && !str(id)) throw new OpError("bad_request", "id must be a job id");
			return eventLog.since({ after, limit, id });
		}
		case "watch":
			return addWatch(conn, args);
		case "concierge":
			// the hub's (a session cannot start, stop or question the concierge)
			if (conn.peer) throw new OpError("unsupported", "the concierge is the hub's: a session cannot start, stop or ask it");
			return conciergeOp(args);
		case "concierge-ask":
			if (conn.peer) throw new OpError("unsupported", "the concierge is the hub's: a session cannot start, stop or ask it");
			return conciergeAsk(args);
		case "concierge-say":
			return conciergeSay(conn, args);
		// M45: the concierge's policy, suggestions, answers and acts (its own connection)
		case "concierge-policy":
			return conciergePolicyOp(conn);
		case "concierge-suggest":
			return conciergeSuggest(conn, args);
		case "concierge-reply":
			return conciergeReply(conn, args);
		case "concierge-act":
			return conciergeAct(conn, args);
		default:
			throw new OpError("bad_request", `unknown op: ${op}`);
	}
}

async function onLine(conn: Conn, line: string): Promise<void> {
	if (!line.trim()) return;
	let msg: { id?: unknown; op?: unknown; args?: unknown } | undefined;
	try {
		msg = JSON.parse(line);
	} catch {
		log("warn", "bad client line");
		return;
	}
	const reqId = msg && typeof msg === "object" ? msg.id : undefined;
	if (typeof reqId !== "number") return;
	if (typeof msg!.op !== "string") {
		send(conn, { id: reqId, ok: false, error: "op required", code: "bad_request" });
		return;
	}
	try {
		// M34: every request a span (its op, its time, ok or its error)
		// a refusal (busy, full, not_found ...) is an answer, not a failure: ok, with its code
		const op = msg!.op as string;
		const result = await telemetry.startSpan({ name: `roost.op.${op.slice(0, 32)}` }, (span) =>
			handle(conn, op, msg!.args).catch((err: unknown) => {
				if (err instanceof OpError) {
					span.setAttributes({ code: err.code });
					span.setStatus({ status: "ok" });
				}
				throw err;
			}),
		);
		// M35: what the answer says was saved is on disk before it is sent
		await durable();
		send(conn, { id: reqId, ok: true, result });
	} catch (err) {
		const e = err as Partial<OpError> & Error;
		if (!(err instanceof OpError)) log("error", "op failed", { op: msg!.op, error: String(e?.stack ?? err) });
		send(conn, { id: reqId, ok: false, error: e?.message ?? String(err), code: e?.code ?? "internal" });
	}
}

loadJobs();
loadSchedules();

try {
	unlinkSync(daemonSocketPath());
} catch {}
server = createServer((sock) => {
	const conn: Conn = { sock, subscribed: false };
	conns.add(conn);
	const reader = new LineReader();
	sock.on("data", (chunk) => {
		for (const line of reader.push(chunk)) void onLine(conn, line);
	});
	sock.on("error", () => {});
	sock.on("close", () => {
		conns.delete(conn);
		if (conn.peer?.kind === "fg" && fgPeers.get(conn.peer.id) === conn) {
			fgPeers.delete(conn.peer.id);
			pushChildrenOf(conn.peer.session);
		}
	});
});
server.on("error", (err) => {
	log("error", "server error", { error: String(err) });
});
await new Promise<void>((res) => {
	server.once("error", (err) => {
		releaseDaemonLock();
		console.error(`daemon cannot listen: ${err}`);
		process.exit(1);
	});
	server.listen(daemonSocketPath(), () => res());
});
try {
	chmodSync(daemonSocketPath(), 0o600);
} catch {}

const watcher = setInterval(checkHosts, 1000);
// M39: runs that fell due while it was off, then every tick
catchUpSchedules();
const scheduler = setInterval(scheduleTick, SCHEDULE_TICK_MS);
scheduler.unref();
const shellWatcher = setInterval(shellTick, 2000);
shellWatcher.unref();
const reaper = setInterval(
	() => {
		sweepWatches();
		void reapIdle().catch((err: unknown) => log("error", "reap failed", { error: String(err) }));
		void cleanupOld().catch((err: unknown) => log("error", "cleanup failed", { error: String(err) }));
		void pollPrs().catch((err: unknown) => log("error", "pull request poll failed", { error: String(err) }));
	},
	Number(process.env.PI_ROOST_REAP_CHECK_MS) || REAP_CHECK_MS,
);
// M44: the concierge's heartbeat, and what happened while the service was off
const conciergeTicker = setInterval(() => conciergeTick(), CONCIERGE_TICK_MS);
conciergeTicker.unref();
nudgeConcierge();
process.on("SIGTERM", () => void shutdown(true));
process.on("SIGINT", () => void shutdown(true));
log("info", "started", { pid: process.pid, version: ROOST_VERSION, socket: daemonSocketPath(), ptyError, jobs: recs.size, live: roster.size });
