import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { HubTheme } from "./theme.ts";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	decodeKittyPrintable,
	Input,
	isKeyRelease,
	parseKey,
	type SlashCommand,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { attachToHost, type DetachReason } from "../lib/attach.ts";
import { DaemonClient, type DaemonError } from "../lib/client.ts";
import { hostSocketPath } from "../lib/paths.ts";
import { atCandidates, atPrefix, parseInput, THINKING_LEVELS } from "../lib/dispatch-input.ts";
import { type Filter, parseFilter } from "../lib/filter.ts";
import { forgetJob, observeJob } from "../lib/job-events.ts";
import { ensureLive } from "../lib/resume.ts";
import { changeText, cleanupText, worktreeChange, type WorktreeChange } from "../lib/worktree.ts";
import { formatCost, todayOf, totalUsage } from "../lib/usage.ts";
import { agoText, parseScheduleInput, untilText } from "../lib/schedule.ts";
import { TaskEditor } from "./task-editor.ts";
import { type AgentDef, findAgent, pickAgent } from "../lib/agents.ts";
import { hyperlink, prLabel, prTone, rowHasPr } from "../lib/pr.ts";
import { fallbackName, refusedByDaemon } from "../lib/dispatch.ts";
import type { DispatchArgs, Event, JobRow, ReplyMode } from "../lib/protocol.ts";
import { eventAgo, eventLine, type RoostEvent } from "../lib/events.ts";
import { screenPath } from "../lib/store.ts";
import { readTail, transcriptItems } from "../lib/transcript.ts";
import { type ConciergeStatus, orderLine, type StandingOrder } from "../lib/concierge.ts";
import { type Preset, presetFrom, projectConfigPath } from "../lib/config.ts";
import {
	ageOf,
	counts,
	formatDuration,
	headerText,
	iconOf,
	modelFacts,
	fitTail,
	rowDetailsOf,
	formatTokens,
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
	isProfileRow,
	takesReplies,
} from "../lib/view-model.ts";

const MIN_TASK = 4; // DI-1
const DOUBLE_PRESS_MS = 2000; // Ctrl+X delete, Ctrl+C exit

/** M48: the commands a peek takes (`/…` in its reply box), for that session. */
const PEEK_COMMANDS: { name: string; description: string; argumentHint?: string }[] = [
	{ name: "stop", description: "stop it" },
	{ name: "respawn", description: "start it again" },
	{ name: "rm", description: "delete it (twice within 2 s)" },
	{ name: "pin", description: "pin / unpin (a pinned session keeps running)" },
	{ name: "rename", description: "rename it (bare: edit the name)", argumentHint: "name" },
	{ name: "attach", description: "attach to it (→)" },
	{ name: "model", description: "switch its model (bare: pick)", argumentHint: "provider/id" },
	{ name: "thinking", description: "its thinking level (bare: pick)", argumentHint: "level" },
	{ name: "name", description: "its own session name (pi's /name)", argumentHint: "name" },
	{ name: "compact", description: "compact its context (pi's /compact)" },
	{ name: "continue", description: "send: Continue where you left off." },
	{ name: "log", description: "its events (newest first)" },
	{ name: "transcript", description: "its transcript (a terminal agent: its screen)" },
	{ name: "ask", description: "ask the concierge about it", argumentHint: "question" },
];
const RESTART_ASK_MS = 3000;
const NOTICE_MS = 4000;
const SPIN_MS = 150;
/** M8: the row's model and context column only shows while the summary keeps this many columns. */
const MIN_SUMMARY = 24;
const MODEL_COL = 20;
/** M22: how often the view checks its rows against the daemon's. */
const RESYNC_MS = 15_000;
/** M8: how long a sent /model or /thinking may take to show in the session's reports. */
const SWITCH_CHECK_MS = 8000;
/** M26: the most models one task fans out to. */
const MAX_FANOUT = 6;

/** M23: a picker's items matching its search: every word of it, in any case. */
export function pickerShown(p: { items: { label: string; value: string }[]; query?: string }): { label: string; value: string }[] {
	const words = (p.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return p.items;
	return p.items.filter((it) => {
		const hay = `${it.label} ${it.value}`.toLowerCase();
		return words.every((w) => hay.includes(w));
	});
}

export interface AgentViewOptions {
	tui: TUI;
	theme: HubTheme;
	/** Directory new jobs start in. */
	cwd: string;
	/** AV-7: show only jobs started under this directory. */
	cwdFilter?: string;
	/** Builds the dispatch request for a task typed into the view. */
	/** A new pi job; the view adds its /model and /thinking defaults and @dir target. */
	launch: (task: string, opts?: LaunchOptions) => LaunchRequest;
	/** M18: agents a task's first word or `@name` can pick, and the default one (`dispatchAgent`). */
	agents?: () => ReadonlyMap<string, AgentDef>;
	defaultAgent?: string;
	/**
	 * M39: the template of a scheduled pi session: as `launch`, with `{{run}}` where each
	 * run's own session file goes (no worktree).
	 */
	scheduleLaunch?: (task: string, opts: { cwd: string; model?: string; thinking?: string }) => LaunchRequest;
	/** DI-6: a shell job (no model). */
	launchShell?: (command: string, cwd: string) => DispatchArgs;
	/** M30: the user's agent profiles (terminal agents besides pi), by name. */
	profiles?: () => string[];
	/** M30: a new session of a profile's agent. */
	launchProfile?: (profile: string, task: string, opts: { cwd: string; model?: string; thinking?: string; worktree?: boolean }) => LaunchRequest;
	/** Slash commands of this pi (DI-4, DI-5: skills and prompt templates become first prompts). */
	commands?: () => { name: string; source: string }[];
	/** M10: new sessions get a worktree unless /worktree off (config worktreeIsolation "all"). */
	worktreeDefault?: boolean;
	/** DI-4: models for the /model picker, as "provider/id". */
	models?: () => string[];
	/** DI-4: past sessions of a directory for /resume. */
	resumable?: (cwd: string) => Promise<Resumable[]>;
	/**
	 * M23: pi's own session selector for /resume (search, this directory or all, sort);
	 * without it, or when it cannot be built, the view's own list.
	 */
	sessionSelector?: (o: {
		cwd: string;
		onSelect: (session: Resumable) => void;
		onCancel: () => void;
		requestRender: () => void;
		/** A session a live job runs (not to be deleted from the list). */
		busy: (path: string) => boolean;
	}) => Overlay;
	/** M23: what new sessions run when no model is chosen ("provider/id"). */
	defaultModel?: () => string | undefined;
	/** M23: this pi's own session file (it cannot be resumed in the background). */
	currentSession?: () => string | undefined;
	/** M23: the models pi cycles through (`enabledModels`); none: all of them. */
	scopedModels?: () => string[];
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
	/** M27: the presets (user's and project's) and saving one to the user's file (null removes). */
	presets?: () => Record<string, Preset>;
	savePreset?: (name: string, preset: Preset | null) => void;
	/** M27: whether the user's own file has this preset (a project's cannot be removed here). */
	userPreset?: (name: string) => boolean;
	/** M26: what a session changed in its worktree (tests may replace git). */
	worktreeChange?: (path: string, base: string) => Promise<WorktreeChange | undefined>;
	/** M44: the launch of the concierge's pi session (its model and thinking level from roost.json). */
	conciergeLaunch?: () => LaunchRequest;
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
	/** M18: run as this agent. */
	agent?: AgentDef;
	/** M26: one of a fan-out: a worktree when the directory is a repository, else none (no error). */
	fanout?: string;
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
	/** M23: typed text narrows the list (every word, any case). */
	query?: string;
	/** M23: Tab shows these instead (all models vs the enabled ones), and back. */
	other?: { label: string; items: { label: string; value: string }[] };
	/** M23: what the list shows now, for the title (the enabled models, all models). */
	scope?: string;
}

/** M23: a component shown in place of the list (pi's session selector), with its keys. */
export interface Overlay {
	render(width: number): string[];
	handleInput?(data: string): void;
	focused?: boolean;
	dispose?(): void;
}

interface Columns {
	mode: "full" | "share" | "none";
	modelW: number;
	shareW: number;
	ageW: number;
	/** M24: the cost column ("$1.20"), when there is room for it. */
	costW: number;
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
	/** M17: pi's editor: several lines (Shift+Enter), long pastes folded. */
	private input: TaskEditor;
	/** M48: the reply box is an editor like the task box (lines, pastes, undo, completion). */
	private reply: TaskEditor;
	/** AV-K10: the row being renamed, edited in its own input. */
	private renaming: string | undefined;
	private renameInput = new Input({ prompt: "rename › " });
	private groupBy: "state" | "directory" = "state";
	/** DI-4: defaults for the next dispatches. */
	private model: string | undefined;
	private thinking: string | undefined;
	/** M10: /worktree for the next dispatches (undefined: the user's default). */
	private worktree: boolean | undefined;
	private picker: Picker | undefined;
	private overlay: Overlay | undefined;
	private notice: Notice | undefined;
	private armedStop: { id: string; at: number } | undefined;
	private ctrlCAt = 0;
	private frame = 0;
	private spinner: NodeJS.Timeout | undefined;
	private resync: NodeJS.Timeout | undefined;
	private attached = false;
	private closed = false;
	private connectError: string | undefined;
	/** M44: the concierge as the daemon last said; asking: a `? …` whose answer is awaited (two minutes at most). */
	private concierge: ConciergeStatus | undefined;
	private asking = false;
	private askTimer: NodeJS.Timeout | undefined;
	/** An answer that came while another overlay was open: shown once it closes. */
	private pendingAnswer: string | undefined;
	/** M45: suggestions the user dismissed (Esc), by row and time: the banner skips them. */
	private dismissed = new Set<string>();
	private nameWidth = 16;
	/** M8: the model / context column, the same for every row of a render so it lines up. */
	private columns: Columns = { mode: "none", modelW: 0, shareW: 0, ageW: 0, costW: 0 };
	/** M8: switches sent to live sessions, until their reports show them (or do not). */
	private switches = new Map<string, Switch>();
	/** M25: rows checked with Ctrl+O; the batch keys act on all of them. */
	private marked = new Set<string>();
	private sendingMarked = false;
	/** M26: the next task starts one session per model. */
	private fanout: string[] | undefined;
	/** M27: the preset in use: its name, and what the view has no setting of its own for. */
	private preset: { name: string; agent?: string; dir?: string } | undefined;
	/** M30: new sessions run this profile's agent instead of pi. */
	private profile: string | undefined;
	private dispatching = false;
	/** The job a reply is typed for; replies never retarget to another row. */
	private peekId: string | undefined;

	private origin: string | undefined;
	/** Esc/Enter came before the moved conversation's worker was up: attach once it is. */
	private attachWhenLive: string | undefined;

	constructor(o: AgentViewOptions) {
		this.input = new TaskEditor(
			o.tui,
			{ border: (s) => o.theme.fg("border", s), dim: (s) => o.theme.fg("dim", s), accent: (s) => o.theme.fg("accent", s) },
			"describe a task and press Enter to start it in the background · Shift+Enter new line",
		);
		this.reply = new TaskEditor(o.tui, { border: (s) => o.theme.fg("border", s), dim: (s) => o.theme.fg("dim", s), accent: (s) => o.theme.fg("accent", s) }, "reply · Enter sends · / commands");
		this.reply.focused = false;
		// M48: pi's completion menu in both boxes: `/` the box's commands, `@` paths under its directory
		this.input.setAutocomplete(this.completion(() => this.viewCommands(), () => this.dispatchCwd()));
		this.reply.setAutocomplete(this.completion(() => this.peekCommands(), () => (this.peekId ? this.rows.get(this.peekId)?.cwd : undefined) ?? this.dispatchCwd()));
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
		clearInterval(this.resync);
		this.pendingAnswer = undefined;
		this.asked(false);
		this.closeOverlay();
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
			const { jobs, after } = await this.listFrom(client);
			if (this.closed) return client.close();
			this.rows = new Map(jobs.map((j) => [j.id, j]));
			for (const e of after) this.applyRow(e);
			for (const j of jobs) observeJob(j); // what is already there is not news
			for (const j of jobs) this.checkSwitch(j); // a switch shown while we were away
			// M44: a daemon from before the concierge has no such op: then there is none
			this.concierge = await client.request("concierge", { action: "status" }).catch(() => undefined);
			this.client = client;
			this.connectError = undefined;
			// AV-8: pushed events only; reconnect when the daemon goes away.
			const live = client;
			// M22: a push lost on the way (or never sent) shows up within RESYNC_MS
			clearInterval(this.resync);
			this.resync = setInterval(() => void this.resyncRows(live), RESYNC_MS);
			this.resync.unref?.();
			client.onClose(() => {
				if (this.client !== live) return;
				clearInterval(this.resync);
				this.client = undefined;
				this.asked(false);
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

	/**
	 * M22: the rows, and the events that came after the reply: those are newer than it,
	 * though handled before the code after the await runs.
	 */
	private async listFrom(client: DaemonClient): Promise<{ jobs: JobRow[]; after: Event[] }> {
		const heard: { e: Event; at: number }[] = [];
		const off = client.onEvent((e) => heard.push({ e, at: client.position() }));
		try {
			const { result, at } = await client.requestAt("list", this.o.cwdFilter ? { cwd: this.o.cwdFilter } : {});
			const after = heard.filter((h) => h.at > at).map((h) => h.e);
			return { jobs: result.jobs, after: after.filter((e) => e.event !== "job" || !this.o.cwdFilter || within(e.job.cwd, this.o.cwdFilter)) };
		} finally {
			off();
		}
	}

	/** M22: a row event over a fresh list (no notifications: it was seen already). */
	private applyRow(e: Event): void {
		if (e.event === "job") {
			if (this.o.cwdFilter && !within(e.job.cwd, this.o.cwdFilter)) return;
			this.rows.set(e.job.id, e.job);
		} else if (e.event === "removed") this.rows.delete(e.id);
	}

	/** M22: the daemon's rows as they are now (the stream after the reply carries on from them). */
	private async resyncRows(client: DaemonClient): Promise<void> {
		if (this.closed || this.client !== client) return;
		let jobs: JobRow[];
		let after: Event[];
		try {
			({ jobs, after } = await this.listFrom(client));
		} catch {
			return; // the close handler reconnects
		}
		if (this.closed || this.client !== client) return;
		const next = new Map(jobs.map((j) => [j.id, j]));
		for (const e of after) {
			if (e.event === "job") next.set(e.job.id, e.job);
			else if (e.event === "removed") next.delete(e.id);
		}
		for (const id of this.rows.keys()) if (!next.has(id)) forgetJob(id);
		for (const j of jobs) observeJob(j);
		this.rows = next;
		for (const j of jobs) this.checkSwitch(j);
		const waiting = this.attachWhenLive ? next.get(this.attachWhenLive) : undefined;
		if (waiting && !this.attached) {
			if (waiting.pid) {
				this.attachWhenLive = undefined;
				void this.attachTo(waiting.id).catch((err: unknown) => this.say(String(err), "error"));
			} else if (waiting.endedAt !== null) this.attachWhenLive = undefined;
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
		} else if (e.event === "concierge") {
			const prev = this.concierge;
			this.concierge = e.status;
			const s = e.status;
			if (!s.on) this.asked(false);
			if (this.asking && s.answer && s.answer.at !== prev?.answer?.at) {
				this.asked(false);
				// not over what is open (a confirm, a picker): after it
				if (this.overlay) {
					this.pendingAnswer = s.answer.text;
					this.say(`concierge answered: ${oneLine(s.answer.text).slice(0, 80)} (opens when this closes)`, "muted");
				} else this.showAnswer(s.answer.text);
			}
			if (s.notice && s.notice.at !== prev?.notice?.at && s.notice.kind === "need") this.say(`concierge: ${s.notice.text}`, "warning");
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
		if (this.peek || this.renaming) return undefined;
		const f = parseFilter(this.input.getValue());
		// M16 (Claude Code): `#1234` or a pull request URL selects the session working on it,
		// and is a task to dispatch when none is
		if (f?.pr && ![...this.rows.values()].some((r) => rowHasPr(r.prs, f.pr!))) return undefined;
		return f;
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
		if (this.overlay) {
			this.overlay.handleInput?.(data);
			this.o.tui.requestRender();
			return;
		}
		if (this.picker) return this.pickerKey(key, data);
		if (this.renaming) return this.renameKey(key, data);
		const typing = this.peek ? this.reply : this.input;
		const text = typing.getValue();
		// M17: Ctrl+J (a bare LF) adds a line; a paste arriving in pieces goes to the editor whole
		// (M48: the reply box too); the open completion menu takes its keys
		if (data === "\n" || typing.inPaste() || (typing.autocompleteOpen() && (key === "tab" || key === "up" || key === "down" || key === "enter" || key === "escape"))) {
			typing.handleInput(data);
			this.o.tui.requestRender();
			return;
		}

		switch (key) {
			case "tab":
				if (!this.peek) this.completeAt();
				return;
			case "ctrl+s":
				return this.toggleGroupBy();
			case "ctrl+l":
				// M23: the model for new sessions, or for the session in the peek
				if (this.peek) {
					const row = this.peekId ? this.rows.get(this.peekId) : undefined;
					if (row) this.sessionSetting(row, "model", "");
					return;
				}
				return this.newModelPicker();
			case "ctrl+p":
				if (this.peek) break;
				return this.cycleModel(1);
			case "shift+ctrl+p":
			case "ctrl+shift+p":
				if (this.peek) break;
				return this.cycleModel(-1);
			case "shift+tab":
				if (this.peek) break;
				return this.cycleThinking();
			case "ctrl+t":
				return void this.togglePin();
			case "ctrl+o":
				if (this.peek) break;
				return this.toggleMark();
			case "ctrl+f":
				if (this.peek) break;
				fill(this.input, "n:");
				this.o.tui.requestRender();
				return;
			case "ctrl+r":
				return this.startRename();
			case "ctrl+g":
				// M48: the reply too
				return void this.editExternally(typing);
			case "alt+up":
				return this.jumpHeader(-1);
			case "alt+down":
				return this.jumpHeader(1);
			case "shift+up":
				return void this.reorder(-1);
			case "shift+down":
				return void this.reorder(1);
			case "up":
			case "down":
				// M17: within a task (M48: or a reply) of several lines the arrows move in the text
				if (typing.multiline() && !typing.atEdge(key)) break;
				return this.moveAndRender(key === "up" ? -1 : 1);
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
			case "alt+enter":
				// M28 (as pi): Alt+Enter queues the reply after the session's current work
				if (this.peek) return void this.sendReply("followUp");
				if (text.trim() && !this.filter() && this.markedRows().length > 0) return void this.sendToMarked("followUp");
				break;
			case "enter":
				return void this.enter();
			case "space":
				if (!text) return this.togglePeek();
				break;
			case "ctrl+y":
				// M45: the concierge's suggested answer goes as the reply (on an empty input)
				if (!text && !this.peek && this.escalation()) return void this.acceptSuggestion();
				break;
			case "ctrl+e":
				if (!text && !this.peek && this.escalation()) return this.editSuggestion();
				break;
			case "?":
				if (!text) {
					// M44: with the concierge on, ? starts a question to it (help: /help)
					if (this.concierge?.on) {
						this.input.setValue("? ");
						this.o.tui.requestRender();
						return;
					}
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
		if (this.markedRows().length > 0) {
			this.marked.clear();
			this.say("marks cleared");
			return;
		}
		// M45: the banner's suggestion is dismissed (it comes back with the next one)
		const esc = this.concierge?.on ? this.escalation() : undefined;
		if (esc?.suggested) {
			this.dismissed.add(`${esc.id}:${esc.suggested.at}`);
			this.say(`dismissed; ${esc.name} still waits (/concierge log has the suggestion)`);
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
		if (this.peek) return this.sendReply("steer");
		// a second Enter while a batch is sent neither sends again nor attaches
		if (this.sendingMarked) return;
		// M25: with rows marked, the typed text goes to each of them
		if (this.input.getValue().trim() && !this.filter() && this.markedRows().length > 0) return this.sendToMarked("steer");
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
	private async editExternally(box: TaskEditor = this.input): Promise<void> {
		const editor = process.env.VISUAL || process.env.EDITOR;
		if (!editor) return this.say("set $VISUAL or $EDITOR to edit the task in an editor", "warning");
		const current = box.getValue();
		const { tui } = this.o;
		let text: string | undefined;
		let dir: string | undefined;
		let stopped = false;
		try {
			dir = mkdtempSync(join(tmpdir(), "pi-roost-task-"));
			const file = join(dir, "task.md");
			writeFileSync(file, current);
			this.attached = true; // the terminal belongs to the editor
			tui.stop({ preserveScreen: true });
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
		// M17: the editor keeps the lines
		box.setValue(text);
		this.o.tui.requestRender();
	}

	// ---- in-view commands (DI-4) -----------------------------------------

	/** Returns true when the command was handled here (and the input consumed). */
	/** M18: not a skill or prompt template (those can be an agent's first prompt). */
	private isViewCommand(name: string): boolean {
		if (name.startsWith("skill:")) return false;
		return !(this.o.commands?.() ?? []).some((c) => c.name === name && (c.source === "prompt" || c.source === "skill"));
	}

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
					// a profile's model is an argument of its own: never one that reads as a flag
					if (arg !== "default" && this.profile && (arg.startsWith("-") || /\s/.test(arg))) {
						this.say(`not a model: ${arg}`, "warning");
						return true;
					}
					if (arg !== "default" && !this.profile && known.length > 0 && !known.includes(arg)) {
						this.say(`unknown model ${arg} (bare /model lists them)`, "warning");
						return true;
					}
					this.model = arg === "default" ? undefined : arg;
					this.say(this.model ? `new sessions use ${this.model}` : "new sessions use the default model");
					return done();
				}
				this.newModelPicker();
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
				this.resume();
				return done();
			case "usage":
				this.showUsage();
				return done();
			case "log":
			case "events":
				void this.showLog();
				return done();
			case "concierge":
				void this.conciergeCommand(arg);
				return done();
			case "ask":
				void this.ask(arg);
				return done();
			case "schedule":
			case "schedules":
				void this.scheduleCommand(arg);
				return done();
			case "fanout": {
				if (arg === "off") {
					this.fanout = undefined;
					this.say("the next task starts one session");
					return done();
				}
				if (arg) {
					const list = [...new Set(arg.split(/[\s,]+/).filter(Boolean))];
					const known = this.o.models?.() ?? [];
					const bad = list.find((m) => !m.includes("/") || (known.length > 0 && !known.includes(m)));
					if (bad) {
						this.say(`unknown model ${bad} (bare /fanout picks them)`, "warning");
						return true;
					}
					if (list.length < 2 || list.length > MAX_FANOUT) {
						this.say(`/fanout takes 2 to ${MAX_FANOUT} models`, "warning");
						return true;
					}
					this.fanout = list;
					this.say(`the next task runs with ${list.length} models, each in its own worktree`);
					return done();
				}
				this.fanoutPicker();
				return done();
			}
			case "compare":
				this.compare();
				return done();
			case "preset":
				if (this.presetCommand(arg)) return done();
				return true;
			case "profile": {
				const names = this.o.profiles?.() ?? [];
				if (!arg) {
					if (names.length === 0) this.say("no agent profiles: add agentProfiles to your roost.json (docs/profiles.md)", "warning");
					else this.openPicker("Agent for new sessions", ["pi", ...names], this.profile ?? "pi", (v) => this.setProfile(v));
					return done();
				}
				if (arg !== "pi" && arg !== "off" && !names.includes(arg)) {
					this.say(`no profile ${arg} (bare /profile lists them)`, "warning");
					return true;
				}
				this.setProfile(arg);
				return done();
			}
		}
		const known = this.o.commands?.().find((c) => c.name === name);
		if (known && (known.source === "prompt" || known.source === "skill")) return false;
		this.say(`/${name} isn't available in agent view`, "warning");
		return true; // the text stays in the input
	}

	/** M30: the agent new sessions run (pi unless a profile is chosen). */
	private setProfile(v: string): void {
		const was = this.profile;
		this.profile = v === "pi" || v === "off" ? undefined : v;
		// a model id is the agent's own: it does not carry over to another agent
		if (was !== this.profile && this.model && (this.profile !== undefined || !this.model.includes("/"))) this.model = undefined;
		this.say(this.profile ? `new sessions run ${this.profile}` : "new sessions run pi");
	}

	private openPicker(title: string, values: string[], current: string, pick: (v: string) => void | Promise<void>): void {
		const items = values.map((v) => ({ label: v, value: v }));
		this.picker = { title, items, index: Math.max(0, values.indexOf(current)), pick };
		this.o.tui.requestRender();
	}

	/**
	 * M23: models to choose from, searchable; the enabled ones (`enabledModels`, what pi
	 * cycles through) first when there are some, Tab for all of them.
	 */
	private modelPicker(title: string, current: string, withDefault: boolean, pick: (v: string) => void | Promise<void>): void {
		const all = this.o.models?.() ?? [];
		const enabled = (this.o.scopedModels?.() ?? []).filter((m) => all.length === 0 || all.includes(m));
		const def = this.o.defaultModel?.();
		const head = withDefault ? [{ label: `default${def ? ` (${def})` : ""}`, value: "default" }] : [];
		const list = (ids: string[]) => [...head, ...ids.map((m) => ({ label: m, value: m }))];
		const items = list(enabled.length > 0 ? enabled : all);
		this.picker = {
			title,
			items,
			index: Math.max(0, items.findIndex((it) => it.value === current)),
			pick,
			...(enabled.length > 0 ? { scope: "enabled models", other: { label: "all models", items: list(all) } } : {}),
		};
		this.o.tui.requestRender();
	}

	/** M23: the model for new sessions (/model, Ctrl+L). */
	private newModelPicker(): void {
		this.modelPicker("Model for new sessions", this.model ?? "default", true, (v) => {
			this.model = v === "default" ? undefined : v;
			this.say(this.model ? `new sessions use ${this.model}` : "new sessions use the default model");
		});
	}

	/** M23: Ctrl+P / Shift+Ctrl+P: the next or previous enabled model for new sessions, as in pi. */
	private cycleModel(step: 1 | -1): void {
		const all = this.o.models?.() ?? [];
		const enabled = (this.o.scopedModels?.() ?? []).filter((m) => all.length === 0 || all.includes(m));
		const ring = enabled.length > 0 ? enabled : all;
		if (ring.length === 0) return this.say("no models available", "warning");
		const at = this.model ? ring.indexOf(this.model) : -1;
		const next = ring[(((at === -1 && step === -1 ? 0 : at) + step) % ring.length + ring.length) % ring.length]!;
		this.model = next;
		this.say(`new sessions use ${next}`);
	}

	/** M23: Shift+Tab: the next thinking level for new sessions, as in pi. */
	private cycleThinking(): void {
		const levels: (string | undefined)[] = [undefined, ...THINKING_LEVELS];
		const at = levels.indexOf(this.thinking);
		this.thinking = levels[(at + 1) % levels.length];
		this.say(`new sessions think ${this.thinking ?? "at the default level"}`);
	}

	/** M23 /resume: pi's own session list when there is one, else the view's. */
	private resume(): void {
		if (this.o.sessionSelector) {
			try {
				const overlay = this.o.sessionSelector({
					cwd: this.dispatchCwd(),
					onSelect: (session) => {
						this.closeOverlay();
						void this.resumeSession(session).catch((err: unknown) => this.say((err as Error).message, "error"));
					},
					onCancel: () => this.closeOverlay(),
					requestRender: () => this.o.tui.requestRender(),
					busy: (path) => [...this.rows.values()].some((r) => r.sessionFile === path && (r.pid !== null || r.endedAt === null)),
				});
				if ("focused" in overlay) overlay.focused = true;
				this.overlay = overlay;
				this.o.tui.requestRender();
				return;
			} catch (err) {
				this.say(`pi's session list is unavailable (${oneLine((err as Error).message)}): the simple one`, "warning");
			}
		}
		void this.resumePicker();
	}

	/**
	 * M39 /schedule: `<name> <when> <task>` adds one (a pi session with the view's model,
	 * thinking and directory); `list` (or bare), `run`, `pause`, `resume`, `rm <name>`.
	 */
	private async scheduleCommand(arg: string): Promise<void> {
		const client = this.client;
		if (!client) return this.say("background service unavailable", "error");
		const words = arg.trim().split(/\s+/).filter(Boolean);
		try {
			if (words.length === 0 || (words.length === 1 && words[0] === "list")) return await this.showSchedules();
			const [verb, name] = words as [string, string | undefined];
			if (words.length === 2 && name && ["rm", "pause", "resume", "run"].includes(verb)) {
				if (verb === "rm") {
					await client.request("schedule-rm", { name });
					return this.say(`schedule ${name} removed`);
				}
				if (verb === "run") {
					const r = await client.request("schedule-run", { name });
					this.cursor = { kind: "row", id: r.id };
					return this.say(`schedule ${name} started a run`, "success");
				}
				const r = await client.request("schedule-pause", { name, paused: verb === "pause" });
				return this.say(r.paused || r.nextAt === null ? `schedule ${name} paused` : `schedule ${name}: next run ${untilText(r.nextAt)}`, "success");
			}
			const p = parseScheduleInput(arg);
			if ("error" in p) return this.say(p.error, "warning");
			const dir = this.presetDir();
			if (dir && "error" in dir) return this.say(dir.error, "warning");
			const cwd = dir?.path ?? this.dispatchCwd();
			// M40: what runs: a ! command, the profile's agent, else a pi session (the view's choices)
			let launch: DispatchArgs;
			if (p.task.startsWith("!")) {
				const command = p.task.slice(1).trim();
				if (!command) return this.say("! needs a command", "warning");
				if (!this.o.launchShell) return this.say("shell jobs are not available here", "warning");
				launch = this.o.launchShell(command, cwd);
			} else if (this.profile) {
				if (!this.o.launchProfile) return this.say("agent profiles are not available here", "warning");
				const { discard: _d, note: _n, ...rest } = this.o.launchProfile(this.profile, p.task, { cwd, model: this.model, thinking: this.thinking, worktree: false });
				launch = rest;
			} else {
				if (!this.o.scheduleLaunch) return this.say("schedules are not available here", "warning");
				const { discard: _d, note: _n, ...rest } = this.o.scheduleLaunch(p.task, { cwd, model: this.model, thinking: this.thinking });
				launch = rest;
			}
			const r = await client.request("schedule-add", { name: p.name, when: p.when, launch, task: p.task });
			this.say(`schedule ${r.name}: ${r.when} · first run ${r.nextAt === null ? "never" : untilText(r.nextAt)}`, "success");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M39 /schedule list: each schedule, when it runs next, its last run; Esc closes. */
	private async showSchedules(): Promise<void> {
		const list = (await this.client!.request("schedules", {})).schedules;
		if (list.length === 0) return this.say('no schedules: /schedule <name> <every 1h | daily 09:00 | weekdays 09:00 | cron "…"> <task>');
		let top = 0;
		const view = this;
		const lines = (width: number): string[] => {
			const t = view.o.theme;
			const now = Date.now();
			const out = [t.bold("Schedules"), ""];
			for (const s of list) {
				const next = s.paused ? t.fg("warning", "paused") : s.nextAt === null ? "never" : `next ${untilText(s.nextAt, now)}`;
				const last = s.lastRunAt ? `last ${agoText(now - s.lastRunAt)} ago` : "not run yet";
				out.push(truncateToWidth(`${t.fg("accent", s.name)}  ${s.when}  · ${next} · ${last}`, width));
				out.push(t.fg("dim", truncateToWidth(`  ${oneLine(s.task ?? "")}  · ${s.agent} · ${s.cwd}${s.model ? ` · ${s.model}` : ""}`, width)));
				if (s.lastSkip) out.push(t.fg("warning", truncateToWidth(`  skipped ${agoText(now - s.lastSkip.at)} ago: ${oneLine(s.lastSkip.why)}`, width)));
			}
			return out;
		};
		this.overlay = {
			render(width: number) {
				const all = lines(width);
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				top = Math.max(0, Math.min(top, all.length - room));
				const keys = view.o.theme.fg("dim", truncateToWidth("/schedule run|pause|resume|rm <name> · ↑↓ scroll · Esc close", width));
				return [...all.slice(top, top + room), "", keys];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (key === "up") top = Math.max(0, top - 1);
				else if (key === "down") top++;
			},
		};
		this.o.tui.requestRender();
	}

	/** M24 /usage: what the sessions spent, by model and by session; Esc closes, ↑↓ scroll. */
	private showUsage(): void {
		let top = 0;
		const view = this;
		this.overlay = {
			render(width: number) {
				const lines = view.usageLines(width);
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				top = Math.max(0, Math.min(top, lines.length - room));
				const keys = view.o.theme.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width));
				return [...lines.slice(top, top + room), "", keys];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (key === "up") top = Math.max(0, top - 1);
				else if (key === "down") top++;
				else if (key === "pageUp") top = Math.max(0, top - 10);
				else if (key === "pageDown") top += 10;
			},
		};
		this.o.tui.requestRender();
	}

	/** M43 /log: what happened lately across the sessions (newest first); r reloads, Esc closes. */
	private async showLog(only?: (e: RoostEvent) => boolean, title = "Log · what happened lately (newest first)"): Promise<void> {
		const client = this.client;
		if (!client) return this.say("background service unavailable", "error");
		let events: RoostEvent[];
		const fetch = async () => (await client.request("events", { limit: 500 })).events.filter((e) => !only || only(e)).slice(-200);
		try {
			events = await fetch();
		} catch (err) {
			return this.say((err as Error).message, "error");
		}
		if (events.length === 0) return this.say(only ? "nothing from the concierge yet" : "nothing happened yet (the log starts with the next task, reply or message)");
		let top = 0;
		const view = this;
		const lines = (width: number): string[] => {
			const t = view.o.theme;
			const now = Date.now();
			const out = [t.bold(truncateToWidth(title, width)), ""];
			for (const e of [...events].reverse()) {
				const tone =
					e.kind === "state" && e.state === "failed"
						? "error"
						: e.kind === "state" && e.state === "blocked"
							? "warning"
							: e.kind === "state" && e.state === "done"
								? "success"
								: e.kind === "message" || e.kind === "report" || e.kind === "notice"
									? "accent"
									: "muted";
				out.push(truncateToWidth(`  ${t.fg("dim", eventAgo(e.at, now).padStart(4))}  ${t.fg(tone, oneLine(eventLine(e)))}`, width));
			}
			return out;
		};
		this.overlay = {
			render(width: number) {
				const all = lines(width);
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				top = Math.max(0, Math.min(top, all.length - room));
				const keys = view.o.theme.fg("dim", truncateToWidth("r reload · ↑↓ scroll · Esc close", width));
				return [...all.slice(top, top + room), "", keys];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (data === "r") {
					void fetch()
						.then((r) => {
							events = r;
							view.o.tui.requestRender();
						})
						.catch(() => {});
				} else if (key === "up") top = Math.max(0, top - 1);
				else if (key === "down") top++;
				else if (key === "pageUp") top = Math.max(0, top - 10);
				else if (key === "pageDown") top += 10;
			},
		};
		this.o.tui.requestRender();
	}

	/** M44 /concierge on|off|status|log|attach|ask …: the hub's resident agent. */
	private async conciergeCommand(arg: string): Promise<void> {
		const client = this.client;
		if (!client) return this.say("background service unavailable", "error");
		const [verb = "status", ...rest] = arg.trim().split(/\s+/).filter(Boolean);
		try {
			if (verb === "on") {
				if (this.concierge?.on) return this.say(this.conciergeLine(), "muted");
				// the job it had is started again; a first start needs a launch
				if (this.concierge?.id) this.concierge = await client.request("concierge", { action: "on" });
				else {
					if (!this.o.conciergeLaunch) return this.say("the concierge is not available here", "warning");
					const { discard: _d, note: _n, ...launch } = this.o.conciergeLaunch();
					this.concierge = await client.request("concierge", { action: "on", launch });
				}
				return this.say(`concierge on (${this.concierge.model ?? "its model"}) · ? asks it · /concierge off stops it`, "success");
			}
			if (verb === "off") {
				this.concierge = await client.request("concierge", { action: "off" });
				this.asked(false);
				return this.say("concierge off", "muted");
			}
			if (verb === "status") {
				this.concierge = await client.request("concierge", { action: "status" });
				return this.say(this.concierge.on ? this.conciergeLine() : "concierge off · /concierge on starts it", "muted");
			}
			if (verb === "log") return await this.showLog((e) => e.kind === "concierge" || (!!this.concierge?.id && (e.whoId === this.concierge.id || e.id === this.concierge.id)), "Concierge · what it did and said (newest first)");
			if (verb === "attach") {
				if (!this.concierge?.id) return this.say("no concierge session yet (/concierge on)", "warning");
				return await this.attachTo(this.concierge.id);
			}
			if (verb === "ask") return await this.ask(rest.join(" "));
			// M45: the policy, and the undo
			if (verb === "answer") {
				const answer = rest[0];
				if (!answer) return this.say(`concierge answers: ${this.concierge?.policy.answer ?? "never"} · /concierge answer never|routine|always`, "muted");
				if (answer !== "never" && answer !== "routine" && answer !== "always") return this.say("/concierge answer never | routine | always", "warning");
				this.concierge = await client.request("concierge", { action: "answer", answer });
				return this.say(
					answer === "never"
						? "concierge answers: never (it suggests; you answer)"
						: answer === "routine"
							? "concierge answers: routine questions by itself (proceed/confirm, the obvious default, what is in the fleet); the rest it suggests · /concierge undo withdraws one"
							: "concierge answers: whatever it can; irreversible questions it still suggests · /concierge undo withdraws one",
					"success",
				);
			}
			if (verb === "act") {
				const v = rest[0];
				if (v !== "on" && v !== "off") return this.say(`concierge act: ${this.concierge?.policy.act ? "on" : "off"} · /concierge act on|off (may it start, stop and restart sessions)`, "muted");
				this.concierge = await client.request("concierge", { action: "act", act: v === "on" });
				return this.say(v === "on" ? "concierge may start, stop and restart sessions (when you ask it to)" : "concierge may not start, stop or restart sessions", "success");
			}
			if (verb === "undo") {
				this.concierge = await client.request("concierge", { action: "undo" });
				const a = this.concierge.answered;
				return this.say(a ? `withdrawn: the answer to ${a.name} («${oneLine(a.text).slice(0, 60)}»); it is told to disregard it and ask you` : "nothing to undo", "success");
			}
			// M46: the standing orders: the list, one more (the concierge keeps it, in its words), one less
			if (verb === "orders") {
				const [sub, ...more] = rest;
				if (sub === "add") {
					// the user's own (the concierge may not drop it); a clock first, in roost's words
					// (a clock in plain words, "every evening", is for `? remember …`: the concierge keeps it)
					const words = more.join(" ").trim();
					if (!words) return this.say('/concierge orders add [every 30m | daily 18:00 | weekdays 09:00 | cron "…"] <the rule, in your words>', "warning");
					const m = /^(every\s+\d+\s*[mhd]|daily\s+\d{1,2}:\d{2}|weekdays\s+\d{1,2}:\d{2}|cron\s+"[^"]+")\s+(.+)$/i.exec(words);
					// starts like a clock but is not one in roost's words: said, not kept as prose by mistake
					if (!m && /^(every|daily|weekdays|cron)\b/i.test(words)) {
						return this.say('that starts like a clock but is not one in roost\'s words: every 30m | daily 18:00 | weekdays 09:00 | cron "m h dom mon dow" (one minute at least), then the rule; or word the rule differently', "warning");
					}
					const when = m?.[1];
					const { order } = await client.request("concierge-order", { action: "add", text: m ? m[2]! : words, ...(when ? { when } : {}) });
					return this.say(`kept standing order #${order?.id}${when ? ` (${when})` : ""}; the concierge sees it on its next wake`, "success");
				}
				if (sub === "rm") {
					const id = Number(more[0]);
					if (!Number.isInteger(id)) return this.say("/concierge orders rm <id>", "warning");
					await client.request("concierge-order", { action: "rm", id });
					return this.say(`dropped standing order #${id}`, "success");
				}
				if (sub) return this.say("/concierge orders | orders add <rule> | orders rm <id>", "warning");
				const { orders } = await client.request("concierge-order", { action: "list" });
				if (orders.length === 0) return this.say("no standing orders · /concierge orders add <rule> (or tell the concierge: ? remember …)", "muted");
				return this.showOrders(orders);
			}
			this.say("/concierge on | off | status | log | attach | ask <question> | answer never|routine|always | act on|off | undo | orders [add <rule> | rm <id>]", "warning");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M44: the status line under the header. */
	private conciergeLine(): string {
		const c = this.concierge;
		if (!c?.on) return "";
		const now = Date.now();
		const parts = ["concierge"];
		const a = c.answered;
		if (c.overBudget) parts.push(`over its budget for today (${formatCost(c.budget)}): not woken`);
		// M45: an answer it gave in the user's place, for a minute, with the undo
		else if (a && !a.undone && now - a.at < 60_000) parts.push(`answered ${a.name}: ${oneLine(a.text).slice(0, 80)} (${eventAgo(a.at, now)} ago) · /concierge undo`);
		else if (c.notice) parts.push(`${c.notice.kind === "need" ? "needs you: " : ""}${oneLine(c.notice.text)} (${eventAgo(c.notice.at, now)} ago)`);
		else parts.push(c.lastWakeAt ? `quiet · last wake ${eventAgo(c.lastWakeAt, now)} ago` : "quiet");
		if (c.behind > 0 && !c.overBudget) parts.push(`${c.behind} new`);
		if (c.policy.answer !== "never") parts.push(`answers ${c.policy.answer}`);
		if (c.policy.act) parts.push("acts");
		if (c.costToday > 0) parts.push(`${formatCost(c.costToday)} today`);
		return parts.join(" · ");
	}

	/** M45: the row the banner is about: the selected one if it waits with a suggestion, else the longest waiting. */
	private escalation(): JobRow | undefined {
		// dismissals of suggestions that are gone are forgotten
		for (const k of this.dismissed) {
			const [id, at] = k.split(":");
			const r = id ? this.rows.get(id) : undefined;
			if (!r?.suggested || String(r.suggested.at) !== at) this.dismissed.delete(k);
		}
		const has = (r: JobRow | undefined): r is JobRow => !!r?.suggested && r.state === "blocked" && !this.dismissed.has(`${r.id}:${r.suggested.at}`);
		const sel = this.selectedRow();
		if (has(sel)) return sel;
		return [...this.rows.values()].filter(has).sort((a, b) => a.stateSince - b.stateSince)[0];
	}

	private escalationLine(row: JobRow, now: number): string {
		const s = row.suggested!;
		const q = row.question ? `asks: ${oneLine(row.question)}` : `waits for ${row.waitingFor ?? "input"}`;
		const why = s.why ? ` (${oneLine(s.why)})` : "";
		return `needs you · ${row.name} ${q} (${formatDuration(now - row.stateSince)}) · concierge suggests: ${oneLine(s.text)}${why} · Ctrl+Y sends it · Ctrl+E edits · Esc dismisses`;
	}

	/** Ctrl+Y: the suggestion goes as the user's reply. */
	private async acceptSuggestion(): Promise<void> {
		const row = this.escalation();
		if (!row?.suggested || !this.client) return;
		const text = row.suggested.text;
		// once: a second press before the row moves would answer its next question (the
		// banner is back if the send did not go)
		const key = `${row.id}:${row.suggested.at}`;
		this.dismissed.add(key);
		try {
			const r = await this.client.request("reply", { id: row.id, text, requestId: `hub-accept-${row.id}-${row.suggested.at}`.slice(0, 64) });
			if (r.delivered || r.saved) this.say(`sent to ${row.name}: ${oneLine(text).slice(0, 80)}`, "success");
			else {
				this.dismissed.delete(key);
				this.say(`not delivered: ${row.name} is not running`, "error");
			}
		} catch (err) {
			this.dismissed.delete(key);
			this.say((err as Error).message, "error");
		}
	}

	/** Ctrl+E: the suggestion in the reply box of that row's peek, to edit before sending. */
	private editSuggestion(): void {
		const row = this.escalation();
		if (!row?.suggested) return;
		this.cursor = { kind: "row", id: row.id };
		if (!this.peek || this.peekId !== row.id) {
			this.peek = true;
			this.peekId = row.id;
			this.reply.focused = true;
			this.input.focused = false;
		}
		fill(this.reply, row.suggested.text);
		this.o.tui.requestRender();
	}

	/** M46: the standing orders, newest first. */
	private showOrders(orders: StandingOrder[]): void {
		let top = 0;
		const view = this;
		const lines = (width: number): string[] => {
			const t = view.o.theme;
			const now = Date.now();
			const out = [t.bold(truncateToWidth("Standing orders · what the concierge keeps in mind", width)), ""];
			for (const o of [...orders].reverse()) {
				const by = o.by === "concierge" ? "" : t.fg("dim", " · yours");
				out.push(truncateToWidth(`  ${t.fg(o.when ? "accent" : "muted", oneLine(orderLine(o, now)))}${by}`, width));
			}
			out.push("", t.fg("dim", truncateToWidth("/concierge orders add <rule> · /concierge orders rm <id>", width)));
			return out;
		};
		this.overlay = {
			render(width: number) {
				const all = lines(width);
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				top = Math.max(0, Math.min(top, all.length - room));
				return [...all.slice(top, top + room), "", view.o.theme.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (key === "up") top = Math.max(0, top - 1);
				else if (key === "down") top++;
			},
		};
		this.o.tui.requestRender();
	}

	/** M44: `? …`: a question to the concierge; its answer opens in an overlay. */
	private async ask(question: string): Promise<void> {
		const q = question.trim();
		if (!q) return this.say("? needs a question, e.g. ? what is blocked and why", "warning");
		if (!this.client) return this.say("background service unavailable", "error");
		if (!this.concierge?.on) return this.say("the concierge is off: /concierge on starts it", "warning");
		try {
			await this.client.request("concierge-ask", { text: q });
			this.asked(true);
			this.input.setValue("");
			this.say("asked the concierge; its answer opens here", "muted");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** A question is awaited, or not (an answer came; it went off; two minutes passed). */
	private asked(on: boolean): void {
		clearTimeout(this.askTimer);
		this.askTimer = undefined;
		this.asking = on;
		if (!on) return;
		this.askTimer = setTimeout(() => {
			this.askTimer = undefined;
			if (!this.asking) return;
			this.asking = false;
			this.say("the concierge has not answered (/concierge attach to see why)", "warning");
		}, 120_000);
		this.askTimer.unref?.();
	}

	private showAnswer(answer: string): void {
		let top = 0;
		const view = this;
		this.overlay = {
			render(width: number) {
				const t = view.o.theme;
				const clean = stripTerminalSequences(answer).replace(/\t/g, "  ").replace(CONTROL, "");
				const body = wrapTextWithAnsi(clean, Math.max(4, width - 2)).map((l) => `  ${l}`);
				const all = [t.bold(truncateToWidth("Concierge", width)), "", ...body];
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				top = Math.max(0, Math.min(top, all.length - room));
				return [...all.slice(top, top + room), "", t.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (key === "up") top = Math.max(0, top - 1);
				else if (key === "down") top++;
			},
		};
		this.o.tui.requestRender();
	}

	private usageLines(width: number): string[] {
		const t = this.o.theme;
		const now = Date.now();
		const rows = [...this.rows.values()].filter((r) => r.usage && (r.usage.cost > 0 || r.usage.input + r.usage.output > 0));
		const tot = totalUsage(rows, now);
		const fit = (s: string) => truncateToWidth(s, width);
		const out = [t.bold(fit("Usage · sessions in this view")), ""];
		if (rows.length === 0) return [...out, t.fg("dim", fit("  nothing spent yet (sessions report what they spend as they work)"))];
		const sub = tot.subCost > 0 ? ` · ${formatCost(tot.subCost)} of it on a subscription (as if billed per token)` : "";
		out.push(fit(`  today ${formatCost(tot.today)} · all ${formatCost(tot.cost)} · ${formatTokens(tot.tokens)} tokens${sub}`), "");
		const col = (s: string, n: number) => (visibleWidth(s) >= n ? truncateToWidth(s, n) : s + " ".repeat(n - visibleWidth(s)));
		const nameW = Math.max(12, Math.min(40, Math.floor(width / 2.5)));
		out.push(t.bold(fit("  By model")));
		const models = Object.entries(tot.models).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
		for (const [m, v] of models) {
			out.push(fit(`  ${col(shortModel(m), nameW)}  ${formatCost(v.cost).padStart(8)}  ${formatTokens(v.tokens).padStart(6)} tok  ${v.sessions} session${v.sessions === 1 ? "" : "s"}`));
		}
		out.push("", t.bold(fit("  By session")));
		const sorted = rows.sort((a, b) => b.usage!.cost - a.usage!.cost);
		for (const r of sorted) {
			const u = r.usage!;
			const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
			const today = todayOf(u, now);
			out.push(
				fit(
					`  ${col(oneLine(r.name), nameW)}  ${formatCost(u.cost).padStart(8)}  ${formatTokens(tokens).padStart(6)} tok${today > 0 ? `  ${formatCost(today)} today` : ""}${u.sub ? t.fg("dim", "  (sub)") : ""}  ${t.fg("dim", r.model ? shortModel(r.model) : "")}`,
				),
			);
		}
		return out;
	}

	private closeOverlay(): void {
		try {
			this.overlay?.dispose?.();
		} catch {}
		this.overlay = undefined;
		// M44: the concierge's answer that waited for this to close
		if (this.pendingAnswer !== undefined) {
			const answer = this.pendingAnswer;
			this.pendingAnswer = undefined;
			this.showAnswer(answer);
			return;
		}
		this.o.tui.requestRender();
	}

	/**
	 * M23: into a past session at once: its row when it has one (started again if it
	 * ended), else a new background job on it, attached as soon as it runs.
	 */
	private async resumeSession(s: Resumable): Promise<void> {
		if (s.path === this.o.currentSession?.()) return this.say("that is this pi's own session", "warning");
		const row = [...this.rows.values()].find((r) => r.sessionFile === s.path);
		if (row) {
			this.cursor = { kind: "row", id: row.id };
			// chosen on purpose: no "Enter again to start it"
			this.restartAsk = { id: row.id, at: Date.now() };
			return this.attachTo(row.id);
		}
		if (!this.client) return this.say("background service unavailable", "error");
		const args = this.o.launch("", { cwd: s.cwd || this.dispatchCwd(), sessionFile: s.path, name: s.name, origin: "adopt" });
		let r: { id: string; name: string };
		try {
			r = await this.client.request("dispatch", args);
		} catch (err) {
			args.discard?.();
			const e = err as DaemonError;
			if (e.code === "locked") return this.say(`${oneLine(s.name)} is open in another pi window`, "warning");
			throw err;
		}
		this.cursor = { kind: "row", id: r.id };
		this.say(`resuming ${oneLine(r.name)}…`, "accent");
		// its first push may have come before this reply
		if (this.rows.get(r.id)?.pid) {
			if (!this.attached) void this.attachTo(r.id).catch((err: unknown) => this.say(String(err), "error"));
		} else this.attachWhenLive = r.id;
	}

	private pickerKey(key: string | undefined, data = ""): void {
		const p = this.picker!;
		const shown = pickerShown(p);
		if (key === "escape" || key === "ctrl+c") {
			// M23: Esc clears the search first
			if (p.query) {
				p.query = "";
				p.index = 0;
			} else this.picker = undefined;
		} else if (key === "up") p.index = Math.max(0, p.index - 1);
		else if (key === "down") p.index = Math.min(shown.length - 1, p.index + 1);
		else if (key === "pageUp") p.index = Math.max(0, p.index - 10);
		else if (key === "pageDown") p.index = Math.min(shown.length - 1, p.index + 10);
		else if (key === "tab" && p.other) {
			// M23: the enabled models and all of them (the one selected stays selected)
			const items = p.items;
			const scope = p.scope;
			const was = shown[p.index]?.value;
			p.items = p.other.items;
			p.scope = p.other.label;
			p.other = { label: scope ?? "", items };
			p.index = Math.max(0, pickerShown(p).findIndex((it) => it.value === was));
		} else if (key === "backspace") {
			p.query = (p.query ?? "").slice(0, -1);
			p.index = 0;
		} else if (key === "enter") {
			// nothing matches: the search stays to be changed
			if (shown.length === 0) return this.o.tui.requestRender();
			this.picker = undefined;
			const item = shown[p.index];
			if (item) void Promise.resolve(p.pick(item.value)).catch((err: unknown) => this.say((err as Error).message, "error"));
		} else {
			// M23: typing searches (a paste too, its lines joined; a kitty-encoded key is decoded)
			const pasted = data.startsWith("\x1b[200~") ? data.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n\t]+/g, " ") : undefined;
			const text = pasted ?? (isKeyRelease(data) ? undefined : (decodeKittyPrintable(data) ?? data));
			if (text && !text.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(text)) {
				p.query = (p.query ?? "") + text;
				p.index = 0;
			}
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
			sessions = await this.o.resumable(cwd);
		} catch (err) {
			return this.say((err as Error).message, "error");
		}
		if (sessions.length === 0) return this.say("no past sessions to resume here");
		const byPath = new Map(sessions.map((s) => [s.path, s]));
		this.picker = {
			title: "Resume a session in the background",
			items: sessions.slice(0, 200).map((s) => ({
				label: `${oneLine(s.name)} · ${formatAgo(Date.now() - s.modified)}${known.has(s.path) ? " · listed" : ""}`,
				value: s.path,
			})),
			index: 0,
			pick: (path) => this.resumeSession(byPath.get(path)!),
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
		// M17: only the word being typed changes; a folded paste before it stays folded
		this.input.replaceTail(prefix.length, `${first} `);
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
		// a peek acts on its own row, never on the marks
		const marked = this.peek ? [] : this.markedRows();
		if (marked.length > 0 && this.client) {
			// M25: pin them all, unless all are pinned already
			const pinned = marked.some((r) => !r.pinned);
			let failed = 0;
			for (const r of marked) {
				try {
					await this.client.request("pin", { id: r.id, pinned });
				} catch {
					failed++;
				}
			}
			return this.say(`${pinned ? "pinned" : "unpinned"} ${marked.length - failed} sessions${failed ? ` · ${failed} failed` : ""}`, failed ? "warning" : "muted");
		}
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
		const typed = this.input.getValue();
		// M44: `? …` is a question for the concierge, not a task (`?foo` is a task)
		if (typed.trim() === "?" || typed.trimStart().startsWith("? ")) return this.ask(typed.trim().slice(1).trim());
		const base = this.dispatchCwd();
		// M18 (Claude Code): a first word or `@name` naming an agent runs the task as it
		// (read once per Enter: it scans the agent folders)
		let found: ReadonlyMap<string, AgentDef> | undefined;
		const agents = () => (found ??= this.o.agents?.() ?? new Map());
		// M30: a profile's agent has no pi agents to pick from
		const picked = this.o.agents && !this.profile && !/^[!/]/.test(typed.trim()) ? pickAgent(typed, agents()) : undefined;
		const parsed = parseInput(picked ? picked.task : typed, base);
		if (parsed.kind === "command") {
			if (picked && this.isViewCommand(parsed.name)) return this.say(`${picked.agent.name} runs a task, not /${parsed.name}`, "warning");
			const handled = this.command(parsed.name, parsed.arg);
			if (handled) return;
			// DI-5: skills and prompt templates run as the job's first prompt
		}
		let args: LaunchRequest;
		if (parsed.kind === "shell") {
			if (!parsed.command) return this.say("! needs a command", "warning");
			if (picked) return this.say(`${picked.agent.name} runs a task, not a ! command`, "warning");
			if (!this.o.launchShell) return this.say("shell jobs are not available here", "warning");
			const dir = parsed.cwd ? undefined : this.presetDir();
			if (dir && "error" in dir) return this.say(dir.error, "warning");
			args = this.o.launchShell(parsed.command, parsed.cwd ?? dir?.path ?? base);
		} else {
			const task = parsed.kind === "task" ? parsed.task : (picked ? picked.task : typed).trim();
			if (task.length < MIN_TASK) return this.say("Too short", "warning");
			// M27: a typed @dir or agent wins over the preset's
			const typedDir = parsed.kind === "task" ? parsed.cwd : undefined;
			const dir = typedDir ? undefined : this.presetDir();
			if (dir && "error" in dir) return this.say(dir.error, "warning");
			const cwd = typedDir ?? dir?.path ?? base;
			if (this.profile) {
				if (this.fanout) return this.say(`fan-out runs pi sessions (/profile pi, or /fanout off for one ${this.profile})`, "warning");
				if (!this.o.launchProfile) return this.say("agent profiles are not available here", "warning");
				try {
					args = this.o.launchProfile(this.profile, task, { cwd, model: this.model, thinking: this.thinking, worktree: this.worktree });
				} catch (err) {
					return this.say((err as Error).message, "error");
				}
			} else {
				const fallback = this.preset?.agent ?? this.o.defaultAgent;
				const agent = picked?.agent ?? (fallback ? findAgent(agents(), fallback) : undefined);
				if (fallback && !agent) return this.say(`${this.preset?.agent ? "the preset's agent" : "dispatchAgent"} ${fallback} is not an agent here`, "warning");
				// M26: one session per model
				if (this.fanout) return this.dispatchFanout(task, cwd, agent, typed, attach);
				try {
					args = this.o.launch(task, { cwd, model: this.model, thinking: this.thinking, worktree: this.worktree, ...(agent ? { agent } : {}) });
				} catch (err) {
					return this.say((err as Error).message, "error");
				}
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

	/** M28: Enter steers into the work under way (pi's Enter); Alt+Enter waits for it (pi's Alt+Enter). */
	private async sendReply(mode: ReplyMode = "steer"): Promise<void> {
		const row = this.peekId ? this.rows.get(this.peekId) : undefined;
		const text = this.reply.getValue().trim();
		if (!row) {
			this.closePeek();
			return this.say("that session no longer exists", "warning");
		}
		if (!text || !this.client) return;
		// M48: a /command in a peek is for that session (M8: /model and /thinking among them)
		const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		if (cmd) {
			try {
				await this.peekCommand(row, cmd[1]!.toLowerCase(), (cmd[2] ?? "").trim());
			} catch (err) {
				this.say((err as Error).message, "error");
			}
			return;
		}
		if (text.startsWith("!")) return this.say("shell commands are not sent to a session; attach (→) to run one", "warning");
		try {
			const r = await this.client.request("reply", { id: row.id, text, mode });
			this.reply.setValue("");
			if (r.stopped) this.say(`stopped · ${row.name}`);
			else if (r.delivered) {
				const how = row.state !== "working" ? "" : mode === "steer" ? " · joins its current work" : " · after its current work";
				this.say(row.waitingFor === "dialog" ? "queued; attach (→) to answer the dialog" : `sent · ${row.name}${how}`, "success");
			} else if (r.respawned) this.say(`sent · starting ${row.name} again`, "success");
			else if (r.saved) this.say(`saved; it is sent when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else this.say("not delivered: the session is not running", "error");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M48: a `/command` typed in a peek acts on that session (the keys' code, by name). */
	private async peekCommand(row: JobRow, name: string, arg: string): Promise<void> {
		const client = this.client;
		if (!client) return this.say("background service unavailable", "error");
		const done = () => {
			this.reply.setValue("");
			this.o.tui.requestRender();
		};
		switch (name) {
			case "model":
			case "thinking":
				// M8: with the same pickers as for new sessions
				return this.sessionSetting(row, name, arg);
			case "stop":
				done();
				if (row.pid === null) return this.say(`${row.name} is not running`, "warning");
				await client.request("stop", { id: row.id });
				return this.say(`stopping · ${row.name}`, "warning");
			case "respawn": {
				done();
				const r = await client.request("respawn", { id: row.id });
				const first = r.results[0];
				return first?.started ? this.say(`starting ${row.name} again`, "success") : this.say(first?.error ?? `${row.name} was not started`, "warning");
			}
			case "rm": {
				// twice within 2 s, as Ctrl+X Ctrl+X
				done();
				const now = Date.now();
				if (this.armedStop?.id === row.id && now - this.armedStop.at < DOUBLE_PRESS_MS) {
					this.armedStop = undefined;
					const res = await client.request("rm", { id: row.id });
					this.closePeek();
					return this.say(`deleted · ${row.name}${res.worktree ? ` · ${cleanupText(res.worktree)}` : ""}`);
				}
				this.armedStop = { id: row.id, at: now };
				return this.say(`/rm again within 2 s to delete ${row.name}${row.pid !== null ? " (it is running: it is stopped first)" : ""}`, "warning");
			}
			case "pin":
				done();
				return this.togglePin();
			case "rename": {
				done();
				if (!arg) return this.startRename();
				await client.request("rename", { id: row.id, name: arg });
				return this.say(`renamed · ${arg}`, "success");
			}
			case "attach":
				done();
				return this.attachSelected();
			case "log":
				done();
				return this.showLog((e) => e.id === row.id || e.whoId === row.id, `Log · ${oneLine(row.name)} (newest first)`);
			case "transcript":
				done();
				return this.showTranscript(row);
			case "continue":
				this.reply.setValue("Continue where you left off.");
				return this.sendReply("followUp");
			case "ask":
				done();
				if (!arg) return this.say("/ask <a question about this session>", "warning");
				return this.ask(`About the session ${row.name} (${row.id}): ${arg}`);
			case "name":
			case "compact": {
				// pi's own, run in the session by the worker
				if (name === "name" && !arg) return this.say("/name <the session's own name>", "warning");
				if (row.kind === "shell") return this.say(`/${name} is for a pi session`, "warning");
				const r = await client.request("reply", { id: row.id, text: `/${name}${arg ? ` ${arg}` : ""}` });
				done();
				if (r.delivered) return this.say(`/${name} · ${row.name}`, "success");
				return this.say(r.saved ? `saved; it runs when ${row.name} starts again` : `not delivered: ${row.name} is not running`, "warning");
			}
			default:
				return this.say(`not a command for a session: /${name} · ${PEEK_COMMANDS.map((c) => `/${c.name}`).join(" ")}`, "warning");
		}
	}

	/** M48 /transcript in a peek: its transcript (a terminal agent: its screen), the end first in view; r reloads. */
	private showTranscript(row: JobRow): void {
		const view = this;
		const t = this.o.theme;
		let body: string[] = [];
		let top = -1; // -1: the end
		const load = (width: number): string[] => {
			const inner = Math.max(1, width - 2);
			const out: string[] = [];
			try {
				if (row.kind === "shell" || !row.sessionFile) {
					for (const l of readFileSync(screenPath(row.id), "utf8").trimEnd().split("\n")) out.push(truncateToWidth(l.replace(CONTROL, " "), inner));
				} else {
					const tail = readTail(row.sessionFile);
					for (const it of transcriptItems(tail.text, tail.truncated)) {
						const text =
							it.kind === "tool"
								? `⚙ ${it.name}${it.args ? ` ${it.args}` : ""}${it.result ? `\n  → ${it.result}` : ""}`
								: it.kind === "user"
									? `you: ${it.text}`
									: it.kind === "assistant"
										? `› ${it.text}`
										: `· ${it.text}`;
						// a long result shows its first lines
						for (const l of text.replace(CONTROL, " ").split("\n").slice(0, 24)) for (const w of wrap(l, inner)) out.push(it.kind === "assistant" ? w : t.fg(it.kind === "user" ? "accent" : it.kind === "tool" && it.error ? "error" : "muted", w));
						out.push("");
					}
				}
			} catch {
				out.push(t.fg("dim", "(nothing to read yet)"));
			}
			return out.length > 0 ? out : [t.fg("dim", "(empty)")];
		};
		this.overlay = {
			render(width: number) {
				if (body.length === 0) body = load(width);
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				const all = [t.bold(truncateToWidth(`Transcript · ${oneLine(row.name)}`, width)), "", ...body];
				if (top < 0) top = Math.max(0, all.length - room);
				top = Math.max(0, Math.min(top, Math.max(0, all.length - room)));
				return [...all.slice(top, top + room), "", t.fg("dim", truncateToWidth("r reload · ↑↓ PgUp PgDn scroll · Esc close", width))];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (data === "r") {
					body = [];
					top = -1;
				} else if (key === "up") top = Math.max(0, top - 1);
				else if (key === "down") top++;
				else if (key === "pageUp") top = Math.max(0, top - 10);
				else if (key === "pageDown") top += 10;
			},
		};
		this.o.tui.requestRender();
	}

	/** M48: pi's own completion (pi-tui) for a box: `/` its commands, `@` paths under its directory (fuzzy with fd). */
	private completion(commands: () => SlashCommand[], base: () => string): AutocompleteProvider {
		const fresh = () => new CombinedAutocompleteProvider(commands(), base());
		return {
			triggerCharacters: ["/", "@"],
			getSuggestions: (lines, line, col, options) => fresh().getSuggestions(lines, line, col, options),
			applyCompletion: (lines, line, col, item, prefix) => fresh().applyCompletion(lines, line, col, item, prefix),
			shouldTriggerFileCompletion: (lines, line, col) => fresh().shouldTriggerFileCompletion(lines, line, col),
		};
	}

	/** The task box's commands: the view's, then pi's prompt templates and skills (an agent's first prompt). */
	private viewCommands(): SlashCommand[] {
		const levels = () => [...THINKING_LEVELS].map((v) => ({ value: v, label: v }));
		const models = () => (this.o.models?.() ?? []).map((m) => ({ value: m, label: m }));
		const names = (list: string[]) => list.map((n) => ({ value: n, label: n }));
		const starts = (items: { value: string; label: string; description?: string }[], prefix: string) => items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		const own: SlashCommand[] = [
			{ name: "model", description: "the model for new sessions", argumentHint: "provider/id | default", getArgumentCompletions: (p) => starts(models(), p) },
			{ name: "thinking", description: "the thinking level for new sessions", argumentHint: "level", getArgumentCompletions: (p) => starts(levels(), p) },
			{ name: "worktree", description: "new sessions in their own git worktree", argumentHint: "on | off" },
			{ name: "resume", description: "pick a session to resume in the background" },
			{ name: "usage", description: "what the sessions spent" },
			{ name: "log", description: "what happened lately" },
			{ name: "concierge", description: "the hub's own agent", argumentHint: "on | off | status | log | attach | ask | answer | act | undo | orders", getArgumentCompletions: (p) => starts(names(["on", "off", "status", "log", "attach", "ask", "answer", "act", "undo", "orders"]), p) },
			{ name: "ask", description: "ask the concierge", argumentHint: "question" },
			{ name: "schedule", description: "a task on a schedule", argumentHint: "<name> <when> <task> | run | pause | resume | rm" },
			{ name: "fanout", description: "the next task once per model", argumentHint: "model model … | off" },
			{ name: "compare", description: "the fan-out side by side" },
			{ name: "preset", description: "launch presets", argumentHint: "name | save name | rm name | off" },
			{ name: "profile", description: "new sessions run another agent", argumentHint: "name | pi" },
			{ name: "exit", description: "leave the view" },
		];
		const pi = (this.o.commands?.() ?? []).filter((c) => c.source === "prompt" || c.source === "skill").map((c) => ({ name: c.name, description: `pi: ${c.source}` }));
		return [...own, ...pi];
	}

	/** A peek's commands: for that session. */
	private peekCommands(): SlashCommand[] {
		const starts = (items: { value: string; label: string }[], prefix: string) => items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		return PEEK_COMMANDS.map((c) =>
			c.name === "model"
				? { ...c, getArgumentCompletions: (p: string) => starts((this.o.models?.() ?? []).map((m) => ({ value: m, label: m })), p) }
				: c.name === "thinking"
					? { ...c, getArgumentCompletions: (p: string) => starts([...THINKING_LEVELS].map((v) => ({ value: v, label: v })), p) }
					: { ...c },
		);
	}

	/** M8: switch a session's model or thinking level from its peek. */
	private sessionSetting(row: JobRow, which: "model" | "thinking", arg: string): void {
		if (row.kind === "shell") return this.say(isProfileRow(row) ? `${row.profile} takes its model when it starts` : "a shell job has no model", "warning");
		const values: string[] = which === "model" ? (this.o.models?.() ?? []) : [...THINKING_LEVELS];
		const apply = async (v: string) => void (await this.sendSetting(row, which, v));
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
		if (which === "model") return this.modelPicker(`Model for ${oneLine(row.name)}`, current, false, apply);
		this.openPicker(`Thinking for ${oneLine(row.name)}`, values, current, apply);
	}

	private async sendSetting(picked: JobRow, which: "model" | "thinking", value: string, quiet = false): Promise<boolean> {
		// M25: quiet (a batch) says nothing itself and answers whether it reached the session
		const say = (text: string, tone?: Tone) => {
			if (!quiet) this.say(text, tone);
		};
		if (!this.client) {
			say("background service unavailable", "error");
			return false;
		}
		// the picker may have been open a while: act on the row as it is now
		const row = this.rows.get(picked.id);
		if (!row) {
			say("that session no longer exists", "warning");
			return false;
		}
		const pending = this.switches.get(switchKey(row.id, which));
		// a second switch before the first shows: compare with what the session had before both
		const before = pending ? pending.before : ((which === "model" ? row.model : row.thinking) ?? null);
		try {
			const r = await this.client.request("reply", { id: row.id, text: `/${which} ${value}` });
			if (!quiet) this.reply.setValue("");
			if (r.delivered) {
				// asked, not done: the worker may lack credentials, or pi may lower a thinking level
				if (!pending && before === value) {
					say(`${row.name} already uses ${which} ${value}`);
					return true;
				}
				this.watchSwitch(row, which, value, before, pending ? [...pending.superseded, pending.value] : []);
				say(`asked ${row.name} to use ${which} ${value}…`);
				return true;
			}
			if (r.respawned) say(`${which} ${value} · starting ${row.name} again`, "success");
			else if (r.saved) say(`saved; ${which} changes when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else if (row.pid !== null || row.endedAt === null) say(`${row.name} is starting; try again in a moment`, "warning");
			else say("not delivered: the session is not running", "error");
			return r.respawned === true || r.saved === true;
		} catch (err) {
			say((err as Error).message, "error");
			return false;
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

	/**
	 * M27: the preset's directory, under the hub's (links resolved: a cloned project's
	 * preset cannot reach outside it), when it has one.
	 */
	private presetDir(): { path: string } | { error: string } | undefined {
		const d = this.preset?.dir;
		if (!d) return undefined;
		const path = resolve(this.o.cwd, d);
		let real: string;
		let root: string;
		try {
			real = realpathSync(path);
			root = realpathSync(this.o.cwd);
		} catch {
			return { error: `the preset's directory ${d} does not exist here` };
		}
		const rel = relative(root, real);
		if (rel.startsWith("..") || isAbsolute(rel)) return { error: `the preset's directory ${d} leads outside ${this.o.cwd}` };
		return { path };
	}

	/** M27: /preset [name | off | save name | rm name]; false: the text stays in the input. */
	private presetCommand(arg: string): boolean {
		const all = this.o.presets?.() ?? {};
		const has = (n: string) => Object.hasOwn(all, n);
		const [verb, name = "", ...rest] = arg.split(/\s+/).filter(Boolean);
		if (!verb) {
			const names = Object.keys(all).sort();
			if (names.length === 0) {
				this.say("no presets yet: /preset save <name> keeps what new sessions use now", "warning");
				return false;
			}
			this.picker = {
				title: "Preset for new sessions",
				items: [{ label: "none (the defaults)", value: "" }, ...names.map((n) => ({ label: `${n}  ${presetText(all[n]!)}`, value: n }))],
				index: Math.max(0, names.indexOf(this.preset?.name ?? "") + 1),
				pick: (v) => (v ? this.applyPreset(v, all[v]!) : this.clearPreset()),
			};
			this.o.tui.requestRender();
			return true;
		}
		if (verb === "off" && !name) {
			if (!this.preset) {
				this.say("no preset in use");
				return true;
			}
			this.clearPreset();
			return true;
		}
		if (verb === "save" || verb === "rm") {
			if (!name || rest.length > 0) {
				this.say(`/preset ${verb} <name>`, "warning");
				return false;
			}
			if (!this.o.savePreset) {
				this.say("presets cannot be saved here", "warning");
				return false;
			}
			if (verb === "rm" && !(this.o.userPreset?.(name) ?? has(name))) {
				this.say(has(name) ? `${name} is a project's preset (${relative(this.o.cwd, projectConfigPath(this.o.cwd))})` : `no preset ${name}`, "warning");
				return false;
			}
			const p: Preset = {
				...(this.model ? { model: this.model } : {}),
				...(this.thinking ? { thinking: this.thinking } : {}),
				...(this.worktree !== undefined ? { worktree: this.worktree } : {}),
				...(this.preset?.agent ? { agent: this.preset.agent } : {}),
				...(this.preset?.dir ? { dir: this.preset.dir } : {}),
				...(this.fanout && this.fanout.length >= 2 ? { fanout: this.fanout } : {}),
				...(this.profile ? { profile: this.profile } : {}),
			};
			// what would not read back (a model without its provider) is not saved
			if (verb === "save" && !samePreset(presetFrom(p), p)) {
				this.say(`these choices do not make a preset (a pi model needs provider/id)`, "warning");
				return false;
			}
			try {
				this.o.savePreset(name, verb === "save" ? p : null);
			} catch (err) {
				this.say((err as Error).message, "error");
				return false;
			}
			if (verb === "rm") {
				if (this.preset?.name === name) this.preset = undefined;
				const still = Object.hasOwn(this.o.presets?.() ?? {}, name);
				this.say(still ? `removed your preset ${name} (the project's ${name} stays)` : `removed preset ${name}`);
			} else {
				this.preset = { name, ...(p.agent ? { agent: p.agent } : {}), ...(p.dir ? { dir: p.dir } : {}) };
				this.say(`saved preset ${name}: ${presetText(p) || "the defaults"}`, "success");
			}
			return true;
		}
		if (name) {
			this.say("/preset <name>, off, save <name> or rm <name>", "warning");
			return false;
		}
		const p = has(verb) ? all[verb] : undefined;
		if (!p) {
			this.say(`no preset ${verb} (bare /preset lists them)`, "warning");
			return false;
		}
		this.applyPreset(verb, p);
		return true;
	}

	private applyPreset(name: string, p: Preset): void {
		// a preset is the whole choice: what it leaves out is the default (nothing from the last one stays)
		this.model = p.model;
		this.thinking = p.thinking;
		this.worktree = p.worktree;
		this.fanout = p.fanout ? [...p.fanout] : undefined;
		this.profile = p.profile && p.profile !== "pi" ? p.profile : undefined;
		this.preset = { name, ...(p.agent ? { agent: p.agent } : {}), ...(p.dir ? { dir: p.dir } : {}) };
		const dir = this.presetDir();
		const missing = dir && "error" in dir ? ` · ${dir.error}` : "";
		this.say(`preset ${name}: ${presetText(p) || "nothing to change"}${missing}`, missing ? "warning" : "success");
	}

	private clearPreset(): void {
		this.preset = undefined;
		this.model = undefined;
		this.thinking = undefined;
		this.worktree = undefined;
		this.fanout = undefined;
		this.profile = undefined;
		this.say("new sessions use the defaults");
	}

	/** M26: bare /fanout: Enter adds or removes a model, the list opens again until Esc. */
	private fanoutPicker(): void {
		const chosen = this.fanout ?? [];
		this.modelPicker(`Fan out the next task (${chosen.length} chosen) · Enter adds or removes · Esc done`, chosen.at(-1) ?? "", false, (v) => {
			const now = this.fanout ?? [];
			const next = now.includes(v) ? now.filter((m) => m !== v) : now.length >= MAX_FANOUT ? now : [...now, v];
			if (next === now) this.say(`at most ${MAX_FANOUT} models`, "warning");
			this.fanout = next.length > 0 ? next : undefined;
			this.fanoutPicker();
		});
		const p = this.picker;
		if (!p) return;
		const mark = (it: { label: string; value: string }) => ({ ...it, label: `${chosen.includes(it.value) ? "✓" : " "} ${it.label}` });
		p.items = p.items.map(mark);
		if (p.other) p.other.items = p.other.items.map(mark);
	}

	private async dispatchFanout(task: string, cwd: string, agent: AgentDef | undefined, typed: string, attach = false): Promise<void> {
		const models = this.fanout ?? [];
		if (models.length < 2) return this.say("a fan-out needs two models at least (/fanout)", "warning");
		if (!this.client) return this.say("background service unavailable", "error");
		const fanout = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const base = fallbackName(task);
		const started: string[] = [];
		const notes = new Set<string>();
		const failed: string[] = [];
		this.dispatching = true;
		this.input.setValue("");
		try {
			for (const model of models) {
				let args: LaunchRequest;
				try {
					args = this.o.launch(task, { cwd, model, thinking: this.thinking, worktree: true, fanout, name: `${base} · ${shortModel(model)}`, ...(agent ? { agent } : {}) });
				} catch (err) {
					failed.push(`${shortModel(model)}: ${oneLine((err as Error).message)}`);
					continue;
				}
				const { discard, note, ...request } = args;
				try {
					const { id } = await this.client.request("dispatch", { ...request, fanout });
					started.push(id);
					if (note) notes.add(note);
				} catch (err) {
					const refused = refusedByDaemon(err);
					if (refused) discard?.();
					// an unanswered dispatch may still run: its worktree stays (as for one task)
					failed.push(`${shortModel(model)}: ${oneLine((err as Error).message)}${!refused && request.worktree ? ` (worktree ${request.worktree.branch} kept)` : ""}`);
				}
			}
		} finally {
			this.dispatching = false;
		}
		if (started.length === 0) {
			if (!this.input.getValue()) this.input.setValue(typed);
			return this.say(`nothing started · ${failed.join(" · ")}`, "error");
		}
		this.fanout = undefined; // once
		this.cursor = { kind: "row", id: started[0]! };
		const extra = [...notes, ...(failed.length ? [`not started: ${failed.join(", ")}`] : []), ...(attach ? ["Ctrl+Enter opens a single task, not a fan-out"] : [])];
		this.say(`started ${started.length} sessions, one per model · /compare on one of them${extra.length ? ` · ${extra.join(" · ")}` : ""}`, extra.length ? "warning" : "success");
	}

	/** M26: the sessions to compare: the selected row's fan-out, else the marked rows. */
	private compareRows(): JobRow[] {
		const row = this.selectedRow();
		if (row?.fanout) {
			return [...this.rows.values()].filter((r) => r.fanout === row.fanout).sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
		}
		return this.markedRows();
	}

	/** M26: /compare: one column per session, ← → choose, Enter opens it, k twice keeps it. */
	private compare(): void {
		const first = this.compareRows();
		if (first.length < 2) return this.say("/compare works on a row of a fan-out (/fanout), or on two or more marked rows", "warning");
		const ids = first.map((r) => r.id);
		const fanoutId = first[0]!.fanout && first.every((r) => r.fanout === first[0]!.fanout) ? first[0]!.fanout : undefined;
		const changes = new Map<string, string>();
		const view = this;
		let index = Math.max(0, ids.indexOf(this.selectedRow()?.id ?? ""));
		let keepArmed = 0;
		let closed = false;
		const change = this.o.worktreeChange ?? worktreeChange;
		const load = () => {
			for (const id of ids) {
				const wt = this.rows.get(id)?.worktree;
				if (!wt?.base) {
					changes.set(id, "no worktree");
					continue;
				}
				void change(wt.path, wt.base)
					.then((c) => changes.set(id, c ? changeText(c) : existsSync(wt.path) ? "no diff (its base is gone?)" : "worktree gone"))
					.catch(() => changes.set(id, "?"))
					.finally(() => {
						if (!closed) this.o.tui.requestRender();
					});
			}
		};
		load();
		this.overlay = {
			render(width: number) {
				const rows = ids.map((id) => view.rows.get(id)).filter((r): r is JobRow => r !== undefined);
				if (rows.length === 0) {
					queueMicrotask(() => view.closeOverlay());
					return [];
				}
				index = Math.min(index, rows.length - 1);
				const room = Math.max(6, (view.o.tui.terminal.rows || 30) - 7);
				const armed = keepArmed > 0 && Date.now() - keepArmed < DOUBLE_PRESS_MS;
				const keys = armed
					? "k again: keep this one, delete the others (pinned ones stay)"
					: `← → choose · Enter open${fanoutId ? " · k keep this one (deletes the others)" : ""} · r refresh · Esc close`;
				return [...view.compareLines(rows, index, changes, width, room), "", view.o.theme.fg(armed ? "warning" : "dim", truncateToWidth(keys, width))];
			},
			handleInput(data: string) {
				if (isKeyRelease(data)) return;
				const key = parseKey(data);
				// a letter as typed, also when the terminal encodes it (kitty CSI u)
				const ch = decodeKittyPrintable(data) ?? data;
				const count = ids.filter((id) => view.rows.has(id)).length;
				if (ch !== "k") keepArmed = 0;
				if (key === "escape" || key === "ctrl+c" || ch === "q") view.closeOverlay();
				else if (key === "left") index = Math.max(0, index - 1);
				else if (key === "right" || key === "tab") index = Math.min(count - 1, index + 1);
				else if (ch === "r") load();
				else if (key === "enter") {
					const row = ids.map((id) => view.rows.get(id)).filter((r): r is JobRow => r !== undefined)[index];
					view.closeOverlay();
					if (row) {
						view.cursor = { kind: "row", id: row.id };
						void view.attachTo(row.id).catch((err: unknown) => view.say(String(err), "error"));
					}
				} else if (ch === "k") {
					// keeping one deletes the others: only among the sessions of one fan-out
					if (!fanoutId) return view.say("k keeps one of a fan-out; for marked rows use Ctrl+X", "warning");
					const now = Date.now();
					if (!keepArmed || now - keepArmed > DOUBLE_PRESS_MS) {
						keepArmed = now;
						// the prompt goes back when the double press runs out
						setTimeout(() => {
							if (!closed) view.o.tui.requestRender();
						}, DOUBLE_PRESS_MS + 50).unref?.();
						return;
					}
					keepArmed = 0;
					const rows = ids.map((id) => view.rows.get(id)).filter((r): r is JobRow => r !== undefined);
					const keep = rows[index];
					view.closeOverlay();
					if (keep) void view.keepOne(keep, rows.filter((r) => r.id !== keep.id));
				}
			},
			dispose() {
				closed = true;
			},
		};
		this.o.tui.requestRender();
	}

	private compareLines(rows: JobRow[], index: number, changes: Map<string, string>, width: number, room: number): string[] {
		const t = this.o.theme;
		const now = Date.now();
		// pi may have named the sessions since (each its own way): the first one's name, less its model
		const first = rows[0]!;
		const tag = first.model ? ` · ${shortModel(first.model)}` : "";
		const title = tag && first.name.endsWith(tag) ? first.name.slice(0, -tag.length) : first.name;
		const out = [t.bold(truncateToWidth(`Compare · ${oneLine(title)} · ${rows.length} sessions`, width)), ""];
		const block = (r: JobRow, w: number, sel: boolean): string[] => {
			const u = r.usage;
			const tokens = u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
			const head = `${sel ? "›" : " "} ${r.model ? shortModel(r.model) : oneLine(r.name)}`;
			const lines = [
				sel ? t.fg("accent", t.bold(head)) : t.bold(head),
				t.fg("dim", `  ${r.state} · ${ageOf(r, now)}`),
				t.fg("muted", `  ${u ? `${formatCost(u.cost)} · ${formatTokens(tokens)} tok${u.sub ? " (sub)" : ""}` : "no usage yet"}`),
				t.fg("muted", `  ${changes.get(r.id) ?? "…"}`),
				"",
			];
			const text = r.question ?? r.summary ?? r.error ?? "";
			// a model's text: no escape sequences or tabs reach the terminal (lines stay)
			const clean = stripTerminalSequences(text).replace(/\t/g, "  ").replace(CONTROL, "");
			const body = wrapTextWithAnsi(clean, Math.max(4, w - 2)).map((l) => `  ${l}`);
			return [...lines, ...body].map((l) => truncateToWidth(l, w));
		};
		const gap = 2;
		const colW = Math.floor((width - gap * (rows.length - 1)) / rows.length);
		if (colW >= 24) {
			const blocks = rows.map((r, i) => block(r, colW, i === index));
			const height = Math.min(room - 2, Math.max(...blocks.map((b) => b.length)));
			for (let y = 0; y < height; y++) {
				out.push(
					blocks
						.map((b) => {
							const l = b[y] ?? "";
							return l + " ".repeat(Math.max(0, colW - visibleWidth(l)));
						})
						.join(" ".repeat(gap)),
				);
			}
			return out;
		}
		// narrow: the chosen one in full, the others as one line each
		rows.forEach((r, i) => {
			if (i === index) out.push(...block(r, width, true).slice(0, Math.max(5, room - rows.length - 2)));
			else out.push(truncateToWidth(`  ${r.model ? shortModel(r.model) : oneLine(r.name)} · ${r.state} · ${r.usage ? formatCost(r.usage.cost) : "-"} · ${changes.get(r.id) ?? "…"}`, width));
		});
		return out;
	}

	/** M26: keep one of a comparison: the others are deleted (worktrees with work are kept). */
	private async keepOne(keep: JobRow, others: JobRow[]): Promise<void> {
		if (!this.client) return this.say("background service unavailable", "error");
		const kept: string[] = [];
		let deleted = 0;
		const failed: string[] = [];
		const pinned = others.filter((r) => r.pinned);
		for (const r of others) {
			if (r.pinned) continue; // pinned on purpose: never deleted by a batch
			try {
				if (r.pid !== null) await this.client.request("stop", { id: r.id });
				const res = await this.client.request("rm", { id: r.id });
				deleted++;
				this.marked.delete(r.id);
				if (res.worktree && (!res.worktree.removed || res.worktree.branchKept)) kept.push(cleanupText(res.worktree));
			} catch (err) {
				failed.push(`${oneLine(r.name)}: ${oneLine((err as Error).message)}`);
			}
		}
		this.cursor = { kind: "row", id: keep.id };
		const parts = [`kept ${oneLine(rowName(keep))} · deleted ${deleted}`];
		if (pinned.length) parts.push(`${pinned.length} pinned kept`);
		if (kept.length) parts.push(kept.join(" · "));
		if (failed.length) parts.push(`not deleted: ${failed.join(", ")}`);
		this.say(parts.join(" · "), kept.length || failed.length ? "warning" : "success");
	}

	/**
	 * M25: the marked rows on screen, in list order. A marked row in a folded group or
	 * filtered out stays marked but is not acted on: a batch never reaches what is not shown.
	 */
	private markedRows(): JobRow[] {
		if (this.marked.size === 0) return [];
		for (const id of this.marked) if (!this.rows.has(id)) this.marked.delete(id);
		return this.itemList().flatMap((it) => (it.kind === "row" && this.marked.has(it.row.id) ? [it.row] : []));
	}

	/** M25: Ctrl+O marks the row, or on a header the whole group (again: unmarks it). */
	private toggleMark(): void {
		const it = this.selected();
		if (!it) return;
		const ids = it.kind === "row" ? [it.row.id] : it.section.rows.map((r) => r.id);
		if (ids.length === 0) return;
		const unmark = ids.every((id) => this.marked.has(id));
		for (const id of ids) {
			if (unmark) this.marked.delete(id);
			else this.marked.add(id);
		}
		// a row moves on to the next one, so Ctrl+O Ctrl+O marks two
		if (it.kind === "row") this.move(1);
		const n = this.markedRows().length;
		this.say(n > 0 ? `${n} marked · type and Enter to send to all · Ctrl+X stop · Ctrl+T pin · Esc unmark` : "marks cleared");
	}

	/** M25: the typed text to every marked session; /model and /thinking switch them all. */
	private async sendToMarked(mode: ReplyMode = "steer"): Promise<void> {
		if (this.sendingMarked) return;
		const rows = this.markedRows();
		const typed = this.input.getValue();
		const text = typed.trim();
		if (!this.client) return this.say("background service unavailable", "error");
		// a new task or a shell job is never sent as a reply by mistake: the input stays
		if (/^[!@]/.test(text)) return this.say("rows are marked: a typed text goes to them as a reply (Esc unmarks to start a task)", "warning");
		const setting = /^\/(model|thinking)(?:\s+(.*))?$/.exec(text);
		if (setting) return this.markedSetting(rows, setting[1] as "model" | "thinking", (setting[2] ?? "").trim());
		if (text === "/compare") {
			this.input.setValue("");
			return this.compare();
		}
		if (text.startsWith("/") && this.isViewCommand(text.slice(1).split(/\s/)[0] ?? "")) {
			return this.say("only /model, /thinking and /compare act on marked sessions (Esc unmarks)", "warning");
		}
		// M30: a profile's agent takes replies typed in; a plain command takes none
		const pi = rows.filter(takesReplies);
		if (pi.length === 0) return this.say("the marked rows are shell jobs: nothing to send to", "warning");
		let sent = 0;
		let later = 0;
		const failed: string[] = [];
		// cleared first: a second Enter while sending has nothing to send
		this.sendingMarked = true;
		this.input.setValue("");
		try {
			for (const r of pi) {
				try {
					const res = await this.client.request("reply", { id: r.id, text, mode });
					if (res.delivered || res.respawned) sent++;
					else if (res.saved) later++;
					else failed.push(r.name);
				} catch {
					failed.push(r.name);
				}
			}
		} finally {
			this.sendingMarked = false;
		}
		// nothing reached anyone: the text comes back
		if (sent === 0 && later === 0 && !this.input.getValue()) this.input.setValue(typed);
		const parts = [`sent to ${sent} of ${pi.length} sessions${mode === "followUp" ? " (after their current work)" : ""}`];
		if (later) parts.push(`${later} saved for their next start`);
		if (failed.length) parts.push(`not delivered: ${failed.map(oneLine).join(", ")}`);
		if (pi.length < rows.length) parts.push(`${rows.length - pi.length} shell jobs skipped`);
		this.say(parts.join(" · "), failed.length ? "warning" : "success");
	}

	private markedSetting(rows: JobRow[], which: "model" | "thinking", arg: string): void {
		const pi = rows.filter((r) => r.kind !== "shell");
		if (pi.length === 0) return this.say("a shell job has no model", "warning");
		const values: string[] = which === "model" ? (this.o.models?.() ?? []) : [...THINKING_LEVELS];
		const apply = async (v: string) => {
			let ok = 0;
			for (const r of pi) if (await this.sendSetting(r, which, v, true)) ok++;
			this.input.setValue("");
			this.say(`asked ${ok} of ${pi.length} sessions to use ${which} ${v}…`, ok === pi.length ? "muted" : "warning");
		};
		if (arg) {
			if (arg === "default") return this.say(`a running session has no default ${which}: pick one (bare /${which})`, "warning");
			if (which === "model" && !arg.includes("/")) return this.say("use provider/id (bare /model lists them)", "warning");
			if (values.length > 0 && !values.includes(arg)) {
				return this.say(which === "model" ? `unknown model ${arg} (bare /model lists them)` : `thinking is one of ${values.join(", ")}`, "warning");
			}
			return void apply(arg);
		}
		if (values.length === 0) return this.say("no models available", "warning");
		this.input.setValue("");
		const title = `${which === "model" ? "Model" : "Thinking"} for ${pi.length} marked sessions`;
		const same = new Set(pi.map((r) => (which === "model" ? r.model : r.thinking) ?? ""));
		const current = same.size === 1 ? [...same][0]! : "";
		if (which === "model") return this.modelPicker(title, current, false, apply);
		this.openPicker(title, values, current, apply);
	}

	/** AV-K12: stop; again within 2 s delete; on a header, the whole group. */
	private async stopSelected(): Promise<void> {
		if (!this.client) return;
		const it = this.selected();
		const marked = this.peek ? [] : this.markedRows();
		if (!it && marked.length === 0) return;
		// M25: the marked rows, else the row, else the header's group
		const targets = marked.length > 0 ? marked : it!.kind === "row" ? [it!.row] : it!.section.rows;
		if (targets.length === 0) return;
		const key =
			marked.length > 0
				? `marked:${targets.map((r) => r.id).join(",")}`
				: it!.kind === "row"
					? it!.row.id
					: `group:${it!.section.key}:${targets.map((r) => r.id).join(",")}`;
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
				for (const r of targets) this.marked.delete(r.id);
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
		// M22: one attach at a time: a second one would share the terminal with the first,
		// and the first one's end would pause the input of the second
		if (this.attached) return;
		const row = this.rows.get(id);
		if (!row) return;
		if (row.pid === null) {
			if (!this.client) return this.say("background service unavailable", "error");
			// a reaped session just wakes up (AT-1); one that ended asks first (DM-7)
			const now = Date.now();
			if (!row.reaped && (this.restartAsk?.id !== id || now - this.restartAsk.at > RESTART_ASK_MS)) {
				this.restartAsk = { id, at: now };
				return this.say(
					row.kind === "shell" && !isProfileRow(row)
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

		// M24: what the sessions spent (all of them, subagents included)
		const spent = totalUsage([...this.rows.values()], now);
		const money = spent.cost > 0 ? ` · ${formatCost(spent.today)} today · ${formatCost(spent.cost)} all` : "";
		out.push(truncateToWidth(t.bold("pi agents") + t.fg("dim", `  ${headerText(c)}${money}`), w));
		if (!short) out.push(t.fg("border", "─".repeat(w)));
		this.headLines = out.length;
		if (this.connectError) out.push(t.fg("error", truncateToWidth(`background service: ${oneLine(this.connectError)}`, w)));

		if (this.origin && this.o.banner) out.push(t.fg("accent", truncateToWidth(this.o.banner, w)));
		const wt = this.worktree ?? this.o.worktreeDefault === true;
		// M23: always says what a new session runs (Ctrl+L, Ctrl+P and Shift+Tab change it)
		const def = this.o.defaultModel?.();
		if (this.model || this.thinking || wt || def || this.preset || this.profile) {
			// M30: a profile's agent has no pi default model
			const model = this.model ? `model ${this.model}` : def && !this.profile ? `model ${def} (default)` : undefined;
			const pr = this.preset;
			const d = [pr && `preset ${pr.name}`, this.profile && `runs ${this.profile}`, model, this.thinking && `thinking ${this.thinking}`, wt && "own worktree", pr?.agent && `as ${pr.agent}`, pr?.dir && `in @${pr.dir}`]
				.filter(Boolean)
				.join(" · ");
			out.push(t.fg("dim", truncateToWidth(`new sessions: ${d}`, w)));
		}
		// M45: the escalation banner: a session waits, the concierge suggests an answer
		const esc = this.concierge?.on ? this.escalation() : undefined;
		if (esc) out.push(t.fg("warning", truncateToWidth(this.escalationLine(esc, Date.now()), w)));
		// M44: the concierge's line
		if (this.concierge?.on) out.push(t.fg(this.concierge.notice?.kind === "need" && !this.concierge.overBudget && !esc ? "warning" : "dim", truncateToWidth(this.conciergeLine(), w)));
		if (this.fanout) {
			const n = this.fanout.length;
			const list = this.fanout.map(shortModel).join(", ");
			out.push(t.fg(n >= 2 ? "accent" : "warning", truncateToWidth(n >= 2 ? `next task: ${n} sessions, one per model (${list}), own worktrees · /fanout off` : `fan-out: ${list}, add one more model (/fanout)`, w)));
		}
		if (this.overlay) {
			const rows = this.o.tui.terminal.rows || 30;
			let body: string[];
			try {
				body = this.overlay.render(w);
			} catch (err) {
				this.closeOverlay();
				this.say(`the session list failed: ${oneLine((err as Error).message)}`, "error");
				body = [];
			}
			// its last lines (the keys) stay on screen
			if (body.length > rows - out.length) body = [...body.slice(0, Math.max(1, rows - out.length - 2)), ...body.slice(-2)];
			this.bottomFrom = out.length + body.length - 1;
			return [...out, ...body].map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
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
		this.nameWidth = Math.max(1, Math.min(28, Math.floor(w / 3), Math.max(8, ...all.map((r) => visibleWidth(oneLine(rowName(r))) + (r.parentSession ? 2 : 0)))));
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
				const all = s.rows.length > 0 && s.rows.every((r) => this.marked.has(r.id));
				out.push(this.mark(isSel, truncateToWidth(t.bold(label) + hint, Math.max(1, w - 2)), all));
				return;
			}
			if (isSel) this.selLine = out.length;
			out.push(truncateToWidth(this.mark(isSel, this.rowLine(it.row, Math.max(1, w - 2), now), this.marked.has(it.row.id)), w));
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

	private mark(selected: boolean, line: string, checked = false): string {
		const t = this.o.theme;
		// M25: a marked row has a check in the second column
		return `${selected ? t.fg("accent", "›") : " "}${checked ? t.fg("success", "✓") : " "}${line}`;
	}

	private rowLine(row: JobRow, width: number, now: number): string {
		const t = this.o.theme;
		const icon = iconOf(row, this.frame, !this.o.reducedMotion);
		const age = ageOf(row, now);
		// M9: a spawned session is marked as someone's child
		const full = oneLine(`${row.parentSession ? "↳ " : ""}${rowName(row)}`);
		// M26: a fan-out's model stays readable when its name is cut
		const tag = row.fanout && row.model ? ` · ${shortModel(row.model)}` : "";
		const name =
			tag && visibleWidth(full) > this.nameWidth && full.endsWith(tag) && this.nameWidth > visibleWidth(tag) + 4
				? truncateToWidth(full.slice(0, -tag.length), this.nameWidth - visibleWidth(tag)) + tag
				: truncateToWidth(full, this.nameWidth);
		const pad = " ".repeat(Math.max(0, this.nameWidth - visibleWidth(name)));
		const styled = row.id === this.o.highlightId ? t.bold(t.fg(nameToneOf(row.id), name)) : t.fg(nameToneOf(row.id), name);
		const head = `${t.fg(icon.tone, icon.glyph)} ${styled}${pad}  `;
		const detail = this.detailText(row);
		const ageCol = t.fg("dim", age.padStart(this.columns.ageW));
		// M24: what it spent (dim when billed to a subscription: notional)
		const cw = this.columns.costW;
		const costText = cw > 0 && row.usage && row.usage.cost > 0 ? formatCost(row.usage.cost) : "";
		const costCol = cw > 0 ? `${t.fg(row.usage?.sub ? "dim" : "muted", costText.padStart(cw))}  ` : "";
		// M16: Claude Code's `#N` at the right edge, coloured by status, linked to the pull request
		const pr = prLabel(row.prs);
		const prCol = pr ? `  ${hyperlink(t.fg(pr.tone, pr.text), pr.url)}` : "";
		const tail = `${detail ? `${detail}  ` : ""}${costCol}${ageCol}${prCol}`;
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
		const none: Columns = { mode: "none", modelW: 0, shareW: 0, ageW, costW: 0 };
		if (this.o.rowDetails === false) return none;
		const base = this.layoutColumns(rows, width, ageW, 0);
		// M24: what each session spent, when that still leaves the summary its room
		const costW = Math.max(0, ...rows.map((r) => (r.usage && r.usage.cost > 0 ? formatCost(r.usage.cost).length : 0)));
		if (costW > 0) {
			const withCost = this.layoutColumns(rows, width, ageW, costW + 2);
			if (withCost.mode === base.mode && withCost.costW === 0) return { ...withCost, costW };
		}
		return base;
	}

	private layoutColumns(rows: JobRow[], width: number, ageW: number, extra: number): Columns {
		const none: Columns = { mode: "none", modelW: 0, shareW: 0, ageW, costW: 0 };
		const ds = rows.map(rowDetailsOf).filter((d): d is NonNullable<typeof d> => d !== null);
		const modelW = Math.min(MODEL_COL, Math.max(0, ...ds.map((d) => (d.model ? visibleWidth(oneLine(d.model)) : 0))));
		const shareW = Math.max(0, ...ds.map((d) => d.context?.length ?? 0));
		// what the summary keeps: the row minus icon, name, the column, the age and the gaps
		// M16: the `#N` label at the right edge takes its room too
		const prW = Math.max(0, ...rows.map((r) => (prLabel(r.prs)?.text.length ?? -2) + 2));
		const room = (col: number) => width - (2 + this.nameWidth + 2) - col - 2 - ageW - 2 - prW - extra;
		const full = modelW + (modelW && shareW ? 3 : 0) + shareW;
		if (full > 0 && room(full) >= MIN_SUMMARY) return { mode: "full", modelW, shareW, ageW, costW: 0 };
		if (shareW > 0 && room(shareW) >= MIN_SUMMARY) return { mode: "share", modelW: 0, shareW, ageW, costW: 0 };
		// M24: no room even for `extra` alone: say so (the cost column is left out)
		return extra > 0 && room(0) < MIN_SUMMARY ? { ...none, costW: -1 } : none;
	}

	/** M8: "claude-opus-5-5 · 43%", padded to the column (blank for a row without them). */
	private detailText(row: JobRow): string {
		const c = this.columns;
		if (c.mode === "none") return "";
		const t = this.o.theme;
		const d = rowDetailsOf(row);
		const share = d?.context ? t.fg(d.tone, d.context.padStart(c.shareW)) : " ".repeat(c.shareW);
		if (c.mode === "share") return share;
		const raw = d?.model ? fitTail(oneLine(d.model), c.modelW) : "";
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
		const blocked = row.state === "blocked";
		// what it asks, said last, or failed with: first, whole (a failed row's error is not cut short)
		const sentence = sentenceOf(row).replace(CONTROL, " ");
		for (const chunk of wrap(sentence, inner)) lines.push(`    ${row.state === "failed" ? t.fg("error", chunk) : chunk}`);
		row.choices.forEach((c, i) => lines.push(`    ${t.fg("accent", `${i + 1}.`)} ${truncateToWidth(oneLine(c), Math.max(1, inner - 4))}`));
		// M45: the concierge's suggested answer, with its reason
		if (row.suggested && blocked) {
			const why = row.suggested.why ? ` · ${oneLine(row.suggested.why)}` : "";
			lines.push(`    ${t.fg("warning", "concierge suggests:")} ${truncateToWidth(`${oneLine(row.suggested.text)}${why}`, Math.max(1, inner - 20))} ${t.fg("dim", "(Ctrl+Y sends · Ctrl+E edits)")}`);
		}
		// M48: the task it was started on; where; since when
		if (row.task) lines.push(`    ${t.fg("dim", truncateToWidth(`task: ${oneLine(row.task)}`, inner))}`);
		const when = row.endedAt
			? `${row.state} ${formatDuration(now - row.endedAt)} ago · took ${formatDuration(row.endedAt - row.startedAt)}`
			: `started ${formatDuration(now - row.startedAt)} ago`;
		lines.push(`    ${t.fg("dim", truncateToWidth(`${tildeDir(row.cwd)} · ${when}`, inner))}`);
		// a blocked row's status is always "waiting": say it once, with how long
		const facts: string[] = [
			blocked
				? `needs input · waiting ${formatDuration(now - row.stateSince)}`
				: row.state + (row.status ? ` · ${row.status}` : ""),
		];
		if (row.queued) facts.push(`${row.queued} ${row.queued === 1 ? "reply" : "replies"} queued`);
		if (row.parentSession) {
			const parent = [...this.rows.values()].find((r) => r.sessionFile === row.parentSession && r.id !== row.id);
			facts.push(`child of ${parent ? oneLine(parent.name) : "a foreground session"}`);
		}
		const kids = [...this.rows.values()].filter((r) => r.parentSession && r.parentSession === row.sessionFile && r.id !== row.id);
		if (kids.length > 0) {
			const live = kids.filter((r) => r.state === "working" || r.state === "blocked").length;
			facts.push(`${kids.length} subagent${kids.length === 1 ? "" : "s"}${live ? ` (${live} running)` : ""}`);
		}
		for (const p of row.prs ?? []) {
			const what = `#${p.number} ${p.status}${p.needsReview ? " · needs review" : ""}${p.title ? ` · ${oneLine(p.title)}` : ""}`;
			lines.push(`    ${hyperlink(t.fg(prTone(p.status), truncateToWidth(what, inner)), p.url)}`);
		}
		if (row.agent) facts.push(`agent ${oneLine(row.agent)}`);
		if (row.worktree) {
			facts.push(`⎇ ${oneLine(row.worktree.branch)}`);
		}
		facts.push(row.id);
		lines.push(`    ${t.fg("dim", truncateToWidth(facts.join(" · "), inner))}`);
		// M8: model, thinking and context window on a line of their own; M48: what it cost
		const model = modelFacts(row);
		const u = row.usage;
		if (u && u.cost > 0) model.push(`${u.cost < 0.01 ? "<$0.01" : `$${u.cost.toFixed(2)}`}${u.sub ? " (sub)" : ""} · ${kTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tokens`);
		if (model.length > 0) {
			const tone = row.context ? rowDetailsOf(row)?.tone ?? "dim" : "dim";
			lines.push(`    ${t.fg(tone, truncateToWidth(model.join(" · "), inner))}`);
		}
		if (row.waitingFor === "dialog") lines.push(`    ${t.fg("warning", "a dialog is open: attach (→) to answer it; replies wait for it")}`);
		// M48: the last things it said and did (a terminal agent: its screen), live while the peek is open
		for (const l of this.tailLines(row, inner, now)) lines.push(`    ${l}`);
		// M48: the box says what Enter does for a session in this state
		this.reply.setPlaceholder(
			blocked
				? "answer · Enter sends · 1-9 picks a choice · / commands"
				: row.state === "failed"
					? "Enter sends your text · /continue picks it up where it left off · / commands"
					: row.state === "working"
						? "reply · Enter joins its work · Alt+Enter after it · / commands"
						: "reply · Enter sends (a session that ended starts again) · / commands",
		);
		for (const l of this.reply.render(inner)) lines.push(`    ${l}`);
		return lines;
	}

	/** M48: the tail of its transcript (or its screen), re-read at most every 2 s; as many lines as the terminal has room for. */
	private tails = new Map<string, { at: number; key: string; lines: string[] }>();
	private tailLines(row: JobRow, inner: number, now: number): string[] {
		const t = this.o.theme;
		const max = Math.max(3, Math.min(12, Math.floor((this.o.tui.terminal.rows || 30) / 4)));
		const cached = this.tails.get(row.id);
		if (cached && now - cached.at < 2000) return cached.lines.slice(-max);
		let key = "";
		const out: string[] = [];
		try {
			if (row.kind === "shell" || !row.sessionFile) {
				const screen = readFileSync(screenPath(row.id), "utf8");
				for (const l of screen.trimEnd().split("\n")) if (l.trim()) out.push(t.fg("muted", truncateToWidth(oneLine(l), inner)));
			} else {
				const tail = readTail(row.sessionFile);
				key = `${tail.size}:${tail.mtimeMs}`;
				if (cached?.key === key) {
					cached.at = now;
					return cached.lines.slice(-max);
				}
				for (const it of transcriptItems(tail.text, tail.truncated)) {
					if (it.kind === "user") out.push(t.fg("accent", truncateToWidth(`you: ${oneLine(it.text)}`, inner)));
					else if (it.kind === "assistant") out.push(truncateToWidth(`› ${oneLine(it.text)}`, inner));
					else if (it.kind === "tool") out.push(t.fg(it.error ? "error" : "muted", truncateToWidth(`⚙ ${it.name}${it.args ? ` ${oneLine(it.args)}` : ""}`, inner)));
					else out.push(t.fg("dim", truncateToWidth(`· ${oneLine(it.text)}`, inner)));
				}
			}
		} catch {
			// nothing written yet (a session file pi has not created, no screen kept)
		}
		this.tails.set(row.id, { at: now, key, lines: out.slice(-40) });
		return out.slice(-max);
	}

	private footer(): string {
		if (this.renaming) return "Enter rename · Esc cancel";
		if (this.origin) return "Esc/Enter back to your conversation · ↑↓ select · Space peek · ? keys";
		if (this.filter()) return "filtering (s: n: o: a: #PR) · Enter/→ attach · Esc clear";
		if (this.peek) return "Enter send · Alt+Enter after work · 1-9 pick · / commands · Esc close · ? keys";
		const n = this.markedRows().length;
		if (n > 0) return `${n} marked · type, Enter: send to all · /model /thinking · Ctrl+T pin · Ctrl+X stop · Ctrl+O mark · Esc unmark`;
		return "↑↓ select · Enter/→ attach · Space peek · Ctrl+Enter start+attach · Ctrl+X stop · ? keys · Esc exit";
	}

	/** `room`: the lines left under the header. */
	private pickerLines(width: number, room: number): string[] {
		const t = this.o.theme;
		const p = this.picker!;
		const shown = pickerShown(p);
		const height = Math.max(1, Math.min(Math.max(1, shown.length), room - 5));
		const start = Math.max(0, Math.min(p.index - Math.floor(height / 2), shown.length - height));
		const title = p.scope ? `${p.title} · ${p.scope}` : p.title;
		const lines = [t.bold(truncateToWidth(title, width)), truncateToWidth(`${t.fg("dim", "search: ")}${p.query ?? ""}▏`, width), ""];
		if (shown.length === 0) lines.push(t.fg("dim", "  nothing matches"));
		shown.slice(start, start + height).forEach((it, i) => {
			const sel = start + i === p.index;
			lines.push(this.mark(sel, truncateToWidth(sel ? t.fg("accent", it.label) : it.label, Math.max(1, width - 2))));
		});
		const keys = `type to search · ↑↓ choose · Enter pick${p.other ? ` · Tab ${p.other.label}` : ""} · Esc ${p.query ? "clear" : "cancel"}`;
		lines.push("", t.fg("dim", truncateToWidth(keys, width)));
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
			["Ctrl+O", "mark the row (on a header: the group) for a batch"],
			["marked: type, Enter", "send it to every marked session (/model, /thinking too)"],
			["in a peek: Alt+Enter", "send after its current work (Enter: joins it, as in pi)"],
			["in a peek: /…", "that session: /stop /respawn /rm /pin /rename /attach /model /thinking /name /compact /continue /log /transcript /ask"],
			["Tab · /", "complete: / the commands, @ paths (pi's menu: ↑↓ choose, Enter or Tab take)"],
			["Ctrl+G · Ctrl+J", "edit the task or reply in $VISUAL · a new line"],
			["marked: Ctrl+X Ctrl+T", "stop / delete, pin / unpin all of them"],
			["Ctrl+R", "rename"],
			["Shift+↑ Shift+↓", "move the row within its group"],
			["Alt+↑ Alt+↓", "previous / next group"],
			["Alt+1…9", "attach to row N of this directory"],
			["Ctrl+F", "find by name (n:)"],
			["Ctrl+G", "write the task in $VISUAL / $EDITOR"],
			["s: n: o:", "filter by state, name, result; combine with spaces"],
			["@dir task", "start the task in that directory (Tab completes)"],
			["! command", "run a shell command as a job"],
			["/profile", "the agent new sessions run: pi or one of your agentProfiles"],
			["/model /thinking", "defaults for new sessions (bare: pick; default resets)"],
			["Ctrl+L", "pick the model for new sessions (in a peek: for that session)"],
			["Ctrl+P Shift+Ctrl+P", "next / previous enabled model for new sessions"],
			["Shift+Tab", "next thinking level for new sessions"],
			["/worktree", "new sessions in their own git worktree and branch (toggle)"],
			["in a peek: /model", "switch that session's model (/thinking: its level)"],
			["/resume", "open a past session (search; Tab: this directory or all)"],
			["/usage", "what the sessions spent: today, all, by model, by session"],
			["/log", "what happened lately: tasks, questions, results, messages (newest first)"],
			["/concierge on|off|log", "the hub's own agent: watches the sessions, tells you what needs you, relays between them"],
			["/concierge answer|act|undo", "may it answer routine questions itself (never|routine|always), start/stop sessions (on|off); withdraw its last answer"],
			["/concierge orders [add|rm]", "the standing orders it keeps (rules in your words, some on a clock); add one, drop one"],
			["? question", "ask the concierge about the sessions (with it on; help is /help)"],
			["Ctrl+Y · Ctrl+E", "send the concierge's suggested answer to the session that waits · edit it first (the banner under the header)"],
			["/schedule name when task", "run a task on a schedule (every 1h, daily 09:00, weekdays 09:00, cron \"…\"): a pi session, the /profile agent, or a ! command; bare: list"],
			["/fanout a/x b/y", "the next task runs once per model, each in its own worktree"],
			["/compare", "a fan-out (or marked rows) side by side; k keeps one"],
			["/preset [name]", "saved choices for new sessions (save <name>, rm <name>, off)"],
			["Esc", "close peek · clear input · unmark · exit"],
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

/** M27: what a preset sets, short. */
/** Whether a preset reads back as written (key order aside). */
function samePreset(a: Preset | undefined, b: Preset): boolean {
	const norm = (p: Preset) => JSON.stringify(Object.fromEntries(Object.entries(p).sort(([x], [y]) => x.localeCompare(y))));
	return !!a && norm(a) === norm(b);
}

export function presetText(p: Preset): string {
	return [
		p.profile && p.profile !== "pi" && `runs ${p.profile}`,
		p.model && shortModel(p.model),
		p.thinking && `thinking ${p.thinking}`,
		p.worktree === true ? "own worktree" : p.worktree === false ? "no worktree" : undefined,
		p.agent && `as ${p.agent}`,
		p.dir && `@${p.dir}`,
		p.fanout && `fan-out ${p.fanout.map(shortModel).join(", ")}`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** M26: a fan-out's rows say their model (pi names each session on its own, often alike). */
export function rowName(row: JobRow): string {
	if (!row.fanout || !row.model) return row.name;
	const tag = shortModel(row.model);
	return row.name.endsWith(` · ${tag}`) ? row.name : `${row.name} · ${tag}`;
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

/** M48: a directory with the home as `~` (the peek's "where"). */
function tildeDir(dir: string): string {
	const home = process.env.HOME;
	if (!home) return dir;
	return dir === home ? "~" : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

/** M48: a token count in short (`34k`, `1.2M`). */
function kTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Put text in an input with the cursor after it (setValue leaves the cursor where it was). */
function fill(input: { setValue(v: string): void; handleInput(d: string): void }, value: string): void {
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
