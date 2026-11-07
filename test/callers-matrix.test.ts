// M63: what each kind of caller gets from each op, pinned. The daemon's answer to every op
// (and every task action) for a Person, a foreground Session, a background Session (a job),
// the Concierge and an Unregistered agent, with arguments that do nothing harmful once
// allowed: "ok", or the error's code and message. A change to who may do what shows here.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaemonClient } from "../lib/client.ts";
import { acquireWriterLock, releaseWriterLock } from "../lib/locks.ts";
import { isAlive } from "../lib/proc.ts";
import { listJobIds, readState } from "../lib/store.ts";

const DAEMON = resolve("daemon/main.ts");
const HOST = resolve("host/main.ts");

let home: string;
let rt: string;
let work: string;
let daemon: ChildProcess | undefined;
const clients: DaemonClient[] = [];
const locks: string[] = [];

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeout = 10000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

async function connect(): Promise<DaemonClient> {
	const c = await DaemonClient.connect();
	clients.push(c);
	return c;
}

const report = () => ({ state: "working" as const, status: "busy" as const, waitingFor: null, summary: null, question: null, choices: [], tool: null, error: null, name: null, model: null, agentItems: true });

let n = 0;
const sleeper = (name: string, env: Record<string, string> = {}) => {
	const script = join(work, `fake-pi-${n}.sh`);
	writeFileSync(script, "exec sleep 60\n");
	const sessionFile = join(work, `c${n++}.jsonl`);
	return { cwd: work, sessionFile, command: ["/bin/sh", script, "--session", sessionFile], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, name, origin: "dispatch" as const };
};

/** A job's worker: reports on a connection of its own, which binds it as that job. */
async function worker(id: string): Promise<DaemonClient> {
	const c = await connect();
	await c.request("report", { id, token: readState(id)?.jobToken as string, report: report() });
	return c;
}

type Who = "person" | "foreground" | "job" | "concierge" | "unregistered";
const WHO: Who[] = ["person", "foreground", "job", "concierge", "unregistered"];

/** The ops, each with arguments that are refused or harmless once allowed. `shutdown` is last. */
const OPS: [string, Record<string, unknown>][] = [
	["ping", {}],
	["schedules", {}],
	["schedule-add", {}],
	["schedule-rm", { name: "nope" }],
	["schedule-pause", { name: "nope" }],
	["schedule-run", { name: "nope" }],
	["list", {}],
	["dispatch", {}],
	["resolve", { query: "nope" }],
	["status", {}],
	["subscribe", {}],
	["stop", { id: "nope" }],
	["rm", { id: "nope" }],
	["respawn", { id: "nope" }],
	["pin", { id: "nope" }],
	["rename", { id: "nope", name: "x" }],
	["reorder", { ids: [] }],
	["reply", { id: "nope", text: "x" }],
	["ack", { id: "nope", token: "nope" }],
	["peers", {}],
	["send", { to: "nope", text: "x" }],
	["spawn", {}],
	["handback", { text: "" }],
	["peer_ack", { id: "nope" }],
	["events", { limit: 1 }],
	["watch", { id: "nope" }],
	["concierge", { action: "status" }],
	["concierge-ask", { text: "" }],
	["concierge-say", { text: "" }],
	["concierge-policy", {}],
	["concierge-suggest", {}],
	["concierge-reply", {}],
	["concierge-act", {}],
	["concierge-order", { action: "list" }],
	["concierge-order", { action: "add", text: "" }],
	["concierge-order", { action: "rm", id: 999 }],
	["concierge-order", { action: "applied", id: 999 }],
];

/** Task actions, each on a fresh open task the Person added (no repository, no workspace). */
const TASK_ACTIONS: [string, Record<string, unknown>][] = [
	["list", {}],
	["add", { title: "" }],
	["cleanup", {}],
	["claim", {}],
	["release", {}],
	["done", {}],
	["drop", {}],
	["assign", { to: "nope" }],
	["start", {}],
	["merge", {}],
	["back", {}],
	["abort", {}],
	["commit", {}],
	["approve", {}],
	["verify", {}],
	["pass", {}],
	["comment", {}],
	["uncomment", {}],
	["shelve", {}],
	["pr", {}],
];

describe("M63: who may do what", () => {
	const by: Record<Who, DaemonClient> = {} as Record<Who, DaemonClient>;
	const ids: string[] = [];

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "roost-m-"));
		rt = mkdtempSync("/tmp/rtm-");
		work = mkdtempSync(join(tmpdir(), "roost-mw-"));
		Object.assign(process.env, { PI_ROOST_HOME: home, PI_ROOST_RUNTIME_DIR: rt, PI_ROOST_HOST_ENTRY: HOST, PI_ROOST_CONFIG_DIR: home });
		daemon = spawn(process.execPath, [DAEMON], { stdio: "ignore", env: process.env });
		by.person = await waitFor(async () => {
			try {
				const c = await connect();
				await c.request("ping", {});
				return c;
			} catch {
				return undefined;
			}
		});
		// a foreground pi: holds its session's writer lock, registers on its connection
		const session = join(work, "fg.jsonl");
		expect(acquireWriterLock(session).ok).toBe(true);
		locks.push(session);
		by.foreground = await connect();
		ids.push((await by.foreground.request("peer_register", { session, name: "fg", cwd: work, pid: process.pid })).id);
		// a background session: a job the Person dispatched, its worker reporting
		const job = await by.person.request("dispatch", sleeper("job"));
		ids.push(job.id);
		await waitFor(async () => (await by.person.request("list", {})).jobs.find((j) => j.id === job.id)?.pid);
		by.job = await worker(job.id);
		// the concierge: on, its worker reporting
		const st = await by.person.request("concierge", { action: "on", launch: sleeper("concierge", { ROOST_ROLE: "concierge" }) });
		ids.push(st.id!);
		await waitFor(async () => (await by.person.request("list", {})).jobs.find((j) => j.id === st.id)?.pid);
		by.concierge = await worker(st.id!);
		// an Unregistered agent: said hello (refused: no such job), so an agent's connection
		by.unregistered = await connect();
		await by.unregistered.request("hello", { id: "nope", token: "nope" } as never).catch(() => {});
	}, 30_000);

	afterAll(() => {
		for (const c of clients) c.close();
		for (const id of listJobIds()) {
			const pid = readState(id)?.hostPid;
			if (pid && isAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
		for (const f of locks.splice(0)) releaseWriterLock(f);
		rmSync(home, { recursive: true, force: true });
		rmSync(rt, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
		for (const k of ["PI_ROOST_HOME", "PI_ROOST_RUNTIME_DIR", "PI_ROOST_HOST_ENTRY", "PI_ROOST_CONFIG_DIR"]) delete process.env[k];
	});

	/** The answer, with what differs from run to run (ids, paths, task numbers) named. */
	async function answer(c: DaemonClient, op: string, args: Record<string, unknown>): Promise<string> {
		try {
			await c.request(op as never, args as never);
			return "ok";
		} catch (err) {
			const e = err as { code?: string; message?: string };
			let m = `${e.code ?? "?"}: ${e.message ?? ""}`;
			for (const [i, id] of ids.entries()) m = m.split(id).join(`<id${i}>`);
			return m.split(work).join("<work>").replace(/#\d+/g, "#<t>");
		}
	}

	it("each op, for each kind of caller", async () => {
		const table: Record<string, Record<Who, string>> = {};
		for (const [op, args] of OPS) {
			const key = op === "concierge-order" ? `${op}.${args.action}` : op;
			table[key] = {} as Record<Who, string>;
			for (const w of WHO) table[key][w] = await answer(by[w], op, args);
		}
		// shutdown last, the Person last of all (it stops the daemon)
		table.shutdown = {} as Record<Who, string>;
		for (const w of WHO.filter((x) => x !== "person")) table.shutdown[w] = await answer(by[w], "shutdown", {});
		table.shutdown.person = "(not run: it stops the daemon)";
		expect(table).toMatchSnapshot();
	}, 60_000);
});

describe("M63: who may do what with a task", () => {
	// a daemon of its own: the first describe's Person may have stopped it
	const by: Record<Who, DaemonClient> = {} as Record<Who, DaemonClient>;
	const ids: string[] = [];
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "roost-m-"));
		rt = mkdtempSync("/tmp/rtm-");
		work = mkdtempSync(join(tmpdir(), "roost-mw-"));
		Object.assign(process.env, { PI_ROOST_HOME: home, PI_ROOST_RUNTIME_DIR: rt, PI_ROOST_HOST_ENTRY: HOST, PI_ROOST_CONFIG_DIR: home });
		daemon = spawn(process.execPath, [DAEMON], { stdio: "ignore", env: process.env });
		by.person = await waitFor(async () => {
			try {
				const c = await connect();
				await c.request("ping", {});
				return c;
			} catch {
				return undefined;
			}
		});
		const session = join(work, "fg.jsonl");
		expect(acquireWriterLock(session).ok).toBe(true);
		locks.push(session);
		by.foreground = await connect();
		ids.push((await by.foreground.request("peer_register", { session, name: "fg", cwd: work, pid: process.pid })).id);
		const job = await by.person.request("dispatch", sleeper("job"));
		ids.push(job.id);
		await waitFor(async () => (await by.person.request("list", {})).jobs.find((j) => j.id === job.id)?.pid);
		by.job = await worker(job.id);
		const st = await by.person.request("concierge", { action: "on", launch: sleeper("concierge", { ROOST_ROLE: "concierge" }) });
		ids.push(st.id!);
		await waitFor(async () => (await by.person.request("list", {})).jobs.find((j) => j.id === st.id)?.pid);
		by.concierge = await worker(st.id!);
		by.unregistered = await connect();
		await by.unregistered.request("hello", { id: "nope", token: "nope" } as never).catch(() => {});
	}, 30_000);

	afterAll(() => {
		for (const c of clients.splice(0)) c.close();
		for (const id of listJobIds()) {
			const pid = readState(id)?.hostPid;
			if (pid && isAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
		for (const f of locks.splice(0)) releaseWriterLock(f);
		rmSync(home, { recursive: true, force: true });
		rmSync(rt, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
		for (const k of ["PI_ROOST_HOME", "PI_ROOST_RUNTIME_DIR", "PI_ROOST_HOST_ENTRY", "PI_ROOST_CONFIG_DIR"]) delete process.env[k];
	});

	async function answer(c: DaemonClient, args: Record<string, unknown>): Promise<string> {
		try {
			await c.request("task", args as never);
			return "ok";
		} catch (err) {
			const e = err as { code?: string; message?: string };
			let m = `${e.code ?? "?"}: ${e.message ?? ""}`;
			for (const [i, id] of ids.entries()) m = m.split(id).join(`<id${i}>`);
			return m.split(work).join("<work>").replace(/#\d+/g, "#<t>");
		}
	}

	it("each task action, for each kind of caller, on a fresh open task", async () => {
		const table: Record<string, Record<Who, string>> = {};
		for (const [action, extra] of TASK_ACTIONS) {
			table[`task.${action}`] = {} as Record<Who, string>;
			for (const w of WHO) {
				const t = (await by.person.request("task", { action: "add", title: `${action} by ${w}` })).task!;
				table[`task.${action}`][w] = await answer(by[w], { action, id: t.id, ...extra });
			}
		}
		// the Concierge starts a task when its policy lets it act: past the policy, to the task's own checks
		await by.person.request("concierge", { action: "act", act: true } as never);
		const t = (await by.person.request("task", { action: "add", title: "start by the concierge, act on" })).task!;
		table["task.start (act on)"] = { concierge: await answer(by.concierge, { action: "start", id: t.id }) } as Record<Who, string>;
		expect(table).toMatchSnapshot();
	}, 60_000);
});
