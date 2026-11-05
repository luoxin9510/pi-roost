import { appendFileSync, chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import xterm from "@xterm/headless";
import serializeAddon from "@xterm/addon-serialize";
import pty from "node-pty";
import { writeFileAtomic, writeJsonAtomic } from "../lib/atomic.ts";
import { FrameDecoder, FrameType, encodeFrame, encodeJsonFrame, parseJsonPayload } from "../lib/framing.ts";
import { REPAINT_MARKER } from "../lib/attach.ts";
import { ModeTracker, StreamTail } from "../lib/term-modes.ts";
import { daemonSocketPath, ensureDirs, hostSocketPath, jobDir } from "../lib/paths.ts";
import { launchCommand, readJob, readState, screenPath, writeExit, writeWorker } from "../lib/store.ts";
import { envKept, killProbes, workspaceEnv } from "../lib/workspace-env.ts";
import { jobEnv } from "../lib/identity.ts";

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
		: jobEnv({ id, ...(typeof token === "string" ? { token } : {}), socket: daemonSocketPath(), dir: jobDir(id) });
// M20: the workspace's own environment (direnv, mise, fnm ...), evaluated at every start.
// Told to stop meanwhile: the probe goes, and the job ends as one that never ran.
const earlyStop = () => {
	killProbes();
	writeExit(id, { code: null, signal: "SIGTERM", at: Date.now() });
	process.exit(0);
};
process.once("SIGTERM", earlyStop);
process.once("SIGHUP", earlyStop);
const workspace = job.workspaceEnv
	? await workspaceEnv(job.cwd, job.env, job.workspaceEnv, (k) => envKept(k, job.envForce?.includes(k) ? [] : job.envDeny))
	: { env: job.env, via: "none" as const };
if (job.workspaceEnv) log("workspace env", { mode: job.workspaceEnv, via: workspace.via });
process.off("SIGTERM", earlyStop);
process.off("SIGHUP", earlyStop);
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
// M21: an attach starts from this screen, as the program left it (tmux's model)
const serializer = new serializeAddon.SerializeAddon();
term.loadAddon(serializer);
const modes = new ModeTracker();
const tail = new StreamTail();
// M15: while nobody is attached the program's terminal queries (device attributes, cursor
// position) are answered here, as a terminal would; attached, the user's terminal answers
term.onData((reply) => {
	// attached, the user's terminal answers; a query from before the attach's snapshot
	// point never reaches it, so the host still answers until that point is parsed
	if ((attached && !attached.answering) || !workerAlive) return;
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
	// a resize resets the scroll region now: what the program sends for the new size follows
	modes.resized();
	// the mirror takes the size after what it has yet to parse, as a terminal would
	term.write("", () => term.resize(c, r));
	dirty = true;
}

interface Attach {
	sock: Socket;
	decoder: StringDecoder;
	/** M21: output after the snapshot's point, sent once the snapshot is. */
	pending?: string[];
	/** M21: the mirror is still parsing what came before the snapshot point. */
	answering?: boolean;
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
		// replay: the host shows the screen (M21), the worker need not repaint it
		writeJsonAtomic(join(jobDir(id), "attached.json"), { attached: now, at: Date.now(), replay: true });
		if (readState(id)?.attachSignal === true && workerAlive) proc.kill("SIGUSR2");
	} catch (err) {
		log("attach signal failed", { error: String(err) });
	}
}

proc.onData((data) => {
	try {
		term.write(data, () => {
			dirty = true;
		});
	} catch (err) {
		// xterm throws once far behind (tens of MB): the mirror misses this, the client does not
		log("mirror write failed", { error: String(err) });
	}
	modes.feed(data);
	tail.feed(data);
	const a = attached;
	if (!a || a.sock.destroyed) return;
	// an older worker still marks its repaint (M14): the marker is not for the terminal
	const out = data.split(REPAINT_MARKER).join("");
	if (a.pending) a.pending.push(out);
	else if (out) a.sock.write(encodeFrame(FrameType.DATA, out));
});

/** M21: what a terminal may still be in from before (the view, a shell): back to defaults. */
const CLIENT_RESET = "\x1b[0m\x1b[r\x1b[?6l\x1b(B\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?7h\x1b[0 q";

/**
 * M21: the screen as the program left it, for a terminal that has something else on it:
 * the main screen's rows (or, when the program is on its alternate screen, that screen
 * alone: the user's own main screen stays as it is), the cursor, the colours, the modes
 * (serialize's own and the ones ModeTracker follows) and the scroll region. No
 * scrollback: entering a session prints no history into the user's terminal. `extra` is
 * the modes as they were at the snapshot point.
 */
function snapshot(extra: { modes: string; region: [number, number] | undefined }): string {
	let s = serializer.serialize({ scrollback: 0 });
	const buf = term.buffer.active;
	if (buf.type === "alternate") {
		// the main rows would land on the user's own main screen: only the alternate one goes
		const at = s.indexOf("\x1b[?1049h");
		s = `\x1b[?1049h\x1b[H\x1b[2J${at >= 0 ? s.slice(at + "\x1b[?1049h".length) : s}`;
	} else s = `\x1b[H\x1b[2J${s}`;
	let end = "";
	if (extra.region || term.modes.originMode) {
		// DECSTBM and DECOM move the cursor home: put it back (origin mode off while placing it)
		const [top, bottom] = extra.region ?? [1, term.rows];
		end += `\x1b[?6l${extra.region ? `\x1b[${top};${bottom || term.rows}r` : ""}\x1b[${buf.cursorY + 1};${buf.cursorX + 1}H`;
		if (term.modes.originMode) end += `\x1b[?6h\x1b[${buf.cursorY - top + 2};${buf.cursorX + 1}H`;
	}
	return `${CLIENT_RESET}${s}${extra.modes}${end}`;
}

/** M21: send the snapshot once the mirror has every byte that came before the attach. */
function replay(a: Attach): void {
	// all taken at the snapshot point: what follows is in the pending output
	const extra = { modes: modes.restore(), region: modes.scrollRegion() };
	const cut = tail.text();
	a.pending = cut ? [cut] : [];
	a.answering = true;
	term.write("", () => {
		a.answering = false;
		if (attached !== a || a.sock.destroyed) return;
		try {
			a.sock.write(encodeFrame(FrameType.DATA, Buffer.from(snapshot(extra))));
		} catch (err) {
			log("snapshot failed", { error: String(err) });
			a.sock.write(encodeFrame(FrameType.DATA, Buffer.from("\x1b[2J\x1b[H")));
		}
		for (const p of a.pending ?? []) if (p) a.sock.write(encodeFrame(FrameType.DATA, p));
		a.pending = undefined;
	});
}

function kick(a: Attach, reason: "takeover" | "exit" | "request"): void {
	if (attached === a) setAttached(undefined);
	if (a.sock.destroyed) return;
	a.sock.end(encodeJsonFrame(FrameType.DETACHED, { reason }));
}

/**
 * M22: SIGCONT to the worker's process group (it leads its own session in the PTY). pi
 * stops itself on Ctrl+Z, and in the background no shell would ever continue it.
 */
function continueWorker(): void {
	// a shell job's command may be stopped on purpose
	if (!workerAlive || job?.kind === "shell") return;
	try {
		process.kill(-proc.pid, "SIGCONT");
	} catch {
		try {
			process.kill(proc.pid, "SIGCONT");
		} catch {}
	}
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
		case "terminate-idle":
			// M22: the reaper's stop, only while nobody is attached (decided here, atomically)
			if (attached) reply = { ok: false, attached: true };
			else {
				terminateWorker();
				reply = { ok: true };
			}
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
						// M22: the worker has exited and the host is going: say so
						if (finishing) {
							sock.end(encodeJsonFrame(FrameType.DETACHED, { reason: "exit" }));
							return;
						}
						if (attached) kick(attached, "takeover");
						me = { sock, decoder: new StringDecoder("utf8") };
						// M21: the client gets this screen as it is (no clear, no waiting for the worker)
						sock.write(encodeJsonFrame(FrameType.HELLO, { replay: true }));
						// the size first: what the program draws for it follows the snapshot
						if (hello.cols && hello.rows) resizeAll(hello.cols, hello.rows);
						setAttached(me);
						// M22: a worker stopped by a stray Ctrl+Z (pi suspends itself) carries on
						continueWorker();
						replay(me);
					} else throw new Error("bad role");
					continue;
				}
				if (role === "attach" && me) {
					// M22: an attach taken over (or kicked) no longer types or sizes the session
					if (attached !== me) continue;
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
