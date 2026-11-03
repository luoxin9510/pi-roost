import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonError } from "../lib/client.ts";
import { daemonSocketPath, jobDir } from "../lib/paths.ts";
import { isAlive, processStartToken } from "../lib/proc.ts";
import type { Event, JobRow } from "../lib/protocol.ts";
import { listJobIds, readState } from "../lib/store.ts";

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
		["PI_ROOST_REAP_CHECK_MS", undefined],
		["PI_ROOST_SHELL_KEEP_MS", undefined],
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

	it("finalizes jobs whose host died while the daemon was down", async () => {
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

	it("DM-5: a worker that crashes mid-run restarts once, then fails", async () => {
		const { client } = await startDaemon();
		const { id } = await client.request("dispatch", args("sleep 0.3; exit 3"));
		const row = await waitFor(async () => {
			const r = await find(client, id);
			return r?.endedAt && readState(id)?.crashRestarts === 1 ? r : undefined;
		}, 15000);
		expect(row.state).toBe("failed");
		expect(row.error).toMatch(/code 3/);
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
		expect(live).toMatchObject({ kind: "shell", status: "busy", sessionFile: "" });
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
