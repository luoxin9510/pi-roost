// Agent view layout as data (PRD §6.1): groups, row icons, ages, counts.
// Rendering lives in adapters/pi/agent-view.ts; this module is pure.
import { homedir } from "node:os";
import { type Filter, matches } from "./filter.ts";
import { readyForReview } from "./pr.ts";
import type { JobRow } from "./protocol.ts";

export type GroupKey = "pinned" | "ready" | "needs-input" | "working" | "completed";

export const GROUPS: { key: GroupKey; title: string; hint: string }[] = [
	{ key: "pinned", title: "Pinned", hint: "kept running and listed first (Ctrl+T)" },
	{ key: "ready", title: "Ready for review", hint: "an open pull request needs review or has failing checks" },
	{ key: "needs-input", title: "Needs input", hint: "waiting for an answer, a dialog or a first prompt" },
	{ key: "working", title: "Working", hint: "running a turn right now" },
	{ key: "completed", title: "Completed", hint: "finished, failed or stopped; attach or reply to continue" },
];

/** Semantic colour names, mapped to theme tokens by the renderer. */
export type Tone = "accent" | "warning" | "dim" | "success" | "error" | "muted";

export interface Section {
	/** A state group, or `dir:<cwd>` when grouping by directory (AV-K6). */
	key: string;
	/** The directory of a directory section. */
	dir?: string;
	title: string;
	hint: string;
	rows: JobRow[];
	/** Rows folded into "… N more" (completed only). */
	hidden: number;
	collapsed: boolean;
}

export type Item = { kind: "header"; section: Section } | { kind: "row"; row: JobRow; section: Section };

/**
 * M13: whether the agent view lists a row. As in Claude Code, subagents a session spawns
 * are not rows of their own: its subagent panel shows them. A child whose parent nobody
 * holds any more and that still works or waits is listed, so live work never goes unseen.
 */
export function listed(row: JobRow, subagents: "hide" | "inline" = "hide"): boolean {
	if (subagents === "inline" || !row.parentSession) return true;
	return row.parentOpen !== true && (row.state === "working" || row.state === "blocked");
}

export function groupOf(row: JobRow, pinned: ReadonlySet<string> = new Set()): GroupKey {
	if (row.pinned || pinned.has(row.id)) return "pinned";
	if (row.state === "blocked") return "needs-input";
	if (row.state === "working") return "working";
	// M16 (Claude Code): an open pull request that needs review or has failing checks
	if (readyForReview(row.prs)) return "ready";
	return "completed";
}

export interface LayoutOptions {
	pinned?: ReadonlySet<string>;
	collapsed?: ReadonlySet<string>;
	groupBy?: "state" | "directory";
	/** DI-7: only matching rows; groups open and nothing folds while it applies. */
	filter?: Filter;
	/** Completed rows shown before folding the rest (AV-5). */
	maxCompleted?: number;
}

const byNewest = (a: JobRow, b: JobRow) => b.startedAt - a.startedAt;
const byEnded = (a: JobRow, b: JobRow) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

/**
 * AV-K13: rows the user reordered in this section keep that order, below the ones
 * never moved here (an order made in another group or grouping does not apply).
 */
export function ordered(list: JobRow[], cmp: (a: JobRow, b: JobRow) => number, key?: string): JobRow[] {
	const isPlaced = (r: JobRow) => r.order !== null && (key === undefined || r.orderKey === key);
	const loose = list.filter((r) => !isPlaced(r)).sort(cmp);
	const placed = list.filter(isPlaced).sort((a, b) => a.order! - b.order! || cmp(a, b));
	return [...loose, ...placed];
}

/** `~/…` for paths under the home directory. */
export function shortPath(dir: string, home = homedir()): string {
	return home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
}

const activity = (r: JobRow) => Math.max(r.startedAt, r.stateSince, r.endedAt ?? 0);

/** Sections in display order; empty ones are dropped unless nothing exists at all (AV-2). */
export function layout(all: JobRow[], opts: LayoutOptions = {}): Section[] {
	const pinned = opts.pinned ?? new Set<string>();
	const collapsed = opts.collapsed ?? new Set<string>();
	const filter = opts.filter;
	const rows = filter ? all.filter((r) => matches(r, filter)) : all;
	const keepEmpty = !filter && all.length === 0;
	const fold = (list: JobRow[]) =>
		!filter && opts.maxCompleted !== undefined && list.length > opts.maxCompleted
			? { rows: list.slice(0, opts.maxCompleted), hidden: list.length - opts.maxCompleted }
			: { rows: list, hidden: 0 };
	const sections: Section[] = [];
	if (opts.groupBy === "directory") {
		const pin = GROUPS[0]!;
		const pins = ordered(rows.filter((r) => groupOf(r, pinned) === "pinned"), byNewest, "pinned");
		if (pins.length > 0 || keepEmpty) sections.push({ ...pin, rows: pins, hidden: 0, collapsed: !filter && collapsed.has(pin.key) });
		const byDir = new Map<string, JobRow[]>();
		for (const r of rows) if (groupOf(r, pinned) !== "pinned") byDir.set(r.cwd, [...(byDir.get(r.cwd) ?? []), r]);
		const dirs = [...byDir.entries()].sort((a, b) => Math.max(...b[1].map(activity)) - Math.max(...a[1].map(activity)));
		for (const [dir, list] of dirs) {
			const key = `dir:${dir}`;
			sections.push({
				key,
				dir,
				title: shortPath(dir),
				hint: "",
				// no folding here: a directory's live rows must stay visible
				rows: ordered(list, byNewest, key),
				hidden: 0,
				collapsed: !filter && collapsed.has(key),
			});
		}
		return sections;
	}
	const buckets = new Map<GroupKey, JobRow[]>(GROUPS.map((g) => [g.key, []]));
	for (const row of rows) buckets.get(groupOf(row, pinned))!.push(row);
	for (const g of GROUPS) {
		const list = ordered(buckets.get(g.key)!, g.key === "completed" ? byEnded : byNewest, g.key);
		// M16: Ready for review shows only with a pull request in it
		if (list.length === 0 && (!keepEmpty || g.key === "ready")) continue;
		const shown = g.key === "completed" ? fold(list) : { rows: list, hidden: 0 };
		sections.push({ ...g, ...shown, collapsed: !filter && collapsed.has(g.key) });
	}
	return sections;
}

/** Selectable lines in order: each header, then its rows unless collapsed. */
export function items(sections: Section[]): Item[] {
	const out: Item[] = [];
	for (const section of sections) {
		out.push({ kind: "header", section });
		if (!section.collapsed) for (const row of section.rows) out.push({ kind: "row", row, section });
	}
	return out;
}

export interface Icon {
	glyph: string;
	tone: Tone;
}

const SPINNER = ["✽", "✻", "✼", "✻"];

/** AV-4: glyph by process state, colour by job state. `frame` animates busy rows. */
export function iconOf(row: JobRow, frame = 0, animate = true): Icon {
	const alive = row.pid !== null;
	const glyph = !alive ? "∙" : row.status === "busy" ? (animate ? SPINNER[frame % SPINNER.length]! : "✽") : "✻";
	return { glyph, tone: toneOf(row) };
}

export function toneOf(row: JobRow): Tone {
	switch (row.state) {
		case "working":
			return row.status === "idle" ? "dim" : "accent";
		case "blocked":
			return "warning";
		case "done":
			return "success";
		case "failed":
			return "error";
		default:
			return "muted";
	}
}

/** Compact age; freezes at the run length once the job's work finished (AV-3). */
export function ageOf(row: JobRow, now: number): string {
	const finished = row.state === "done" || row.state === "failed" || row.state === "stopped";
	const end = row.endedAt ?? (finished ? row.stateSince : now);
	const ms = Math.max(0, end - row.startedAt);
	return formatDuration(ms);
}

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

export interface Counts {
	needsInput: number;
	working: number;
	completed: number;
}

export function counts(rows: JobRow[]): Counts {
	const c: Counts = { needsInput: 0, working: 0, completed: 0 };
	for (const r of rows) {
		if (r.state === "blocked") c.needsInput++;
		else if (r.state === "working") c.working++;
		else c.completed++;
	}
	return c;
}

/** AV-6 header line. */
export function headerText(c: Counts): string {
	return `${c.needsInput} needs input · ${c.working} working · ${c.completed} completed`;
}

// ---- M8: model and context window ---------------------------------------

/** Context use from this share on is shown as a warning, and as an error from the next. */
export const CONTEXT_WARN_PERCENT = 80;
export const CONTEXT_ERROR_PERCENT = 95;

/**
 * "anthropic/claude-haiku-4-5-20251001" → "claude-haiku-4-5": the id, without the provider,
 * a gateway's vendor prefix ("anthropic::", Bedrock's "us.anthropic."), a version or a date
 * suffix, so the part that tells models apart is what the column shows (M22).
 */
export function shortModel(model: string): string {
	const at = model.indexOf("/");
	let id = at > 0 ? model.slice(at + 1) : model;
	const vendor = id.lastIndexOf("::");
	if (vendor >= 0 && vendor + 2 < id.length) id = id.slice(vendor + 2);
	id = id.replace(/^(?:(?:us|eu|apac|global|[a-z]{2})\.)?anthropic\.(?=claude)/, "");
	const short = id.replace(/-v\d+(?::\d+)?$/, "").replace(/[-@](?:20\d{6}|\d{4}-\d{2}-\d{2})$/, "");
	return short || id;
}

/** M22: a name too long for its column keeps its end ("…aude-opus-5-5"): that is what differs. */
export function fitTail(text: string, width: number): string {
	if (width <= 0) return "";
	const chars = [...text];
	if (chars.length <= width) return text;
	return width === 1 ? "…" : `…${chars.slice(chars.length - (width - 1)).join("")}`;
}

/** 950 → "950", 86_400 → "86k", 1_000_000 → "1M", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
	if (Math.round(n) < 1000) return String(Math.round(n));
	// 999_500 rounds to 1000k: that is 1M
	if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`;
	return `${Math.round(n / 100_000) / 10}M`;
}

/** The tone of the share as shown: 79.6 shows as 80% and is a warning. */
export function contextToneOf(percent: number | null): Tone {
	if (percent === null) return "dim";
	percent = Math.round(percent);
	if (percent >= CONTEXT_ERROR_PERCENT) return "error";
	if (percent >= CONTEXT_WARN_PERCENT) return "warning";
	return "dim";
}

export interface RowDetails {
	model: string | null;
	/** "43%", "?%" after a compaction, or null when the window is unknown. */
	context: string | null;
	tone: Tone;
}

/** M30: a level 0 agent run from a profile (a shell-kind job that is an agent). */
export const isProfileRow = (row: Pick<JobRow, "kind" | "profile">): boolean =>
	row.kind === "shell" && typeof row.profile === "string" && row.profile !== "" && row.profile !== "shell";

/** Whether a reply can reach it: pi, or a profile's agent (typed in); not a plain command. */
export const takesReplies = (row: Pick<JobRow, "kind" | "profile">): boolean => row.kind !== "shell" || isProfileRow(row);

/** The short right-hand column of a row; null when there is nothing to show (shell jobs). */
export function rowDetailsOf(row: JobRow): RowDetails | null {
	// M30: a profile's agent shows which agent it is (and its model when chosen); no context
	if (isProfileRow(row)) return { model: row.model ? `${row.profile} ${shortModel(row.model)}` : row.profile!, context: null, tone: contextToneOf(null) };
	if (row.kind === "shell") return null;
	const model = row.model ? shortModel(row.model) : null;
	const c = row.context;
	const context = c ? (c.percent === null ? "?%" : `${Math.round(c.percent)}%`) : null;
	if (!model && !context) return null;
	return { model, context, tone: contextToneOf(c?.percent ?? null) };
}

/** The peek's full line: "anthropic/claude-opus-5-5 · thinking high · ctx 86k / 200k (43%)". */
export function modelFacts(row: JobRow): string[] {
	const out: string[] = [];
	if (isProfileRow(row)) out.push(`agent ${row.profile}`);
	if (row.model) out.push(row.model);
	if (row.thinking) out.push(`thinking ${row.thinking}`);
	const c = row.context;
	if (c) {
		if (c.tokens === null || c.percent === null) out.push(`ctx ? / ${formatTokens(c.window)} (compacted; known after the next reply)`);
		else out.push(`ctx ${formatTokens(c.tokens)} / ${formatTokens(c.window)} (${Math.round(c.percent)}%)`);
	}
	return out;
}

/** AV-6 terminal title. */
export function titleText(c: Counts): string {
	return c.needsInput > 0 ? `${c.needsInput} awaiting input · pi agents` : "pi agents";
}

/** What the peek panel and the row say for a job (PK-1). */
export function sentenceOf(row: JobRow): string {
	if (row.state === "blocked") return row.question ?? row.summary ?? waitingLabel(row);
	if (row.state === "failed") return row.error ?? row.summary ?? "failed";
	if (row.state === "stopped") return row.summary ?? "stopped";
	if (row.summary) return row.summary;
	if (row.state !== "working") return "done";
	// a command that prints nothing has no line to show
	if (row.pid === null) return "starting…";
	return row.kind === "shell" && !isProfileRow(row) ? "running" : "working…";
}

function waitingLabel(row: JobRow): string {
	if (row.waitingFor === "dialog") return "waiting in a dialog";
	if (row.waitingFor === "first-prompt") return "waiting for a first prompt";
	return "waiting for input";
}

const NAME_TONES = ["syntaxKeyword", "syntaxFunction", "syntaxString", "syntaxType", "syntaxNumber", "mdLink"] as const;
export type NameTone = (typeof NAME_TONES)[number];

/** A stable per-session colour for its name (AV-3). */
export function nameToneOf(id: string): NameTone {
	let h = 0;
	for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return NAME_TONES[h % NAME_TONES.length]!;
}
