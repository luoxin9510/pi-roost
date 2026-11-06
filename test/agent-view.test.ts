import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDef } from "../lib/agents.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AgentView, type AgentViewOptions } from "../hub/agent-view.ts";
import type { DaemonClient } from "../lib/client.ts";
import type { Event, JobRow } from "../lib/protocol.ts";
import type { RoostEvent } from "../lib/events.ts";
import type { ConciergeStatus, StandingOrder } from "../lib/concierge.ts";
import type { BoardTask } from "../lib/board.ts";
import { modelFacts, rowDetailsOf, takesReplies } from "../lib/view-model.ts";

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
	/** M43: what /log shows. */
	log: RoostEvent[] = [];
	/** M44: the concierge as the daemon says it stands. */
	concierge: ConciergeStatus = { on: false, id: null, state: null, live: false, model: null, wakesLastHour: 0, lastWakeAt: null, behind: 0, costToday: 0, budget: 1, overBudget: false, notice: null, policy: { answer: "never", act: false }, orders: 0, answered: null, answer: null };
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
	/** M51: the request ids the hub sent (kept apart from the args the tests compare). */
	requestIds: { op: string; id: string }[] = [];
	async request(op: string, args: unknown): Promise<unknown> {
		if ((op === "reply" || op === "dispatch") && args && typeof args === "object" && "requestId" in args) {
			const { requestId, ...rest } = args as { requestId: string };
			this.requestIds.push({ op, id: requestId });
			args = rest;
		}
		this.requests.push({ op, args });
		if (op === "list") return { jobs: this.rows };
		if (op === "dispatch") {
			await new Promise((r) => setTimeout(r, this.dispatchDelay));
			return { id: "new1", name: "new task" };
		}
		if (op === "reply") return this.replyResult;
		// M48: a peek's commands
		if (op === "respawn") return { results: [{ id: (args as { id: string }).id, started: true }] };
		if (op === "rm") return { id: (args as { id: string }).id };
		if (op === "rename") return args;
		if (op === "pin") return { id: (args as { id: string }).id, pinned: (args as { pinned: boolean }).pinned };
		if (op === "schedule-add") return { ...(args as object), paused: false, nextAt: Date.now() + 3600_000 };
		if (op === "events") return { events: this.log, cursor: this.log.length };
		if (op === "concierge") {
			const a = args as { action: string };
			if (a.action === "on") this.concierge = { ...this.concierge, on: true, id: "c1", state: "working", live: true, model: "anthropic/claude-haiku-5-5" };
			if (a.action === "off") this.concierge = { ...this.concierge, on: false };
			// M45: the policy and the undo
			if (a.action === "answer") this.concierge = { ...this.concierge, policy: { ...this.concierge.policy, answer: (args as { answer: "never" }).answer } };
			if (a.action === "act") this.concierge = { ...this.concierge, policy: { ...this.concierge.policy, act: (args as { act: boolean }).act } };
			if (a.action === "undo") this.concierge = { ...this.concierge, answered: this.concierge.answered ? { ...this.concierge.answered, undone: true } : null };
			return this.concierge;
		}
		if (op === "concierge-ask") return { id: "c1" };
		// M46: the standing orders
		if (op === "concierge-order") {
			const a = args as { action: string; id?: number; text?: string; when?: string };
			if (a.action === "rm") this.orders = this.orders.filter((o) => o.id !== a.id);
			if (a.action === "add") {
				const order: StandingOrder = { id: this.orders.length + 1, text: a.text ?? "", when: a.when ?? null, by: "user", at: Date.now(), lastAt: null, nextAt: a.when ? Date.now() + 60_000 : null, count: 0 };
				this.orders = [...this.orders, order];
				return { orders: this.orders, order };
			}
			return { orders: this.orders };
		}
		// M47: the task board
		if (op === "task") {
			const a = args as { action: string; id?: number; title?: string; detail?: string; after?: number[]; result?: string; to?: string };
			if (a.action === "list") return { tasks: this.tasks };
			if (a.action === "add") {
				const task: BoardTask = { id: this.tasks.length + 1, title: a.title ?? "", detail: a.detail ?? null, state: "open", after: a.after ?? [], by: { who: "user", whoId: null }, at: Date.now(), owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: null, waiting: [] };
				this.tasks = [...this.tasks, task];
				return { tasks: this.tasks, task };
			}
			const task = this.tasks.find((t) => t.id === a.id);
			if (!task) throw Object.assign(new Error(`no task #${a.id}`), { code: "not_found" });
			if (a.action === "assign") {
				task.assigned = { id: "w1", name: a.to ?? "", at: Date.now() };
				return { tasks: this.tasks, task, sent: "delivered" };
			}
			// M55: start and merge
			if (a.action === "start") return { tasks: this.tasks, task, job: { id: "w9", name: "users" } };
			// M57: approve: shown (dry), then with the hash
			if (a.action === "approve") return (a as { dry?: boolean }).dry ? { tasks: this.tasks, task, note: "verify: npm test", hash: "h1" } : { tasks: this.tasks, task, note: "approved for r: verify: npm test" };
			if (a.action === "merge") return { tasks: this.tasks, task: { ...task, workspace: { stage: "merged" } }, note: "merged into main (abc12345)" };
			if (a.action === "done") Object.assign(task, { state: "done", doneAt: Date.now(), result: a.result ?? null });
			if (a.action === "drop") task.state = "dropped";
			if (a.action === "release") task.state = "open";
			return { tasks: this.tasks, task };
		}
		return {};
	}
	orders: StandingOrder[] = [];
	tasks: BoardTask[] = [];
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
		expect(client.requests.find((r) => r.op === "reply")?.args).toEqual({ id: a.id, text: "no", mode: "steer" });
		// M51: with a request id, so a resend after a lost answer is taken once
		expect(client.requestIds.find((r) => r.op === "reply")?.id).toMatch(/^hub\./);

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

describe("M45: escalation and policy in the hub", () => {
	it("a suggestion on a waiting row is a banner: Ctrl+Y sends it, Ctrl+E edits it, Esc dismisses it; the peek shows it; the line says what it answered and the policy", async () => {
		const launch = { cwd: "/w", sessionFile: "/s/c.jsonl", command: ["pi"], env: { ROOST_ROLE: "concierge" }, name: "concierge", origin: "dispatch" as const };
		const since = Date.now() - 120_000;
		const waiting = row({ id: "q1", name: "api-fix", state: "blocked", status: "waiting", waitingFor: "question", question: "Use schema v2?", stateSince: since, suggested: { text: "yes, v2", why: "the migration session created it", at: since + 1000 } });
		const { view, client } = setup([waiting, row({ id: "w1", name: "lint" })], { extra: { conciergeLaunch: () => launch } });
		await view.start();
		// with the concierge off, no banner
		expect(view.render(200).join("\n")).not.toContain("needs you ·");
		type(view, "/concierge on");
		view.handleInput("\r");
		await sleep(20);
		let screen = view.render(200).join("\n");
		expect(screen).toContain("needs you · api-fix asks: Use schema v2? (2m");
		expect(screen).toContain("· concierge suggests: yes, v2 (the migration session created it) · Ctrl+Y sends it · Ctrl+E edits · Esc dismisses");
		// Ctrl+Y: the suggestion goes as the user's reply
		view.handleInput("\x19");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => r.args)).toEqual([{ id: "q1", text: "yes, v2" }]);
		expect(client.requestIds.map((r) => r.id)).toEqual([expect.stringMatching(/^hub-accept-q1-/)]);
		expect(view.render(200).join("\n")).toContain("sent to api-fix: yes, v2");
		// a second press sends nothing (the row's next question is not this answer's)
		view.handleInput("\x19");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "reply")).toHaveLength(1);
		expect(view.render(200).join("\n")).not.toContain("needs you ·");
		// a new suggestion (a later at) is a banner again
		client.emit({ event: "job", job: { ...waiting, suggested: { text: "yes, v2", why: "the migration session created it", at: since + 2000 } } });
		expect(view.render(200).join("\n")).toContain("needs you ·");
		// Ctrl+E: the row's peek with the suggestion in the reply box
		view.handleInput("\x05");
		screen = view.render(200).join("\n");
		expect(screen).toContain("concierge suggests: yes, v2 · the migration session created it");
		expect((view as unknown as { reply: { getValue(): string } }).reply.getValue()).toBe("yes, v2");
		view.handleInput("\x1b");
		// Esc on the list dismisses this suggestion; a new one (a later at) shows again
		view.handleInput("\x1b");
		expect(view.render(200).join("\n")).toContain("dismissed; api-fix still waits");
		expect(view.render(200).join("\n")).not.toContain("needs you ·");
		client.emit({ event: "job", job: { ...waiting, suggested: { text: "yes, v2 (confirmed)", why: null, at: since + 5000 } } });
		expect(view.render(200).join("\n")).toContain("concierge suggests: yes, v2 (confirmed) · Ctrl+Y");
		// the row moving on takes the banner with it
		client.emit({ event: "job", job: { ...waiting, state: "working", status: "busy", waitingFor: null, question: null, suggested: null } });
		expect(view.render(200).join("\n")).not.toContain("needs you ·");
		// the policy: set from the hub; the line says it; an answer it gave, with the undo
		type(view, "/concierge answer routine");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.find((r) => r.op === "concierge" && (r.args as { action: string }).action === "answer")?.args).toEqual({ action: "answer", answer: "routine" });
		expect(view.render(200).join("\n")).toContain("concierge answers: routine questions by itself");
		type(view, "/concierge act on");
		view.handleInput("\r");
		await sleep(20);
		client.concierge = { ...client.concierge, policy: { answer: "routine", act: true }, answered: { id: "q1", name: "api-fix", text: "yes, v2", at: Date.now() - 10_000, undone: false } };
		client.emit({ event: "concierge", status: client.concierge });
		screen = view.render(200).join("\n");
		expect(screen).toContain("concierge · answered api-fix: yes, v2 (10s ago) · /concierge undo · answers routine · acts");
		type(view, "/concierge undo");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.find((r) => r.op === "concierge" && (r.args as { action: string }).action === "undo")).toBeDefined();
		expect(view.render(200).join("\n")).toContain("withdrawn: the answer to api-fix");
		type(view, "/concierge answer sometimes");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(200).join("\n")).toContain("/concierge answer never | routine | always");
	});
});

describe("M46: standing orders in the hub", () => {
	it("/concierge orders lists them (an overlay, newest first); orders add asks the concierge to keep it; orders rm drops one", async () => {
		const launch = { cwd: "/w", sessionFile: "/s/c.jsonl", command: ["pi"], env: { ROOST_ROLE: "concierge" }, name: "concierge", origin: "dispatch" as const };
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { conciergeLaunch: () => launch } });
		await view.start();
		type(view, "/concierge on");
		view.handleInput("\r");
		await sleep(20);
		// none yet
		type(view, "/concierge orders");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(200).join("\n")).toContain("no standing orders · /concierge orders add <rule>");
		// add: the user's own, kept at once; a clock first, in roost's words
		type(view, "/concierge orders add when build ends, tell deploy its result");
		view.handleInput("\r");
		await sleep(20);
		type(view, '/concierge orders add every 30m say what is blocked');
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "concierge-order" && (r.args as { action: string }).action === "add").map((r) => r.args)).toEqual([
			{ action: "add", text: "when build ends, tell deploy its result" },
			{ action: "add", text: "say what is blocked", when: "every 30m" },
		]);
		expect(view.render(200).join("\n")).toContain("kept standing order #2 (every 30m); the concierge sees it on its next wake");
		expect(client.requests.some((r) => r.op === "concierge-ask")).toBe(false);
		type(view, "/concierge orders add");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(200).join("\n")).toContain("/concierge orders add [every 30m | daily 18:00 | weekdays 09:00 | cron");
		// starts like a clock but is not one in roost's words: said, not kept as prose
		type(view, "/concierge orders add every 10s say what is blocked");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(200).join("\n")).toContain("that starts like a clock but is not one in roost's words");
		expect(client.requests.filter((r) => r.op === "concierge-order" && (r.args as { action: string }).action === "add")).toHaveLength(2);
		// the list: an overlay, newest first, the user's marked, the ones on a clock with their when and count
		const now = Date.now();
		client.orders = [
			{ id: 1, text: "when build ends, tell deploy its result", when: null, by: "user", at: now - 3600_000, lastAt: now - 60_000, nextAt: null, count: 2 },
			{ id: 2, text: "say what is blocked", when: "every 30m", by: "concierge", at: now - 600_000, lastAt: null, nextAt: now + 1_200_000, count: 0 },
		];
		type(view, "/concierge orders");
		view.handleInput("\r");
		await sleep(20);
		const screen = view.render(200);
		const text = screen.join("\n");
		expect(text).toContain("Standing orders · what the concierge keeps in mind");
		expect(text.indexOf("#2 every 30m · say what is blocked")).toBeLessThan(text.indexOf("#1 when build ends, tell deploy its result (applied ×2, 1m ago) · yours"));
		expect(text).toContain("↑↓ scroll · Esc close");
		view.handleInput("\x1b");
		expect(view.render(200).join("\n")).not.toContain("Standing orders · what");
		// rm
		type(view, "/concierge orders rm 2");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.find((r) => r.op === "concierge-order" && (r.args as { action: string }).action === "rm")?.args).toEqual({ action: "rm", id: 2 });
		expect(client.orders.map((o) => o.id)).toEqual([1]);
		expect(view.render(200).join("\n")).toContain("dropped standing order #2");
		type(view, "/concierge orders rm x");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(200).join("\n")).toContain("/concierge orders rm <id>");
		type(view, "/concierge orders what");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(200).join("\n")).toContain("/concierge orders | orders add <rule> | orders rm <id>");
	});
});

describe("M44: the concierge in the hub", () => {
	it("/concierge on starts it with its launch; its line sits under the header; ? asks it and the answer opens; its row is not listed; off", async () => {
		const launch = { cwd: "/w", sessionFile: "/s/c.jsonl", command: ["pi"], env: { ROOST_ROLE: "concierge" }, name: "concierge", origin: "dispatch" as const };
		const { view, client } = setup([row({ name: "fix tests" })], { extra: { conciergeLaunch: () => launch } });
		await view.start();
		expect(view.render(120).join("\n")).not.toContain("concierge ·");
		// ? with it off: help
		view.handleInput("?");
		expect(view.render(120).join("\n")).toContain("/concierge on|off|log");
		view.handleInput("\x1b");
		type(view, "/concierge on");
		view.handleInput("\r");
		await sleep(20);
		const on = client.requests.find((r) => r.op === "concierge" && (r.args as { action: string }).action === "on");
		expect((on?.args as { launch: typeof launch }).launch).toEqual(launch);
		let screen = view.render(120).join("\n");
		expect(screen).toContain("concierge on (anthropic/claude-haiku-5-5)");
		expect(screen).toContain("concierge · quiet");
		// a notice from it, pushed by the daemon
		const at = Date.now() - 60_000;
		client.emit({ event: "concierge", status: { ...client.concierge, notice: { kind: "need", text: "fix tests asks which branch", at }, costToday: 0.02 } });
		screen = view.render(120).join("\n");
		expect(screen).toContain("concierge · needs you: fix tests asks which branch (1m ago) · $0.02 today");
		// ? on an empty input starts a question; Enter asks; the answer opens when it comes
		view.handleInput("?");
		type(view, "what is blocked");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.find((r) => r.op === "concierge-ask")?.args).toEqual({ text: "what is blocked" });
		expect(view.render(120).join("\n")).toContain("asked the concierge");
		client.emit({ event: "concierge", status: { ...client.concierge, answer: { text: "fix tests waits for a branch name.", at: Date.now() } } });
		screen = view.render(120).join("\n");
		expect(screen).toContain("Concierge");
		expect(screen).toContain("fix tests waits for a branch name.");
		view.handleInput("\x1b");
		expect(view.render(120).join("\n")).not.toContain("fix tests waits for a branch name.");
		// its own job is a line under the header, never a row
		client.emit({ event: "job", job: row({ id: "c1", name: "concierge", role: "concierge" }) });
		screen = view.render(120).join("\n");
		expect(screen).toContain("0 needs input · 1 working · 0 completed");
		expect(screen.split("\n").filter((l) => /concierge\s+(working|done|blocked|failed|stopped)/.test(l))).toEqual([]);
		// /ask works too; off takes the line away
		type(view, "/ask anything new?");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "concierge-ask")).toHaveLength(2);
		type(view, "/concierge off");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).not.toContain("concierge ·");
		view.dispose();
	});
});

describe("M43: /log in the hub", () => {
	it("lists what happened, newest first, and closes on Esc; an empty feed says so", async () => {
		const { view, client } = setup([row({ name: "fix tests" })]);
		await view.start();
		type(view, "/log");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("nothing happened yet");
		const at = Date.now();
		client.log = [
			{ seq: 1, at: at - 120_000, kind: "dispatch", id: "j1", name: "fix tests", who: "user" },
			{ seq: 2, at: at - 60_000, kind: "state", id: "j1", name: "fix tests", state: "blocked", from: "working", waitingFor: "question", text: "Which branch?" },
			{ seq: 3, at: at - 1000, kind: "message", id: "j1", name: "fix tests", who: "lead", text: "use main" },
		];
		type(view, "/log");
		view.handleInput("\r");
		await sleep(20);
		const panel = view.render(120).join("\n");
		expect(panel).toContain("Log · what happened lately");
		expect(panel).toContain("1m  fix tests asks: Which branch?");
		expect(panel).toContain("lead → fix tests: use main");
		expect(panel.indexOf("use main")).toBeLessThan(panel.indexOf("started fix tests"));
		expect(client.requests.filter((r) => r.op === "events")).toHaveLength(2);
		view.handleInput("r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "events")).toHaveLength(3);
		view.handleInput("\x1b");
		expect(view.render(120).join("\n")).not.toContain("Log · what happened lately");
		view.dispose();
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
			{ id: "a", text: "rebase on main", mode: "steer" },
			{ id: "b", text: "rebase on main", mode: "steer" },
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

	it("M28: in a peek Enter steers and Alt+Enter waits for the current work; marked rows too", async () => {
		const rows = [row({ id: "a", name: "one" }), row({ id: "b", name: "two" })];
		const { view, client } = setup(rows);
		await view.start();
		view.handleInput(" ");
		type(view, "use pnpm");
		view.handleInput("\r");
		await sleep(10);
		expect(view.render(100).join("\n")).toContain("sent · one · joins its current work");
		type(view, "then run the tests");
		view.handleInput("\x1b\r"); // Alt+Enter
		await sleep(10);
		expect(view.render(100).join("\n")).toContain("sent · one · after its current work");
		view.handleInput("\x1b"); // close the peek
		view.handleInput("\x0f");
		view.handleInput("\x0f");
		type(view, "rebase please");
		view.handleInput("\x1b\r");
		await sleep(10);
		expect(client.requests.filter((r) => r.op === "reply").map((r) => (r.args as { mode: string }).mode)).toEqual(["steer", "followUp", "followUp", "followUp"]);
		expect(view.render(100).join("\n")).toContain("sent to 2 of 2 sessions (after their current work)");
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
	function withPresets(initial: Record<string, import("../lib/config.ts").Preset>, cwd?: string) {
		const store = { ...initial };
		const user = new Set(Object.keys(initial));
		const s = setup([], {
			agents: new Map([["reviewer", reviewer]]),
			extra: {
				...(cwd ? { cwd } : {}),
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
		const { mkdirSync, mkdtempSync, realpathSync, symlinkSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const hub = realpathSync(mkdtempSync(join(tmpdir(), "roost-preset-")));
		mkdirSync(join(hub, "api"));
		symlinkSync(tmpdir(), join(hub, "out"));
		const { view } = withPresets(
			{ review: { model: "b/two", thinking: "high", agent: "reviewer", dir: "api" }, escape: { dir: "out" }, gone: { dir: "nope" }, fast: { model: "a/one" } },
			hub,
		);
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
		expect(o).toMatchObject({ cwd: join(hub, "api"), model: "b/two", thinking: "high" });
		expect(o.agent?.name).toBe("reviewer");
		type(view, "@/tmp check the other diff");
		view.handleInput("\r");
		await sleep(10);
		expect((launches[before + 1]!.opts as { cwd: string }).cwd).toMatch(/tmp$/);
		// another preset replaces the whole choice: nothing of review's stays
		type(view, "/preset fast");
		view.handleInput("\r");
		const head = view.render(140).find((l) => l.startsWith("new sessions:"))!;
		expect(head).toBe("new sessions: preset fast · model a/one");
		// a link out of the hub's directory, or a directory that is not there, starts nothing
		for (const [name, says] of [
			["escape", "leads outside"],
			["gone", "does not exist here"],
		] as const) {
			const n = launches.length;
			type(view, `/preset ${name}`);
			view.handleInput("\r");
			type(view, "run the whole suite");
			view.handleInput("\r");
			await sleep(10);
			expect(launches.length).toBe(n);
			expect(view.render(140).join("\n")).toContain(says);
			view.handleInput("\u0003");
		}
		// off: back to the defaults; a name like toString is no preset
		type(view, "/preset off");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).not.toContain("new sessions: preset");
		type(view, "/preset toString");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain("no preset toString");
		view.dispose();
		rmSync(hub, { recursive: true, force: true });
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

describe("AgentView schedules (M39, M40)", () => {
	function withAll() {
		const profiled: { profile: string; task: string; opts: unknown }[] = [];
		const s = setup([], {
			extra: {
				profiles: () => ["codex"],
				launchProfile: (profile, task, o) => {
					profiled.push({ profile, task, opts: o });
					return { kind: "shell", profile, cwd: o.cwd, sessionFile: "", command: [profile, task], env: {}, name: task, origin: "dispatch" };
				},
				scheduleLaunch: (task, o) => ({ cwd: o.cwd, sessionFile: "/s/{{run}}.jsonl", command: ["pi", "--session", "/s/{{run}}.jsonl", "--", task], env: {}, name: task, origin: "dispatch", model: o.model }),
			},
		});
		return { ...s, profiled };
	}
	const added = (client: FakeClient) => client.requests.filter((r) => r.op === "schedule-add").map((r) => r.args as { name: string; when: string; task: string; launch: Record<string, unknown> });

	it("/schedule adds a pi session, the /profile agent, or a ! command, with the view's choices", async () => {
		const { view, client, profiled } = withAll();
		await view.start();
		const submit = async (text: string) => {
			type(view, text);
			view.handleInput("\r");
			await sleep(10);
		};
		await submit("/model a/one");
		await submit("/schedule nightly every 2h check the build");
		expect(added(client)[0]).toMatchObject({ name: "nightly", when: "every 2h", task: "check the build", launch: { model: "a/one", sessionFile: "/s/{{run}}.jsonl" } });
		await submit("/profile codex");
		await submit("/model o3-mini");
		await submit("/schedule deps daily 09:00 update the dependencies");
		expect(added(client)[1]).toMatchObject({ name: "deps", launch: { kind: "shell", profile: "codex", command: ["codex", "update the dependencies"] } });
		expect(profiled[0]).toMatchObject({ profile: "codex", task: "update the dependencies", opts: { worktree: false, model: "o3-mini" } });
		await submit("/schedule tests weekdays 18:00 ! npm test");
		expect(added(client)[2]).toMatchObject({ name: "tests", when: "weekdays 18:00", launch: { kind: "shell", command: ["sh", "-lc", "npm test"] } });
		expect(added(client)[2]!.launch.profile).toBeUndefined();
		await submit("/schedule bad hourly task");
		expect(added(client)).toHaveLength(3);
	});
});

describe("AgentView agent profiles (M30)", () => {
	function withProfiles(presets: Record<string, import("../lib/config.ts").Preset> = {}) {
		const profiled: { profile: string; task: string; opts: unknown }[] = [];
		const s = setup([], {
			extra: {
				profiles: () => ["codex", "aider"],
				launchProfile: (profile, task, o) => {
					profiled.push({ profile, task, opts: o });
					return { kind: "shell", profile, cwd: o.cwd, sessionFile: "", command: [profile, task], env: {}, name: task, origin: "dispatch" };
				},
				presets: () => presets,
			},
		});
		return { ...s, profiled };
	}

	it("/profile picks the agent new sessions run; tasks go to it, with any model id; /profile pi goes back", async () => {
		const { view, client, profiled } = withProfiles();
		await view.start();
		type(view, "/profile nope");
		view.handleInput("\r");
		expect(view.render(100).join("\n")).toContain("no profile nope");
		view.handleInput("\u0003");
		type(view, "/profile codex");
		view.handleInput("\r");
		type(view, "/model o3-mini");
		view.handleInput("\r");
		expect(view.render(120).find((l) => l.startsWith("new sessions:"))).toBe("new sessions: runs codex · model o3-mini");
		const before = launches.length;
		type(view, "fix the flaky test");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.length).toBe(before);
		expect(profiled[0]).toMatchObject({ profile: "codex", task: "fix the flaky test", opts: { cwd: "/w", model: "o3-mini" } });
		expect(client.requests.find((r) => r.op === "dispatch")?.args).toMatchObject({ kind: "shell", profile: "codex" });
		// fan-out runs pi sessions only
		type(view, "/fanout a/one b/two");
		view.handleInput("\r");
		type(view, "another task here");
		view.handleInput("\r");
		expect(view.render(120).join("\n")).toContain("fan-out runs pi sessions");
		view.handleInput("\u0003");
		type(view, "/fanout off");
		view.handleInput("\r");
		type(view, "/profile pi");
		view.handleInput("\r");
		type(view, "/model default");
		view.handleInput("\r");
		type(view, "a task for pi");
		view.handleInput("\r");
		await sleep(10);
		expect(launches.length).toBe(before + 1);
	});

	it("a preset may run a profile; /preset off goes back to pi", async () => {
		const { view, profiled } = withProfiles({ quick: { profile: "aider", model: "sonnet" } });
		await view.start();
		type(view, "/preset quick");
		view.handleInput("\r");
		expect(view.render(140).find((l) => l.startsWith("new sessions:"))).toBe("new sessions: preset quick · runs aider · model sonnet");
		type(view, "tidy up the readme");
		view.handleInput("\r");
		await sleep(10);
		expect(profiled[0]).toMatchObject({ profile: "aider", opts: { model: "sonnet" } });
		type(view, "/preset off");
		view.handleInput("\r");
		expect(view.render(140).some((l) => l.includes("runs aider"))).toBe(false);
	});

	it("a profile's row takes replies and shows which agent it is; a plain command's does not", () => {
		const agentRow = row({ kind: "shell", profile: "codex", model: "o3" });
		const cmd = row({ kind: "shell", profile: "shell", model: null });
		expect(takesReplies(agentRow)).toBe(true);
		expect(takesReplies(cmd)).toBe(false);
		expect(rowDetailsOf(agentRow)).toMatchObject({ model: "codex o3", context: null });
		expect(rowDetailsOf({ ...agentRow, model: null })).toMatchObject({ model: "codex" });
		expect(rowDetailsOf(cmd)).toBeNull();
		expect(modelFacts(agentRow)).toEqual(["agent codex", "o3"]);
	});
});

describe("M55: /tasks start and merge in the hub", () => {
	it("start makes the task's worktree, launches a session in it with the task as its prompt, and sends both; merge sends the configured mode", async () => {
		const made: unknown[] = [];
		const fake = ((repo: string, id: number, title: string) => {
			made.push([repo, id, title]);
			return { path: "/r/.pi/worktrees/t1-users-ab12", branch: "roost/t1-users-ab12", repo: "/r", base: "a".repeat(40), baseRef: "main", cwd: "/r/.pi/worktrees/t1-users-ab12", sourceDirty: false, included: [] };
		}) as never;
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { createTaskWorktree: fake, taskMerge: "no-ff" } });
		client.tasks = [{ id: 1, title: "users", detail: "a users table", state: "open", after: [], by: { who: "user", whoId: null }, at: 1, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: "/r", waiting: [] }];
		await view.start();
		launches.length = 0;
		type(view, "/tasks start 1");
		view.handleInput("\r");
		await sleep(20);
		expect(made).toEqual([["/r", 1, "users"]]);
		expect(launches[0]!.opts).toMatchObject({ cwd: "/r/.pi/worktrees/t1-users-ab12", worktree: false });
		expect(launches[0]!.task).toContain("Task #1: users");
		expect(launches[0]!.task).toContain("a users table");
		expect(launches[0]!.task).toContain("roost_task_done");
		const start = client.requests.find((r) => r.op === "task" && (r.args as { action: string }).action === "start")!.args as { workspace: unknown; launch: { name: string } };
		expect(start.workspace).toEqual({ path: "/r/.pi/worktrees/t1-users-ab12", branch: "roost/t1-users-ab12", baseRef: "main", baseSha: "a".repeat(40) });
		expect(view.render(120).join("\n")).toContain("#1 started · users · ⎇ roost/t1-users-ab12");
		type(view, "/tasks merge 1");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "task").map((r) => r.args)).toContainEqual({ action: "merge", id: 1, mode: "no-ff" });
		expect(view.render(120).join("\n")).toContain("#1: merged into main (abc12345)");
	});

	it("a task for any session gets no workspace", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { createTaskWorktree: (() => { throw new Error("not called"); }) as never } });
		client.tasks = [{ id: 1, title: "x", detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: 1, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: null, waiting: [] }];
		await view.start();
		type(view, "/tasks start 1");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("#1 is for any session");
	});
});

describe("M47: the task board in the hub", () => {
	it("/tasks shows the board (an overlay); add, assign, done, rm act on it; the header counts what is on it", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint" })]);
		await view.start();
		expect(client.requests.filter((r) => r.op === "task").map((r) => r.args)).toEqual([{ action: "list" }]);
		// nothing on it: no header line, an empty overlay
		expect(view.render(120).join("\n")).not.toContain("tasks ");
		type(view, "/tasks");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("the board is empty");
		view.handleInput("\x1b");
		// add: a title, the tasks it waits on, the detail after --
		type(view, "/tasks add the schema");
		view.handleInput("\r");
		await sleep(20);
		type(view, "/tasks add write the tests after #1 -- the unit tests for the board");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "task" && (r.args as { action: string }).action === "add").map((r) => r.args)).toEqual([
			{ action: "add", title: "the schema", detail: undefined, after: undefined, project: null },
			{ action: "add", title: "write the tests", detail: "the unit tests for the board", after: [1], project: null },
		]);
		expect(view.render(120).join("\n")).toContain("task #2 added: write the tests (after #1)");
		type(view, "/tasks add");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("/tasks add <title> [after #n] [-- detail]");
		// the counts come as an event: the header says them while something is on the board
		client.emit({ event: "board", board: { open: 1, claimed: 0, blocked: 1, done: 0 } });
		expect(view.render(120).join("\n")).toContain("tasks 1 open · 1 blocked · /tasks");
		// the overlay: open, blocked (with its detail), the keys
		type(view, "/tasks");
		view.handleInput("\r");
		await sleep(20);
		const screen = view.render(120).join("\n");
		expect(screen).toContain("Task board · all projects · 1 open · 1 blocked");
		expect(screen).toContain("#1 open · the schema");
		expect(screen).toContain("#2 blocked on #1 · write the tests");
		expect(screen).toContain("the unit tests for the board");
		expect(screen).toContain("/tasks all · add <title> [after #n] [-- detail] · assign <id> <session>");
		view.handleInput("\x1b");
		// assign, done, rm (by number, # or not)
		type(view, "/tasks assign 1 lint");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("task #1 handed to lint");
		type(view, "/tasks done #1 applied v2");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "task").map((r) => r.args)).toContainEqual({ action: "done", id: 1, result: "applied v2" });
		expect(view.render(120).join("\n")).toContain("task #1 done");
		type(view, "/tasks rm 2");
		view.handleInput("\r");
		await sleep(20);
		expect(client.requests.filter((r) => r.op === "task").map((r) => r.args)).toContainEqual({ action: "drop", id: 2 });
		expect(view.render(120).join("\n")).toContain("task #2 dropped");
		// the done one is listed, dim, after the live ones; a dropped one is gone
		type(view, "/tasks");
		view.handleInput("\r");
		await sleep(20);
		const again = view.render(120).join("\n");
		expect(again).toContain("every task is done");
		expect(again).toContain("· the schema → applied v2");
		expect(again).not.toContain("write the tests");
		view.handleInput("\x1b");
		// what the hub cannot parse, and what the daemon refuses, are said
		type(view, "/tasks assign x");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("/tasks assign <id> <session id or name>");
		type(view, "/tasks done 9");
		view.handleInput("\r");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("no task #9");
		// a title that ends in a number is a title (`after` wants a #); a long run of digits does not stall; several ids
		const before = client.requests.length;
		for (const t of ["/tasks add retry after 3", "/tasks add x after 1111111111111111111111111111111111111z", "/tasks add a after #1, #2 -- d"]) {
			type(view, t);
			view.handleInput("\r");
			await sleep(20);
		}
		expect(client.requests.slice(before).map((r) => r.args)).toEqual([
			{ action: "add", title: "retry after 3", detail: undefined, after: undefined, project: null },
			{ action: "add", title: "x after 1111111111111111111111111111111111111z", detail: undefined, after: undefined, project: null },
			{ action: "add", title: "a", detail: "d", after: [1, 2], project: null },
		]);
	});
});

describe("M48: the peek, deeper", () => {
	/** The screen once it says `text` (an overlay or a notice comes after an await), within a second. */
	const screenWith = async (view: AgentView, text: string, width = 120): Promise<string> => {
		let screen = "";
		for (let i = 0; i < 200; i++) {
			screen = view.render(width).join("\n");
			if (screen.includes(text)) return screen;
			await sleep(5);
		}
		return screen;
	};
	const entry = (id: string, parentId: string | null, message: unknown) => `${JSON.stringify({ type: "message", id, parentId, message })}\n`;
	/** A pi session file with a prompt, a reply with a tool call, its result and a last reply. */
	function sessionFile(dir: string): string {
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", id: "s", version: 1 })}\n` +
				entry("m1", null, { role: "user", content: [{ type: "text", text: "write the tests" }] }) +
				entry("m2", "m1", { role: "assistant", content: [{ type: "text", text: "Reading the code first." }, { type: "toolCall", id: "t1", name: "read_file", arguments: { path: "src/x.ts" } }] }) +
				entry("m3", "m2", { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "export const x = 1" }] }) +
				entry("m4", "m3", { role: "assistant", content: [{ type: "text", text: "Now the tests." }] }),
		);
		return file;
	}
	const usage = { input: 30_000, output: 4_000, cacheRead: 0, cacheWrite: 0, cost: 0.12, today: 0.12, day: 0, sub: false, models: {} };

	it("shows the task, where and since when, the cost, queued replies and the transcript tail (live); a failed row's error whole; the box says what Enter does", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-peek-"));
		try {
			const file = sessionFile(dir);
			const home = process.env.HOME ?? "/nohome";
			const r1 = row({ id: "p1", name: "tests", task: "write the tests for x", cwd: `${home}/w`, queued: 2, usage, sessionFile: file });
			const failed = row({ id: "p2", name: "lint", state: "failed", status: null, pid: null, endedAt: Date.now() - 5_000, error: `the linter found ${"many ".repeat(30)}problems in the end` });
			const asking = row({ id: "p3", name: "api", state: "blocked", status: "waiting", waitingFor: "question", question: "Use v2?", choices: ["yes", "no"] });
			const { view } = setup([r1, failed, asking]);
			await view.start();
			// the list: Needs input (api), Working (tests), Completed (lint); headers are rows too
			const select = (name: string) => {
				view.handleInput("\x1b[H");
				for (let i = 0; i < 10 && !view.render(120).some((l) => l.startsWith("›") && l.includes(name)); i++) view.handleInput("\x1b[B");
			};
			select("tests");
			view.handleInput(" "); // peek tests
			let screen = view.render(120).join("\n");
			expect(screen).toContain("task: write the tests for x");
			expect(screen).toContain("~/w · started 1m ago");
			expect(screen).toContain("2 replies queued");
			expect(screen).toContain("$0.12 · 34k tokens");
			expect(screen).toContain("you: write the tests");
			expect(screen).toContain("⚙ read_file");
			expect(screen).toContain("› Now the tests.");
			expect(screen).toContain("reply · Enter joins its work");
			// live: the file grows, the tail follows (re-read at most every 2 s)
			appendFileSync(file, entry("m5", "m4", { role: "assistant", content: [{ type: "text", text: "Done: 3 tests pass." }] }));
			(view as unknown as { tails: Map<string, unknown> }).tails.clear();
			screen = view.render(120).join("\n");
			expect(screen).toContain("› Done: 3 tests pass.");
			// the failed row: its error whole, and what Enter does
			view.handleInput("\x1b"); // close
			select("lint");
			view.handleInput(" ");
			screen = view.render(80).join("\n");
			expect(screen).toContain("problems in the end");
			expect(screen).toContain("failed 5s ago · took");
			expect(screen).toContain("/continue picks it up");
			// the asking row: answer
			view.handleInput("\x1b");
			select("api");
			view.handleInput(" ");
			screen = view.render(80).join("\n");
			expect(screen).toContain("1. yes");
			expect(screen).toContain("answer · Enter sends · 1-9 picks a choice");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("commands in a peek act on that session; unknown ones and ! are refused; a reply of several lines goes whole", async () => {
		const r1 = row({ id: "p1", name: "tests" });
		const { view, client } = setup([r1, row({ id: "p2", name: "other" })]);
		await view.start();
		view.handleInput(" ");
		const send = async (text: string, says: string) => {
			view.handleInput("\x03"); // a refused command stays in the box to fix: cleared here
			type(view, text);
			view.handleInput("\r");
			return screenWith(view, says);
		};
		const ops = (op: string) => client.requests.filter((r) => r.op === op).map((r) => r.args);
		expect(await send("/stop", "stopping · tests")).toContain("stopping · tests");
		expect(ops("stop")).toEqual([{ id: "p1" }]);
		expect(await send("/respawn", "starting tests again")).toContain("starting tests again");
		expect(ops("respawn")).toEqual([{ id: "p1" }]);
		expect(await send("/rename api-two", "renamed · api-two")).toContain("renamed · api-two");
		expect(ops("rename")).toEqual([{ id: "p1", name: "api-two" }]);
		await send("/pin", "pinned · tests");
		expect(ops("pin")).toEqual([{ id: "p1", pinned: true }]);
		expect(await send("/continue", "sent · tests")).toContain("sent · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "Continue where you left off.", mode: "followUp" });
		expect(await send("/compact", "/compact · tests")).toContain("/compact · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "/compact" });
		expect(await send("/name zed", "/name · tests")).toContain("/name · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "/name zed" });
		// not the peek's: the session's (a prompt template, a skill), sent as a reply
		expect(await send("/review now", "sent · tests")).toContain("sent · tests");
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "/review now", mode: "steer" });
		expect(await send("!ls", "shell commands are not sent to a session")).toContain("shell commands are not sent to a session");
		expect(ops("reply")).toHaveLength(4);
		// several lines: Ctrl+J adds one; Enter sends them together
		view.handleInput("\x03");
		type(view, "line one");
		view.handleInput("\n");
		type(view, "line two");
		view.handleInput("\r");
		await sleep(20);
		expect(ops("reply").at(-1)).toEqual({ id: "p1", text: "line one\nline two", mode: "steer" });
		// /rm: twice within 2 s; the peek closes with the row
		expect(await send("/rm", "/rm again within 2 s to delete tests")).toContain("/rm again within 2 s to delete tests");
		expect(ops("rm")).toEqual([]);
		expect(await send("/rm", "deleted · tests")).toContain("deleted · tests");
		expect(ops("rm")).toEqual([{ id: "p1" }]);
		expect(view.render(120).join("\n")).not.toContain("/ commands · Esc close");
	});

	it("/log and /transcript in a peek open overlays for that session; Tab completes a / command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-peek-"));
		try {
			const file = sessionFile(dir);
			const r1 = row({ id: "p1", name: "tests", sessionFile: file });
			const { view, client } = setup([r1, row({ id: "p2", name: "other" })]);
			client.log = [
				{ seq: 1, at: Date.now() - 60_000, kind: "state", id: "p1", name: "tests", state: "working", from: null, text: null },
				{ seq: 2, at: Date.now() - 30_000, kind: "state", id: "p2", name: "other", state: "done", from: "working", text: "all green" },
			];
			await view.start();
			view.handleInput(" ");
			type(view, "/log");
			view.handleInput("\r");
			let screen = await screenWith(view, "Log · tests (newest first)");
			expect(screen).toContain("Log · tests (newest first)");
			expect(screen).not.toContain("all green");
			view.handleInput("\x1b");
			type(view, "/transcript");
			view.handleInput("\r");
			screen = await screenWith(view, "Transcript · tests");
			expect(screen).toContain("Transcript · tests");
			expect(screen).toContain("› Now the tests.");
			expect(screen).toContain("→ export const x = 1");
			view.handleInput("\x1b");
			expect(view.render(120).join("\n")).not.toContain("Transcript · tests");
			// completion: pi's menu opens on /, Tab takes the first match
			const reply = (view as unknown as { reply: { getValue(): string; autocompleteOpen(): boolean } }).reply;
			type(view, "/tra");
			for (let i = 0; i < 100 && !reply.autocompleteOpen(); i++) await sleep(5);
			expect(reply.autocompleteOpen()).toBe(true);
			view.handleInput("\t");
			for (let i = 0; i < 100 && reply.getValue().trim() !== "/transcript"; i++) await sleep(5);
			expect(reply.getValue().trim()).toBe("/transcript");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Enter on a / command in the open menu runs it at once; Tab in a peek opens pi's menu; a narrower terminal keeps every line within it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-peek-"));
		try {
			const file = sessionFile(dir);
			appendFileSync(file, entry("m5", "m4", { role: "assistant", content: [{ type: "text", text: `A very long line ${"x".repeat(150)} end` }] }));
			const r1 = row({ id: "p1", name: "tests", sessionFile: file, task: `t ${"y".repeat(150)}` });
			const { view, client } = setup([r1]);
			client.log = [{ seq: 1, at: Date.now() - 60_000, kind: "state", id: "p1", name: "tests", state: "working", from: null, text: null }];
			await view.start();
			view.handleInput(" ");
			const reply = (view as unknown as { reply: { getValue(): string; autocompleteOpen(): boolean } }).reply;
			const open = async () => {
				for (let i = 0; i < 100 && !reply.autocompleteOpen(); i++) await sleep(5);
				return reply.autocompleteOpen();
			};
			// typed whole, the menu still open (as it is for a person): one Enter
			type(view, "/transcript");
			expect(await open()).toBe(true);
			view.handleInput("\r");
			expect(await screenWith(view, "Transcript · tests")).toContain("Transcript · tests");
			expect(reply.getValue()).toBe("");
			view.handleInput("\x1b");
			// the menu closed with Esc, Tab opens it again for the prefix (pi's forced completion)
			type(view, "/s");
			expect(await open()).toBe(true);
			view.handleInput("\x1b");
			for (let i = 0; i < 100 && reply.autocompleteOpen(); i++) await sleep(5);
			expect(reply.autocompleteOpen()).toBe(false);
			view.handleInput("\t");
			expect(await open()).toBe(true);
			view.handleInput("\x1b");
			for (let i = 0; i < 100 && reply.autocompleteOpen(); i++) await sleep(5);
			view.handleInput("\x03"); // clear /s
			// the same in the task box: /log + Enter opens the log at once
			view.handleInput("\x1b"); // close the peek
			const input = (view as unknown as { input: { autocompleteOpen(): boolean } }).input;
			type(view, "/log");
			for (let i = 0; i < 100 && !input.autocompleteOpen(); i++) await sleep(5);
			expect(input.autocompleteOpen()).toBe(true);
			view.handleInput("\r");
			expect(await screenWith(view, "Log · what happened lately")).toContain("Log · what happened lately");
			expect(client.requests.filter((r) => r.op === "dispatch")).toHaveLength(0);
			view.handleInput("\x1b");
			// wide, then narrow: the tail and the task are cut to the width each time
			view.handleInput(" ");
			expect(view.render(120).some((l) => visibleWidth(l) > 100)).toBe(true);
			for (const l of view.render(60)) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
			type(view, "/transcript");
			expect(await open()).toBe(true);
			view.handleInput("\r");
			await screenWith(view, "Transcript · tests");
			expect(view.render(120).some((l) => visibleWidth(l) > 100)).toBe(true);
			for (const l of view.render(60)) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("M61: a session's own slash commands in its peek", () => {
	const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const screenWith = async (view: AgentView, text: string): Promise<string> => {
		let screen = "";
		for (let i = 0; i < 200; i++) {
			screen = view.render(120).join("\n");
			if (screen.includes(text)) return screen;
			await sleepMs(5);
		}
		return screen;
	};
	/** A fake host: records the control calls; `status` says whether someone is attached. */
	function fakeHost(attached = false) {
		const calls: { id: string; op: string; extra?: unknown }[] = [];
		const fn = async (id: string, op: string, _timeout?: number, extra?: unknown) => {
			calls.push({ id, op, ...(extra ? { extra } : {}) });
			if (op === "status") return { attached };
			if (op === "snapshot") return { text: "Session Info\n  Messages: 3" };
			return { ok: true };
		};
		return { calls, fn: fn as never };
	}
	const commands = [
		{ name: "deploy", description: "ship it", source: "extension" as const },
		{ name: "skill:lint", description: "lint things", source: "skill" as const },
		{ name: "review", description: "review code", source: "prompt" as const },
		{ name: "tree", description: "clashes with a built-in", source: "extension" as const },
	];
	const menu = (view: AgentView) => (view as unknown as { peekCommands(): { name: string; description?: string }[] }).peekCommands();
	const make = (r: JobRow, host = fakeHost(), extra: Partial<AgentViewOptions> = {}) => {
		const s = setup([r], { extra: { hostControl: host.fn, sessionCommands: () => commands, profileCommands: (p) => (p === "mine" ? [{ name: "init", description: "set up" }] : []), ...extra } });
		return { ...s, host };
	};
	const send = async (view: AgentView, text: string, says: string) => {
		view.handleInput("\x03");
		type(view, text);
		view.handleInput("\r");
		return screenWith(view, says);
	};

	it("the menu has the groups in order with tags, no duplicates, and marks for a row that is not running or is working", async () => {
		const { view } = make(row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }));
		await view.start();
		view.handleInput(" ");
		const m = menu(view);
		const tag = (c: { description?: string }) => c.description!.split(" · ")[0];
		const names = m.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
		const groups = m.map(tag).filter((t, i, a) => a.indexOf(t) === i);
		expect(groups).toEqual(["hub", "pi", "extension", "skill", "prompt"]);
		expect(m.find((c) => c.name === "stop")!.description).toBe("hub · stop it");
		expect(m.find((c) => c.name === "session")!.description).toBe("pi · Show session info and stats");
		expect(m.find((c) => c.name === "model")!.description).toMatch(/^hub · /);
		expect(m.find((c) => c.name === "deploy")!.description).toBe("extension · ship it");
		// pi's /tree wins over an extension command of the same name
		expect(m.find((c) => c.name === "tree")!.description).toMatch(/^pi · /);
		view.handleInput("\x1b");
		// working: pi's built-ins are for when it is idle
		const w = make(row({ id: "p2", name: "busy" }));
		await w.view.start();
		w.view.handleInput(" ");
		expect(menu(w.view).find((c) => c.name === "session")!.description).toBe("pi · Show session info and stats (when idle)");
		// not running
		const g = make(row({ id: "p3", name: "gone", state: "stopped", status: null, pid: null }));
		await g.view.start();
		g.view.handleInput(" ");
		expect(menu(g.view).find((c) => c.name === "session")!.description).toBe("pi · Show session info and stats (not running)");
		expect(menu(g.view).find((c) => c.name === "stop")!.description).toBe("hub · stop it (not running)");
	});

	it("/session on an idle row types it, then reads the screen into an overlay; /tree types it, then attaches", async () => {
		const { view, host } = make(row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "question", question: "?" }));
		await view.start();
		view.handleInput(" ");
		const screen = await send(view, "/session", "Session Info");
		expect(screen).toContain("session · tests");
		expect(screen).toContain("Messages: 3");
		expect(host.calls.map((c) => c.op)).toEqual(["status", "command", "snapshot"]);
		expect(host.calls[1]).toEqual({ id: "p1", op: "command", extra: { text: "/session" } });
		view.handleInput("\x1b");
		// a picker: typed in, then attached
		const attached: string[] = [];
		(view as unknown as { attachTo: (id: string) => Promise<void> }).attachTo = async (id) => void attached.push(id);
		host.calls.length = 0;
		await send(view, "/tree", "");
		await sleepMs(30);
		expect(host.calls.map((c) => c.op)).toEqual(["status", "command"]);
		expect(host.calls[1]!.extra).toEqual({ text: "/tree" });
		expect(attached).toEqual(["p1"]);
	});

	it("words after a built-in that takes none are refused (pi would send them to the model); one that needs them says so; an argument goes along", async () => {
		const { view, host } = make(row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }));
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/tree foo", "/tree takes no arguments")).toContain("/tree takes no arguments");
		expect(await send(view, "/import", "/import needs")).toContain("/import needs");
		expect(host.calls).toEqual([]);
		await send(view, "/Export out.html", "Session Info");
		expect(host.calls.find((c) => c.op === "command")!.extra).toEqual({ text: "/export out.html" });
	});

	it("a session without a host pi-roost runs (a foreground pi) is told so, not a socket error", async () => {
		const gone = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
		const { view } = make(row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }), { calls: [], fn: (async () => Promise.reject(gone)) as never });
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/session", "has no terminal")).toContain("has no terminal pi-roost hosts");
	});

	it("/quit needs a second /quit within 2 s", async () => {
		const { view, host } = make(row({ id: "p1", name: "tests", state: "blocked", status: "waiting", waitingFor: "first-prompt" }));
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/quit", "/quit again within 2 s to end tests")).toContain("/quit again within 2 s");
		expect(host.calls.some((c) => c.op === "command")).toBe(false);
		await send(view, "/quit", "/quit · tests");
		expect(host.calls.filter((c) => c.op === "command").map((c) => c.extra)).toEqual([{ text: "/quit" }]);
	});

	it("refuses for a working row, a dialog, an attached row, a row not running and a profile row", async () => {
		const typed = (h: ReturnType<typeof fakeHost>) => h.calls.some((c) => c.op === "command");
		const working = make(row({ id: "w", name: "busy" }));
		await working.view.start();
		working.view.handleInput(" ");
		expect(await send(working.view, "/session", "works when it is idle")).toContain("busy is working");
		expect(typed(working.host)).toBe(false);
		const dialog = make(row({ id: "d", name: "ask", state: "blocked", status: "waiting", waitingFor: "dialog" }));
		await dialog.view.start();
		dialog.view.handleInput(" ");
		expect(await send(dialog.view, "/session", "in a dialog")).toContain("ask is in a dialog");
		const there = make(row({ id: "a", name: "mine", state: "blocked", status: "waiting", waitingFor: "first-prompt" }), fakeHost(true));
		await there.view.start();
		there.view.handleInput(" ");
		expect(await send(there.view, "/session", "attached elsewhere")).toContain("mine is attached elsewhere");
		expect(typed(there.host)).toBe(false);
		const gone = make(row({ id: "g", name: "gone", state: "stopped", status: null, pid: null }));
		await gone.view.start();
		gone.view.handleInput(" ");
		expect(await send(gone.view, "/session", "is not running")).toContain("gone is not running");
		expect(gone.host.calls).toEqual([]);
		// a terminal agent's row: the command goes to it as a reply, never typed by the hub
		const agent = make(row({ id: "t", name: "agent", kind: "shell", profile: "mine" }));
		await agent.view.start();
		agent.view.handleInput(" ");
		await send(agent.view, "/session", "");
		await sleepMs(20);
		expect(agent.host.calls).toEqual([]);
		expect(agent.client.requests.filter((r) => r.op === "reply").map((r) => (r.args as { text: string }).text)).toEqual(["/session"]);
	});

	it("an extension command goes as a reply and says so; a profile's declared command is listed and sent as a reply", async () => {
		const { view, client } = make(row({ id: "p1", name: "tests" }));
		await view.start();
		view.handleInput(" ");
		expect(await send(view, "/deploy now", "/deploy · tests")).toContain("/deploy · tests");
		expect(client.requests.filter((r) => r.op === "reply").at(-1)!.args).toEqual({ id: "p1", text: "/deploy now", mode: "steer" });
		const a = make(row({ id: "t", name: "agent", kind: "shell", profile: "mine" }));
		await a.view.start();
		a.view.handleInput(" ");
		const m = menu(a.view);
		expect(m.find((c) => c.name === "init")!.description).toBe("mine · set up");
		expect(m.some((c) => c.name === "session")).toBe(false);
		expect(m.some((c) => c.name === "stop")).toBe(true);
		expect(await send(a.view, "/init x", "/init · agent")).toContain("/init · agent");
		expect(a.client.requests.filter((r) => r.op === "reply").at(-1)!.args).toEqual({ id: "t", text: "/init x", mode: "steer" });
	});
});

describe("M57: the workspace overlay", () => {
	const sha = "a".repeat(40);
	const task = (id: number, title: string, extra: Partial<BoardTask> = {}): BoardTask => ({ id, title, detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: 1, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: "/r", waiting: [], ...extra });
	const ws = (stage: string, extra: object = {}) => ({ path: `/r/.pi/worktrees/x-${stage}`, branch: `roost/t-${stage}`, baseRef: "main", baseSha: sha, stage, note: null, ...extra }) as never;
	const changes = (async () => ({ files: [{ status: "M", path: "db/schema.sql", add: 12, del: 1 }, { status: "A", path: "db/0004_users.sql", add: 40, del: 0 }], insertions: 52, deletions: 1, commits: 2, dirty: false })) as never;
	const board = () => [
		task(5, "login page", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("working") }),
		task(4, "users migration", { state: "claimed", owner: { id: "w1", name: "lint" }, workspace: ws("review", { note: "verified: npm test (3s)" }) }),
		task(6, "rate limiter", { workspace: ws("conflict", { note: "conflict in src/rate.ts" }) }),
		task(9, "audit log", { after: [4] }),
	];

	it("/workspaces lists the pipeline (review first), the selected one's detail beside it; Ctrl+N goes to the next that needs you", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint", state: "working" })], { extra: { taskChanges: changes } });
		client.tasks = board();
		await view.start();
		type(view, "/workspaces");
		view.handleInput("\r");
		await sleep(30);
		const out = view.render(120).join("\n");
		expect(out).toContain("all projects · workspaces");
		expect(out.indexOf("REVIEW")).toBeLessThan(out.indexOf("CONFLICT · FAILED"));
		expect(out.indexOf("CONFLICT · FAILED")).toBeLessThan(out.indexOf("WORKING"));
		expect(out).toContain("▶ ◆ #4 users migration");
		expect(out).toContain("+52 −1");
		expect(out).toContain("#9 audit log · after #4");
		// the detail: branch, agent, change, files
		expect(out).toContain("roost/t-review (base main)");
		expect(out).toContain("2 files +52 −1 · 2 commits");
		expect(out).toContain("db/0004_users.sql");
		expect(out).toContain("m merge · b back · v verify");
		// n: the next that needs you (the conflict), then back round to the review
		view.handleInput("n");
		expect(view.render(120).join("\n")).toContain("▶ ✕ #6 rate limiter");
		view.handleInput("n");
		expect(view.render(120).join("\n")).toContain("▶ ◆ #4 users migration");
		view.handleInput("\x1b");
		expect(view.render(120).join("\n")).not.toContain("· workspaces");
		// Ctrl+N from the list opens it at the first that needs you
		view.handleInput("\x0e");
		await sleep(30);
		expect(view.render(120).join("\n")).toContain("▶ ◆ #4 users migration");
	});

	it("the keys act on the selected task: m merges, b sends back with a note, s starts an open one; keys a stage has not do nothing", async () => {
		const fake = (() => ({ path: "/r/.pi/worktrees/t9-audit-ab12", branch: "roost/t9-audit-ab12", repo: "/r", base: sha, baseRef: "main", cwd: "/r/.pi/worktrees/t9-audit-ab12", sourceDirty: false, included: [] })) as never;
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { taskChanges: changes, createTaskWorktree: fake, taskMerge: "ff" } });
		client.tasks = board();
		await view.start();
		view.handleInput("\x0e");
		await sleep(30);
		const acts = () => client.requests.filter((r) => r.op === "task" && (r.args as { action: string }).action !== "list").map((r) => r.args);
		// p (pass) is for a failed task only
		view.handleInput("p");
		await sleep(10);
		expect(acts()).toEqual([]);
		view.handleInput("m");
		await sleep(30);
		expect(acts()).toContainEqual({ action: "merge", id: 4, mode: "ff" });
		view.handleInput("b");
		for (const ch of "use a transaction") view.handleInput(ch);
		expect(view.render(120).join("\n")).toContain("#4 back › use a transaction");
		view.handleInput("\r");
		await sleep(30);
		expect(acts()).toContainEqual({ action: "back", id: 4, note: "use a transaction" });
		// the open task at the end: s starts it in its worktree
		view.handleInput("\x1b[F");
		expect(view.render(120).join("\n")).toContain("▶ · #9 audit log");
		view.handleInput("s");
		await sleep(30);
		expect(acts().some((a) => (a as { action: string; id: number }).action === "start" && (a as { id: number }).id === 9)).toBe(true);
	});

	it("a shows the commands in full and approves on y only, with the shown hash; a note goes to the task it was written for", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { taskChanges: changes } });
		client.tasks = board();
		await view.start();
		view.handleInput("\x0e");
		await sleep(30);
		const acts = () => client.requests.filter((r) => r.op === "task" && (r.args as { action: string }).action !== "list").map((r) => r.args);
		view.handleInput("a");
		await sleep(20);
		expect(view.render(120).join("\n")).toContain("approve for #4: verify: npm test · they run in your account");
		// a second a is not a yes
		view.handleInput("a");
		await sleep(20);
		expect(acts()).toEqual([{ action: "approve", id: 4, dry: true }]);
		view.handleInput("a");
		await sleep(20);
		view.handleInput("y");
		await sleep(20);
		expect(acts()).toContainEqual({ action: "approve", id: 4, hash: "h1" });
		// b on #4, then the selection moves (a reload): the note still goes to #4
		view.handleInput("b");
		for (const ch of "fix it") view.handleInput(ch);
		client.tasks = client.tasks.filter((t) => t.id !== 4);
		client.tasks.push(task(4, "users migration", { workspace: ws("review") }));
		view.handleInput("\r");
		await sleep(30);
		expect(acts()).toContainEqual({ action: "back", id: 4, note: "fix it" });
	});

	it("no line is wider than the terminal", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { taskChanges: changes } });
		client.tasks = board();
		await view.start();
		view.handleInput("\x0e");
		await sleep(30);
		for (const w of [8, 12, 20, 40, 99, 100, 120]) for (const l of view.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
	});

	it("under 100 columns the detail goes below the list", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint" })], { extra: { taskChanges: changes } });
		client.tasks = board();
		await view.start();
		type(view, "/ws");
		view.handleInput("\r");
		await sleep(30);
		const lines = view.render(80);
		const at = (s: string) => lines.findIndex((l) => l.includes(s));
		expect(at("roost/t-review (base main)")).toBeGreaterThan(at("#9 audit log"));
		expect(lines.every((l) => !l.includes("│"))).toBe(true);
	});

	it("the header says Ctrl+N while tasks are in workspaces", async () => {
		const { view, client } = setup([row({ id: "w1", name: "lint" })]);
		client.tasks = board();
		await view.start();
		expect(view.render(120).join("\n")).toContain("Ctrl+N workspaces");
	});
});
