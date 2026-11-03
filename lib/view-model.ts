// Agent view layout as data (PRD §6.1): groups, row icons, ages, counts.
// Rendering lives in extensions/agent-view.ts; this module is pure.
import type { JobRow } from "./protocol.ts";

export type GroupKey = "pinned" | "needs-input" | "working" | "completed";

export const GROUPS: { key: GroupKey; title: string; hint: string }[] = [
	{ key: "pinned", title: "Pinned", hint: "kept running and listed first (Ctrl+T)" },
	{ key: "needs-input", title: "Needs input", hint: "waiting for an answer, a dialog or a first prompt" },
	{ key: "working", title: "Working", hint: "running a turn right now" },
	{ key: "completed", title: "Completed", hint: "finished, failed or stopped; attach or reply to continue" },
];

/** Semantic colour names, mapped to theme tokens by the renderer. */
export type Tone = "accent" | "warning" | "dim" | "success" | "error" | "muted";

export interface Section {
	key: GroupKey;
	title: string;
	hint: string;
	rows: JobRow[];
	/** Rows folded into "… N more" (completed only). */
	hidden: number;
	collapsed: boolean;
}

export type Item = { kind: "header"; section: Section } | { kind: "row"; row: JobRow; section: Section };

export function groupOf(row: JobRow, pinned: ReadonlySet<string>): GroupKey {
	if (pinned.has(row.id)) return "pinned";
	if (row.state === "blocked") return "needs-input";
	if (row.state === "working") return "working";
	return "completed";
}

export interface LayoutOptions {
	pinned?: ReadonlySet<string>;
	collapsed?: ReadonlySet<GroupKey>;
	/** Completed rows shown before folding the rest (AV-5). */
	maxCompleted?: number;
}

const byNewest = (a: JobRow, b: JobRow) => b.startedAt - a.startedAt;
const byEnded = (a: JobRow, b: JobRow) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

/** Sections in display order; empty ones are dropped unless nothing exists at all (AV-2). */
export function layout(rows: JobRow[], opts: LayoutOptions = {}): Section[] {
	const pinned = opts.pinned ?? new Set<string>();
	const collapsed = opts.collapsed ?? new Set<GroupKey>();
	const buckets = new Map<GroupKey, JobRow[]>(GROUPS.map((g) => [g.key, []]));
	for (const row of rows) buckets.get(groupOf(row, pinned))!.push(row);
	const sections: Section[] = [];
	for (const g of GROUPS) {
		const list = buckets.get(g.key)!.sort(g.key === "completed" ? byEnded : byNewest);
		if (list.length === 0 && rows.length > 0) continue;
		let shown = list;
		let hidden = 0;
		if (g.key === "completed" && opts.maxCompleted !== undefined && list.length > opts.maxCompleted) {
			shown = list.slice(0, opts.maxCompleted);
			hidden = list.length - shown.length;
		}
		sections.push({ ...g, rows: shown, hidden, collapsed: collapsed.has(g.key) });
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

/** AV-6 terminal title. */
export function titleText(c: Counts): string {
	return c.needsInput > 0 ? `${c.needsInput} awaiting input · pi agents` : "pi agents";
}

/** What the peek panel and the row say for a job (PK-1). */
export function sentenceOf(row: JobRow): string {
	if (row.state === "blocked") return row.question ?? row.summary ?? waitingLabel(row);
	if (row.state === "failed") return row.error ?? row.summary ?? "failed";
	if (row.state === "stopped") return row.summary ?? "stopped";
	return row.summary ?? (row.state === "working" ? "starting…" : "done");
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
