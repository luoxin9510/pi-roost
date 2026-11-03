import { describe, expect, it } from "vitest";
import type { JobRow } from "../lib/protocol.ts";
import { ageOf, counts, formatDuration, headerText, iconOf, items, layout, sentenceOf, titleText } from "../lib/view-model.ts";

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
		error: null,
		stateSince: T0 + n,
		reaped: false,
		pinned: false,
		order: null,
		...over,
	};
}

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
		const a = row({ id: "a", order: 1 });
		const b = row({ id: "b", order: 0 });
		const c = row({ id: "c" });
		expect(ordered([a, b, c], () => 0).map((r) => r.id)).toEqual(["c", "b", "a"]);
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
