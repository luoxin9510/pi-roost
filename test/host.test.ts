import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrameDecoder, FrameType, encodeFrame, parseJsonPayload } from "../lib/framing.ts";
import { connectHost, hostControl } from "../lib/hostclient.ts";
import { newJobId } from "../lib/ids.ts";
import { ensureDirs, hostSocketPath, jobDir } from "../lib/paths.ts";
import { type JobRecord, createJob, exitPath, readExit, screenPath } from "../lib/store.ts";

// The host runs straight from source under Node 24 type stripping. Workers sleep
// 0.5 s before printing: output before the first attach is not replayed (no
// serialize addon), so the client must be connected first.

let home: string;
let rt: string;
let hosts: ChildProcess[] = [];
let socks: Socket[] = [];
const saved = { home: process.env.PI_ROOST_HOME, rt: process.env.PI_ROOST_RUNTIME_DIR };

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeout = 8000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-h-"));
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

async function startHost(script: string): Promise<{ id: string; child: ChildProcess }> {
	const id = newJobId();
	const now = Date.now();
	const record: JobRecord = {
		id,
		name: "t",
		cwd: home,
		sessionFile: join(home, "s.jsonl"),
		command: ["/bin/sh", "-c", script],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		origin: "bg",
		createdAt: now,
		roostVersion: "0.0.0",
	};
	createJob(record, { state: "working", startedAt: now, updatedAt: now });
	const child = spawn(process.execPath, ["host/main.ts", id], { stdio: "ignore", env: process.env });
	hosts.push(child);
	await waitFor(() => existsSync(hostSocketPath(id)));
	return { id, child };
}

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

interface Client {
	sock: Socket;
	text: () => string;
	detached: () => string | undefined;
}

function watch(sock: Socket): Client {
	const dec = new FrameDecoder();
	let text = "";
	let detached: string | undefined;
	sock.on("data", (chunk) => {
		for (const f of dec.push(chunk)) {
			if (f.type === FrameType.DATA) text += f.payload.toString("utf8");
			else if (f.type === FrameType.DETACHED) detached = parseJsonPayload<{ reason: string }>(f).reason;
		}
	});
	socks.push(sock);
	return { sock, text: () => text, detached: () => detached };
}

describe("host", () => {
	it("attach: output, input, exit", async () => {
		const { id, child } = await startHost("sleep 0.5; echo hi; read x; echo got:$x; sleep 0.3");
		const c = watch(await connectHost(id, { role: "attach", cols: 80, rows: 24 }));
		await waitFor(() => c.text().includes("hi"));
		c.sock.write(encodeFrame(FrameType.DATA, "abc\r"));
		await waitFor(() => c.text().includes("got:abc"));
		await waitFor(() => c.detached() === "exit");
		await waitFor(() => exited(child));
		expect(readExit(id)?.code).toBe(0);
		expect(readFileSync(screenPath(id), "utf8")).toContain("got:abc");
		expect(existsSync(hostSocketPath(id))).toBe(false);
	});

	it("takeover and terminate", async () => {
		const { id, child } = await startHost("sleep 0.5; echo ready; sleep 30");
		const a = watch(await connectHost(id, { role: "attach", cols: 80, rows: 24 }));
		await waitFor(() => a.text().includes("ready"));
		const b = watch(await connectHost(id, { role: "attach", cols: 100, rows: 30 }));
		await waitFor(() => a.detached() === "takeover");
		const status = (await hostControl(id, "status")) as { attached: boolean; alive: boolean; cols: number };
		expect(status.attached).toBe(true);
		expect(status.alive).toBe(true);
		expect(status.cols).toBe(100);
		expect(b.detached()).toBeUndefined();
		expect(await hostControl(id, "terminate")).toEqual({ ok: true });
		await waitFor(() => exited(child));
		const ex = readExit(id);
		expect(ex && (ex.signal !== null || ex.code !== 0)).toBe(true);
		expect(existsSync(exitPath(id))).toBe(true);
	});

	it("control snapshot", async () => {
		const { id } = await startHost("sleep 0.5; echo ready; sleep 30");
		const text = await waitFor(async () => {
			const r = (await hostControl(id, "snapshot")) as { text: string };
			return r.text.includes("ready") ? r.text : undefined;
		});
		expect(text.endsWith("\n")).toBe(true);
		expect(await hostControl(id, "detach")).toEqual({ detached: false });
		await hostControl(id, "terminate");
	});

	it("survives garbage from a client", async () => {
		const { id, child } = await startHost("sleep 0.5; echo ready; sleep 30");
		const sock = await connectHost(id, { role: "control" });
		socks.push(sock);
		sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
		await waitFor(() => sock.destroyed);
		// under load the next control connection can race the teardown of the bad one: retry it,
		// while still requiring the host process itself to have survived
		const status = await waitFor(async () => {
			try {
				return (await hostControl(id, "status")) as { alive: boolean };
			} catch {
				return undefined;
			}
		});
		expect(status.alive).toBe(true);
		expect(exited(child)).toBe(false);
		await hostControl(id, "terminate");
		await waitFor(() => exited(child));
		expect(existsSync(jobDir(id))).toBe(true);
	});
});
