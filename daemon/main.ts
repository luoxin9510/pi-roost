import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { isAbsolute } from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic.ts";
import { hostEntry } from "../lib/client.ts";
import {
	type AgentKind,
	envelope,
	foregroundPeerId,
	MAX_PENDING_AGENT,
	MESSAGE_MAX,
	MESSAGES_PER_MINUTE,
	RateLimiter,
	type Relation,
	relationOf,
	reportBody,
	sanitizeName,
	SPAWNS_PER_MINUTE,
	type TreeNode,
} from "../lib/comms.ts";
import { loadUserConfig } from "../lib/config.ts";
import { hostControl } from "../lib/hostclient.ts";
import { newJobId, newToken } from "../lib/ids.ts";
import { acquireDaemonLock, readWriterLock, releaseDaemonLock } from "../lib/locks.ts";
import { daemonLogPath, daemonSocketPath, ensureDirs, jobDir as jobDirOf, rosterPath, runtimeDir } from "../lib/paths.ts";
import { isAlive, processStartToken, sameProcess } from "../lib/proc.ts";
import {
	type DaemonStatus,
	type DispatchArgs,
	type Event,
	type HandbackArgs,
	type JobRow,
	LineReader,
	type PeerRow,
	type SendResult,
	type WorkerReport,
	contextFrom,
	encodeLine,
} from "../lib/protocol.ts";
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
	respawnCommand,
	screenPath,
	updateState,
} from "../lib/store.ts";
import { type GhPr, isPrUrl, type PrInfo, prFromGh, prUrlsIn } from "../lib/pr.ts";
import { ROOST_VERSION } from "../lib/version.ts";
import { type CleanupResult, cleanupWorktree, isInside, validWorktree, type WorktreeInfo, worktreeLine, worktreeStatus } from "../lib/worktree.ts";

const WAIT_MS = 6000;
const CONTINUE = "Continue where you left off.";
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
}

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
}

/** M9: connected foreground pi sessions, by peer id. */
const fgPeers = new Map<string, Conn>();
/** M10: rm could not stop the worker: its worktree is not cleaned up. */
const workerAlive = new Set<string>();
/** M9: jobs being removed (their end is reported as a removal, once). */
const removing = new Set<string>();
const messageLimiter = new RateLimiter(MESSAGES_PER_MINUTE);
const spawnLimiter = new RateLimiter(SPAWNS_PER_MINUTE);

function persistRoster(): void {
	const obj: Record<string, HostRef> = {};
	for (const [id, ref] of roster) obj[id] = ref;
	try {
		writeJsonAtomic(rosterPath(), obj);
	} catch (err) {
		log("error", "roster write failed", { error: String(err) });
	}
}

function hostGone(ref: HostRef): boolean {
	if (!isAlive(ref.hostPid)) return true;
	return ref.hostToken ? !sameProcess(ref.hostPid, ref.hostToken) : false;
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
		context: rec.kind === "shell" ? null : contextFrom(st.context),
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
		worktree: rec.worktree ? { path: rec.worktree.path, branch: rec.worktree.branch } : null,
		...(Array.isArray(st.prs) && st.prs.length > 0 ? { prs: st.prs as PrInfo[] } : {}),
	};
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
	for (const c of conns) if (c.subscribed) send(c, event);
}

function pushJob(id: string): void {
	const job = rowOf(id);
	if (job) push({ event: "job", job });
}

/** rm: stop the job, drop its records, then its worktree when that holds no work (M10). */
async function removeRecord(id: string): Promise<{ id: string; worktree?: CleanupResult }> {
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
	recs.delete(id);
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
	if (!rec || rec.kind === "shell" || roster.has(id) || starting.has(id) || respawning.has(id) || stopping.has(id) || removing.has(id)) return false;
	const st = readState(id);
	if (!st || typeof st.endedAt !== "number" || now - st.endedAt < days * DAY_MS) return false;
	if (st.pinned === true || st.state === "blocked" || pendingReplies(id).length > 0 || heldReports(id).length > 0) return false;
	return ![...recs.values()].some((r) => r.parentSession === rec.sessionFile && roster.has(r.id));
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
			await removeRecord(id).catch((err: unknown) => log("warn", "cleanup failed", { id, error: String(err) }));
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
	// M9: the daemon, not the worker, decided how this run ended
	let daemonEnded = false;
	if (recs.get(id)?.kind === "shell") {
		// DI-6: stopped, or the command's exit status; the row goes away a while later
		if (stopReq) patch.state = "stopped";
		else {
			patch.state = ex && ex.code === 0 ? "done" : "failed";
			if (patch.state === "failed") patch.error = ex ? `exited with code ${ex.code}${ex.signal ? ` (${ex.signal})` : ""}` : "host vanished";
		}
		patch.removeAt = now + SHELL_KEEP_MS;
		// the host flushed its screen on exit: the last output line is the result
		const line = lastScreenLine(id);
		if (line) patch.summary = line;
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
			} else {
				patch.state = "stopped";
				patch.error = "ended while the background service was off";
			}
		}
	} else if (!ex) {
		patch.state = "failed";
		patch.error = "host vanished";
		daemonEnded = true;
	} else if (ex.code !== 0) {
		// DM-5: one automatic restart for a worker that crashed mid-run
		const restarts = typeof st.crashRestarts === "number" ? st.crashRestarts : 0;
		restart = st.state === "working" && restarts < 1;
		daemonEnded = !restart;
		patch.state = "failed";
		if (!st.error) patch.error = `worker exited with code ${ex.code}${ex.signal ? ` (${ex.signal})` : ""}`;
	} else if (st.state === "failed" || (st.state === "blocked" && st.waitingFor === "question")) {
		// The worker's last word stands for a failed turn or an open question (answered
		// by restarting the session); a dialog or a missing first prompt dies with it.
		patch.state = st.state;
	} else patch.state = "done";
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
	if (restart && !shuttingDown) {
		void respawn(id, { prompt: CONTINUE, crash: true }).catch((err: unknown) =>
			log("error", "crash restart failed", { id, error: String(err) }),
		);
	}
	if (daemonEnded && !shuttingDown && recs.get(id)?.parentSession) {
		const why = removing.has(id) ? "removed by the user" : patch.state === "stopped" ? "stopped" : `failed: ${patch.error ?? st.error ?? "unknown"}`;
		// a removal cleans the worktree up at the same time: its state would be stale
		const body = reportBody({ state: "ended", error: why });
		void (removing.has(id) ? Promise.resolve(body) : withWorktreeLine(id, body)).then((b) => routeReport(id, b));
	}
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
	const saved = readJson<Record<string, HostRef>>(rosterPath()) ?? {};
	for (const [id, ref] of Object.entries(saved)) {
		if (!recs.has(id) || typeof ref?.hostPid !== "number") continue;
		if (ref.hostToken && sameProcess(ref.hostPid, ref.hostToken)) {
			roster.set(id, { hostPid: ref.hostPid, hostToken: ref.hostToken });
			log("info", "re-adopted", { id, hostPid: ref.hostPid });
		} else finalize(id, "host gone at startup", { startup: true });
	}
	for (const id of recs.keys()) {
		const st = readState(id);
		if (st && st.endedAt === undefined && !roster.has(id)) finalize(id, "orphaned", { startup: true });
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
	for (const k of Object.keys(env)) if (k.startsWith("PI_JOB_")) delete env[k];
	delete env.PI_DAEMON_SOCK;
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

async function dispatch(a: DispatchArgs, extra: Partial<JobRecord> = {}): Promise<{ id: string; name: string }> {
	if (!a || typeof a !== "object") throw new OpError("bad_request", "missing args");
	if (!str(a.cwd) || !isAbsolute(a.cwd) || !isDir(a.cwd)) throw new OpError("bad_request", `cwd is not a directory: ${a.cwd}`);
	if (!Array.isArray(a.command) || a.command.length === 0 || !a.command.every(str)) {
		throw new OpError("bad_request", "command must be a non-empty array of strings");
	}
	const shell = a.kind === "shell";
	if (!shell && (!str(a.sessionFile) || !isAbsolute(a.sessionFile))) throw new OpError("bad_request", "sessionFile must be an absolute path");
	const env: Record<string, string> = {};
	if (a.env && typeof a.env === "object") {
		for (const [k, v] of Object.entries(a.env)) if (typeof v === "string") env[k] = v;
	}
	// before the lock and roster checks: nothing may await between them and recs.set
	let worktree: WorktreeInfo | undefined;
	if (a.worktree !== undefined) {
		if (shell) throw new OpError("bad_request", "shell jobs run without a worktree");
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

	let id = newJobId();
	while (recs.has(id)) id = newJobId();
	const base = str(a.name) ? a.name : id;
	// M22: a job this one takes the session from gives up its name (one row per session)
	const taken = new Set([...recs.values()].filter((r) => !(!shell && foldsInto(r, a.sessionFile)) && !hiddenJob(r.id)).map((r) => r.name));
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
		env,
		...(str(a.model) ? { model: a.model } : {}),
		...(str(a.thinking) ? { thinking: a.thinking } : {}),
		...(str(a.agent) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(a.agent) ? { agent: a.agent } : {}),
		...(a.workspaceEnv === "shell" || a.workspaceEnv === "direnv" ? { workspaceEnv: a.workspaceEnv } : {}),
		...(Array.isArray(a.envDeny) ? { envDeny: a.envDeny.filter((d): d is string => typeof d === "string" && d !== "").slice(0, 256) } : {}),
		...(Array.isArray(a.envForce) ? { envForce: a.envForce.filter((d): d is string => typeof d === "string" && d !== "").slice(0, 256) } : {}),
		origin,
		createdAt: now,
		...(str(a.piVersion) ? { piVersion: a.piVersion } : {}),
		roostVersion: ROOST_VERSION,
		...(worktree ? { worktree } : {}),
		...extra,
	};
	createJob(rec, { state: "working", startedAt: now, updatedAt: now, jobToken: newToken(), ...(shell ? { status: "busy" } : {}) });
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
	if (!shell) supersedeOthers(id);
	if (!shell) pushChildrenOf(rec.sessionFile); // M13: an adopted session's children have a parent row now
	return { id, name };
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
		ref.hostToken = processStartToken(hostPid) ?? "";
		if (!ref.hostToken) await sleep(20);
	}
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
async function respawn(
	id: string,
	opts: { prompt?: string; crash?: boolean; restart?: boolean } = {},
): Promise<{ id: string; started: boolean }> {
	const rec = recs.get(id);
	if (!rec) throw new OpError("not_found", `no such job: ${id}`);
	if (starting.has(id) || respawning.has(id)) return { id, started: false };
	respawning.add(id);
	try {
		const shell = rec.kind === "shell";
		let prompt = shell ? undefined : opts.prompt;
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
		const command = respawnCommand(rec, written, prompt, { model: st?.model ?? rec.model, thinking: st?.thinking ?? rec.thinking });
		const now = Date.now();
		// nothing new to do: the worker shows where the session left off, so keep the row as is
		const restore = written && !prompt && pendingReplies(id).length === 0 && st?.state !== "working";
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
			command,
			restore,
			crashRestarts: opts.crash ? (typeof st?.crashRestarts === "number" ? st.crashRestarts : 0) + 1 : 0,
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
				removeJob(id);
				log("info", "shell job expired", { id });
				push({ event: "removed", id });
			}
			shellPids.delete(id);
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
	from?: string;
	relation?: Relation;
}

const isAgentItem = (r: PendingReply) => r.kind === "message" || r.kind === "report";

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
	updateState(id, {
		pendingReplies: pendingReplies(id).filter((r) => (exact ? r.seq !== acked : r.seq > acked || isAgentItem(r))),
	});
}

function deliverEvent(id: string, r: PendingReply): Event {
	return {
		event: "deliver",
		id,
		seq: r.seq,
		text: r.text,
		...(r.kind ? { kind: r.kind } : {}),
		...(r.from ? { from: r.from } : {}),
		...(r.relation ? { relation: r.relation } : {}),
	};
}

async function reply(
	args: { id?: unknown; text?: unknown } | undefined,
): Promise<{ delivered: boolean; saved: boolean; stopped?: boolean; respawned?: boolean; error?: string }> {
	const id = requireJob(args);
	const text = typeof args?.text === "string" ? args.text.trim() : "";
	if (!text) throw new OpError("bad_request", "empty reply");
	const live = roster.has(id);
	if (text === "/stop") {
		if (live) await terminateHost(id);
		return { delivered: live, saved: false, stopped: live };
	}
	if (text.startsWith("!")) throw new OpError("unsupported", "shell commands in replies are not supported yet; attach to run them");
	if (recs.get(id)?.kind === "shell") throw new OpError("unsupported", "a shell job takes no replies; attach to type into it");
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
	updateState(id, { replySeq: seq, pendingReplies: [...pending, { seq, text }] });
	if (connected) {
		send(conn!, { event: "deliver", id, seq, text });
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
		// a rename the session has not taken yet keeps the daemon's name
		displayName: str(st.pendingName) && opt(r.name, 200) !== st.pendingName ? st.pendingName : opt(r.name, 200),
		...(str(st.pendingName) && opt(r.name, 200) === st.pendingName ? { pendingName: null } : {}),
		model: opt(r.model, 200),
		// M8: workers before 0.1.5 send neither; keep what is known then
		...(r.thinking !== undefined ? { thinking: opt(r.thinking, 20) } : {}),
		...(r.context !== undefined ? { context: contextFrom(r.context) } : {}),
		// M11: a phone using the session keeps it from being reaped (never in the future)
		...(typeof r.remoteAt === "number" && Number.isFinite(r.remoteAt) ? { remoteAt: Math.min(r.remoteAt, Date.now()) } : {}),
		reportedAt: Date.now(),
		attachSignal: r.attachSignal === true,
		attachRepaint: r.attachRepaint === true,
		// M16: links only grow (a respawned worker starts with none)
		...(Array.isArray(r.prLinks) ? { prLinks: mergeLinks(st.prLinks, r.prLinks) } : {}),
		// a turn that ends normally clears the crash budget (DM-5)
		// (only once the worker has stayed up a while, so a crash loop stays bounded)
		...(r.state !== "working" && Date.now() - (typeof st.restartedAt === "number" ? st.restartedAt : 0) > CRASH_RESET_MS
			? { crashRestarts: 0 }
			: {}),
	});
	if (before !== r.state) log("info", "state", { id, from: before, to: r.state, waitingFor: r.waitingFor ?? null });
	pushJob(id);
	// M13: a subagent that finished closes (each report while done and idle starts the wait again)
	if (r.state === "done" && r.status === "idle" && recs.get(id)?.parentSession) scheduleAutoClose(id);
}

/** AV-K10: the row's name, the job's name for `attach <name>`, and the live session's name. */
function rename(args: { id?: unknown; name?: unknown } | undefined): { id: string; name: string } {
	const id = requireJob(args);
	const name = typeof args?.name === "string" ? args.name.replace(/\s+/g, " ").trim().slice(0, 200) : "";
	if (!name) throw new OpError("bad_request", "empty name");
	const rec = recs.get(id)!;
	const next = { ...rec, name };
	writeJsonAtomic(`${jobDirOf(id)}/job.json`, next);
	recs.set(id, next);
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
	const external = loadUserConfig().agentExternalMessages;
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
	const byName = rows.filter((r) => r.name === to && r.relation !== "external");
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
	if (!messageLimiter.take(me)) throw new OpError("rate_limited", `at most ${MESSAGES_PER_MINUTE} messages a minute`);
	// the receiver sees the sender from its own side of the tree
	const relation = relationOf(treeNode(target.key), treeNode(me));
	const from = peerName(peer);
	const text = envelope({ from, id: peer.id, relation, kind: "message", body: message });
	const r = await deliverAgent(target.key, "message", text, { from, relation });
	log("info", "agent message", { from: peer.id, to: r.id || target.id, outcome: r.outcome });
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
	if (!recs.get(id)?.parentSession || !loadUserConfig().subagentAutoClose) return;
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
	clearInterval(watcher);
	clearInterval(shellWatcher);
	clearInterval(reaper);
	if (!keepWorkers) {
		const ids = [...roster.keys()];
		await Promise.all(ids.map((id) => terminateHost(id)));
		await waitGone(ids, WAIT_MS);
	}
	persistRoster();
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
		const result = await handle(conn, msg!.op, msg!.args);
		send(conn, { id: reqId, ok: true, result });
	} catch (err) {
		const e = err as Partial<OpError> & Error;
		if (!(err instanceof OpError)) log("error", "op failed", { op: msg!.op, error: String(e?.stack ?? err) });
		send(conn, { id: reqId, ok: false, error: e?.message ?? String(err), code: e?.code ?? "internal" });
	}
}

loadJobs();

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
const shellWatcher = setInterval(shellTick, 2000);
shellWatcher.unref();
const reaper = setInterval(
	() => {
		void reapIdle().catch((err: unknown) => log("error", "reap failed", { error: String(err) }));
		void cleanupOld().catch((err: unknown) => log("error", "cleanup failed", { error: String(err) }));
		void pollPrs().catch((err: unknown) => log("error", "pull request poll failed", { error: String(err) }));
	},
	Number(process.env.PI_ROOST_REAP_CHECK_MS) || REAP_CHECK_MS,
);
process.on("SIGTERM", () => void shutdown(true));
process.on("SIGINT", () => void shutdown(true));
log("info", "started", { pid: process.pid, version: ROOST_VERSION, socket: daemonSocketPath(), ptyError, jobs: recs.size, live: roster.size });
