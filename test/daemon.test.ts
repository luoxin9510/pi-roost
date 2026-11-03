import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
		expect(row?.state).toBe("failed");
		expect(readState(id)?.error).toBe("host vanished");
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
