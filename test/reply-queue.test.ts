import { describe, expect, it } from "vitest";
import { ReplyQueue } from "../adapters/pi/worker.ts";

function harness(opts: { setModel?: () => Promise<boolean> } = {}) {
	const sent: { text: string; opts: unknown }[] = [];
	const acks: number[] = [];
	const notes: string[] = [];
	const state = { running: false, idle: true, dialog: false };
	const pi = {
		sendUserMessage: async (text: string, opts: unknown) => {
			sent.push({ text, opts });
		},
		setSessionName: (n: string) => sent.push({ text: `name:${n}`, opts: null }),
		setThinkingLevel: (l: string) => sent.push({ text: `thinking:${l}`, opts: null }),
		setModel: opts.setModel ?? (async () => true),
	};
	const ctx = {
		isIdle: () => state.idle,
		ui: { notify: (m: string) => notes.push(m) },
		modelRegistry: { find: (p: string, id: string) => (p === "x" ? { provider: p, id } : undefined) },
	};
	const q = new ReplyQueue(pi as never, {
		ctx: () => ctx as never,
		running: () => state.running,
		dialogOpen: () => state.dialog,
		ack: (seq) => acks.push(seq),
	});
	return { q, sent, acks, notes, state };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ReplyQueue", () => {
	it("M8: a /model that pi refuses (false or a throw) leaves one note, never a prompt", async () => {
		const no = harness({ setModel: async () => false });
		no.q.add(1, "/model x/m");
		await sleep(10);
		expect(no.notes).toEqual(["pi-roost: cannot switch to x/m: no credentials for x in this session"]);
		expect(no.sent).toEqual([]);
		expect(no.acks).toEqual([1]);
		const boom = harness({ setModel: async () => Promise.reject(new Error("No API key for x/m")) });
		boom.q.add(1, "/model x/m");
		await sleep(10);
		expect(boom.notes).toEqual(["pi-roost: cannot switch model: Error: No API key for x/m"]);
	});

	it("sends the first reply as a prompt, holds the next until the run starts, then follows up", () => {
		const h = harness();
		h.q.add(1, "first");
		h.q.add(2, "second");
		expect(h.sent).toEqual([{ text: "first", opts: { expandPromptTemplates: true } }]);
		expect(h.acks).toEqual([1]);
		h.state.running = true;
		h.state.idle = false;
		h.q.pump(); // agent_start
		expect(h.sent[1]).toEqual({ text: "second", opts: { deliverAs: "followUp", expandPromptTemplates: true } });
		expect(h.acks).toEqual([1, 2]);
	});

	it("M28: a steering reply joins the running turn; one without a mode follows up", () => {
		const h = harness();
		h.state.running = true;
		h.state.idle = false;
		h.q.add({ seq: 1, text: "use pnpm", mode: "steer" });
		h.q.add({ seq: 2, text: "then run the tests" });
		expect(h.sent).toEqual([
			{ text: "use pnpm", opts: { deliverAs: "steer", expandPromptTemplates: true } },
			{ text: "then run the tests", opts: { deliverAs: "followUp", expandPromptTemplates: true } },
		]);
		// idle: either one starts a turn
		const idle = harness();
		idle.q.add({ seq: 1, text: "go", mode: "steer" });
		expect(idle.sent).toEqual([{ text: "go", opts: { expandPromptTemplates: true } }]);
	});

	it("runs settings at once, warns on bad ones, and drops resends", () => {
		const h = harness();
		h.state.running = true;
		h.q.add(1, "/name reset fix");
		h.q.add(2, "/thinking high");
		h.q.add(3, "/thinking loud");
		h.q.add(4, "/model y/z");
		h.q.add(1, "/name reset fix");
		expect(h.sent.map((s) => s.text)).toEqual(["name:reset fix", "thinking:high"]);
		expect(h.notes).toHaveLength(2);
		expect(h.acks).toEqual([1, 2, 3, 4, 1]);
	});

	it("waits behind a dialog and while compacting", async () => {
		const h = harness();
		h.state.dialog = true;
		h.q.add(1, "after the dialog");
		expect(h.sent).toEqual([]);
		h.state.dialog = false;
		h.state.idle = false; // compacting: not running, not idle
		h.q.pump();
		expect(h.sent).toEqual([]);
		h.state.idle = true;
		await sleep(600);
		expect(h.sent.map((s) => s.text)).toEqual(["after the dialog"]);
		expect(h.acks).toEqual([1]);
	});
});

describe("ReplyQueue agent items (M9)", () => {
	function agentHarness(branch: unknown[] = []) {
		const custom: { message: any; opts: any }[] = [];
		const acks: [number, boolean][] = [];
		const state = { running: false, idle: true, dialog: false };
		const pi = {
			sendUserMessage: async () => {},
			sendMessage: async (message: unknown, opts: unknown) => void custom.push({ message, opts }),
		};
		const ctx = { isIdle: () => state.idle, ui: { notify() {} }, sessionManager: { getBranch: () => branch } };
		const q = new ReplyQueue(pi as never, {
			ctx: () => ctx as never,
			running: () => state.running,
			dialogOpen: () => state.dialog,
			ack: (seq, exact) => acks.push([seq, exact === true]),
			jobId: "j1",
		});
		return { q, custom, acks, state, ctx };
	}
	const item = (seq: number, kind: "message" | "report" = "message") => ({ seq, text: `<agent-message>${seq}</agent-message>`, kind, from: "p", relation: "parent" });

	it("starts a run when idle, steers while running, acknowledges only once pi has it", () => {
		const h = agentHarness();
		h.q.add(item(1));
		expect(h.custom[0]!.opts).toEqual({ triggerTurn: true });
		expect(h.custom[0]!.message).toMatchObject({ customType: "pi-roost-agent-message", details: { seq: 1, job: "j1", kind: "message" } });
		expect(h.q.takeAgentStart()).toMatchObject({ seq: 1, relation: "parent" });
		expect(h.acks).toEqual([]);
		h.state.running = true;
		h.state.idle = false;
		h.q.add(item(2, "report"));
		expect(h.custom[1]!.opts).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(h.q.takeAgentStart()).toBeUndefined();
		h.q.messageEnded({ role: "custom", customType: "pi-roost-agent-message", details: { seq: 1 } });
		expect(h.acks).toEqual([[1, true]]);
		h.q.settled();
		expect(h.acks).toEqual([
			[1, true],
			[2, true],
		]);
	});

	it("waits while a dialog is open", () => {
		const h = agentHarness();
		h.state.dialog = true;
		h.q.add(item(3));
		expect(h.custom).toEqual([]);
		h.state.dialog = false;
		h.q.pump();
		expect(h.custom).toHaveLength(1);
	});

	it("applies settings behind a waiting agent item, up to the next user reply", () => {
		const h = agentHarness();
		const names: string[] = [];
		(h.q as any).pi.setSessionName = (n: string) => names.push(n);
		h.state.dialog = true;
		h.q.add(item(1));
		h.q.add({ seq: 2, text: "/name First" });
		h.q.add({ seq: 3, text: "hello" });
		h.q.add({ seq: 4, text: "/name Second" });
		expect(names).toEqual(["First"]);
		expect(h.acks).toEqual([[2, false]]);
		expect(h.custom).toEqual([]);
		// the agent item keeps its place and is still handed over once it may be
		h.state.dialog = false;
		h.q.pump();
		expect(h.custom).toHaveLength(1);
	});

	it("drops a resend the session already holds (after a restart)", () => {
		const h = agentHarness([
			{ type: "custom_message", customType: "pi-roost-agent-message", details: { seq: 7, job: "j1" } },
			// another job of the same session numbered its own items
			{ type: "custom_message", customType: "pi-roost-agent-message", details: { seq: 8, job: "j0" } },
		]);
		h.q.noteSession(h.ctx as never);
		h.q.add(item(7));
		expect(h.custom).toEqual([]);
		expect(h.acks).toEqual([[7, true]]);
		h.q.add(item(8));
		expect(h.custom).toHaveLength(1);
	});
});
