import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonError } from "../lib/client.ts";
import { daemonSocketPath, jobDir } from "../lib/paths.ts";
import { isAlive, processStartToken } from "../lib/proc.ts";
import type { Event, JobRow } from "../lib/protocol.ts";
import { acquireWriterLock, releaseWriterLock } from "../lib/locks.ts";
import { listJobIds, readJob, readState } from "../lib/store.ts";

const DAEMON = resolve("daemon/main.ts");
const HOST = resolve("host/main.ts");

let home: string;
let rt: string;
let work: string;
let daemons: ChildProcess[] = [];
let clients: DaemonClient[] = [];
let extra: ChildProcess[] = [];
const saved = {
	home: process.env.PI_ROOST_HOME,
	rt: process.env.PI_ROOST_RUNTIME_DIR,
	host: process.env.PI_ROOST_HOST_ENTRY,
};

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeout = 10000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-d-"));
	rt = mkdtempSync("/tmp/rt-");
	work = mkdtempSync(join(tmpdir(), "roost-w-"));
	process.env.PI_ROOST_HOME = home;
	process.env.PI_ROOST_RUNTIME_DIR = rt;
	process.env.PI_ROOST_HOST_ENTRY = HOST;
	process.env.PI_ROOST_CONFIG_DIR = home; // never the user's real settings
});

afterEach(() => {
	for (const c of clients) c.close();
	for (const id of listJobIds()) {
		const pid = readState(id)?.hostPid;
		if (pid && isAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
	for (const p of [...daemons, ...extra]) if (p.exitCode === null) p.kill("SIGKILL");
	clients = [];
	daemons = [];
	extra = [];
	rmSync(home, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
	for (const [k, v] of [
		["PI_ROOST_HOME", saved.home],
		["PI_ROOST_RUNTIME_DIR", saved.rt],
		["PI_ROOST_HOST_ENTRY", saved.host],
		["PI_ROOST_CONFIG_DIR", undefined],
		["PI_ROOST_REAP_MINUTES", undefined],
		["PI_ROOST_SCHEDULE_TICK_MS", undefined],
		["PI_ROOST_AUTO_CLOSE_MS", undefined],
		["PI_ROOST_RESUME_DELAYS_MS", undefined],
		["PI_ROOST_REAP_CHECK_MS", undefined],
		["PI_ROOST_SHELL_KEEP_MS", undefined],
		["PI_ROOST_CLEANUP_DAYS", undefined],
		["PI_ROOST_CLEANUP_CHECK_MS", undefined],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

async function startDaemon(): Promise<{ proc: ChildProcess; client: DaemonClient }> {
	const proc = spawn(process.execPath, [DAEMON], { stdio: "ignore", env: process.env });
	daemons.push(proc);
	const client = await waitFor(async () => {
		try {
			const c = await DaemonClient.connect();
			await c.request("ping", {});
			return c;
		} catch {
			return undefined;
		}
	});
	clients.push(client);
	return { proc, client };
}

let seq = 0;
function args(script: string, over: Record<string, unknown> = {}) {
	return {
		cwd: work,
		sessionFile: join(work, `s${seq++}.jsonl`),
		command: ["/bin/sh", "-c", script],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name: "job",
		origin: "dispatch" as const,
		...over,
	};
}

const find = async (c: DaemonClient, id: string): Promise<JobRow | undefined> =>
	(await c.request("list", {})).jobs.find((j) => j.id === id);

const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

describe("daemon", () => {
	it("dispatches a job, lists it working, then done; events are pushed", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		await client.request("subscribe", {});
		client.onEvent((e) => events.push(e));
		const { id, name } = await client.request("dispatch", args("sleep 0.5; echo hi; sleep 1", { name: "first" }));
		expect(name).toBe("first");
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(row.state).toBe("working");
		expect(row.kind).toBe("pi");
		const done = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "done" ? r : undefined;
		});
		expect(done.endedAt).toBeTypeOf("number");
		expect(done.pid).toBeNull();
		const states = events.filter((e) => e.event === "job" && e.job.id === id).map((e) => (e as { job: JobRow }).job.state);
		expect(states[0]).toBe("working");
		expect(states.at(-1)).toBe("done");
	});

	it("stops a long job, then rm removes it and its directory", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		await client.request("subscribe", {});
		client.onEvent((e) => events.push(e));
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("stop", { id });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "stopped" ? r : undefined;
		});
		expect(row.endedAt).toBeTypeOf("number");
		await client.request("stop", { id });
		await client.request("rm", { id });
		expect(await find(client, id)).toBeUndefined();
		expect(existsSync(jobDir(id))).toBe(false);
		expect(events).toContainEqual({ event: "removed", id });
		await expect(client.request("stop", { id })).rejects.toMatchObject({ code: "not_found" });
	});

	it("rejects locked sessions and duplicate live sessionFiles", async () => {
		const { client } = await startDaemon();
		const holder = spawn("sleep", ["10"], { stdio: "ignore" });
		extra.push(holder);
		const token = await waitFor(() => processStartToken(holder.pid!));
		const sessionFile = join(work, "locked.jsonl");
		writeFileSync(`${sessionFile}.lock`, JSON.stringify({ pid: holder.pid, token, at: Date.now() }));
		const err = (await client.request("dispatch", args("sleep 1", { sessionFile })).catch((e) => e)) as DaemonError;
		expect(err.code).toBe("locked");
		expect(err.message).toContain(String(holder.pid));

		const shared = join(work, "shared.jsonl");
		await client.request("dispatch", args("sleep 30", { sessionFile: shared }));
		await expect(client.request("dispatch", args("sleep 30", { sessionFile: shared }))).rejects.toMatchObject({
			code: "locked",
		});
	});

	it("validates dispatch args", async () => {
		const { client } = await startDaemon();
		await expect(client.request("dispatch", args("true", { cwd: join(work, "nope") }))).rejects.toMatchObject({ code: "bad_request" });
		await expect(client.request("dispatch", args("true", { command: [] }))).rejects.toMatchObject({ code: "bad_request" });
		await expect(client.request("dispatch", args("true", { sessionFile: "rel.jsonl" }))).rejects.toMatchObject({
			code: "bad_request",
		});
	});

	it("de-duplicates names", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 30", { name: "dup" }));
		const b = await client.request("dispatch", args("sleep 30", { name: "dup" }));
		const c = await client.request("dispatch", args("sleep 30", { name: "dup" }));
		expect([a.name, b.name, c.name]).toEqual(["dup", "dup (2)", "dup (3)"]);
	});

	it("resolves by prefix and name substring, reports ambiguity", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 30", { name: "Alpha build" }));
		const b = await client.request("dispatch", args("sleep 30", { name: "alpha test" }));
		const c = await client.request("dispatch", args("sleep 30", { name: "gamma" }));
		expect((await client.request("resolve", { query: a.id.slice(0, 6) })).id).toBe(a.id);
		expect((await client.request("resolve", { query: a.id })).id).toBe(a.id);
		expect((await client.request("resolve", { query: "GAMM" })).id).toBe(c.id);
		const err = (await client.request("resolve", { query: "alpha" }).catch((e) => e)) as DaemonError;
		expect(err.code).toBe("ambiguous");
		expect(err.message).toContain(a.id);
		expect(err.message).toContain(b.id);
		await expect(client.request("resolve", { query: "zzzz" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("keeps workers across a daemon restart (DM-6)", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		expect(existsSync(daemonSocketPath())).toBe(false);
		expect(isAlive(hostPid)).toBe(true);

		const second = await startDaemon();
		const row = await find(second.client, id);
		expect(row?.state).toBe("working");
		expect(row?.pid).toBeTypeOf("number");
		await second.client.request("stop", { id });
		await waitFor(async () => (await find(second.client, id))?.state === "stopped");
	});

	it("finalizes jobs whose host died while the daemon was down (autoResume crash)", async () => {
		writeFileSync(join(home, "roost.json"), JSON.stringify({ autoResume: "crash" }));
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		process.kill(hostPid, "SIGKILL");
		const second = await startDaemon();
		const row = await find(second.client, id);
		// DM-7: recent progress → failed, resumable
		expect(row?.state).toBe("failed");
		expect(readState(id)?.error).toMatch(/machine restart/);
	});

	it("DM-7: a run whose last progress is older than 48 h shows as stopped", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		process.kill(hostPid, "SIGKILL");
		const old = Date.now() - 49 * 3600_000;
		const statePath = join(jobDir(id), "state.json");
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(statePath, JSON.stringify({ ...st, reportedAt: old, updatedAt: old }));
		const second = await startDaemon();
		expect((await find(second.client, id))?.state).toBe("stopped");
		expect(readState(id)?.error).toBe("ended while the background service was off");
	});

	it("M15: records of sessions ended long ago are removed; pinned and recent ones stay", async () => {
		process.env.PI_ROOST_CLEANUP_DAYS = "1";
		process.env.PI_ROOST_CLEANUP_CHECK_MS = "1";
		process.env.PI_ROOST_REAP_CHECK_MS = "150";
		const { client } = await startDaemon();
		const ids: string[] = [];
		for (const name of ["old", "pinned", "recent"]) ids.push((await client.request("dispatch", args("true", { name }))).id);
		await waitFor(async () => {
			const jobs = (await client.request("list", { all: true })).jobs;
			return ids.every((id) => jobs.find((j) => j.id === id)?.endedAt);
		});
		const old = Date.now() - 3 * 24 * 3600_000;
		for (const [i, id] of ids.entries()) {
			if (i === 2) continue;
			const statePath = join(jobDir(id), "state.json");
			const st = JSON.parse(readFileSync(statePath, "utf8"));
			writeFileSync(statePath, JSON.stringify({ ...st, endedAt: old, ...(i === 1 ? { pinned: true } : {}) }));
		}
		await waitFor(async () => !(await client.request("list", { all: true })).jobs.some((j) => j.id === ids[0]));
		const left = (await client.request("list", { all: true })).jobs.map((j) => j.id);
		expect(left).toContain(ids[1]);
		expect(left).toContain(ids[2]);
		expect(existsSync(jobDir(ids[0]!))).toBe(false);
	});

	it("shutdown without keepWorkers terminates hosts", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		await first.client.request("shutdown", {});
		await waitFor(() => exited(first.proc));
		expect(isAlive(hostPid)).toBe(false);
		expect(readState(id)?.state).toBe("stopped");
	});

	it("a second daemon exits 0 and leaves the first alone", async () => {
		const first = await startDaemon();
		const second = spawn(process.execPath, [DAEMON], { stdio: "ignore", env: process.env });
		daemons.push(second);
		await waitFor(() => exited(second));
		expect(second.exitCode).toBe(0);
		expect(exited(first.proc)).toBe(false);
		const pong = await first.client.request("ping", {});
		expect(pong.pid).toBe(first.proc.pid);
		const st = await first.client.request("status", {});
		expect(st.pid).toBe(first.proc.pid);
		expect(st.ptyError).toBeNull();
	});

	it("survives garbage lines", async () => {
		const { proc, client } = await startDaemon();
		mkdirSync(rt, { recursive: true });
		const sock = createConnection(daemonSocketPath());
		const lines: string[] = [];
		sock.on("data", (d) => lines.push(...d.toString().split("\n").filter(Boolean)));
		await new Promise((r) => sock.once("connect", r));
		sock.write("{not json\n\n[1,2]\n{\"id\":7}\n{\"id\":8,\"op\":\"nope\"}\n");
		await waitFor(() => lines.length >= 2);
		sock.destroy();
		const msgs = lines.map((l) => JSON.parse(l));
		expect(msgs.map((m) => m.code)).toEqual(["bad_request", "bad_request"]);
		expect(exited(proc)).toBe(false);
		await client.request("ping", {});
	});
});

describe("worker reports", () => {
	const report = (over: Record<string, unknown> = {}) => ({
		state: "blocked" as const,
		status: "waiting" as const,
		waitingFor: "question" as const,
		summary: "double-ended or single-ended reset?",
		question: "double-ended or single-ended reset?",
		choices: ["double", "single"],
		tool: null,
		error: null,
		name: "reset question",
		model: "x/y",
		...over,
	});

	it("accepts a report with the job token and shows it in the row", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await expect(client.request("report", { id, token: "nope", report: report() })).rejects.toMatchObject({ code: "unauthorized" });
		await client.request("report", { id, token, report: report() });
		const row = (await find(client, id))!;
		expect(row).toMatchObject({
			state: "blocked",
			status: "waiting",
			waitingFor: "question",
			summary: "double-ended or single-ended reset?",
			choices: ["double", "single"],
			name: "reset question",
			model: "x/y",
		});
		await expect(client.request("report", { id, token, report: report({ state: "bogus" }) })).rejects.toMatchObject({
			code: "bad_request",
		});
	});

	it("M24: takes the session's usage, validates it, and keeps it when a report has none", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 1.25, today: 0.5, day: 1, sub: false, models: { "a/b": { cost: 1.25, tokens: 30 } } };
		await client.request("report", { id, token, report: { ...report(), usage } });
		expect((await find(client, id))?.usage).toEqual(usage);
		await client.request("report", { id, token, report: report() });
		expect((await find(client, id))?.usage?.cost).toBe(1.25);
		await client.request("report", { id, token, report: { ...report(), usage: { cost: "x", models: [] } as never } });
		expect((await find(client, id))?.usage).toMatchObject({ cost: 0, sub: false });
	});

	it("M26: a dispatch's fan-out id reaches its row; a malformed one is dropped", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", { ...args("sleep 30"), fanout: "fabc123" });
		expect((await find(client, id))?.fanout).toBe("fabc123");
		expect((await find(client, id))?.profile).toBe("pi"); // M29
		const bad = await client.request("dispatch", { ...args("sleep 30"), fanout: "../../x" });
		expect((await find(client, bad.id))?.fanout).toBeNull();
	});

	it("M8: takes thinking and context use, validates them, and keeps them when a report has neither", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		const context = { tokens: 86_000, window: 200_000, percent: 43 };
		await client.request("report", { id, token, report: report({ thinking: "high", context }) });
		expect(await find(client, id)).toMatchObject({ model: "x/y", thinking: "high", context });
		// a worker before 0.1.5 sends neither field: the last known values stay
		await client.request("report", { id, token, report: report() });
		expect(await find(client, id)).toMatchObject({ thinking: "high", context });
		// garbage is dropped, not stored
		await client.request("report", { id, token, report: report({ context: { tokens: "lots", window: -1 } }) });
		expect((await find(client, id))?.context).toBeNull();
		await client.request("report", { id, token, report: report({ context: { tokens: null, window: 200_000, percent: null } }) });
		expect((await find(client, id))?.context).toEqual({ tokens: null, window: 200_000, percent: null });
	});

	it("keeps the last reported state when the worker exits cleanly, clears live fields", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 1.5"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await client.request("report", { id, token, report: report() });
		const ended = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt ? r : undefined;
		});
		expect(ended.state).toBe("blocked");
		expect(ended.status).toBeNull();
		expect(ended.waitingFor).toBeNull();
		expect(ended.summary).toBe("double-ended or single-ended reset?");
	});

	it("a non-zero exit is failed even after a done report; stop wins over reports", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 1; exit 3"));
		const b = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, a.id))?.pid && (await find(client, b.id))?.pid);
		const done = report({ state: "done", status: "idle", waitingFor: null, question: null, choices: [] });
		await client.request("report", { id: a.id, token: readState(a.id)?.jobToken as string, report: done });
		const failed = await waitFor(async () => {
			const r = await find(client, a.id);
			return r?.endedAt ? r : undefined;
		});
		expect(failed.state).toBe("failed");
		expect(failed.error).toMatch(/code 3/);
		await client.request("stop", { id: b.id });
		await client.request("report", { id: b.id, token: readState(b.id)?.jobToken as string, report: done });
		const stopped = await waitFor(async () => {
			const r = await find(client, b.id);
			return r?.endedAt ? r : undefined;
		});
		expect(stopped.state).toBe("stopped");
	});
});

describe("replies", () => {
	const working = {
		state: "working" as const,
		status: "busy" as const,
		waitingFor: null,
		summary: null,
		question: null,
		choices: [],
		tool: null,
		error: null,
		name: null,
		model: null,
	};

	it("pushes replies to the worker's connection, keeps them until acked; saves when not connected", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;

		// no worker connection yet: saved for later (PK-5); commands are not saved
		expect(await client.request("reply", { id, text: "first" })).toEqual({ delivered: false, saved: true });
		expect(await client.request("reply", { id, text: "/name x" })).toEqual({ delivered: false, saved: false });
		await expect(client.request("reply", { id, text: "!ls" })).rejects.toMatchObject({ code: "unsupported" });

		const worker = await DaemonClient.connect();
		clients.push(worker);
		const got: { seq: number; text: string }[] = [];
		worker.onEvent((e) => {
			if (e.event === "deliver") got.push({ seq: e.seq, text: e.text });
		});
		await worker.request("report", { id, token, report: working });
		await waitFor(() => got.length === 1);
		expect(got[0]).toEqual({ seq: 1, text: "first" });

		expect(await client.request("reply", { id, text: "  second  " })).toEqual({ delivered: true, saved: false });
		await waitFor(() => got.length === 2);
		expect(got[1]).toEqual({ seq: 2, text: "second" });
		// unacked replies stay pending and are resent on the next worker connection
		expect((readState(id)?.pendingReplies as unknown[]).length).toBe(2);
		await expect(worker.request("ack", { id, token: "bad", seq: 1 })).rejects.toMatchObject({ code: "unauthorized" });
		await worker.request("ack", { id, token, seq: 1 });
		expect(readState(id)?.pendingReplies).toEqual([{ seq: 2, text: "second" }]);

		const again = await DaemonClient.connect();
		clients.push(again);
		const resent: number[] = [];
		again.onEvent((e) => {
			if (e.event === "deliver") resent.push(e.seq);
		});
		await again.request("report", { id, token, report: working });
		await waitFor(() => resent.length === 1);
		expect(resent).toEqual([2]);

		// M28: a steering reply keeps its mode, also when it is sent again
		const modes: (string | undefined)[] = [];
		again.onEvent((e) => {
			if (e.event === "deliver") modes.push(e.mode);
		});
		expect(await client.request("reply", { id, text: "use pnpm", mode: "steer" })).toEqual({ delivered: true, saved: false });
		await waitFor(() => modes.length === 1);
		expect(modes).toEqual(["steer"]);
		expect((readState(id)?.pendingReplies as { mode?: string }[]).at(-1)).toMatchObject({ text: "use pnpm", mode: "steer" });
		await client.request("reply", { id, text: "plain", mode: "sideways" as never });
		await waitFor(() => modes.length === 2);
		expect(modes[1]).toBeUndefined();

		expect(await client.request("reply", { id, text: "/stop" })).toMatchObject({ stopped: true });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "stopped" ? r : undefined;
		});
		expect(row.endedAt).toBeTypeOf("number");
	});

	it("saves replies to an ended job", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2"));
		await waitFor(async () => (await find(client, id))?.endedAt);
		await waitFor(async () => (await find(client, id))?.endedAt);
		// flow 5.7: the reply is kept and the session starts again to receive it
		expect(await client.request("reply", { id, text: "continue" })).toEqual({ delivered: false, saved: true, respawned: true });
		expect(readState(id)?.pendingReplies).toEqual([{ seq: 1, text: "continue" }]);
		await waitFor(async () => (await find(client, id))?.endedAt);
		expect(await client.request("reply", { id, text: "/stop" })).toMatchObject({ stopped: false, delivered: false });
		await expect(client.request("reply", { id, text: "   " })).rejects.toMatchObject({ code: "bad_request" });
	});
});

describe("lifecycle", () => {
	const idle = {
		state: "done" as const,
		status: "idle" as const,
		waitingFor: null,
		summary: "all done",
		question: null,
		choices: [],
		tool: null,
		error: null,
		name: null,
		model: null,
	};

	it("M8: a respawn runs the model it last reported, or before any report the one it was dispatched with", async () => {
		const { client } = await startDaemon();
		const a = args("sleep 0.2", { sessionFile: join(work, "m8.jsonl"), model: "a/m", thinking: "low" });
		a.command = ["/bin/sh", "-c", "sleep 0.2", "--model", "a/m", "--thinking", "low", "--", "first"];
		writeFileSync(a.sessionFile, "{}\n");
		const { id } = await client.request("dispatch", a);
		await waitFor(async () => (await find(client, id))?.endedAt);
		await client.request("respawn", { id });
		expect(readState(id)?.command).toEqual(["/bin/sh", "-c", "sleep 0.2", "--model", "a/m", "--thinking", "low"]);
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		const report = { state: "working" as const, status: "busy" as const, waitingFor: null, summary: null, question: null, choices: [], tool: null, error: null, name: null, model: "b/n", thinking: "off" };
		await client.request("report", { id, token, report });
		await waitFor(async () => (await find(client, id))?.endedAt);
		await client.request("respawn", { id });
		expect(readState(id)?.command).toEqual(["/bin/sh", "-c", "sleep 0.2", "--model", "b/n", "--thinking", "off"]);
		await waitFor(async () => (await find(client, id))?.endedAt);
	});

	it("respawn starts an ended job again without its first prompt once the session exists", async () => {
		const { client } = await startDaemon();
		const a = args("sleep 0.2", { sessionFile: join(work, "written.jsonl") });
		a.command = ["/bin/sh", "-c", "sleep 0.2", "--", "first prompt"];
		writeFileSync(a.sessionFile, "{}\n");
		const { id } = await client.request("dispatch", a);
		await waitFor(async () => (await find(client, id))?.endedAt);
		expect(existsSync(join(jobDir(id), "exit.json"))).toBe(true);
		const { results } = await client.request("respawn", { id, prompt: "go on" });
		expect(results).toEqual([{ id, started: true }]);
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(row.state).toBe("working");
		expect(row.endedAt).toBeNull();
		expect(readState(id)?.command).toEqual(["/bin/sh", "-c", "sleep 0.2", "--", "go on"]);
		// already live: nothing to do unless asked to restart
		expect((await client.request("respawn", { id })).results).toEqual([{ id, started: false }]);
		await waitFor(async () => (await find(client, id))?.state === "done");
	});

	it("DM-5, M38: a worker that keeps crashing mid-run is restarted 3 times, then left failed", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "50,50,50";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.3; exit 3"));
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.state === "failed" && readState(id)?.crashRestarts === 3 ? r : undefined;
		}, 15000);
		expect(row.error).toMatch(/code 3.*not restarted again after 3 automatic restarts/);
		expect(readState(id)?.resumeAt).toBeUndefined();
	});

	it("M38: autoResume off restarts nothing", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "50,50,50";
		writeFileSync(join(home, "roost.json"), JSON.stringify({ autoResume: "off" }));
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.3; exit 3"));
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt ? r : undefined;
		});
		await new Promise((r) => setTimeout(r, 500));
		expect((await find(client, id))?.state).toBe("failed");
		expect(row.error).toMatch(/code 3$/);
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});

	it("DM-4: reaps an idle unattached worker, keeps the row, and wakes it on reply", async () => {
		process.env.PI_ROOST_REAP_MINUTES = "0.005"; // 300 ms
		process.env.PI_ROOST_REAP_CHECK_MS = "100";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await client.request("report", { id, token, report: idle });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.reaped ? r : undefined;
		});
		expect(row).toMatchObject({ state: "done", pid: null, summary: "all done" });
		expect(readState(id)?.stopRequested).not.toBe(true);
		expect(await client.request("reply", { id, text: "one more thing" })).toMatchObject({ respawned: true });
		const back = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(back.reaped).toBe(false);
	});

	it("does not reap a job with replies waiting; restarting a working job continues its turn", async () => {
		process.env.PI_ROOST_REAP_MINUTES = "0.002";
		process.env.PI_ROOST_REAP_CHECK_MS = "50";
		const { client } = await startDaemon();
		const a = args("sleep 30", { sessionFile: join(work, "w.jsonl") });
		writeFileSync(a.sessionFile, "{}\n");
		const { id } = await client.request("dispatch", a);
		await waitFor(async () => (await find(client, id))?.pid);
		// never connected as a worker: the reply stays pending
		expect(await client.request("reply", { id, text: "later" })).toMatchObject({ saved: true });
		await client.request("report", { id, token: readState(id)?.jobToken as string, report: idle });
		await new Promise((r) => setTimeout(r, 600));
		expect((await find(client, id))?.reaped).toBe(false);
		expect((await find(client, id))?.pid).toBeTruthy();

		const b = args("sleep 30", { sessionFile: join(work, "w2.jsonl") });
		writeFileSync(b.sessionFile, "{}\n");
		const busy = await client.request("dispatch", b);
		await waitFor(async () => (await find(client, busy.id))?.pid);
		await client.request("respawn", { id: busy.id, restart: true });
		expect(readState(busy.id)?.command).toEqual(["/bin/sh", "-c", "sleep 30", "--", "Continue where you left off."]);
		expect(readState(busy.id)?.restore).toBe(false);
	});

	it("M11: a session a phone used recently is not reaped; its idle time starts then", async () => {
		process.env.PI_ROOST_REAP_MINUTES = "0.01"; // 600 ms
		process.env.PI_ROOST_REAP_CHECK_MS = "50";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await client.request("report", { id, token, report: idle });
		const statePath = join(jobDir(id), "state.json");
		// idle for long, but the phone looked at it just now (a remoteAt in the future is clamped)
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		writeFileSync(statePath, JSON.stringify({ ...st, stateSince: Date.now() - 60_000 }));
		await client.request("report", { id, token, report: { ...idle, remoteAt: Date.now() + 3_600_000 } });
		expect(readState(id)?.remoteAt as number).toBeLessThanOrEqual(Date.now());
		await new Promise((res) => setTimeout(res, 300));
		expect((await find(client, id))?.reaped).toBe(false);
		// then nobody uses it: reaped once the idle time has passed since the phone
		const row = await waitFor(async () => {
			const x = await find(client, id);
			return x?.reaped ? x : undefined;
		});
		expect(row.pid).toBeNull();
	});

	it("never reaps a pinned or working job", async () => {
		process.env.PI_ROOST_REAP_MINUTES = "0.002";
		process.env.PI_ROOST_REAP_CHECK_MS = "50";
		const { client } = await startDaemon();
		const busy = await client.request("dispatch", args("sleep 30"));
		const pinned = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, busy.id))?.pid && (await find(client, pinned.id))?.pid);
		const statePath = join(jobDir(pinned.id), "state.json");
		writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), pinned: true }));
		await client.request("report", { id: pinned.id, token: readState(pinned.id)?.jobToken as string, report: idle });
		await new Promise((r) => setTimeout(r, 800));
		expect((await find(client, busy.id))?.pid).toBeTruthy();
		expect((await find(client, pinned.id))?.pid).toBeTruthy();
	});

	it("respawn --all restarts live and reaped jobs but leaves finished ones", async () => {
		const { client } = await startDaemon();
		const live = await client.request("dispatch", args("sleep 30"));
		const ended = await client.request("dispatch", args("true"));
		await waitFor(async () => (await find(client, live.id))?.pid && (await find(client, ended.id))?.endedAt);
		const before = readState(live.id)?.hostPid;
		const { results } = await client.request("respawn", { all: true });
		expect(results).toEqual([{ id: live.id, started: true }]);
		await waitFor(async () => {
			const r = await find(client, live.id);
			return r?.pid && readState(live.id)?.hostPid !== before;
		});
	});
});

describe("organise ops", () => {
	it("pin, rename and reorder are stored and listed", async () => {
		const { client } = await startDaemon();
		const a = await client.request("dispatch", args("sleep 30", { name: "alpha" }));
		const b = await client.request("dispatch", args("sleep 30", { name: "beta" }));
		expect(await client.request("pin", { id: a.id, pinned: true })).toEqual({ id: a.id, pinned: true });
		await client.request("rename", { id: b.id, name: "  gamma   ray " });
		await client.request("reorder", { ids: [b.id, a.id], key: "working" });
		const ra = await find(client, a.id);
		const rb = await find(client, b.id);
		expect(ra).toMatchObject({ pinned: true, order: 1, orderKey: "working" });
		expect(rb).toMatchObject({ name: "gamma ray", order: 0 });
		expect((await client.request("resolve", { query: "gamma" })).id).toBe(b.id);
		await expect(client.request("rename", { id: b.id, name: " " })).rejects.toMatchObject({ code: "bad_request" });
		await expect(client.request("reorder", { ids: ["nope"], key: "working" })).rejects.toMatchObject({ code: "bad_request" });
	});

	it("a rename outlives reports of the old session name and waits for the worker as a /name reply", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30", { name: "old" }));
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("rename", { id, name: "new name" });
		expect(readState(id)?.pendingReplies).toEqual([{ seq: 1, text: "/name new name" }]);
		const token = readState(id)?.jobToken as string;
		const report = (name: string) => ({ state: "working" as const, status: "busy" as const, waitingFor: null, summary: null, question: null, choices: [], tool: null, error: null, name, model: null });
		await client.request("report", { id, token, report: report("old") });
		expect((await find(client, id))?.name).toBe("new name");
		await client.request("report", { id, token, report: report("new name") });
		expect(readState(id)?.pendingName).toBeNull();
	});
});

describe("shell jobs (DI-6)", () => {
	it("runs without a session, shows its last output line, and goes away after a while", async () => {
		process.env.PI_ROOST_SHELL_KEEP_MS = "1500";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", { ...args("echo first; echo LAST-LINE; sleep 5"), kind: "shell", sessionFile: "" });
		const live = await waitFor(async () => {
			const r = await find(client, id);
			return r?.summary === "LAST-LINE" ? r : undefined;
		}, 8000);
		expect(live).toMatchObject({ kind: "shell", profile: "shell", status: "busy", sessionFile: "" });
		await expect(client.request("reply", { id, text: "hello" })).rejects.toMatchObject({ code: "unsupported" });
		const done = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt ? r : undefined;
		}, 8000);
		expect(done).toMatchObject({ state: "done", summary: "LAST-LINE" });
		await waitFor(async () => !(await find(client, id)), 8000);
		delete process.env.PI_ROOST_SHELL_KEEP_MS;
	});

	it("a command that prints nothing is pushed with its pid once it runs", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		await client.request("subscribe", {});
		client.onEvent((e) => events.push(e));
		const { id } = await client.request("dispatch", { ...args("sleep 5"), kind: "shell", sessionFile: "" });
		await waitFor(
			async () => events.some((e) => e.event === "job" && e.job.id === id && e.job.pid !== null) || undefined,
			8000,
		);
		await client.request("stop", { id });
	});

	it("a failing command ends failed with its exit code", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", { ...args("exit 4"), kind: "shell", sessionFile: "" });
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt ? x : undefined;
		});
		expect(r).toMatchObject({ state: "failed", error: "exited with code 4" });
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});
});

describe("shell jobs and lifecycle", () => {
	it("respawn --all leaves a running shell job alone; a stopped one is still removed later", async () => {
		process.env.PI_ROOST_SHELL_KEEP_MS = "800";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", { ...args("sleep 30"), kind: "shell", sessionFile: "" });
		await waitFor(async () => (await find(client, id))?.pid);
		const host = readState(id)?.hostPid;
		expect((await client.request("respawn", { all: true })).results).toEqual([]);
		expect(readState(id)?.hostPid).toBe(host);
		await client.request("stop", { id });
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt ? x : undefined;
		});
		expect(r.state).toBe("stopped");
		await waitFor(async () => !(await find(client, id)), 8000);
	});
});

describe("M22: one row per session", () => {
	const blocked = {
		state: "blocked" as const,
		status: "waiting" as const,
		waitingFor: "question" as const,
		summary: "go on?",
		question: "go on?",
		choices: [],
		tool: null,
		error: null,
		name: null,
		model: null,
	};

	it("a job that runs an ended job's session again takes its row, name and pin", async () => {
		const { client } = await startDaemon();
		const sessionFile = join(work, "same.jsonl");
		const a = await client.request("dispatch", args("true", { sessionFile, name: "fix-login" }));
		await waitFor(async () => (await find(client, a.id))?.endedAt);
		await client.request("pin", { id: a.id, pinned: true });
		const events: Event[] = [];
		client.onEvent((e) => events.push(e));
		await client.request("subscribe", {});
		// moved to the background again from another pi window
		const b = await client.request("dispatch", args("sleep 30", { sessionFile, name: "fix-login", origin: "adopt" }));
		expect(b.name).toBe("fix-login");
		await waitFor(() => events.some((e) => e.event === "removed" && e.id === a.id));
		const rows = (await client.request("list", {})).jobs;
		expect(rows.map((r) => r.id)).toEqual([b.id]);
		expect(rows[0]!.pinned).toBe(true);
		// its records stay (a worktree, its links), only the row goes
		expect(readState(a.id)?.supersededBy).toBe(b.id);
		// the job that took it over goes: the old row is back, and the next one takes it again
		await client.request("rm", { id: b.id });
		await waitFor(async () => (await client.request("list", {})).jobs.some((r) => r.id === a.id));
		const c = await client.request("dispatch", args("sleep 30", { sessionFile, name: "fix-login", origin: "adopt" }));
		await waitFor(async () => {
			const ids = (await client.request("list", {})).jobs.map((r) => r.id);
			return ids.length === 1 && ids[0] === c.id;
		});
	});

	it("an ended job waiting for an answer stops asking once another pi window opens its session", async () => {
		const { client } = await startDaemon();
		const sessionFile = join(work, "asked.jsonl");
		const { id } = await client.request("dispatch", args("sleep 0.6", { sessionFile }));
		await waitFor(async () => (await find(client, id))?.pid);
		await client.request("report", { id, token: readState(id)?.jobToken as string, report: blocked });
		await waitFor(async () => (await find(client, id))?.endedAt);
		expect((await find(client, id))?.state).toBe("blocked");
		expect(acquireWriterLock(sessionFile).ok).toBe(true);
		try {
			const fg = await DaemonClient.connect();
			clients.push(fg);
			await fg.request("peer_register", { session: sessionFile, name: "fg", cwd: work, pid: process.pid });
			const row = await waitFor(async () => {
				const r = await find(client, id);
				return r?.state === "done" ? r : undefined;
			});
			expect(row).toMatchObject({ waitingFor: null, question: null, summary: "continued in another pi window" });
		} finally {
			releaseWriterLock(sessionFile);
		}
	});

	it("a live job's worker shows with its pid before it reports", async () => {
		const { client } = await startDaemon();
		const events: Event[] = [];
		client.onEvent((e) => events.push(e));
		await client.request("subscribe", {});
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(() => events.some((e) => e.event === "job" && e.job.id === id && e.job.pid !== null), 6000);
	});
});

describe("M30 level 0 agents (profiles)", () => {
	const FAKE = resolve("test/fixtures/fake-agent.mjs");
	const agent = (over: Record<string, unknown> = {}) => ({
		cwd: work,
		sessionFile: "",
		kind: "shell" as const,
		profile: "fake",
		command: [process.execPath, FAKE, "first"],
		taskInArgv: true,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name: "fake",
		origin: "dispatch" as const,
		term: { submit: "\r", settleMs: 600, waiting: "proceed\\? \\(y/n\\)" },
		...over,
	});
	const screen = (id: string) => {
		try {
			return readFileSync(join(jobDir(id), "screen.txt"), "utf8");
		} catch {
			return "";
		}
	};
	const until = (client: DaemonClient, id: string, pred: (r: JobRow) => boolean, timeout = 12000) =>
		waitFor(async () => {
			const r = await find(client, id);
			return r && pred(r) ? r : undefined;
		}, timeout);

	it("reads its state from the terminal, types replies in, asks with the profile's regex, and stays after it exits", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", agent());
		expect(await find(client, id)).toMatchObject({ kind: "shell", profile: "fake", state: "working" });
		// done with its task, it notified: it wants you, with the notification as the question
		const asked = await until(client, id, (r) => r.state === "blocked");
		expect(asked).toMatchObject({ waitingFor: "question", question: "finished first", status: "waiting" });
		await waitFor(() => screen(id).includes("answer: first"));
		// a reply is typed in and submitted
		expect(await client.request("reply", { id, text: "second" })).toMatchObject({ delivered: true });
		await until(client, id, (r) => r.question === "finished second");
		await waitFor(() => screen(id).includes("answer: second"));
		// the profile's waiting regex: a dialog, with the line as the question
		await client.request("reply", { id, text: "ask" });
		expect(await until(client, id, (r) => r.waitingFor === "dialog")).toMatchObject({ question: "Do you want to proceed? (y/n)" });
		await client.request("reply", { id, text: "y" });
		await waitFor(() => screen(id).includes("you said y"));
		// it exits: the row stays (a command's would go), done
		await client.request("reply", { id, text: "quit" });
		const ended = await until(client, id, (r) => r.endedAt !== null);
		expect(ended).toMatchObject({ state: "done", waitingFor: null, question: null, summary: "fake agent" });
		expect(readState(id)?.removeAt).toBeUndefined();
		// a reply to it once ended starts it again and types the reply in when it is quiet
		const again = await client.request("reply", { id, text: "back again" });
		expect(again).toMatchObject({ respawned: true });
		await waitFor(() => screen(id).includes("answer: back again"), 15000);
		await client.request("stop", { id });
	}, 40000);

	it("types a first task in once it is quiet; a reply waits for it; it is never reaped", async () => {
		process.env.PI_ROOST_REAP_MINUTES = "0.001";
		process.env.PI_ROOST_REAP_CHECK_MS = "200";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", agent({ command: [process.execPath, FAKE], taskInArgv: undefined, term: { submit: "\r", settleMs: 600, typeTask: "typed task" } }));
		await expect(client.request("reply", { id, text: "too early" })).rejects.toMatchObject({ code: "busy" });
		await waitFor(() => screen(id).includes("answer: typed task"), 15000);
		expect(readState(id)?.typeTask ?? null).toBeNull();
		// idle far past the reap time: a level 0 agent keeps running
		await until(client, id, (r) => r.state !== "working");
		await new Promise((r) => setTimeout(r, 1500));
		expect(await find(client, id)).toMatchObject({ endedAt: null });
		expect(readState(id)?.reaped ?? false).toBe(false);
		await client.request("stop", { id });
	}, 30000);

	it("checks what it is given", async () => {
		const { client } = await startDaemon();
		await expect(client.request("dispatch", { ...agent(), kind: undefined, sessionFile: join(work, "x.jsonl") })).rejects.toMatchObject({ code: "bad_request" });
		await expect(client.request("dispatch", agent({ profile: "../x" }))).rejects.toMatchObject({ code: "bad_request" });
	});
});

describe("M31 the agent protocol", () => {
	it("hello: the daemon answers with its protocol and capabilities; a bad one is refused", async () => {
		const { client } = await startDaemon();
		const r = await client.request("hello", { protocol: 1, agent: { name: "x" }, capabilities: ["report"] });
		expect(r).toMatchObject({ protocol: 1, daemon: { name: "roost" } });
		expect(r.capabilities).toContain("replies");
		// a newer protocol is answered with this one: the agent decides
		expect((await client.request("hello", { protocol: 7 })).protocol).toBe(1);
		await expect(client.request("hello", { protocol: "one" } as never)).rejects.toMatchObject({ code: "bad_request" });
	});

	const hasPython = (() => {
		try {
			return spawnSync("python3", ["--version"]).status === 0;
		} catch {
			return false;
		}
	})();
	const agents = [
		{ lang: "TypeScript", command: () => [process.execPath, resolve("test/fixtures/agent-ts.ts")], name: "scripted-ts" },
		{ lang: "Python", command: () => ["python3", resolve("test/fixtures/agent-py.py")], name: "scripted-py", python: true },
	];
	for (const a of agents) {
		it.skipIf("python" in a && !hasPython)(`conformance (${a.lang} client): first task as a reply, reports, acks, a daemon restart, exit`, async () => {
			const first = await startDaemon();
			const { id } = await first.client.request("dispatch", {
				cwd: work,
				sessionFile: "",
				kind: "shell",
				profile: "scripted",
				protocol: true,
				command: a.command(),
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				name: "scripted",
				origin: "dispatch",
				term: { submit: "\r", settleMs: 600, typeTask: "first" },
			});
			const until = async (c: DaemonClient, pred: (r: JobRow) => boolean, timeout = 15000) =>
				waitFor(async () => {
					const r = await find(c, id);
					return r && pred(r) ? r : undefined;
				}, timeout);
			// the first task arrives as reply 1; its reports set the row; what it said in its hello is kept
			const did = await until(first.client, (r) => r.summary === "did first (#1)");
			expect(did).toMatchObject({ state: "done", status: "idle", model: "scripted-1", profile: "scripted" });
			expect(did.capabilities).toEqual(expect.arrayContaining(["report", "replies", "usage"]));
			await waitFor(() => (readState(id)?.pendingReplies as unknown[] | undefined)?.length === 0);
			expect((readState(id)?.agentInfo as { name?: string }).name).toBe(a.name);
			// a reply
			expect(await first.client.request("reply", { id, text: "second" })).toMatchObject({ delivered: true });
			await until(first.client, (r) => r.summary === "did second (#2)");
			// M47: the board through the client, as the job: a task put on, claimed, done (the answers routed by request id)
			await first.client.request("reply", { id, text: "board" });
			const boarded = await until(first.client, (r) => (r.summary ?? "").startsWith("board #"));
			const { tasks } = await first.client.request("task", { action: "list" });
			expect(tasks).toHaveLength(1);
			expect(tasks[0]).toMatchObject({ id: 1, title: "from the agent", detail: "a task it put on", state: "done", result: "done by the agent", owner: { id, name: "scripted" }, by: { who: "scripted", whoId: id } });
			expect(boarded.summary).toBe("board #1");
			// the daemon restarts under it: it reconnects, says hello, reports, and takes replies once each
			const before = Date.now();
			await first.client.request("shutdown", { keepWorkers: true });
			await waitFor(() => exited(first.proc));
			const second = await startDaemon();
			await waitFor(() => ((readState(id)?.reportedAt as number | undefined) ?? 0) > before);
			expect(await second.client.request("reply", { id, text: "third" })).toMatchObject({ delivered: true });
			await until(second.client, (r) => r.summary === "did third (#3)");
			// it exits: done, with what it last said
			await second.client.request("reply", { id, text: "exit" });
			const ended = await until(second.client, (r) => r.endedAt !== null);
			expect(ended).toMatchObject({ state: "done", summary: "bye" });
			expect((readState(id)?.pendingReplies as unknown[] | undefined) ?? []).toEqual([]);
		}, 60000);
	}
});

describe("M34 the daemon's telemetry", () => {
	it("records a span per request, reply latencies, reports and host start", async () => {
		const file = join(home, "telemetry.jsonl");
		process.env.ROOST_TELEMETRY = file;
		try {
			const { client } = await startDaemon();
			await client.request("subscribe", {});
			const { id } = await client.request("dispatch", {
				cwd: work,
				sessionFile: "",
				kind: "shell",
				profile: "scripted",
				protocol: true,
				command: [process.execPath, resolve("test/fixtures/agent-ts.ts")],
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				name: "scripted",
				origin: "dispatch",
				term: { submit: "\r", settleMs: 600, typeTask: "first" },
			});
			await waitFor(async () => (await find(client, id))?.summary === "did first (#1)", 15000);
			await client.request("reply", { id, text: "second" });
			await waitFor(async () => (await find(client, id))?.summary === "did second (#2)", 15000);
			await waitFor(() => (readState(id)?.pendingReplies as unknown[] | undefined)?.length === 0);
			await client.request("stop", { id });
			await waitFor(async () => (await find(client, id))?.endedAt);
			const { parseTelemetry } = await import("../lib/telemetry.ts");
			const recs = await waitFor(() => {
				const r = existsSync(file) ? parseTelemetry(readFileSync(file, "utf8")) : [];
				return r.some((x) => x.name === "roost.reply.ack_latency") && r.some((x) => x.name === "roost.host.ready") ? r : undefined;
			}, 5000);
			const names = new Set(recs.map((r) => r.name));
			for (const n of ["roost.op.dispatch", "roost.op.reply", "roost.op.report", "roost.op.ack", "roost.op.hello", "roost.op.stop", "roost.reports", "roost.events", "roost.host.start", "roost.host.ready", "roost.reply.deliver_latency", "roost.reply.ack_latency", "roost.state_changes"]) {
				expect(names, n).toContain(n);
			}
			expect(recs.find((r) => r.name === "roost.host.ready")?.proc).toBe(`host-${id}`);
		} finally {
			delete process.env.ROOST_TELEMETRY;
		}
	}, 40000);
});

describe("M35 an agent restarted after a lost ack", () => {
	it("skips the replies it finished before (agent.json), and handles the new one once", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", {
			cwd: work,
			sessionFile: "",
			kind: "shell",
			profile: "scripted",
			protocol: true,
			command: [process.execPath, resolve("test/fixtures/agent-ts.ts")],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name: "scripted",
			origin: "dispatch",
			term: { submit: "\r", settleMs: 600, typeTask: "first" },
		});
		await waitFor(async () => (await find(client, id))?.summary === "did first (#1)", 15000);
		await client.request("reply", { id, text: "second" });
		await waitFor(async () => (await find(client, id))?.summary === "did second (#2)", 15000);
		await waitFor(() => JSON.parse(readFileSync(join(jobDir(id), "agent.json"), "utf8")).handled === 2);
		await client.request("stop", { id });
		await waitFor(async () => (await find(client, id))?.endedAt);
		// as if the ack of "second" had been lost with the process
		const file = join(jobDir(id), "state.json");
		const st = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...st, pendingReplies: [{ seq: 2, text: "second" }] }));
		await client.request("reply", { id, text: "third" });
		// the new process handled one reply: third (second was finished, only acked again)
		await waitFor(async () => (await find(client, id))?.summary === "did third (#1)", 15000);
		await waitFor(() => (readState(id)?.pendingReplies as unknown[]).length === 0);
		await client.request("stop", { id });
	}, 40000);
});

describe("M35 a state file lost in a crash", () => {
	it("leaves the job listed, failed and startable, after a restart", async () => {
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("exit 0"));
		await waitFor(async () => (await find(first.client, id))?.endedAt);
		await first.client.request("shutdown", {});
		await waitFor(() => exited(first.proc));
		writeFileSync(join(jobDir(id), "state.json"), "");
		const second = await startDaemon();
		const row = await find(second.client, id);
		expect(row).toMatchObject({ state: "failed" });
		expect(row?.error).toMatch(/lost in a crash/);
	});
});

describe("M36 request ids", () => {
	it("a reply or a dispatch sent again with the same id is taken once", async () => {
		const { client } = await startDaemon();
		const a = { ...args("sleep 30"), requestId: "d-1" };
		const { id } = await client.request("dispatch", a);
		expect((await client.request("dispatch", a)).id).toBe(id);
		expect([...(await client.request("list", {})).jobs].filter((j) => j.id === id)).toHaveLength(1);
		const first = await client.request("reply", { id, text: "hello", requestId: "r-1" });
		expect(first.duplicate).toBeUndefined();
		expect(await client.request("reply", { id, text: "hello", requestId: "r-1" })).toMatchObject({ duplicate: true, saved: true });
		const pending = readState(id)?.pendingReplies as { text: string }[];
		expect(pending.filter((p) => p.text === "hello")).toHaveLength(1);
		await expect(client.request("reply", { id, text: "x", requestId: "bad id!" })).rejects.toMatchObject({ code: "bad_request" });
		await client.request("stop", { id });
	});
});

describe("M36 a resend after the daemon died before starting the job", () => {
	it("starts the ended job for the reply it took", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", {
			cwd: work,
			sessionFile: "",
			kind: "shell",
			profile: "scripted",
			protocol: true,
			command: [process.execPath, resolve("test/fixtures/agent-ts.ts")],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name: "scripted",
			origin: "dispatch",
			term: { submit: "\r", settleMs: 600, typeTask: "first" },
		});
		await waitFor(async () => (await find(client, id))?.summary === "did first (#1)", 15000);
		await client.request("stop", { id });
		await waitFor(async () => (await find(client, id))?.endedAt);
		// as if a reply was taken (kept with its id) and the daemon died before starting the job
		const file = join(jobDir(id), "state.json");
		const st = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, JSON.stringify({ ...st, replySeq: 2, pendingReplies: [{ seq: 2, text: "kept" }], requestIds: ["r-kept"] }));
		expect(await client.request("reply", { id, text: "kept", requestId: "r-kept" })).toMatchObject({ duplicate: true, respawned: true });
		await waitFor(async () => (await find(client, id))?.summary === "did kept (#1)", 15000);
		await client.request("stop", { id });
	}, 40000);
});

describe("M38: interrupted runs carry on", () => {
	const kill = (pid: number) => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	};

	it("a run whose host died while the service was down starts again by itself", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "50,50,50";
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(first.client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		// a session pi has written: it carries on where it left off
		writeFileSync(readJob(id)!.sessionFile, "{}\n");
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		kill(hostPid);
		const second = await startDaemon();
		const row = await waitFor(async () => {
			const r = await find(second.client, id);
			return r?.pid && r.pid !== hostPid ? r : undefined;
		});
		expect(row.state).toBe("working");
		expect(readState(id)?.crashRestarts).toBe(1);
		expect(readState(id)?.resumeAt).toBeUndefined();
		expect((readState(id)?.command as string[]).at(-1)).toBe("Continue where you left off.");
		await second.client.request("stop", { id });
	});

	it("a host killed under a working run is a crash: restarted (autoResume crash: not)", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "50,50,50";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, id))?.pid);
		const hostPid = readState(id)!.hostPid!;
		kill(hostPid);
		await waitFor(async () => {
			const st = readState(id);
			return st?.crashRestarts === 1 && typeof st.hostPid === "number" && st.hostPid !== hostPid && (await find(client, id))?.pid ? true : undefined;
		}, 15000);
		await client.request("stop", { id });

		writeFileSync(join(home, "roost.json"), JSON.stringify({ autoResume: "crash" }));
		const other = await client.request("dispatch", args("sleep 30"));
		await waitFor(async () => (await find(client, other.id))?.pid);
		kill(readState(other.id)!.hostPid!);
		const r = await waitFor(async () => {
			const x = await find(client, other.id);
			return x?.endedAt ? x : undefined;
		}, 15000);
		expect(r.state).toBe("failed");
		expect(r.error).toBe("host vanished");
	});

	it("a stop while a restart waits calls it off", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "3000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		const waiting = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt && typeof readState(id)?.resumeAt === "number" ? r : undefined;
		});
		expect(waiting.state).toBe("working");
		expect(waiting.error).toMatch(/continuing in 3 s \(automatic restart 1 of 1\)/);
		await client.request("stop", { id });
		expect((await find(client, id))?.state).toBe("stopped");
		await new Promise((r) => setTimeout(r, 3500));
		const after = await find(client, id);
		expect(after?.state).toBe("stopped");
		expect(after?.pid).toBeNull();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});

	it("a restart waiting when the service went down is taken up by the next start", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "2000";
		const first = await startDaemon();
		const { id } = await first.client.request("dispatch", args("sleep 0.2; exit 3"));
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		const second = await startDaemon();
		await waitFor(async () => (readState(id)?.crashRestarts === 1 && (await find(second.client, id))?.pid ? true : undefined), 8000);
		expect(readState(id)?.resumeAt).toBeUndefined();
		await second.client.request("stop", { id });
	});

	it("a reply while a restart waits starts it at once, with the reply instead", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "5000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		await client.request("reply", { id, text: "try another way" });
		await waitFor(async () => ((await find(client, id))?.pid ? true : undefined), 4000);
		expect(readState(id)?.resumeAt).toBeUndefined();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
		await client.request("stop", { id });
	});

	it("a worker killed by a signal is a crash, not a clean end (node-pty reports it as code 0)", async () => {
		writeFileSync(join(home, "roost.json"), JSON.stringify({ autoResume: "off" }));
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; kill -9 $$"));
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.endedAt ? x : undefined;
		});
		expect(r).toMatchObject({ state: "failed", error: "worker killed by SIGKILL" });
		const sh = await client.request("dispatch", { ...args("sleep 0.2; kill -9 $$"), kind: "shell", sessionFile: "" });
		const r2 = await waitFor(async () => {
			const x = await find(client, sh.id);
			return x?.endedAt ? x : undefined;
		});
		expect(r2).toMatchObject({ state: "failed", error: "killed by SIGKILL" });
	});

	it("a start by other means while a restart waits carries the run on, keeping the count", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "5000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		writeFileSync(readJob(id)!.sessionFile, "{}\n");
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		// what attach (ensureLive) and Enter twice do: a respawn with no prompt
		await client.request("respawn", { id });
		expect((readState(id)?.command as string[]).at(-1)).toBe("Continue where you left off.");
		expect(readState(id)?.resumeAt).toBeUndefined();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
		await client.request("stop", { id });
	});

	it("a start that fails while a restart waits leaves the restart to run, and it fails with why", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "1500";
		const { client } = await startDaemon();
		const dir = mkdtempSync(join(tmpdir(), "roost-gone-"));
		const { id } = await client.request("dispatch", { ...args("sleep 0.2; exit 3"), cwd: dir });
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		rmSync(dir, { recursive: true, force: true });
		await expect(client.request("respawn", { id })).rejects.toMatchObject({ code: "bad_request" });
		expect(typeof readState(id)?.resumeAt).toBe("number");
		const r = await waitFor(async () => {
			const x = await find(client, id);
			return x?.state === "failed" ? x : undefined;
		}, 6000);
		expect(r.error).toMatch(/could not restart it: cwd is gone/);
		expect(r.endedAt).toBeTypeOf("number");
		expect(readState(id)?.resumeAt).toBeUndefined();
	});

	it("a /stop reply while a restart waits stops it", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "3000";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.2; exit 3"));
		await waitFor(() => (typeof readState(id)?.resumeAt === "number" ? true : undefined));
		expect(await client.request("reply", { id, text: "/stop" })).toMatchObject({ stopped: true });
		expect((await find(client, id))?.state).toBe("stopped");
		await new Promise((r) => setTimeout(r, 3300));
		expect((await find(client, id))?.pid).toBeNull();
	});
});

describe("M39: scheduled tasks", () => {
	// the session file in the command, as pi's has it (`sh -c script <file>`: its $0)
	const template = (script: string) => {
		const file = join(work, "{{run}}.jsonl");
		return args(script, { sessionFile: file, command: ["/bin/sh", "-c", script, file] });
	};
	const writeSchedules = (list: unknown[]) => writeFileSync(join(home, "schedules.json"), JSON.stringify(list));
	const saved = (over: Record<string, unknown>) => ({
		name: "nightly",
		when: "every 1h",
		launch: template("sleep 0.3"),
		paused: false,
		catchUp: true,
		createdAt: Date.now() - 7200_000,
		anchor: Date.now() - 7200_000,
		nextAt: Date.now() - 60_000,
		...over,
	});

	it("adds, lists, pauses, resumes and removes schedules; refuses bad ones", async () => {
		const { client } = await startDaemon();
		const before = Date.now();
		const row = await client.request("schedule-add", { name: "hourly", when: "every 1h", launch: template("sleep 0.3"), task: "check the build" });
		expect(row).toMatchObject({ name: "hourly", when: "every 1h", task: "check the build", cwd: work, paused: false, catchUp: true, lastJob: null });
		expect(row.nextAt! - before).toBeGreaterThanOrEqual(3600_000 - 1000);
		expect((await client.request("schedules", {})).schedules.map((s) => s.name)).toEqual(["hourly"]);
		await expect(client.request("schedule-add", { name: "hourly", when: "every 1h", launch: template("x") })).rejects.toMatchObject({ code: "exists" });
		await expect(client.request("schedule-add", { name: "b", when: "hourly", launch: template("x") })).rejects.toMatchObject({ code: "bad_request" });
		await expect(client.request("schedule-add", { name: "c", when: "every 1h", launch: args("x") })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("{{run}}") });
		await expect(client.request("schedule-add", { name: "../x", when: "every 1h", launch: template("x") })).rejects.toMatchObject({ code: "bad_request" });
		const paused = await client.request("schedule-pause", { name: "hourly", paused: true });
		expect(paused).toMatchObject({ paused: true, nextAt: null });
		const resumed = await client.request("schedule-pause", { name: "hourly", paused: false });
		expect(resumed.nextAt).toBeGreaterThan(Date.now() + 3500_000);
		await client.request("schedule-rm", { name: "hourly" });
		expect((await client.request("schedules", {})).schedules).toEqual([]);
		await expect(client.request("schedule-rm", { name: "hourly" })).rejects.toMatchObject({ code: "not_found" });
	});

	it("runs one now: a session of its own, named after the schedule; never two at once", async () => {
		const { client } = await startDaemon();
		await client.request("schedule-add", { name: "check", when: "daily 03:00", launch: template("sleep 1.5") });
		const { id } = await client.request("schedule-run", { name: "check" });
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.pid ? r : undefined;
		});
		expect(row).toMatchObject({ name: "check", schedule: "check", state: "working" });
		const rec = (await import("../lib/store.ts")).readJob(id)!;
		expect(rec.sessionFile).toMatch(/\/\d{4}-\d\d-\d\dT[\d-]+Z_[0-9a-f-]{36}\.jsonl$/);
		await expect(client.request("schedule-run", { name: "check" })).rejects.toMatchObject({ code: "busy" });
		const s = (await client.request("schedules", {})).schedules[0]!;
		expect(s.lastJob).toBe(id);
		expect(s.lastSkip?.why).toMatch(/still going/);
		await waitFor(async () => (await find(client, id))?.state === "done");
		const again = await client.request("schedule-run", { name: "check" });
		expect(again.id).not.toBe(id);
		expect((await find(client, again.id))?.name).toBe("check (2)");
	});

	it("runs when due, and keeps going on its rhythm", async () => {
		process.env.PI_ROOST_SCHEDULE_TICK_MS = "100";
		writeSchedules([saved({ nextAt: Date.now() + 400, catchUp: false })]);
		const { client } = await startDaemon();
		const job = await waitFor(async () => (await client.request("list", {})).jobs.find((j) => j.schedule === "nightly"), 5000);
		expect(job.name).toBe("nightly");
		const s = (await client.request("schedules", {})).schedules[0]!;
		expect(s.lastJob).toBe(job.id);
		// the next whole hour from its anchor
		expect(s.nextAt).toBeGreaterThan(Date.now());
		const off = (s.nextAt! - (Date.now() - 7200_000)) % 3600_000;
		expect(Math.min(off, 3600_000 - off)).toBeLessThan(5000);
	});

	it("a run missed while the service was off runs once at start (catchUp), or is skipped", async () => {
		process.env.PI_ROOST_SCHEDULE_TICK_MS = "100";
		writeSchedules([saved({ name: "missed", nextAt: Date.now() - 3 * 3600_000 }), saved({ name: "skipped", catchUp: false })]);
		const { client } = await startDaemon();
		await waitFor(async () => (await client.request("list", {})).jobs.some((j) => j.schedule === "missed") || undefined, 5000);
		await new Promise((r) => setTimeout(r, 500));
		const jobs = (await client.request("list", {})).jobs;
		expect(jobs.filter((j) => j.schedule === "missed")).toHaveLength(1);
		expect(jobs.filter((j) => j.schedule === "skipped")).toHaveLength(0);
		for (const s of (await client.request("schedules", {})).schedules) expect(s.nextAt).toBeGreaterThan(Date.now());
	});

	it("survives a restart of the service; a paused one does not run", async () => {
		process.env.PI_ROOST_SCHEDULE_TICK_MS = "100";
		const first = await startDaemon();
		await first.client.request("schedule-add", { name: "kept", when: "weekdays 09:00", launch: template("sleep 0.3"), catchUp: false });
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		const list = JSON.parse(readFileSync(join(home, "schedules.json"), "utf8"));
		writeSchedules([...list, saved({ name: "resting", paused: true, nextAt: null })]);
		const second = await startDaemon();
		const rows = (await second.client.request("schedules", {})).schedules;
		expect(rows.map((s) => [s.name, s.paused])).toEqual([
			["kept", false],
			["resting", true],
		]);
		await new Promise((r) => setTimeout(r, 400));
		expect((await second.client.request("list", {})).jobs.filter((j) => j.schedule)).toEqual([]);
	});

	it("a finished run whose worker is still up does not hold the next one; its worker is closed", async () => {
		const { client } = await startDaemon();
		await client.request("schedule-add", { name: "idle", when: "daily 03:00", launch: template("sleep 30") });
		const { id } = await client.request("schedule-run", { name: "idle" });
		await waitFor(async () => (await find(client, id))?.pid);
		const token = readState(id)?.jobToken as string;
		await client.request("report", { id, token, report: { state: "done", status: "idle", waitingFor: null, summary: "did it", question: null, choices: [], tool: null, error: null, name: null, model: null } });
		const second = await client.request("schedule-run", { name: "idle" });
		expect(second.id).not.toBe(id);
		// done and idle: closed a moment later, as a subagent's
		await waitFor(async () => ((await find(client, id))?.pid === null ? true : undefined), 10000);
		expect((await find(client, id))?.state).toBe("done");
		await client.request("stop", { id: second.id });
	});

	it("two runs asked at once start one", async () => {
		const { client } = await startDaemon();
		await client.request("schedule-add", { name: "twice", when: "daily 03:00", launch: template("sleep 2") });
		const both = await Promise.allSettled([client.request("schedule-run", { name: "twice" }), client.request("schedule-run", { name: "twice" })]);
		expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(both.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "busy" } });
		expect((await client.request("list", {})).jobs.filter((j) => j.schedule === "twice")).toHaveLength(1);
	});
});

describe("M40: agents cut short carry on; scheduled commands and agents", () => {
	const FAKE = resolve("test/fixtures/fake-agent.mjs");
	const TS = resolve("test/fixtures/agent-ts.ts");
	const fake = (over: Record<string, unknown> = {}) => ({
		cwd: work,
		sessionFile: "",
		kind: "shell" as const,
		profile: "fake",
		command: [process.execPath, FAKE, "crash"],
		taskInArgv: true,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		name: "fake",
		origin: "dispatch" as const,
		term: { submit: "\r", settleMs: 600, waiting: "proceed\\? \\(y/n\\)" },
		...over,
	});
	const screen = (id: string) => {
		try {
			return readFileSync(join(jobDir(id), "screen.txt"), "utf8");
		} catch {
			return "";
		}
	};
	const until = (client: DaemonClient, id: string, pred: (r: JobRow) => boolean, timeout = 15000) =>
		waitFor(async () => {
			const r = await find(client, id);
			return r && pred(r) ? r : undefined;
		}, timeout);

	it("a terminal agent with resume that dies mid-work is started again and told to continue", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "100,100,100";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", fake({ resumeCommand: [process.execPath, FAKE, "resumed"], resumable: true }));
		await waitFor(() => (readState(id)?.crashRestarts === 1 ? true : undefined), 10000);
		expect(readState(id)?.command).toEqual([process.execPath, FAKE, "resumed"]);
		await waitFor(() => screen(id).includes("answer: Continue where you left off.") || undefined, 15000);
		const r = await until(client, id, (x) => x.state !== "working");
		expect(r.error).toBeNull();
		expect(readState(id)?.resumeAt).toBeUndefined();
		await client.request("stop", { id });
	});

	it("a terminal agent without resume is not started again: it could not carry on", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "100,100,100";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", fake({ resumeCommand: [process.execPath, FAKE] }));
		const r = await until(client, id, (x) => x.endedAt !== null);
		expect(r).toMatchObject({ state: "failed", error: "exited with code 3" });
		await new Promise((res) => setTimeout(res, 500));
		expect((await find(client, id))?.pid).toBeNull();
		expect(readState(id)?.crashRestarts ?? 0).toBe(0);
	});

	it("a protocol agent that dies mid-work is started again and takes \"continue\" as a reply", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "100,100,100";
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", {
			cwd: work,
			sessionFile: "",
			kind: "shell",
			profile: "scripted",
			protocol: true,
			command: [process.execPath, TS],
			resumeCommand: [process.execPath, TS],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name: "scripted",
			origin: "dispatch",
			term: { submit: "\r", settleMs: 600, typeTask: "crash" },
		});
		const r = await until(client, id, (x) => x.summary === "did Continue where you left off. (#1)", 20000);
		expect(r.state).toBe("done");
		expect(readState(id)?.crashRestarts).toBe(1);
		await waitFor(() => (readState(id)?.pendingReplies as unknown[] | undefined)?.length === 0);
		await client.request("stop", { id });
	});

	it("a schedule runs a terminal agent, named after it, closed once done; and a plain command", async () => {
		process.env.PI_ROOST_AUTO_CLOSE_MS = "600";
		const { client } = await startDaemon();
		// it notifies when done (as Claude Code does): unattended, that is done, not a question
		const row = await client.request("schedule-add", { name: "term", when: "daily 03:00", launch: fake({ command: [process.execPath, FAKE, "task"] }), task: "task" });
		expect(row.agent).toBe("fake");
		const { id } = await client.request("schedule-run", { name: "term" });
		expect(await find(client, id)).toMatchObject({ name: "term", schedule: "term", profile: "fake", state: "working" });
		await waitFor(() => screen(id).includes("answer: task") || undefined, 15000);
		// done and nobody attached: its process goes, the row stays
		const closed = await until(client, id, (x) => x.pid === null, 15000);
		expect(closed).toMatchObject({ state: "done", summary: "finished task", question: null });
		// a command
		const cmd = await client.request("schedule-add", { name: "cmd", when: "daily 03:00", launch: { ...args("echo scheduled"), kind: "shell", sessionFile: "" }, task: "! echo scheduled" });
		expect(cmd.agent).toBe("shell");
		const run = await client.request("schedule-run", { name: "cmd" });
		const done = await until(client, run.id, (x) => x.endedAt !== null);
		expect(done).toMatchObject({ state: "done", schedule: "cmd", profile: "shell" });
		await expect(client.request("schedule-add", { name: "wt", when: "daily 03:00", launch: { ...fake(), worktree: { path: "/x", branch: "b", repo: "/r", base: "main" } } })).rejects.toMatchObject({ code: "bad_request" });
	});

	it("a terminal agent whose host died while the service was down keeps what it was: done, or its question", async () => {
		const first = await startDaemon();
		const done = await first.client.request("dispatch", fake({ command: [process.execPath, FAKE, "one"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_QUIET: "1" }, name: "quiet" }));
		const asked = await first.client.request("dispatch", fake({ command: [process.execPath, FAKE, "two"], name: "loud" }));
		await until(first.client, done.id, (r) => r.state === "done");
		await until(first.client, asked.id, (r) => r.state === "blocked" && r.question === "finished two");
		const pids = [readState(done.id)!.hostPid!, readState(asked.id)!.hostPid!];
		await first.client.request("shutdown", { keepWorkers: true });
		await waitFor(() => exited(first.proc));
		for (const pid of pids) process.kill(pid, "SIGKILL");
		const second = await startDaemon();
		expect(await find(second.client, done.id)).toMatchObject({ state: "done", error: null, pid: null });
		// (a row without a process shows no waitingFor; the state keeps it for the reply that starts it)
		expect(await find(second.client, asked.id)).toMatchObject({ state: "blocked", question: "finished two", summary: "finished two", error: null, pid: null });
		expect(readState(asked.id)?.waitingFor).toBe("question");
	});

	it("an automatic restart that cannot start leaves no \"continue\" queued for a later reply", async () => {
		process.env.PI_ROOST_RESUME_DELAYS_MS = "100";
		const { client } = await startDaemon();
		const dir = mkdtempSync(join(tmpdir(), "roost-gone-"));
		const { id } = await client.request("dispatch", {
			cwd: dir,
			sessionFile: "",
			kind: "shell",
			profile: "scripted",
			protocol: true,
			command: [process.execPath, TS],
			resumeCommand: [process.execPath, TS],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name: "scripted",
			origin: "dispatch",
			term: { submit: "\r", settleMs: 600, typeTask: "crash" },
		});
		// the agent took the task (acked) and is about to die; its directory goes meanwhile
		await waitFor(() => ((readState(id)?.pendingReplies as unknown[] | undefined)?.length === 0 ? true : undefined));
		rmSync(dir, { recursive: true, force: true });
		const r = await until(client, id, (x) => x.state === "failed" && /could not restart/.test(x.error ?? ""), 20000);
		expect(r.error).toMatch(/cwd is gone/);
		expect(((readState(id)?.pendingReplies as { text: string }[] | undefined) ?? []).map((x) => x.text)).toEqual([]);
	});
});

