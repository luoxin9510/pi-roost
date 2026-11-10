import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { DaemonClient, type DaemonError, GiveUp } from "../lib/client.ts";
import type { OverlayHost } from "./overlay-host.ts";
import { type RoostPort, roostPort } from "./roost-port.ts";
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
import { commandsPath, readCommands, screenPath } from "../lib/store.ts";
import { hostControl } from "../lib/hostclient.ts";
import { PI_COMMANDS, piCommand, type SessionCommand } from "../lib/pi-commands.ts";
import { taskChanges } from "../lib/task-git.ts";
import { type DiffFile, type DiffLine, type TaskDiff, taskDiff } from "../lib/task-diff.ts";
import { commentAnchor, commentOn, outdatedIn } from "../lib/review.ts";
import { nextNeedsYou, overlaps, type TaskChanges, changeShort, type WsEntry, WS_GROUP_TITLES, type WsSession, workspaceEntries, wsCounts, wsDetail, wsIcon, wsKeys, wsRowText } from "../lib/workspace-view.ts";
import { readTail, transcriptItems } from "../lib/transcript.ts";
import { type ConciergeStatus, orderLine, type StandingOrder } from "../lib/concierge.ts";
import { type BoardSummary, type BoardTask, type ReviewComment, boardSummary, liveOrder, manyProjects, projectLabel, projectOf, summaryLine, taskLine, taskPrompt } from "../lib/board.ts";
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

/** M48: one line of a peek's tail, raw (cut to the width when rendered). */
type TailItem = { kind: "you" | "said" | "tool" | "note" | "screen"; text: string; error?: boolean };
/** M48: a peek's tail reads this much of the session file's end (a few lines; the overlay reads more). */
const TAIL_READ_MAX = 256 * 1024;

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
/** M56: how long a shown /tasks approve waits for the same command again. */
const APPROVE_MS = 30_000;
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
	/** M61: a pi session's own slash commands (its worker's commands.json); tests pass a fake. */
	sessionCommands?: (id: string) => SessionCommand[];
	/** M61: the slash commands an agent profile declares. */
	profileCommands?: (profile: string) => { name: string; description?: string }[];
	/** M61: the host's control socket (type a command into pi, read its screen); tests pass a fake. */
	hostControl?: typeof hostControl;
	/** M10: new sessions get a worktree unless /worktree off (config worktreeIsolation "all"). */
	worktreeDefault?: boolean;
	/** M55: how /tasks merge goes into base (config taskMerge). */
	taskMerge?: "ff" | "no-ff";
	/** M55: a task's worktree (tests pass a fake). */
	/** M57: what a task's worktree holds against base (tests pass a fake). */
	taskChanges?: typeof taskChanges;
	/** M58: a task's diff against base (tests pass a fake). */
	taskDiff?: typeof taskDiff;
	/** M59: a shelved task's worktree made again (tests pass a fake). */
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
	/** M71: a pushed event, after the view took it in (the view keeps the one subscription). */
	onEvent?(e: Event): void;
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
	/** M57: the workspace overlay's reload, while it is open (a board event refreshes it). */
	private wsReload: (() => void) | undefined;
	/** M60: the pull request shown for a task, confirmed by /tasks pr again within 30 s. */
	private prShown: { id: number; at: number; hash: string } | undefined;
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
	/** M56: the commands /tasks approve showed, by their hash. */
	private approveShown: { id: number; at: number; hash: string } | undefined;
	/** M61: a built-in command on its way (a second Enter meanwhile is ignored). */
	private commandBusy = false;
	/** M61: sessions' command lists by the mtime of the file they were read from. */
	private commandsCache = new Map<string, { mtime: number; list: SessionCommand[] }>();
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
	/** M47: the task board's counts, as the daemon last said (the header line; /tasks fetches the tasks). */
	private board: BoardSummary | undefined;
	private nameWidth = 16;
	/** M8: the model / context column, the same for every row of a render so it lines up. */
	private columns: Columns = { mode: "none", modelW: 0, shareW: 0, ageW: 0, costW: 0 };
	/** M8: switches sent to live sessions, until their reports show them (or do not). */
	private switches = new Map<string, Switch>();
	/** M25: rows checked with Ctrl+O; the batch keys act on all of them. */
	private marked = new Set<string>();
	private sendingMarked = false;
	/** M51: a peek reply on its way (sent again meanwhile when its answer was lost). */
	private sendingReply = false;
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

	/** M71: the daemon port of a connection (one per client, so a closure holding it keeps its connection). */
	private ports = new WeakMap<DaemonClient, RoostPort>();
	private portFor(client: DaemonClient): RoostPort {
		let port = this.ports.get(client);
		if (!port) this.ports.set(client, (port = roostPort(client, (d) => this.live(d))));
		return port;
	}

	/** M71: the port of the connection now (undefined while there is none). */
	private get port(): RoostPort | undefined {
		return this.client && this.portFor(this.client);
	}

	/** M51: the connection now, waiting a moment while it is being made again (the daemon restarted). */
	private async live(deadline = Date.now() + 10_000): Promise<DaemonClient> {
		const until = Math.min(deadline, Date.now() + 10_000);
		for (;;) {
			if (this.closed) throw new GiveUp("the agent view is closed");
			const c = this.client;
			if (c && !c.isClosed) return c;
			if (Date.now() > until) throw new Error("background service unavailable");
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	private async connect(): Promise<void> {
		if (this.closed) return;
		let client: DaemonClient | undefined;
		try {
			client = await (this.o.connect ?? (() => DaemonClient.connectOrStart()))();
			if (this.closed) return client.close();
			await this.portFor(client).subscribe((e) => this.onEvent(e));
			const { jobs, after } = await this.listFrom(client);
			if (this.closed) return client.close();
			this.rows = new Map(jobs.map((j) => [j.id, j]));
			for (const e of after) this.applyRow(e);
			for (const j of jobs) observeJob(j); // what is already there is not news
			for (const j of jobs) this.checkSwitch(j); // a switch shown while we were away
			// M44: a daemon from before the concierge has no such op: then there is none
			this.concierge = await this.portFor(client).concierge.status().catch(() => undefined);
			// M47: the board's counts (a daemon from before the board has no such op: then there is none)
			this.board = await this.portFor(client)
				.tasks.list()
				.then((r) => boardSummary(r.tasks))
				.catch(() => undefined);
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
		const port = this.portFor(client);
		const off = port.listen((e) => heard.push({ e, at: port.position() }));
		try {
			const { result, at } = await port.jobs.listAt(this.o.cwdFilter ? { cwd: this.o.cwdFilter } : {});
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
		} else if (e.event === "board") {
			// M47: the counts for the header; an open /tasks overlay fetches the tasks itself
			this.board = e.board;
			// M57: the workspace overlay follows the board
			this.wsReload?.();
		}
		try {
			this.overlay?.onEvent?.(e);
		} catch {}
		this.render0();
	}

	/** M71: what an overlay gets from the view (no overlay uses it yet: they move in M72–M74). */
	/** The host of an overlay opened on `port` (the connection it was opened on, as the closures hold theirs). */
	overlayHost(port: RoostPort): OverlayHost {
		return {
			port,
			theme: this.o.theme,
			say: (text, tone) => this.say(text, tone),
			close: () => this.closeOverlay(),
			requestRender: () => this.o.tui.requestRender(),
			attachTo: (id) => this.attachTo(id),
			rows: () => this.rows,
			taskDiff: this.o.taskDiff,
			taskChanges: this.o.taskChanges,
			worktreeChange: this.o.worktreeChange,
			hostControl: this.o.hostControl,
		};
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
		// M17: Ctrl+J (a bare LF) adds a line; a paste arriving in pieces goes to the editor whole (M48: the reply box too)
		if (data === "\n" || typing.inPaste()) {
			typing.handleInput(data);
			this.o.tui.requestRender();
			return;
		}
		// M48: the open completion menu takes its keys; Enter on a / command takes it and runs it at
		// once (as pi's prompt does); on a path it only completes
		if (typing.autocompleteOpen() && (key === "tab" || key === "up" || key === "down" || key === "enter" || key === "escape")) {
			typing.handleInput(data);
			if (key === "enter" && typing.getValue().startsWith("/")) return void this.enter();
			this.o.tui.requestRender();
			return;
		}

		switch (key) {
			case "tab":
				// M6: @dir in the task box; else (M48) pi's menu, forced open as pi's Tab does
				if (!this.peek && this.completeAt()) return;
				typing.handleInput(data);
				this.o.tui.requestRender();
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
			case "ctrl+n":
				// M57: the workspace overlay, at the next task that needs you
				return void this.showWorkspaces(true);
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
			case "tasks":
			case "task":
				void this.tasksCommand(arg);
				return done();
			case "workspaces":
			case "ws":
				void this.showWorkspaces(false);
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
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		const words = arg.trim().split(/\s+/).filter(Boolean);
		try {
			if (words.length === 0 || (words.length === 1 && words[0] === "list")) return await this.showSchedules();
			const [verb, name] = words as [string, string | undefined];
			if (words.length === 2 && name && ["rm", "pause", "resume", "run"].includes(verb)) {
				if (verb === "rm") {
					await port.schedules.rm(name);
					return this.say(`schedule ${name} removed`);
				}
				if (verb === "run") {
					const r = await port.schedules.run(name);
					this.cursor = { kind: "row", id: r.id };
					return this.say(`schedule ${name} started a run`, "success");
				}
				const r = await port.schedules.pause(name, verb === "pause");
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
			const r = await port.schedules.add({ name: p.name, when: p.when, launch, task: p.task });
			this.say(`schedule ${r.name}: ${r.when} · first run ${r.nextAt === null ? "never" : untilText(r.nextAt)}`, "success");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M39 /schedule list: each schedule, when it runs next, its last run; Esc closes. */
	private async showSchedules(): Promise<void> {
		const list = (await this.port!.schedules.list()).schedules;
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
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		let events: RoostEvent[];
		const fetch = async () => (await port.events.list({ limit: 500 })).events.filter((e) => !only || only(e)).slice(-200);
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
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		const [verb = "status", ...rest] = arg.trim().split(/\s+/).filter(Boolean);
		try {
			if (verb === "on") {
				if (this.concierge?.on) return this.say(this.conciergeLine(), "muted");
				// the job it had is started again; a first start needs a launch
				if (this.concierge?.id) this.concierge = await port.concierge.on();
				else {
					if (!this.o.conciergeLaunch) return this.say("the concierge is not available here", "warning");
					const { discard: _d, note: _n, ...launch } = this.o.conciergeLaunch();
					this.concierge = await port.concierge.on(launch);
				}
				return this.say(`concierge on (${this.concierge.model ?? "its model"}) · ? asks it · /concierge off stops it`, "success");
			}
			if (verb === "off") {
				this.concierge = await port.concierge.off();
				this.asked(false);
				return this.say("concierge off", "muted");
			}
			if (verb === "status") {
				this.concierge = await port.concierge.status();
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
				this.concierge = await port.concierge.answer(answer);
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
				this.concierge = await port.concierge.act(v === "on");
				return this.say(v === "on" ? "concierge may start, stop and restart sessions (when you ask it to)" : "concierge may not start, stop or restart sessions", "success");
			}
			if (verb === "undo") {
				this.concierge = await port.concierge.undo();
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
					const { order } = await port.concierge.orders.add(m ? m[2]! : words, when);
					return this.say(`kept standing order #${order?.id}${when ? ` (${when})` : ""}; the concierge sees it on its next wake`, "success");
				}
				if (sub === "rm") {
					const id = Number(more[0]);
					if (!Number.isInteger(id)) return this.say("/concierge orders rm <id>", "warning");
					await port.concierge.orders.rm(id);
					return this.say(`dropped standing order #${id}`, "success");
				}
				if (sub) return this.say("/concierge orders | orders add <rule> | orders rm <id>", "warning");
				const { orders } = await port.concierge.orders.list();
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
		if (!row?.suggested || !this.port) return;
		const text = row.suggested.text;
		// once: a second press before the row moves would answer its next question (the
		// banner is back if the send did not go)
		const key = `${row.id}:${row.suggested.at}`;
		this.dismissed.add(key);
		try {
			const r = await this.port.jobs.reply({ id: row.id, text, requestId: `hub-accept-${row.id}-${row.suggested.at}`.slice(0, 64) });
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
		if (!this.port) return this.say("background service unavailable", "error");
		if (!this.concierge?.on) return this.say("the concierge is off: /concierge on starts it", "warning");
		try {
			await this.port.concierge.ask(q);
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
		if (!this.port) return this.say("background service unavailable", "error");
		const args = this.o.launch("", { cwd: s.cwd || this.dispatchCwd(), sessionFile: s.path, name: s.name, origin: "adopt" });
		let r: { id: string; name: string };
		try {
			r = await this.port.jobs.dispatch(args, { tag: "hub" });
		} catch (err) {
			// M51: lost (sent, no answer) may have been taken: what it made stays
			if ((err as DaemonError).code !== "lost") args.discard?.();
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
		if (marked.length > 0 && this.port) {
			// M25: pin them all, unless all are pinned already
			const pinned = marked.some((r) => !r.pinned);
			let failed = 0;
			for (const r of marked) {
				try {
					await this.port.jobs.pin(r.id, pinned);
				} catch {
					failed++;
				}
			}
			return this.say(`${pinned ? "pinned" : "unpinned"} ${marked.length - failed} sessions${failed ? ` · ${failed} failed` : ""}`, failed ? "warning" : "muted");
		}
		const row = this.selectedRow();
		if (!row || !this.port) return;
		try {
			const { pinned } = await this.port.jobs.pin(row.id, !row.pinned);
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
			if (!name || !this.port) return;
			void this.port
				.jobs.rename(id, name)
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
		if (it?.kind !== "row" || !this.port) return;
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
			await this.port.jobs.reorder(ids, key);
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
		if (!this.port) return this.say("background service unavailable", "error");
		this.dispatching = true;
		this.input.setValue("");
		try {
			const { id, name } = await this.port.jobs.dispatch(request, { tag: "hub" });
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
		if (!text || !this.port || this.sendingReply) return;
		// M48: a /command the peek knows is for that session (M8: /model and /thinking among them);
		// any other /… goes to the session as a reply (pi's prompt templates and skills, say)
		const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
		const name = cmd?.[1]?.toLowerCase();
		if (cmd && name && PEEK_COMMANDS.some((c) => c.name === name)) {
			try {
				await this.peekCommand(row, name, (cmd[2] ?? "").trim());
			} catch (err) {
				this.say((err as Error).message, "error");
			}
			return;
		}
		// M61: pi's own commands (/session, /tree, …) are typed into the session's pi: its worker never sees them
		const builtin = name ? piCommand(name) : undefined;
		if (cmd && name && builtin && builtin.how !== "hub" && row.kind === "pi") {
			try {
				// pi matches its commands exactly: the name as pi spells it, the arguments as typed
				await this.piBuiltin(row, name, builtin.how, `/${name}${cmd[2]?.trim() ? ` ${cmd[2].trim()}` : ""}`);
			} catch (err) {
				this.say((err as Error).message, "error");
			}
			return;
		}
		if (text.startsWith("!")) return this.say("shell commands are not sent to a session; attach (→) to run one", "warning");
		try {
			// M51: one at a time (a second Enter while it is sent again would send it twice)
			this.sendingReply = true;
			const r = await this.port.jobs.reply({ id: row.id, text, mode }, { tag: "hub" }).finally(() => {
				this.sendingReply = false;
			});
			this.reply.setValue("");
			if (r.duplicate) this.say(`sent · ${row.name}`, "success");
			else if (r.stopped) this.say(`stopped · ${row.name}`);
			else if (r.delivered) {
				const how = row.state !== "working" ? "" : mode === "steer" ? " · joins its current work" : " · after its current work";
				// M61: the session's own command says so
				const own = name && this.sessionCommandList(row).some((c) => c.name.toLowerCase() === name);
				this.say(row.waitingFor === "dialog" ? "queued; attach (→) to answer the dialog" : `${own ? `/${name}` : "sent"} · ${row.name}${how}`, "success");
			} else if (r.respawned) this.say(`sent · starting ${row.name} again`, "success");
			else if (r.saved) this.say(`saved; it is sent when the session starts again${r.error ? ` (${r.error})` : ""}`, "warning");
			else this.say("not delivered: the session is not running", "error");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/**
	 * M47: `/tasks`: the shared task board. Bare: the board. `add <title> [after #n …] [-- detail]`,
	 * `assign <id> <session>`, `done <id> [result]`, `rm <id>`, `release <id>`.
	 */
	private async tasksCommand(arg: string): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		const [verb = "", ...rest] = arg.trim().split(/\s+/).filter(Boolean);
		const idOf = (s: string | undefined): number | undefined => {
			const n = Number((s ?? "").replace(/^#/, ""));
			return Number.isInteger(n) && n > 0 ? n : undefined;
		};
		try {
			// M52: the board of the project the hub is in (its repository) and the tasks for any session; `all`: every task
			const here = projectOf(this.dispatchCwd());
			if (!verb || verb === "list" || verb === "all") {
				const every = verb === "all" || here === null;
				const { tasks } = await port.tasks.list(every ? {} : { project: here! });
				if (every) this.board = boardSummary(tasks);
				return this.showTasks(tasks, every ? "all projects" : projectLabel(here));
			}
			if (verb === "add") {
				// the title, then `after #2 #3`, then ` -- ` and the detail
				const text = rest.join(" ");
				const dash = text.indexOf(" -- ");
				let title = (dash >= 0 ? text.slice(0, dash) : text).trim();
				const detail = dash >= 0 ? text.slice(dash + 4).trim() : "";
				const after: number[] = [];
				// `after #2 #3` (the first with a #: "retry after 3" is a title); no nested quantifier (no backtracking blow-up)
				const m = /\s+after\s+(#\d+(?:[\s,]+#?\d+)*)[\s,]*$/i.exec(title);
				if (m) {
					for (const x of m[1]!.split(/[\s,]+/).filter(Boolean)) {
						const n = idOf(x);
						if (n !== undefined) after.push(n);
					}
					title = title.slice(0, m.index).trim();
				}
				if (!title) return this.say("/tasks add <title> [after #n] [-- detail]", "warning");
				const r = await port.tasks.add({ title, detail: detail || undefined, after: after.length > 0 ? after : undefined, project: here });
				return this.say(`task #${r.task?.id} added${here ? ` to ${projectLabel(here)}` : ""}: ${title}${after.length > 0 ? ` (after ${after.map((n) => `#${n}`).join(", ")})` : ""}`, "success");
			}
			const id = idOf(rest[0]);
			if (verb === "assign" || verb === "give") {
				const to = rest.slice(1).join(" ");
				if (id === undefined || !to) return this.say("/tasks assign <id> <session id or name>", "warning");
				const r = await port.tasks.assign(id, to);
				const who = r.task?.assigned?.name ?? to;
				return this.say(r.sent === "delivered" || r.sent === "queued" || r.sent === "started" ? `task #${id} handed to ${who}` : `task #${id} not handed over: ${who} is not running`, r.sent === "delivered" || r.sent === "queued" || r.sent === "started" ? "success" : "warning");
			}
			if (verb === "done") {
				if (id === undefined) return this.say("/tasks done <id> [result]", "warning");
				await port.tasks.done(id, rest.slice(1).join(" ") || undefined);
				return this.say(`task #${id} done`, "success");
			}
			if (verb === "rm" || verb === "drop") {
				if (id === undefined) return this.say("/tasks rm <id>", "warning");
				await port.tasks.drop(id);
				return this.say(`task #${id} dropped`, "muted");
			}
			if (verb === "release") {
				if (id === undefined) return this.say("/tasks release <id>", "warning");
				await port.tasks.release(id);
				return this.say(`task #${id} is open again`, "muted");
			}
			// M55: a task's own workspace
			if (verb === "start") {
				if (id === undefined) return this.say("/tasks start <id>", "warning");
				return await this.startTask(id);
			}
			// M59: shelve a task (worktree removed, branch kept); remove what was left behind
			if (verb === "shelve") {
				if (id === undefined) return this.say("/tasks shelve <id>", "warning");
				const r = await port.tasks.shelve(id);
				return this.say(`#${id} ${r.note ?? "shelved"}`, "success");
			}
			if (verb === "cleanup") {
				const go = rest[0] === "yes";
				const r = await port.tasks.cleanup(!go);
				const lines = (r.note ?? "").split("\n").filter(Boolean);
				const nothing = lines.length === 1 && lines[0] === "nothing left behind";
				if (nothing) return this.say("nothing left behind", "muted");
				return this.showLines(go ? "Cleaned up" : "Left behind · /tasks cleanup yes removes it (never a worktree with changes, never an unmerged branch)", lines);
			}
			if (verb === "review") {
				if (id === undefined) return this.say("/tasks review <id>", "warning");
				return await this.openReview(id);
			}
			if (verb === "merge") {
				if (id === undefined) return this.say("/tasks merge <id>", "warning");
				this.say(`merging #${id}…`, "muted");
				const r = await port.tasks.merge(id, this.o.taskMerge ?? "ff");
				const stage = r.task?.workspace?.stage;
				return this.say(`#${id}: ${r.note ?? stage ?? "?"}`, stage === "merged" ? "success" : "warning");
			}
			if (verb === "back") {
				if (id === undefined) return this.say("/tasks back <id> [what to change]", "warning");
				const r = await port.tasks.back(id, rest.slice(1).join(" ") || undefined);
				return this.say(`#${id} back to work · ${r.note ?? ""}`, "success");
			}
			if (verb === "abort") {
				if (id === undefined) return this.say("/tasks abort <id>", "warning");
				await port.tasks.abort(id);
				return this.say(`#${id}: sync aborted, in review again`, "muted");
			}
			if (verb === "commit") {
				if (id === undefined) return this.say("/tasks commit <id> [message]", "warning");
				const r = await port.tasks.commit(id, rest.slice(1).join(" ") || undefined);
				return this.say(`#${id}: ${r.note ?? "committed"}`, "success");
			}
			// M56: the repository's commands: shown, then approved by the same command again
			if (verb === "approve") {
				if (id === undefined) return this.say("/tasks approve <id>", "warning");
				const shown = this.approveShown;
				if (!shown || shown.id !== id || Date.now() - shown.at >= APPROVE_MS) {
					const r = await port.tasks.approve({ id, dry: true });
					if (!r.hash) return this.say(r.note ?? "nothing to approve", "warning");
					this.approveShown = { id, at: Date.now(), hash: r.hash };
					return this.say(`${r.note} · they run in your account: /tasks approve ${id} again within 30 s to approve`, "warning");
				}
				this.approveShown = undefined;
				// what is approved is what was shown (the daemon refuses if the commands changed)
				const r = await port.tasks.approve({ id, hash: shown.hash });
				return this.say(r.note ?? "approved", "success");
			}
			// M60: the optional exit: shown, then the same command again within 30 s (for the tip shown)
			if (verb === "pr") {
				if (id === undefined) return this.say("/tasks pr <id>", "warning");
				const shown = this.prShown;
				if (!shown || shown.id !== id || Date.now() - shown.at >= APPROVE_MS) {
					const r = await port.tasks.pr({ id, dry: true });
					this.prShown = { id, at: Date.now(), hash: r.hash ?? "" };
					return this.say(`#${id}: ${r.note} · /tasks pr ${id} again within 30 s to do it`, "warning");
				}
				this.prShown = undefined;
				this.say(`#${id}: pushing…`, "muted");
				const r = await port.tasks.pr({ id, hash: shown.hash });
				return this.say(`#${id}: ${r.note ?? "opened"}`, "success");
			}
			if (verb === "verify") {
				if (id === undefined) return this.say("/tasks verify <id>", "warning");
				const r = await port.tasks.verify(id);
				return this.say(`#${id}: ${r.note ?? "verifying"}`, "success");
			}
			if (verb === "pass") {
				if (id === undefined) return this.say("/tasks pass <id>", "warning");
				await port.tasks.pass(id);
				return this.say(`#${id}: in review (passed by hand)`, "muted");
			}
			return this.say("/tasks [all | add <title> [after #n] [-- detail] | start <id> | review <id> | merge <id> | pr <id> | shelve <id> | cleanup [yes] | approve <id> | verify <id> | pass <id> | back <id> [note] | abort <id> | commit <id> [msg] | assign <id> <session> | done <id> [result] | rm <id> | release <id>]", "warning");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/**
	 * M55/M65: a task in its own worktree: the daemon makes it (prepare: where), a session
	 * is launched in it as /new launches one, and the daemon starts it there and claims the
	 * task for it. A worktree prepared for a start that does not come is the daemon's to
	 * remove (a refused start's at once, one never asked for after a while).
	 */
	private async startTask(id: number): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		const { tasks } = await port.tasks.list();
		const t = tasks.find((x) => x.id === id);
		if (!t) return this.say(`no task #${id}`, "warning");
		if (!t.project) return this.say(`#${id} is for any session: add it in a repository to give it a workspace`, "warning");
		try {
			const w = (await port.tasks.prepare(id)).workspace;
			if (!w) return this.say(`#${id}: no worktree came back`, "error");
			const { discard: _d, note: _n, ...rest } = this.o.launch(taskPrompt(t), { cwd: w.path, model: this.model, thinking: this.thinking, worktree: false });
			const r = await port.tasks.start(id, rest as DispatchArgs);
			if (r.job) this.cursor = { kind: "row", id: r.job.id };
			this.say(`#${id} started · ${r.job?.name ?? "?"} · ⎇ ${w.branch}${w.sourceDirty ? " · uncommitted changes in the main checkout are not in it" : ""}`, w.sourceDirty ? "warning" : "success");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** M59: lines in an overlay (what cleanup found or did); ↑↓ scroll, Esc closes. */
	private showLines(title: string, lines: string[]): void {
		const view = this;
		const t = this.o.theme;
		let top = 0;
		this.overlay = {
			render(width: number) {
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				const body = lines.map((l) => truncateToWidth(`  ${oneLine(l)}`, width));
				top = Math.max(0, Math.min(top, Math.max(0, body.length - room)));
				return [t.bold(truncateToWidth(title, width)), "", ...body.slice(top, top + room), "", t.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
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

	/** M47: the board as an overlay: open (claimable), blocked, claimed, then done, newest first. */
	private showTasks(tasks: BoardTask[], scope = "all projects"): void {
		const projects = manyProjects(tasks);
		let top = 0;
		const view = this;
		const lines = (width: number): string[] => {
			const t = view.o.theme;
			const now = Date.now();
			const out = [t.bold(truncateToWidth(`Task board · ${scope} · ${summaryLine(boardSummary(tasks))}`, width)), ""];
			const live = tasks.filter((x) => x.state === "open" || x.state === "claimed");
			const group = (x: BoardTask) => liveOrder(x, tasks);
			for (const x of [...live].sort((a, b) => group(a) - group(b) || a.id - b.id)) {
				const g = group(x);
				const line = oneLine(taskLine(x, tasks, now, projects));
				out.push(truncateToWidth(`  ${t.fg(g === 0 ? "accent" : g === 1 ? "warning" : "muted", line)}`, width));
				if (x.detail && g !== 2) out.push(truncateToWidth(`      ${t.fg("dim", oneLine(x.detail))}`, width));
			}
			if (live.length === 0) out.push(t.fg("dim", tasks.some((x) => x.state === "done") ? "  every task is done" : "  the board is empty"));
			const done = tasks.filter((x) => x.state === "done").sort((a, b) => (b.doneAt ?? b.at) - (a.doneAt ?? a.at));
			if (done.length > 0) {
				out.push("");
				for (const x of done.slice(0, 30)) out.push(truncateToWidth(`  ${t.fg("dim", oneLine(taskLine(x, tasks, now, projects)))}`, width));
				if (done.length > 30) out.push(t.fg("dim", `  … ${done.length - 30} more done`));
			}
			out.push("", t.fg("dim", truncateToWidth("/tasks all · add <title> [after #n] [-- detail] · assign <id> <session> · done <id> [result] · rm <id> · release <id>", width)));
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

	/**
	 * M57: the workspace overlay: this repository's tasks (every project's outside one) as a
	 * pipeline, what needs you first; the selected one's detail beside it (below it under 100
	 * columns); the keys act on it. `next`: open at the next task that needs you.
	 */
	private wsOpening = false;
	private async showWorkspaces(next: boolean, focus?: number): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		// a second Ctrl+N while the first loads opens nothing more
		if (this.wsOpening) return;
		this.wsOpening = true;
		try {
			await this.openWorkspaces(port, next, focus);
		} finally {
			this.wsOpening = false;
		}
	}

	private async openWorkspaces(port: RoostPort, next: boolean, focus?: number): Promise<void> {
		const view = this;
		const t = this.o.theme;
		const here = projectOf(this.dispatchCwd());
		const changesOf = this.o.taskChanges ?? taskChanges;
		let tasks: BoardTask[] = [];
		let entries: WsEntry[] = [];
		let sel: number | undefined;
		let top = 0;
		let back: { id: number; input: Input } | undefined;
		// approve: the commands shown in full, then y (the dry call's hash goes with it)
		let confirm: { id: number; note: string; hash: string; kind: "approve" | "pr" } | undefined;
		let busy = false;
		let closed = false;
		const changes = new Map<number, { key: string; at: number; c?: TaskChanges; loading: boolean }>();
		const sessionOf = (x: BoardTask): WsSession | undefined => {
			const r = x.owner ? view.rows.get(x.owner.id) : undefined;
			return r ? { name: oneLine(rowName(r)), state: r.state, waitingFor: r.waitingFor ?? null, running: r.pid !== null } : undefined;
		};
		const selected = (): BoardTask | undefined => entries.find((e) => e.task.id === sel)?.task;
		// what each worktree holds: read again when its stage, note or verify changed, or after 5 s
		const fetchChanges = () => {
			const now = Date.now();
			for (const e of entries) {
				const w = e.task.workspace;
				if (!w || !w.path || w.stage === "merged" || !w.baseRef) continue;
				const key = `${w.stage}:${w.note ?? ""}:${w.verify?.at ?? 0}`;
				const hit = changes.get(e.task.id);
				if (hit && (hit.loading || (hit.key === key && now - hit.at < 5000))) continue;
				changes.set(e.task.id, { key, at: now, c: hit?.c, loading: true });
				void changesOf(w.path, w.baseRef).then(
					(c) => {
						changes.set(e.task.id, { key, at: Date.now(), c, loading: false });
						if (!closed) view.o.tui.requestRender();
					},
					() => changes.set(e.task.id, { key, at: Date.now(), loading: false }),
				);
			}
		};
		const load = async (pickNext: boolean): Promise<void> => {
			const r = await port.tasks.list(here ? { project: here } : {});
			if (closed) return;
			tasks = r.tasks;
			entries = workspaceEntries(tasks);
			if (pickNext) sel = nextNeedsYou(entries, undefined, sessionOf) ?? sel;
			else if (focus !== undefined && sel === undefined) sel = focus;
			if (sel === undefined || !entries.some((e) => e.task.id === sel)) sel = entries[0]?.task.id;
			fetchChanges();
			view.o.tui.requestRender();
		};
		let reloading: Promise<void> | undefined;
		let again = false;
		let self: Overlay | undefined;
		const reload = () => {
			// replaced by another overlay without closing: stop following the board
			if (self && view.overlay !== self) closed = true;
			if (closed) {
				if (view.wsReload === reload) view.wsReload = undefined;
				return;
			}
			// one load at a time; one more after it when asked meanwhile (its answer may predate the change)
			if (reloading) {
				again = true;
				return;
			}
			reloading = load(false)
				.catch((err: unknown) => view.say((err as Error).message, "error"))
				.finally(() => {
					reloading = undefined;
					if (again) {
						again = false;
						reload();
					}
				});
		};
		try {
			await load(next);
		} catch (err) {
			return this.say((err as Error).message, "error");
		}
		if (next && (sel === undefined || !nextNeedsYou(entries, undefined, sessionOf))) this.say(entries.length > 0 ? "nothing needs you" : "no tasks in workspaces: /tasks add, then s on it here", "muted");
		// a verb of /tasks on the selected task; the overlay reloads after it
		const act = (verb: string, x: BoardTask, extra = "") => {
			if (busy) return;
			busy = true;
			void view.tasksCommand(`${verb} ${x.id}${extra ? ` ${extra}` : ""}`).finally(() => {
				busy = false;
				reload();
			});
		};
		// M60: tasks changing the same files (from what was read of each worktree)
		let overlapNow = new Map<number, { id: number; files: string[] }[]>();
		const listLines = (width: number): { lines: string[]; selAt: number } => {
			overlapNow = overlaps(entries, (id) => changes.get(id)?.c);
			const lines: string[] = [];
			let selAt = 0;
			let group = "";
			for (const e of entries) {
				if (e.group !== group) {
					group = e.group;
					lines.push(t.fg("dim", truncateToWidth(WS_GROUP_TITLES[e.group], width)));
				}
				const s = sessionOf(e.task);
				const icon = wsIcon(e.task, s);
				const isSel = e.task.id === sel;
				if (isSel) selAt = lines.length;
				const shared = overlapNow.has(e.task.id) ? "⚠ " : "";
				const right = `${shared}${changeShort(changes.get(e.task.id)?.c) || (e.task.workspace?.stage === "working" && s && !s.running ? "idle" : "")}`.trim();
				const head = `${isSel ? t.fg("accent", "▶") : " "} ${t.fg(icon.tone, icon.glyph)} `;
				const room = Math.max(1, width - visibleWidth(head) - (right ? visibleWidth(right) + 1 : 0));
				const text = truncateToWidth(oneLine(wsRowText(e.task, tasks)), room);
				const gap = " ".repeat(Math.max(1, width - visibleWidth(head) - visibleWidth(text) - visibleWidth(right)));
				lines.push(truncateToWidth(`${head}${isSel ? t.bold(text) : text}${right ? `${gap}${t.fg("dim", right)}` : ""}`, width));
			}
			if (entries.length === 0) lines.push(t.fg("dim", truncateToWidth(here ? "no tasks here: /tasks add <title>" : "no tasks", width)));
			return { lines, selAt };
		};
		const detailLines = (width: number, max: number): string[] => {
			const x = selected();
			if (!x) return [];
			const s = sessionOf(x);
			const row = x.owner ? view.rows.get(x.owner.id) : undefined;
			const hit = changes.get(x.id);
			const items = wsDetail(x, { session: s, sentence: row ? sentenceOf(row) : undefined, changes: hit?.c ?? (hit?.loading ? "loading" : undefined), fileMax: Math.max(2, max - 12), overlap: overlapNow.get(x.id) });
			const out = [t.bold(truncateToWidth(`#${x.id} ${oneLine(x.title)}`, width))];
			for (const it of items) {
				const label = it.label ? it.label.padEnd(7) : " ".repeat(7);
				const text = truncateToWidth(oneLine(it.text), Math.max(1, width - 8));
				out.push(`${t.fg("dim", label)} ${it.tone ? t.fg(it.tone, text) : text}`);
			}
			return out.slice(0, max);
		};
		this.wsReload = reload;
		this.overlay = self = {
			render(width: number) {
				const rows = view.o.tui.terminal.rows || 30;
				const room = Math.max(4, rows - 8);
				const title = `${here ? projectLabel(here) : "all projects"} · workspaces`;
				const counts = wsCounts(entries);
				const pad = Math.max(1, width - visibleWidth(title) - visibleWidth(counts));
				const out = [truncateToWidth(`${t.bold(title)}${" ".repeat(pad)}${t.fg("dim", counts)}`, width), ""];
				const wide = width >= 100;
				const listW = wide ? Math.min(48, Math.floor(width * 0.42)) : width;
				const { lines: list, selAt } = listLines(listW);
				const listRoom = wide ? room : Math.max(3, Math.floor(room / 2));
				// the selection stays in view
				if (selAt < top) top = selAt;
				if (selAt >= top + listRoom) top = selAt - listRoom + 1;
				top = Math.max(0, Math.min(top, Math.max(0, list.length - listRoom)));
				const shown = list.slice(top, top + listRoom);
				if (wide) {
					const detail = detailLines(width - listW - 3, room);
					for (let i = 0; i < Math.max(shown.length, detail.length); i++) {
						const l = shown[i] ?? "";
						out.push(`${l}${" ".repeat(Math.max(0, listW - visibleWidth(l)))} ${t.fg("dim", "│")} ${detail[i] ?? ""}`);
					}
				} else {
					out.push(...shown, t.fg("dim", "─".repeat(Math.min(width, 40))), ...detailLines(width, Math.max(3, room - shown.length - 1)));
				}
				out.push("");
				if (back) out.push(...back.input.render(width));
				if (confirm) for (const l of wrap(confirm.kind === "approve" ? `approve for #${confirm.id}: ${confirm.note} · they run in your account` : `#${confirm.id}: ${confirm.note}?`, width)) out.push(t.fg("warning", l));
				const n = view.notice;
				if (n && n.until > Date.now()) out.push(t.fg(n.tone, truncateToWidth(oneLine(n.text), width)));
				const x = selected();
				const keys = back ? "Enter send back with this note (empty: none) · Esc cancel" : confirm ? `y ${confirm.kind === "approve" ? "approve these commands" : "push and open it"} · any other key: no` : [...wsKeys(x, x ? sessionOf(x) : undefined).map(([k, v]) => `${k} ${v}`), "↑↓ select", "Esc close"].join(" · ");
				out.push(t.fg("dim", truncateToWidth(keys, width)));
				return out;
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (back) {
					if (key === "escape" || key === "ctrl+c") back = undefined;
					else if (key === "enter") {
						// the task the note was written for, wherever the selection went meanwhile
						const note = oneLine(back.input.getValue()).trim();
						const x = tasks.find((y) => y.id === back!.id);
						back = undefined;
						if (x) act("back", x, note);
					} else back.input.handleInput(data);
					return;
				}
				if (confirm) {
					const c = confirm;
					confirm = undefined;
					if (data !== "y" || busy) return view.say(c.kind === "approve" ? "not approved" : "no pull request", "muted");
					busy = true;
					if (c.kind === "pr") view.say(`#${c.id}: pushing…`, "muted");
					void (c.kind === "pr" ? port.tasks.pr({ id: c.id, hash: c.hash }) : port.tasks.approve({ id: c.id, hash: c.hash }))
						.then((r) => view.say(r.note ?? "approved", "success"))
						.catch((err: unknown) => view.say((err as Error).message, "error"))
						.finally(() => {
							busy = false;
							reload();
						});
					return;
				}
				if (key === "escape" || key === "ctrl+c" || data === "q") return view.closeOverlay();
				const i = entries.findIndex((e) => e.task.id === sel);
				if (key === "up" || key === "down") {
					const j = Math.max(0, Math.min(entries.length - 1, (i < 0 ? 0 : i) + (key === "up" ? -1 : 1)));
					sel = entries[j]?.task.id;
					fetchChanges();
					return;
				}
				if (key === "home" || key === "end") {
					sel = (key === "home" ? entries[0] : entries[entries.length - 1])?.task.id;
					fetchChanges();
					return;
				}
				if (data === "n" || key === "ctrl+n") {
					const to = nextNeedsYou(entries, sel, sessionOf);
					if (to === undefined) view.say("nothing needs you", "muted");
					else sel = to;
					return;
				}
				if (data === "r") {
					changes.clear();
					return reload();
				}
				const x = selected();
				if (!x) return;
				const s = sessionOf(x);
				const allowed = new Set(wsKeys(x, s).map(([k]) => k));
				// M58: Enter reviews a task with a workspace (its diff, comments); Esc comes back here
				if (key === "enter" && x.workspace?.path && x.workspace.stage !== "merged" && x.workspace.stage !== "shelved") {
					const at = x.id;
					view.closeOverlay();
					return void view.openReview(at, () => void view.showWorkspaces(false, at));
				}
				const attach = data === "t" || key === "right" || key === "enter";
				if (attach) {
					if (s?.running && x.owner) {
						view.closeOverlay();
						return void view.attachTo(x.owner.id).catch((err: unknown) => view.say(String((err as Error).message ?? err), "error"));
					}
					if (data === "t" || key === "right") view.say(`#${x.id} has no session running${allowed.has("s") ? ": s starts one" : ""}`, "muted");
					return;
				}
				if (!allowed.has(data)) return;
				if (data === "b") {
					back = { id: x.id, input: new Input({ prompt: `#${x.id} back › ` }) };
					back.input.focused = true;
					return;
				}
				if (data === "o") {
					if (busy) return;
					busy = true;
					void port.tasks
						.pr({ id: x.id, dry: true })
						.then((r) => {
							if (r.hash) confirm = { id: x.id, note: oneLine(r.note ?? ""), hash: r.hash, kind: "pr" };
						})
						.catch((err: unknown) => view.say((err as Error).message, "error"))
						.finally(() => {
							busy = false;
							view.o.tui.requestRender();
						});
					return;
				}
				if (data === "a") {
					if (busy) return;
					busy = true;
					void port.tasks
						.approve({ id: x.id, dry: true })
						.then((r) => {
							if (r.hash) confirm = { id: x.id, note: oneLine(r.note ?? ""), hash: r.hash, kind: "approve" };
							else view.say(r.note ?? "nothing to approve", "muted");
						})
						.catch((err: unknown) => view.say((err as Error).message, "error"))
						.finally(() => {
							busy = false;
							view.o.tui.requestRender();
						});
					return;
				}
				const verb = { s: "start", m: "merge", v: "verify", p: "pass", x: "abort", h: "shelve" }[data];
				if (verb) act(verb, x);
			},
			dispose() {
				closed = true;
				if (view.wsReload === reload) view.wsReload = undefined;
			},
		};
		this.o.tui.requestRender();
	}

	/**
	 * M58: a task's review: its diff against base (committed and not), a file at a time, the
	 * person's comments under their lines; c comments, b sends back with them, m merges.
	 * `onClose`: where Esc goes (the workspace overlay it came from).
	 */
	private reviewOpening = false;
	private async openReview(id: number, onClose?: () => void): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
		// a second Enter while it loads opens nothing more
		if (this.reviewOpening) return;
		this.reviewOpening = true;
		try {
			await this.reviewOverlay(port, id, onClose);
		} finally {
			this.reviewOpening = false;
		}
	}

	private async reviewOverlay(port: RoostPort, id: number, onClose?: () => void): Promise<void> {
		const view = this;
		const t = this.o.theme;
		const diffOf = this.o.taskDiff ?? taskDiff;
		let task: BoardTask | undefined;
		let diff: TaskDiff | undefined;
		let fi = 0;
		let ri = -1; // -1: the file's first line of diff
		let top = 0;
		let input: { kind: "comment" | "back"; box: Input } | undefined;
		let busy = false;
		let closed = false;
		let self: Overlay | undefined;
		const load = async (): Promise<void> => {
			const { tasks } = await port.tasks.list();
			task = tasks.find((x) => x.id === id);
			const w = task?.workspace;
			if (!task || !w || !w.path) throw new Error(`#${id} has no workspace to review`);
			const d = await diffOf(w.path, w.baseRef);
			if (!d) throw new Error(`#${id}: git could not diff ${w.branch} against ${w.baseRef}`);
			diff = d;
			fi = Math.min(fi, Math.max(0, d.files.length - 1));
		};
		try {
			await load();
		} catch (err) {
			this.say((err as Error).message, "error");
			return onClose?.();
		}
		const comments = () => task?.workspace?.comments ?? [];
		// the files, and one more holding the comments on files no longer in the diff
		const filesOf = (): DiffFile[] => {
			const fs = diff?.files ?? [];
			const there = new Set(fs.map((f) => f.path));
			return comments().some((c) => !there.has(c.file)) ? [...fs, { path: "", status: "M", binary: false, hunks: [] }] : fs;
		};
		type Row = { kind: "hunk"; text: string; h: number } | { kind: "line"; line: DiffLine; h: number } | { kind: "note"; text: string } | { kind: "stale"; c: ReviewComment };
		const rowsOf = (f: DiffFile | undefined): Row[] => {
			if (!f) return [];
			// comments not under a line of it now (outdated), first; d deletes them there
			if (!f.path) {
				const there = new Set((diff?.files ?? []).map((x) => x.path));
				return comments().filter((c) => !there.has(c.file)).map((c) => ({ kind: "stale", c }));
			}
			const out: Row[] = outdatedIn(f, comments()).map((c) => ({ kind: "stale", c }));
			if (f.summary) return [...out, { kind: "note", text: f.summary }];
			if (f.binary) return [...out, { kind: "note", text: "binary file" }];
			if (f.hunks.length === 0) return [...out, { kind: "note", text: f.status === "R" ? "renamed, its text unchanged" : f.status === "A" ? "an empty file" : f.status === "D" ? "an empty file, deleted" : "its text unchanged (its mode changed)" }];
			f.hunks.forEach((hk, h) => {
				out.push({ kind: "hunk", text: hk.header, h });
				for (const line of hk.lines) out.push({ kind: "line", line, h });
			});
			return out;
		};
		const anchor = commentAnchor;
		// a comment sits under its line while that line is where it was; otherwise it is outdated (kept)
		const placed = (f: DiffFile, rows: Row[]) => {
			const at = new Map<number, ReviewComment[]>();
			for (const c of comments()) {
				if (c.file !== f.path) continue;
				const r = rows.findIndex((x) => x.kind === "line" && commentOn(c, f.path, x.line));
				if (r >= 0) at.set(r, [...(at.get(r) ?? []), c]);
			}
			return { at };
		};
		const clean = (s: string) => s.replace(/\t/g, "    ").replace(CONTROL, " ").replace(/[\x80-\x9f]/g, " ");
		// merge and back close the review when they did it (the task merged, at work again); else it stays
		const act = (verb: string, extra = "") => {
			if (busy) return view.say("busy: try again in a moment", "muted");
			busy = true;
			void view
				.tasksCommand(`${verb} ${id}${extra ? ` ${extra}` : ""}`)
				.then(() => reload())
				.finally(() => {
					busy = false;
					const stage = task?.workspace?.stage;
					if ((verb === "merge" && stage === "merged") || (verb === "back" && stage === "working")) close();
				});
		};
		const reload = async () => {
			try {
				await load();
			} catch (err) {
				// a merged task's worktree is gone: nothing to diff any more
				if (task?.workspace?.stage !== "merged") view.say((err as Error).message, "error");
			}
			if (!closed) view.o.tui.requestRender();
		};
		const close = () => {
			if (closed || view.overlay !== self) return;
			view.closeOverlay();
			onClose?.();
		};
		const moveLine = (rows: Row[], to: number) => {
			ri = Math.max(0, Math.min(rows.length - 1, to));
		};
		this.overlay = self = {
			render(width: number) {
				const room = Math.max(4, (view.o.tui.terminal.rows || 30) - 9);
				const files = filesOf();
				fi = Math.min(fi, Math.max(0, files.length - 1));
				const f = files[fi];
				const rows = rowsOf(f);
				if (ri < 0) ri = Math.max(0, rows.findIndex((r) => r.kind === "line"));
				moveLine(rows, ri);
				const { at } = f ? placed(f, rows) : { at: new Map<number, ReviewComment[]>() };
				const hunks = f?.hunks.length ?? 0;
				const cur = rows[ri];
				const h = cur && (cur.kind === "line" || cur.kind === "hunk") ? cur.h + 1 : 0;
				const name = !f ? "no changes" : !f.path ? "comments on files not in the diff now" : clean(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);
				const head = `#${id} ${oneLine(task?.title ?? "")} · ${f?.path ? `${f.status} ` : ""}${name}`;
				const facts = [files.length > 1 ? `file ${fi + 1}/${files.length}` : "", hunks > 0 ? `hunk ${h || 1}/${hunks}` : "", comments().length > 0 ? `${comments().length} comment${comments().length === 1 ? "" : "s"}` : "", diff?.truncated ? "diff cut short" : ""].filter(Boolean).join(" · ");
				const out = [t.bold(truncateToWidth(oneLine(head), width)), t.fg("dim", truncateToWidth(facts || " ", width)), t.fg("dim", "─".repeat(Math.max(1, Math.min(width, 120))))];
				// the body: the rows with the comments under theirs, the cursor in view
				const body: { text: string; row: number }[] = [];
				rows.forEach((r, i) => {
					const mark = i === ri ? t.fg("accent", "▶") : " ";
					if (r.kind === "note") body.push({ text: `${mark} ${t.fg("dim", r.text)}`, row: i });
					else if (r.kind === "stale") body.push({ text: `${mark} ${t.fg("warning", truncateToWidth(clean(`✎ ${f?.path ? "outdated" : r.c.file} (line ${r.c.line}): ${oneLine(r.c.text)}`), Math.max(1, width - 2)))}`, row: i });
					else if (r.kind === "hunk") body.push({ text: `${mark} ${t.fg("dim", truncateToWidth(clean(r.text), Math.max(1, width - 2)))}`, row: i });
					else {
						const l = r.line;
						const no = String(l.newNo ?? l.oldNo ?? "").padStart(5);
						const text = truncateToWidth(clean(`${l.kind} ${l.text}`), Math.max(1, width - 8), "…");
						body.push({ text: `${mark}${t.fg("dim", no)} ${l.kind === "+" ? t.fg("success", text) : l.kind === "-" ? t.fg("error", text) : text}`, row: i });
					}
					for (const c of at.get(i) ?? []) for (const w of wrap(clean(`└ ✎ ${oneLine(c.text)}`), Math.max(1, width - 8))) body.push({ text: `       ${t.fg("warning", w)}`, row: i });
				});
				const first = body.findIndex((b) => b.row === ri);
				let last = first;
				while (last + 1 < body.length && body[last + 1]!.row === ri) last++;
				if (first < top) top = first;
				if (last >= top + room) top = last - room + 1;
				top = Math.max(0, Math.min(top, Math.max(0, body.length - room)));
				out.push(...body.slice(top, top + room).map((b) => b.text));
				if (files.length === 0) out.push(t.fg("dim", "  nothing changed against base"));
				out.push("");
				if (input) out.push(...input.box.render(width));
				const n = view.notice;
				if (n && n.until > Date.now()) out.push(t.fg(n.tone, truncateToWidth(oneLine(n.text), width)));
				const keys = input
					? `Enter ${input.kind === "comment" ? "keep the comment" : "send back with the comments"} · Esc cancel`
					: "j/k line · n/p hunk · ]/[ file · c comment · d delete comment · b send back · m merge · r reload · Esc back";
				out.push(t.fg("dim", truncateToWidth(keys, width)));
				return out.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
			},
			handleInput(data: string) {
				const key = parseKey(data);
				const files = filesOf();
				const f = files[fi];
				const rows = rowsOf(f);
				if (input) {
					if (key === "escape" || key === "ctrl+c") input = undefined;
					else if (key === "enter") {
						// busy: the text stays in the box for another Enter
						if (busy) return view.say("busy: Enter again in a moment", "muted");
						const text = oneLine(input.box.getValue()).trim();
						const kind = input.kind;
						input = undefined;
						if (kind === "back") return act("back", text);
						const r = rows[ri];
						if (!text || !f?.path || r?.kind !== "line") return;
						busy = true;
						void port.tasks
							.comment(id, { file: f.path, ...anchor(r.line), text, tip: diff?.tip })
							.then((res) => {
								if (task?.workspace && res.task?.workspace) task.workspace.comments = res.task.workspace.comments;
							})
							.catch((err: unknown) => view.say((err as Error).message, "error"))
							.finally(() => {
								busy = false;
								view.o.tui.requestRender();
							});
					} else input.box.handleInput(data);
					return;
				}
				if (key === "escape" || data === "q" || key === "ctrl+c") return close();
				if (data === "j" || key === "down") return moveLine(rows, ri + 1);
				if (data === "k" || key === "up") return moveLine(rows, ri - 1);
				if (key === "pageDown") return moveLine(rows, ri + 10);
				if (key === "pageUp") return moveLine(rows, ri - 10);
				if (data === "n" || data === "p") {
					// to the first line of the next (previous) hunk; p from a hunk's start goes to the one before
					const cur = rows[ri];
					const h = cur && (cur.kind === "line" || cur.kind === "hunk") ? cur.h : data === "n" ? -1 : Number.MAX_SAFE_INTEGER;
					const want = data === "n" ? h + 1 : h - 1;
					const at = rows.findIndex((r) => r.kind === "hunk" && r.h === want);
					if (at >= 0) moveLine(rows, at + 1 < rows.length ? at + 1 : at);
					return;
				}
				if (data === "]" || data === "[") {
					const to = fi + (data === "]" ? 1 : -1);
					if (to >= 0 && to < files.length) {
						fi = to;
						// the first line of its diff (past its outdated comments and its first hunk's header)
						const next = rowsOf(files[to]);
						const first = next.findIndex((r) => r.kind === "line");
						ri = first >= 0 ? first : 0;
						top = 0;
					}
					return;
				}
				if (data === "r") return void reload();
				if (data === "c") {
					if (rows[ri]?.kind !== "line") return view.say("c comments on a line of the diff", "muted");
					input = { kind: "comment", box: new Input({ prompt: "comment › " }) };
					input.box.focused = true;
					return;
				}
				if (data === "d") {
					if (!f || busy) return;
					const r = rows[ri];
					const mine = r?.kind === "stale" ? [r.c] : r?.kind === "line" ? placed(f, rows).at.get(ri) : undefined;
					if (!mine || mine.length === 0) return view.say("no comment here", "muted");
					const c = mine[mine.length - 1]!;
					busy = true;
					void port.tasks
						.uncomment(id, { file: c.file, line: c.line, at: c.at })
						.then((res) => {
							if (task?.workspace) task.workspace.comments = res.task?.workspace?.comments;
						})
						.catch((err: unknown) => view.say((err as Error).message, "error"))
						.finally(() => {
							busy = false;
							view.o.tui.requestRender();
						});
					return;
				}
				if (data === "b") {
					input = { kind: "back", box: new Input({ prompt: `#${id} back › ` }) };
					input.box.focused = true;
					return;
				}
				if (data === "m") return act("merge");
			},
			dispose() {
				closed = true;
			},
		};
		this.o.tui.requestRender();
	}

	/** M48: a `/command` typed in a peek acts on that session (the keys' code, by name). */
	private async peekCommand(row: JobRow, name: string, arg: string): Promise<void> {
		const port = this.port;
		if (!port) return this.say("background service unavailable", "error");
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
				await port.jobs.stop(row.id);
				return this.say(`stopping · ${row.name}`, "warning");
			case "respawn": {
				done();
				const r = await port.jobs.respawn(row.id);
				const first = r.results[0];
				return first?.started ? this.say(`starting ${row.name} again`, "success") : this.say(first?.error ?? `${row.name} was not started`, "warning");
			}
			case "rm": {
				// twice within 2 s, as Ctrl+X Ctrl+X
				done();
				const now = Date.now();
				if (this.armedStop?.id === row.id && now - this.armedStop.at < DOUBLE_PRESS_MS) {
					this.armedStop = undefined;
					const res = await port.jobs.rm(row.id);
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
				await port.jobs.rename(row.id, arg);
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
				// pi's own, run in the session by the worker (a session that ended is not started again for it)
				if (name === "name" && !arg) return this.say("/name <the session's own name>", "warning");
				if (row.kind === "shell") return this.say(`/${name} is for a pi session`, "warning");
				if (row.pid === null) return this.say(`${row.name} is not running: /${name} works in a running session`, "warning");
				const r = await this.port.jobs.reply({ id: row.id, text: `/${name}${arg ? ` ${arg}` : ""}` }, { tag: "hub" });
				done();
				if (r.delivered) return this.say(`/${name} · ${row.name}`, "success");
				return this.say(r.respawned ? `starting ${row.name} again; /${name} runs then` : r.saved ? `saved; it runs when ${row.name} starts again` : `not delivered: ${row.name} is not running`, "warning");
			}
			default:
			// not the peek's: sendReply sends it to the session
		}
	}

	/** M48 /transcript in a peek: its transcript (a terminal agent: its screen), the end first in view; r reloads. */
	private showTranscript(row: JobRow): void {
		const view = this;
		const t = this.o.theme;
		let body: string[] = [];
		let bodyWidth = 0; // the width body was laid out for: a narrower terminal lays it out again
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
				if (body.length === 0 || bodyWidth !== width) {
					body = load(width);
					bodyWidth = width;
				}
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
		const fresh = () => new CombinedAutocompleteProvider(commands(), base(), fdOnPath());
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
			{ name: "tasks", description: "the shared task board (this project's; all: every project's)", argumentHint: "all | add <title> [after #n] [-- detail] | assign <id> <session> | done <id> [result] | rm <id> | release <id>", getArgumentCompletions: (p) => starts(names(["all", "add", "start", "review", "merge", "pr", "shelve", "cleanup", "back", "approve", "verify", "pass", "abort", "commit", "assign", "done", "rm", "release"]), p) },
			{ name: "concierge", description: "the hub's own agent", argumentHint: "on | off | status | log | attach | ask | answer | act | undo | orders", getArgumentCompletions: (p) => starts(names(["on", "off", "status", "log", "attach", "ask", "answer", "act", "undo", "orders"]), p) },
			{ name: "workspaces", description: "the tasks in their worktrees: review, merge, send back (Ctrl+N: the next that needs you)" },
			{ name: "ask", description: "ask the concierge", argumentHint: "question" },
			{ name: "schedule", description: "a task on a schedule", argumentHint: "<name> <when> <task> | run | pause | resume | rm" },
			{ name: "fanout", description: "the next task once per model", argumentHint: "model model … | off" },
			{ name: "compare", description: "the fan-out side by side" },
			{ name: "preset", description: "launch presets", argumentHint: "name | save name | rm name | off", getArgumentCompletions: (p) => starts(names([...Object.keys(this.o.presets?.() ?? {}), "save", "rm", "off"]), p) },
			{ name: "profile", description: "new sessions run another agent", argumentHint: "name | pi", getArgumentCompletions: (p) => starts(names(["pi", ...(this.o.profiles?.() ?? [])]), p) },
			{ name: "exit", description: "leave the view" },
		];
		const pi = (this.o.commands?.() ?? []).filter((c) => c.source === "prompt" || c.source === "skill").map((c) => ({ name: c.name, description: `pi: ${c.source}` }));
		return [...own, ...pi];
	}

	/** M61: the session's own commands, from the worker's commands.json (cached by its mtime). */
	private sessionCommandList(row: JobRow): { name: string; description?: string; source: string }[] {
		if (isProfileRow(row)) return (this.o.profileCommands?.(row.profile!) ?? []).map((c) => ({ ...c, source: row.profile! }));
		if (row.kind !== "pi") return [];
		if (this.o.sessionCommands) return this.o.sessionCommands(row.id);
		try {
			const mtime = statSync(commandsPath(row.id)).mtimeMs;
			const hit = this.commandsCache.get(row.id);
			if (hit?.mtime === mtime) return hit.list;
			const list = readCommands(row.id);
			this.commandsCache.set(row.id, { mtime, list });
			return list;
		} catch {
			return [];
		}
	}

	/**
	 * A peek's commands: for that session, in groups tagged at the start of the description:
	 * the hub's, pi's built-ins (not those the hub has), then the session's own (M61).
	 */
	private peekCommands(): SlashCommand[] {
		const starts = (items: { value: string; label: string }[], prefix: string) => items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
		const row = this.peekId ? this.rows.get(this.peekId) : undefined;
		const gone = row !== undefined && row.pid === null;
		const busy = row?.state === "working" || row?.waitingFor === "dialog";
		const out: SlashCommand[] = PEEK_COMMANDS.map((c) => {
			// M61: what needs a running pi session says so
			const mark = row && gone && row.kind === "pi" && ["stop", "name", "compact"].includes(c.name) ? " (not running)" : "";
			const base = { ...c, description: `hub · ${c.description}${mark}` };
			return c.name === "model"
				? { ...base, getArgumentCompletions: (p: string) => starts((this.o.models?.() ?? []).map((m) => ({ value: m, label: m })), p) }
				: c.name === "thinking"
					? { ...base, getArgumentCompletions: (p: string) => starts([...THINKING_LEVELS].map((v) => ({ value: v, label: v })), p) }
					: base;
		});
		const seen = new Set(out.map((c) => c.name));
		const add = (c: SlashCommand) => {
			if (seen.has(c.name)) return;
			seen.add(c.name);
			out.push(c);
		};
		if (!row || row.kind === "pi") {
			for (const c of PI_COMMANDS) {
				if (c.how === "hub") continue;
				const mark = gone ? " (not running)" : busy ? " (when idle)" : "";
				add({ name: c.name, description: `pi · ${c.description}${mark}`, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) });
			}
		}
		if (row) for (const c of this.sessionCommandList(row)) add({ name: c.name, description: `${c.source} · ${c.description ?? ""}`.replace(/ · $/, "") });
		return out;
	}

	/**
	 * M61: one of pi's built-in commands, typed into the session's pi (the worker never sees
	 * these): `screen` ones show the session's screen once it settles, `picker` ones attach so
	 * the picker is in front of the user, `quit` asks twice.
	 */
	private async piBuiltin(row: JobRow, name: string, how: "screen" | "picker" | "confirm", text: string): Promise<void> {
		const host = this.o.hostControl ?? hostControl;
		// pi matches a command without arguments exactly: words after it would go to the model as a prompt
		const spec = piCommand(name);
		const hasArgs = /\s/.test(text.trim());
		if (hasArgs && !spec?.args) return this.say(`/${name} takes no arguments`, "warning");
		if (!hasArgs && spec?.args === "required") return this.say(`/${name} needs ${spec.argumentHint ?? "an argument"}`, "warning");
		if (this.commandBusy) return;
		if (row.pid === null) return this.say(`${row.name} is not running: /${name} works in a running session`, "warning");
		if (row.state === "working" || row.waitingFor === "dialog") return this.say(`${row.name} is ${row.state === "working" ? "working" : "in a dialog"}: /${name} works when it is idle`, "warning");
		this.commandBusy = true;
		try {
			return await this.piBuiltinRun(row, name, how, text, host);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			return this.say(code === "ENOENT" || code === "ECONNREFUSED" ? `${row.name} has no terminal pi-roost hosts (a foreground pi?): run /${name} there` : (err as Error).message, "error");
		} finally {
			this.commandBusy = false;
		}
	}

	private async piBuiltinRun(row: JobRow, name: string, how: "screen" | "picker" | "confirm", text: string, host: typeof hostControl): Promise<void> {
		const st = (await host(row.id, "status")) as { attached?: boolean };
		if (st.attached) return this.say(`${row.name} is attached elsewhere: its editor is theirs; detach it first`, "warning");
		if (how === "confirm") {
			const now = Date.now();
			const key = `quit:${row.id}`;
			if (this.armedStop?.id !== key || now - this.armedStop.at >= DOUBLE_PRESS_MS) {
				this.armedStop = { id: key, at: now };
				return this.say(`/${name} again within 2 s to end ${row.name}`, "warning");
			}
			this.armedStop = undefined;
		}
		const r = (await host(row.id, "command", 3000, { text })) as { ok?: boolean; error?: string };
		if (!r.ok) return this.say(r.error ?? `/${name} was not delivered: ${row.name} is not running`, "error");
		this.reply.setValue("");
		this.o.tui.requestRender();
		if (how === "picker") return this.attachTo(row.id);
		if (how === "confirm") return this.say(`/${name} · ${row.name}`, "warning");
		await sleep(800);
		const shot = async () => ((await host(row.id, "snapshot")) as { text?: string }).text ?? "";
		this.showScreen(row, text.split(/\s/)[0]!, await shot(), shot);
	}

	/** M61: a session's screen as an overlay (what a built-in command printed); r reloads, Esc closes. */
	private showScreen(row: JobRow, title: string, first: string, reload: () => Promise<string>): void {
		const view = this;
		const t = this.o.theme;
		let screen = first;
		this.overlay = {
			render(width: number) {
				const room = Math.max(3, (view.o.tui.terminal.rows || 30) - 6);
				const lines = screen.trimEnd().split("\n").map((l) => truncateToWidth(l.replace(CONTROL, " "), Math.max(1, width - 2)));
				return [t.bold(truncateToWidth(`${title} · ${oneLine(row.name)}`, width)), "", ...lines.slice(-room), "", t.fg("dim", truncateToWidth("r reload · Esc close", width))];
			},
			handleInput(data: string) {
				const key = parseKey(data);
				if (key === "escape" || key === "ctrl+c" || data === "q") view.closeOverlay();
				else if (data === "r")
					void reload().then(
						(text) => {
							screen = text;
							view.o.tui.requestRender();
						},
						(err: unknown) => view.say(String((err as Error).message ?? err), "error"),
					);
			},
		};
		this.o.tui.requestRender();
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
		if (!this.port) {
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
			const r = await this.port.jobs.reply({ id: row.id, text: `/${which} ${value}` }, { tag: "hub" });
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
		if (!this.port) return this.say("background service unavailable", "error");
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
					const { id } = await this.port.jobs.dispatch({ ...request, fanout }, { tag: "hub" });
					started.push(id);
					if (note) notes.add(note);
				} catch (err) {
					const refused = refusedByDaemon(err);
					if (refused) discard?.();
					// an unanswered dispatch may still run: its worktree stays (as for one task)
					failed.push(`${shortModel(model)}: ${oneLine((err as Error).message)}${!refused && request.worktree ? ` (worktree ${request.worktree.branch} kept)` : ""}`);
					// M51: the service did not come back: the other models are not tried one by one
					if (!refused) break;
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
		if (!this.port) return this.say("background service unavailable", "error");
		const kept: string[] = [];
		let deleted = 0;
		const failed: string[] = [];
		const pinned = others.filter((r) => r.pinned);
		for (const r of others) {
			if (r.pinned) continue; // pinned on purpose: never deleted by a batch
			try {
				if (r.pid !== null) await this.port.jobs.stop(r.id);
				const res = await this.port.jobs.rm(r.id);
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
		if (!this.port) return this.say("background service unavailable", "error");
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
					const res = await this.port.jobs.reply({ id: r.id, text, mode }, { tag: "hub" });
					if (res.delivered || res.respawned || res.duplicate) sent++;
					else if (res.saved) later++;
					else failed.push(r.name);
				} catch (err) {
					failed.push(r.name);
					// M51: the service did not come back: the rest are not tried one by one
					if (!refusedByDaemon(err)) {
						failed.push(...pi.slice(pi.indexOf(r) + 1).map((x) => x.name));
						break;
					}
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
		if (!this.port) return;
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
					const res = await this.port.jobs.rm(r.id);
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
				for (const r of targets) if (r.pid !== null) await this.port.jobs.stop(r.id);
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
			if (!this.port) return this.say("background service unavailable", "error");
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
		// M47: the board's line, while something is on it
		const b = this.board;
		if (b && (b.open > 0 || b.claimed > 0 || b.blocked > 0 || (b.workspaces ?? 0) > 0)) out.push(t.fg(b.needsYou ? "warning" : "dim", truncateToWidth(`tasks ${summaryLine(b)} · /tasks${(b.workspaces ?? 0) > 0 ? " · Ctrl+N workspaces" : ""}`, w)));
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

	/**
	 * M48: the tail of its transcript (or its screen): raw lines cached per row, the file looked at
	 * (its size and mtime) every 2 s at most and read only when it changed; cut to the width at render.
	 */
	private tails = new Map<string, { at: number; key: string; items: TailItem[] }>();
	private tailLines(row: JobRow, inner: number, now: number): string[] {
		const t = this.o.theme;
		const max = Math.max(3, Math.min(12, Math.floor((this.o.tui.terminal.rows || 30) / 4)));
		let cached = this.tails.get(row.id);
		if (!cached || now - cached.at >= 2000) {
			const screen = row.kind === "shell" || !row.sessionFile;
			const file = screen ? screenPath(row.id) : row.sessionFile;
			let key = "";
			try {
				const st = statSync(file);
				key = `${file}:${st.size}:${st.mtimeMs}`;
				if (cached && cached.key === key) cached.at = now;
				else {
					const items: TailItem[] = [];
					if (screen) {
						for (const l of readFileSync(file, "utf8").trimEnd().split("\n")) if (l.trim()) items.push({ kind: "screen", text: oneLine(l) });
					} else {
						// the last part is enough for a few lines (the overlay reads more)
						const tail = readTail(file, TAIL_READ_MAX);
						for (const it of transcriptItems(tail.text, tail.truncated)) {
							if (it.kind === "user") items.push({ kind: "you", text: oneLine(it.text) });
							else if (it.kind === "assistant") items.push({ kind: "said", text: oneLine(it.text) });
							else if (it.kind === "tool") items.push({ kind: "tool", text: oneLine(`${it.name}${it.args ? ` ${it.args}` : ""}`), error: it.error === true });
							else items.push({ kind: "note", text: oneLine(it.text) });
						}
					}
					cached = { at: now, key, items: items.slice(-40) };
					this.tails.set(row.id, cached);
				}
			} catch {
				// nothing written yet (a session file pi has not created, no screen kept)
				cached = { at: now, key, items: [] };
				this.tails.set(row.id, cached);
			}
		}
		return cached.items.slice(-max).map((it) => {
			const line = truncateToWidth(it.kind === "you" ? `you: ${it.text}` : it.kind === "said" ? `› ${it.text}` : it.kind === "tool" ? `⚙ ${it.text}` : it.kind === "note" ? `· ${it.text}` : it.text, inner);
			if (it.kind === "said") return line;
			return t.fg(it.kind === "you" ? "accent" : it.kind === "tool" && it.error ? "error" : it.kind === "note" ? "dim" : "muted", line);
		});
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
			["/tasks [add|assign|done|rm|release]", "the shared task board: sessions claim tasks (roost_task_*), the concierge hands them out; add <title> [after #n] [-- detail], assign <id> <session>, done <id> [result], rm <id>, release <id>"],
			["/workspaces · Ctrl+N", "the tasks in their own worktrees, as a pipeline: Enter review · s start · m merge · b back · v verify · a approve · t attach · n the next that needs you"],
			["/tasks pr <id>", "the optional exit: push the task's branch and open a pull request into its base (shown first; again within 30 s does it)"],
			["/tasks shelve <id> · cleanup", "put a task away (its worktree removed, its branch kept; start brings it back) · remove worktrees and logs left behind (yes: do it)"],
			["/tasks review <id>", "a task's diff against base: j/k line · n/p hunk · ]/[ file · c comment · d delete it · b send back with the comments · m merge"],
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
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

/** M48: a directory with the home as `~` (the peek's "where"). */
function tildeDir(dir: string): string {
	const home = process.env.HOME;
	if (!home) return dir;
	return dir === home ? "~" : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

/** M48: pi's path completion uses fd when it is on the PATH (fuzzy, .gitignore kept); found once. */
let fdPathCache: string | null | undefined;
function fdOnPath(): string | null {
	if (fdPathCache !== undefined) return fdPathCache;
	fdPathCache = null;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		for (const name of ["fd", "fdfind"]) {
			const p = join(dir, name);
			if (existsSync(p)) {
				fdPathCache = p;
				return p;
			}
		}
	}
	return fdPathCache;
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
