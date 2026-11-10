import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../lib/client.ts";
import { pidAlive, sweepOrphans } from "../lib/orphans.ts";
import { listJobIds, readState } from "../lib/store.ts";

// M78: a test-mode daemon follows PI_ROOST_PARENT_PID; the sweeper clears what a killed run left

const DAEMON = resolve("daemon/main.ts");
const HOST = resolve("host/main.ts");
const KEYS = ["PI_ROOST_HOME", "PI_ROOST_RUNTIME_DIR", "PI_ROOST_HOST_ENTRY", "PI_ROOST_CONFIG_DIR"];

let home: string;
let rt: string;
let work: string;
let procs: ChildProcess[] = [];
/** Processes started as orphans (their parent gone at once): not ChildProcesses of ours. */
let orphanPids: number[] = [];
/** The fakes' directories. */
let fakeDirs: string[] = [];
let client: DaemonClient | undefined;
let saved: Record<string, string | undefined> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeout = 10000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await sleep(25);
	}
}
const ps = () => execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
const sleepersOf = (tag: string) =>
	ps()
		.split("\n")
		.filter((l) => l.includes(`sleep ${tag}`) && !l.includes("ps -axo"))
		.map((l) => Number(l.trim().split(/\s+/)[0]));
const gone = (pid: number) => !pidAlive(pid);

function helper(): ChildProcess {
	const h = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	procs.push(h);
	return h;
}

async function startDaemon(parent?: number): Promise<ChildProcess> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PI_ROOST_PARENT_PID;
	if (parent !== undefined) env.PI_ROOST_PARENT_PID = String(parent);
	const d = spawn(process.execPath, [DAEMON], { stdio: "ignore", env });
	procs.push(d);
	client = await waitFor(async () => {
		try {
			const c = await DaemonClient.connect();
			await c.request("ping", {});
			return c;
		} catch {
			return undefined;
		}
	});
	return d;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-o-"));
	rt = mkdtempSync("/tmp/rto-");
	work = mkdtempSync(join(tmpdir(), "roost-ow-"));
	saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	Object.assign(process.env, { PI_ROOST_HOME: home, PI_ROOST_RUNTIME_DIR: rt, PI_ROOST_HOST_ENTRY: HOST, PI_ROOST_CONFIG_DIR: home });
});

afterEach(() => {
	client?.close();
	client = undefined;
	try {
		for (const id of listJobIds()) {
			const pid = readState(id)?.hostPid;
			if (pid && pidAlive(pid)) process.kill(pid, "SIGKILL");
		}
	} catch {}
	for (const p of procs) if (p.pid && pidAlive(p.pid)) process.kill(p.pid, "SIGKILL");
	procs = [];
	for (const pid of orphanPids) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
	orphanPids = [];
	for (const pid of sleepersOf("6173")) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const d of [home, rt, work, ...fakeDirs]) rmSync(d, { recursive: true, force: true });
	fakeDirs = [];
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("a test-mode daemon follows its parent", () => {
	it("exits with the parent, and takes its host and the host's child along", async () => {
		const h = helper();
		const d = await startDaemon(h.pid);
		const { id } = await client!.request("dispatch", {
			cwd: work,
			sessionFile: join(work, "s.jsonl"),
			command: ["/bin/sh", "-c", "sleep 6173"],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name: "job",
			origin: "dispatch",
		});
		const hostPid = await waitFor(() => readState(id)?.hostPid);
		const sleepers = await waitFor(() => {
			const s = sleepersOf("6173");
			return s.length > 0 ? s : undefined;
		});
		process.kill(h.pid!, "SIGKILL");
		await waitFor(() => gone(d.pid!), 8000);
		await waitFor(() => gone(hostPid), 8000);
		await waitFor(() => sleepers.every(gone), 8000);
	});

	it("a host follows the parent on its own (its daemon killed at the same time)", async () => {
		const h = helper();
		const d = await startDaemon(h.pid);
		const { id } = await client!.request("dispatch", {
			cwd: work,
			sessionFile: join(work, "s.jsonl"),
			command: ["/bin/sh", "-c", "sleep 6173"],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			name: "job",
			origin: "dispatch",
		});
		const hostPid = await waitFor(() => readState(id)?.hostPid);
		const sleepers = await waitFor(() => {
			const s = sleepersOf("6173");
			return s.length > 0 ? s : undefined;
		});
		process.kill(d.pid!, "SIGKILL");
		process.kill(h.pid!, "SIGKILL");
		await waitFor(() => gone(hostPid), 8000);
		await waitFor(() => sleepers.every(gone), 8000);
	});

	it("exits when its home is deleted", async () => {
		const h = helper();
		const d = await startDaemon(h.pid);
		rmSync(home, { recursive: true, force: true });
		await waitFor(() => gone(d.pid!), 8000);
	});

	it("without the variable, ignores its parent dying", async () => {
		const h = helper();
		const d = await startDaemon();
		process.kill(h.pid!, "SIGKILL");
		await sleep(3000);
		expect(pidAlive(d.pid!)).toBe(true);
		await client!.request("shutdown", {});
		await waitFor(() => gone(d.pid!), 8000);
	});
});

describe("sweepOrphans", () => {
	/** A process whose command looks like the daemon's, with the given environment. */
	function fake(env: Record<string, string>): ChildProcess {
		const dir = mkdtempSync(join(tmpdir(), "roost-fake-"));
		fakeDirs.push(dir);
		mkdirSync(join(dir, "daemon"));
		const script = join(dir, "daemon", "main.ts");
		writeFileSync(script, "setInterval(() => {}, 1000);\n");
		const clean: NodeJS.ProcessEnv = { ...process.env };
		for (const k of ["PI_ROOST_PARENT_PID", "PI_ROOST_HOME"]) delete clean[k];
		const p = spawn(process.execPath, [script], { stdio: "ignore", env: { ...clean, ...env } });
		procs.push(p);
		return p;
	}
	const settle = () => sleep(300);
	/** The same fake started by a shell that exits at once: its parent becomes 1, as a leftover's. */
	function orphanFake(env: Record<string, string>): number {
		const dir = mkdtempSync(join(tmpdir(), "roost-fake-"));
		fakeDirs.push(dir);
		mkdirSync(join(dir, "daemon"));
		const script = join(dir, "daemon", "main.ts");
		writeFileSync(script, "setInterval(() => {}, 1000);\n");
		const clean: NodeJS.ProcessEnv = { ...process.env };
		for (const k of ["PI_ROOST_PARENT_PID", "PI_ROOST_HOME"]) delete clean[k];
		const out = execFileSync("sh", ["-c", `"${process.execPath}" "${script}" >/dev/null 2>&1 & echo $!`], { encoding: "utf8", env: { ...clean, ...env } });
		const pid = Number(out.trim());
		orphanPids.push(pid);
		return pid;
	}

	it("kills a marked process whose parent is gone, spares live-parent and unmarked ones", async () => {
		const dead = helper();
		process.kill(dead.pid!, "SIGKILL");
		await waitFor(() => gone(dead.pid!));
		const live = helper();
		const orphan = fake({ PI_ROOST_PARENT_PID: String(dead.pid) });
		const followed = fake({ PI_ROOST_PARENT_PID: String(live.pid) });
		const unmarked = fake({ PI_ROOST_HOME: join(tmpdir(), "other-home") });
		await settle();
		const killed = sweepOrphans();
		expect(killed).toContain(orphan.pid);
		await waitFor(() => gone(orphan.pid!));
		expect(killed).not.toContain(followed.pid);
		expect(killed).not.toContain(unmarked.pid);
		expect(pidAlive(followed.pid!)).toBe(true);
		expect(pidAlive(unmarked.pid!)).toBe(true);
	});

	it("kills a process marked only by a test home once it is an orphan; spares one whose parent is alive (a run from before M78 in progress)", async () => {
		const running = fake({ PI_ROOST_HOME: join(tmpdir(), "roost-running") });
		const left = orphanFake({ PI_ROOST_HOME: join(tmpdir(), "roost-leftover") });
		await settle();
		const killed = sweepOrphans();
		expect(killed).toContain(left);
		expect(killed).not.toContain(running.pid);
		await waitFor(() => gone(left));
		expect(pidAlive(running.pid!)).toBe(true);
	});

	// a host killed while it starts its worker leaves node-pty's helper waiting for ever
	it("kills node-pty's helper left an orphan in a test's directory; spares one with a parent, or elsewhere", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-fake-"));
		fakeDirs.push(dir);
		const bin = join(dir, "node_modules", "node-pty", "prebuilds", "x", "spawn-helper");
		mkdirSync(join(dir, "node_modules", "node-pty", "prebuilds", "x"), { recursive: true });
		writeFileSync(bin, "setInterval(() => {}, 1000);\n");
		const testCwd = join(tmpdir(), "roost-w-left");
		const helperAt = (cwd: string, orphan: boolean): number => {
			if (!orphan) {
				const p = spawn(process.execPath, [bin, cwd, "/bin/sh", "-c", "sleep 30"], { stdio: "ignore" });
				procs.push(p);
				return p.pid!;
			}
			const out = execFileSync("sh", ["-c", `"${process.execPath}" "${bin}" "${cwd}" /bin/sh -c "sleep 30" >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
			const pid = Number(out.trim());
			orphanPids.push(pid);
			return pid;
		};
		const left = helperAt(testCwd, true);
		const withParent = helperAt(testCwd, false);
		const elsewhere = helperAt("/Users/someone/project", true);
		await settle();
		const killed = sweepOrphans();
		expect(killed).toContain(left);
		await waitFor(() => gone(left));
		expect(killed).not.toContain(withParent);
		expect(pidAlive(withParent)).toBe(true);
		expect(killed).not.toContain(elsewhere);
		expect(pidAlive(elsewhere)).toBe(true);
	});
});
