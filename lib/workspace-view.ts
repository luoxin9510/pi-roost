// M57 (docs/plans/m57-workspace-overlay.md): the tasks of a repository as a pipeline, for
// the hub's workspace overlay: what needs a person first, then what runs, then what waits,
// then what was merged lately. Pure: the hub draws it, the tests read it.
import { type BoardTask, blockedOn, needsYou, stageLabel } from "./board.ts";

export type WsGroup = "review" | "fix" | "verifying" | "working" | "open" | "shelved" | "merged";
export const WS_GROUPS: readonly WsGroup[] = ["review", "fix", "verifying", "working", "open", "shelved", "merged"];
export const WS_GROUP_TITLES: Record<WsGroup, string> = {
	review: "REVIEW",
	fix: "CONFLICT · FAILED",
	verifying: "VERIFYING",
	working: "WORKING",
	open: "OPEN",
	shelved: "SHELVED",
	merged: "MERGED",
};

/** Merged tasks shown: those of the last day, at most this many. */
export const WS_MERGED_MAX = 10;
export const WS_MERGED_MS = 24 * 3_600_000;

export interface WsEntry {
	task: BoardTask;
	group: WsGroup;
}

/** The group a task is shown in, or undefined when it is not (dropped, done without a workspace, merged long ago). */
export function wsGroup(t: BoardTask, now = Date.now()): WsGroup | undefined {
	if (t.state === "dropped") return undefined;
	const w = t.workspace;
	// an open task of a repository can be started; one for any session cannot (no repository)
	if (!w) return t.state === "open" && t.project ? "open" : undefined;
	switch (w.stage) {
		case "review":
			return "review";
		case "conflict":
		case "failed":
			return "fix";
		case "verifying":
			return "verifying";
		case "working":
		case "merging":
			return "working";
		case "shelved":
			return "shelved";
		case "merged": {
			const at = w.merge?.at || t.doneAt || t.at;
			return now - at <= WS_MERGED_MS ? "merged" : undefined;
		}
	}
}

/** The tasks in their groups' order; within a group by id, merged newest first (at most WS_MERGED_MAX). */
export function workspaceEntries(tasks: BoardTask[], now = Date.now()): WsEntry[] {
	const out: WsEntry[] = [];
	for (const g of WS_GROUPS) {
		let list = tasks.filter((t) => wsGroup(t, now) === g);
		if (g === "merged") list = list.sort((a, b) => (b.workspace?.merge?.at || b.doneAt || 0) - (a.workspace?.merge?.at || a.doneAt || 0)).slice(0, WS_MERGED_MAX);
		else list = list.sort((a, b) => a.id - b.id);
		for (const task of list) out.push({ task, group: g });
	}
	return out;
}

/** What the overlay knows of the session holding a task (the hub's row). */
export interface WsSession {
	name: string;
	state: string;
	waitingFor?: string | null;
	running: boolean;
}

export type WsTone = "accent" | "warning" | "error" | "success" | "muted" | "dim";

/**
 * The icon of a task: `●` working, `◐` waiting for you (its session asks), `○` idle,
 * `⧗` verifying, `◆` review, `✕` conflict or failed, `✓` merged, `·` open, `–` shelved.
 * The colour only adds to it.
 */
export function wsIcon(t: BoardTask, s?: WsSession): { glyph: string; tone: WsTone } {
	const w = t.workspace;
	if (!w) return { glyph: "·", tone: "dim" };
	switch (w.stage) {
		case "review":
			return { glyph: "◆", tone: "accent" };
		case "conflict":
		case "failed":
			return { glyph: "✕", tone: "error" };
		case "verifying":
			return { glyph: "⧗", tone: "warning" };
		case "merged":
			return { glyph: "✓", tone: "success" };
		case "shelved":
			return { glyph: "–", tone: "dim" };
		case "merging":
			return { glyph: "●", tone: "warning" };
		case "working":
			if (s?.running && s.state === "blocked") return { glyph: "◐", tone: "warning" };
			if (s?.running && s.state === "working") return { glyph: "●", tone: "accent" };
			return { glyph: "○", tone: "muted" };
	}
}

/** A task the overlay counts as needing you: its stage (review, conflict, failed), or its session asks. */
export const wsNeedsYou = (t: BoardTask, s?: WsSession): boolean => needsYou(t) || (t.workspace?.stage === "working" && !!s?.running && s.state === "blocked");

/**
 * The next task after `from` (by the entries' order, wrapping) that needs you; `from`
 * itself only when it is the only one. Undefined when none does.
 */
export function nextNeedsYou(entries: WsEntry[], from: number | undefined, sessionOf: (t: BoardTask) => WsSession | undefined = () => undefined): number | undefined {
	const ids = entries.filter((e) => wsNeedsYou(e.task, sessionOf(e.task))).map((e) => e.task.id);
	if (ids.length === 0) return undefined;
	const order = entries.map((e) => e.task.id);
	const at = from === undefined ? -1 : order.indexOf(from);
	for (let i = 1; i <= order.length; i++) {
		const id = order[(at + i + order.length) % order.length]!;
		if (ids.includes(id)) return id;
	}
	return ids[0];
}

/** The counts for the overlay's title: `3 working · 1 review · 1 conflict`. */
export function wsCounts(entries: WsEntry[]): string {
	const n = (g: WsGroup) => entries.filter((e) => e.group === g).length;
	const parts = [
		n("working") && `${n("working")} working`,
		n("verifying") && `${n("verifying")} verifying`,
		n("review") && `${n("review")} in review`,
		n("fix") && `${n("fix")} to fix`,
		n("open") && `${n("open")} open`,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : "nothing in workspaces";
}

/** What a task's worktree holds against its base (the hub reads it with git; see taskChanges). */
export interface TaskChanges {
	files: { status: string; path: string; add: number | null; del: number | null }[];
	insertions: number;
	deletions: number;
	/** Commits on its branch that base does not have. */
	commits: number;
	/** Uncommitted (tracked changes or new files). */
	dirty: boolean;
}

/** `+82 −3`, for a row (empty when there is nothing). */
export function changeShort(c: TaskChanges | undefined): string {
	if (!c || c.files.length === 0) return "";
	return `+${c.insertions} −${c.deletions}`;
}

/** A row's text after the icon: `#4 users migration`, with what holds an open task. */
export function wsRowText(t: BoardTask, all: BoardTask[]): string {
	const title = t.title.replace(/\s+/g, " ").trim();
	if (!t.workspace) {
		const waits = blockedOn(t, all);
		if (waits.length > 0) return `#${t.id} ${title} · after ${waits.map((i) => `#${i}`).join(" ")}`;
	}
	return `#${t.id} ${title}`;
}

/** The keys that act on a task in its state: what the overlay's bottom line offers. */
export function wsKeys(t: BoardTask | undefined, s?: WsSession): [string, string][] {
	const keys: [string, string][] = [];
	const w = t?.workspace;
	if (t && !w && t.state === "open") keys.push(["s", "start"]);
	if (w) {
		const live = !!s?.running;
		if (w.path && w.stage !== "merged") keys.push(["Enter", "review"]);
		if (w.stage === "review" || w.stage === "conflict" || w.stage === "failed") keys.push(["m", "merge"]);
		if (w.stage === "review" || w.stage === "conflict" || w.stage === "failed") keys.push(["b", "back"]);
		if (w.stage === "review" || w.stage === "failed") keys.push(["v", "verify"]);
		if (w.stage === "failed") keys.push(["p", "pass"]);
		if (w.stage === "conflict") keys.push(["x", "abort sync"]);
		if (!live && ["working", "review", "failed", "conflict", "shelved"].includes(w.stage)) keys.push(["s", "start again"]);
		if (live) keys.push(["t", "attach"]);
		if (t.project) keys.push(["a", "approve"]);
	}
	keys.push(["n", "next"], ["r", "reload"]);
	return keys;
}

const fmtSecs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

/**
 * The detail of a task, as plain lines (the hub colours and cuts them): branch, agent,
 * change, verify, the note, the files, what its session said last.
 */
export function wsDetail(t: BoardTask, o: { session?: WsSession; sentence?: string; changes?: TaskChanges | "loading"; now?: number; fileMax?: number }): { label: string; text: string; tone?: WsTone }[] {
	const now = o.now ?? Date.now();
	const out: { label: string; text: string; tone?: WsTone }[] = [];
	const w = t.workspace;
	if (t.detail) out.push({ label: "task", text: t.detail.replace(/\s+/g, " ").trim() });
	if (!w) {
		out.push({ label: "state", text: t.state === "open" ? "open: s starts it in its own worktree" : t.state });
		return out;
	}
	out.push({ label: "stage", text: `${stageLabel(w.stage)}${w.note ? ` · ${w.note.replace(/\s+/g, " ")}` : ""}`, tone: needsYou(t) ? "warning" : undefined });
	out.push({ label: "branch", text: `${w.branch || "(none)"} (base ${w.baseRef || "?"})` });
	if (o.session) {
		const s = o.session;
		const what = !s.running ? "not running" : s.state === "blocked" ? "waiting for you" : s.state;
		out.push({ label: "agent", text: `${s.name} · ${what}`, tone: s.running && s.state === "blocked" ? "warning" : undefined });
	} else if (t.owner) out.push({ label: "agent", text: `${t.owner.name} · gone` });
	const c = o.changes;
	if (c === "loading") out.push({ label: "change", text: "…" });
	else if (c) {
		const n = c.files.length;
		const parts = [n === 0 ? "no changes" : `${n} file${n === 1 ? "" : "s"} +${c.insertions} −${c.deletions}`];
		if (c.commits > 0) parts.push(`${c.commits} commit${c.commits === 1 ? "" : "s"}`);
		if (c.dirty) parts.push("uncommitted changes");
		out.push({ label: "change", text: parts.join(" · ") });
	}
	if (w.verify) {
		const v = w.verify;
		out.push({ label: "verify", text: `${v.ok ? "✓ passed" : "✕ failed"}${v.rounds > 0 ? ` · round ${v.rounds}` : ""} · ${fmtSecs(Math.max(0, now - v.at))} ago`, tone: v.ok ? "success" : "error" });
		if (!v.ok && v.tail) for (const l of v.tail.trimEnd().split("\n").slice(-3)) out.push({ label: "", text: l, tone: "dim" });
	}
	if (w.merge?.into) out.push({ label: "merged", text: `into ${w.baseRef} (${w.merge.into.slice(0, 8)})`, tone: "success" });
	if (c && c !== "loading" && c.files.length > 0) {
		const max = o.fileMax ?? 8;
		out.push({ label: "files", text: "" });
		for (const f of c.files.slice(0, max)) out.push({ label: "", text: `${f.status.padEnd(2)} ${f.path}${f.add !== null ? `  +${f.add}${f.del ? ` −${f.del}` : ""}` : ""}` });
		if (c.files.length > max) out.push({ label: "", text: `… ${c.files.length - max} more`, tone: "dim" });
	}
	if (o.sentence) out.push({ label: "said", text: `"${o.sentence.replace(/\s+/g, " ").trim()}"`, tone: "muted" });
	if (t.result) out.push({ label: "result", text: t.result.replace(/\s+/g, " ").trim(), tone: "muted" });
	return out;
}
