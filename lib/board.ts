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
}

/** The ids a task still waits on: the ones that exist and are neither done nor dropped. */
export function blockedOn(t: BoardTask, all: Iterable<BoardTask>): number[] {
	const by = new Map<number, BoardTask>();
	for (const x of all) by.set(x.id, x);
	return t.after.filter((id) => {
		const d = by.get(id);
		return d !== undefined && d.state !== "done" && d.state !== "dropped";
	});
}

/** Open, claimed, blocked (open but waiting on another) and done, counted. */
export function boardSummary(all: BoardTask[]): BoardSummary {
	const s: BoardSummary = { open: 0, claimed: 0, blocked: 0, done: 0 };
	for (const t of all) {
		if (t.state === "done") s.done++;
		else if (t.state === "claimed") s.claimed++;
		else if (t.state === "open") {
			if (blockedOn(t, all).length > 0) s.blocked++;
			else s.open++;
		}
	}
	return s;
}

/** `3 open · 2 claimed · 1 blocked · 5 done` (what is zero left out; "none" when the board is empty). */
export function summaryLine(s: BoardSummary): string {
	const parts = [s.open && `${s.open} open`, s.claimed && `${s.claimed} claimed`, s.blocked && `${s.blocked} blocked`, s.done && `${s.done} done`].filter(Boolean);
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
	if (t.state === "claimed") return `#${t.id} claimed by ${line(t.owner?.name ?? "?")}${t.claimedAt ? ` (${eventAgo(t.claimedAt, now)})` : ""} · ${title}`;
	const waits = blockedOn(t, all);
	if (waits.length > 0) return `#${t.id} blocked on ${waits.map((i) => `#${i}`).join(" ")} · ${title}`;
	const to = t.assigned ? ` · handed to ${line(t.assigned.name)} ${eventAgo(t.assigned.at, now)} ago` : "";
	return `#${t.id} open · ${title}${to}`;
}

/** Open (claimable) first, then blocked, then claimed: the order the digest and the hub list live tasks in. */
export function liveOrder(t: BoardTask, all: BoardTask[]): number {
	return t.state === "claimed" ? 2 : blockedOn(t, all).length > 0 ? 1 : 0;
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
