import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, parseKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { attachToHost, type DetachReason } from "../lib/attach.ts";
import { DaemonClient } from "../lib/client.ts";
import { hostSocketPath } from "../lib/paths.ts";
import { atCandidates, atPrefix, parseInput, THINKING_LEVELS } from "../lib/dispatch-input.ts";
import { type Filter, parseFilter } from "../lib/filter.ts";
import { forgetJob, observeJob } from "../lib/job-events.ts";
import { ensureLive } from "../lib/resume.ts";
import { cleanupText } from "../lib/worktree.ts";
import { refusedByDaemon } from "../lib/dispatch.ts";
import type { DispatchArgs, Event, JobRow } from "../lib/protocol.ts";
import {
	ageOf,
	counts,
	formatDuration,
	headerText,
	iconOf,
	modelFacts,
	rowDetailsOf,
	shortModel,
	type Item,
	items,
	layout,
	listed,
	nameToneOf,
	type Section,
	sentenceOf,
	titleText,
	type Tone,
} from "../lib/view-model.ts";

const MIN_TASK = 4; // DI-1
const DOUBLE_PRESS_MS = 2000; // Ctrl+X delete, Ctrl+C exit
const RESTART_ASK_MS = 3000;
const NOTICE_MS = 4000;
const SPIN_MS = 150;
/** M8: the row's model and context column only shows while the summary keeps this many columns. */
const MIN_SUMMARY = 24;
const MODEL_COL = 20;
/** M8: how long a sent /model or /thinking may take to show in the session's reports. */
const SWITCH_CHECK_MS = 8000;

export interface AgentViewOptions {
	tui: TUI;
	theme: Theme;
	/** Directory new jobs start in. */
	cwd: string;
	/** AV-7: show only jobs started under this directory. */
	cwdFilter?: string;
	/** Builds the dispatch request for a task typed into the view. */
	/** A new pi job; the view adds its /model and /thinking defaults and @dir target. */
	launch: (task: string, opts?: LaunchOptions) => LaunchRequest;
	/** DI-6: a shell job (no model). */
	launchShell?: (command: string, cwd: string) => DispatchArgs;
	/** Slash commands of this pi (DI-4, DI-5: skills and prompt templates become first prompts). */
	commands?: () => { name: string; source: string }[];
	/** M10: new sessions get a worktree unless /worktree off (config worktreeIsolation "all"). */
	worktreeDefault?: boolean;
	/** DI-4: models for the /model picker, as "provider/id". */
	models?: () => string[];
	/** DI-4: past sessions of a directory for /resume. */
	resumable?: (cwd: string) => Promise<Resumable[]>;
	setTitle: (title: string) => void;
	/** Daemon connection; tests pass a fake. */
	connect?: () => Promise<DaemonClient>;
	/** AV-K6: initial grouping and where a change is persisted. */
	groupBy?: "state" | "directory";
	onGroupBy?: (groupBy: "state" | "directory") => void;
	/** NT-1: a job needs input or finished while the view is on screen. */
	notify?: (row: JobRow, kind: "needs_input" | "completed") => void;
	/** AV-9: a row to keep bold (the conversation just moved to the background). */
	highlightId?: string;
	/** BG-5: Esc goes back into this job (the conversation that just moved) instead of leaving. */
	origin?: string;
	/** Shown above the list until the user returns to the origin. */
	banner?: string;
	/** Screen-reader mode: no animation (PRD accessibility). */
	reducedMotion?: boolean;
	/** Render exactly the terminal's height: list at the top, input and keys at the bottom. */
	fullscreen?: boolean;
	/** M8: show each row's model and context window use (default true). */
	rowDetails?: boolean;
	/** M13: subagents a session spawns are not rows (Claude Code), or are (inline). */
	subagents?: "hide" | "inline";
	/** M8: how long a /model or /thinking switch may take to show (tests shorten it). */
	switchCheckMs?: number;
	done: () => void;
}

/** A dispatch request, plus (M10) how to undo its worktree and what to tell the user. */
export type LaunchRequest = DispatchArgs & { discard?: () => void; note?: string };

export interface LaunchOptions {
	cwd?: string;
	model?: string;
	thinking?: string;
	/** M10: in its own git worktree (undefined: the user's default). */
	worktree?: boolean;
	/** /resume: run this existing session instead of a new one. */
	sessionFile?: string;
	name?: string;
	origin?: "dispatch" | "adopt";
}

export interface Resumable {
	path: string;
	name: string;
	cwd: string;
	modified: number;
}

interface Picker {
	title: string;
	items: { label: string; value: string }[];
	index: number;
	pick: (value: string) => void | Promise<void>;
}

interface Columns {
	mode: "full" | "share" | "none";
	modelW: number;
	shareW: number;
	ageW: number;
}

interface Switch {
	which: "model" | "thinking";
	value: string;
	before: string | null;
	/** Pending switches this one replaced: a report showing one of them is not the outcome. */
	superseded: string[];
	timer: NodeJS.Timeout;
}

const switchKey = (id: string, which: "model" | "thinking") => `${id}:${which}`;

interface Notice {
	text: string;
	tone: Tone;
	until: number;
}

/** The agent view (PRD §6.1–6.5) as one focused pi-tui component. */
export class AgentView implements Component {
	private o: AgentViewOptions;
	private client: DaemonClient | undefined;
	/** DM-7: a failed or stopped session restarts on a second Enter. */
	private restartAsk: { id: string; at: number } | undefined;
	private rows = new Map<string, JobRow>();
	private collapsed = new Set<Section["key"]>();
	private cursor: { kind: "row"; id: string } | { kind: "header"; key: Section["key"] } | undefined;
	private peek = false;
	private help = false;
	private input = new Input({ prompt: "› ", placeholder: "describe a task and press Enter to start it in the background" });
	private reply = new Input({ prompt: "reply › " });
	/** AV-K10: the row being renamed, edited in its own input. */
	private renaming: string | undefined;
	private renameInput = new Input({ prompt: "rename › " });
	private groupBy: "state" | "directory" = "state";
	/** Ctrl+G: a multi-line task from $EDITOR, shown in the input as its first line. */
	private longTask: { text: string; shown: string } | undefined;
	/** DI-4: defaults for the next dispatches. */
	private model: string | undefined;
	private thinking: string | undefined;
	/** M10: /worktree for the next dispatches (undefined: the user's default). */
	private worktree: boolean | undefined;
	private picker: Picker | undefined;
	private notice: Notice | undefined;
	private armedStop: { id: string; at: number } | undefined;
	private ctrlCAt = 0;
	private frame = 0;
	private spinner: NodeJS.Timeout | undefined;
	private attached = false;
	private closed = false;
	private connectError: string | undefined;
	private nameWidth = 16;
	/** M8: the model / context column, the same for every row of a render so it lines up. */
	private columns: Columns = { mode: "none", modelW: 0, shareW: 0, ageW: 0 };
	/** M8: switches sent to live sessions, until their reports show them (or do not). */
	private switches = new Map<string, Switch>();
	private dispatching = false;
	/** The job a reply is typed for; replies never retarget to another row. */
	private peekId: string | undefined;

	private origin: string | undefined;
	/** Esc/Enter came before the moved conversation's worker was up: attach once it is. */
	private attachWhenLive: string | undefined;

	constructor(o: AgentViewOptions) {
		this.o = o;
		this.origin = o.origin;
		this.groupBy = o.groupBy ?? "state";
		if (o.origin) this.cursor = { kind: "row", id: o.origin };
		this.input.focused = true;
	}

	// ---- lifecycle -------------------------------------------------------

	async start(): Promise<void> {
		this.spinner = setInterval(() => {
			if (this.closed || this.attached || this.o.reducedMotion) return;
			const busy = [...this.rows.values()].some((r) => r.pid !== null && r.status === "busy");
			if (busy || this.notice) {
				this.frame++;
				this.o.tui.requestRender();
			}
		}, SPIN_MS);
		this.spinner.unref?.();
		await this.connect();
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.spinner);
		for (const s of this.switches.values()) clearTimeout(s.timer);
		this.switches.clear();
		this.client?.close();
		this.client = undefined;
		this.o.setTitle("pi");
	}

	private async connect(): Promise<void> {
		if (this.closed) return;
		let client: DaemonClient | undefined;
		try {
			client = await (this.o.connect ?? (() => DaemonClient.connectOrStart()))();
			if (this.closed) return client.close();
			client.onEvent((e) => this.onEvent(e));
			await client.request("subscribe", {});
			const { jobs } = await client.request("list", this.o.cwdFilter ? { cwd: this.o.cwdFilter } : {});
			if (this.closed) return client.close();
			this.rows = new Map(jobs.map((j) => [j.id, j]));
			for (const j of jobs) observeJob(j); // what is already there is not news
			for (const j of jobs) this.checkSwitch(j); // a switch shown while we were away
			this.client = client;
			this.connectError = undefined;
			// AV-8: pushed events only; reconnect when the daemon goes away.
			const live = client;
			client.onClose(() => {
				if (this.client !== live) return;
				this.client = undefined;
				this.connectError = "reconnecting…";
				this.render0();
				setTimeout(() => void this.connect(), 500).unref?.();
			});
		} catch (err) {
			client?.close();
			if (this.closed) return;
			this.connectError = (err as Error).message;
			setTimeout(() => void this.connect(), 2000).unref?.();
		}
		this.render0();
	}

	private onEvent(e: Event): void {
		if (e.event === "job") {
			if (this.o.cwdFilter && !within(e.job.cwd, this.o.cwdFilter)) return;
			this.rows.set(e.job.id, e.job);
			this.checkSwitch(e.job);
			const kind = observeJob(e.job);
			// M13: a subagent tells its own session, not the agent view
			if (kind && !this.attached && listed(e.job, this.o.subagents)) this.o.notify?.(e.job, kind);
			if (this.attachWhenLive === e.job.id && !this.attached) {
				if (e.job.pid) {
					this.attachWhenLive = undefined;
					void this.attachTo(e.job.id).catch((err: unknown) => this.say(String(err), "error"));
				} else if (e.job.endedAt !== null) this.attachWhenLive = undefined;
			}
		} else if (e.event === "removed") {
			this.rows.delete(e.id);
			forgetJob(e.id);
		}
		this.render0();
	}

	private render0(): void {
		// while attached the terminal belongs to the worker: no title or repaint
		if (this.closed || this.attached) return;
		this.o.setTitle(titleText(counts(this.listedRows())));
		this.o.tui.requestRender();
	}

	// ---- model -----------------------------------------------------------

	/** M13: the rows the view lists (subagents live in their session's panel). */
	private listedRows(): JobRow[] {
		return [...this.rows.values()].filter((r) => listed(r, this.o.subagents));
	}

	private sections(): Section[] {
		const height = this.o.tui.terminal.rows || 30;
		return layout(this.listedRows(), {
			collapsed: this.collapsed,
			groupBy: this.groupBy,
			filter: this.filter(),
			// AV-5: keep live groups visible on short terminals
			maxCompleted: Math.max(3, height - 14),
		});
	}

	/** DI-7: the input holds filters (s: n: o:) rather than a task. */
	private filter(): Filter | undefined {
		return this.peek || this.renaming ? undefined : parseFilter(this.input.getValue());
	}

	private itemList(): Item[] {
		return items(this.sections());
	}

	private selectedIndex(list: Item[]): number {
		const c = this.cursor;
		if (c) {
			const i = list.findIndex((it) =>
				c.kind === "row" ? it.kind === "row" && it.row.id === c.id : it.kind === "header" && it.section.key === c.key,
			);
			if (i >= 0) return i;
		}
		const firstRow = list.findIndex((it) => it.kind === "row");
		return firstRow >= 0 ? firstRow : 0;
	}

	private selected(): Item | undefined {
		const list = this.itemList();
		return list[this.selectedIndex(list)];
	}

	private selectedRow(): JobRow | undefined {
		const it = this.selected();
		return it?.kind === "row" ? it.row : undefined;
	}

	private move(delta: number | "home" | "end"): void {
		const list = this.itemList();
		if (list.length === 0) return;
		const cur = this.selectedIndex(list);
		const next = delta === "home" ? 0 : delta === "end" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, cur + delta));
		const it = list[next]!;
		this.cursor = it.kind === "row" ? { kind: "row", id: it.row.id } : { kind: "header", key: it.section.key };
		this.reply.setValue("");
		if (this.peek) {
			// the panel follows the selection (PK: ↑↓ with the panel open)
			this.peekId = it.kind === "row" ? it.row.id : undefined;
			if (!this.peekId) this.closePeek();
		}
	}

	private say(text: string, tone: Tone = "muted"): void {
		this.notice = { text, tone, until: Date.now() + NOTICE_MS };
		this.o.tui.requestRender();
	}

	// ---- input -----------------------------------------------------------

	handleInput(data: string): void {
		if (this.attached) return;
		const key = parseKey(data);
		if (this.help) {
			this.help = false;
			this.o.tui.requestRender();
			return;
		}
		if (this.picker) return this.pickerKey(key);
		if (this.renaming) return this.renameKey(key, data);
		const typing = this.peek ? this.reply : this.input;
		const text = typing.getValue();

		switch (key) {
			case "tab":
				if (!this.peek && this.completeAt()) return;
				break;
			case "ctrl+s":
				return this.toggleGroupBy();
			case "ctrl+t":
				return void this.togglePin();
			case "ctrl+f":
				if (this.peek) break;
				fill(this.input, "n:");
				this.o.tui.requestRender();
				return;
			case "ctrl+r":
				return this.startRename();
			case "ctrl+g":
				if (this.peek) break;
				return void this.editExternally();
			case "alt+up":
				return this.jumpHeader(-1);
			case "alt+down":
				return this.jumpHeader(1);
			case "shift+up":
				return void this.reorder(-1);
			case "shift+down":
				return void this.reorder(1);
			case "up":
				return this.moveAndRender(-1);
			case "down":
				return this.moveAndRender(1);
			case "pageUp":
				return this.moveAndRender(-10);
			case "pageDown":
				return this.moveAndRender(10);
			case "home":
				if (text) break;
				return this.moveAndRender("home");
			case "end":
				if (text) break;
				return this.moveAndRender("end");
			case "right":
				if (text && !this.filter()) break;
				return void this.attachSelected();
			case "escape":
				return this.escape();
			case "ctrl+c":
				return this.ctrlC();
			case "ctrl+x":
				return void this.stopSelected();
			case "ctrl+enter":
				if (!this.peek) return void this.dispatch(true);
				break;
			case "enter":
				return void this.enter();
			case "space":
				if (!text) return this.togglePeek();
				break;
			case "?":
				if (!text) {
					this.help = true;
					this.o.tui.requestRender();
					return;
				}
				break;
		}
		// PK-3: a digit on an empty reply fills the numbered choice
		if (this.peek && !text && key && /^[1-9]$/.test(key)) {
			const choice = this.selectedRow()?.choices[Number(key) - 1];
			if (choice) {
				fill(this.reply, choice);
				this.o.tui.requestRender();
				return;
			}
		}
		// AV-K14: Alt+1…9 attach to row N of the selected row's directory
		const alt = key ? /^alt\+([1-9])$/.exec(key) : null;
		if (alt) return void this.attachNth(Number(alt[1]));
		typing.handleInput(data);
		// DI-7: a filter selects its first match as it is typed
		if (!this.peek && this.filter()) {
			const first = this.itemList().find((it) => it.kind === "row");
			if (first?.kind === "row") this.cursor = { kind: "row", id: first.row.id };
		}
		this.o.tui.requestRender();
	}

	private moveAndRender(delta: number | "home" | "end"): void {
		this.move(delta);
		this.o.tui.requestRender();
	}

	private togglePeek(): void {
		const row = this.selectedRow();
		this.peek = !this.peek && row !== undefined;
		this.peekId = this.peek ? row?.id : undefined;
		// pin the selection to this row so it follows it into another group
		if (row) this.cursor = { kind: "row", id: row.id };
		this.reply.focused = this.peek;
		this.input.focused = !this.peek;
		this.reply.setValue("");
		this.o.tui.requestRender();
	}

	private closePeek(): void {
		this.peek = false;
		this.peekId = undefined;
		this.reply.setValue("");
		this.reply.focused = false;
		this.input.focused = true;
	}

	/** AV-K15: close peek → clear input → exit. */
	private escape(): void {
		if (this.peek) return this.togglePeek();
		if (this.input.getValue()) {
			this.input.setValue("");
			this.o.tui.requestRender();
			return;
		}
		const origin = this.origin;
		if (origin) {
			const row = this.rows.get(origin);
			if (row?.pid) {
				this.origin = undefined; // back here after detaching, Esc leaves
				void this.attachTo(origin).catch((err: unknown) => this.say(String(err), "error"));
				return;
			}
			if (!row || row.endedAt === null) {
				// dispatch answered before the worker's first report reached the view
				this.origin = undefined;
				this.attachWhenLive = origin;
				this.say("Your conversation is starting…", "accent");
				return;
			}
		}
		this.attachWhenLive = undefined;
		this.o.done();
	}

	/** AV-K16: clear input; twice to exit. */
	private ctrlC(): void {
		const typing = this.peek ? this.reply : this.input;
		if (typing.getValue()) {
			typing.setValue("");
			this.ctrlCAt = 0;
			this.o.tui.requestRender();
			return;
		}
		const now = Date.now();
		if (now - this.ctrlCAt < DOUBLE_PRESS_MS) return this.o.done();
		this.ctrlCAt = now;
		this.say("Ctrl+C again to exit (background sessions keep running)");
	}

	private async enter(): Promise<void> {
		if (this.peek) return this.sendReply();
		// AV-K2: filter text is not a task: Enter acts on the selection
		if (this.input.getValue().trim() && !this.filter()) return this.dispatch(false);
		const it = this.selected();
		if (it?.kind === "header") {
			if (this.collapsed.has(it.section.key)) this.collapsed.delete(it.section.key);
			else this.collapsed.add(it.section.key);
			this.o.tui.requestRender();
			return;
		}
		return this.attachSelected();
	}

	/** Ctrl+G: write the task in $VISUAL / $EDITOR (P2 row "Ctrl+G external editor"). */
	private async editExternally(): Promise<void> {
		const editor = process.env.VISUAL || process.env.EDITOR;
		if (!editor) return this.say("set $VISUAL or $EDITOR to edit the task in an editor", "warning");
		const current = this.longTask && this.longTask.shown === this.input.getValue() ? this.longTask.text : this.input.getValue();
		const { tui } = this.o;
		let text: string | undefined;
		let dir: string | undefined;
		let stopped = false;
		try {
			dir = mkdtempSync(join(tmpdir(), "pi-roost-task-"));
			const file = join(dir, "task.md");
			writeFileSync(file, current);
			this.attached = true; // the terminal belongs to the editor
			tui.stop();
			stopped = true;
			// $VISUAL may carry arguments ("code -w"): a shell line, with the file quoted
			const r = spawnSync(`${editor} '${file.replace(/'/g, "'\\''")}'`, { stdio: "inherit", shell: true });
			if (r.status === 0) text = readFileSync(file, "utf8").replace(/\s+$/, "");
		} catch (err) {
			this.say(`could not open the editor: ${(err as Error).message}`, "error");
		} finally {
			this.attached = false;
			if (stopped) {
				tui.start();
				tui.requestRender(true);
			}
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
		if (text === undefined) return this.say("editor exited with an error; task unchanged", "warning");
		const lines = text.split("\n");
		if (lines.length > 1) {
			const shown = `${oneLine(lines[0] ?? "")} [+${lines.length - 1} lines]`;
			this.longTask = { text, shown };
			fill(this.input, shown);
		} else {
			this.longTask = undefined;
			fill(this.input, text);
		}
		this.o.tui.requestRender();
	}

	// ---- in-view commands (DI-4) -----------------------------------------

	/** Returns true when the command was handled here (and the input consumed). */
	private command(name: string, arg: string): boolean {
		const done = () => {
			this.input.setValue("");
			this.o.tui.requestRender();
			return true;
		};
		switch (name) {
			case "exit":
			case "quit":
				this.o.done();
				return true;
			case "model": {
				if (arg) {
					const known = this.o.models?.() ?? [];
					if (arg !== "default" && known.length > 0 && !known.includes(arg)) {
						this.say(`unknown model ${arg} (bare /model lists them)`, "warning");
						return true;
					}
					this.model = arg === "default" ? undefined : arg;
					this.say(this.model ? `new sessions use ${this.model}` : "new sessions use the default model");
					return done();
				}
				const models = this.o.models?.() ?? [];
				this.openPicker("Model for new sessions", ["default", ...models], this.model ?? "default", (v) => {
					this.model = v === "default" ? undefined : v;
					this.say(this.model ? `new sessions use ${this.model}` : "new sessions use the default model");
				});
				return done();
			}
			case "thinking": {
				const levels: string[] = ["default", ...THINKING_LEVELS];
				if (arg) {
					if (!levels.includes(arg)) {
						this.say(`thinking is one of ${levels.join(", ")}`, "warning");
						return true;
					}
					this.thinking = arg === "default" ? undefined : arg;
					this.say(`new sessions think ${this.thinking ?? "at the default level"}`);
					return done();
				}
				this.openPicker("Thinking for new sessions", levels, this.thinking ?? "default", (v) => {
					this.thinking = v === "default" ? undefined : v;
					this.say(`new sessions think ${this.thinking ?? "at the default level"}`);
				});
				return done();
			}
			case "worktree": {
				const v = arg.toLowerCase();
				if (v && !["on", "off", "default"].includes(v)) {
					this.say("/worktree takes on, off or default (bare: toggle)", "warning");
					return true;
				}
				this.worktree = v === "default" ? undefined : v === "on" ? true : v === "off" ? false : !(this.worktree ?? this.o.worktreeDefault === true);
				const on = this.worktree ?? this.o.worktreeDefault === true;
				this.say(on ? "new sessions get their own git worktree" : "new sessions work in the directory itself");
				return done();
			}
			case "resume":
				void this.resumePicker();
				return done();
		}
		const known = this.o.commands?.().find((c) => c.name === name);
		if (known && (known.source === "prompt" || known.source === "skill")) return false;
		this.say(`/${name} isn't available in agent view`, "warning");
		return true; // the text stays in the input
	}

	private openPicker(title: string, values: string[], current: string, pick: (v: string) => void | Promise<void>): void {
		const items = values.map((v) => ({ label: v, value: v }));
		this.picker = { title, items, index: Math.max(0, values.indexOf(current)), pick };
		this.o.tui.requestRender();
	}

	private pickerKey(key: string | undefined): void {
		const p = this.picker!;
		if (key === "escape" || key === "ctrl+c") this.picker = undefined;
		else if (key === "up") p.index = Math.max(0, p.index - 1);
		else if (key === "down") p.index = Math.min(p.items.length - 1, p.index + 1);
		else if (key === "pageUp") p.index = Math.max(0, p.index - 10);
		else if (key === "pageDown") p.index = Math.min(p.items.length - 1, p.index + 10);
		else if (key === "enter") {
			this.picker = undefined;
			const item = p.items[p.index];
			if (item) void Promise.resolve(p.pick(item.value)).catch((err: unknown) => this.say((err as Error).message, "error"));
		}
		this.o.tui.requestRender();
	}

	/** DI-4 /resume: a past session of this directory without a row becomes a job. */
	private async resumePicker(): Promise<void> {
		if (!this.o.resumable) return this.say("/resume is not available here", "warning");
		const cwd = this.dispatchCwd();
		const known = new Set([...this.rows.values()].map((r) => r.sessionFile).filter(Boolean));
		let sessions: Resumable[];
		this.say("loading sessions…");
		try {
			sessions = (await this.o.resumable(cwd)).filter((s) => !known.has(s.path));
		} catch (err) {
			return this.say((err as Error).message, "error");
		}
		if (sessions.length === 0) return this.say("no past sessions to resume here");
		const byPath = new Map(sessions.map((s) => [s.path, s]));
		this.picker = {
			title: "Resume a session in the background",
			items: sessions.slice(0, 200).map((s) => ({ label: `${oneLine(s.name)} · ${formatAgo(Date.now() - s.modified)}`, value: s.path })),
			index: 0,
			pick: async (path) => {
				const s = byPath.get(path)!;
				if (!this.client) return this.say("background service unavailable", "error");
				const args = this.o.launch("", { cwd: s.cwd || cwd, sessionFile: s.path, name: s.name, origin: "adopt" });
				const { id, name } = await this.client.request("dispatch", args);
				this.cursor = { kind: "row", id };
				this.say(`resumed · ${name}`, "success");
			},
		};
		this.o.tui.requestRender();
	}

	/** DI-3: Tab completes the @dir being typed. */
	private completeAt(): boolean {
		const value = this.input.getValue();
		const prefix = atPrefix(value);
		if (prefix === undefined) return false;
		const first = this.atSuggestions(prefix)[0];
		if (!first) return true;
		fill(this.input, `${value.slice(0, value.length - prefix.length)}${first} `);
		this.o.tui.requestRender();
		return true;
	}

	private atCache: { key: string; at: number; list: string[] } | undefined;

	/** Cached briefly: render runs on every key and tick, and this reads directories. */
	private atSuggestions(prefix: string): string[] {
		const base = this.dispatchCwd();
		const key = `${base}\0${prefix}`;
		if (this.atCache && this.atCache.key === key && Date.now() - this.atCache.at < 2000) return this.atCache.list;
		const list = atCandidates(base, [...new Set([...this.rows.values()].map((r) => r.cwd))], prefix);
		this.atCache = { key, at: Date.now(), list };
		return list;
	}

	// ---- organise (AV-K6…K14) --------------------------------------------

	private toggleGroupBy(): void {
		const row = this.selectedRow() ?? this.selected()?.section.rows[0];
		this.groupBy = this.groupBy === "state" ? "directory" : "state";
		this.collapsed.clear();
		this.cursor = row ? { kind: "row", id: row.id } : undefined;
		try {
			this.o.onGroupBy?.(this.groupBy);
		} catch (err) {
			this.say(`could not save the grouping: ${(err as Error).message}`, "warning");
		}
		this.say(this.groupBy === "directory" ? "grouped by directory" : "grouped by state");
	}

	private async togglePin(): Promise<void> {
		const row = this.selectedRow();
		if (!row || !this.client) return;
		try {
			const { pinned } = await this.client.request("pin", { id: row.id, pinned: !row.pinned });
			this.cursor = { kind: "row", id: row.id };
			this.say(pinned ? `pinned · ${row.name} (kept running)` : `unpinned · ${row.name}`);
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private startRename(): void {
		const row = this.selectedRow();
		if (!row) return;
		this.renaming = row.id;
		fill(this.renameInput, row.name);
		this.renameInput.focused = true;
		this.input.focused = false;
		this.o.tui.requestRender();
	}

	private endRename(): void {
		this.renaming = undefined;
		this.renameInput.focused = false;
		this.input.focused = true;
		this.o.tui.requestRender();
	}

	private renameKey(key: string | undefined, data: string): void {
		if (key === "escape" || key === "ctrl+c") return this.endRename();
		if (key === "enter") {
			const id = this.renaming!;
			const name = this.renameInput.getValue().trim();
			this.endRename();
			if (!name || !this.client) return;
			void this.client
				.request("rename", { id, name })
				.then(() => this.say(`renamed · ${name}`, "success"))
				.catch((err: unknown) => this.say((err as Error).message, "error"));
			return;
		}
		this.renameInput.handleInput(data);
		this.o.tui.requestRender();
	}

	private jumpHeader(dir: 1 | -1): void {
		const list = this.itemList();
		let i = this.selectedIndex(list);
		for (i += dir; i >= 0 && i < list.length; i += dir) {
			const it = list[i]!;
			if (it.kind === "header") {
				this.cursor = { kind: "header", key: it.section.key };
				this.o.tui.requestRender();
				return;
			}
		}
	}

	private async reorder(dir: 1 | -1): Promise<void> {
		const it = this.selected();
		if (it?.kind !== "row" || !this.client) return;
		if (this.filter()) return this.say("clear the filter to reorder", "warning");
		// the whole section, including rows folded into "… N more"
		const full = layout(this.listedRows(), { groupBy: this.groupBy }).find((s) => s.key === it.section.key);
		const rows = full?.rows ?? it.section.rows;
		const i = rows.findIndex((r) => r.id === it.row.id);
		const j = i + dir;
		if (j < 0 || j >= rows.length) return;
		const ids = rows.map((r) => r.id);
		[ids[i], ids[j]] = [ids[j]!, ids[i]!];
		// apply locally at once; the daemon's events confirm it
		const key = it.section.key;
		ids.forEach((id, n) => {
			const r = this.rows.get(id);
			if (r) this.rows.set(id, { ...r, order: n, orderKey: key });
		});
		this.o.tui.requestRender();
		try {
			await this.client.request("reorder", { ids, key });
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private async attachNth(n: number): Promise<void> {
		const sel = this.selectedRow();
		const cwd = sel?.cwd ?? this.o.cwd;
		const rows = this.itemList()
			.filter((it): it is Extract<Item, { kind: "row" }> => it.kind === "row" && it.row.cwd === cwd)
			.map((it) => it.row);
		const row = rows[n - 1];
		if (!row) return this.say(`no row ${n} in ${cwd}`, "warning");
		this.cursor = { kind: "row", id: row.id };
		return this.attachTo(row.id);
	}

	// ---- actions ---------------------------------------------------------

	/** Where a dispatch goes: the selected directory section when grouping by directory. */
	private dispatchCwd(): string {
		if (this.groupBy === "directory") {
			const it = this.selected();
			if (it?.section.dir) return it.section.dir;
			if (it?.kind === "row") return it.row.cwd;
		}
		return this.o.cwd;
	}

	private async dispatch(attach: boolean): Promise<void> {
		if (this.dispatching) return;
		if (this.filter()) return this.say("that is a filter; Enter attaches to the selected row", "warning");
		const shown = this.input.getValue();
		// a task written in $EDITOR keeps its line breaks as long as the input is untouched
		const typed = this.longTask && this.longTask.shown === shown ? this.longTask.text : shown;
		this.longTask = undefined;
		const base = this.dispatchCwd();
		const parsed = parseInput(typed, base);
		if (parsed.kind === "command") {
			const handled = this.command(parsed.name, parsed.arg);
			if (handled) return;
			// DI-5: skills and prompt templates run as the job's first prompt
		}
		let args: LaunchRequest;
		if (parsed.kind === "shell") {
			if (!parsed.command) return this.say("! needs a command", "warning");
			if (!this.o.launchShell) return this.say("shell jobs are not available here", "warning");
			args = this.o.launchShell(parsed.command, parsed.cwd ?? base);
		} else {
			const task = parsed.kind === "task" ? parsed.task : typed.trim();
			if (task.length < MIN_TASK) return this.say("Too short", "warning");
			const cwd = parsed.kind === "task" ? (parsed.cwd ?? base) : base;
			try {
				args = this.o.launch(task, { cwd, model: this.model, thinking: this.thinking, worktree: this.worktree });
			} catch (err) {
				return this.say((err as Error).message, "error");
			}
		}
		const { discard, note, ...request } = args;
		if (!this.client) return this.say("background service unavailable", "error");
		this.dispatching = true;
		this.input.setValue("");
		try {
			const { id, name } = await this.client.request("dispatch", request);
			this.cursor = { kind: "row", id };
			const where = request.worktree ? ` · ⎇ ${request.worktree.branch}` : "";
			this.say(`started · ${name}${where}${note ? ` · ${note}` : ""}`, note ? "warning" : "success");
			if (attach) {
				const deadline = Date.now() + 3000;
				while (!this.rows.get(id)?.pid && Date.now() < deadline) await sleep(50);
				await this.attachTo(id);
			}
		} catch (err) {
			if (refusedByDaemon(err)) discard?.();
			if (!this.input.getValue()) this.input.setValue(typed);
			this.say((err as Error).message, "error");
		} finally {
			this.dispatching = false;
		}
	}

	private async sendReply(): Promise<void> {
		const row = this.peekId ? this.rows.get(this.peekId) : undefined;
		const text = this.reply.getValue().trim();
		if (!row) {
			this.closePeek();
			return this.say("that session no longer exists", "warning");
		}
		if (!text || !this.client) return;
		// M8: /model and /thinking in a peek change that session, with the same pickers as for new ones
		const setting = /^\/(model|thinking)(?:\s+(.*))?$/.exec(text);
		if (setting) return this.sessionSetting(row, setting[1] as "model" | "thinking", (setting[2] ?? "").trim());
		try {
			const r = await this.client.request("reply", { id: row.id, text });
			this.reply.setValue("");
			if (r.stopped) this.say(`stopped · ${row.name}`);
			else if (r.delivered) {
				this.say(row.waitingFor === "dialog" ? "queued; attach (→) to answer the dialog" : `sent · ${row.name}`, "success");
			} else if (r.respawned) this.say(`sent · starting ${row.name} again`, "success");
			else if (r.saved) this.say(`saved; it is sent when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else this.say("not delivered: the session is not running", "error");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M8: switch a session's model or thinking level from its peek. */
	private sessionSetting(row: JobRow, which: "model" | "thinking", arg: string): void {
		if (row.kind === "shell") return this.say("a shell job has no model", "warning");
		const values: string[] = which === "model" ? (this.o.models?.() ?? []) : [...THINKING_LEVELS];
		const apply = (v: string) => this.sendSetting(row, which, v);
		if (arg) {
			if (arg === "default") return this.say(`a running session has no default ${which}: pick one (bare /${which})`, "warning");
			if (which === "model" && !arg.includes("/")) return this.say("use provider/id (bare /model lists them)", "warning");
			if (values.length > 0 && !values.includes(arg)) {
				return this.say(which === "model" ? `unknown model ${arg} (bare /model lists them)` : `thinking is one of ${values.join(", ")}`, "warning");
			}
			return void apply(arg);
		}
		if (values.length === 0) return this.say("no models available", "warning");
		this.reply.setValue("");
		const current = (which === "model" ? row.model : row.thinking) ?? "";
		this.openPicker(`${which === "model" ? "Model" : "Thinking"} for ${oneLine(row.name)}`, values, current, apply);
	}

	private async sendSetting(picked: JobRow, which: "model" | "thinking", value: string): Promise<void> {
		if (!this.client) return this.say("background service unavailable", "error");
		// the picker may have been open a while: act on the row as it is now
		const row = this.rows.get(picked.id);
		if (!row) return this.say("that session no longer exists", "warning");
		const pending = this.switches.get(switchKey(row.id, which));
		// a second switch before the first shows: compare with what the session had before both
		const before = pending ? pending.before : ((which === "model" ? row.model : row.thinking) ?? null);
		try {
			const r = await this.client.request("reply", { id: row.id, text: `/${which} ${value}` });
			this.reply.setValue("");
			if (r.delivered) {
				// asked, not done: the worker may lack credentials, or pi may lower a thinking level
				if (!pending && before === value) return this.say(`${row.name} already uses ${which} ${value}`);
				this.watchSwitch(row, which, value, before, pending ? [...pending.superseded, pending.value] : []);
				this.say(`asked ${row.name} to use ${which} ${value}…`);
			} else if (r.respawned) this.say(`${which} ${value} · starting ${row.name} again`, "success");
			else if (r.saved) this.say(`saved; ${which} changes when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else if (row.pid !== null || row.endedAt === null) this.say(`${row.name} is starting; try again in a moment`, "warning");
			else this.say("not delivered: the session is not running", "error");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** One watch per session and setting: a /thinking does not cancel the check of a /model. */
	private watchSwitch(row: JobRow, which: "model" | "thinking", value: string, before: string | null, replaced: string[]): void {
		// the value asked for now is the outcome, even if an earlier switch asked for it too
		const superseded = [...new Set(replaced)].filter((v) => v !== value);
		const key = switchKey(row.id, which);
		const old = this.switches.get(key);
		if (old) clearTimeout(old.timer);
		const timer = setTimeout(() => {
			if (this.switches.get(key)?.timer !== timer) return;
			this.switches.delete(key);
			const now = this.rows.get(row.id);
			if (!now) return;
			const actual = (which === "model" ? now.model : now.thinking) ?? null;
			// a report the view missed (a reconnect) may already show it
			if (actual === value) return this.say(`${now.name} now uses ${which} ${value}`, "success");
			this.say(
				// the hint first: a long model id may be cut at 80 columns (the peek names the session)
				which === "model"
					? `model switch failed (credentials? envAllowList): still ${actual ? shortModel(actual) : "?"}, not ${shortModel(value)}`
					: `thinking ${value} not taken (unsupported?): still ${actual ?? "?"}`,
				"warning",
			);
		}, this.o.switchCheckMs ?? SWITCH_CHECK_MS);
		timer.unref?.();
		this.switches.set(key, { which, value, before, superseded, timer });
	}

	/** A report shows a switch (or pi's adjusted thinking level). */
	private checkSwitch(row: JobRow): void {
		for (const which of ["model", "thinking"] as const) {
			const key = switchKey(row.id, which);
			const s = this.switches.get(key);
			if (!s) continue;
			const actual = (which === "model" ? row.model : row.thinking) ?? null;
			// only a switch this one replaced: from now on that is the value to move away from
			if (actual !== null && s.superseded.includes(actual)) {
				s.before = actual;
				s.superseded = s.superseded.filter((v) => v !== actual);
				continue;
			}
			if (actual === s.before) continue; // not applied yet (the timer decides)
			clearTimeout(s.timer);
			this.switches.delete(key);
			if (actual === s.value) {
				// a running turn keeps its current request; the next one uses the new setting
				this.say(`${row.name} now uses ${which} ${s.value}${row.state === "working" ? " (from its next request)" : ""}`, "success");
			} else if (which === "thinking") this.say(`${row.name} thinks ${actual ?? "?"}: the closest its model supports to ${s.value}`, "warning");
			else this.say(`${row.name} now uses ${actual ?? "?"}`, "warning");
		}
	}

	/** AV-K12: stop; again within 2 s delete; on a header, the whole group. */
	private async stopSelected(): Promise<void> {
		if (!this.client) return;
		const it = this.selected();
		if (!it) return;
		const targets = it.kind === "row" ? [it.row] : it.section.rows;
		if (targets.length === 0) return;
		const key = it.kind === "row" ? it.row.id : `group:${it.section.key}:${targets.map((r) => r.id).join(",")}`;
		const now = Date.now();
		const armed = this.armedStop?.id === key && now - this.armedStop.at < DOUBLE_PRESS_MS;
		this.armedStop = { id: key, at: now };
		try {
			if (armed || targets.every((r) => r.pid === null)) {
				if (!armed) return this.say("Ctrl+X again to delete", "warning");
				const kept: string[] = [];
				let only = "";
				for (const r of targets) {
					const res = await this.client.request("rm", { id: r.id });
					if (res.worktree) {
						only = cleanupText(res.worktree);
						if (!res.worktree.removed || res.worktree.branchKept) kept.push(only);
					}
				}
				this.armedStop = undefined;
				if (targets.length === 1) this.say(`deleted · ${targets[0]!.name}${only ? ` · ${only}` : ""}`, kept.length > 0 ? "warning" : "muted");
				else this.say(`deleted ${targets.length} sessions${kept.length > 0 ? ` · ${kept.length} worktrees or branches kept` : ""}`, kept.length > 0 ? "warning" : "muted");
			} else {
				for (const r of targets) if (r.pid !== null) await this.client.request("stop", { id: r.id });
				this.say(`stopping${targets.length > 1 ? ` ${targets.length} sessions` : ""} · Ctrl+X again to delete`, "warning");
			}
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private async attachSelected(): Promise<void> {
		const row = this.selectedRow();
		if (!row) return;
		try {
			await this.attachTo(row.id);
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** AT-1/AT-2: hand the terminal to the job's PTY host, then repaint. */
	private async attachTo(id: string): Promise<void> {
		const row = this.rows.get(id);
		if (!row) return;
		if (row.pid === null) {
			if (!this.client) return this.say("background service unavailable", "error");
			// a reaped session just wakes up (AT-1); one that ended asks first (DM-7)
			const now = Date.now();
			if (!row.reaped && (this.restartAsk?.id !== id || now - this.restartAsk.at > RESTART_ASK_MS)) {
				this.restartAsk = { id, at: now };
				return this.say(
					row.kind === "shell"
						? `${row.name} has ended · Enter again to run the command again`
						: `${row.name} is ${row.state} · Enter again to start it`,
					"warning",
				);
			}
			this.restartAsk = undefined;
		}
		const { tui } = this.o;
		let reason: DetachReason;
		let failure: string | undefined;
		try {
			this.attached = true;
			// M14: leave the screen as it is (fullscreen pi would print its transcript first)
			tui.stop({ preserveScreen: true });
			if (row.pid === null) await ensureLive(this.client!, row, process.stdout);
			reason = await attachToHost(hostSocketPath(id), { stdin: process.stdin, stdout: process.stdout });
		} catch (err) {
			reason = "error";
			failure = (err as Error).message;
		} finally {
			this.attached = false;
			tui.start();
			tui.requestRender(true);
			this.render0();
		}
		this.cursor = { kind: "row", id };
		if (failure) this.say(`could not start ${row.name}: ${oneLine(failure)}`, "error");
		else if (reason === "takeover") this.say("Attached elsewhere", "warning");
		else if (reason === "exit") this.say(`${row.name} ended`);
		else if (reason === "error" || reason === "closed") this.say(`lost the connection to ${row.name}`, "error");
	}

	// ---- render ----------------------------------------------------------

	invalidate(): void {}

	render(width: number): string[] {
		const lines = this.renderLines(width);
		if (!this.o.fullscreen) return lines;
		return fitScreen(lines, this.o.tui.terminal.rows || 30, this.selLine, this.bottomFrom, {
			selectedEnd: this.selEnd,
			keep: this.headLines,
		});
	}

	/**
	 * In render: the selected row's first and last line (with its peek and reply input),
	 * the first line of the bottom block (input, keys), and the fixed lines on top.
	 */
	private selLine = -1;
	private selEnd = -1;
	private bottomFrom = -1;
	private headLines = 2;

	private renderLines(width: number): string[] {
		const t = this.o.theme;
		const w = Math.max(1, width);
		this.selLine = -1;
		this.selEnd = -1;
		this.bottomFrom = -1;
		const now = Date.now();
		// the peeked row vanished (deleted, folded, collapsed): never reply to another one
		if (this.peek && !this.itemList().some((it) => it.kind === "row" && it.row.id === this.peekId)) this.closePeek();
		if (this.notice && now > this.notice.until) this.notice = undefined;
		const all = this.listedRows();
		const c = counts(all);
		const out: string[] = [];
		const short = (this.o.tui.terminal.rows || 30) < 18;

		out.push(truncateToWidth(t.bold("pi agents") + t.fg("dim", `  ${headerText(c)}`), w));
		if (!short) out.push(t.fg("border", "─".repeat(w)));
		this.headLines = out.length;
		if (this.connectError) out.push(t.fg("error", truncateToWidth(`background service: ${oneLine(this.connectError)}`, w)));

		if (this.origin && this.o.banner) out.push(t.fg("accent", truncateToWidth(this.o.banner, w)));
		const wt = this.worktree ?? this.o.worktreeDefault === true;
		if (this.model || this.thinking || wt) {
			const d = [this.model && `model ${this.model}`, this.thinking && `thinking ${this.thinking}`, wt && "own worktree"].filter(Boolean).join(" · ");
			out.push(t.fg("dim", truncateToWidth(`new sessions: ${d}`, w)));
		}
		if (this.picker || this.help) {
			const rows = this.o.tui.terminal.rows || 30;
			const body = this.picker ? this.pickerLines(w, rows - out.length) : this.helpLines(w, rows - out.length);
			// its last line (how to leave) stays on screen
			this.bottomFrom = out.length + body.length - 1;
			return [...out, ...body].map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
		}

		const sections = this.sections();
		const list = items(sections);
		this.nameWidth = Math.max(1, Math.min(28, Math.floor(w / 3), Math.max(8, ...all.map((r) => visibleWidth(oneLine(r.name)) + (r.parentSession ? 2 : 0)))));
		this.columns = this.columnsFor(all, Math.max(1, w - 2), now);
		const sel = this.selectedIndex(list);
		const empty = all.length === 0;
		list.forEach((it, i) => {
			const isSel = i === sel;
			if (it.kind === "header") {
				const s = it.section;
				const label = `${s.collapsed ? "▸" : "▾"} ${s.title}${s.rows.length || s.hidden ? ` (${s.rows.length + s.hidden})` : ""}`;
				const hint = empty ? t.fg("dim", `  ${s.hint}`) : "";
				if (isSel) this.selLine = out.length;
				out.push(this.mark(isSel, truncateToWidth(t.bold(label) + hint, Math.max(1, w - 2))));
				return;
			}
			if (isSel) this.selLine = out.length;
			out.push(truncateToWidth(this.mark(isSel, this.rowLine(it.row, Math.max(1, w - 2), now)), w));
			// the peek belongs right under its row, before the section's "… N more"
			if (isSel && this.peek) out.push(...this.peekLines(it.row, w, now));
			if (isSel) this.selEnd = out.length - 1;
			const lastOfSection = list[i + 1]?.kind !== "row" || list[i + 1]?.section !== it.section;
			if (lastOfSection && it.section.hidden > 0) out.push(truncateToWidth(`  ${t.fg("dim", `… ${it.section.hidden} more`)}`, w));
		});

		// a peek's lines belong with its row; the input and keys stay at the bottom
		if (this.selEnd === -1) this.selEnd = this.selLine;
		out.push("");
		this.bottomFrom = out.length;
		if (this.renaming) out.push(...this.renameInput.render(w));
		else if (!this.peek) {
			out.push(...this.input.render(w));
			const at = atPrefix(this.input.getValue());
			if (at !== undefined) {
				const s = this.atSuggestions(at);
				out.push(t.fg("dim", truncateToWidth(s.length ? `Tab: ${s.slice(0, 6).map((d) => `@${d}`).join("  ")}` : "no matching directory", w)));
			}
		}
		const f = this.filter();
		if (f && !list.some((it) => it.kind === "row")) out.push(t.fg("dim", truncateToWidth("no sessions match", w)));
		if (this.notice) out.push(t.fg(this.notice.tone, truncateToWidth(oneLine(this.notice.text), w)));
		out.push(t.fg("dim", truncateToWidth(this.footer(), w)));
		// pi-tui refuses (and crashes on) lines wider than the terminal
		return out.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
	}

	private mark(selected: boolean, line: string): string {
		return selected ? `${this.o.theme.fg("accent", "›")} ${line}` : `  ${line}`;
	}

	private rowLine(row: JobRow, width: number, now: number): string {
		const t = this.o.theme;
		const icon = iconOf(row, this.frame, !this.o.reducedMotion);
		const age = ageOf(row, now);
		// M9: a spawned session is marked as someone's child
		const name = truncateToWidth(oneLine(`${row.parentSession ? "↳ " : ""}${row.name}`), this.nameWidth);
		const pad = " ".repeat(Math.max(0, this.nameWidth - visibleWidth(name)));
		const styled = row.id === this.o.highlightId ? t.bold(t.fg(nameToneOf(row.id), name)) : t.fg(nameToneOf(row.id), name);
		const head = `${t.fg(icon.tone, icon.glyph)} ${styled}${pad}  `;
		const detail = this.detailText(row);
		const ageCol = t.fg("dim", age.padStart(this.columns.ageW));
		const tail = detail ? `${detail}  ${ageCol}` : ageCol;
		const room = width - visibleWidth(head) - visibleWidth(tail) - 2;
		const summary = room > 4 ? t.fg(row.pid === null ? "dim" : "muted", truncateToWidth(oneLine(sentenceOf(row)), room)) : "";
		const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(summary) - visibleWidth(tail));
		return `${head}${summary}${" ".repeat(gap)}${tail}`;
	}

	/**
	 * M8: how much of the model / context column fits. The summary keeps MIN_SUMMARY
	 * columns: on a narrow terminal the column shrinks to the share, then goes.
	 */
	private columnsFor(rows: JobRow[], width: number, now: number): Columns {
		const ageW = Math.max(0, ...rows.map((r) => ageOf(r, now).length));
		const none: Columns = { mode: "none", modelW: 0, shareW: 0, ageW };
		if (this.o.rowDetails === false) return none;
		const ds = rows.map(rowDetailsOf).filter((d): d is NonNullable<typeof d> => d !== null);
		const modelW = Math.min(MODEL_COL, Math.max(0, ...ds.map((d) => (d.model ? visibleWidth(oneLine(d.model)) : 0))));
		const shareW = Math.max(0, ...ds.map((d) => d.context?.length ?? 0));
		// what the summary keeps: the row minus icon, name, the column, the age and the gaps
		const room = (col: number) => width - (2 + this.nameWidth + 2) - col - 2 - ageW - 2;
		const full = modelW + (modelW && shareW ? 3 : 0) + shareW;
		if (full > 0 && room(full) >= MIN_SUMMARY) return { mode: "full", modelW, shareW, ageW };
		if (shareW > 0 && room(shareW) >= MIN_SUMMARY) return { mode: "share", modelW: 0, shareW, ageW };
		return none;
	}

	/** M8: "claude-opus-5-5 · 43%", padded to the column (blank for a row without them). */
	private detailText(row: JobRow): string {
		const c = this.columns;
		if (c.mode === "none") return "";
		const t = this.o.theme;
		const d = rowDetailsOf(row);
		const share = d?.context ? t.fg(d.tone, d.context.padStart(c.shareW)) : " ".repeat(c.shareW);
		if (c.mode === "share") return share;
		const raw = d?.model ? truncateToWidth(oneLine(d.model), c.modelW) : "";
		// right-aligned as a block: the shares line up, the model sits next to its share
		const lead = (w: number) => " ".repeat(Math.max(0, c.modelW - w));
		if (c.shareW === 0) return lead(visibleWidth(raw)) + t.fg("dim", raw);
		if (c.modelW === 0) return share;
		if (!raw) return `${lead(0)}   ${share}`;
		return `${lead(visibleWidth(raw))}${t.fg("dim", raw)}${t.fg("dim", d?.context ? " · " : "   ")}${share}`;
	}

	/** PK-1: the full sentence, choices, waiting time, and the reply input. */
	private peekLines(row: JobRow, width: number, now: number): string[] {
		const t = this.o.theme;
		const inner = Math.max(1, width - 4);
		const lines: string[] = [];
		const sentence = sentenceOf(row).replace(CONTROL, " ");
		for (const chunk of wrap(sentence, inner)) lines.push(`    ${chunk}`);
		row.choices.forEach((c, i) => lines.push(`    ${t.fg("accent", `${i + 1}.`)} ${truncateToWidth(oneLine(c), Math.max(1, inner - 4))}`));
		// a blocked row's status is always "waiting": say it once, with how long
		const facts: string[] = [
			row.state === "blocked"
				? `needs input · waiting ${formatDuration(now - row.stateSince)}`
				: row.state + (row.status ? ` · ${row.status}` : ""),
		];
		if (row.parentSession) {
			const parent = [...this.rows.values()].find((r) => r.sessionFile === row.parentSession && r.id !== row.id);
			facts.push(`child of ${parent ? oneLine(parent.name) : "a foreground session"}`);
		}
		const kids = [...this.rows.values()].filter((r) => r.parentSession && r.parentSession === row.sessionFile && r.id !== row.id);
		if (kids.length > 0) {
			const live = kids.filter((r) => r.state === "working" || r.state === "blocked").length;
			facts.push(`${kids.length} subagent${kids.length === 1 ? "" : "s"}${live ? ` (${live} running)` : ""}`);
		}
		if (row.worktree) {
			facts.push(`⎇ ${oneLine(row.worktree.branch)}`);
		}
		facts.push(row.id);
		lines.push(`    ${t.fg("dim", truncateToWidth(facts.join(" · "), inner))}`);
		// M8: model, thinking and context window on a line of their own
		const model = modelFacts(row);
		if (model.length > 0) {
			const tone = row.context ? rowDetailsOf(row)?.tone ?? "dim" : "dim";
			lines.push(`    ${t.fg(tone, truncateToWidth(model.join(" · "), inner))}`);
		}
		if (row.waitingFor === "dialog") lines.push(`    ${t.fg("warning", "a dialog is open: attach (→) to answer it; replies wait for it")}`);
		for (const l of this.reply.render(inner)) lines.push(`    ${l}`);
		return lines;
	}

	private footer(): string {
		if (this.renaming) return "Enter rename · Esc cancel";
		if (this.origin) return "Esc/Enter back to your conversation · ↑↓ select · Space peek · ? keys";
		if (this.filter()) return "filtering (s: n: o:) · Enter/→ attach · Esc clear";
		if (this.peek) return "Enter send · 1-9 pick · ↑↓ next · → attach · /stop stops · Esc close · ? keys";
		return "↑↓ select · Enter/→ attach · Space peek · Ctrl+Enter start+attach · Ctrl+X stop · ? keys · Esc exit";
	}

	/** `room`: the lines left under the header. */
	private pickerLines(width: number, room: number): string[] {
		const t = this.o.theme;
		const p = this.picker!;
		const height = Math.max(1, Math.min(p.items.length, room - 4));
		const start = Math.max(0, Math.min(p.index - Math.floor(height / 2), p.items.length - height));
		const lines = [t.bold(truncateToWidth(p.title, width)), ""];
		p.items.slice(start, start + height).forEach((it, i) => {
			const sel = start + i === p.index;
			lines.push(this.mark(sel, truncateToWidth(sel ? t.fg("accent", it.label) : it.label, Math.max(1, width - 2))));
		});
		lines.push("", t.fg("dim", truncateToWidth("↑↓ choose · Enter pick · Esc cancel", width)));
		return lines;
	}

	/** `room`: the lines left under the header; two columns when one does not fit. */
	private helpLines(width: number, room: number): string[] {
		const t = this.o.theme;
		const keys: [string, string][] = [
			["↑ ↓ PgUp PgDn Home End", "move"],
			["Enter", "attach · start the typed task · fold a group"],
			["→", "attach"],
			["Space", "peek and reply"],
			["Ctrl+Enter", "start the typed task and attach"],
			["Ctrl+X", "stop; again within 2 s to delete (on a header: the group)"],
			["Ctrl+S", "group by state / directory"],
			["Ctrl+T", "pin / unpin (pinned sessions keep running)"],
			["Ctrl+R", "rename"],
			["Shift+↑ Shift+↓", "move the row within its group"],
			["Alt+↑ Alt+↓", "previous / next group"],
			["Alt+1…9", "attach to row N of this directory"],
			["Ctrl+F", "find by name (n:)"],
			["Ctrl+G", "write the task in $VISUAL / $EDITOR"],
			["s: n: o:", "filter by state, name, result; combine with spaces"],
			["@dir task", "start the task in that directory (Tab completes)"],
			["! command", "run a shell command as a job"],
			["/model /thinking", "defaults for new sessions (bare: pick; default resets)"],
			["/worktree", "new sessions in their own git worktree and branch (toggle)"],
			["in a peek: /model", "switch that session's model (/thinking: its level)"],
			["/resume", "bring back a past session of this directory"],
			["Esc", "close peek · clear input · exit"],
			["Ctrl+C", "clear input; twice to exit"],
			["in a session", "← on an empty prompt, /exit or Ctrl+Z detaches"],
		];
		const line = (k: string, v: string, w: number) => truncateToWidth(`  ${t.fg("accent", k.padEnd(24))}${v}`, w);
		let body = keys.map(([k, v]) => line(k, v, width));
		if (keys.length + 3 > room && width >= 70) {
			const half = Math.ceil(keys.length / 2);
			const col = Math.floor(width / 2);
			body = keys.slice(0, half).map(([k, v], i) => {
				const left = line(k, v, col - 1);
				const right = keys[half + i];
				return right ? left + " ".repeat(Math.max(1, col - visibleWidth(left))) + line(right[0], right[1], width - col) : left;
			});
		}
		return ["", ...body, "", t.fg("dim", "any key to close")];
	}
}

/**
 * Full screen: exactly `rows` lines. The bottom block (input, notices, keys) is pinned
 * to the last lines; the first `keep` lines (title, rule) stay; the rest scrolls so the
 * selection — `selected` to `selectedEnd`, a row with its peek — is visible, its end
 * (the reply input) first. Lines from `bottom` on are the bottom block (-1: none).
 */
export function fitScreen(
	lines: string[],
	rows: number,
	selected: number,
	bottom: number,
	opts: { selectedEnd?: number; keep?: number } = {},
): string[] {
	const height = Math.max(1, rows);
	const top = bottom === -1 ? lines : lines.slice(0, bottom);
	const foot = bottom === -1 ? [] : lines.slice(bottom).slice(-height);
	const room = height - foot.length;
	let body = top;
	if (top.length > room) {
		// a tiny screen gives up the title before the selection
		const keep = Math.max(0, Math.min(opts.keep ?? 2, room - 1));
		const rest = room - keep;
		const lo = Math.max(keep, Math.min(selected, top.length - 1));
		const hi = Math.max(lo, Math.min(opts.selectedEnd ?? lo, top.length - 1));
		let start = Math.min(hi - rest + 1 + Math.floor(rest / 3), lo); // some context after, the start shown
		start = Math.max(start, hi - rest + 1); // but never losing the end
		start = Math.max(keep, Math.min(start, top.length - rest));
		body = [...top.slice(0, keep), ...top.slice(start, start + rest)];
	}
	return [...body, ...Array(Math.max(0, room - body.length)).fill(""), ...foot].slice(0, height);
}

// Control characters other than newlines would corrupt the line-based renderer.
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/g;

/** Put text in an input with the cursor after it (setValue leaves the cursor where it was). */
function fill(input: Input, value: string): void {
	input.setValue("");
	// typed in, so the cursor ends after it whatever the user's key bindings
	for (const ch of value.replace(CONTROL, " ")) input.handleInput(ch);
}

function formatAgo(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function oneLine(text: string): string {
	return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

function within(dir: string, root: string): boolean {
	return dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/)) {
			if (!word) continue;
			if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) {
				out.push(line);
				line = "";
			}
			line = line ? `${line} ${word}` : word;
		}
		if (line) out.push(truncateToWidth(line, width));
	}
	return out.slice(0, 6);
}
