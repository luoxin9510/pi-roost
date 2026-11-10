// M73: the task board and the lines overlay on their own: a fake host, keys through handleInput.
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinesOverlay, createTasksOverlay } from "../hub/overlays/tasks.ts";
import type { BoardTask } from "../lib/board.ts";
import { fakeHost, task, ws } from "./support/overlay-host.ts";
import { expectCloseKeys, KEY, strip, tagTheme } from "./support/overlay-keys.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
afterEach(() => vi.useRealTimers());

function board(tasks: BoardTask[], over: { scope?: string; termRows?: number; tag?: boolean } = {}) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	const h = fakeHost<never>(undefined as never, { ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}) });
	const overlay = createTasksOverlay(h.host, { tasks, scope: over.scope ?? "all projects" });
	return { ...h, overlay };
}
const T = (id: number, title: string, extra: Partial<BoardTask> = {}) => task(id, title, { project: null, ...extra });
const many = (n: number, mk: (i: number) => BoardTask) => Array.from({ length: n }, (_, i) => mk(i));

describe("M73: the task board overlay", () => {
	it("renders the title with the scope and summary, the keys under the list, and takes no daemon call", () => {
		const { overlay } = board([T(1, "the schema"), T(2, "write the tests", { after: [1] })], { scope: "pi-roost" });
		const out = overlay.render(200);
		expect(out[0]).toBe("Task board · pi-roost · 1 open · 1 blocked");
		expect(out[1]).toBe("");
		expect(out.at(-1)).toBe("↑↓ scroll · Esc close");
		expect(out.at(-2)).toBe("");
		expect(out).toContain("/tasks all · add <title> [after #n] [-- detail] · assign <id> <session> · done <id> [result] · rm <id> · release <id>");
	});

	it("lists open, then blocked, then claimed, then workspaces; by id inside a group; each in its colour", () => {
		const { overlay } = board(
			[
				T(1, "in review", { state: "claimed", owner: { id: "w", name: "lint" }, workspace: ws("review") }),
				T(2, "claimed", { state: "claimed", owner: { id: "w", name: "lint" }, claimedAt: NOW - 5 * MIN }),
				T(3, "blocked", { after: [5] }),
				T(6, "open b"),
				T(5, "open a"),
			],
			{ tag: true },
		);
		const out = overlay.render(100);
		const at = (s: string) => out.findIndex((l) => l.includes(s));
		expect([at("open a"), at("open b"), at("blocked on"), at("claimed by"), at("in review")].every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1]!))).toBe(true);
		expect(out[at("open a")]).toBe("  ⟨accent⟩#5 open · open a⟨/accent⟩");
		expect(out[at("open b")]).toContain("⟨accent⟩");
		expect(out[at("blocked on")]).toBe("  ⟨warning⟩#3 blocked on #5 · blocked⟨/warning⟩");
		expect(out[at("claimed by")]).toBe("  ⟨muted⟩#2 claimed by lint (5m) · claimed⟨/muted⟩");
		expect(out[at("in review")]).toContain("⟨muted⟩");
	});

	it("shows a task's detail under it, except for a claimed one", () => {
		const { overlay } = board([
			T(1, "open", { detail: "open detail" }),
			T(2, "blocked", { after: [1], detail: "blocked detail" }),
			T(3, "claimed", { state: "claimed", owner: { id: "w", name: "lint" }, detail: "claimed detail" }),
			T(4, "workspace", { state: "claimed", owner: { id: "w", name: "lint" }, workspace: ws("review"), detail: "workspace detail" }),
		]);
		const text = overlay.render(100).join("\n");
		expect(text).toContain("      open detail");
		expect(text).toContain("      blocked detail");
		expect(text).not.toContain("claimed detail");
		expect(text).toContain("      workspace detail");
	});

	it("puts the detail on one line, dim, and cuts every line to the width", () => {
		const { overlay } = board([T(1, "a title " + "long ".repeat(30), { detail: "first\nsecond " + "x".repeat(200) })], { tag: true });
		const out = overlay.render(40);
		expect(out.some((l) => l.includes("      ⟨dim⟩first second"))).toBe(true);
		expect(strip(out).every((l) => visibleWidth(l) <= 40)).toBe(true);
	});

	it("says the board is empty, or that every task is done; dropped tasks are not shown", () => {
		expect(board([], { tag: true }).overlay.render(100)).toContain("⟨dim⟩  the board is empty⟨/dim⟩");
		expect(board([T(1, "gone", { state: "dropped" })]).overlay.render(100).join("\n")).toContain("  the board is empty");
		const done = board([T(1, "finished", { state: "done", doneAt: NOW - MIN })]).overlay.render(100).join("\n");
		expect(done).toContain("  every task is done");
		expect(done).not.toContain("the board is empty");
		expect(done).not.toContain("gone");
	});

	it("lists the done ones after a blank line, newest first (by doneAt, else its creation), dim", () => {
		const { overlay } = board(
			[
				T(1, "open"),
				T(2, "old done", { state: "done", doneAt: NOW - 50 * MIN, at: NOW - 90 * MIN }),
				T(3, "new done", { state: "done", doneAt: NOW - 5 * MIN, at: NOW - 100 * MIN, owner: { id: "w", name: "lint" }, result: "applied" }),
				T(4, "no doneAt", { state: "done", doneAt: null, at: NOW - 20 * MIN }),
			],
			{ tag: true },
		);
		const out = overlay.render(120);
		const at = (s: string) => out.findIndex((l) => l.includes(s));
		expect(at("new done")).toBeLessThan(at("no doneAt"));
		expect(at("no doneAt")).toBeLessThan(at("old done"));
		expect(out[at("new done")]).toBe("  ⟨dim⟩#3 done 5m ago by lint · new done → applied⟨/dim⟩");
		expect(out[at("new done") - 1]).toBe("");
	});

	it("shows 30 done and counts the rest; exactly 30 has no 'more' line", () => {
		const done = (n: number) => many(n, (i) => T(10 + i, `finished ${i}`, { state: "done", doneAt: NOW - (i + 1) * MIN }));
		const scrolled = (ts: BoardTask[]) => {
			const { overlay } = board(ts, { termRows: 200 });
			return overlay.render(100).join("\n");
		};
		const t33 = scrolled(done(33));
		expect(t33).toContain("finished 29");
		expect(t33).not.toContain("finished 30");
		expect(t33).toContain("  … 3 more done");
		const t30 = scrolled(done(30));
		expect(t30).toContain("finished 29");
		expect(t30).not.toContain("more done");
		expect(scrolled(done(31))).toContain("  … 1 more done");
	});

	it("names each task's project when the tasks are of more than one", () => {
		const two = board([T(1, "in a", { project: "/p/alpha" }), T(2, "in b", { project: "/p/beta" })]).overlay.render(100).join("\n");
		expect(two).toContain("#1 open · [alpha] in a");
		expect(two).toContain("#2 open · [beta] in b");
		const one = board([T(1, "in a", { project: "/p/alpha" }), T(2, "also a", { project: "/p/alpha" })]).overlay.render(100).join("\n");
		expect(one).not.toContain("[alpha]");
		const done = board([T(1, "x", { project: "/p/alpha" }), T(2, "y", { project: "/p/beta", state: "done", doneAt: NOW })]).overlay.render(100).join("\n");
		expect(done).toContain("[beta] y");
	});

	it("fits the terminal: rows - 6 lines of list, a blank, the keys; 30 rows when unknown; at least 3", () => {
		const open = many(40, (i) => T(i + 1, `t${i}`));
		expect(board(open, { termRows: 20 }).overlay.render(100)).toHaveLength(14 + 2);
		expect(board(open, { termRows: 0 }).overlay.render(100)).toHaveLength(24 + 2);
		expect(board(open, { termRows: 4 }).overlay.render(100)).toHaveLength(3 + 2);
		expect(board([T(1, "one")], { termRows: 20 }).overlay.render(100).length).toBeLessThan(16);
	});

	it("scrolls with ↑↓, never above the first line or below the last", () => {
		const { overlay } = board(many(20, (i) => T(i + 1, `t${i}`)), { termRows: 9 });
		const first = () => strip(overlay.render(100))[0]!;
		expect(first()).toContain("Task board");
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		expect(first()).toBe("  #1 open · t0");
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("");
		for (let i = 0; i < 100; i++) overlay.handleInput!(KEY.down);
		const last = strip(overlay.render(200));
		expect(last[0]).toBe("  #20 open · t19");
		expect(last.slice(0, 3).join("|")).toContain("release <id>");
		overlay.handleInput!(KEY.up);
		expect(strip(overlay.render(200))[0]).not.toBe(last[0]);
	});

	it("shows a short list whole, in colour: bold title, dim keys and footer, however it was scrolled", () => {
		const { overlay } = board([T(1, "one")], { tag: true });
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		const foot = "⟨dim⟩/tasks all · add <title> [after #n] [-- detail] · assign <id> <session> · done <id> [result] · rm <id> · release <id>⟨/dim⟩";
		expect(overlay.render(200)).toEqual(["**Task board · all projects · 1 open**", "", "  ⟨accent⟩#1 open · one⟨/accent⟩", "", foot, "", "⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩"]);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(overlay.render(200)).toHaveLength(7);
	});

	it("dims the 'more done' line; control characters in a title become spaces; every line fits a narrow width", () => {
		const done = many(32, (i) => T(10 + i, `finished ${i}`, { state: "done", doneAt: NOW - (i + 1) * MIN }));
		const { overlay } = board([T(1, "bell\x07in the title \x1b[31m"), ...done], { tag: true, termRows: 200 });
		const out = overlay.render(200);
		expect(out).toContain("⟨dim⟩  … 2 more done⟨/dim⟩");
		expect(out[2]).toBe("  ⟨accent⟩#1 open · bell in the title [31m⟨/accent⟩");
		expect(out.find((l) => l.includes("#10 done"))).toBe("  ⟨dim⟩#10 done 1m ago · finished 0⟨/dim⟩");
		const narrow = board([T(1, "x".repeat(60), { detail: "d".repeat(60) }), ...many(3, (i) => T(10 + i, "y".repeat(60), { state: "done", doneAt: NOW }))], { termRows: 200 }).overlay.render(20);
		for (const l of narrow) expect(visibleWidth(l), l).toBeLessThanOrEqual(20);
		expect(narrow.length).toBeGreaterThan(8);
		const done2 = board([T(1, "done", { state: "done", doneAt: NOW, owner: { id: "w", name: "z\x07z" } })]).overlay.render(100).join("\n");
		expect(done2).toContain("by z z");
	});

	it("after the terminal got smaller, shows from the top, not the end", () => {
		let rows = 60;
		const h = fakeHost<never>(undefined as never, { termRows: () => rows });
		const overlay = createTasksOverlay(h.host, { tasks: many(5, (i) => T(i + 1, `t${i}`)), scope: "all projects" });
		overlay.render(100);
		rows = 9;
		expect(strip(overlay.render(100))[0]).toBe("Task board · all projects · 5 open");
	});

	it("Esc, Enter, Ctrl+C and q close it; other keys do not", () => {
		expectCloseKeys(() => {
			const b = board([T(1, "x")]);
			return { overlay: b.overlay, log: b.log };
		});
	});
});

describe("M73: the lines overlay", () => {
	function lines(ls: string[], over: { termRows?: number; title?: string } = {}) {
		const h = fakeHost<never>(undefined as never, { theme: tagTheme, ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}) });
		return { ...h, overlay: createLinesOverlay(h.host, { title: over.title ?? "Cleaned up", lines: ls }) };
	}

	it("renders the title (bold), the lines indented and on one line, the keys", () => {
		const { overlay } = lines(["#3: worktree removed", "two\nlines\there"]);
		expect(overlay.render(100)).toEqual(["**Cleaned up**", "", "  #3: worktree removed", "  two lines here", "", "⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩"]);
	});

	it("cuts the title and each line to the width", () => {
		const { overlay } = lines(["x".repeat(100)], { title: "T".repeat(100) });
		const out = strip(overlay.render(30));
		expect(visibleWidth(out[0]!)).toBeLessThanOrEqual(30);
		expect(visibleWidth(out[2]!)).toBeLessThanOrEqual(30);
	});

	it("scrolls the body only, the title and keys stay; clamps at both ends", () => {
		const { overlay } = lines(Array.from({ length: 20 }, (_, i) => `row ${i}`), { termRows: 9 });
		const body = () => strip(overlay.render(100)).slice(2, -2);
		expect(body()).toEqual(["  row 0", "  row 1", "  row 2"]);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.down);
		expect(body()[0]).toBe("  row 1");
		for (let i = 0; i < 100; i++) overlay.handleInput!(KEY.down);
		expect(body()).toEqual(["  row 17", "  row 18", "  row 19"]);
		overlay.handleInput!(KEY.up);
		expect(body()[0]).toBe("  row 16");
		expect(strip(overlay.render(100))[0]).toBe("Cleaned up");
	});

	it("fewer lines than room: no scrolling; unknown height is 30 rows; at least 3 lines", () => {
		const { overlay } = lines(["only"]);
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		expect(overlay.render(100)).toEqual(["**Cleaned up**", "", "  only", "", "⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩"]);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(overlay.render(100)).toHaveLength(5);
		expect(lines(Array.from({ length: 50 }, (_, i) => `r${i}`), { termRows: 0 }).overlay.render(100)).toHaveLength(2 + 24 + 2);
		expect(lines(Array.from({ length: 50 }, (_, i) => `r${i}`), { termRows: 4 }).overlay.render(100)).toHaveLength(2 + 3 + 2);
	});

	it("Esc, Enter, Ctrl+C and q close it; other keys do not", () => {
		expectCloseKeys(() => {
			const l = lines(["x"]);
			return { overlay: l.overlay, log: l.log };
		});
	});
});
