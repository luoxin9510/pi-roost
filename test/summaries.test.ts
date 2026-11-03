import { describe, expect, it } from "vitest";
import {
	notifySequence,
	notifyText,
	observeJob,
	resolveNotify,
	setJobEventBus,
	transitionKind,
} from "../lib/job-events.ts";
import type { JobRow } from "../lib/protocol.ts";
import {
	awayIsEmpty,
	emptyAway,
	parseField,
	parseTurnSummary,
	recapList,
	splitModelRef,
	transcriptTail,
} from "../lib/summarizer.ts";
import { WorkerTracker } from "../lib/worker-state.ts";

const row = (over: Partial<JobRow> = {}): JobRow => ({
	id: "a1",
	cwd: "/w",
	kind: "pi",
	startedAt: 0,
	state: "working",
	pid: 1,
	status: "busy",
	waitingFor: null,
	sessionFile: "/s.jsonl",
	name: "fix tests",
	endedAt: null,
	summary: null,
	question: null,
	choices: [],
	model: null,
	error: null,
	stateSince: 0,
	reaped: false,
		pinned: false,
		order: null,
		orderKey: null,
	...over,
});

describe("summary model replies", () => {
	it("parses a turn summary out of prose or fences and clips it", () => {
		expect(parseTurnSummary('Sure!\n```json\n{"summary": "Fixed the flaky host test", "kind": "done", "reply": "x"}\n```')).toEqual({
			summary: "Fixed the flaky host test",
			kind: "done",
			reply: null,
		});
		const q = parseTurnSummary(`{"summary": "${"long ".repeat(40)}", "kind": "question", "reply": "use tabs"}`)!;
		expect(q.kind).toBe("question");
		expect(q.reply).toBe("use tabs");
		expect(q.summary.length).toBeLessThanOrEqual(80);
		expect(parseTurnSummary("no json here")).toBeUndefined();
		expect(parseTurnSummary('{"summary": "  "}')).toBeUndefined();
	});

	it("reads single fields and model references", () => {
		expect(parseField('{"name": "\\"Fix login bug.\\""}', "name", 60)).toBe("Fix login bug");
		expect(parseField('{"name": 3}', "name", 60)).toBeUndefined();
		expect(splitModelRef("openrouter/google/gemini-2.5-flash")).toEqual({ provider: "openrouter", id: "google/gemini-2.5-flash" });
		expect(splitModelRef("nope")).toBeUndefined();
		expect(splitModelRef(undefined)).toBeUndefined();
	});

	it("keeps the newest transcript lines within the budget", () => {
		expect(transcriptTail(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 25)).toBe(`${"b".repeat(10)}\n${"c".repeat(10)}`);
		expect(transcriptTail(["x".repeat(50)], 20)).toBe("x".repeat(20));
	});
});

describe("tracker with a summary model", () => {
	it("rewords the row and corrects question detection for the same run only", () => {
		const t = new WorkerTracker();
		t.start({ fresh: true });
		t.agentStart();
		t.assistantMessage({ content: [{ type: "text", text: "I updated the parser. Want me to also update the docs" }], stopReason: "stop" });
		t.agentSettled(false);
		expect(t.report().state).toBe("done"); // no question mark: heuristics say done
		const run = t.runId();
		expect(t.applyTurnSummary(run, { summary: "Parser updated; docs too?", kind: "question", reply: "yes, update the docs" })).toBe(true);
		expect(t.report()).toMatchObject({ state: "blocked", waitingFor: "question", summary: "Parser updated; docs too?" });
		expect(t.report().choices[0]).toBe("yes, update the docs");
		t.agentStart();
		expect(t.applyTurnSummary(run, { summary: "stale", kind: "done", reply: null })).toBe(false);
		expect(t.applyProgressSummary(t.runId(), "Refactoring the parser")).toBe(true);
		expect(t.report().summary).toBe("Refactoring the parser");
	});
});

describe("job events", () => {
	it("announces transitions once and ignores first sightings", () => {
		const seen: [string, unknown][] = [];
		setJobEventBus({ emit: (c, d) => seen.push([c, d]) });
		expect(observeJob(row({ id: "e1" }))).toBeUndefined();
		expect(observeJob(row({ id: "e1", state: "blocked", question: "tabs?" }))).toBe("needs_input");
		expect(observeJob(row({ id: "e1", state: "blocked" }))).toBeUndefined();
		expect(observeJob(row({ id: "e1", state: "done", summary: "ok" }))).toBe("completed");
		expect(seen.map(([c]) => c)).toEqual(["agents:job_needs_input", "agents:job_completed"]);
		expect(seen[1]![1]).toMatchObject({ id: "e1", state: "done", summary: "ok" });
		expect(transitionKind("working", row({ state: "stopped" }))).toBeUndefined();
		setJobEventBus(undefined);
	});

	it("builds terminal notifications", () => {
		expect(resolveNotify("auto", { TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
		expect(resolveNotify("auto", { TERM_PROGRAM: "Apple_Terminal" })).toBe("bell");
		expect(resolveNotify("off", {})).toBe("off");
		expect(notifySequence("osc9", "a", "b;\x1bc")).toBe("\x1b]9;a: b c\x07");
		expect(notifySequence("osc777", "t", "b")).toBe("\x1b]777;notify;t;b\x07");
		expect(notifySequence("bell", "t", "b")).toBe("\x07");
		expect(notifySequence("off", "t", "b")).toBe("");
		expect(notifyText(row({ state: "failed", error: "boom" }), "completed")).toEqual({ title: "fix tests failed", body: "boom" });
	});
});

describe("away log", () => {
	it("lists turns, tools and the last question", () => {
		const a = emptyAway();
		expect(awayIsEmpty(a)).toBe(true);
		a.turns = 2;
		a.failures = 1;
		a.tools = { bash: 3, edit: 1 };
		a.questions = ["tabs or spaces?"];
		expect(recapList(a)).toBe("2 turns finished (1 failed) · tools: bash ×3, edit · asked: tabs or spaces?");
	});
});
