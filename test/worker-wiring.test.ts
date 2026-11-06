import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	process.env.PI_ROOST_HOME = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_JOB_DIR;
	delete process.env.PI_ROOST_CONFIG_DIR;
	delete process.env.PI_ROOST_HOME;
});

function fakePi(commands: unknown[] = []) {
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
		getCommands: (): unknown[] => commands,
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

	it("M61: session_start writes the session's commands to commands.json, bounded, and never breaks the worker", async () => {
		const many = Array.from({ length: 400 }, (_, i) => ({ name: `c${i}`, description: i === 0 ? `${"long ".repeat(100)}\nsecond line` : "d", source: "extension", sourceInfo: {} }));
		const { pi, emit } = fakePi(many);
		registerWorker(pi, { id: "j2", token: "t", socket: join(dir, "no-daemon.sock") });
		mkdirSync(join(dir, "jobs", "j2"), { recursive: true });
		const ctx = { hasUI: false, cwd: dir, model: undefined, sessionManager: { getSessionName: () => undefined, getBranch: () => [], getSessionFile: () => undefined } };
		await emit("session_start", { reason: "startup" }, ctx);
		const list = JSON.parse(readFileSync(join(dir, "jobs", "j2", "commands.json"), "utf8")) as { name: string; description?: string; source: string }[];
		expect(list).toHaveLength(300);
		expect(list[0]!.description!.length).toBeLessThanOrEqual(200);
		expect(list[0]!.description).not.toContain("\n");
		expect(list[1]).toEqual({ name: "c1", description: "d", source: "extension" });
		await emit("session_shutdown");
		// getCommands throwing, or no job directory: the worker carries on
		const bad = fakePi();
		bad.pi.getCommands = () => {
			throw new Error("boom");
		};
		registerWorker(bad.pi, { id: "j3", token: "t", socket: join(dir, "no-daemon.sock") });
		await expect(bad.emit("session_start", { reason: "startup" }, ctx)).resolves.toBeUndefined();
		expect(existsSync(join(dir, "jobs", "j3", "commands.json"))).toBe(false);
		await bad.emit("session_shutdown");
	});
});
