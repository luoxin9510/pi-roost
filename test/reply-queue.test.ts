import { describe, expect, it } from "vitest";
import { ReplyQueue } from "../extensions/worker.ts";

function harness() {
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
		setModel: async () => true,
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
