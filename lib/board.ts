// M47: the shared task board (Claude Code's agent teams coordinate through a task list:
// pending / in progress / completed, claimed with a lock, dependencies that unblock). The
// daemon keeps it (tasks.json); sessions take work from it (roost_task_*), the hub shows
// and edits it (/tasks), the concierge works it as the lead (hub_task_*).
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { eventAgo } from "./events.ts";

export interface BoardTask {
	id: number;
	title: string;
	detail: string | null;
	state: "open" | "claimed" | "done" | "dropped";
	/** Ids it waits on: claimable once each is done (a dropped one does not hold it). */
	after: number[];
	/** Who put it on the board: "user", "concierge", or a session's name (its job id when a job). */
	by: { who: string; whoId: string | null };
	at: number;
	/** The session that holds it (claimed), or held it (done). */
	owner: { id: string; name: string } | null;
	claimedAt: number | null;
	doneAt: number | null;
	result: string | null;
	/** Handed to a session by the hub or the concierge (a message there); open until that session claims it. */
	assigned: { id: string; name: string; at: number } | null;
	/** M52: the project it is for (a repository's root, projectOf); null: any session's. */
	project: string | null;
	/** M52: sessions told when it can be claimed (refused as blocked); at most TASK_WAITING_MAX. */
	waiting: { id: string; name: string }[];
	/** M54: its own worktree and where it is in the loop (absent: a task without one). */
	workspace?: TaskWorkspace | null;
}

/**
 * M54 (docs/plans/ade-roadmap.md): where a task with a workspace is, task → worktree →
 * verify → review → local merge. The stage is the truth for such a task; `state` follows
 * the claim as for any task, except that `merged` is `done`.
 */
export type WorkspaceStage = "working" | "verifying" | "review" | "merging" | "conflict" | "failed" | "shelved" | "merged";
export const WORKSPACE_STAGES: readonly WorkspaceStage[] = ["working", "verifying", "review", "merging", "conflict", "failed", "shelved", "merged"];
/** The stages that wait on a person. */
export const NEEDS_YOU_STAGES: ReadonlySet<WorkspaceStage> = new Set(["review", "conflict", "failed"]);

/** A review comment on a line of the task's diff (M58). */
export interface ReviewComment {
	file: string;
	line: number;
	text: string;
	/** The line's text when it was written: the comment is outdated once it is not there. */
	lineText: string;
	/** The branch tip it was written on. */
	tip: string;
	at: number;
}

export interface TaskWorkspace {
	/** The worktree's top directory ("" when a damaged record lost it). */
	path: string;
	branch: string;
	/** The base branch's name, e.g. "main". */
	baseRef: string;
	/** The commit the worktree was made from (40 or 64 hex; "" when unknown). */
	baseSha: string;
	stage: WorkspaceStage;
	/** Why it is where it is, for a person: "not verified (interrupted)", a git message. */
	note: string | null;
	verify?: { ok: boolean; at: number; log: string; tail: string; rounds: number };
	/** Written before the merge (the tip and the base it starts from), `into` after it (M55). */
	merge?: { tip: string; oldBase: string; at: number; into?: string };
	comments?: ReviewComment[];
	/** M59: the branch tip its session's done sent to review (a merge by hand is of this tip). */
	reviewTip?: string;
}

export const TASK_NOTE_MAX = 500;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const strOf = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/**
 * A stored workspace, normalised: null when there is none; a damaged one (no path or
 * branch, an unknown stage) is kept as `failed` for a person to look at, never dropped
 * (its worktree and branch may hold work).
 */
export function parseWorkspace(raw: unknown): TaskWorkspace | null {
	if (raw === undefined || raw === null) return null;
	const o = (typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const path = strOf(o.path, 4096);
	const branch = strOf(o.branch, 255);
	const stage = typeof o.stage === "string" && (WORKSPACE_STAGES as readonly string[]).includes(o.stage) ? (o.stage as WorkspaceStage) : null;
	const damaged = !path || !isAbsolute(path) || !branch || !stage;
	const w: TaskWorkspace = {
		path: path && isAbsolute(path) ? path : "",
		branch: branch ?? "",
		baseRef: strOf(o.baseRef, 255) ?? "",
		baseSha: typeof o.baseSha === "string" && SHA.test(o.baseSha) ? o.baseSha : "",
		stage: damaged ? "failed" : stage,
		note: damaged ? "the stored workspace was damaged: check its worktree and branch by hand" : strOf(o.note, TASK_NOTE_MAX),
	};
	const v = o.verify as Record<string, unknown> | undefined;
	if (v && typeof v === "object" && typeof v.ok === "boolean" && Number.isFinite(v.at))
		w.verify = { ok: v.ok, at: v.at as number, log: strOf(v.log, 4096) ?? "", tail: strOf(v.tail, 4000) ?? "", rounds: Number.isInteger(v.rounds) && (v.rounds as number) >= 0 ? (v.rounds as number) : 0 };
	if (typeof o.reviewTip === "string" && SHA.test(o.reviewTip)) w.reviewTip = o.reviewTip;
	const m = o.merge as Record<string, unknown> | undefined;
	if (m && typeof m === "object" && typeof m.tip === "string" && SHA.test(m.tip) && typeof m.oldBase === "string" && SHA.test(m.oldBase))
		w.merge = { tip: m.tip, oldBase: m.oldBase, at: Number.isFinite(m.at) ? (m.at as number) : 0, ...(typeof m.into === "string" && SHA.test(m.into) ? { into: m.into } : {}) };
	if (Array.isArray(o.comments)) {
		const cs = o.comments
			.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
			.filter((c) => strOf(c.file, 4096) && Number.isInteger(c.line) && (c.line as number) >= 1 && strOf(c.text, TASK_TEXT_MAX))
			.slice(0, 200)
			.map((c) => ({
				file: (c.file as string).slice(0, 4096),
				line: c.line as number,
				text: (c.text as string).slice(0, TASK_TEXT_MAX),
				lineText: typeof c.lineText === "string" ? c.lineText.slice(0, 1000) : "",
				tip: typeof c.tip === "string" && SHA.test(c.tip) ? c.tip : "",
				at: Number.isFinite(c.at) ? (c.at as number) : 0,
			}));
		if (cs.length > 0) w.comments = cs;
	}
	return w;
}

/** How a stage reads in a line: `in review`, `conflict`. */
export function stageLabel(s: WorkspaceStage): string {
	return s === "review" ? "in review" : s;
}

/** The task needs a person (review, a conflict, a failure). */
export const needsYou = (t: BoardTask): boolean => !!t.workspace && t.state !== "dropped" && NEEDS_YOU_STAGES.has(t.workspace.stage);

/**
 * M54: whether `d`, which `t` waits on, no longer holds it. Dropped: never holds. Of
 * another project: done (its code is not in this repository). With a workspace: merged
 * (its state is then done; a task marked done by hand without its merge still holds).
 * Otherwise: done.
 */
export function dependencyMet(d: BoardTask, t: Pick<BoardTask, "project">): boolean {
	if (d.state === "dropped") return true;
	if ((d.project ?? null) !== (t.project ?? null)) return d.state === "done";
	if (d.workspace) return d.workspace.stage === "merged" && d.state === "done";
	return d.state === "done";
}

export const TASK_MAX = 200;
export const TASK_TITLE_MAX = 200;
export const TASK_TEXT_MAX = 2000;
export const TASK_WAITING_MAX = 20;

/**
 * M52: the project a directory is in: the root of its git repository, a worktree's being
 * its repository's (roost's isolated sessions share the board of the repository they
 * branch); null outside a repository (such a session sees the tasks for anyone).
 */
export function projectOf(cwd: string | null | undefined): string | null {
	if (!cwd || !isAbsolute(cwd)) return null;
	let dir: string;
	try {
		dir = realpathSync(cwd);
	} catch {
		dir = resolve(cwd);
	}
	for (;;) {
		const git = join(dir, ".git");
		try {
			if (statSync(git).isDirectory()) return dir;
			// a worktree's .git is a file: `gitdir: <repository's git dir>/worktrees/<name>`
			const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"));
			return m ? repositoryOf(resolve(dir, m[1]!.trim()), dir) : dir;
		} catch {}
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

/**
 * M52: the project of a checkout whose .git file points at `gd`. A linked worktree's git dir
 * has a `commondir` naming the repository's: its parent for a `.git` dir, the bare
 * repository itself otherwise. A submodule's (no commondir) is the checkout itself.
 */
function repositoryOf(gd: string, dir: string): string {
	let common: string;
	try {
		common = resolve(gd, readFileSync(join(gd, "commondir"), "utf8").trim());
	} catch {
		return dir;
	}
	try {
		common = realpathSync(common);
	} catch {}
	return basename(common) === ".git" ? dirname(common) : common;
}

/** M52: a project's short name (its directory's), or "any" for the tasks for any session. */
export const projectLabel = (p: string | null): string => (p ? basename(p) : "any");

/** M52: a task a session of `project` sees and may take: its project's, or one for any session. */
export const onBoardOf = (t: Pick<BoardTask, "project">, project: string | null): boolean => t.project === null || t.project === project;

export interface BoardSummary {
	open: number;
	claimed: number;
	blocked: number;
	done: number;
	/** M54: tasks in their workspaces (not merged, not dropped); not in the counts above. */
	workspaces?: number;
	/** M54: of those, the ones waiting on a person (review, conflict, failed). */
	needsYou?: number;
}

/** The ids a task still waits on: the ones that exist and still hold it (dependencyMet). */
export function blockedOn(t: BoardTask, all: Iterable<BoardTask>): number[] {
	const by = new Map<number, BoardTask>();
	for (const x of all) by.set(x.id, x);
	return t.after.filter((id) => {
		const d = by.get(id);
		return d !== undefined && !dependencyMet(d, t);
	});
}

/** M54: a session can claim it now: open, waiting on nothing, without a workspace (one with a workspace is started: /tasks start). */
export const claimable = (t: BoardTask, all: Iterable<BoardTask>): boolean => t.state === "open" && !t.workspace && blockedOn(t, all).length === 0;

/** A task in its workspace: one with a workspace that is neither merged (done) nor dropped. */
const inWorkspace = (t: BoardTask): boolean => !!t.workspace && t.state !== "done" && t.state !== "dropped";

/** Open, claimed, blocked (open but waiting on another), done; M54: in workspaces, needing you. */
export function boardSummary(all: BoardTask[]): BoardSummary {
	const s: BoardSummary = { open: 0, claimed: 0, blocked: 0, done: 0, workspaces: 0, needsYou: 0 };
	for (const t of all) {
		if (t.state === "done") s.done++;
		else if (inWorkspace(t)) {
			s.workspaces!++;
			if (needsYou(t)) s.needsYou!++;
		} else if (t.state === "claimed") s.claimed++;
		else if (t.state === "open") {
			if (blockedOn(t, all).length > 0) s.blocked++;
			else s.open++;
		}
	}
	return s;
}

/** `3 open · 2 claimed · 1 blocked · 2 in workspaces (1 needs you) · 5 done` (zeros left out; "none" when empty). */
export function summaryLine(s: BoardSummary): string {
	const ws = s.workspaces ? `${s.workspaces} in workspace${s.workspaces === 1 ? "" : "s"}${s.needsYou ? ` (${s.needsYou} need${s.needsYou === 1 ? "s" : ""} you)` : ""}` : 0;
	const parts = [s.open && `${s.open} open`, s.claimed && `${s.claimed} claimed`, s.blocked && `${s.blocked} blocked`, ws, s.done && `${s.done} done`].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : "none";
}

/**
 * One line for a task: `#4 open · write the tests`, `#5 blocked on #2 · deploy`,
 * `#2 claimed by api-fix (3m) · the migration`, `#1 done 10m ago by api-fix · the schema → applied v2`.
 */
/** M49: one line of a title, a result, a name: the board's lines in a digest are the digest's, whatever was stored. */
const line = (s: string): string => s.replace(/\s+/g, " ").trim();

export function taskLine(t: BoardTask, all: Iterable<BoardTask>, now = Date.now(), projects = false): string {
	// M52: the project's name, when the tasks shown are of more than one
	const title = `${projects ? `[${projectLabel(t.project ?? null)}] ` : ""}${line(t.title)}`;
	if (t.state === "done") return `#${t.id} done${t.doneAt ? ` ${eventAgo(t.doneAt, now)} ago` : ""}${t.owner ? ` by ${line(t.owner.name)}` : ""} · ${title}${t.result ? ` → ${line(t.result)}` : ""}`;
	if (t.state === "dropped") return `#${t.id} dropped · ${title}`;
	// M54: a task in its workspace says where in the loop it is, and who works on it
	if (t.workspace) return `#${t.id} ${stageLabel(t.workspace.stage)}${t.owner ? ` · ${line(t.owner.name)}` : ""} · ${title}${t.workspace.note ? ` (${line(t.workspace.note)})` : ""}`;
	if (t.state === "claimed") return `#${t.id} claimed by ${line(t.owner?.name ?? "?")}${t.claimedAt ? ` (${eventAgo(t.claimedAt, now)})` : ""} · ${title}`;
	const waits = blockedOn(t, all);
	if (waits.length > 0) {
		// M54: what holds it, when that is a task in its workspace: `#4 (in review)`
		const by = new Map<number, BoardTask>();
		for (const x of all) by.set(x.id, x);
		const held = (i: number) => {
			const w = by.get(i)?.workspace;
			return w && w.stage !== "merged" ? `#${i} (${stageLabel(w.stage)})` : `#${i}`;
		};
		return `#${t.id} blocked on ${waits.map(held).join(" ")} · ${title}`;
	}
	const to = t.assigned ? ` · handed to ${line(t.assigned.name)} ${eventAgo(t.assigned.at, now)} ago` : "";
	return `#${t.id} open · ${title}${to}`;
}

/** Open (claimable) first, then blocked, then claimed, then (M54) those in workspaces: the order the digest and the hub list live tasks in. */
export function liveOrder(t: BoardTask, all: BoardTask[]): number {
	return t.workspace ? 3 : t.state === "claimed" ? 2 : blockedOn(t, all).length > 0 ? 1 : 0;
}

/** The board for a digest: the summary line, then every task that is not done or dropped (open, blocked, claimed). */
/** M52: whether the tasks are of more than one project (then each line names its own). */
export const manyProjects = (all: BoardTask[]): boolean => new Set(all.map((t) => t.project ?? null)).size > 1;

export function boardLines(all: BoardTask[], now = Date.now()): string[] {
	const projects = manyProjects(all);
	const s = boardSummary(all);
	const out = [`The board (${summaryLine(s)}):`];
	const live = all.filter((t) => t.state === "open" || t.state === "claimed");
	if (live.length === 0) out.push(s.done > 0 ? "- every task is done" : "- empty");
	const order = (t: BoardTask) => liveOrder(t, all);
	for (const t of [...live].sort((a, b) => order(a) - order(b) || a.id - b.id)) out.push(`- ${taskLine(t, all, now, projects)}`);
	return out;
}

/** The board for a tool's answer: boardLines, then the last `doneMax` done tasks (newest last). */
export function boardListing(all: BoardTask[], now = Date.now(), doneMax = 10): string[] {
	const out = boardLines(all, now);
	const done = all.filter((t) => t.state === "done").sort((a, b) => (a.doneAt ?? a.at) - (b.doneAt ?? b.at));
	const shown = done.slice(-doneMax);
	if (shown.length > 0) {
		out.push(done.length > shown.length ? `Done (the last ${shown.length} of ${done.length}):` : "Done:");
		for (const t of shown) out.push(`- ${taskLine(t, all, now, manyProjects(all))}`);
	}
	return out;
}

/** M58: at most this many review comments on a task; a send-back's text at most this long. */
export const REVIEW_COMMENTS_MAX = 200;
export const REVIEW_TEXT_MAX = 4000;

/**
 * M58: the review comments as a message for the session: each with its place and the line
 * it is about, bounded (the rest counted).
 */
export function reviewText(comments: ReviewComment[], max = REVIEW_TEXT_MAX): { text: string; count: number } {
	const one = (s: string) => s.replace(/\s+/g, " ").trim();
	const out: string[] = [];
	let used = 0;
	let count = 0;
	for (let i = 0; i < comments.length; i++) {
		const c = comments[i]!;
		const line = `- ${c.file}:${c.line}${c.lineText ? ` (${one(c.lineText).slice(0, 120)})` : ""}: ${one(c.text)}`.slice(0, max);
		if (used + line.length + 1 > max && count > 0) {
			out.push(`… and ${comments.length - i} more comment${comments.length - i === 1 ? "" : "s"}, sent with the next send-back`);
			break;
		}
		out.push(line);
		used += line.length + 1;
		count++;
	}
	return { text: out.join("\n"), count };
}

/** M55/M57: the first prompt of a task's session (the hub's /tasks start, the concierge's hub_task_start). */
export function taskPrompt(t: Pick<BoardTask, "id" | "title" | "detail" | "workspace">): string {
	const comments = t.workspace?.comments ?? [];
	return [
		`Task #${t.id}: ${t.title}`,
		t.detail ?? "",
		t.workspace ? "Work on it started before in this worktree: read `git log` and the diff against the base branch first." : "",
		comments.length > 0 ? `The review asks for changes (line numbers are of the reviewed version):\n${reviewText(comments).text}` : "",
		"Commit your work on this branch, then call roost_task_done with a line on what you did.",
	]
		.filter(Boolean)
		.join("\n\n");
}
