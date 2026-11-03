import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, writeFileAtomic, writeJsonAtomic } from "../lib/atomic.ts";
import { newJobId, newToken } from "../lib/ids.ts";
import {
	acquireDaemonLock,
	acquireWriterLock,
	readDaemonLock,
	readWriterLock,
	releaseDaemonLock,
	releaseWriterLock,
} from "../lib/locks.ts";
import { daemonLockPath, ensureDirs, hostSocketPath, jobDir, jobsDir, roostHome, runtimeDir } from "../lib/paths.ts";
import { isAlive, processStartToken, sameProcess } from "../lib/proc.ts";
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
	writeExit,
} from "../lib/store.ts";
import { ROOST_VERSION } from "../lib/version.ts";

let home: string;
let rt: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-home-"));
	rt = mkdtempSync("/tmp/rt-");
	process.env.PI_ROOST_HOME = home;
	process.env.PI_ROOST_RUNTIME_DIR = rt;
});

afterEach(() => {
	for (const c of children.splice(0)) c.kill("SIGKILL");
	rmSync(home, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
});

function deadPid(): number {
	const r = spawnSync("true");
	return r.pid;
}

function sleeper(): ChildProcess {
	const c = spawn("sleep", ["5"], { stdio: "ignore" });
	children.push(c);
	return c;
}

describe("paths", () => {
	it("honours env overrides and builds paths", () => {
		expect(roostHome()).toBe(home);
		expect(runtimeDir()).toBe(rt);
		expect(jobDir("abc")).toBe(join(home, "jobs", "abc"));
		expect(hostSocketPath("abc")).toBe(join(rt, "host-abc.sock"));
	});

	it("ensureDirs creates 0700 dirs", () => {
		rmSync(rt, { recursive: true });
		ensureDirs();
		expect(statSync(jobsDir()).mode & 0o777).toBe(0o700);
		expect(statSync(rt).mode & 0o777).toBe(0o700);
	});

	it("ensureDirs rejects a symlinked runtime dir", () => {
		const target = mkdtempSync("/tmp/rt-");
		const link = `${target}-link`;
		rmSync(rt, { recursive: true });
		spawnSync("ln", ["-s", target, link]);
		process.env.PI_ROOST_RUNTIME_DIR = link;
		try {
			expect(() => ensureDirs()).toThrow();
		} finally {
			rmSync(link, { force: true });
			rmSync(target, { recursive: true, force: true });
		}
	});
});

describe("atomic", () => {
	it("writes and reads json, leaving no temp files", () => {
		const f = join(home, "a.json");
		writeJsonAtomic(f, { x: 1 });
		expect(readJson(f)).toEqual({ x: 1 });
		writeFileAtomic(f, new Uint8Array([123, 125]));
		expect(readJson(f)).toEqual({});
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(require_ls(home)).toEqual(["a.json"]);
	});

	it("readJson returns undefined for missing and garbage", () => {
		expect(readJson(join(home, "nope.json"))).toBeUndefined();
		const f = join(home, "bad.json");
		writeFileSync(f, "{not json");
		expect(readJson(f)).toBeUndefined();
	});
});

function require_ls(dir: string): string[] {
	return spawnSync("ls", ["-A", dir], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
}

describe("proc / ids / version", () => {
	it("own pid alive and same process", () => {
		const tok = processStartToken(process.pid);
		expect(tok).toBeTruthy();
		expect(isAlive(process.pid)).toBe(true);
		expect(sameProcess(process.pid, tok as string)).toBe(true);
		expect(sameProcess(process.pid, "bogus")).toBe(false);
	});

	it("dead pid is not alive", () => {
		const pid = deadPid();
		expect(isAlive(pid)).toBe(false);
		expect(processStartToken(pid)).toBeUndefined();
		expect(sameProcess(pid, "x")).toBe(false);
	});

	it("ids have the right shape", () => {
		expect(newJobId()).toMatch(/^[0-9a-f]{8}$/);
		expect(newToken()).toMatch(/^[0-9a-f]{32}$/);
	});

	it("reads the package version", () => {
		expect(ROOST_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("writer lock", () => {
	it("acquires (creating the parent dir), re-acquires, releases", () => {
		const f = join(home, "sessions", "s.jsonl");
		expect(acquireWriterLock(f)).toEqual({ ok: true });
		expect(acquireWriterLock(f)).toEqual({ ok: true });
		expect(readWriterLock(f)?.pid).toBe(process.pid);
		releaseWriterLock(f);
		expect(existsSync(`${f}.lock`)).toBe(false);
		expect(readWriterLock(f)).toBeUndefined();
	});

	it("replaces a stale lock and reads it as undefined", () => {
		const f = join(home, "s.jsonl");
		const lock = { pid: deadPid(), token: "old", at: 1 };
		writeFileSync(`${f}.lock`, JSON.stringify(lock));
		expect(readWriterLock(f)).toBeUndefined();
		expect(acquireWriterLock(f)).toEqual({ ok: true });
		expect(readWriterLock(f)?.pid).toBe(process.pid);
	});

	it("refuses when a live other process holds it", () => {
		const f = join(home, "s.jsonl");
		const c = sleeper();
		const lock = { pid: c.pid as number, token: processStartToken(c.pid as number), at: 1 };
		writeFileSync(`${f}.lock`, JSON.stringify(lock));
		const r = acquireWriterLock(f);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.holder.pid).toBe(c.pid);
		expect(readWriterLock(f)?.pid).toBe(c.pid);
		releaseWriterLock(f); // not ours: must stay
		expect(existsSync(`${f}.lock`)).toBe(true);
	});
});

describe("daemon lock", () => {
	it("acquire stores extras; second acquire from same process is refused", () => {
		ensureDirs();
		expect(acquireDaemonLock({ socket: "s" })).toEqual({ ok: true });
		expect(readDaemonLock()?.socket).toBe("s");
		const r = acquireDaemonLock({});
		expect(r.ok).toBe(false);
		releaseDaemonLock();
		expect(existsSync(daemonLockPath())).toBe(false);
	});

	it("replaces a stale lock", () => {
		ensureDirs();
		writeFileSync(daemonLockPath(), JSON.stringify({ pid: deadPid(), token: "old", at: 1 }));
		expect(acquireDaemonLock({})).toEqual({ ok: true });
		expect(readDaemonLock()?.pid).toBe(process.pid);
	});

	it("refuses when a live other process holds it, and does not release it", () => {
		ensureDirs();
		const c = sleeper();
		const pid = c.pid as number;
		writeFileSync(daemonLockPath(), JSON.stringify({ pid, token: processStartToken(pid), at: 1 }));
		const r = acquireDaemonLock({});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.holder.pid).toBe(pid);
		releaseDaemonLock();
		expect(existsSync(daemonLockPath())).toBe(true);
	});
});

describe("store", () => {
	const record = (id: string): JobRecord => ({
		id,
		name: "n",
		cwd: "/tmp",
		sessionFile: "/tmp/s.jsonl",
		command: ["node", "pi"],
		env: {},
		origin: "bg",
		createdAt: 1,
		roostVersion: ROOST_VERSION,
	});
	const state = (): JobState => ({ state: "working", startedAt: 1, updatedAt: 1 });

	it("create / read / update / exit / list / remove", () => {
		createJob(record("aaaa1111"), { ...state(), extra: "keep" });
		createJob(record("bbbb2222"), state());
		mkdirSync(join(jobsDir(), "junk"));
		expect(statSync(join(jobDir("aaaa1111"), "tmp")).isDirectory()).toBe(true);
		expect(readJob("aaaa1111")?.name).toBe("n");
		expect(listJobIds().sort()).toEqual(["aaaa1111", "bbbb2222"]);

		const next = updateState("aaaa1111", { state: "done", endedAt: 5 });
		expect(next.state).toBe("done");
		expect(next.extra).toBe("keep");
		expect(next.updatedAt).toBeGreaterThan(1);
		expect(readState("aaaa1111")).toEqual(next);

		expect(readExit("aaaa1111")).toBeUndefined();
		writeExit("aaaa1111", { code: 0, signal: null, at: 9 });
		expect(readExit("aaaa1111")).toEqual({ code: 0, signal: null, at: 9 });

		removeJob("aaaa1111");
		expect(listJobIds()).toEqual(["bbbb2222"]);
		expect(readJob("aaaa1111")).toBeUndefined();
	});
});
