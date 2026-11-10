import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";

/**
 * M78: test-mode only. PI_ROOST_PARENT_PID is set by the tests and the stress runner, never in
 * normal use: the daemon and its hosts follow that process and go when it is gone.
 */
export function followedParent(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const n = Number(env.PI_ROOST_PARENT_PID);
	return Number.isInteger(n) && n > 1 ? n : undefined;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const ROOT_RE = /(?:^|[\s/])(?:daemon\/main\.ts|host\/main\.ts|stress\/agent\.ts)(?:\s|$)/;
/** node-pty's helper as a host starts a worker: `…/node-pty/…/spawn-helper <cwd> <command…>`. */
const HELPER_RE = /(?:^|\/)node-pty\/\S*\/spawn-helper\s+(\S+)/;

function tmpRoots(): string[] {
	const roots = new Set<string>(["/tmp", "/private/tmp", tmpdir()]);
	for (const r of [...roots]) {
		try {
			roots.add(realpathSync(r));
		} catch {}
	}
	return [...roots].map((r) => r.replace(/\/+$/, ""));
}

/** PI_ROOST_HOME in the OS temp dir with a test prefix: `<tmp>/roost-...`. */
export function isTestHome(home: string | undefined): boolean {
	if (!home) return false;
	return tmpRoots().some((r) => home.startsWith(`${r}${sep}roost-`));
}

/** The environment of a process of ours, or undefined where it cannot be read. */
function envOf(pid: number): Record<string, string> | undefined {
	try {
		if (process.platform === "linux") {
			const out: Record<string, string> = {};
			for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
				const i = kv.indexOf("=");
				if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
			}
			return out;
		}
		if (process.platform === "darwin") {
			const line = execFileSync("ps", ["eww", "-o", "pid=,command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
			const out: Record<string, string> = {};
			for (const name of ["PI_ROOST_PARENT_PID", "PI_ROOST_HOME"]) {
				const m = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(line);
				if (m) out[name] = m[1]!;
			}
			return out;
		}
	} catch {}
	return undefined;
}

interface Proc {
	pid: number;
	ppid: number;
	command: string;
}

function listProcs(): Proc[] {
	try {
		const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
		const procs: Proc[] = [];
		for (const l of out.split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
			if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
		}
		return procs;
	} catch {
		return [];
	}
}

/**
 * M78: kills what earlier test and stress runs left behind: daemon/host/stress-agent processes
 * that carry a test marker (PI_ROOST_PARENT_PID, or PI_ROOST_HOME under the temp dir as
 * `roost-*`) and whose followed parent is gone (marked by its home only: whose own parent is
 * gone, its parent pid 1). Never touches a process without a marker, nor one whose parent is
 * alive (another run in progress). Also node-pty's helper left an orphan in a test's directory
 * (M78, after review: a host killed while it started its worker). Returns the pids killed.
 */
export function sweepOrphans(log: (line: string) => void = () => {}): number[] {
	const procs = listProcs();
	const mine = new Set<number>([process.pid, process.ppid]);
	const killed: number[] = [];
	for (const p of procs) {
		if (mine.has(p.pid) || !ROOT_RE.test(p.command)) continue;
		const env = envOf(p.pid);
		if (!env) continue;
		const raw = env.PI_ROOST_PARENT_PID ? Number(env.PI_ROOST_PARENT_PID) : undefined;
		// a value that names no process to follow counts as no value (the home marker's rule)
		const parent = raw !== undefined && Number.isInteger(raw) && raw > 1 ? raw : undefined;
		const marked = parent !== undefined || isTestHome(env.PI_ROOST_HOME);
		if (!marked) continue;
		if (parent !== undefined && pidAlive(parent)) continue;
		// marked by its home only (a run from before M78, maybe in another checkout): only once it
		// is an orphan; one with a live parent is a run in progress
		if (parent === undefined && p.ppid !== 1) continue;
		// a host's worker goes with it: it would only be adopted by init
		const kids = /host\/main\.ts/.test(p.command) ? procs.filter((c) => c.ppid === p.pid).map((c) => c.pid) : [];
		for (const pid of [p.pid, ...kids]) {
			// a worker leads its own process group (what it started is in it)
			if (pid !== p.pid) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {}
			}
			try {
				process.kill(pid, "SIGKILL");
				killed.push(pid);
			} catch {}
		}
	}
	// node-pty's helper of a host killed mid-start (a test's SIGKILL) waits for it for ever: an
	// orphan whose worker's directory is a test's (`<tmp>/roost-*`) goes too
	for (const p of procs) {
		const m = HELPER_RE.exec(p.command);
		if (!m || p.ppid !== 1 || mine.has(p.pid) || !isTestHome(m[1])) continue;
		try {
			process.kill(p.pid, "SIGKILL");
			killed.push(p.pid);
		} catch {}
	}
	if (killed.length > 0) log(`swept ${killed.length} leftover test process(es): ${killed.join(" ")}`);
	return killed;
}
