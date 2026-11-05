import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../lib/protocol.ts";
import { descendantCounts, keyOf, LINGER_MS, panelTree, renderPanel, shownIn } from "../adapters/pi/subagent-panel.ts";

let n = 0;
function row(over: Partial<JobRow> = {}): JobRow {
	n++;
	const now = Date.now();
	return {
		id: `id${n}`,
		cwd: "/w",
		kind: "pi",
		startedAt: now - 60_000 + n,
		state: "working",
		pid: 100 + n,
		status: "busy",
		waitingFor: null,
		sessionFile: `/s/${n}.jsonl`,
		name: `child ${n}`,
		endedAt: null,
		summary: "running bash",
		question: null,
		choices: [],
		model: "p/m",
		thinking: null,
		context: null,
		error: null,
		stateSince: now - 30_000,
		reaped: false,
		pinned: false,
		order: null,
		orderKey: null,
		parentSession: "/s/parent.jsonl",
		rootSession: "/s/parent.jsonl",
		...over,
	};
}

const plain = (_c: string, t: string) => t;
const view = (rows: JobRow[], over: Record<string, unknown> = {}) => ({
	rows,
	descendants: new Map<string, number>(),
	focused: false,
	sel: 0,
	maxRows: 5,
	now: Date.now(),
	frame: 0,
	termRows: 40,
	...over,
});

describe("subagent panel", () => {
	it("lists this session's children, waiting and working first; finished ones leave at once (Claude Code)", () => {
		const now = Date.now();
		const done = row({ state: "done", status: "idle", pid: null, summary: "All green", stateSince: now - 1000 });
		const working = row();
		const waiting = row({ state: "blocked", status: "waiting", question: "Which color?" });
		const failed = row({ state: "failed", status: null, pid: null, stateSince: now - 1000 });
		const other = row({ parentSession: "/s/other.jsonl" });
		const all = [done, working, waiting, failed, other];
		const ids = (mode?: "panel" | "list" | "all", hidden?: Set<string>, at = now) => panelTree(all, "/s/parent.jsonl", { now: at, mode, hidden }).map((t) => t.row.id);
		expect(ids()).toEqual([waiting.id, working.id, failed.id]);
		expect(ids("panel", new Set([failed.id]))).toEqual([waiting.id, working.id]);
		// /subagents: the finished one too, below running work
		expect(ids("list")).toEqual([waiting.id, working.id, failed.id, done.id]);
		// 30 s later only running work is left, unless asked for every one
		expect(ids("list", undefined, now + LINGER_MS)).toEqual([waiting.id, working.id]);
		expect(ids("all", undefined, now + LINGER_MS)).toEqual([waiting.id, working.id, failed.id, done.id]);
		expect(panelTree(all, undefined)).toEqual([]);
	});

	it("keeps stopped and failed rows for 30 seconds", () => {
		const now = Date.now();
		const stopped = row({ state: "stopped", pid: null, stateSince: now - LINGER_MS + 1 });
		expect(shownIn(stopped, now, "panel")).toBe(true);
		expect(shownIn(stopped, now + 1, "panel")).toBe(false);
		expect(shownIn(row({ state: "done", stateSince: now }), now, "panel")).toBe(false);
	});

	it("nests subagents as a tree, counts what is below, keeps the path to a live one", () => {
		const now = Date.now();
		const a = row({ name: "a" });
		const a1 = row({ name: "a1", parentSession: a.sessionFile });
		const a2 = row({ name: "a2", parentSession: a1.sessionFile });
		const b = row({ name: "b", state: "done", status: "idle", pid: null, stateSince: now - 60_000 });
		const b1 = row({ name: "b1", parentSession: b.sessionFile });
		const tree = panelTree([a, a1, a2, b, b1], "/s/parent.jsonl", { now });
		expect(tree.map((t) => [t.row.name, t.depth])).toEqual([
			["a", 0],
			["a1", 1],
			["a2", 2],
			["b", 0],
			["b1", 1],
		]);
		const counts = descendantCounts(tree);
		expect(counts.get(a.id)).toBe(2);
		expect(counts.get(a1.id)).toBe(1);
		expect(counts.has(a2.id)).toBe(false);
		const lines = renderPanel(view(tree.map((t) => t.row), { descendants: counts, depth: new Map(tree.map((t) => [t.row.id, t.depth])) }), 120, plain);
		expect(lines[1]).toMatch(/^ {2}. └ a1/);
		expect(lines[2]).toMatch(/^ {2}. {3}└ a2/);
	});

	it("says where a finished subagent went", () => {
		expect(renderPanel(view([], { finished: true }), 80, plain)).toEqual(["  /subagents to see subagents"]);
		expect(renderPanel(view([row()], { finished: true }), 120, plain).at(-1)).toBe("  ↓ select subagent · /subagents to see subagents");
		expect(renderPanel(view([row()], { finished: true, focused: true }), 120, plain).at(-1)).toContain("↵ view · → attach");
	});

	it("shows nothing without children; a row per child, the hint, the selection", () => {
		expect(renderPanel(view([]), 80, plain)).toEqual([]);
		const a = row({ name: "red", worktree: { path: "/w/.pi/worktrees/red-0001", branch: "roost/red-0001" } });
		const b = row({ name: "blue", state: "blocked", status: "waiting", question: "Which color, red or blue?" });
		const lines = renderPanel(view([a, b], { descendants: new Map([[a.id, 2]]) }), 120, plain);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^ {2}. red {2}/);
		expect(lines[0]).toContain("running bash");
		expect(lines[0]).toContain("⎇ roost/red-0001");
		expect(lines[0]).toContain("(+2)");
		expect(lines[1]).toContain("Which color, red or blue?");
		expect(lines[2]).toContain("↓ select subagents");
		const focused = renderPanel(view([a, b], { focused: true, sel: 1 }), 120, plain);
		expect(focused[1]!.startsWith("› ")).toBe(true);
		expect(focused[2]).toContain("↵ view · → attach · m message · x stop · K stop all · Esc back");
	});

	it("caps the rows and keeps the selection on screen", () => {
		const rows = Array.from({ length: 8 }, () => row());
		const lines = renderPanel(view(rows, { maxRows: 3 }), 100, plain);
		expect(lines).toHaveLength(4);
		expect(lines[2]).toContain("… 6 more (/agents)");
		const far = renderPanel(view(rows, { maxRows: 3, focused: true, sel: 6 }), 100, plain);
		expect(far.some((l) => l.startsWith("› ") && l.includes(rows[6]!.name))).toBe(true);
	});

	it("never renders a line wider than the terminal; short terminals get one line", () => {
		const rows = [
			row({ name: "调查不稳定的复位测试用例并修复它，名字很长很长", summary: "正在运行 bash：npm test -- --run 很长的输出\n第二行" }),
			row({ state: "failed", status: null, pid: null, error: "Error: boom\u001b[31m red" }),
			row({ state: "blocked", status: "waiting", question: "Q?\nmore" }),
		];
		for (const width of [1, 2, 5, 10, 20, 39, 40, 41, 60, 80, 200]) {
			for (const focused of [false, true]) {
				for (const l of renderPanel(view(rows, { focused, sel: 2 }), width, plain)) {
					expect(visibleWidth(l), `width ${width}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(width);
				}
			}
		}
		const short = renderPanel(view(rows, { termRows: 10 }), 80, plain);
		expect(short).toHaveLength(1);
		expect(short[0]).toContain("3 subagents · 1 waiting · 1 working · ↓");
	});

	it("one row at most still shows the selection; a key to press again replaces the hint", () => {
		const rows = Array.from({ length: 3 }, () => row());
		const one = renderPanel(view(rows, { maxRows: 1, focused: true, sel: 2 }), 100, plain);
		expect(one[0]!.startsWith("› ")).toBe(true);
		expect(one[1]).toContain("… 2 more");
		const armed = renderPanel(view(rows, { focused: true, notice: "x again stops child" }), 100, plain);
		expect(armed.at(-1)).toBe("  x again stops child");
		expect(renderPanel(view(rows, { notice: "x again stops child" }), 100, plain).at(-1)).toContain("↓ select");
	});

	it("writes a message under the selected row; the hint follows", () => {
		const rows = [row({ name: "red" }), row({ name: "blue" })];
		const lines = renderPanel(view(rows, { focused: true, sel: 1, composer: (w: number) => "message blue › hi".slice(0, w) }), 80, plain);
		expect(lines[2]).toBe("    message blue › hi");
		expect(lines.at(-1)).toBe("  ↵ send · Esc cancel");
		expect(renderPanel(view(rows, { focused: true }), 120, plain).at(-1)).toContain("m message · x stop · K stop all");
		for (const w of [1, 5, 7, 20]) {
			for (const l of renderPanel(view(rows, { focused: true, sel: 1, composer: () => "message blue › a long draft ".repeat(5) }), w, plain)) {
				expect(visibleWidth(l)).toBeLessThanOrEqual(w);
			}
		}
	});

	it("reads the panel keys", () => {
		expect(keyOf("\x1b[B")).toBe("down");
		expect(keyOf("\x1b[A")).toBe("up");
		expect(keyOf("\r")).toBe("view");
		expect(keyOf("\x1b[C")).toBe("open");
		expect(keyOf("x")).toBe("stop");
		expect(keyOf("\x1b")).toBe("back");
		expect(keyOf("\x1b[D")).toBe("back");
		expect(keyOf("m")).toBe("message");
		expect(keyOf("K")).toBe("stopAll");
		expect(keyOf("a")).toBe("other");
	});
});
