import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dispatched: Record<string, unknown>[] = [];
vi.mock("../lib/client.ts", () => ({
	DaemonClient: {
		connectOrStart: async () => ({
			request: async (_op: string, args: Record<string, unknown>) => {
				dispatched.push(args);
				return { id: "job1" };
			},
			close() {},
		}),
		connect: async () => {
			throw new Error("no daemon");
		},
	},
}));
const opened: unknown[] = [];
vi.mock("../extensions/open-view.ts", () => ({
	agentViewOpen: () => false,
	agentViewOpens: () => 0,
	openAgentView: async (_ctx: unknown, opts: unknown) => {
		opened.push(opts);
	},
}));

const { registerForeground, footerText, isPromptEditor } = await import("../extensions/foreground.ts");

type Handler = (event: any, ctx?: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerCommand: (name: string, c: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, c.handler),
		getFlag: () => undefined,
	};
	const emit = (name: string, event: any = {}, ctx?: any) => {
		for (const h of handlers.get(name) ?? []) h(event, ctx);
	};
	const emitAsync = async (name: string, event: any = {}, ctx?: any) => {
		for (const h of handlers.get(name) ?? []) await h(event, ctx);
	};
	return { pi: pi as any, emit, emitAsync, commands };
}

const editor = { getText: () => "", setText() {}, onSubmit: () => {} };
const selector = { handleInput() {}, render: () => [] };

let sessionFile = "";
let selectAnswer: (options: string[]) => string | undefined = () => undefined;
function fakeCtx(file = sessionFile) {
	let stale = false;
	let editorText = "";
	let focused: unknown = editor;
	let inputs: ((data: string) => any)[] = [];
	const notes: string[] = [];
	const ui = {
		select: async (_title: string, options: string[]) => selectAnswer(options),
		notify: (t: string) => notes.push(t),
		setStatus() {},
		setWidget(_k: string, f: (tui: any) => unknown) {
			f({ getFocusedComponent: () => focused });
		},
		onTerminalInput(fn: (d: string) => any) {
			inputs.push(fn);
			return () => {
				inputs = inputs.filter((x) => x !== fn);
			};
		},
		getEditorText: () => editorText,
		setEditorText: (t: string) => {
			editorText = t;
		},
	};
	const calls = { abort: 0, newSession: 0, switches: [] as string[], shutdown: 0 };
	const ctx = {
		hasUI: true,
		cwd: "/work",
		get ui() {
			if (stale) throw new Error("ctx is stale");
			return ui;
		},
		sessionManager: { getSessionFile: () => file, getSessionName: () => "my chat", getBranch: () => [] },
		abort: (): void => {
			calls.abort++;
		},
		waitForIdle: async () => {},
		shutdown: () => {
			calls.shutdown++;
		},
		switchSession: async (path: string, opts?: { withSession?: (next: any) => Promise<void> }) => {
			calls.switches.push(path);
			stale = true;
			const next = { ui, switchSession: async (p: string) => calls.switches.push(p), newSession: async () => calls.newSession++ };
			await opts?.withSession?.(next);
			return { cancelled: false };
		},
	};
	return {
		ctx,
		calls,
		notes,
		// like pi: listeners in order, the first answer wins
		press: (data: string) => {
			for (const fn of inputs) {
				const r = fn(data);
				if (r !== undefined) return r;
			}
			return undefined;
		},
		focus: (c: unknown) => {
			focused = c;
		},
		type: (t: string) => {
			editorText = t;
		},
		get editorText() {
			return editorText;
		},
	};
}

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fg-"));
	process.env.PI_ROOST_HOME = home;
	process.env.PI_ROOST_CONFIG_DIR = home;
	sessionFile = join(home, "s.jsonl");
	writeFileSync(sessionFile, "{}\n");
	dispatched.length = 0;
	opened.length = 0;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	delete process.env.PI_ROOST_HOME;
	delete process.env.PI_ROOST_CONFIG_DIR;
	vi.useRealTimers();
});

const LEFT = "\x1b[D";

describe("← on the prompt", () => {
	it("submits /bg only from an empty, focused prompt editor", () => {
		const { pi, emit } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		f.type("draft");
		expect(f.press(LEFT)).toBeUndefined();
		f.type("");
		f.focus(selector); // /model, /tree, … took the editor's place
		expect(f.press(LEFT)).toBeUndefined();
		f.focus(editor);
		expect(f.press(LEFT)).toEqual({ data: "\r" });
		expect(f.editorText).toBe("/bg");
		// a second ← before the command runs is swallowed, not a second /bg
		f.type("");
		expect(f.press(LEFT)).toEqual({ consume: true });
	});

	it("tells the prompt editor from selectors", () => {
		expect(isPromptEditor(editor as never)).toBe(true);
		expect(isPromptEditor(selector as never)).toBe(false);
		expect(isPromptEditor(null)).toBe(false);
	});
});

describe("/bg", () => {
	it("adopts the file, opens the view, starts a fresh session and never touches the stale ctx", async () => {
		const { pi, emit, commands } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		await expect(commands.get("bg")!("", f.ctx)).resolves.toBeUndefined();
		expect(dispatched[0]).toMatchObject({ sessionFile, origin: "adopt", name: "my chat" });
		expect(opened).toEqual([{ origin: "job1", banner: "Your conversation moved to the background" }]);
		expect(f.calls.switches[0]).toMatch(/scratch/);
		// then a fresh conversation next to the moved one, not in the scratch directory
		expect(f.calls.switches[1]?.startsWith(`${home}/`)).toBe(true);
		expect(f.calls.switches[1]).not.toMatch(/scratch/);
	});

	it("interrupts a running turn after its tool and continues in the worker", async () => {
		const { pi, emit, commands } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		emit("agent_start");
		emit("tool_execution_start", {});
		const moved = commands.get("bg")!("then run the tests", f.ctx);
		await new Promise((r) => setTimeout(r, 20));
		expect(f.calls.abort).toBe(0); // still waiting for the tool
		emit("tool_execution_end", {});
		f.ctx.abort = () => {
			f.calls.abort++;
			emit("agent_settled", { aborted: true });
		};
		await moved;
		expect(f.calls.abort).toBe(1);
		expect(dispatched[0]?.command).toContain("Continue where you left off.\n\nthen run the tests");
	});

	it("keeps the conversation when the user stops the turn", async () => {
		const { pi, emit, commands } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_start", {}, f.ctx);
		emit("agent_start");
		emit("tool_execution_start", {});
		const moved = commands.get("bg")!("", f.ctx);
		emit("tool_execution_end", {});
		emit("agent_settled", { aborted: true });
		await moved;
		expect(f.calls.switches).toEqual([]);
		expect(f.notes.join()).toMatch(/you stopped the turn/);
	});

	it("refuses during compaction, in a hand-off session and without a session file", async () => {
		const { pi, emit, commands } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_before_compact");
		await commands.get("bg")!("", f.ctx);
		emit("session_compact");
		await commands.get("bg")!("", fakeCtx(join(home, "scratch", "x.jsonl")).ctx);
		const none = fakeCtx();
		none.ctx.sessionManager.getSessionFile = () => undefined as never;
		await commands.get("bg")!("", none.ctx);
		expect(f.notes.join()).toMatch(/compacted/);
		expect(none.notes.join()).toMatch(/not saved/);
		expect(dispatched).toEqual([]);
	});
});

it("opens the agent view for a conversation pi has not written yet", async () => {
	const { pi, emit, commands } = fakePi();
	registerForeground(pi);
	const f = fakeCtx(join(home, "unwritten.jsonl"));
	emit("session_start", {}, f.ctx);
	await commands.get("bg")!("", f.ctx);
	expect(opened).toEqual([undefined]);
	expect(f.calls.switches).toEqual([]);
	expect(dispatched).toEqual([]);
});

describe("footerText", () => {
	it("counts waiting jobs first, then completions the user has not seen", () => {
		expect(footerText("←", { waiting: 2, done: 1 }, 0)).toBe("← 2 agents");
		expect(footerText("←", { waiting: 0, done: 3 }, 1)).toBe("← 2 done");
		expect(footerText("←", { waiting: 0, done: 1 }, 1)).toBeUndefined();
	});
});

describe("BG-9 quit while busy", () => {
	it("Ctrl+D during a turn offers to move it; the daemon adopts the file after pi lets go", async () => {
		const { pi, emit, emitAsync } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_start", { reason: "resume" }, f.ctx);
		emit("agent_start");
		selectAnswer = (o) => o[0]; // Move to background and exit
		f.ctx.abort = () => {
			f.calls.abort++;
			emit("agent_settled", { aborted: true });
		};
		expect(f.press("\x04")).toEqual({ consume: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(f.calls.abort).toBe(1);
		expect(f.calls.shutdown).toBe(1);
		await emitAsync("session_shutdown", { reason: "quit" });
		expect(dispatched.at(-1)).toMatchObject({ sessionFile, origin: "adopt", name: "my chat" });
		expect((dispatched.at(-1) as { command: string[] }).command.at(-1)).toBe("Continue where you left off.");
	});

	it("does nothing special when idle or on Cancel", async () => {
		const { pi, emit } = fakePi();
		registerForeground(pi);
		const f = fakeCtx();
		emit("session_start", { reason: "resume" }, f.ctx);
		expect(f.press("\x04")).toBeUndefined(); // idle: pi's own Ctrl+D
		emit("agent_start");
		selectAnswer = () => "Cancel";
		expect(f.press("\x04")).toEqual({ consume: true });
		await new Promise((r) => setTimeout(r, 20));
		expect(f.calls.shutdown).toBe(0);
	});
});
