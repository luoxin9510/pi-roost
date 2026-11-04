import type { AgentDef } from "../lib/agents.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AgentView, type AgentViewOptions } from "../extensions/agent-view.ts";
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
		return () => {
			this.events = this.events.filter((x) => x !== l);
		};
	}
	/** M22: events emitted so far (a fake place in the stream). */
	emitted = 0;
	position() {
		return this.emitted;
	}
	async requestAt(op: string, args: unknown): Promise<{ result: unknown; at: number }> {
		const result = await this.request(op, args);
		return { result, at: this.emitted };
	}
	onClose(l: () => void) {
		this.closes.push(l);
		return () => {};
	}
	close() {
		this.closed = true;
	}
	emit(e: Event) {
		this.emitted++;
		for (const l of [...this.events]) l(e);
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
function setup(
	rows: JobRow[],
	opts: { rowsHigh?: number; onGroupBy?: (g: string) => void; switchCheckMs?: number; agents?: Map<string, AgentDef>; defaultAgent?: string; extra?: Partial<AgentViewOptions> } = {},
) {
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
		...(opts.agents ? { agents: () => opts.agents! } : {}),
		...(opts.defaultAgent ? { defaultAgent: opts.defaultAgent } : {}),
		...opts.extra,
	});
	return { view, client, renders: () => renders, done: () => doneCalls };
}

const type = (view: AgentView, text: string) => {
	for (const ch of text) view.handleInput(ch);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AgentView render", () => {
	it("M18: a first word or @name naming an agent runs the task as it; a: filters; peek says it", async () => {
		const reviewer: AgentDef = { name: "reviewer", systemPromptMode: "replace", prompt: "You review.", file: "/a/reviewer.md" };
		const agents = new Map([["reviewer", reviewer]]);
		const tagged = row({ name: "check pr", agent: "reviewer" });
		const plainRow = row({ name: "other work" });
		const { view } = setup([tagged, plainRow], { agents });
		await view.start();
		launches.length = 0;
		for (const t of ["reviewer look at the diff", "@reviewer and the tests", "reviewers are people too"]) {
			type(view, t);
			view.handleInput("\r");
			await sleep(20);
		}
		expect(launches.map((l) => [l.task, (l.opts as { agent?: AgentDef }).agent?.name])).toEqual([
			["look at the diff", "reviewer"],
			["and the tests", "reviewer"],
			["reviewers are people too", undefined],
		]);
		type(view, "reviewer /model a/one");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("reviewer runs a task, not /model");
		for (let i = 0; i < 30; i++) view.handleInput("\x7f");
		type(view, "reviewer /review the diff");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)).toMatchObject({ task: "/review the diff" });
		expect((launches.at(-1)!.opts as { agent?: AgentDef }).agent?.name).toBe("reviewer");
		launches.length = 3;
		type(view, "a:reviewer");
		const text = view.render(120).join("\n");
		expect(text).toContain("check pr");
		expect(text).not.toContain("other work");
		for (let i = 0; i < 10; i++) view.handleInput("\x7f");
		view.handleInput(" ");
		expect(view.render(120).join("\n")).toContain("agent reviewer");
	});

	it("M18: dispatchAgent is the default; an unknown one is refused", async () => {
		const helper: AgentDef = { name: "helper", systemPromptMode: "append", prompt: "Be brief.", file: "/a/helper.md" };
		const { view } = setup([], { agents: new Map([["helper", helper]]), defaultAgent: "helper" });
		await view.start();
		launches.length = 0;
		type(view, "write the notes");
		view.handleInput("\r");
		await sleep(20);
		expect((launches[0]?.opts as { agent?: AgentDef }).agent?.name).toBe("helper");
		const bad = setup([], { agents: new Map(), defaultAgent: "ghost" });
		await bad.view.start();
		launches.length = 0;
		type(bad.view, "write the notes");
		bad.view.handleInput("\r");
		await sleep(20);
		expect(launches).toHaveLength(0);
		expect(bad.view.render(120).join("\n")).toContain("dispatchAgent ghost is not an agent here");
		// commands still work
		for (let i = 0; i < 20; i++) bad.view.handleInput("\x7f");
		type(bad.view, "!ls");
		bad.view.handleInput("\r");
		await sleep(20);
		expect(bad.view.render(120).join("\n")).not.toContain("dispatchAgent ghost");
	});

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
		// Ctrl+J as a bare LF adds a line; a paste in pieces is not taken as keys
		type(view, "one");
		view.handleInput("\n");
		type(view, "two");
		view.handleInput("\x1b[200~");
		view.handleInput("\r");
		view.handleInput(" ?x");
		view.handleInput("\x1b[201~");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("one\ntwo\n ?x");
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

describe("M23: /resume and models in the hub", () => {
	it("the model picker searches, shows the enabled models with Tab for all, and says what new sessions run", async () => {
		launches.length = 0;
		const { view } = setup([row()], {
			extra: { models: () => ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5", "openai/gpt-5"], scopedModels: () => ["anthropic/claude-opus-5-5", "openai/gpt-5"], defaultModel: () => "anthropic/claude-opus-5-5" },
		});
		await view.start();
		expect(view.render(100).join("\n")).toContain("new sessions: model anthropic/claude-opus-5-5 (default)");
		view.handleInput("\x0c"); // Ctrl+L
		let screen = view.render(100).join("\n");
		expect(screen).toContain("Model for new sessions · enabled models");
		expect(screen).not.toContain("claude-haiku");
		view.handleInput("\t"); // all models
		expect(view.render(100).join("\n")).toContain("· all models");
		type(view, "hai");
		screen = view.render(100).join("\n");
		expect(screen).toContain("search: hai");
		expect(screen).toContain("anthropic/claude-haiku-5-5");
		expect(screen).not.toContain("openai/gpt-5");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("new sessions: model anthropic/claude-haiku-5-5");
		type(view, "summarise the log");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.at(-1)).toMatchObject({ opts: { model: "anthropic/claude-haiku-5-5" } });
		view.dispose();
	});

	it("Ctrl+P and Shift+Ctrl+P cycle the enabled models; Shift+Tab the thinking level", async () => {
		const { view } = setup([row()], { extra: { scopedModels: () => ["a/one", "b/two"] } });
		await view.start();
		view.handleInput("\x10"); // Ctrl+P
		expect(view.render(100).join("\n")).toContain("new sessions: model a/one");
		view.handleInput("\x10");
		expect(view.render(100).join("\n")).toContain("new sessions: model b/two");
		view.handleInput("\x10");
		expect(view.render(100).join("\n")).toContain("new sessions: model a/one");
		view.handleInput("\x1b[112;6u"); // Shift+Ctrl+P (kitty)
		expect(view.render(100).join("\n")).toContain("new sessions: model b/two");
		view.handleInput("\x1b[Z"); // Shift+Tab
		expect(view.render(100).join("\n")).toContain("thinking off");
		view.dispose();
	});

	it("/resume shows pi's session list; picking one with no row starts it in the background and enters it", async () => {
		launches.length = 0;
		let keys = "";
		let picked: ((s: { path: string; name: string; cwd: string; modified: number }) => void) | undefined;
		const { view, client } = setup([row()], {
			extra: {
				sessionSelector: (o) => {
					picked = o.onSelect;
					return { render: () => ["PI SESSION LIST", "keys: enter select"], handleInput: (d) => (keys += d) };
				},
			},
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("PI SESSION LIST");
		type(view, "abc");
		expect(keys).toBe("abc"); // its keys go to it
		picked!({ path: "/s/old.jsonl", name: "old work", cwd: "/w/app", modified: Date.now() });
		await sleep(20);
		expect(view.render(100).join("\n")).not.toContain("PI SESSION LIST");
		expect(launches.at(-1)).toMatchObject({ task: "", opts: { sessionFile: "/s/old.jsonl", cwd: "/w/app", origin: "adopt" } });
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(true);
		expect(view.render(100).join("\n")).toContain("resuming");
		view.dispose();
	});

	it("/resume falls back to the view's own list when pi's cannot be built; an Esc closes pi's", async () => {
		const { view } = setup([row()], {
			extra: {
				sessionSelector: () => {
					throw new Error("no such export");
				},
				resumable: async () => [{ path: "/s/a.jsonl", name: "alpha", cwd: "/w", modified: Date.now() }],
			},
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		await sleep(20);
		const screen = view.render(100).join("\n");
		// the view's own list (its warning gives way to the list's own notices)
		expect(screen).toContain("Resume a session in the background");
		expect(screen).toContain("alpha");
		view.dispose();
		let cancel: (() => void) | undefined;
		const two = setup([row()], { extra: { sessionSelector: (o) => ((cancel = o.onCancel), { render: () => ["PI SESSION LIST"] }) } });
		await two.view.start();
		type(two.view, "/resume");
		two.view.handleInput("\r");
		cancel!();
		expect(two.view.render(100).join("\n")).not.toContain("PI SESSION LIST");
		two.view.dispose();
	});

	it("/resume on a session that has a row enters that row (no second job)", async () => {
		const listed = row({ name: "listed one", sessionFile: "/s/listed.jsonl", pid: null, endedAt: Date.now() - 1000, state: "done" });
		let picked: ((s: { path: string; name: string; cwd: string; modified: number }) => void) | undefined;
		const { view, client } = setup([listed], { extra: { sessionSelector: (o) => ((picked = o.onSelect), { render: () => ["LIST"] }) } });
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		picked!({ path: "/s/listed.jsonl", name: "listed one", cwd: "/w", modified: Date.now() });
		await sleep(30);
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		// started again for the attach (an ended row asks no "Enter again" when chosen here)
		expect(client.requests.some((r) => r.op === "respawn")).toBe(true);
		view.dispose();
	});
});

describe("M23 review", () => {
	it("Enter with nothing matching keeps the picker; a paste searches; Tab keeps the selected model", async () => {
		const { view } = setup([row()], { extra: { models: () => ["a/one", "b/two", "c/three"], scopedModels: () => ["a/one", "b/two"] } });
		await view.start();
		view.handleInput("\x0c");
		view.handleInput("\x1b[B"); // a/one
		view.handleInput("\x1b[B"); // b/two
		view.handleInput("\t"); // all models: b/two still selected
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("new sessions: model b/two");
		view.handleInput("\x0c");
		type(view, "zzz");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("nothing matches");
		view.handleInput("\x1b"); // clears the search
		view.handleInput("\x1b[200~thr\nee\x1b[201~");
		expect(view.render(100).join("\n")).toContain("search: thr ee");
		view.dispose();
	});

	it("resuming this pi's own session is refused; a job whose push came first is entered", async () => {
		let picked: ((s: { path: string; name: string; cwd: string; modified: number }) => void) | undefined;
		const { view, client } = setup([row()], {
			extra: { currentSession: () => "/s/me.jsonl", sessionSelector: (o) => ((picked = o.onSelect), { render: () => ["LIST"] }) },
		});
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		picked!({ path: "/s/me.jsonl", name: "me", cwd: "/w", modified: Date.now() });
		await sleep(10);
		expect(view.render(100).join("\n")).toContain("this pi's own session");
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		view.dispose();
	});

	it("closing the view disposes pi's list (its loads stop)", async () => {
		let disposed = 0;
		const { view } = setup([row()], { extra: { sessionSelector: () => ({ render: () => ["LIST"], dispose: () => disposed++ }) } });
		await view.start();
		type(view, "/resume");
		view.handleInput("\r");
		view.dispose();
		expect(disposed).toBe(1);
	});
});

describe("M24: usage in the hub", () => {
	const usage = (cost: number, today: number, sub = false) => ({
		input: 1000,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		cost,
		today,
		day: (() => {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		})(),
		sub,
		models: { "anthropic/claude-opus-5-5": { cost, tokens: 1500 } },
	});

	it("rows show what each session spent, the header today's and all; /usage lists by model and session", async () => {
		const a = row({ name: "big job", model: "anthropic/claude-opus-5-5", usage: usage(12.5, 2) });
		const b = row({ name: "small job", model: "anthropic/claude-opus-5-5", usage: usage(0.3, 0.3, true) });
		const { view } = setup([a, b]);
		await view.start();
		const screen = view.render(140).join("\n");
		expect(screen).toContain("$12.50");
		expect(screen).toContain("$0.30");
		expect(screen).toContain("$2.30 today · $12.80 all");
		type(view, "/usage");
		view.handleInput("\r");
		const panel = view.render(140).join("\n");
		expect(panel).toContain("Usage · sessions in this view");
		expect(panel).toContain("By model");
		expect(panel).toContain("claude-opus-5-5");
		expect(panel).toContain("2 sessions");
		expect(panel.indexOf("big job")).toBeLessThan(panel.indexOf("small job"));
		expect(panel).toContain("(sub)");
		expect(panel).toContain("on a subscription");
		view.handleInput("\x1b");
		expect(view.render(140).join("\n")).not.toContain("By model");
		view.dispose();
	});

	it("no cost column or totals before anything is spent; a narrow screen drops the column first", async () => {
		const { view } = setup([row({ name: "fresh" })]);
		await view.start();
		const screen = view.render(140).join("\n");
		expect(screen).not.toContain("today ·");
		expect(screen).not.toMatch(/\$\d/);
		view.dispose();
		const two = setup([row({ name: "spent", summary: "a long summary of what it is doing right now", model: "anthropic/claude-opus-5-5", usage: usage(3, 0) })]);
		await two.view.start();
		// the model column and the share go first, then the cost: the summary keeps its room
		const line = two.view.render(48).find((l) => l.includes("spent")) ?? "";
		expect(line).toContain("a long");
		expect(line).not.toContain("$3.00");
		expect(two.view.render(160).find((l) => l.includes("spent"))).toContain("$3.00");
		two.view.dispose();
	});
});

describe("AgentView batch (M25)", () => {
	const ctrlO = "\x0f";
	it("Ctrl+O marks rows and moves on; the typed text goes to each marked session", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" }), row({ id: "c", name: "three" }), row({ id: "s", name: "! make", kind: "shell" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO); // one, cursor to two
		view.handleInput(ctrlO); // two
		let out = view.render(100);
		expect(out.find((l) => l.includes("one"))).toMatch(/^ ✓/);
		expect(out.find((l) => l.includes("two"))).toMatch(/^ ✓/);
		expect(out.find((l) => l.includes("three"))).toMatch(/^› /);
		expect(out.join("\n")).toContain("2 marked");
		type(view, "rebase on main");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => r.args)).toEqual([
			{ id: "a", text: "rebase on main" },
			{ id: "b", text: "rebase on main" },
		]);
		expect(client.requests.some((r) => r.op === "dispatch")).toBe(false);
		out = view.render(100);
		expect(out.join("\n")).toContain("sent to 2 of 2 sessions");
		// the marks stay for the next batch; a mark again on a row unmarks it
		view.handleInput("\x1b[A"); // up to two
		view.handleInput(ctrlO);
		expect(view.render(100).find((l) => l.includes("two"))).not.toMatch(/^.✓/);
		// a shell job is skipped
		view.handleInput("\x1b[B"); // s? cursor moved on to three; go to the shell row
		view.handleInput(ctrlO);
		type(view, "status?");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => (r.args as { id: string }).id).slice(2)).toEqual(["a"]);
		expect(view.render(100).join("\n")).toContain("1 shell jobs skipped");
		view.dispose();
	});

	it("/model and /thinking switch every marked session; bare /model picks once for all", async () => {
		const rows = [row({ id: "a", name: "one", model: "a/one" }), row({ id: "b", name: "two", model: "a/one" })];
		const { view, client } = setup(rows, { switchCheckMs: 10_000 });
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO);
		type(view, "/model b/two");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => r.args)).toEqual([
			{ id: "a", text: "/model b/two" },
			{ id: "b", text: "/model b/two" },
		]);
		expect(view.render(100).join("\n")).toContain("asked 2 of 2 sessions to use model b/two");
		type(view, "/thinking nope");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("thinking is one of");
		view.handleInput("\u0003");
		type(view, "/model");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("Model for 2 marked sessions");
		view.handleInput("\x1b");
		view.handleInput("\u0003");
		type(view, "/worktree on");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("only /model, /thinking and /compare act on marked sessions");
		view.dispose();
	});

	it("Ctrl+O on a header marks the group; Ctrl+T pins all; Ctrl+X stops then deletes all; Esc unmarks first", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" }), row({ id: "c", name: "three" })];
		const { view, client, done } = setup(rows);
		await view.start();
		view.handleInput("\x1b[1;3A"); // Alt+↑: the group header
		view.handleInput(ctrlO);
		expect(view.render(100).join("\n")).toContain("3 marked");
		view.handleInput("\x14"); // Ctrl+T: pin all (unpin only when all are pinned)
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "pin").map((r) => r.args)).toEqual([
			{ id: "a", pinned: true },
			{ id: "b", pinned: true },
			{ id: "c", pinned: true },
		]);
		view.handleInput("\x18"); // Ctrl+X: stop the running ones
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "stop")).toHaveLength(3);
		view.handleInput("\x18"); // again: delete
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "rm").map((r) => (r.args as { id: string }).id)).toEqual(["a", "b", "c"]);
		expect(view.render(100).join("\n")).not.toContain("marked");
		// Esc: marks before leaving
		view.handleInput("\x1b[B");
		view.handleInput(ctrlO);
		view.handleInput("\x1b");
		expect(done()).toBe(0);
		expect(view.render(100).join("\n")).toContain("marks cleared");
		view.handleInput("\x1b");
		expect(done()).toBe(1);
		view.dispose();
	});

	it("M25 review: a peek acts on its row; folded marks are not acted on; ! and @ stay; a failed send gives the text back", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" }), row({ id: "c", name: "three" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO); // a, b marked; cursor on c
		view.handleInput(" "); // peek c
		view.handleInput("\x18"); // Ctrl+X: stops c, not the marks
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "stop").map((r) => r.args)).toEqual([{ id: "c" }]);
		view.handleInput("\x14");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "pin").map((r) => r.args)).toEqual([{ id: "c", pinned: true }]);
		view.handleInput("\x1b"); // close the peek
		type(view, "! npm test");
		view.handleInput("\r");
		await sleep(10);
		expect(client.requests.some((r) => r.op === "reply" || r.op === "dispatch")).toBe(false);
		expect(view.render(100).join("\n")).toContain("! npm test");
		view.handleInput("\u0003");
		client.replyResult = { delivered: false, saved: false };
		type(view, "are you done?");
		view.handleInput("\r");
		view.handleInput("\r"); // a second Enter while sending sends nothing more
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(2);
		const out = view.render(100).join("\n");
		expect(out).toContain("not delivered: one, two");
		expect(out).toContain("are you done?");
		view.handleInput("\u0003");
		// fold the group: its marks are kept but not acted on
		view.handleInput("\x1b[1;3A"); // Alt+↑: the header
		view.handleInput("\r"); // fold
		expect(view.render(100).join("\n")).not.toContain("marked");
		view.handleInput("\x18");
		await sleep(10);
		// on the folded header Ctrl+X is the group's (shown as a group), not the hidden marks
		expect(client.requests.filter((r) => r.op === "stop").map((r) => (r.args as { id: string }).id)).toEqual(["c", "a", "b", "c"]);
		view.dispose();
	});

	it("a removed row drops out of the marks", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(ctrlO);
		view.handleInput(ctrlO);
		client.emit({ event: "removed", id: "a" });
		expect(view.render(100).join("\n")).toContain("1 marked");
		// all marked are pinned: Ctrl+T unpins them
		client.emit({ event: "job", job: { ...rows[1]!, pinned: true } });
		view.handleInput("\x14");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "pin").map((r) => r.args)).toEqual([{ id: "b", pinned: false }]);
		view.dispose();
	});
});

describe("AgentView fan-out (M26)", () => {
	it("/fanout checks its models; the next task starts one session per model, once", async () => {
		const { view, client } = setup([]);
		await view.start();
		type(view, "/fanout a/one");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("/fanout takes 2 to 6 models");
		view.handleInput("\u0003");
		type(view, "/fanout a/one c/nope");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("unknown model c/nope");
		view.handleInput("\u0003");
		type(view, "/fanout a/one, b/two");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("next task: 2 sessions, one per model (one, two)");
		const before = launches.length;
		type(view, "fix the flaky test");
		view.handleInput("\r");
		await sleep(20);
		const opts = launches.slice(before).map((l) => l.opts as { model: string; worktree: boolean; fanout: string; name: string });
		expect(opts.map((o) => [o.model, o.worktree, o.name])).toEqual([
			["a/one", true, "fix the flaky test · one"],
			["b/two", true, "fix the flaky test · two"],
		]);
		expect(opts[0]!.fanout).toMatch(/^f[a-z0-9]+$/);
		expect(opts[1]!.fanout).toBe(opts[0]!.fanout);
		const sent = client.requests.filter((r) => r.op === "dispatch").map((r) => (r.args as { fanout?: string }).fanout);
		expect(sent).toEqual([opts[0]!.fanout, opts[0]!.fanout]);
		const out = view.render(100).join("\n");
		expect(out).toContain("started 2 sessions, one per model");
		expect(out).not.toContain("next task:");
		// once: the next task is one session again
		type(view, "write the changelog");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(3);
		view.dispose();
	});

	it("bare /fanout: Enter adds or removes a model, Esc keeps the choice; /fanout off cancels", async () => {
		const { view } = setup([]);
		await view.start();
		type(view, "/fanout");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("Fan out the next task (0 chosen)");
		view.handleInput("\r"); // a/one
		view.handleInput("\x1b[B");
		view.handleInput("\r"); // b/two
		let out = view.render(100).join("\n");
		expect(out).toContain("(2 chosen)");
		expect(out).toContain("✓ a/one");
		view.handleInput("\x1b[A");
		view.handleInput("\r"); // a/one again: removed
		expect(view.render(100).join("\n")).toContain("(1 chosen)");
		view.handleInput("\x1b");
		out = view.render(100).join("\n");
		expect(out).toContain("fan-out: two, add one more model");
		type(view, "/fanout off");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).not.toContain("fan-out:");
		view.dispose();
	});

	it("/compare shows a fan-out side by side with its changes; k twice keeps one and deletes the others", async () => {
		const wt = (b: string) => ({ path: `/wt/${b}`, branch: b, base: "abc" });
		const rows = [
			row({ id: "a", name: "fix it · one", model: "a/one", fanout: "f1", state: "done", summary: "Fixed by retrying.", worktree: wt("a"), usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.42, today: 0.42, day: 0, sub: false, models: {} } }),
			row({ id: "b", name: "fix it · two", model: "b/two", fanout: "f1", state: "done", summary: "Rewrote the test.", worktree: wt("b") }),
			row({ id: "c", name: "unrelated", model: "a/one", state: "done" }),
		];
		const asked: string[] = [];
		const { view, client } = setup(rows, {
			extra: {
				worktreeChange: async (path) => {
					asked.push(path);
					return path.endsWith("a") ? { files: 1, insertions: 3, deletions: 1, untracked: 0 } : { files: 0, insertions: 0, deletions: 0, untracked: 2 };
				},
			},
		});
		await view.start();
		type(view, "/compare");
		view.handleInput("\r");
		await sleep(10);
		const out = view.render(120).join("\n");
		expect(out).toContain("Compare · fix it · 2 sessions");
		expect(out).toContain("1 file +3 −1");
		expect(out).toContain("2 new");
		expect(out).toContain("$0.42");
		expect(out).toContain("Fixed by retrying.");
		expect(out).toContain("Rewrote the test.");
		expect(out).not.toContain("unrelated");
		expect(asked.sort()).toEqual(["/wt/a", "/wt/b"]);
		// a narrow terminal: the chosen one in full, the other on one line
		expect(view.render(40).join("\n")).toContain("two · done");
		view.handleInput("\x1b[C"); // → two
		view.handleInput("k");
		expect(view.render(120).join("\n")).toContain("k again");
		view.handleInput("k");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "stop" || r.op === "rm").map((r) => [r.op, (r.args as { id: string }).id])).toEqual([
			["stop", "a"],
			["rm", "a"],
		]);
		expect(view.render(120).join("\n")).toContain("kept fix it · two · deleted 1");
		view.dispose();
	});

	it("M26 review: k in kitty encoding; pinned ones stay; marked rows cannot be kept; no escapes from replies", async () => {
		const rows = [
			row({ id: "a", name: "t · one", model: "a/one", fanout: "f1", state: "done", summary: "ok\x1b]0;pwned\x07\tdone\x1b[2J" }),
			row({ id: "b", name: "t · two", model: "b/two", fanout: "f1", state: "done", pinned: true }),
			row({ id: "c", name: "t · three", model: "c/three", fanout: "f1", state: "done", pid: null }),
		];
		const { view, client } = setup(rows, { extra: { worktreeChange: async () => undefined } });
		await view.start();
		view.handleInput("\x1b[1;3B"); // the next group (Completed), then its first row
		view.handleInput("\x1b[B");
		type(view, "/compare");
		view.handleInput("\r");
		const out = view.render(120).join("\n");
		expect(out).toContain("Compare · t · 3 sessions");
		expect(out).not.toMatch(/\x1b\]|\x07|\x1b\[2J|\t/);
		expect(out).toContain("ok  done");
		// columns by name: one, three, two; keep "three": "two" is pinned and stays, "one" goes
		view.handleInput("\x1b[C");
		view.handleInput("\x1b[107u");
		view.handleInput("\x1b[107;1:3u"); // its release changes nothing
		view.handleInput("\x1b[107u");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "rm").map((r) => (r.args as { id: string }).id)).toEqual(["a"]);
		expect(view.render(120).join("\n")).toContain("1 pinned kept");
		view.dispose();

		// marked rows (not one fan-out): k deletes nothing
		const other = [row({ id: "x", name: "x", state: "done" }), row({ id: "y", name: "y", state: "done" })];
		const s2 = setup(other);
		await s2.view.start();
		s2.view.handleInput("\x0f");
		s2.view.handleInput("\x0f");
		type(s2.view, "/compare");
		s2.view.handleInput("\r");
		expect(s2.view.render(120).join("\n")).not.toContain("k keep");
		s2.view.handleInput("k");
		s2.view.handleInput("k");
		await sleep(10);
		expect(s2.client.requests.some((r) => r.op === "rm" || r.op === "stop")).toBe(false);
		s2.view.dispose();
	});

	it("/compare needs a fan-out or marked rows", async () => {
		const { view } = setup([row({ id: "a" }), row({ id: "b" })]);
		await view.start();
		type(view, "/compare");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("/compare works on a row of a fan-out");
		view.handleInput("\x0f");
		view.handleInput("\x0f");
		type(view, "/compare");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("Compare · job");
		view.dispose();
	});
});

describe("AgentView presets (M27)", () => {
	const reviewer: AgentDef = { name: "reviewer", systemPromptMode: "replace", prompt: "You review.", file: "/a/reviewer.md" };
	function withPresets(initial: Record<string, import("../lib/config.ts").Preset>) {
		const store = { ...initial };
		const user = new Set(Object.keys(initial));
		const s = setup([], {
			agents: new Map([["reviewer", reviewer]]),
			extra: {
				presets: () => store,
				savePreset: (name, p) => {
					if (p) {
						store[name] = p;
						user.add(name);
					} else {
						delete store[name];
						user.delete(name);
					}
				},
				userPreset: (name) => user.has(name),
			},
		});
		return { ...s, store, user };
	}

	it("/preset name applies it: model, thinking, agent and directory reach the next task; a typed @dir wins", async () => {
		const { view } = withPresets({ review: { model: "b/two", thinking: "high", agent: "reviewer", dir: "api" } });
		await view.start();
		type(view, "/preset nope");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("no preset nope");
		view.handleInput("\u0003");
		type(view, "/preset review");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain("new sessions: preset review · model b/two · thinking high · as reviewer · in @api");
		const before = launches.length;
		type(view, "check the latest diff");
		view.handleInput("\r");
		await sleep(10);
		const o = launches[before]!.opts as { cwd: string; model: string; thinking: string; agent?: AgentDef };
		expect(o).toMatchObject({ cwd: "/w/api", model: "b/two", thinking: "high" });
		expect(o.agent?.name).toBe("reviewer");
		type(view, "@/tmp check the other diff");
		view.handleInput("\r");
		await sleep(10);
		expect((launches[before + 1]!.opts as { cwd: string }).cwd).toMatch(/tmp$/);
		// off: back to the defaults
		type(view, "/preset off");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).not.toContain("preset review");
		view.dispose();
	});

	it("/preset save keeps the current choices; bare /preset picks; rm removes only the user's", async () => {
		const { view, store, user } = withPresets({});
		await view.start();
		type(view, "/preset");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("no presets yet");
		view.handleInput("\u0003");
		type(view, "/model a/one");
		view.handleInput("\r");
		type(view, "/fanout a/one b/two");
		view.handleInput("\r");
		type(view, "/preset save duo");
		view.handleInput("\r");
		expect(store.duo).toEqual({ model: "a/one", fanout: ["a/one", "b/two"] });
		expect(view.render(120).join("\n")).toContain("saved preset duo");
		// a project's preset is not the user's to remove
		store.shared = { thinking: "low" };
		type(view, "/preset rm shared");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain("shared is a project's preset");
		view.handleInput("\u0003");
		type(view, "/preset off");
		view.handleInput("\r");
		type(view, "/preset");
		view.handleInput("\r");
		let out = view.render(120).join("\n");
		expect(out).toContain("Preset for new sessions");
		expect(out).toContain("duo  one · fan-out one, two");
		view.handleInput("\x1b[B"); // duo
		view.handleInput("\r");
		out = view.render(120).join("\n");
		expect(out).toContain("preset duo");
		expect(out).toContain("next task: 2 sessions");
		type(view, "/preset rm duo");
		view.handleInput("\r");
		expect(store.duo).toBeUndefined();
		expect(user.has("duo")).toBe(false);
		expect(view.render(120).join("\n")).not.toContain("new sessions: preset duo");
		view.dispose();
	});
});
