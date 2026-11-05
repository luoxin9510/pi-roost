import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONCIERGE_DEFAULTS, conciergeFrom, conciergeSystemPrompt, digestText, fleetLine, heartbeatMs } from "../lib/concierge.ts";
import { loadConfig } from "../lib/config.ts";
import type { JobRow } from "../lib/protocol.ts";
import { HUB_TOOLS, isConciergeRole, registerConcierge } from "../adapters/pi/concierge.ts";

const row = (over: Partial<JobRow> = {}): JobRow => ({
	id: "j1",
	cwd: "/w",
	kind: "pi",
	startedAt: 1000,
	state: "working",
	pid: 42,
	status: "busy",
	waitingFor: null,
	sessionFile: "/s/j1.jsonl",
	name: "fix tests",
	endedAt: null,
	summary: "running vitest",
	question: null,
	choices: [],
	model: "anthropic/claude-haiku-5-5",
	thinking: "off",
	context: null,
	error: null,
	stateSince: 0,
	reaped: false,
	pinned: false,
	order: null,
	orderKey: null,
	...over,
});

describe("M44: the concierge's pieces", () => {
	it("takes the settings it understands, with the defaults for the rest", () => {
		expect(conciergeFrom(undefined)).toBeUndefined();
		expect(conciergeFrom("x")).toBeUndefined();
		expect(conciergeFrom({})).toEqual(CONCIERGE_DEFAULTS);
		expect(conciergeFrom({ model: "openai/gpt-5-mini", thinking: "low", wakesPerHour: 10, heartbeat: "every 5m", dailyBudgetUsd: 0.5 })).toEqual({
			model: "openai/gpt-5-mini",
			thinking: "low",
			wakesPerHour: 10,
			heartbeat: "every 5m",
			dailyBudgetUsd: 0.5,
			answer: "never",
		});
		// what does not parse keeps the default: a model without a provider, a cron heartbeat, a negative budget
		expect(conciergeFrom({ model: "haiku", heartbeat: "daily 09:00", dailyBudgetUsd: -1, wakesPerHour: 0, answer: "always" })).toEqual(CONCIERGE_DEFAULTS);
		expect(conciergeFrom({ heartbeat: "off" })?.heartbeat).toBe("off");
		expect(heartbeatMs(CONCIERGE_DEFAULTS)).toBe(15 * 60_000);
		expect(heartbeatMs({ ...CONCIERGE_DEFAULTS, heartbeat: "off" })).toBeNull();
		expect(heartbeatMs({ ...CONCIERGE_DEFAULTS, heartbeat: "nonsense" })).toBeNull();
	});

	it("the digest: what happened, one line each, and the fleet; a heartbeat says nothing happened", () => {
		const now = 10 * 60_000;
		const d = digestText({
			why: "events",
			events: [
				{ seq: 7, at: now - 120_000, kind: "state", id: "j1", name: "fix tests", state: "blocked", from: "working", waitingFor: "question", text: "Which branch?" },
				{ seq: 8, at: now - 60_000, kind: "message", id: "j2", name: "api", who: "lead", text: "status?" },
			],
			rows: [row({ state: "blocked", waitingFor: "question", question: "Which branch?", stateSince: now - 120_000 }), row({ id: "j2", name: "api", summary: "writing the handler", stateSince: now - 5 * 60_000 })],
			sinceAt: now - 300_000,
			now,
		});
		expect(d.startsWith('<roost-digest why="events">')).toBe(true);
		expect(d).toContain("2 events since your last wake 5m ago.");
		expect(d).toContain("- 2m ago: fix tests asks: Which branch? [j1]");
		expect(d).toContain("- 1m ago: lead → api: status? [j2]");
		expect(d).toContain("The fleet (2 sessions):");
		expect(d).toContain("- j1  fix tests  waits for question 2m  asks: Which branch?");
		expect(d).toContain("- j2  api  working 5m  writing the handler");
		expect(d.endsWith("</roost-digest>")).toBe(true);
		const h = digestText({ why: "heartbeat", events: [], rows: [], sinceAt: null, now });
		expect(h).toContain("heartbeat.");
		expect(h).toContain("Nothing happened since.");
		expect(h).toContain("- none");
		// a failed row says its error; a working row without a process says so
		expect(fleetLine(row({ state: "failed", error: "exit 1", pid: null, stateSince: now }), now)).toBe("j1  fix tests  failed 0s  error: exit 1");
		expect(fleetLine(row({ pid: null, stateSince: now }), now)).toContain("(no process)");
	});

	it("the system prompt says what it is, what it may not do, and how the user reaches it", () => {
		const p = conciergeSystemPrompt(CONCIERGE_DEFAULTS);
		expect(p).toContain("You are the concierge of pi-roost");
		expect(p).toContain("Never answer a session's question in its place");
		expect(p).toContain("cannot approve anything");
		expect(p).toContain("hub_notify is how you reach the user");
		expect(p).not.toContain("\n\n\n");
	});
});

describe("M44: the concierge in roost.json", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "roost-cc-"));
		process.env.PI_ROOST_CONFIG_DIR = dir;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.PI_ROOST_CONFIG_DIR;
	});

	it("is the user's setting, never a project's", () => {
		expect(loadConfig(dir).concierge).toBeUndefined();
		writeFileSync(join(dir, "roost.json"), JSON.stringify({ concierge: { wakesPerHour: 5 } }));
		expect(loadConfig(dir).concierge).toEqual({ ...CONCIERGE_DEFAULTS, wakesPerHour: 5 });
		mkdirSyncSafe(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "roost.json"), JSON.stringify({ concierge: { dailyBudgetUsd: 1000, model: "x/y" } }));
		expect(loadConfig(dir).concierge).toEqual({ ...CONCIERGE_DEFAULTS, wakesPerHour: 5 });
	});
});

function mkdirSyncSafe(p: string): void {
	mkdirSync(p, { recursive: true });
}

describe("M44: the concierge's role in pi", () => {
	type Handler = (event: any, ctx?: any) => unknown;
	function fakePi() {
		const handlers = new Map<string, Handler[]>();
		const tools: string[] = [];
		const renderers: string[] = [];
		let active: string[] | undefined;
		const pi = {
			on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
			registerTool: (t: { name: string }) => tools.push(t.name),
			registerMessageRenderer: (type: string) => renderers.push(type),
			setActiveTools: (names: string[]) => {
				active = names;
			},
		};
		const emit = async (name: string, event: any = {}, ctx?: any) => {
			const out: unknown[] = [];
			for (const h of handlers.get(name) ?? []) out.push(await h(event, ctx));
			return out;
		};
		return { pi: pi as any, emit, tools, renderers, active: () => active };
	}

	it("is chosen by the job's environment", () => {
		expect(isConciergeRole({})).toBe(false);
		expect(isConciergeRole({ ROOST_ROLE: "concierge" })).toBe(true);
	});

	it("registers the hub's tools, replaces the system prompt, keeps pi's tools off, and hands a plain answer to the hub", async () => {
		const calls: { op: string; args: unknown }[] = [];
		const link = { call: async (op: string, args: unknown) => (calls.push({ op, args }), {} as never) };
		const { pi, emit, tools, renderers, active } = fakePi();
		registerConcierge(pi, link as never);
		expect(tools).toEqual([...HUB_TOOLS]);
		expect(renderers).toEqual(["pi-roost-agent-message"]);
		await emit("session_start", {});
		expect(active()).toEqual([...HUB_TOOLS]);
		const [r] = await emit("before_agent_start", { systemPrompt: "pi's own" });
		expect((r as { systemPrompt: string }).systemPrompt).toContain("You are the concierge of pi-roost");
		// a turn a digest started (a custom message): its text goes nowhere
		const branch = (last: { role: string; content: unknown }[]) => ({ sessionManager: { getBranch: () => last.map((m) => ({ type: "message", message: m })) } });
		await emit("agent_start", {});
		await emit("message_end", { message: { role: "custom", content: "<roost-digest>" } });
		await emit("agent_settled", { aborted: false }, branch([{ role: "custom", content: "<roost-digest>" }, { role: "assistant", content: [{ type: "text", text: "nothing to report" }] }]));
		expect(calls).toEqual([]);
		// a turn the user's question started: its last text is the answer
		await emit("agent_start", {});
		await emit("message_end", { message: { role: "user", content: "what is blocked?" } });
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "let me look" }] } });
		await emit("agent_settled", { aborted: false }, branch([{ role: "user", content: "what is blocked?" }, { role: "assistant", content: [{ type: "text", text: "api waits for a branch name." }] }]));
		expect(calls).toEqual([{ op: "concierge-say", args: { kind: "answer", text: "api waits for a branch name." } }]);
		// an aborted one is not
		await emit("agent_start", {});
		await emit("message_end", { message: { role: "user", content: "and now?" } });
		await emit("agent_settled", { aborted: true }, branch([{ role: "user", content: "and now?" }, { role: "assistant", content: "half" }]));
		expect(calls).toHaveLength(1);
	});
});
