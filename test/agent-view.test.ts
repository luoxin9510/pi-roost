import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AgentView } from "../extensions/agent-view.ts";
import type { DaemonClient } from "../lib/client.ts";
import type { Event, JobRow } from "../lib/protocol.ts";

let n = 0;
function row(over: Partial<JobRow> = {}): JobRow {
	n++;
	const now = Date.now();
	return {
		id: `id${n}`,
		cwd: "/w",
		kind: "pi",
		startedAt: now - 60_000,
		state: "working",
		pid: 100 + n,
		status: "busy",
		waitingFor: null,
		sessionFile: `/s/${n}.jsonl`,
		name: `job ${n}`,
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
		...over,
	};
}

class FakeClient {
	requests: { op: string; args: unknown }[] = [];
	events: ((e: Event) => void)[] = [];
	closes: (() => void)[] = [];
	closed = false;
	rows: JobRow[];
	dispatchDelay = 0;
	replyResult: unknown = { delivered: true, saved: false };
	constructor(rows: JobRow[]) {
		this.rows = rows;
	}
	onEvent(l: (e: Event) => void) {
		this.events.push(l);
		return () => {};
	}
	onClose(l: () => void) {
		this.closes.push(l);
		return () => {};
	}
	close() {
		this.closed = true;
	}
	emit(e: Event) {
		for (const l of this.events) l(e);
	}
	async request(op: string, args: unknown): Promise<unknown> {
		this.requests.push({ op, args });
		if (op === "list") return { jobs: this.rows };
		if (op === "dispatch") {
			await new Promise((r) => setTimeout(r, this.dispatchDelay));
			return { id: "new1", name: "new task" };
		}
		if (op === "reply") return this.replyResult;
		if (op === "pin") return { id: (args as { id: string }).id, pinned: (args as { pinned: boolean }).pinned };
		return {};
	}
}

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const launches: { task: string; opts: unknown }[] = [];
function setup(rows: JobRow[], opts: { rowsHigh?: number; onGroupBy?: (g: string) => void; switchCheckMs?: number } = {}) {
	const client = new FakeClient(rows);
	let renders = 0;
	let doneCalls = 0;
	const tui = {
		terminal: { rows: opts.rowsHigh ?? 30, columns: 80 },
		requestRender: () => renders++,
		stop: () => {},
		start: () => {},
	};
	const view = new AgentView({
		tui: tui as never,
		theme: theme as never,
		cwd: "/w",
		launch: (task, o) => {
			launches.push({ task, opts: o });
			return { cwd: "/w", sessionFile: "/s/x.jsonl", command: ["pi", task], env: {}, name: task, origin: "dispatch" };
		},
		launchShell: (command, cwd) => ({ kind: "shell", cwd, sessionFile: "", command: ["sh", "-lc", command], env: {}, name: `! ${command}`, origin: "dispatch" }),
		commands: () => [
			{ name: "review", source: "prompt" },
			{ name: "settings", source: "builtin" },
		],
		models: () => ["a/one", "b/two"],
		setTitle: () => {},
		connect: async () => client as unknown as DaemonClient,
		done: () => doneCalls++,
		reducedMotion: true,
		onGroupBy: opts.onGroupBy,
		switchCheckMs: opts.switchCheckMs,
	});
	return { view, client, renders: () => renders, done: () => doneCalls };
}

const type = (view: AgentView, text: string) => {
	for (const ch of text) view.handleInput(ch);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AgentView render", () => {
	it("M16: a session with a pull request to review is Ready for review; #N filters to it; peek lists it", async () => {
		const pr = { number: 2048, url: "https://github.com/o/r/pull/2048", status: "failing" as const, needsReview: true, title: "collision fix" };
		const review = row({ name: "jump physics", state: "done", status: "idle", pid: null, prs: [pr] });
		const merged = row({ name: "old work", state: "done", status: "idle", pid: null, prs: [{ ...pr, number: 7, url: "https://github.com/o/r/pull/7", status: "merged", needsReview: false }] });
		const other = row({ name: "busy one" });
		const { view } = setup([review, merged, other]);
		await view.start();
		const text = view.render(120).join("\n").replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
		expect(text).toMatch(/Ready for review[\s\S]*jump physics[\s\S]*Working[\s\S]*Completed[\s\S]*old work/);
		expect(text).toContain("#2048");
		expect(text).toContain("#7");
		for (const w of [30, 45, 60]) for (const l of view.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
		type(view, "#2048");
		const filtered = view.render(120).join("\n");
		expect(filtered).toContain("jump physics");
		expect(filtered).not.toContain("busy one");
		// no session has it: a task to dispatch, not a filter
		for (let i = 0; i < 5; i++) view.handleInput("\x7f");
		type(view, "#99");
		expect(view.render(120).join("\n")).toContain("busy one");
		for (let i = 0; i < 3; i++) view.handleInput("\x7f");
		for (let i = 0; i < 10 && !view.render(120).some((l) => l.includes("›") && l.includes("jump physics")); i++) view.handleInput("\x1b[B");
		view.handleInput(" ");
		expect(view.render(120).join("\n")).toContain("#2048 failing · needs review · collision fix");
		view.dispose();
	});

	it("M13: subagents a session spawns are not rows (Claude Code); one whose parent is gone and still runs is", async () => {
		const parent = row({ name: "parent job" });
		const child = row({ name: "held child", parentSession: parent.sessionFile, parentOpen: true });
		const orphan = row({ name: "orphan child", parentSession: "/s/gone.jsonl", parentOpen: false });
		const orphanDone = row({ name: "orphan done", state: "done", status: "idle", pid: null, parentSession: "/s/gone.jsonl", parentOpen: false });
		const { view } = setup([parent, child, orphan, orphanDone]);
		await view.start();
		const text = view.render(100).join("\n");
		expect(text).toContain("parent job");
		expect(text).toContain("orphan child");
		expect(text).not.toContain("held child");
		expect(text).not.toContain("orphan done");
		view.dispose();
		const { listed } = await import("../lib/view-model.ts");
		expect([listed(child), listed(orphan), listed(orphanDone), listed(child, "inline"), listed(parent)]).toEqual([false, true, false, true, true]);
	});

	it("never renders a line wider than the terminal, whatever the content", async () => {
		const rows = [
			row({ name: "调查不稳定的复位测试用例并修复它", summary: "正在运行 bash：npm test -- --run 很长很长的输出" }),
			row({ state: "failed", status: null, pid: null, error: "Error: boom\n    at x (/a/b.ts:1:2)\n\tat y\u001b[31m red", endedAt: Date.now() }),
			row({ state: "blocked", status: "waiting", waitingFor: "question", question: "Which reset?\nDouble or single?", choices: ["double-ended reset", "single-ended reset"] }),
			...Array.from({ length: 30 }, () => row({ state: "done", status: "idle" })),
		];
		const { view } = setup(rows, { rowsHigh: 12 });
		await view.start();
		for (const width of [1, 5, 10, 30, 52, 60, 120]) {
			for (const peek of [false, true]) {
				const lines = view.render(width);
				for (const l of lines) expect(visibleWidth(l), `width ${width}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(width);
				for (const l of lines) expect(l).not.toMatch(/[\n\r\t]/);
				if (!peek) view.handleInput(" ");
			}
			view.handleInput("\u001b"); // close peek
		}
		view.dispose();
	});

	it("shows every group header with a hint when there are no jobs", async () => {
		const { view } = setup([]);
		await view.start();
		const text = view.render(120).join("\n");
		for (const h of ["Pinned", "Needs input", "Working", "Completed"]) expect(text).toContain(h);
		expect(text).toContain("0 needs input · 0 working · 0 completed");
		view.dispose();
	});
});

describe("AgentView keys", () => {
	it("rejects short tasks and dispatches once on a double Enter", async () => {
		const { view, client } = setup([row()]);
		await view.start();
		type(view, "abc");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Too short");
		view.handleInput("\u0003"); // Ctrl+C clears
		client.dispatchDelay = 50;
		type(view, "fix the flaky reset test");
		view.handleInput("\r");
		view.handleInput("\r");
		await sleep(100);
		expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(1);
		view.dispose();
	});

	it("a reply goes to the peeked row, and is refused once that row is gone", async () => {
		const a = row({ state: "blocked", status: "waiting", waitingFor: "question", question: "A?", choices: ["yes", "no"] });
		const b = row();
		const { view, client } = setup([a, b]);
		await view.start();
		view.handleInput(" "); // peek the first row (needs input group)
		view.handleInput("2"); // fills choice 2
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.find((r) => r.op === "reply")?.args).toEqual({ id: a.id, text: "no" });

		type(view, "late answer");
		client.emit({ event: "removed", id: a.id });
		view.render(80);
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(1);
		view.dispose();
	});

	it("Esc closes peek, then clears input, then exits; Ctrl+C twice exits", async () => {
		const { view, done } = setup([row()]);
		await view.start();
		view.handleInput(" ");
		view.handleInput("\u001b");
		type(view, "draft");
		view.handleInput("\u001b");
		expect(done()).toBe(0);
		view.handleInput("\u001b");
		expect(done()).toBe(1);
		view.handleInput("\u0003");
		view.handleInput("\u0003");
		expect(done()).toBe(2);
		view.dispose();
	});

	it("dispose before the daemon answers leaks no connection", async () => {
		const client = new FakeClient([]);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const view = new AgentView({
			tui: { terminal: { rows: 30 }, requestRender: () => {}, stop: () => {}, start: () => {} } as never,
			theme: theme as never,
			cwd: "/w",
			launch: () => {
				throw new Error("unused");
			},
			setTitle: () => {},
			connect: async () => {
				await gate;
				return client as unknown as DaemonClient;
			},
			done: () => {},
		});
		const started = view.start();
		view.dispose();
		release();
		await started;
		expect(client.closed).toBe(true);
	});
});

describe("AgentView organise (M6a)", () => {
	it("filters with s: n: o:, selects the first match, and Enter attaches rather than dispatching", async () => {
		const rows = [
			row({ id: "a", name: "fix login", state: "done", summary: "fixed the cookie bug" }),
			row({ id: "b", name: "docs pass", state: "working" }),
			row({ id: "c", name: "fix build", state: "blocked", question: "which node version?" }),
		];
		const { view, client } = setup(rows);
		await view.start();
		type(view, "n:fix s:done");
		let out = view.render(80).join("\n");
		expect(out).toContain("fix login");
		expect(out).not.toContain("fix build");
		expect(out).not.toContain("docs pass");
		expect(out).toContain("filtering");
		view.handleInput("\u0003");
		type(view, "o:node");
		out = view.render(80).join("\n");
		expect(out).toContain("fix build");
		expect(out).not.toContain("fix login");
		view.handleInput("\u0003");
		type(view, "n:zzz");
		expect(view.render(80).join("\n")).toContain("no sessions match");
		view.handleInput("\u0003");
		type(view, "o:node");
		view.handleInput("\r"); // attaches to the match (no host here), never dispatches
		await sleep(10);
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		view.dispose();
	});

	it("Ctrl+S groups by directory and reports the choice; Ctrl+T pins; Ctrl+R renames; Shift+↓ reorders", async () => {
		const chosen: string[] = [];
		const rows = [row({ id: "a", name: "one", cwd: "/w/app" }), row({ id: "b", name: "two", cwd: "/w/lib" })];
		const { view, client } = setup(rows, { onGroupBy: (g) => chosen.push(g) });
		await view.start();
		view.handleInput("\x13"); // Ctrl+S
		expect(chosen).toEqual(["directory"]);
		const out = view.render(80).join("\n");
		expect(out).toContain("/w/app");
		expect(out).toContain("/w/lib");
		view.handleInput("\x14"); // Ctrl+T on the selected row
		await sleep(10);
		expect(client.requests.find((r) => r.op === "pin")?.args).toMatchObject({ pinned: true });
		view.handleInput("\x12"); // Ctrl+R
		for (let i = 0; i < 10; i++) view.handleInput("\x7f");
		type(view, "renamed");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.find((r) => r.op === "rename")?.args).toMatchObject({ name: "renamed" });
		view.handleInput("\x13"); // back to state groups: both in Working
		view.handleInput("\x1b[1;2B"); // Shift+↓
		await sleep(10);
		expect((client.requests.find((r) => r.op === "reorder")?.args as { ids: string[] }).ids).toHaveLength(2);
		view.dispose();
	});
});

describe("AgentView dispatch (M6b)", () => {
	it("/model and /thinking set defaults for new sessions; pickers when bare", async () => {
		launches.length = 0;
		const { view, client } = setup([row()]);
		await view.start();
		type(view, "/model b/two");
		view.handleInput("\r");
		type(view, "/thinking");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Thinking for new sessions");
		view.handleInput("\x1b[B"); // down: off
		view.handleInput("\x1b[B"); // minimal
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("new sessions: model b/two · thinking minimal");
		type(view, "write the changelog");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)).toMatchObject({ task: "write the changelog", opts: { model: "b/two", thinking: "minimal" } });
		type(view, "/model default");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).not.toContain("model b/two");
		expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(1);
		view.dispose();
	});

	it("/worktree toggles a worktree for new sessions; the request carries it, not the undo", async () => {
		launches.length = 0;
		const { view, client } = setup([row({ worktree: { path: "/w/.pi/worktrees/x-0001", branch: "roost/x-0001" } })]);
		await view.start();
		type(view, "/worktree");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("new sessions: own worktree");
		const discarded: string[] = [];
		const o = (view as unknown as { o: { launch: (t: string, x: unknown) => unknown } }).o;
		const plain = o.launch;
		o.launch = (t, x) => ({
			...(plain(t, x) as object),
			worktree: { path: "/w/.pi/worktrees/y-0002", branch: "roost/y-0002", repo: "/w", base: "0".repeat(40) },
			discard: () => discarded.push(t),
			note: "uncommitted changes in /w are not in its worktree",
		});
		type(view, "write the changelog");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)).toMatchObject({ opts: { worktree: true } });
		const sent = client.requests.find((r) => r.op === "dispatch")!.args as Record<string, unknown>;
		expect(sent.worktree).toMatchObject({ branch: "roost/y-0002" });
		expect(sent).not.toHaveProperty("discard");
		expect(sent).not.toHaveProperty("note");
		expect(discarded).toEqual([]);
		expect(view.render(80).join("\n")).toContain("⎇ roost/y-0002");
		type(view, "/worktree off");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).not.toContain("own worktree");
		view.dispose();
	});

	it("prompt templates dispatch; other commands are refused and keep the text; ! starts a shell job", async () => {
		launches.length = 0;
		const { view, client } = setup([row()]);
		await view.start();
		type(view, "/settings");
		view.handleInput("\r");
		const out = view.render(80).join("\n");
		expect(out).toContain("/settings isn't available in agent view");
		expect(out).toContain("/settings");
		view.handleInput("\u0003");
		type(view, "/review the parser");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)?.task).toBe("/review the parser");
		type(view, "! npm test");
		view.handleInput("\r");
		await sleep(10);
		const shell = client.requests.filter((r) => r.op === "dispatch").at(-1)?.args as { kind?: string; command: string[] };
		expect(shell.kind).toBe("shell");
		expect(shell.command).toEqual(["sh", "-lc", "npm test"]);
		view.dispose();
	});
});

describe("AgentView model and context (M8)", () => {
	it("rows show the model and context share while there is room; the peek shows all of it", async () => {
		const a = row({ name: "fix login", model: "anthropic/claude-opus-5-5", thinking: "high", context: { tokens: 86_000, window: 200_000, percent: 43 } });
		const { view } = setup([a]);
		await view.start();
		const wide = view.render(100).find((l) => l.includes("fix login"))!;
		expect(wide).toContain("claude-opus-5-5 · 43%");
		expect(visibleWidth(wide)).toBeLessThanOrEqual(100);
		// narrow: the share alone, then nothing; the summary keeps its room
		const mid = view.render(64).find((l) => l.includes("fix login"))!;
		expect(mid).toContain("43%");
		expect(mid).not.toContain("claude-opus");
		const narrow = view.render(44).find((l) => l.includes("fix login"))!;
		expect(narrow).not.toContain("43%");
		view.handleInput(" "); // peek
		expect(view.render(100).join("\n")).toContain("anthropic/claude-opus-5-5 · thinking high · ctx 86k / 200k (43%)");
		view.dispose();
	});

	it("/model and /thinking in a peek switch that session (picker when bare) and never touch new-session defaults", async () => {
		const a = row({ name: "fix login", model: "a/one", thinking: "medium" });
		const { view, client } = setup([a]);
		await view.start();
		view.handleInput(" ");
		type(view, "/model");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("Model for fix login");
		view.handleInput("\x1b[B"); // a/one → b/two
		view.handleInput("\r");
		await sleep(10);
		type(view, "/thinking low");
		view.handleInput("\r");
		await sleep(10);
		type(view, "/model nope/x");
		view.handleInput("\r");
		await sleep(10);
		const replies = client.requests.filter((r) => r.op === "reply").map((r) => r.args);
		expect(replies).toEqual([
			{ id: a.id, text: "/model b/two" },
			{ id: a.id, text: "/thinking low" },
		]);
		const screen = view.render(80).join("\n");
		expect(screen).toContain("unknown model nope/x");
		expect(screen).not.toContain("new sessions:");
		view.handleInput("\x03"); // a refused command stays in the input to be fixed: clear it
		type(view, "/model default");
		view.handleInput("\r");
		expect(view.render(80).join("\n")).toContain("a running session has no default model");
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(2);
		view.dispose();
	});

	it("a switch is reported as asked, then confirmed by the session's report or flagged when it does not show", async () => {
		const a = row({ name: "fix login", model: "a/one", thinking: "high" });
		const { view, client } = setup([a], { switchCheckMs: 60 });
		await view.start();
		view.handleInput(" ");
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("asked fix login to use model b/two");
		client.emit({ event: "job", job: { ...a, model: "b/two" } });
		expect(view.render(80).join("\n")).toContain("fix login now uses model b/two (from its next request)");
		// pi lowers a level the model does not support
		type(view, "/thinking max");
		view.handleInput("\r");
		await sleep(10);
		client.emit({ event: "job", job: { ...a, model: "b/two", thinking: "xhigh" } });
		expect(view.render(80).join("\n")).toContain("fix login thinks xhigh: the closest its model supports to max");
		// no credentials in the worker: the row never changes; a /thinking meanwhile does not hide that
		type(view, "/model a/one");
		view.handleInput("\r");
		await sleep(10);
		type(view, "/thinking low");
		view.handleInput("\r");
		await sleep(10);
		client.emit({ event: "job", job: { ...a, model: "b/two", thinking: "low" } });
		expect(view.render(80).join("\n")).toContain("fix login now uses thinking low");
		await sleep(100);
		// short enough for 80 columns
		expect(view.render(80).join("\n")).toContain("model switch failed (credentials? envAllowList): still two, not one");
		view.dispose();
	});

	it("a second switch before the first shows: the first one's report is not the outcome", async () => {
		const a = row({ name: "fix login", model: "a/one" });
		const { view, client } = setup([a], { switchCheckMs: 5000 });
		await view.start();
		view.handleInput(" ");
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		type(view, "/model a/one"); // back again, while b/two is still pending: not "already uses"
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(2);
		client.emit({ event: "job", job: { ...a, model: "b/two" } });
		expect(view.render(80).join("\n")).not.toContain("now uses");
		client.emit({ event: "job", job: { ...a, model: "a/one" } });
		expect(view.render(80).join("\n")).toContain("fix login now uses model a/one");
		view.dispose();
	});

	it("three switches in a row: only the last one's value is the outcome; the same switch twice confirms at once", async () => {
		const a = row({ name: "fix login", model: "p/a" });
		const { view, client } = setup([a], { switchCheckMs: 5000 });
		const models = ["p/a", "p/b", "p/c"];
		(view as any).o.models = () => models;
		await view.start();
		view.handleInput(" ");
		for (const m of ["p/b", "p/a", "p/c"]) {
			type(view, `/model ${m}`);
			view.handleInput("\r");
			await sleep(10);
		}
		for (const m of ["p/b", "p/a"]) {
			client.emit({ event: "job", job: { ...a, model: m } });
			expect(view.render(100).join("\n")).not.toContain("now uses");
		}
		client.emit({ event: "job", job: { ...a, model: "p/c" } });
		expect(view.render(100).join("\n")).toContain("fix login now uses model p/c");
		// the same switch twice: its report confirms it, no timer needed
		for (let i = 0; i < 2; i++) {
			type(view, "/model p/b");
			view.handleInput("\r");
			await sleep(10);
		}
		client.emit({ event: "job", job: { ...a, model: "p/b" } });
		expect(view.render(100).join("\n")).toContain("fix login now uses model p/b");
		view.dispose();
	});

	it("the peek footer fits 80 columns; a session that is starting, or gone, gets its own message", async () => {
		const a = row({ name: "fix login", model: "a/one" });
		const { view, client } = setup([a]);
		await view.start();
		view.handleInput(" ");
		expect(view.render(80).at(-1)).toContain("Esc close · ? keys");
		client.replyResult = { delivered: false, saved: false };
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("fix login is starting; try again in a moment");
		// the row goes while the picker is open
		client.replyResult = { delivered: true, saved: false };
		view.handleInput("\x03");
		type(view, "/model");
		view.handleInput("\r");
		client.emit({ event: "removed", id: a.id });
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("that session no longer exists");
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(1);
		view.dispose();
	});

	it("a shell row has no model to switch", async () => {
		const s = row({ name: "tests", kind: "shell", model: null });
		const { view, client } = setup([s]);
		await view.start();
		view.handleInput(" ");
		type(view, "/model a/one");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(80).join("\n")).toContain("a shell job has no model");
		expect(client.requests.some((r) => r.op === "reply")).toBe(false);
		view.dispose();
	});

	it("the column lines up across rows, whatever the model name or age", async () => {
		const now = Date.now();
		// working rows age from startedAt: "10m" and "5s" differ in width
		const a = row({ name: "one", model: "anthropic/claude-haiku-5-5", context: { tokens: 1, window: 100, percent: 91 }, startedAt: now - 600_000 });
		const b = row({ name: "two", model: "x/模型很长的名字也要对齐", context: { tokens: 1, window: 100, percent: 4 }, startedAt: now - 5_000 });
		const c = row({ name: "three", kind: "shell", model: null, startedAt: now - 5_000 });
		const { view } = setup([a, b, c]);
		await view.start();
		const lines = view.render(100);
		const ages = lines.filter((l) => /one|two/.test(l)).map((l) => l.trimEnd().split(" ").at(-1));
		expect(new Set(ages.map((x) => x?.length)).size).toBe(2); // the ages really differ in width
		// CJK is two columns wide: compare columns, not string indices
		const col = (name: string, s: string) => {
			const l = lines.find((x) => x.includes(name))!;
			return visibleWidth(l.slice(0, l.indexOf(s)));
		};
		expect(col("one", "91%")).toBe(col("two", " 4%"));
		expect(lines.find((l) => l.includes("three"))).not.toContain("%");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(100);
		view.dispose();
	});

	it("rowDetails: false hides the column", async () => {
		const a = row({ name: "fix login", model: "anthropic/claude-opus-5-5", context: { tokens: 1, window: 2, percent: 50 } });
		const client = new FakeClient([a]);
		const view = new AgentView({
			tui: { terminal: { rows: 30, columns: 100 }, requestRender: () => {}, stop: () => {}, start: () => {} } as never,
			theme: theme as never,
			cwd: "/w",
			launch: () => ({ cwd: "/w", sessionFile: "/s", command: [], env: {}, name: "x", origin: "dispatch" }),
			setTitle: () => {},
			connect: async () => client as unknown as DaemonClient,
			done: () => {},
			reducedMotion: true,
			rowDetails: false,
		});
		await view.start();
		expect(view.render(100).join("\n")).not.toContain("50%");
		view.dispose();
	});
});

describe("M17: the task input is pi's editor", () => {
	it("Shift+Enter adds a line, ↑↓ move in the text, a long paste folds and dispatches in full", async () => {
		launches.length = 0;
		const a = row({ name: "first job" });
		const b = row({ name: "second job" });
		const { view } = setup([a, b]);
		await view.start();
		type(view, "line one");
		view.handleInput("\x1b[13;2u"); // Shift+Enter (kitty)
		type(view, "line two");
		let text = view.render(80).join("\n");
		expect(text).toContain("line one");
		expect(text).toContain("line two");
		// ↑ on the second line stays in the text; the selection does not move
		const sel = () => view.render(80).find((l) => l.startsWith("›") && l.includes(" job"));
		const before = sel();
		view.handleInput("\x1b[A");
		expect(sel()).toBe(before);
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("line one\nline two");
		// a long paste: a marker on screen, the whole text dispatched
		const long = Array.from({ length: 30 }, (_, i) => `pasted ${i}`).join("\n");
		view.handleInput(`\x1b[200~${long}\x1b[201~`);
		text = view.render(80).join("\n");
		expect(text).not.toContain("pasted 29");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe(long);
		view.dispose();
	});
});

describe("Ctrl+G", () => {
	it("writes the task in $EDITOR and dispatches all of its lines", async () => {
		launches.length = 0;
		const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
		process.env.VISUAL = `sh -c 'printf "first line\\nsecond line\\n" > "$0"'`;
		const { view } = setup([row()]);
		await view.start();
		view.handleInput("\x07"); // Ctrl+G
		await sleep(300);
		// M17: the editor shows every line
		const shown = view.render(80).join("\n");
		expect(shown).toContain("first line");
		expect(shown).toContain("second line");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("first line\nsecond line");
		view.dispose();
		if (saved.v === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = saved.v;
	});
});
