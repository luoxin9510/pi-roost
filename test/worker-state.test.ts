import { describe, expect, it } from "vitest";
import { extractChoices, lastLine, looksLikeQuestion, messageText } from "../lib/heuristics.ts";
import { stateChanged, WorkerTracker } from "../lib/worker-state.ts";

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	content: [{ type: "text", text }],
	stopReason: "stop",
	...extra,
});

describe("heuristics", () => {
	it("detects questions by trailing ? and by phrases in English and Chinese", () => {
		expect(looksLikeQuestion("I looked at it.\n\nDouble-ended or single-ended reset?")).toBe(true);
		expect(looksLikeQuestion("用哪种复位方式？")).toBe(true);
		expect(looksLikeQuestion("Here is the plan. Would you like me to apply it")).toBe(true);
		expect(looksLikeQuestion("改好了，需要我顺便提交吗")).toBe(true);
		expect(looksLikeQuestion("是否继续")).toBe(true);
		// sign-offs and statements are not questions
		expect(looksLikeQuestion("Done.\nLet me know if you need anything else.")).toBe(false);
		expect(looksLikeQuestion("已确认是否存在该文件。")).toBe(false);
		expect(looksLikeQuestion("I wondered whether I should implement it; I did.")).toBe(false);
		expect(looksLikeQuestion("All 42 tests pass.")).toBe(false);
		expect(looksLikeQuestion('He asked "why?" earlier.\nFixed it.')).toBe(false);
		expect(looksLikeQuestion("")).toBe(false);
	});

	it("extracts numbered choices only from the final block", () => {
		expect(extractChoices("Which one?\n1. double-ended\n2) single-ended")).toEqual(["double-ended", "single-ended"]);
		expect(extractChoices("1. a\n2. b\nthen I stopped.\nAll done.")).toEqual([]);
		expect(extractChoices("Pick:\n1. only")).toEqual([]);
		expect(extractChoices("1. a\n2. b\nWhich one?")).toEqual(["a", "b"]);
		expect(extractChoices("Which one?\n1. a\n2. b\nLet me know.")).toEqual(["a", "b"]);
	});

	it("lastLine strips markdown and skips fences", () => {
		expect(lastLine("## Done\n- **All** tests pass\n```")).toBe("All tests pass");
		expect(lastLine("   \n")).toBeNull();
	});

	it("messageText joins text parts and ignores tool calls", () => {
		expect(messageText({ content: [{ type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }] })).toBe("a\nb");
	});
});

describe("WorkerTracker", () => {
	it("working → done with the last line as summary", () => {
		const t = new WorkerTracker();
		t.start({ name: null, model: "p/m", fresh: true });
		expect(t.report()).toMatchObject({ state: "working", status: "idle" });
		t.agentStart();
		t.toolStart("bash");
		expect(t.report()).toMatchObject({ state: "working", status: "busy", tool: "bash", summary: "running bash" });
		t.toolEnd();
		t.assistantMessage(assistant("Ran the suite.\nAll 42 tests pass."));
		t.agentSettled(false);
		expect(t.report()).toMatchObject({ state: "done", status: "idle", waitingFor: null, summary: "All 42 tests pass.", model: "p/m" });
	});

	it("a question at turn end is blocked/question with choices", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.assistantMessage(assistant("Two options:\nWhich reset?\n1. double\n2. single"));
		t.agentSettled(false);
		expect(t.report()).toMatchObject({
			state: "blocked",
			status: "waiting",
			waitingFor: "question",
			question: "Which reset?",
			summary: "Which reset?",
			choices: ["double", "single"],
		});
	});

	it("model errors make the turn failed; an aborted turn is done", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.assistantMessage({ content: [], stopReason: "error", errorMessage: "429 rate limited" });
		t.agentSettled(false);
		expect(t.report()).toMatchObject({ state: "failed", error: "429 rate limited", summary: "429 rate limited" });
		t.agentStart();
		t.assistantMessage(assistant("Should I continue?"));
		t.agentSettled(true);
		expect(t.report().state).toBe("done");
	});

	it("dialogs block and restore; a dialog from a command alone ends as done", () => {
		const t = new WorkerTracker();
		t.dialogStart("confirm", "Proceed?");
		expect(t.report()).toMatchObject({ state: "blocked", status: "waiting", waitingFor: "dialog", question: "Proceed?", summary: "Proceed?" });
		t.dialogEnd();
		expect(t.report()).toMatchObject({ state: "done", status: "idle" });
		t.agentStart();
		t.dialogStart("select", undefined);
		expect(t.report()).toMatchObject({ waitingFor: "dialog", summary: "waiting in a select dialog" });
		t.dialogEnd();
		expect(t.report()).toMatchObject({ state: "working", status: "busy" });
	});

	it("an empty session without a first prompt waits for one; a resumed one is done", () => {
		const empty = new WorkerTracker();
		empty.firstPromptTimeout(0);
		expect(empty.report()).toMatchObject({ state: "blocked", waitingFor: "first-prompt", summary: "waiting for a first prompt" });
		empty.agentStart();
		expect(empty.report()).toMatchObject({ state: "working", waitingFor: null });

		const resumed = new WorkerTracker();
		resumed.firstPromptTimeout(4);
		expect(resumed.report()).toMatchObject({ state: "done", waitingFor: null });

		const started = new WorkerTracker();
		started.agentStart();
		started.firstPromptTimeout(0);
		expect(started.report()).toMatchObject({ state: "working" });
	});

	it("a retried error that then succeeds is not failed (review B1)", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.assistantMessage({ content: [], stopReason: "error", errorMessage: "429" });
		t.assistantMessage(assistant("Recovered and finished."));
		t.agentSettled(false);
		expect(t.report()).toMatchObject({ state: "done", error: null, summary: "Recovered and finished." });
	});

	it("an earlier question does not leak into a later run without text (review B2)", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.assistantMessage(assistant("Should I proceed?"));
		t.agentSettled(false);
		expect(t.report().state).toBe("blocked");
		t.agentStart();
		t.assistantMessage(assistant("Is this a question?"));
		t.assistantMessage({ content: [{ type: "toolCall" }], stopReason: "toolUse" });
		t.agentSettled(false);
		expect(t.report()).toMatchObject({ state: "done", question: null });
	});

	it("/new, /resume and /fork start fresh, a reload keeps the run (review B3)", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.assistantMessage(assistant("Should I proceed?"));
		t.agentSettled(false);
		t.start({ name: "x", model: null, fresh: true });
		expect(t.report()).toMatchObject({ state: "working", status: "idle", question: null, summary: null });
		t.firstPromptTimeout(0);
		expect(t.report().waitingFor).toBe("first-prompt");
		t.agentStart();
		t.start({ name: "x", model: null, fresh: false });
		expect(t.report()).toMatchObject({ state: "working", status: "busy" });
	});

	it("overlapping dialogs stay blocked until the outer one ends (review S6)", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.dialogStart("select", "Outer");
		t.dialogStart("confirm", "Inner");
		t.dialogEnd();
		expect(t.report()).toMatchObject({ waitingFor: "dialog", question: "Outer" });
		t.dialogEnd();
		expect(t.report()).toMatchObject({ state: "working", waitingFor: null });
	});

	it("stateChanged ignores summary-only changes", () => {
		const t = new WorkerTracker();
		t.agentStart();
		t.assistantMessage(assistant("step one"));
		const a = t.report();
		t.assistantMessage(assistant("step two"));
		const b = t.report();
		expect(a.summary).not.toBe(b.summary);
		expect(stateChanged(a, b)).toBe(false);
		t.dialogStart("confirm", "ok?");
		expect(stateChanged(b, t.report())).toBe(true);
	});
});
