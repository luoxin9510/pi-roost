import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWorker } from "../adapters/pi/worker.ts";

type Handler = (event: any, ctx?: any) => unknown;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ww-"));
	process.env.PI_JOB_DIR = dir;
	process.env.PI_ROOST_CONFIG_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_JOB_DIR;
	delete process.env.PI_ROOST_CONFIG_DIR;
});

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const entries: { type: string; data: any }[] = [];
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerCommand() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		registerTool() {},
		getThinkingLevel: () => "off",
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		setSessionName() {},
		sendUserMessage() {},
		getFlag: () => undefined,
	};
	const emit = async (name: string, event: any = {}, ctx?: any) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { pi: pi as any, emit, entries };
}

describe("worker wiring", () => {
	it("the recap sees the tracker's settled state of the same event (questions, tools)", async () => {
		const { pi, emit, entries } = fakePi();
		registerWorker(pi, { id: "j1", token: "t", socket: join(dir, "no-daemon.sock") });
		const ctx = {
			hasUI: false,
			cwd: dir,
			model: undefined,
			sessionManager: { getSessionName: () => undefined, getBranch: () => [], getSessionFile: () => undefined },
		};
		await emit("session_start", { reason: "startup" }, ctx);
		await emit("agent_start");
		await emit("tool_execution_start", { toolName: "bash" });
		await emit("tool_execution_end", { toolName: "bash" });
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Tabs or spaces?" }], stopReason: "stop" } });
		await emit("agent_settled", { aborted: false });
		writeFileSync(join(dir, "attached.json"), JSON.stringify({ attached: true }));
		process.emit("SIGUSR2" as never);
		await new Promise((r) => setTimeout(r, 20));
		expect(entries).toHaveLength(1);
		expect(entries[0]!.data.text).toBe("1 turn finished · tools: bash · asked: Tabs or spaces?");
		await emit("session_shutdown");
	});
});
