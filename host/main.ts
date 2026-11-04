import { appendFileSync, chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import xterm from "@xterm/headless";
import pty from "node-pty";
import { writeFileAtomic, writeJsonAtomic } from "../lib/atomic.ts";
import { FrameDecoder, FrameType, encodeFrame, encodeJsonFrame, parseJsonPayload } from "../lib/framing.ts";
import { REPAINT_MARKER } from "../lib/attach.ts";
import { daemonSocketPath, ensureDirs, hostSocketPath, jobDir } from "../lib/paths.ts";
import { launchCommand, readJob, readState, screenPath, writeExit, writeWorker } from "../lib/store.ts";
import { envKept, workspaceEnv } from "../lib/workspace-env.ts";

const { Terminal } = xterm;

const id = process.argv[2];
if (!id) {
	console.error("usage: host <jobId>");
	process.exit(2);
}

const logFile = join(jobDir(id), "host.log");
function log(msg: string, extra: Record<string, unknown> = {}): void {
	try {
		appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), msg, ...extra })}\n`);
	} catch {}
}

process.on("uncaughtException", (err) => log("uncaughtException", { error: String(err?.stack ?? err) }));
process.on("unhandledRejection", (err) => log("unhandledRejection", { error: String(err) }));
process.on("SIGPIPE", () => {});

const job = readJob(id);
if (!job) {
	console.error(`no such job: ${id}`);
	process.exit(1);
}
ensureDirs();

function fixSpawnHelper(): void {
	try {
		const pkg = createRequire(import.meta.url).resolve("node-pty/package.json");
		const root = dirname(pkg);
		const candidates = [
			join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
			join(root, "build", "Release", "spawn-helper"),
		];
		for (const file of candidates) {
			try {
				if (!existsSync(file)) continue;
				if ((statSync(file).mode & 0o111) !== 0o111) chmodSync(file, 0o755);
			} catch {}
		}
	} catch {}
}
fixSpawnHelper();

let cols = 120;
let rows = 30;
const launchState = readState(id);
const token = launchState?.jobToken;
// A shell job has no worker: a pi started inside it must not report as this job.
const identity: Record<string, string> =
	job.kind === "shell"
		? {}
		: {
				PI_JOB_ID: id,
				...(typeof token === "string" ? { PI_JOB_TOKEN: token } : {}),
				PI_DAEMON_SOCK: daemonSocketPath(),
				PI_JOB_DIR: jobDir(id),
			};
// M20: the workspace's own environment (direnv, mise, fnm ...), evaluated at every start
const workspace = job.workspaceEnv
	? await workspaceEnv(job.cwd, job.env, job.workspaceEnv, (k) => envKept(k, job.envDeny))
	: { env: job.env, via: "none" as const };
if (job.workspaceEnv) log("workspace env", { mode: job.workspaceEnv, via: workspace.via });
const env: Record<string, string> = {
	...workspace.env,
	PWD: job.cwd,
	TERM: "xterm-256color",
	...identity,
	// respawned with nothing new to do: the worker shows where the session left off
	...(launchState?.restore === true ? { PI_ROOST_RESTORE: "1" } : {}),
};

const command = launchCommand(job, launchState);
const [file, ...args] = command;
let proc: pty.IPty;
try {
	proc = pty.spawn(file!, args, { name: "xterm-256color", cols, rows, cwd: job.cwd, env });
} catch (err) {
	log("spawn failed", { error: String(err) });
	writeExit(id, { code: 1, signal: null, at: Date.now() });
	process.exit(1);
}
log("spawned", { pid: proc.pid, command });
try {
	writeWorker(id, proc.pid);
} catch {}

const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
// M15: while nobody is attached the program's terminal queries (device attributes, cursor
// position) are answered here, as a terminal would; attached, the user's terminal answers
term.onData((reply) => {
	// while the attach waits for the repaint (M14) the user's terminal does not see the queries
	if ((attached && !attached.hold) || !workerAlive) return;
	try {
		proc.write(reply);
	} catch {}
});
let dirty = false;
let workerAlive = true;

function screenText(): string {
	const buf = term.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < term.rows; y++) {
		lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function flushScreen(): void {
	try {
		writeFileAtomic(screenPath(id!), screenText());
		dirty = false;
	} catch (err) {
		log("screen write failed", { error: String(err) });
	}
}

const screenTimer = setInterval(() => {
	if (dirty) flushScreen();
}, 2000);

function resizeAll(c: number, r: number): void {
	if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1 || c > 1000 || r > 1000) return;
	cols = c;
	rows = r;
	try {
		proc.resize(c, r);
	} catch {}
	term.resize(c, r);
	dirty = true;
}

interface Attach {
	sock: Socket;
	decoder: StringDecoder;
	/** M14: output held back until the worker's repaint marker. */
	hold?: { carry: string; timer: NodeJS.Timeout };
}
let attached: Attach | undefined;
// nobody watches a new worker yet (a previous host may have died attached)
try {
	writeJsonAtomic(join(jobDir(id), "attached.json"), { attached: false, at: Date.now() });
} catch {}

/** Record who is watching; a worker that asked for it hears about changes (AT-5). */
function setAttached(a: Attach | undefined): void {
	const was = attached !== undefined;
	attached = a;
	const now = a !== undefined;
	if (was === now) return;
	try {
		// a file of its own: the daemon rewrites state.json on every report
		writeJsonAtomic(join(jobDir(id), "attached.json"), { attached: now, at: Date.now() });
		if (readState(id)?.attachSignal === true && workerAlive) proc.kill("SIGUSR2");
	} catch (err) {
		log("attach signal failed", { error: String(err) });
	}
}

proc.onData((data) => {
	term.write(data, () => {
		dirty = true;
	});
	const a = attached;
	if (!a || a.sock.destroyed) return;
	let out = data;
	if (a.hold) {
		// M14: what the worker drew before its repaint was for a screen the user is not on
		const buf = a.hold.carry + data;
		const at = buf.indexOf(REPAINT_MARKER);
		if (at < 0) {
			a.hold.carry = buf.slice(-(REPAINT_MARKER.length - 1));
			return;
		}
		releaseHold(a);
		out = buf.slice(at + REPAINT_MARKER.length);
	}
	out = out.split(REPAINT_MARKER).join("");
	if (out) a.sock.write(encodeFrame(FrameType.DATA, out));
});

const REPAINT_WAIT_MS = 1500;

/** M14: hold output back until the worker's repaint; if it never comes, clear and nudge. */
function holdUntilRepaint(a: Attach): void {
	const timer = setTimeout(() => {
		if (!a.hold) return;
		releaseHold(a);
		log("no repaint after attach, nudging");
		if (attached !== a || a.sock.destroyed) return;
		a.sock.write(encodeFrame(FrameType.DATA, Buffer.from("\x1b[2J\x1b[H")));
		nudge();
	}, REPAINT_WAIT_MS);
	timer.unref?.();
	a.hold = { carry: "", timer };
}

function releaseHold(a: Attach): void {
	if (a.hold) clearTimeout(a.hold.timer);
	a.hold = undefined;
}

/** A redraw for programs that only repaint on a size change. */
function nudge(): void {
	if (!workerAlive || rows <= 1) return;
	const r = rows;
	try {
		proc.resize(cols, r - 1);
	} catch {}
	setTimeout(() => {
		try {
			if (workerAlive) proc.resize(cols, r);
		} catch {}
	}, 30);
}

function kick(a: Attach, reason: "takeover" | "exit" | "request"): void {
	releaseHold(a);
	if (attached === a) setAttached(undefined);
	if (a.sock.destroyed) return;
	a.sock.end(encodeJsonFrame(FrameType.DETACHED, { reason }));
}

let killTimer: NodeJS.Timeout | undefined;
function terminateWorker(): void {
	if (!workerAlive) return;
	try {
		proc.kill("SIGTERM");
	} catch {}
	killTimer ??= setTimeout(() => {
		if (!workerAlive) return;
		try {
			process.kill(proc.pid, "SIGKILL");
		} catch {}
	}, 5000);
}

function control(sock: Socket, op: string): void {
	let reply: unknown;
	switch (op) {
		case "snapshot":
			reply = { text: screenText() };
			break;
		case "status":
			reply = { workerPid: proc.pid, alive: workerAlive, attached: attached !== undefined, cols, rows };
			break;
		case "detach": {
			const a = attached;
			if (a) kick(a, "request");
			reply = { detached: a !== undefined };
			break;
		}
		case "terminate":
			terminateWorker();
			reply = { ok: true };
			break;
		default:
			reply = { error: `unknown op: ${op}` };
	}
	sock.write(encodeJsonFrame(FrameType.REPLY, reply));
}

const sockPath = hostSocketPath(id);
const sockets = new Set<Socket>();

const server = createServer((sock) => {
	sockets.add(sock);
	sock.on("error", (err) => log("socket error", { error: String(err) }));
	sock.on("close", () => {
		sockets.delete(sock);
		if (attached?.sock === sock) setAttached(undefined);
	});
	const decoder = new FrameDecoder();
	let role: "attach" | "control" | undefined;
	let me: Attach | undefined;
	sock.on("data", (chunk) => {
		try {
			for (const frame of decoder.push(chunk)) {
				if (!role) {
					if (frame.type !== FrameType.HELLO) throw new Error("expected HELLO");
					const hello = parseJsonPayload<{ role?: string; cols?: number; rows?: number }>(frame);
					if (hello.role === "control") {
						role = "control";
					} else if (hello.role === "attach") {
						role = "attach";
						if (attached) kick(attached, "takeover");
						me = { sock, decoder: new StringDecoder("utf8") };
						const repaints = workerAlive && readState(id)?.attachRepaint === true;
						// M14: tell the client this host clears for itself when it has to
						sock.write(encodeJsonFrame(FrameType.HELLO, { repaint: repaints }));
						// a blank program (a silent command) must not leave the previous screen showing
						if (!repaints) sock.write(encodeFrame(FrameType.DATA, Buffer.from("\x1b[2J\x1b[H")));
						else holdUntilRepaint(me);
						// the size first: a worker that repaints on the signal draws once, at the right size
						if (hello.cols && hello.rows) resizeAll(hello.cols, hello.rows);
						setAttached(me);
						// M14: a worker that repaints itself needs no nudge; a shell program or an older
						// worker redraws on the size change
						if (!repaints) nudge();
					} else throw new Error("bad role");
					continue;
				}
				if (role === "attach" && me) {
					if (frame.type === FrameType.DATA) {
						if (workerAlive) proc.write(me.decoder.write(frame.payload));
					} else if (frame.type === FrameType.RESIZE) {
						const r = parseJsonPayload<{ cols: number; rows: number }>(frame);
						resizeAll(r.cols, r.rows);
					} else throw new Error(`unexpected frame ${frame.type}`);
				} else if (role === "control" && frame.type === FrameType.CONTROL) {
					control(sock, parseJsonPayload<{ op: string }>(frame).op);
				} else throw new Error(`unexpected frame ${frame.type}`);
			}
		} catch (err) {
			log("client error", { error: String(err) });
			sock.destroy();
		}
	});
});
server.on("error", (err) => log("server error", { error: String(err) }));

try {
	unlinkSync(sockPath);
} catch {}
server.listen(sockPath, () => {
	try {
		chmodSync(sockPath, 0o600);
	} catch {}
	log("listening", { sockPath });
});

let finishing = false;
function finish(): void {
	if (finishing) return;
	finishing = true;
	clearInterval(screenTimer);
	if (killTimer) clearTimeout(killTimer);
	flushScreen();
	if (attached) kick(attached, "exit");
	server.close();
	try {
		unlinkSync(sockPath);
	} catch {}
	const done = () => process.exit(0);
	const safety = setTimeout(done, 1000);
	safety.unref();
	// let DETACHED reach the client before exiting
	setTimeout(() => {
		for (const s of sockets) s.destroy();
		done();
	}, 100);
}

proc.onExit(({ exitCode, signal }) => {
	workerAlive = false;
	log("worker exited", { exitCode, signal });
	try {
		writeExit(id, { code: exitCode, signal: signal ? String(signal) : null, at: Date.now() });
	} catch (err) {
		log("exit write failed", { error: String(err) });
	}
	// let pending terminal writes land before the final snapshot
	term.write("", () => finish());
});

function onSignal(): void {
	log("signal");
	terminateWorker();
	setTimeout(() => process.exit(0), 6000).unref();
}
process.on("SIGTERM", onSignal);
process.on("SIGHUP", onSignal);
