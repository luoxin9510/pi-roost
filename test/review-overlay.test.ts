// M72: the review overlay on its own: a fake port, a fake host, a fake diff, keys through handleInput.
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createReviewOverlay, type ReviewOpts } from "../hub/overlays/review.ts";
import type { Overlay } from "../hub/overlay-host.ts";
import type { BoardTask, ReviewComment } from "../lib/board.ts";
import type { TaskDiff } from "../lib/task-diff.ts";
import { fakeHost, SHA, task, tick } from "./support/overlay-host.ts";
import { fakePort } from "./support/roost-port.ts";

const line = (kind: "+" | "-" | " ", text: string, n: number) => ({ kind, text, oldNo: kind === "+" ? null : n, newNo: kind === "-" ? null : n });
const TIP = "b".repeat(40);
const diffOf = (): TaskDiff => ({
	base: SHA,
	tip: TIP,
	truncated: false,
	files: [
		{ path: "a.ts", status: "M", binary: false, hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [line(" ", "const a = 1;", 1), line("-", "const b = 2;", 2), line("+", "const b = 3;", 2)] }, { header: "@@ -9 +9 @@", lines: [line("+", "nine", 9), line(" ", "ten", 10)] }] },
		{ path: "logo.png", status: "A", binary: true, hunks: [] },
	],
});
const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({ file: "a.ts", line: 3, lineText: "+const b = 3;", text: "why three", tip: "", at: 7, ...over });
const reviewTask = (comments: ReviewComment[] = [], stage = "review"): BoardTask => task(4, "users migration", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: { path: "/r/wt", branch: "roost/t4-users-ab12", baseRef: "main", baseSha: SHA, stage, note: null, comments } as never });

async function make(over: { comments?: ReviewComment[]; diff?: TaskDiff | undefined | "none"; tasks?: BoardTask[]; answers?: Record<string, (...a: any[]) => unknown>; opts?: Partial<ReviewOpts>; termRows?: number; theme?: boolean } = {}) {
	const state = { tasks: over.tasks ?? [reviewTask(over.comments)], diff: over.diff === "none" ? undefined : (over.diff ?? diffOf()) as TaskDiff | undefined };
	const port = fakePort({
		"tasks.list": () => ({ tasks: state.tasks }),
		"tasks.comment": (id: number, c: ReviewComment) => ({ tasks: state.tasks, task: { ...state.tasks[0]!, workspace: { ...state.tasks[0]!.workspace!, comments: [...(state.tasks[0]!.workspace!.comments ?? []), { ...c, tip: "", at: 100 }] } }, note: "ok" }),
		"tasks.uncomment": () => ({ tasks: state.tasks, task: { ...state.tasks[0]!, workspace: { ...state.tasks[0]!.workspace!, comments: [] } } }),
		...over.answers,
	});
	const diffCalls: [string, string][] = [];
	const h = fakeHost(port.port as never, {
		taskDiff: (async (path: string, base: string) => {
			diffCalls.push([path, base]);
			return state.diff;
		}) as never,
		...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}),
		...(over.theme ? { theme: { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `<b>${t}</b>` } } : {}),
	} as never);
	const commands: string[] = [];
	const closed: number[] = [];
	const opts: ReviewOpts = { id: 4, tasksCommand: async (l) => void commands.push(l), onClose: () => void closed.push(1), ...over.opts };
	const overlay = (await createReviewOverlay(h.host as never, opts)) as Overlay;
	if (overlay) {
		h.mount(overlay);
		// the view paints before any key (the cursor is placed by the first paint)
		overlay.render(100);
	}
	const text = (w = 100) => overlay.render(w).join("\n");
	const cursor = (w = 100) => overlay.render(w).find((l) => l.startsWith("▶")) ?? "";
	const key = (...ks: string[]) => ks.forEach((k) => overlay.handleInput!(k));
	const type = (s: string) => [...s].forEach((c) => overlay.handleInput!(c));
	const calls = (path: string) => port.calls.filter((c) => c.path === path).map((c) => c.args);
	return { overlay, h, port, state, commands, closed, text, cursor, key, type, calls, diffCalls };
}

describe("the review overlay: opening", () => {
	it("loads the task and its diff against the commit its branch shares with base", async () => {
		const o = await make();
		expect(o.diffCalls).toEqual([["/r/wt", "main"]]);
		expect(o.text()).toContain("#4 users migration · M a.ts");
		expect(o.closed).toEqual([]);
	});

	it("a task that is gone, or has no worktree, says so and gives no overlay; Esc's place is called", async () => {
		const gone = await make({ tasks: [] });
		expect(gone.overlay).toBeUndefined();
		expect(gone.h.said).toEqual([{ text: "#4 has no workspace to review", tone: "error" }]);
		expect(gone.closed).toEqual([1]);
		const none = await make({ tasks: [task(4, "x")] });
		expect(none.overlay).toBeUndefined();
		expect(none.h.texts()).toEqual(["#4 has no workspace to review"]);
		const pathless = await make({ tasks: [{ ...reviewTask(), workspace: { ...reviewTask().workspace!, path: "" } }] });
		expect(pathless.overlay).toBeUndefined();
		expect(pathless.diffCalls).toEqual([]);
	});

	it("a diff git could not make says so; without onClose nothing else happens", async () => {
		const o = await make({ diff: "none", opts: { onClose: undefined } });
		expect(o.overlay).toBeUndefined();
		expect(o.h.said).toEqual([{ text: "#4: git could not diff roost/t4-users-ab12 against main", tone: "error" }]);
		expect(o.closed).toEqual([]);
	});

	it("a refused list says why", async () => {
		const o = await make({ answers: { "tasks.list": () => Promise.reject(new Error("daemon says no")) } });
		expect(o.overlay).toBeUndefined();
		expect(o.h.texts()).toEqual(["daemon says no"]);
	});
});

describe("the review overlay: the screen", () => {
	it("a file's diff with the cursor on its first line, the facts under the head", async () => {
		const o = await make();
		const out = o.text();
		expect(out).toContain("file 1/2 · hunk 1/2");
		expect(out).toContain("@@ -1,2 +1,2 @@");
		expect(out).toContain("    2 + const b = 3;");
		expect(out).toContain("    2 - const b = 2;");
		expect(o.cursor()).toContain("const a = 1;");
		expect(o.overlay.render(200).at(-1)).toBe("j/k line · n/p hunk · ]/[ file · c comment · d delete comment · b send back · m merge · r reload · Esc back");
	});

	it("says 1 comment, N comments; a diff cut short; a lone file has no file count", async () => {
		const one = await make({ comments: [comment({ line: 2 })] });
		expect(one.text()).toContain("hunk 1/2 · 1 comment\n");
		const two = await make({ comments: [comment({ line: 2 }), comment({ line: 9, at: 8 })] });
		expect(two.text()).toContain("2 comments");
		const cut = await make({ diff: { ...diffOf(), truncated: true, files: [diffOf().files[0]!] } });
		expect(cut.text()).toContain("hunk 1/2 · diff cut short");
		expect(cut.text()).not.toContain("file 1/");
	});

	it("a comment sits under its line while that line is where it was; otherwise it is outdated, first", async () => {
		const o = await make({ comments: [comment({ line: 2, lineText: "+const b = 3;", text: "why three" }), comment({ line: 7, lineText: "+gone", text: "an old one", at: 0 })] });
		expect(o.text()).toMatch(/const b = 3;\n\s+└ ✎ why three/);
		const lines = o.overlay.render(100);
		expect(lines.findIndex((l) => l.includes("✎ outdated (line 7): an old one"))).toBeLessThan(lines.findIndex((l) => l.includes("@@ -1,2")));
	});

	it("a comment whose line text changed is outdated", async () => {
		const o = await make({ comments: [comment({ line: 2, lineText: "+const b = 4;" })] });
		expect(o.text()).toContain("✎ outdated (line 2): why three");
		expect(o.text()).not.toContain("└ ✎");
	});

	it("comments on files no longer in the diff have a page of their own, last", async () => {
		const o = await make({ comments: [comment({ file: "gone.ts", line: 3, text: "about gone" })] });
		expect(o.text()).toContain("file 1/3");
		o.key("]", "]");
		expect(o.text()).toContain("#4 users migration · comments on files not in the diff now");
		expect(o.text()).toContain("file 3/3 · 1 comment");
		expect(o.cursor()).toContain("✎ gone.ts (line 3): about gone");
		o.key("]");
		expect(o.text()).toContain("file 3/3");
	});

	it("a binary file, a renamed one, an empty one, one whose mode changed, a summarised one say what they are", async () => {
		const files = [
			{ path: "logo.png", status: "A", binary: true, hunks: [] },
			{ path: "new.ts", oldPath: "old.ts", status: "R", binary: false, hunks: [] },
			{ path: "empty.ts", status: "A", binary: false, hunks: [] },
			{ path: "gone.ts", status: "D", binary: false, hunks: [] },
			{ path: "run.sh", status: "M", binary: false, hunks: [] },
			{ path: "big.ts", status: "M", binary: false, hunks: [], summary: "+5000 −3 (too large to show)" },
		] as TaskDiff["files"];
		const o = await make({ diff: { ...diffOf(), files } });
		const expected = ["binary file", "renamed, its text unchanged", "an empty file", "an empty file, deleted", "its text unchanged (its mode changed)", "+5000 −3 (too large to show)"];
		const heads: string[] = [];
		for (const want of expected) {
			expect(o.text()).toContain(want);
			heads.push(o.overlay.render(100)[0]!);
			o.key("]");
		}
		expect(heads[1]).toContain("R old.ts → new.ts");
		expect(heads[0]).toContain("A logo.png");
	});

	it("nothing changed against base", async () => {
		const o = await make({ diff: { ...diffOf(), files: [] } });
		expect(o.text()).toContain("no changes");
		expect(o.text()).toContain("nothing changed against base");
		o.key("j", "k", "]", "d", "c");
		expect(o.h.texts()).toEqual(["c comments on a line of the diff"]);
	});

	it("control characters and tabs in a file are not drawn raw", async () => {
		const f = { path: "x.ts", status: "M", binary: false, hunks: [{ header: "@@ -1 +1 @@", lines: [line("+", "a\tb\x1b[31mc\x85d", 1)] }] };
		const o = await make({ diff: { ...diffOf(), files: [f] as never } });
		const out = o.text();
		expect(out).toContain("+ a    b [31mc d");
		expect(o.cursor()).not.toContain("\t");
		expect(o.cursor()).not.toContain("\x1b");
		expect(o.cursor()).not.toContain("\x85");
	});

	it("long lines are cut to the width; no line is wider than the terminal", async () => {
		const f = { path: "x".repeat(200), status: "M", binary: false, hunks: [{ header: "@@ " + "h".repeat(200), lines: [line("+", "y".repeat(300), 1)] }] };
		const o = await make({ diff: { ...diffOf(), files: [f] as never }, comments: [comment({ file: "x".repeat(200), line: 1, lineText: "+" + "y".repeat(300), text: "z ".repeat(100) })] });
		for (const w of [10, 30, 80, 120]) for (const l of o.overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
	});

	it("shows the host's notice above the keys while it lasts", async () => {
		const o = await make();
		o.h.host.say("busy: try again in a moment", "muted");
		expect(o.overlay.render(100).at(-2)).toBe("busy: try again in a moment");
		const stale = await make();
		stale.h.host.notice = () => ({ text: "old", tone: "muted", until: Date.now() - 1 });
		expect(stale.text()).not.toContain("old");
	});

	it("scrolls so the cursor stays in view in a short terminal", async () => {
		const many = { path: "m.ts", status: "M", binary: false, hunks: [{ header: "@@ -1,40 +1,40 @@", lines: Array.from({ length: 40 }, (_, i) => line("+", `row${i}`, i + 1)) }] };
		const o = await make({ diff: { ...diffOf(), files: [many as never] } });
		expect(o.text()).toContain("row0");
		expect(o.text()).not.toContain("row30");
		for (let i = 0; i < 30; i++) o.key("j");
		expect(o.cursor()).toContain("row30");
		expect(o.text()).not.toContain("row0\n");
	});
});

describe("the review overlay: moving", () => {
	it("j and k, the arrows and the page keys move the cursor, stopping at the ends", async () => {
		const o = await make();
		o.key("j");
		expect(o.cursor()).toContain("const b = 2;");
		o.key("\x1b[B");
		expect(o.cursor()).toContain("const b = 3;");
		o.key("k");
		expect(o.cursor()).toContain("const b = 2;");
		o.key("\x1b[A");
		expect(o.cursor()).toContain("const a = 1;");
		o.key("\x1b[6~");
		expect(o.cursor()).toContain("ten");
		o.key("j");
		expect(o.cursor()).toContain("ten");
		o.key("\x1b[5~");
		expect(o.cursor()).toContain("@@ -1,2 +1,2 @@");
		o.key("k", "k");
		expect(o.cursor()).toContain("@@ -1,2 +1,2 @@");
	});

	it("n and p go hunk to hunk both ways, from a hunk's start too; they stop at the ends", async () => {
		const o = await make();
		o.key("n");
		expect(o.cursor()).toContain("nine");
		o.key("n");
		expect(o.cursor()).toContain("nine");
		o.key("j");
		o.key("p");
		expect(o.cursor()).toContain("const a = 1;");
		o.key("p");
		expect(o.cursor()).toContain("const a = 1;");
		o.key("n", "p");
		expect(o.cursor()).toContain("const a = 1;");
		// hunk 2/2 from its header row
		o.key("n", "k");
		expect(o.cursor()).toContain("@@ -9 +9 @@");
		o.key("p");
		expect(o.cursor()).toContain("const a = 1;");
		expect(o.text()).toContain("hunk 1/2");
	});

	it("n from the hunk header of the last hunk stays; hunk counts follow the cursor", async () => {
		const o = await make();
		expect(o.text()).toContain("hunk 1/2");
		o.key("n");
		expect(o.text()).toContain("hunk 2/2");
	});

	it("] and [ go file to file, to the first line of its diff, and stop at the ends", async () => {
		const o = await make();
		o.key("[");
		expect(o.text()).toContain("file 1/2");
		o.key("j", "j", "]");
		expect(o.text()).toContain("file 2/2");
		expect(o.cursor()).toContain("binary file");
		o.key("]");
		expect(o.text()).toContain("file 2/2");
		o.key("[");
		expect(o.text()).toContain("file 1/2");
		expect(o.cursor()).toContain("const a = 1;");
	});

	it("a file opens on its first line of diff, past its outdated comments", async () => {
		const o = await make({ comments: [comment({ line: 99, text: "old", lineText: "+nope" })] });
		expect(o.cursor()).toContain("const a = 1;");
		o.key("]", "[");
		expect(o.cursor()).toContain("const a = 1;");
	});

	it("r reads the task and its diff again", async () => {
		const o = await make();
		o.state.diff = { ...diffOf(), files: [diffOf().files[0]!] };
		o.key("r");
		await tick();
		expect(o.calls("tasks.list")).toHaveLength(2);
		expect(o.diffCalls).toHaveLength(2);
		expect(o.text()).not.toContain("file 1/");
		expect(o.h.log.renders).toBeGreaterThan(0);
	});

	it("a reload that fails says why; for a merged task, whose worktree is gone, it is silent", async () => {
		const o = await make();
		o.state.diff = undefined;
		o.key("r");
		await tick();
		expect(o.h.texts()).toEqual(["#4: git could not diff roost/t4-users-ab12 against main"]);
		const merged = await make();
		merged.state.tasks = [reviewTask([], "merged")];
		merged.state.diff = undefined;
		merged.key("r");
		await tick();
		expect(merged.h.said).toEqual([]);
		const gone = await make();
		gone.state.tasks = [];
		gone.key("r");
		await tick();
		expect(gone.h.texts()).toEqual(["#4 has no workspace to review"]);
	});

	it("a file that vanished on reload clamps the file index", async () => {
		const o = await make();
		o.key("]");
		o.state.diff = { ...diffOf(), files: [diffOf().files[0]!] };
		o.key("r");
		await tick();
		expect(o.text()).toContain("#4 users migration · M a.ts");
	});
});

describe("the review overlay: comments", () => {
	it("c on a line of the diff takes a comment; Enter sends it with the line's place, its text and the tip", async () => {
		const o = await make();
		o.key("j", "j", "c");
		expect(o.text()).toContain("comment › ");
		expect(o.text()).toContain("Enter keep the comment · Esc cancel");
		o.type("drop the index first");
		o.key("\r");
		await tick();
		expect(o.calls("tasks.comment")).toEqual([[4, { file: "a.ts", line: 2, lineText: "+const b = 3;", text: "drop the index first", tip: TIP }]]);
		expect(o.text()).toMatch(/const b = 3;\n\s+└ ✎ drop the index first/);
		expect(o.text()).not.toContain("comment › ");
	});

	it("a comment on a removed line takes the old number", async () => {
		const o = await make();
		o.key("j", "c");
		o.type("x");
		o.key("\r");
		await tick();
		expect(o.calls("tasks.comment")[0]).toEqual([4, { file: "a.ts", line: 2, lineText: "-const b = 2;", text: "x", tip: TIP }]);
	});

	it("c anywhere else says where comments go; an empty comment sends nothing; Esc and Ctrl+C cancel", async () => {
		const o = await make();
		o.key("k");
		o.key("\x1b[5~");
		o.key("c");
		expect(o.h.texts()).toEqual(["c comments on a line of the diff"]);
		expect(o.text()).not.toContain("comment › ");
		o.key("j", "c", "\r");
		await tick();
		expect(o.calls("tasks.comment")).toEqual([]);
		o.key("c");
		o.type("abc");
		o.key("\x1b");
		expect(o.text()).not.toContain("comment › ");
		o.key("c", "\x03");
		expect(o.text()).not.toContain("comment › ");
		expect(o.calls("tasks.comment")).toEqual([]);
		expect(o.h.log.closes).toBe(0);
	});

	it("text of spaces is no comment; the comment is one trimmed line", async () => {
		const o = await make();
		o.key("j", "c");
		o.type("   ");
		o.key("\r");
		await tick();
		expect(o.calls("tasks.comment")).toEqual([]);
		o.key("c");
		o.type("  two   words ");
		o.key("\r");
		await tick();
		expect((o.calls("tasks.comment")[0]![1] as { text: string }).text).toBe("two words");
	});

	it("a refused comment is said and the box is closed", async () => {
		const o = await make({ answers: { "tasks.comment": () => Promise.reject(new Error("too many comments")) } });
		o.key("j", "c");
		o.type("x");
		o.key("\r");
		await tick();
		expect(o.h.said).toEqual([{ text: "too many comments", tone: "error" }]);
		expect(o.text()).not.toContain("comment › ");
		// and the next is allowed
		o.key("c");
		expect(o.text()).toContain("comment › ");
	});

	it("while a comment is on its way, Enter in another box says busy and keeps the text", async () => {
		let release!: (v: unknown) => void;
		const o = await make({ answers: { "tasks.comment": () => new Promise((r) => (release = r)) } });
		o.key("j", "c");
		o.type("first");
		o.key("\r");
		o.key("c");
		o.type("second");
		o.key("\r");
		expect(o.h.texts()).toEqual(["busy: Enter again in a moment"]);
		expect(o.text()).toContain("comment › second");
		release({ tasks: [], task: undefined });
		await tick();
		o.key("\r");
		await tick();
		expect(o.calls("tasks.comment").map((c) => (c[1] as { text: string }).text)).toEqual(["first", "second"]);
	});

	it("d deletes the comment under the line, the last one if several", async () => {
		const o = await make({ comments: [comment({ line: 2, at: 7 }), comment({ line: 2, at: 9, text: "second" })] });
		o.key("j", "j", "d");
		await tick();
		expect(o.calls("tasks.uncomment")).toEqual([[4, { file: "a.ts", line: 2, at: 9 }]]);
		expect(o.text()).not.toContain("└ ✎");
	});

	it("d on an outdated comment's row deletes it; on a line without one says so", async () => {
		const o = await make({ comments: [comment({ line: 99, lineText: "+nope", at: 3 })] });
		o.key("d");
		expect(o.h.texts()).toEqual(["no comment here"]);
		o.key("\x1b[H");
		o.key("k", "k", "k", "k", "k", "k");
		o.key("\x1b[5~");
		expect(o.cursor()).toContain("✎ outdated (line 99)");
		o.key("d");
		await tick();
		expect(o.calls("tasks.uncomment")).toEqual([[4, { file: "a.ts", line: 99, at: 3 }]]);
	});

	it("d on a hunk header or a note says there is none; a refused delete is said", async () => {
		const o = await make({ answers: { "tasks.uncomment": () => Promise.reject(new Error("gone already")) }, comments: [comment({ line: 2 })] });
		o.key("j", "j", "d");
		await tick();
		expect(o.h.said.at(-1)).toEqual({ text: "gone already", tone: "error" });
		o.key("]", "d");
		expect(o.h.texts().at(-1)).toBe("no comment here");
		expect(o.calls("tasks.uncomment")).toHaveLength(1);
	});

	it("d does nothing while a delete is on its way", async () => {
		let release!: (v: unknown) => void;
		const o = await make({ comments: [comment({ line: 2 })], answers: { "tasks.uncomment": () => new Promise((r) => (release = r)) } });
		o.key("j", "j", "d", "d");
		await tick();
		expect(o.calls("tasks.uncomment")).toHaveLength(1);
		release({ tasks: [] });
		await tick();
		expect(o.h.said).toEqual([]);
	});

	it("d on a diff with no files does nothing", async () => {
		const o = await make({ diff: { ...diffOf(), files: [] } });
		o.key("d");
		expect(o.h.said).toEqual([]);
		expect(o.calls("tasks.uncomment")).toEqual([]);
	});
});

describe("the review overlay: send back and merge", () => {
	it("b takes a note; Enter sends it back through /tasks with the note", async () => {
		const o = await make();
		o.key("b");
		expect(o.text()).toContain("#4 back › ");
		expect(o.text()).toContain("Enter send back with the comments · Esc cancel");
		o.type("see comments");
		o.key("\r");
		await tick();
		expect(o.commands).toEqual(["back 4 see comments"]);
		expect(o.text()).not.toContain("back › ");
	});

	it("an empty note is a send-back without one; Esc cancels", async () => {
		const o = await make();
		o.key("b", "\r");
		await tick();
		expect(o.commands).toEqual(["back 4"]);
		o.key("b");
		o.type("no");
		o.key("\x1b");
		expect(o.commands).toEqual(["back 4"]);
		expect(o.text()).not.toContain("back › ");
	});

	it("m merges through /tasks and reads the task again", async () => {
		const o = await make();
		o.key("m");
		await tick();
		expect(o.commands).toEqual(["merge 4"]);
		expect(o.calls("tasks.list")).toHaveLength(2);
	});

	it("a merge that happened closes the review and goes to where Esc goes; one that did not keeps it open", async () => {
		const o = await make({
			opts: {
				tasksCommand: async () => {
					o.state.tasks = [reviewTask([], "merged")];
				},
			},
		});
		o.state.diff = undefined;
		o.key("m");
		await tick();
		expect(o.h.log.closes).toBe(1);
		expect(o.closed).toEqual([1]);
		const stays = await make();
		stays.key("m");
		await tick();
		expect(stays.h.log.closes).toBe(0);
		expect(stays.closed).toEqual([]);
		expect(stays.text()).toContain("#4 users migration · M a.ts");
	});

	it("a send-back that put the task to work closes the review; one still in review does not", async () => {
		const o = await make({
			opts: {
				tasksCommand: async () => {
					o.state.tasks = [reviewTask([], "working")];
				},
			},
		});
		o.key("b", "\r");
		await tick();
		expect(o.h.log.closes).toBe(1);
		expect(o.closed).toEqual([1]);
		const stays = await make();
		stays.key("b", "\r");
		await tick();
		expect(stays.h.log.closes).toBe(0);
		// a merge does not close it because the task is at work, nor a send-back because it merged
		const mix = await make({
			opts: {
				tasksCommand: async () => {
					mix.state.tasks = [reviewTask([], "working")];
				},
			},
		});
		mix.key("m");
		await tick();
		expect(mix.h.log.closes).toBe(0);
		const mix2 = await make({
			opts: {
				tasksCommand: async () => {
					mix2.state.tasks = [reviewTask([], "merged")];
				},
			},
		});
		mix2.key("b", "\r");
		await tick();
		expect(mix2.h.log.closes).toBe(0);
	});

	it("a command while another runs says busy and does not run", async () => {
		let finish!: () => void;
		const o = await make({ opts: { tasksCommand: () => new Promise<void>((r) => (finish = r)) } });
		o.key("m");
		o.key("m");
		expect(o.h.texts()).toEqual(["busy: try again in a moment"]);
		o.key("b");
		o.type("x");
		o.key("\r");
		expect(o.h.texts()).toEqual(["busy: try again in a moment", "busy: Enter again in a moment"]);
		expect(o.text()).toContain("back › x");
		finish();
		await tick();
		o.key("\r");
		await tick();
	});

	it("a close from a review that is no longer the one shown closes nothing", async () => {
		const o = await make({
			opts: {
				tasksCommand: async () => {
					o.state.tasks = [reviewTask([], "merged")];
					o.h.mount({ render: () => [] });
				},
			},
		});
		o.key("m");
		await tick();
		expect(o.h.log.closes).toBe(0);
		expect(o.closed).toEqual([]);
	});
});

describe("the review overlay: leaving", () => {
	it("Esc, q and Ctrl+C close it and go to where Esc goes", async () => {
		for (const k of ["\x1b", "q", "\x03"]) {
			const o = await make();
			o.key(k);
			expect(o.h.log.closes).toBe(1);
			expect(o.closed).toEqual([1]);
		}
	});

	it("without a place to go, closing just closes", async () => {
		const o = await make({ opts: { onClose: undefined } });
		o.key("\x1b");
		expect(o.h.log.closes).toBe(1);
	});

	it("Esc in a box only cancels the box", async () => {
		const o = await make();
		o.key("b", "\x1b");
		expect(o.h.log.closes).toBe(0);
		o.key("q");
		expect(o.h.log.closes).toBe(1);
	});

	it("q typed in a box is text", async () => {
		const o = await make();
		o.key("j", "c");
		o.type("quit");
		expect(o.text()).toContain("comment › quit");
		expect(o.h.log.closes).toBe(0);
	});

	it("a close that is not the shown overlay's does nothing; after dispose a reload draws nothing", async () => {
		const o = await make();
		o.h.mount({ render: () => [] });
		o.key("\x1b");
		expect(o.h.log.closes).toBe(0);
		expect(o.closed).toEqual([]);
		const d = await make();
		d.overlay.dispose!();
		const renders = d.h.log.renders;
		d.key("r");
		await tick();
		expect(d.h.log.renders).toBe(renders);
	});
});

describe("the review overlay: the last rules", () => {
	const longFile = (n: number) => ({ path: "m.ts", status: "M", binary: false, hunks: [{ header: "@@ -1,40 +1,40 @@", lines: Array.from({ length: n }, (_, i) => line("+", `row${i}`, i + 1)) }] });
	const withFile = (f: unknown) => ({ ...diffOf(), files: [f as never] });

	it("finds its task among others", async () => {
		const o = await make({ tasks: [task(1, "other", { workspace: reviewTask().workspace }), task(2, "another"), reviewTask()] });
		expect(o.text()).toContain("#4 users migration");
	});

	it("the page of files gone shows only the comments on files that are gone", async () => {
		const o = await make({ comments: [comment({ line: 2, text: "on a.ts" }), comment({ file: "gone.ts", text: "on gone" })] });
		o.key("]", "]");
		expect(o.text()).toContain("on gone");
		expect(o.text()).not.toContain("on a.ts");
	});

	it("several comments on one line are all shown under it", async () => {
		const o = await make({ comments: [comment({ line: 2, text: "first remark", at: 1 }), comment({ line: 2, text: "second remark", at: 2 })] });
		expect(o.text()).toMatch(/const b = 3;\n\s+└ ✎ first remark\n\s+└ ✎ second remark/);
	});

	it("a context line is numbered by its new side", async () => {
		const o = await make({ diff: withFile({ path: "m.ts", status: "M", binary: false, hunks: [{ header: "@@ -5 +7 @@", lines: [{ kind: " ", text: "moved", oldNo: 5, newNo: 7 }] }] }) });
		expect(o.cursor()).toBe("▶    7   moved");
	});

	it("draws added lines as success, removed as error, comments and outdated ones as warning, the cursor in accent", async () => {
		const o = await make({ theme: true, comments: [comment({ line: 2 }), comment({ line: 99, lineText: "+nope", text: "old" })] });
		const out = o.text();
		expect(out).toContain("<success>+ const b = 3;</success>");
		expect(out).toContain("<error>- const b = 2;</error>");
		expect(out).toContain("<warning>└ ✎ why three</warning>");
		expect(out).toContain("<warning>✎ outdated (line 99): old</warning>");
		expect(out).toContain("<accent>▶</accent>");
		expect(out).toContain("<b>#4 users migration · M a.ts</b>");
	});

	it("a long comment wraps under its line", async () => {
		const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
		const o = await make({ comments: [comment({ line: 2, text })] });
		const lines = o.overlay.render(40);
		expect(lines.filter((l) => l.startsWith("       ")).length).toBeGreaterThan(1);
		expect(lines.join("\n")).toContain("mu");
	});

	it("the rule is at most 120 wide; a line wider than the terminal is cut", async () => {
		const o = await make();
		expect(o.overlay.render(200)[2]!.length).toBe(120);
		const long = await make({ diff: withFile({ path: "b.bin", status: "M", binary: false, hunks: [], summary: "s".repeat(80) }) });
		for (const l of long.overlay.render(20)) expect(visibleWidth(l)).toBeLessThanOrEqual(20);
		expect(long.overlay.render(200)[1]).toBe(" ");
	});

	it("the body takes the terminal's height less nine, 30 rows when it is unknown", async () => {
		const o = await make({ diff: withFile(longFile(60)) });
		expect(o.overlay.render(100)).toHaveLength(3 + 21 + 1 + 1);
		const unknown = await make({ diff: withFile(longFile(60)), termRows: 0 });
		expect(unknown.overlay.render(100)).toHaveLength(26);
		const short = await make({ diff: withFile(longFile(60)), termRows: 12 });
		expect(short.overlay.render(100)).toHaveLength(3 + 4 + 1 + 1);
	});

	it("scrolls back up with the cursor; a reload to a shorter diff goes back to the top", async () => {
		const o = await make({ diff: withFile(longFile(60)) });
		for (let i = 0; i < 40; i++) o.key("j");
		expect(o.text()).not.toContain("row0\n");
		for (let i = 0; i < 40; i++) o.key("k");
		expect(o.text()).toContain("row0\n");
		for (let i = 0; i < 40; i++) o.key("j");
		expect(o.text()).not.toContain("row0\n");
		o.state.diff = withFile(longFile(5));
		o.key("r");
		await tick();
		expect(o.text()).toContain("row0\n");
	});

	it("the lines of a comment stay in view with the line they belong to", async () => {
		const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
		const o = await make({ diff: withFile(longFile(60)), comments: [comment({ file: "m.ts", line: 30, lineText: "+row29", text })] });
		for (let i = 0; i < 29; i++) o.key("j");
		expect(o.cursor()).toContain("row29");
		expect(o.text()).toContain("tau");
	});

	it("Page Down moves ten rows", async () => {
		const o = await make({ diff: withFile(longFile(60)) });
		o.key("\x1b[6~");
		expect(o.cursor()).toContain("row10");
		o.key("\x1b[5~");
		expect(o.cursor()).toContain("row0");
	});

	it("] at the last file stays where the cursor is", async () => {
		const o = await make({ diff: { ...diffOf(), files: [diffOf().files[1]!, diffOf().files[0]!] } });
		o.key("]", "j", "j");
		const at = o.cursor();
		o.key("]");
		expect(o.cursor()).toBe(at);
		o.key("[", "]");
		expect(o.cursor()).toContain("const a = 1;");
	});

	it("the boxes are focused (they draw the cursor)", async () => {
		const o = await make();
		o.key("j", "c");
		expect(o.text()).toContain("_pi:c");
		const b = await make();
		b.key("b");
		expect(b.text()).toContain("_pi:c");
	});

	it("a command's end frees the overlay for the next; after dispose the review does not close", async () => {
		let n = 0;
		const o = await make({ opts: { tasksCommand: async () => void n++ } });
		o.key("m");
		await tick();
		o.key("m");
		await tick();
		expect(n).toBe(2);
		expect(o.h.texts()).toEqual([]);
		let finish!: () => void;
		const d = await make({
			opts: {
				tasksCommand: () => new Promise<void>((r) => (finish = r)),
			},
		});
		d.key("m");
		d.state.tasks = [reviewTask([], "merged")];
		d.overlay.dispose!();
		finish();
		await tick();
		expect(d.h.log.closes).toBe(0);
		expect(d.closed).toEqual([]);
	});

	it("a comment and a delete repaint when they land", async () => {
		const o = await make({ comments: [comment({ line: 2 })] });
		o.key("j", "j", "d");
		const before = o.h.log.renders;
		await tick();
		expect(o.h.log.renders).toBeGreaterThan(before);
		o.key("c");
		o.type("x");
		o.key("\r");
		const mid = o.h.log.renders;
		await tick();
		expect(o.h.log.renders).toBeGreaterThan(mid);
	});
});
