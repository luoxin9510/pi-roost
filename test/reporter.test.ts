import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reporter } from "../extensions/worker.ts";
import { encodeLine, LineReader, type WorkerReport } from "../lib/protocol.ts";

const base: WorkerReport = {
	state: "working",
	status: "busy",
	waitingFor: null,
	summary: "running bash",
	question: null,
	choices: [],
	tool: "bash",
	error: null,
	name: null,
	model: null,
};

let dir: string;
let sock: string;
let server: Server | undefined;
let received: WorkerReport[] = [];
let delayMs = 0;

function listen(): Promise<void> {
	return new Promise((resolve) => {
		server = createServer((s: Socket) => {
			const reader = new LineReader();
			s.on("data", (chunk) => {
				for (const line of reader.push(chunk)) {
					const msg = JSON.parse(line);
					received.push(msg.args.report);
					setTimeout(() => s.write(encodeLine({ id: msg.id, ok: true, result: {} })), delayMs);
				}
			});
			s.on("error", () => {});
		});
		server.listen(sock, () => resolve());
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
	dir = mkdtempSync("/tmp/rp-");
	sock = join(dir, "d.sock");
	received = [];
	delayMs = 0;
});

afterEach(async () => {
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = undefined;
	rmSync(dir, { recursive: true, force: true });
});

describe("Reporter", () => {
	it("sends state changes at once, one request at a time, latest wins", async () => {
		await listen();
		delayMs = 100;
		const r = new Reporter({ id: "j", token: "t", socket: sock });
		r.update(base);
		await sleep(20);
		r.update({ ...base, state: "blocked", status: "waiting", waitingFor: "dialog", tool: null });
		r.update({ ...base, state: "done", status: "idle", tool: null });
		await sleep(400);
		expect(received.map((x) => x.state)).toEqual(["working", "done"]);
		await r.close();
	});

	it("throttles row-text-only changes", async () => {
		await listen();
		const r = new Reporter({ id: "j", token: "t", socket: sock });
		r.update(base);
		await sleep(50);
		r.update({ ...base, summary: "still running bash" });
		await sleep(100);
		expect(received).toHaveLength(1);
		await r.close();
		// close flushes what is pending
		expect(received.at(-1)?.summary).toBe("still running bash");
	});

	it("retries until the daemon is back, then sends the newest report", async () => {
		const r = new Reporter({ id: "j", token: "t", socket: sock });
		r.update(base);
		r.update({ ...base, state: "done", status: "idle", tool: null });
		await sleep(200);
		await listen();
		await sleep(1500);
		expect(received.map((x) => x.state)).toEqual(["done"]);
		await r.close();
	});

	it("close gives up after a bounded wait when nobody listens", async () => {
		const r = new Reporter({ id: "j", token: "t", socket: sock });
		r.update(base);
		const t0 = Date.now();
		await r.close();
		expect(Date.now() - t0).toBeLessThan(1500);
	});
});
