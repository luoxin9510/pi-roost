import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameDecoder, FrameType, encodeFrame, encodeJsonFrame, parseJsonPayload } from "../lib/framing.ts";
import { connectHost, hostControl } from "../lib/hostclient.ts";
import { newJobId } from "../lib/ids.ts";
import { ensureDirs, hostSocketPath } from "../lib/paths.ts";
import { type JobRecord, createJob, updateState } from "../lib/store.ts";

// M22: attach/detach under stress. A worker that keeps printing and echoes what it is
// sent; clients come and go quickly, take over each other mid-snapshot, vanish without a
// goodbye, resize all the time, stop reading. After each round the session must still
// take input and show output. STRESS=1 runs many more rounds.

const ROUNDS = process.env.STRESS === "1" ? 600 : 60;

let home: string;
let rt: string;
let hosts: ChildProcess[] = [];
let socks: Socket[] = [];
const saved = { home: process.env.PI_ROOST_HOME, rt: process.env.PI_ROOST_RUNTIME_DIR };

async function waitFor<T>(fn: () => T | undefined | false, timeout = 5000, what = "condition"): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-s-"));
	rt = mkdtempSync("/tmp/rt-");
	process.env.PI_ROOST_HOME = home;
	process.env.PI_ROOST_RUNTIME_DIR = rt;
	ensureDirs();
});

afterEach(() => {
	for (const s of socks) s.destroy();
	for (const h of hosts) if (h.exitCode === null) h.kill("SIGKILL");
	socks = [];
	hosts = [];
	rmSync(home, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
	if (saved.home === undefined) delete process.env.PI_ROOST_HOME;
	else process.env.PI_ROOST_HOME = saved.home;
	if (saved.rt === undefined) delete process.env.PI_ROOST_RUNTIME_DIR;
	else process.env.PI_ROOST_RUNTIME_DIR = saved.rt;
});

/** A worker as busy as a streaming pi: a tick line every 10 ms, an echo of each input line, USR2 handled. */
const WORKER = `
let n = 0, usr2 = 0, stopped = false;
process.on("SIGUSR2", () => usr2++);
// ready for SIGUSR2 now (as pi reports attachSignal only once its extension is loaded)
require("node:fs").writeFileSync(process.env.READY_FILE, "");
setInterval(() => { if (!stopped) process.stdout.write("tick " + (n++) + "\\r\\n"); }, 10);
process.stdin.setRawMode?.(true); // as pi: keys arrive as bytes
let buf = "";
process.stdin.on("data", (d) => {
	// as pi on Ctrl+Z: stop the UI (no reading: keys typed meanwhile wait in the terminal),
	// SIGTSTP the group (discarded: an orphaned group), wait for SIGCONT
	if (d.includes(0x1a)) {
		stopped = true;
		process.stdin.pause();
		process.once("SIGCONT", () => { stopped = false; process.stdin.resume(); });
		try { process.kill(0, "SIGTSTP"); } catch {}
		return;
	}
	buf += d.toString();
	let i;
	while ((i = buf.search(/[\\r\\n]/)) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line) process.stdout.write("got:" + line + " usr2:" + usr2 + "\\r\\n");
	}
});
`;

async function startHost(): Promise<{ id: string; child: ChildProcess }> {
	const id = newJobId();
	const now = Date.now();
	const ready = join(home, `ready-${id}`);
	const record: JobRecord = {
		id,
		name: "s",
		cwd: home,
		sessionFile: join(home, "s.jsonl"),
		command: [process.execPath, "-e", WORKER],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", READY_FILE: ready },
		origin: "bg",
		createdAt: now,
		roostVersion: "0.0.0",
	};
	createJob(record, { state: "working", startedAt: now, updatedAt: now });
	const child = spawn(process.execPath, ["host/main.ts", id], { stdio: "ignore", env: process.env });
	hosts.push(child);
	await waitFor(() => existsSync(hostSocketPath(id)), 8000, "host socket");
	// attachSignal: from now on the host signals the worker on every attach and detach, as
	// with pi. Not before its handler is in: SIGUSR2's default action ends the process (on
	// Linux an attach right after the host listens beat node's start-up)
	await waitFor(() => existsSync(ready), 8000, "worker ready");
	updateState(id, { attachSignal: true });
	return { id, child };
}

interface Client {
	sock: Socket;
	text: () => string;
	detached: () => string | undefined;
	closed: () => boolean;
}

function watch(sock: Socket): Client {
	const dec = new FrameDecoder();
	let text = "";
	let detached: string | undefined;
	let closed = false;
	sock.on("data", (chunk) => {
		for (const f of dec.push(chunk)) {
			if (f.type === FrameType.DATA) text += f.payload.toString("utf8");
			else if (f.type === FrameType.DETACHED) detached = parseJsonPayload<{ reason: string }>(f).reason;
		}
		// keep memory flat over many rounds: only the recent output matters
		if (text.length > 200_000) text = text.slice(-50_000);
	});
	sock.on("close", () => (closed = true));
	sock.on("error", () => {});
	socks.push(sock);
	return { sock, text: () => text, detached: () => detached, closed: () => closed };
}

const attach = async (id: string, cols = 80, rows = 24) => watch(await connectHost(id, { role: "attach", cols, rows }));

/** The session answers: input typed now comes back, and the output keeps moving. */
async function responsive(c: Client, tag: string): Promise<void> {
	c.sock.write(encodeFrame(FrameType.DATA, `${tag}\r`));
	await waitFor(() => c.text().includes(`got:${tag}`), 5000, `echo of ${tag}`);
	const at = c.text().length;
	await waitFor(() => c.text().length > at + 20, 3000, `output after ${tag}`);
}

const rnd = (n: number) => Math.floor(Math.random() * n);

/** The session's output stops: nothing new for `ms` (within `timeout`). */
async function still(c: Client, ms: number, timeout: number): Promise<void> {
	const start = Date.now();
	let at = c.text().length;
	let since = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, 20));
		const n = c.text().length;
		if (n !== at) {
			at = n;
			since = Date.now();
		} else if (Date.now() - since >= ms) return;
		if (Date.now() - start > timeout) throw new Error("the output never stopped");
	}
}

/** As waitFor on a terminal's output; a timeout says what the terminal showed last (M42). */
async function waitForOut(out: () => string, fn: () => boolean, timeout: number, what: string): Promise<void> {
	try {
		await waitFor(fn, timeout, what);
	} catch (err) {
		throw new Error(`${(err as Error).message}; the terminal's last output: ${JSON.stringify(out().slice(-800))}`);
	}
}

describe("M22 stress: attach/detach", () => {
	it(
		`${ROUNDS} rounds of attach, takeover, abrupt drops and resizes keep the session alive`,
		async () => {
			const { id, child } = await startHost();
			let c = await attach(id);
			await responsive(c, "first");
			for (let i = 0; i < ROUNDS; i++) {
				const move = rnd(6);
				if (move === 0) {
					// a clean detach, then a new attach
					await hostControl(id, "detach");
					c = await attach(id, 60 + rnd(100), 10 + rnd(50));
				} else if (move === 1) {
					// a takeover while the previous attach's snapshot may still be pending
					const prev = c;
					c = await attach(id, 60 + rnd(100), 10 + rnd(50));
					await waitFor(() => prev.detached() === "takeover" || prev.closed(), 3000, "takeover kick");
				} else if (move === 2) {
					// the client vanishes (a closed terminal), no goodbye
					c.sock.destroy();
					c = await attach(id);
				} else if (move === 3) {
					// resize storm, then input at once
					for (let k = 0; k < 20; k++) c.sock.write(encodeJsonFrame(FrameType.RESIZE, { cols: 40 + rnd(150), rows: 5 + rnd(60) }));
				} else if (move === 4) {
					// two attaches at once, the older one dropped right after its HELLO
					const [a, b] = await Promise.all([attach(id), attach(id)]);
					a.sock.destroy();
					c = b.detached() ? a : b;
					if (c.closed() || c.detached()) c = await attach(id);
				} else {
					// a client that stops reading for a while (a frozen terminal), then a new one
					c.sock.pause();
					await new Promise((r) => setTimeout(r, 30));
					c = await attach(id);
				}
				if (i % 5 === 0 || i === ROUNDS - 1) await responsive(c, `r${i}`);
			}
			const st = (await hostControl(id, "status")) as { alive: boolean; attached: boolean };
			expect(st).toMatchObject({ alive: true, attached: true });
			expect(child.exitCode).toBeNull();
			await hostControl(id, "terminate");
		},
		ROUNDS * 2000,
	);

	it("a flood of output with a client that never reads does not stall the worker or the next attach", async () => {
		const { id } = await startHost();
		const stuck = await attach(id);
		stuck.sock.pause();
		// the worker keeps ticking for a while into a socket nobody reads
		await new Promise((r) => setTimeout(r, 1500));
		const c = await attach(id);
		await responsive(c, "after-flood");
		await hostControl(id, "terminate");
	}, 20_000);

	it("rapid detach/attach bursts with no pause in between end attached and responsive", async () => {
		const { id } = await startHost();
		let c = await attach(id);
		for (let i = 0; i < 50; i++) {
			void hostControl(id, "detach").catch(() => {});
			c = await attach(id, 70 + (i % 30), 20 + (i % 10));
		}
		await responsive(c, "burst");
		const st = (await hostControl(id, "status")) as { attached: boolean };
		expect(st.attached).toBe(true);
		await hostControl(id, "terminate");
	}, 60_000);
});

// The client side: a real terminal (a PTY) whose process attaches, detaches with Ctrl+Z and
// attaches to the other session, over and over, as switching in the agent view does. Each
// time, keys typed in the terminal must reach the session now attached.
describe("M22 stress: switching sessions from one terminal", () => {
	it(
		"Ctrl+Z and attach again, between two sessions, keeps input flowing",
		async () => {
			const pty = await import("node-pty");
			const a = await startHost();
			const b = await startHost();
			const driver = `
				import { attachToHost } from "./lib/attach.ts";
				import { hostSocketPath } from "./lib/paths.ts";
				const ids = ${JSON.stringify([a.id, b.id])};
				for (let i = 0; ; i++) {
					const id = ids[i % 2];
					process.stdout.write("\\r\\n[attach " + id + " #" + i + "]\\r\\n");
					const why = await attachToHost(hostSocketPath(id), { stdin: process.stdin, stdout: process.stdout });
					process.stdout.write("\\r\\n[detached " + why + "]\\r\\n");
				}
			`;
			const term = pty.spawn(process.execPath, ["--input-type=module", "-e", driver], {
				cols: 100,
				rows: 30,
				cwd: process.cwd(),
				env: process.env as Record<string, string>,
			});
			let out = "";
			term.onData((d) => {
				out += d;
				if (out.length > 400_000) out = out.slice(-100_000);
			});
			try {
				const rounds = process.env.STRESS === "1" ? 300 : 40;
				for (let i = 0; i < rounds; i++) {
					const id = i % 2 ? b.id : a.id;
					await waitForOut(() => out, () => out.includes(`[attach ${id} #${i}]`), 5000, `attach #${i}`);
					// type right away: keys may arrive before the host's greeting
					const tag = `k${i}`;
					term.write(`${tag}\r`);
					// (keys typed into this session before its last detach come first on the line)
					await waitForOut(() => out, () => out.includes(`${tag} usr2:`), 5000, `echo of ${tag}`);
					if (i % 7 === 3) term.write(`\x1a`);
					else {
						// a burst of keys then the detach, all in one go
						term.write("xyz");
						term.write("\x1a");
					}
					await waitForOut(() => out, () => out.includes("[detached local]") && out.lastIndexOf("[detached local]") > out.lastIndexOf(`${tag} usr2:`), 5000, `detach #${i}`);
				}
			} finally {
				term.kill();
				await hostControl(a.id, "terminate").catch(() => {});
				await hostControl(b.id, "terminate").catch(() => {});
			}
		},
		process.env.STRESS === "1" ? 600_000 : 120_000,
	);
});

describe("M22: a worker that suspended itself", () => {
	it("is continued by the next attach (pi stops its process group on Ctrl+Z)", async () => {
		const { id } = await startHost();
		const c = await attach(id);
		await responsive(c, "before");
		// a Ctrl+Z that reached the worker (sent past the client's own detach key check)
		c.sock.write(encodeFrame(FrameType.DATA, "\x1a"));
		// stopped: the ticks end (once the worker gets to the key; a loaded machine takes a while)
		await still(c, 300, 5000);
		const d = await attach(id);
		await responsive(d, "after");
		await hostControl(id, "terminate");
	}, 20_000);
});

describe("M22: review fixes", () => {
	it("an attach that was taken over no longer types into or resizes the session", async () => {
		const { id } = await startHost();
		const a = await attach(id, 80, 24);
		await responsive(a, "a1");
		const b = await attach(id, 50, 20);
		await waitFor(() => a.detached() === "takeover", 3000, "takeover");
		a.sock.write(encodeJsonFrame(FrameType.RESIZE, { cols: 100, rows: 40 }));
		a.sock.write(encodeFrame(FrameType.DATA, "stale\r"));
		await responsive(b, "b1");
		expect(b.text()).not.toContain("got:stale");
		expect(await hostControl(id, "status")).toMatchObject({ cols: 50, rows: 20 });
		await hostControl(id, "terminate");
	}, 20_000);

	it("terminate-idle stops a worker only while nobody is attached", async () => {
		const { id, child } = await startHost();
		const a = await attach(id);
		await responsive(a, "x");
		expect(await hostControl(id, "terminate-idle")).toEqual({ ok: false, attached: true });
		expect(child.exitCode).toBeNull();
		await hostControl(id, "detach");
		await waitFor(() => a.detached() === "request", 3000, "detach");
		expect(await hostControl(id, "terminate-idle")).toEqual({ ok: true });
		await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000, "exit");
	}, 20_000);
});

describe("M22: the detach key across chunks", () => {
	it("a Ctrl+Z split over two reads, and one after a paste whose end was lost, still detach", async () => {
		const pty = await import("node-pty");
		const { id } = await startHost();
		const driver = `
			import { attachToHost } from "./lib/attach.ts";
			import { hostSocketPath } from "./lib/paths.ts";
			for (let i = 0; ; i++) {
				process.stdout.write("\\r\\n[attach #" + i + "]\\r\\n");
				const why = await attachToHost(hostSocketPath(${JSON.stringify(id)}), { stdin: process.stdin, stdout: process.stdout });
				process.stdout.write("\\r\\n[detached " + why + " #" + i + "]\\r\\n");
			}
		`;
		const term = pty.spawn(process.execPath, ["--input-type=module", "-e", driver], { cols: 100, rows: 30, cwd: process.cwd(), env: process.env as Record<string, string> });
		let out = "";
		term.onData((d) => {
			out += d;
		});
		try {
			await waitForOut(() => out, () => out.includes("[attach #0]"), 5000, "attach 0");
			await responsiveTerm("a0");
			// kitty Ctrl+Z (Num Lock on) in two reads
			term.write("\x1b[122;");
			await new Promise((r) => setTimeout(r, 80));
			term.write("133u");
			await waitForOut(() => out, () => out.includes("[detached local #0]"), 5000, "split detach");
			await waitForOut(() => out, () => out.includes("[attach #1]"), 5000, "attach 1");
			// a paste start whose end never comes, then (after a pause) Ctrl+Z
			term.write("\x1b[200~pasted text");
			await new Promise((r) => setTimeout(r, 1300));
			term.write("\x1a");
			await waitForOut(() => out, () => out.includes("[detached local #1]"), 5000, "detach after lost paste end");
		} finally {
			term.kill();
			await hostControl(id, "terminate").catch(() => {});
		}
		async function responsiveTerm(tag: string) {
			term.write(`${tag}\r`);
			await waitForOut(() => out, () => out.includes(`${tag} usr2:`), 5000, `echo ${tag}`);
		}
	}, 30_000);
});
