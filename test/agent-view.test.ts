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
		if (op === "reply") return { delivered: true, saved: false };
		if (op === "pin") return { id: (args as { id: string }).id, pinned: (args as { pinned: boolean }).pinned };
		return {};
	}
}

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const launches: { task: string; opts: unknown }[] = [];
function setup(rows: JobRow[], opts: { rowsHigh?: number; onGroupBy?: (g: string) => void } = {}) {
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
	});
	return { view, client, renders: () => renders, done: () => doneCalls };
}

const type = (view: AgentView, text: string) => {
	for (const ch of text) view.handleInput(ch);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AgentView render", () => {
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

describe("Ctrl+G", () => {
	it("writes the task in $EDITOR and dispatches all of its lines", async () => {
		launches.length = 0;
		const saved = { v: process.env.VISUAL, e: process.env.EDITOR };
		process.env.VISUAL = `sh -c 'printf "first line\\nsecond line\\n" > "$0"'`;
		const { view } = setup([row()]);
		await view.start();
		view.handleInput("\x07"); // Ctrl+G
		await sleep(300);
		expect(view.render(80).join("\n")).toContain("first line [+1 lines]");
		view.handleInput("\r");
		await sleep(20);
		expect(launches.at(-1)?.task).toBe("first line\nsecond line");
		view.dispose();
		if (saved.v === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = saved.v;
	});
});
