import { describe, expect, it } from "vitest";
import type { JobRow } from "../lib/protocol.ts";
import {
	ageOf,
	contextToneOf,
	counts,
	formatDuration,
	formatTokens,
	headerText,
	iconOf,
	items,
	layout,
	modelFacts,
	rowDetailsOf,
	sentenceOf,
	shortModel,
	titleText,
} from "../lib/view-model.ts";

const T0 = 1_000_000;
let n = 0;
function row(over: Partial<JobRow> = {}): JobRow {
	n++;
	return {
		id: `id${n}`,
		cwd: "/w",
		kind: "pi",
		startedAt: T0 + n,
		state: "working",
		pid: 100 + n,
		status: "busy",
		waitingFor: null,
		sessionFile: `/s/${n}.jsonl`,
		name: `job ${n}`,
		endedAt: null,
		summary: null,
		question: null,
		choices: [],
		model: null,
		thinking: null,
		context: null,
		error: null,
		stateSince: T0 + n,
		reaped: false,
		pinned: false,
		order: null,
		orderKey: null,
		...over,
	};
}

describe("model and context (M8)", () => {
	it("short model names drop the provider and a date suffix", () => {
		expect(shortModel("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
		expect(shortModel("corp/qwen/qwen3-8b")).toBe("qwen/qwen3-8b");
		expect(shortModel("openai/gpt-5@2026-01-15")).toBe("gpt-5");
		expect(shortModel("bare")).toBe("bare");
	});

	it("formats token counts", () => {
		expect([950, 86_400, 200_000, 1_000_000, 1_250_000].map(formatTokens)).toEqual(["950", "86k", "200k", "1M", "1.3M"]);
	});

	it("warns from 80% and errs from 95%", () => {
		expect([null, 10, 79.9, 80, 94.9, 95, 120].map(contextToneOf)).toEqual(["dim", "dim", "dim", "warning", "warning", "error", "error"]);
	});

	it("row column and peek facts", () => {
		const r = row({ model: "anthropic/claude-opus-5-5", thinking: "high", context: { tokens: 86_000, window: 200_000, percent: 43.2 } });
		expect(rowDetailsOf(r)).toEqual({ model: "claude-opus-5-5", context: "43%", tone: "dim" });
		expect(modelFacts(r)).toEqual(["anthropic/claude-opus-5-5", "thinking high", "ctx 86k / 200k (43%)"]);
		const compacted = row({ model: "a/m", context: { tokens: null, window: 200_000, percent: null } });
		expect(rowDetailsOf(compacted)?.context).toBe("?%");
		expect(modelFacts(compacted).at(-1)).toContain("ctx ? / 200k");
		expect(rowDetailsOf(row({ kind: "shell", model: "a/m" }))).toBeNull();
		expect(rowDetailsOf(row({ model: null, context: null }))).toBeNull();
		expect(rowDetailsOf(row({ model: "a/m", context: { tokens: 196_000, window: 200_000, percent: 98 } }))?.tone).toBe("error");
	});
});

describe("layout", () => {
	it("groups in order and hides empty groups", () => {
		const rows = [row({ state: "done", status: "idle" }), row({ state: "blocked", status: "waiting", waitingFor: "question" }), row()];
		const s = layout(rows);
		expect(s.map((x) => x.key)).toEqual(["needs-input", "working", "completed"]);
		expect(s.map((x) => x.rows.length)).toEqual([1, 1, 1]);
	});

	it("shows every header when there are no jobs (empty state)", () => {
		expect(layout([]).map((x) => x.key)).toEqual(["pinned", "needs-input", "working", "completed"]);
	});

	it("folds completed rows beyond the limit, newest ended first", () => {
		const rows = [1, 2, 3, 4, 5].map((i) => row({ state: "done", status: null, pid: null, endedAt: T0 + 100 * i }));
		const [completed] = layout(rows, { maxCompleted: 2 });
		expect(completed!.rows.map((r) => r.endedAt)).toEqual([T0 + 500, T0 + 400]);
		expect(completed!.hidden).toBe(3);
	});

	it("collapsed groups keep their header but drop rows from the item list", () => {
		const rows = [row(), row({ state: "done", status: "idle" })];
		const list = items(layout(rows, { collapsed: new Set(["working"]) }));
		expect(list.map((i) => (i.kind === "header" ? `#${i.section.key}` : i.row.state))).toEqual(["#working", "#completed", "done"]);
	});

	it("pinned rows go first", () => {
		const a = row({ state: "done", status: "idle" });
		expect(layout([a, row()], { pinned: new Set([a.id]) })[0]!.key).toBe("pinned");
	});
});

describe("rows", () => {
	it("icons follow the process; tone follows the state", () => {
		expect(iconOf(row(), 0)).toEqual({ glyph: "✽", tone: "accent" });
		expect(iconOf(row(), 1).glyph).toBe("✻");
		expect(iconOf(row(), 1, false).glyph).toBe("✽");
		expect(iconOf(row({ status: "waiting", state: "blocked" }))).toEqual({ glyph: "✻", tone: "warning" });
		expect(iconOf(row({ pid: null, state: "failed", status: null }))).toEqual({ glyph: "∙", tone: "error" });
	});

	it("age counts from creation and freezes once finished", () => {
		const r = row({ startedAt: T0 });
		expect(ageOf(r, T0 + 75_000)).toBe("1m");
		const done = row({ startedAt: T0, state: "done", status: "idle", stateSince: T0 + 5_000 });
		expect(ageOf(done, T0 + 3_600_000)).toBe("5s");
		const ended = row({ startedAt: T0, state: "stopped", pid: null, endedAt: T0 + 7_200_000 });
		expect(ageOf(ended, T0 + 99_999_999)).toBe("2h");
		expect(formatDuration(3 * 86_400_000)).toBe("3d");
	});

	it("header, title and sentences", () => {
		const rows = [row({ state: "blocked", status: "waiting", waitingFor: "dialog", question: null, summary: null }), row()];
		const c = counts(rows);
		expect(headerText(c)).toBe("1 needs input · 1 working · 0 completed");
		expect(titleText(c)).toBe("1 awaiting input · pi agents");
		expect(titleText(counts([]))).toBe("pi agents");
		expect(sentenceOf(rows[0]!)).toBe("waiting in a dialog");
		expect(sentenceOf(row({ state: "failed", error: "429", status: null }))).toBe("429");
	});
});

describe("layout options (M6a)", () => {
	it("groups by directory with pinned first, newest directory first", async () => {
		const { layout } = await import("../lib/view-model.ts");
		const rows = [row({ cwd: "/a", startedAt: 1 }), row({ cwd: "/b", startedAt: 5 }), row({ cwd: "/a", pinned: true })];
		const s = layout(rows, { groupBy: "directory" });
		expect(s.map((x) => x.key)).toEqual(["pinned", "dir:/b", "dir:/a"]);
	});

	it("keeps manual order below untouched rows", async () => {
		const { ordered } = await import("../lib/view-model.ts");
		const a = row({ id: "a", order: 1, orderKey: "working" });
		const b = row({ id: "b", order: 0, orderKey: "working" });
		const c = row({ id: "c" });
		const d = row({ id: "d", order: 0, orderKey: "completed" }); // ordered in another group
		expect(ordered([a, b, c, d], () => 0, "working").map((r) => r.id)).toEqual(["c", "d", "b", "a"]);
	});
});

describe("filters (DI-7)", () => {
	it("parses only filter tokens and matches every kind", async () => {
		const { parseFilter, matches } = await import("../lib/filter.ts");
		expect(parseFilter("fix the bug")).toBeUndefined();
		expect(parseFilter("n:fix and more")).toBeUndefined();
		const f = parseFilter("s:comp n:fix o:")!;
		expect(matches(row({ name: "Fix it", state: "failed", error: "boom" }), f)).toBe(true);
		expect(matches(row({ name: "Fix it", state: "failed" }), f)).toBe(false); // bare o: needs a result
		expect(matches(row({ name: "other", state: "done", summary: "x" }), f)).toBe(false);
		expect(matches(row({ state: "blocked" }), parseFilter("s:needs")!)).toBe(true);
		expect(matches(row({ pinned: true }), parseFilter("s:pinned")!)).toBe(true);
	});
});
