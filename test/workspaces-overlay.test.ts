// M72: the workspace overlay on its own: a fake port, a fake host, keys through handleInput.
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createWorkspacesOverlay, type WorkspacesOpts } from "../hub/overlays/workspaces.ts";
import type { Overlay } from "../hub/overlay-host.ts";
import type { BoardTask } from "../lib/board.ts";
import type { Event } from "../lib/protocol.ts";
import { fakeHost, jobRow, task, tick, ws } from "./support/overlay-host.ts";
import { fakePort } from "./support/roost-port.ts";

const changes = (async () => ({ files: [{ status: "M", path: "db/schema.sql", add: 12, del: 1 }, { status: "A", path: "db/0004_users.sql", add: 40, del: 0 }], insertions: 52, deletions: 1, commits: 2, dirty: false })) as never;
const board = (): BoardTask[] => [
	task(5, "login page", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") }),
	task(4, "users migration", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("review", { note: "verified: npm test (3s)" }) }),
	task(6, "rate limiter", { workspace: ws("conflict", { note: "conflict in src/rate.ts" }) }),
	task(9, "audit log", { after: [4] }),
];

async function make(tasks: BoardTask[] = board(), over: { opts?: Partial<WorkspacesOpts>; answers?: Record<string, (...a: any[]) => unknown>; taskChanges?: unknown; termRows?: number } = {}) {
	const state = { tasks };
	const port = fakePort({
		"tasks.list": () => ({ tasks: state.tasks }),
		"tasks.approve": (a: { dry?: boolean }) => (a.dry ? { tasks: [], note: "verify: npm test", hash: "h1" } : { tasks: [], note: "approved for r: verify: npm test" }),
		"tasks.pr": (a: { dry?: boolean }) => (a.dry ? { tasks: [], note: "push roost/t4 (aaaaaaaa) and open a pull request into main", hash: "t1" } : { tasks: [], note: "pushed to origin · https://example.com/pull/7" }),
		...over.answers,
	});
	const h = fakeHost(port.port as never, { taskChanges: (over.taskChanges ?? changes) as never, ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}) } as never);
	h.rows.set("w1", jobRow());
	const commands: string[] = [];
	const reviews: number[] = [];
	const opts: WorkspacesOpts = {
		here: null,
		next: false,
		tasksCommand: async (line) => {
			commands.push(line);
		},
		openReview: (id) => void reviews.push(id),
		...over.opts,
	};
	const overlay = (await createWorkspacesOverlay(h.host as never, opts)) as Overlay;
	h.mount(overlay);
	const text = (w = 120) => overlay.render(w).join("\n");
	const key = (...ks: string[]) => ks.forEach((k) => overlay.handleInput!(k));
	const type = (s: string) => [...s].forEach((c) => overlay.handleInput!(c));
	const lists = () => port.calls.filter((c) => c.path === "tasks.list");
	const calls = (path: string) => port.calls.filter((c) => c.path === path).map((c) => c.args[0]);
	return { overlay, h, port, state, commands, reviews, text, key, type, lists, calls };
}
const board_event = { event: "board", board: {} } as unknown as Event;

describe("the workspace overlay: the screen", () => {
	it("lists the pipeline, review first; the selected one's detail beside it", async () => {
		const o = await make();
		const out = o.text();
		expect(out).toContain("all projects · workspaces");
		expect(out.indexOf("REVIEW")).toBeLessThan(out.indexOf("CONFLICT · FAILED"));
		expect(out.indexOf("CONFLICT · FAILED")).toBeLessThan(out.indexOf("WORKING"));
		expect(out.indexOf("WORKING")).toBeLessThan(out.indexOf("OPEN"));
		expect(out).toContain("▶ ◆ #4 users migration");
		expect(out).toContain("+52 −1");
		expect(out).toContain("#9 audit log · after #4");
		expect(out).toContain("roost/t-review (base main)");
		expect(out).toContain("2 files +52 −1 · 2 commits");
		expect(out).toContain("db/0004_users.sql");
		expect(out).toContain("m merge · b back · v verify");
		expect(out).toContain("1 working · 1 in review · 1 to fix · 1 open");
	});

	it("names the repository when it is in one; says so when it holds nothing", async () => {
		const o = await make([], { opts: { here: "/home/me/proj" } });
		expect(o.text()).toContain("proj · workspaces");
		expect(o.text()).toContain("no tasks here: /tasks add <title>");
		expect(o.lists()[0]!.args).toEqual([{ project: "/home/me/proj" }]);
		const all = await make([]);
		expect(all.text()).toContain("no tasks");
		expect(all.lists()[0]!.args).toEqual([{}]);
	});

	it("under 100 columns the detail goes below the list, from 100 beside it", async () => {
		const o = await make();
		const narrow = o.overlay.render(80);
		const at = (s: string) => narrow.findIndex((l) => l.includes(s));
		expect(at("roost/t-review (base main)")).toBeGreaterThan(at("#9 audit log"));
		expect(narrow.every((l) => !l.includes("│"))).toBe(true);
		expect(o.overlay.render(99).some((l) => l.includes("│"))).toBe(false);
		expect(o.overlay.render(100).some((l) => l.includes("│"))).toBe(true);
	});

	it("no line is wider than the terminal", async () => {
		const o = await make();
		for (const w of [20, 40, 99, 100, 120]) for (const l of o.overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
	});

	it("shows the host's notice while it lasts, above the keys", async () => {
		const o = await make();
		o.h.host.say("merging #4…", "muted");
		const lines = o.overlay.render(120);
		expect(lines.at(-2)).toBe("merging #4…");
		o.h.mount(o.overlay);
		// an expired notice is not drawn
		const stale = await make(board(), {});
		stale.h.host.notice = () => ({ text: "old", tone: "muted", until: Date.now() - 1 });
		expect(stale.text()).not.toContain("old");
	});

	it("a worktree's changes load in the background, 'loading' meanwhile; a failed read leaves the row plain", async () => {
		let release!: (v: unknown) => void;
		const slow = (() => new Promise((r) => (release = r))) as never;
		const o = await make([task(4, "users", { workspace: ws("review") })], { taskChanges: slow });
		expect(o.text()).toContain("change  …");
		const before = o.h.log.renders;
		release({ files: [{ status: "M", path: "a.ts", add: 3, del: 0 }], insertions: 3, deletions: 0, commits: 1, dirty: false });
		await tick();
		expect(o.h.log.renders).toBeGreaterThan(before);
		expect(o.text()).toContain("+3");
		const failing = await make([task(4, "users", { workspace: ws("review") })], { taskChanges: (async () => Promise.reject(new Error("git"))) as never });
		await tick();
		expect(failing.text()).toContain("#4 users");
		expect(failing.text()).not.toContain("change  …");
	});

	it("marks tasks at work that change the same files; a merged or path-less task is not read", async () => {
		const reads: string[] = [];
		const spy = (async (path: string) => {
			reads.push(path);
			return { files: [{ status: "M", path: "same.ts", add: 1, del: 0 }], insertions: 1, deletions: 0, commits: 1, dirty: false };
		}) as never;
		const o = await make([task(1, "a", { workspace: ws("working") }), task(2, "b", { workspace: ws("review") }), task(3, "c", { workspace: ws("merged", { merge: { at: Date.now() } }) }), task(4, "d", { workspace: ws("review", { path: "" }) })], { taskChanges: spy });
		await tick();
		expect(o.text()).toContain("⚠ +1 −0");
		expect(o.text()).toContain("overlap");
		expect(reads.sort()).toEqual(["/r/.pi/worktrees/x-review", "/r/.pi/worktrees/x-working"]);
	});

	it("an idle session is marked idle on a working task", async () => {
		const o = await make([task(1, "a", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") })], { taskChanges: (async () => undefined) as never });
		o.h.rows.set("w1", jobRow({ pid: null, state: "stopped" }));
		expect(o.text()).toContain("idle");
	});
});

describe("the workspace overlay: opening", () => {
	it("a failed load says why and gives no overlay", async () => {
		const port = fakePort({ "tasks.list": () => Promise.reject(new Error("daemon says no")) });
		const h = fakeHost(port.port as never);
		const o = await createWorkspacesOverlay(h.host as never, { here: null, next: false, tasksCommand: async () => {}, openReview: () => {} });
		expect(o).toBeUndefined();
		expect(h.said).toEqual([{ text: "daemon says no", tone: "error" }]);
	});

	it("next: opens at the first task that needs you; says when none does or when there are none", async () => {
		const first = await make(board(), { opts: { next: true } });
		expect(first.text()).toContain("▶ ◆ #4 users migration");
		expect(first.h.said).toEqual([]);
		const quiet = await make([task(5, "login page", { workspace: ws("working") })], { opts: { next: true } });
		expect(quiet.h.texts()).toEqual(["nothing needs you"]);
		expect(quiet.text()).toMatch(/▶ \S #5 login page/);
		const none = await make([], { opts: { next: true } });
		expect(none.h.texts()).toEqual(["no tasks in workspaces: /tasks add, then s on it here"]);
	});

	it("focus selects that task; a focus that is gone selects the first", async () => {
		const at = await make(board(), { opts: { focus: 6 } });
		expect(at.text()).toContain("▶ ✕ #6 rate limiter");
		const gone = await make(board(), { opts: { focus: 99 } });
		expect(gone.text()).toContain("▶ ◆ #4 users migration");
	});
});

describe("the workspace overlay: keys", () => {
	it("n goes to the next that needs you and round; says when nothing does", async () => {
		const o = await make();
		o.key("n");
		expect(o.text()).toContain("▶ ✕ #6 rate limiter");
		o.key("n");
		expect(o.text()).toContain("▶ ◆ #4 users migration");
		const quiet = await make([task(5, "x", { workspace: ws("working") })]);
		quiet.key("n");
		expect(quiet.h.texts()).toEqual(["nothing needs you"]);
		quiet.key("\x0e");
		expect(quiet.h.texts()).toHaveLength(2);
	});

	it("up and down move within the list, stopping at its ends; home and end jump", async () => {
		const o = await make();
		const sel = () => o.overlay.render(120).find((l) => l.includes("▶"))!;
		o.key("\x1b[A");
		expect(sel()).toContain("#4");
		o.key("\x1b[B");
		expect(sel()).toContain("#6");
		o.key("\x1b[F");
		expect(sel()).toContain("#9");
		o.key("\x1b[B");
		expect(sel()).toContain("#9");
		o.key("\x1b[H");
		expect(sel()).toContain("#4");
	});

	it("Esc, Ctrl+C and q close", async () => {
		for (const k of ["\x1b", "\x03", "q"]) {
			const o = await make();
			o.key(k);
			expect(o.h.log.closes).toBe(1);
		}
	});

	it("m, v, p, x, h and s act through /tasks on the selected task, only where the stage allows it", async () => {
		const o = await make();
		// a task in review: merge and verify, not pass, abort, shelve or start
		o.key("p", "x", "h", "s");
		expect(o.commands).toEqual([]);
		o.key("m");
		await tick();
		expect(o.commands).toEqual(["merge 4"]);
		o.key("v");
		await tick();
		expect(o.commands).toEqual(["merge 4", "verify 4"]);
		// the conflicted one: pass is for a failed task, abort a sync, start again
		o.key("\x1b[B");
		o.key("x");
		await tick();
		expect(o.commands.at(-1)).toBe("abort 6");
		// the open one at the end
		o.key("\x1b[F");
		o.key("s");
		await tick();
		expect(o.commands.at(-1)).toBe("start 9");
		const failed = await make([task(7, "f", { workspace: ws("failed", { note: "verify failed" }) })]);
		failed.key("p");
		await tick();
		expect(failed.commands).toEqual(["pass 7"]);
		const shelvable = await make([task(8, "s", { workspace: ws("review") })]);
		shelvable.key("h");
		await tick();
		expect(shelvable.commands).toEqual(["shelve 8"]);
	});

	it("a key does nothing with nothing selected", async () => {
		const o = await make([]);
		o.key("m", "s", "a", "b", "o", "\r", "t");
		await tick();
		expect(o.commands).toEqual([]);
		expect(o.calls("tasks.approve")).toEqual([]);
		expect(o.h.said).toEqual([]);
	});

	it("while a command runs another does not start; after it the board is read again", async () => {
		let finish!: () => void;
		const o = await make(board(), { opts: { tasksCommand: (line) => new Promise<void>((r) => ((finish = r), void line)) } });
		const before = o.lists().length;
		o.key("m");
		o.key("v");
		await tick();
		finish();
		await tick();
		expect(o.lists().length).toBe(before + 1);
		o.key("v");
		await tick();
		expect(o.lists().length).toBe(before + 1);
	});

	it("r reads the board and the worktrees again", async () => {
		let reads = 0;
		const o = await make(board(), { taskChanges: (async () => (reads++, undefined)) as never });
		const r0 = reads;
		const l0 = o.lists().length;
		o.key("\x1b[B");
		await tick();
		expect(reads).toBe(r0);
		o.key("r");
		await tick();
		expect(o.lists().length).toBe(l0 + 1);
		expect(reads).toBeGreaterThan(r0);
	});
});

describe("the workspace overlay: back with a note", () => {
	it("b opens a note box; Enter sends it to the task it was written for, wherever the selection went", async () => {
		const o = await make();
		o.key("b");
		o.type("use a transaction");
		expect(o.text()).toContain("#4 back › use a transaction");
		expect(o.text()).toContain("Enter send back with this note (empty: none) · Esc cancel");
		// the board changes under it
		o.state.tasks = o.state.tasks.filter((t) => t.id !== 4).concat(task(4, "users migration", { workspace: ws("review") }));
		o.key("\r");
		await tick();
		expect(o.commands).toEqual(["back 4 use a transaction"]);
	});

	it("an empty note sends none; Esc and Ctrl+C cancel; a task gone meanwhile sends nothing", async () => {
		const o = await make();
		o.key("b", "\r");
		await tick();
		expect(o.commands).toEqual(["back 4"]);
		o.key("b");
		o.type("x");
		o.key("\x1b");
		expect(o.text()).not.toContain("back ›");
		o.key("b", "\x03");
		expect(o.text()).not.toContain("back ›");
		o.key("b");
		o.type("lost");
		o.state.tasks = [];
		// the overlay only knows the board it loaded: the task is still there until a reload
		o.key("\r");
		await tick();
		expect(o.commands).toEqual(["back 4", "back 4 lost"]);
	});

	it("keys go to the box, not the list", async () => {
		const o = await make();
		o.key("b");
		o.type("mq");
		expect(o.h.log.closes).toBe(0);
		expect(o.commands).toEqual([]);
	});

	it("a note written for a task that a reload dropped is not sent", async () => {
		const o = await make();
		o.key("b");
		o.type("late");
		o.state.tasks = o.state.tasks.filter((t) => t.id !== 4);
		o.overlay.onEvent!(board_event);
		await tick();
		o.key("\r");
		await tick();
		expect(o.commands).toEqual([]);
	});
});

describe("the workspace overlay: approve and pull request", () => {
	it("a shows the commands in full and approves on y only, with the shown hash", async () => {
		const o = await make();
		o.key("a");
		await tick();
		expect(o.calls("tasks.approve")).toEqual([{ id: 4, dry: true }]);
		expect(o.text()).toContain("approve for #4: verify: npm test · they run in your account");
		expect(o.text()).toContain("y approve these commands · any other key: no");
		o.key("y");
		await tick();
		expect(o.calls("tasks.approve")).toEqual([{ id: 4, dry: true }, { id: 4, hash: "h1" }]);
		expect(o.h.texts().at(-1)).toBe("approved for r: verify: npm test");
		expect(o.h.said.at(-1)!.tone).toBe("success");
		expect(o.text()).not.toContain("approve for #4");
	});

	it("any other key is no: it says so and sends nothing", async () => {
		const o = await make();
		o.key("a");
		await tick();
		// a second a is not a yes
		o.key("a");
		expect(o.h.texts()).toEqual(["not approved"]);
		expect(o.calls("tasks.approve")).toEqual([{ id: 4, dry: true }]);
		expect(o.text()).not.toContain("approve for #4");
	});

	it("nothing to approve (no hash) says the daemon's note and shows no confirm", async () => {
		const o = await make(board(), { answers: { "tasks.approve": () => ({ tasks: [], note: "no verify commands" }) } });
		o.key("a");
		await tick();
		expect(o.h.texts()).toEqual(["no verify commands"]);
		expect(o.text()).not.toContain("any other key: no");
		const bare = await make(board(), { answers: { "tasks.approve": () => ({ tasks: [] }) } });
		bare.key("a");
		await tick();
		expect(bare.h.texts()).toEqual(["nothing to approve"]);
	});

	it("a refused approve says why; a refused y says why and the overlay stays usable", async () => {
		const dry = await make(board(), { answers: { "tasks.approve": () => Promise.reject(new Error("not allowed")) } });
		dry.key("a");
		await tick();
		expect(dry.h.said).toEqual([{ text: "not allowed", tone: "error" }]);
		dry.key("m");
		await tick();
		expect(dry.commands).toEqual(["merge 4"]);
		let n = 0;
		const late = await make(board(), { answers: { "tasks.approve": (a: { dry?: boolean }) => (a.dry ? { tasks: [], note: "x", hash: "h" } : (n++, Promise.reject(new Error("commands changed")))) } });
		late.key("a");
		await tick();
		late.key("y");
		await tick();
		expect(late.h.said.at(-1)).toEqual({ text: "commands changed", tone: "error" });
		late.key("a");
		await tick();
		expect(late.text()).toContain("approve for #4");
	});

	it("o shows the pull request and opens it on y with the hash shown; y says it is pushing", async () => {
		const o = await make([task(4, "users", { workspace: ws("review") })], { taskChanges: (async () => undefined) as never });
		o.key("o");
		await tick();
		expect(o.calls("tasks.pr")).toEqual([{ id: 4, dry: true }]);
		expect(o.text()).toContain("#4: push roost/t4 (aaaaaaaa) and open a pull request into main?");
		expect(o.text()).toContain("y push and open it · any other key: no");
		o.key("y");
		expect(o.h.texts()).toEqual(["#4: pushing…"]);
		await tick();
		expect(o.calls("tasks.pr")).toEqual([{ id: 4, dry: true }, { id: 4, hash: "t1" }]);
		expect(o.h.texts().at(-1)).toBe("pushed to origin · https://example.com/pull/7");
	});

	it("another key than y is no pull request; no hash shows no confirm; an error is said", async () => {
		const o = await make([task(4, "users", { workspace: ws("review") })], { taskChanges: (async () => undefined) as never });
		o.key("o");
		await tick();
		o.key("n");
		expect(o.h.texts()).toEqual(["no pull request"]);
		expect(o.calls("tasks.pr")).toHaveLength(1);
		const bare = await make([task(4, "users", { workspace: ws("review") })], { answers: { "tasks.pr": () => ({ tasks: [], note: "x" }) } });
		bare.key("o");
		await tick();
		expect(bare.text()).not.toContain("any other key: no");
		const bad = await make([task(4, "users", { workspace: ws("review") })], { answers: { "tasks.pr": () => Promise.reject(new Error("no remote")) } });
		bad.key("o");
		await tick();
		expect(bad.h.said).toEqual([{ text: "no remote", tone: "error" }]);
	});

	it("while one asks, a second a or o asks nothing more", async () => {
		let release!: (v: unknown) => void;
		const o = await make(board(), { answers: { "tasks.approve": () => new Promise((r) => (release = r)) } });
		o.key("a");
		o.key("a");
		o.key("o");
		await tick();
		expect(o.calls("tasks.approve")).toHaveLength(1);
		expect(o.calls("tasks.pr")).toEqual([]);
		release({ tasks: [], note: "n", hash: "h1" });
		await tick();
		expect(o.text()).toContain("approve for #4");
	});
});

describe("the workspace overlay: Enter, t and the right arrow", () => {
	it("Enter on a task with a worktree closes and opens its review", async () => {
		const o = await make();
		o.key("\r");
		expect(o.h.log.closes).toBe(1);
		expect(o.reviews).toEqual([4]);
		expect(o.h.attached).toEqual([]);
	});

	it("Enter on a shelved or merged task does not review: it attaches when a session runs, else does nothing", async () => {
		const o = await make([task(8, "old", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("shelved") })]);
		o.key("\r");
		expect(o.reviews).toEqual([]);
		expect(o.h.attached).toEqual(["w1"]);
		expect(o.h.log.closes).toBe(1);
		const merged = await make([task(8, "old", { state: "done", doneAt: Date.now(), workspace: ws("merged", { merge: { at: Date.now() } }) })]);
		merged.key("\r");
		expect(merged.reviews).toEqual([]);
		expect(merged.h.log.closes).toBe(0);
		expect(merged.h.said).toEqual([]);
	});

	it("Enter on an open task without a worktree does nothing; a path-less workspace is not reviewed", async () => {
		const o = await make([task(9, "audit log")]);
		o.key("\r");
		expect(o.reviews).toEqual([]);
		expect(o.h.said).toEqual([]);
		const bare = await make([task(4, "x", { workspace: ws("review", { path: "" }) })]);
		bare.key("\r");
		expect(bare.reviews).toEqual([]);
	});

	it("t and right attach to the running session and close; they say when none runs, with s when it can start", async () => {
		const o = await make([task(5, "login", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") })]);
		o.key("t");
		expect(o.h.attached).toEqual(["w1"]);
		expect(o.h.log.closes).toBe(1);
		const right = await make([task(5, "login", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") })]);
		right.key("\x1b[C");
		expect(right.h.attached).toEqual(["w1"]);
		const idle = await make([task(9, "audit log")]);
		idle.key("t");
		expect(idle.h.texts()).toEqual(["#9 has no session running: s starts one"]);
		const noStart = await make([task(4, "u", { state: "done", doneAt: Date.now(), workspace: ws("merged", { merge: { at: Date.now() } }) })]);
		noStart.key("t");
		expect(noStart.h.texts()).toEqual(["#4 has no session running"]);
		const stopped = await make([task(5, "login", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") })]);
		stopped.h.rows.set("w1", jobRow({ pid: null }));
		stopped.key("t");
		expect(stopped.h.attached).toEqual([]);
		expect(stopped.h.texts()[0]).toContain("has no session running");
	});

	it("an attach that fails is said", async () => {
		const port = fakePort({ "tasks.list": () => ({ tasks: [task(5, "login", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") })] }) });
		const h = fakeHost(port.port as never, { attachTo: () => Promise.reject(new Error("host gone")), taskChanges: (async () => undefined) as never } as never);
		h.rows.set("w1", jobRow());
		const o = (await createWorkspacesOverlay(h.host as never, { here: null, next: false, tasksCommand: async () => {}, openReview: () => {} }))!;
		o.handleInput!("t");
		await tick();
		expect(h.said).toEqual([{ text: "host gone", tone: "error" }]);
	});
});

describe("the workspace overlay: following the board", () => {
	it("a board event reads the tasks again; other events do not", async () => {
		const o = await make();
		const n = o.lists().length;
		o.overlay.onEvent!({ event: "job" } as unknown as Event);
		await tick();
		expect(o.lists().length).toBe(n);
		o.state.tasks = [...o.state.tasks, task(10, "new one", { workspace: ws("review") })];
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.lists().length).toBe(n + 1);
		expect(o.text()).toContain("#10 new one");
	});

	it("one read at a time; one more after it when asked meanwhile", async () => {
		const pending: ((v: unknown) => void)[] = [];
		let slow = false;
		const o = await make(board(), { answers: { "tasks.list": () => (slow ? new Promise((r) => pending.push(r)) : { tasks: board() }) } });
		const n = o.lists().length;
		slow = true;
		o.overlay.onEvent!(board_event);
		o.overlay.onEvent!(board_event);
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.lists().length).toBe(n + 1);
		slow = false;
		pending[0]!({ tasks: board() });
		await tick(15);
		expect(o.lists().length).toBe(n + 2);
	});

	it("a failed read is said and the overlay keeps the board it had", async () => {
		let fail = false;
		const o = await make(board(), { answers: { "tasks.list": () => (fail ? Promise.reject(new Error("daemon gone")) : { tasks: board() }) } });
		fail = true;
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.h.said).toEqual([{ text: "daemon gone", tone: "error" }]);
		expect(o.text()).toContain("#4 users migration");
	});

	it("keeps the selection across a reload; falls to the first when its task is gone", async () => {
		const o = await make();
		o.key("\x1b[B");
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.text()).toContain("▶ ✕ #6 rate limiter");
		o.state.tasks = o.state.tasks.filter((t) => t.id !== 6);
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.text()).toContain("▶ ◆ #4 users migration");
	});

	it("stops after dispose, and when another overlay replaced it without closing", async () => {
		const disposed = await make();
		const n = disposed.lists().length;
		disposed.overlay.dispose!();
		disposed.overlay.onEvent!(board_event);
		await tick();
		expect(disposed.lists().length).toBe(n);
		const replaced = await make();
		const m = replaced.lists().length;
		replaced.h.mount({ render: () => [] });
		replaced.overlay.onEvent!(board_event);
		await tick();
		expect(replaced.lists().length).toBe(m);
		// and for good: the host's current coming back does not revive it
		replaced.h.mount(replaced.overlay);
		replaced.overlay.onEvent!(board_event);
		await tick();
		expect(replaced.lists().length).toBe(m);
	});

	it("a read that lands after dispose changes nothing", async () => {
		let release!: (v: unknown) => void;
		let slow = false;
		const o = await make(board(), { answers: { "tasks.list": () => (slow ? new Promise((r) => (release = r)) : { tasks: board() }) } });
		slow = true;
		o.overlay.onEvent!(board_event);
		o.overlay.dispose!();
		const renders = o.h.log.renders;
		release({ tasks: [] });
		await tick();
		expect(o.text()).toContain("#4 users migration");
		expect(o.h.log.renders).toBe(renders);
	});

	it("a worktree read that lands after dispose does not ask for a repaint", async () => {
		let release!: (v: unknown) => void;
		const o = await make([task(4, "users", { workspace: ws("review") })], { taskChanges: (() => new Promise((r) => (release = r))) as never });
		o.overlay.dispose!();
		const renders = o.h.log.renders;
		release(undefined);
		await tick();
		expect(o.h.log.renders).toBe(renders);
	});

	it("a command's end reads the board even after a refusal", async () => {
		const o = await make(board(), { opts: { tasksCommand: () => Promise.resolve() } });
		const n = o.lists().length;
		o.key("m");
		await tick();
		expect(o.lists().length).toBe(n + 1);
	});
});

describe("the workspace overlay: more of the screen and keys", () => {
	it("the idle marker is for a working task only; a stage is titled once for all its tasks", async () => {
		const o = await make([task(1, "a", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("review") }), task(2, "b", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("review") })], { taskChanges: (async () => undefined) as never });
		o.h.rows.set("w1", jobRow({ pid: null, state: "stopped" }));
		expect(o.text()).not.toContain("idle");
		expect(o.text().match(/REVIEW/g)).toHaveLength(1);
	});

	it("the detail says what the session says; the list is at most 48 wide beside the detail", async () => {
		const o = await make();
		expect(o.text()).toContain('said    "running bash"');
		const bar = o.overlay.render(200).find((l) => l.includes("│"))!;
		expect(bar.indexOf("│")).toBe(49);
		expect(o.overlay.render(100).find((l) => l.includes("│"))!.indexOf("│")).toBe(43);
	});

	const many = () => Array.from({ length: 20 }, (_, i) => task(i + 1, `task ${i + 1}`, { workspace: ws("review") }));

	it("the list scrolls to keep the selection in view, both ways, in a short terminal", async () => {
		const o = await make(many(), { termRows: 14 });
		const sel = () => o.overlay.render(120).find((l) => l.includes("▶"))!;
		expect(o.text()).not.toContain("#12 task 12");
		for (let i = 0; i < 12; i++) o.key("\x1b[B");
		expect(sel()).toContain("#13 task 13");
		expect(o.text()).not.toContain("#1 task 1\n");
		for (let i = 0; i < 12; i++) o.key("\x1b[A");
		expect(sel()).toContain("#1 task 1");
		expect(o.text()).toContain("#1 task 1");
		o.key("\x1b[F");
		expect(sel()).toContain("#20 task 20");
	});

	it("the room follows the terminal's height; under 100 columns the list gets half of it", async () => {
		const tall = await make(many(), { termRows: 40 });
		const short = await make(many(), { termRows: 12 });
		expect(tall.overlay.render(120).length).toBeGreaterThan(short.overlay.render(120).length);
		expect([tall.overlay.render(120).length, short.overlay.render(120).length]).toEqual([30, 8]);
		const narrow = await make(many(), { termRows: 40 });
		// half the room (16 lines: the group title and 15 tasks)
		expect(narrow.overlay.render(80).filter((l) => /^ {2}. #\d+ task/.test(l) || /^▶ . #\d+ task/.test(l))).toHaveLength(15);
	});

	it("moving the selection reads its worktree again when the last read is old", async () => {
		let reads = 0;
		const now = vi.spyOn(Date, "now");
		try {
			const o = await make(board(), { taskChanges: (async () => (reads++, undefined)) as never });
			const r0 = reads;
			now.mockReturnValue(Date.now() + 6000);
			o.key("\x1b[B");
			expect(reads).toBeGreaterThan(r0);
			await tick();
			const r1 = reads;
			now.mockReturnValue(Date.now() + 12000);
			o.key("\x1b[A");
			expect(reads).toBeGreaterThan(r1);
			await tick();
			const r2 = reads;
			now.mockReturnValue(Date.now() + 12000);
			o.key("\x1b[F");
			expect(reads).toBeGreaterThan(r2);
			await tick();
			const r3 = reads;
			now.mockReturnValue(Date.now() + 12000);
			o.key("\x1b[H");
			expect(reads).toBeGreaterThan(r3);
		} finally {
			now.mockRestore();
		}
	});

	it("a read still fresh, or still loading, is not asked again", async () => {
		let reads = 0;
		const o = await make(board(), { taskChanges: (async () => (reads++, undefined)) as never });
		const r0 = reads;
		o.key("\x1b[B", "\x1b[A", "\x1b[F");
		expect(reads).toBe(r0);
		let started = 0;
		const never = await make([task(4, "u", { workspace: ws("review") })], { taskChanges: (() => (started++, new Promise(() => {}))) as never });
		never.key("\x1b[B", "\x1b[H");
		never.overlay.onEvent!(board_event);
		await tick();
		expect(started).toBe(1);
	});

	it("a worktree is read again when its stage, note or verify changed; the old reading shows meanwhile", async () => {
		let release!: (v: unknown) => void;
		let first = true;
		const read = (() => (first ? ((first = false), Promise.resolve({ files: [{ status: "M", path: "a.ts", add: 7, del: 0 }], insertions: 7, deletions: 0, commits: 1, dirty: false })) : new Promise((r) => (release = r)))) as never;
		const o = await make([task(4, "u", { workspace: ws("review", { note: "one" }) })], { taskChanges: read });
		await tick();
		expect(o.text()).toContain("+7");
		o.state.tasks = [task(4, "u", { workspace: ws("review", { note: "two" }) })];
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.text()).toContain("+7");
		release(undefined);
	});

	it("the note is one line without extra spaces", async () => {
		const o = await make();
		o.key("b");
		o.type("a   b");
		o.key("\r");
		await tick();
		expect(o.commands).toEqual(["back 4 a b"]);
		const q = await make();
		q.key("b");
		expect(q.text()).toContain("_pi:c");
	});

	it("the daemon's notes are shown on one line; an approve without a note says approved", async () => {
		const o = await make(board(), { answers: { "tasks.approve": (a: { dry?: boolean }) => (a.dry ? { tasks: [], note: "line one\nline two", hash: "h1" } : { tasks: [] }) } });
		o.key("a");
		await tick();
		expect(o.text()).toContain("verify".slice(0, 0) + "line one line two");
		o.key("y");
		await tick();
		expect(o.h.texts()).toEqual(["approved"]);
	});

	it("after y the board is read again; while it is on its way no command starts", async () => {
		let release!: (v: unknown) => void;
		const o = await make(board(), { answers: { "tasks.approve": (a: { dry?: boolean }) => (a.dry ? { tasks: [], note: "n", hash: "h1" } : new Promise((r) => (release = r))) } });
		o.key("a");
		await tick();
		const n = o.lists().length;
		o.key("y");
		o.key("m");
		await tick();
		expect(o.commands).toEqual([]);
		release({ tasks: [], note: "done" });
		await tick();
		expect(o.lists().length).toBe(n + 1);
		o.key("m");
		await tick();
		expect(o.commands).toEqual(["merge 4"]);
	});

	it("the right arrow says when no session runs; Enter on a task without one stays quiet", async () => {
		const o = await make([task(9, "audit log")]);
		o.key("\x1b[C");
		expect(o.h.texts()).toEqual(["#9 has no session running: s starts one"]);
		o.key("\r");
		expect(o.h.texts()).toHaveLength(1);
	});

	it("while a command runs, a second one on the same overlay does not start", async () => {
		let n = 0;
		const o = await make(board(), { opts: { tasksCommand: () => (n++, new Promise<void>(() => {})) } });
		o.key("m");
		o.key("v");
		o.key("b", "\r");
		await tick();
		expect(n).toBe(1);
	});
});

describe("the workspace overlay: the last rules", () => {
	it("a task whose workspace has no base is not read", async () => {
		const reads: string[] = [];
		await make([task(4, "u", { workspace: ws("review", { baseRef: "" }) })], { taskChanges: (async (p: string) => void reads.push(p)) as never });
		expect(reads).toEqual([]);
	});

	it("a read still on its way is not started again when the task changed meanwhile", async () => {
		let started = 0;
		const o = await make([task(4, "u", { workspace: ws("review", { note: "one" }) })], { taskChanges: (() => (started++, new Promise(() => {}))) as never });
		o.state.tasks = [task(4, "u", { workspace: ws("review", { note: "two" }) })];
		o.overlay.onEvent!(board_event);
		await tick();
		expect(started).toBe(1);
	});

	it("next opens at the task that needs you even when it is not the first", async () => {
		const tasks = [task(5, "calm", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") }), task(6, "stuck", { state: "claimed", owner: { id: "w2", name: "other" }, workspace: ws("working") })];
		const answers = {};
		const plain = await make(tasks, { answers });
		expect(plain.text()).toContain("▶ ● #5 calm");
		const port = fakePort({ "tasks.list": () => ({ tasks }) });
		const h = fakeHost(port.port as never, { taskChanges: (async () => undefined) as never } as never);
		h.rows.set("w1", jobRow());
		h.rows.set("w2", jobRow({ id: "w2", state: "blocked", status: "waiting", waitingFor: "dialog" }));
		const o = (await createWorkspacesOverlay(h.host as never, { here: null, next: true, tasksCommand: async () => {}, openReview: () => {} }))!;
		expect(o.render(120).join("\n")).toMatch(/▶ \S #6 stuck/);
		expect(h.said).toEqual([]);
	});

	it("a reload keeps the selection the person made over the focus it opened with", async () => {
		const o = await make(board(), { opts: { focus: 6 } });
		o.key("\x1b[A");
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.text()).toContain("▶ ◆ #4 users migration");
	});

	it("a reload asks for a repaint", async () => {
		const o = await make();
		const before = o.h.log.renders;
		o.overlay.onEvent!(board_event);
		await tick();
		expect(o.h.log.renders).toBeGreaterThan(before);
	});

	it("an unknown terminal height is 30 rows", async () => {
		const unknown = await make(Array.from({ length: 40 }, (_, i) => task(i + 1, `task ${i + 1}`, { workspace: ws("review") })), { termRows: 0 });
		const known = await make(Array.from({ length: 40 }, (_, i) => task(i + 1, `task ${i + 1}`, { workspace: ws("review") })), { termRows: 30 });
		expect(unknown.overlay.render(120)).toEqual(known.overlay.render(120));
	});
});
