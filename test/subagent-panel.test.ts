import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../lib/protocol.ts";
import { childrenOf, descendantCounts, keyOf, renderPanel } from "../extensions/subagent-panel.ts";

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
	it("lists only this session's children, waiting and working first, minus hidden ones", () => {
		const done = row({ state: "done", status: "idle", pid: null, summary: "All green" });
		const working = row();
		const waiting = row({ state: "blocked", status: "waiting", question: "Which color?" });
		const other = row({ parentSession: "/s/other.jsonl" });
		const all = [done, working, waiting, other];
		expect(childrenOf(all, "/s/parent.jsonl").map((r) => r.id)).toEqual([waiting.id, working.id, done.id]);
		expect(childrenOf(all, "/s/parent.jsonl", new Set([working.id])).map((r) => r.id)).toEqual([waiting.id, done.id]);
		expect(childrenOf(all, undefined)).toEqual([]);
	});

	it("counts descendants below each child", () => {
		const a = row();
		const a1 = row({ parentSession: a.sessionFile });
		const a2 = row({ parentSession: a1.sessionFile });
		const b = row();
		const counts = descendantCounts([a, a1, a2, b], [a, b]);
		expect(counts.get(a.id)).toBe(2);
		expect(counts.has(b.id)).toBe(false);
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
		expect(focused[2]).toContain("↵ open · x stop · Esc back");
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

	it("reads the panel keys", () => {
		expect(keyOf("\x1b[B")).toBe("down");
		expect(keyOf("\x1b[A")).toBe("up");
		expect(keyOf("\r")).toBe("open");
		expect(keyOf("\x1b[C")).toBe("open");
		expect(keyOf("x")).toBe("stop");
		expect(keyOf("\x1b")).toBe("back");
		expect(keyOf("\x1b[D")).toBe("back");
		expect(keyOf("a")).toBe("other");
	});
});
