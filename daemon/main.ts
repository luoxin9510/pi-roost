import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { isAbsolute } from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic.ts";
import { hostEntry } from "../lib/client.ts";
import { hostControl } from "../lib/hostclient.ts";
import { newJobId, newToken } from "../lib/ids.ts";
import { acquireDaemonLock, readWriterLock, releaseDaemonLock } from "../lib/locks.ts";
import { daemonLogPath, daemonSocketPath, ensureDirs, rosterPath, runtimeDir } from "../lib/paths.ts";
import { isAlive, processStartToken, sameProcess } from "../lib/proc.ts";
import {
	type DaemonStatus,
	type DispatchArgs,
	type Event,
	type JobRow,
	LineReader,
	type WorkerReport,
	encodeLine,
} from "../lib/protocol.ts";
import {
	type JobRecord,
	type JobState,
	createJob,
	listJobIds,
	readExit,
	readJob,
	readState,
	removeJob,
	updateState,
} from "../lib/store.ts";
import { ROOST_VERSION } from "../lib/version.ts";

const WAIT_MS = 6000;

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
const conns = new Set<Conn>();

interface Conn {
	sock: Socket;
	subscribed: boolean;
}

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

function rowOf(id: string): JobRow | undefined {
	const rec = recs.get(id);
	const st = readState(id);
	if (!rec || !st) return undefined;
	const live = roster.has(id);
	const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
	return {
		id,
		cwd: rec.cwd,
		kind: "pi",
		startedAt: st.startedAt,
		state: st.state,
		pid: live ? (st.workerPid ?? null) : null,
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
		error: text(st.error),
	};
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

function finalize(id: string, why: string): void {
	roster.delete(id);
	starting.delete(id);
	const st = readState(id);
	if (!st) {
		persistRoster();
		return;
	}
	const ex = readExit(id);
	const stopReq = stopping.has(id) || st.stopRequested === true;
	const patch: Partial<JobState> = { endedAt: Date.now(), status: null, waitingFor: null, tool: null };
	if (stopReq) patch.state = "stopped";
	else if (!ex) {
		patch.state = "failed";
		patch.error = "host vanished";
	} else if (ex.code !== 0) {
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
	log("info", "finalize", { id, why, state: patch.state, exit: ex ?? null });
	pushJob(id);
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
		} else finalize(id, "host gone at startup");
	}
	for (const id of recs.keys()) {
		const st = readState(id);
		if (st && (st.state === "working" || st.state === "blocked") && !roster.has(id)) finalize(id, "orphaned");
	}
	persistRoster();
}

async function terminateHost(id: string): Promise<void> {
	const ref = roster.get(id);
	if (!ref) return;
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

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

async function dispatch(a: DispatchArgs): Promise<{ id: string; name: string }> {
	if (!a || typeof a !== "object") throw new OpError("bad_request", "missing args");
	if (!str(a.cwd) || !isAbsolute(a.cwd) || !isDir(a.cwd)) throw new OpError("bad_request", `cwd is not a directory: ${a.cwd}`);
	if (!Array.isArray(a.command) || a.command.length === 0 || !a.command.every(str)) {
		throw new OpError("bad_request", "command must be a non-empty array of strings");
	}
	if (!str(a.sessionFile) || !isAbsolute(a.sessionFile)) throw new OpError("bad_request", "sessionFile must be an absolute path");
	const env: Record<string, string> = {};
	if (a.env && typeof a.env === "object") {
		for (const [k, v] of Object.entries(a.env)) if (typeof v === "string") env[k] = v;
	}
	const holder = readWriterLock(a.sessionFile);
	if (holder) throw new OpError("locked", `session is in use by pid ${holder.pid}`);
	for (const id of roster.keys()) {
		if (recs.get(id)?.sessionFile === a.sessionFile) {
			throw new OpError("locked", `session is already running as job ${id}`);
		}
	}

	let id = newJobId();
	while (recs.has(id)) id = newJobId();
	const base = str(a.name) ? a.name : id;
	const taken = new Set([...recs.values()].map((r) => r.name));
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;

	const now = Date.now();
	const origin = a.origin === "bg" || a.origin === "adopt" || a.origin === "fork" ? a.origin : "dispatch";
	const rec: JobRecord = {
		id,
		name,
		cwd: a.cwd,
		sessionFile: a.sessionFile,
		command: a.command,
		env,
		...(str(a.model) ? { model: a.model } : {}),
		...(str(a.thinking) ? { thinking: a.thinking } : {}),
		origin,
		createdAt: now,
		...(str(a.piVersion) ? { piVersion: a.piVersion } : {}),
		roostVersion: ROOST_VERSION,
	};
	createJob(rec, { state: "working", startedAt: now, updatedAt: now, jobToken: newToken() });
	recs.set(id, rec);
	starting.add(id);
	let hostPid: number;
	try {
		hostPid = spawnHost(rec);
	} catch (err) {
		starting.delete(id);
		recs.delete(id);
		removeJob(id);
		throw err;
	}
	const ref: HostRef = { hostPid, hostToken: "" };
	roster.set(id, ref);
	for (let i = 0; i < 25 && !ref.hostToken; i++) {
		ref.hostToken = processStartToken(hostPid) ?? "";
		if (!ref.hostToken) await sleep(20);
	}
	try {
		updateState(id, { hostPid, hostToken: ref.hostToken });
	} catch {}
	persistRoster();
	starting.delete(id);
	log("info", "dispatch", { id, name, cwd: rec.cwd, hostPid, origin });
	pushJob(id);
	checkHosts();
	return { id, name };
}

function resolve(query: unknown): string {
	if (!str(query)) throw new OpError("bad_request", "query required");
	if (recs.has(query)) return query;
	const byPrefix = [...recs.keys()].filter((id) => id.startsWith(query));
	if (byPrefix.length === 1) return byPrefix[0]!;
	const q = query.toLowerCase();
	const matches = byPrefix.length > 1 ? byPrefix : [...recs.values()].filter((r) => r.name.toLowerCase().includes(q)).map((r) => r.id);
	if (matches.length === 1) return matches[0]!;
	if (matches.length === 0) throw new OpError("not_found", `no job matches "${query}"`);
	const list = matches.map((id) => `${id} · ${recs.get(id)!.name}`).join(", ");
	throw new OpError("ambiguous", `"${query}" is ambiguous: ${list}`);
}

const REPORT_STATES = new Set(["working", "blocked", "done", "failed"]);
const REPORT_STATUS = new Set(["busy", "waiting", "idle"]);
const REPORT_WAITING = new Set([null, "dialog", "question", "first-prompt"]);

function acceptReport(args: { id?: unknown; token?: unknown; report?: Partial<WorkerReport> } | undefined): void {
	const id = args?.id;
	if (!str(id) || !recs.has(id)) throw new OpError("not_found", `no such job: ${String(id)}`);
	const st = readState(id);
	if (!st || !str(args?.token) || st.jobToken !== args.token) throw new OpError("unauthorized", "bad job token");
	if (!roster.has(id) || stopping.has(id)) return; // ended or being stopped: the daemon owns the state now
	const r = args.report;
	if (!r || !REPORT_STATES.has(r.state as string) || !REPORT_STATUS.has(r.status as string)) {
		throw new OpError("bad_request", "invalid report");
	}
	const opt = (v: unknown, max = 500) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
	const before = st.state;
	updateState(id, {
		state: r.state,
		status: r.status,
		waitingFor: REPORT_WAITING.has(r.waitingFor ?? null) ? (r.waitingFor ?? null) : null,
		summary: opt(r.summary),
		question: opt(r.question, 2000),
		choices: Array.isArray(r.choices) ? r.choices.filter(str).slice(0, 20).map((c) => c.slice(0, 200)) : [],
		tool: opt(r.tool, 100),
		error: opt(r.error, 1000),
		displayName: opt(r.name, 200),
		model: opt(r.model, 200),
		reportedAt: Date.now(),
	});
	if (before !== r.state) log("info", "state", { id, from: before, to: r.state, waitingFor: r.waitingFor ?? null });
	pushJob(id);
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

let server: Server;
let shuttingDown = false;

async function shutdown(keepWorkers: boolean): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log("info", "shutdown", { keepWorkers });
	clearInterval(watcher);
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
		case "rm": {
			const id = requireJob(args);
			if (roster.has(id)) {
				await terminateHost(id);
				if (!(await waitGone([id], WAIT_MS))) {
					const ref = roster.get(id);
					log("warn", "host did not stop, killing", { id });
					const st = readState(id);
					for (const pid of [st?.workerPid, ref?.hostPid]) {
						if (typeof pid !== "number") continue;
						try {
							process.kill(pid, "SIGKILL");
						} catch {}
					}
					await waitGone([id], 2000);
					if (roster.has(id)) finalize(id, "killed by rm");
				}
			}
			recs.delete(id);
			stopping.delete(id);
			removeJob(id);
			log("info", "rm", { id });
			push({ event: "removed", id });
			return { id };
		}
		case "report":
			acceptReport(args);
			return {};
		case "shutdown":
			setTimeout(() => void shutdown(!!args?.keepWorkers), 20);
			return {};
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
	sock.on("close", () => conns.delete(conn));
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
process.on("SIGTERM", () => void shutdown(true));
process.on("SIGINT", () => void shutdown(true));
log("info", "started", { pid: process.pid, version: ROOST_VERSION, socket: daemonSocketPath(), ptyError, jobs: recs.size, live: roster.size });
