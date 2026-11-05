// M47: the shared task board (Claude Code's agent teams coordinate through a task list:
// pending / in progress / completed, claimed with a lock, dependencies that unblock). The
// daemon keeps it (tasks.json); sessions take work from it (roost_task_*), the hub shows
// and edits it (/tasks), the concierge works it as the lead (hub_task_*).
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
}

export const TASK_MAX = 200;
export const TASK_TITLE_MAX = 200;
export const TASK_TEXT_MAX = 2000;

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
export function taskLine(t: BoardTask, all: Iterable<BoardTask>, now = Date.now()): string {
	const title = t.title;
	if (t.state === "done") return `#${t.id} done ${t.doneAt ? `${eventAgo(t.doneAt, now)} ago` : ""}${t.owner ? ` by ${t.owner.name}` : ""} · ${title}${t.result ? ` → ${t.result}` : ""}`;
	if (t.state === "dropped") return `#${t.id} dropped · ${title}`;
	if (t.state === "claimed") return `#${t.id} claimed by ${t.owner?.name ?? "?"}${t.claimedAt ? ` (${eventAgo(t.claimedAt, now)})` : ""} · ${title}`;
	const waits = blockedOn(t, all);
	if (waits.length > 0) return `#${t.id} blocked on ${waits.map((i) => `#${i}`).join(" ")} · ${title}`;
	const to = t.assigned ? ` · handed to ${t.assigned.name} ${eventAgo(t.assigned.at, now)} ago` : "";
	return `#${t.id} open · ${title}${to}`;
}

/** The board for a digest: the summary line, then every task that is not done or dropped (blocked, open, claimed). */
export function boardLines(all: BoardTask[], now = Date.now()): string[] {
	const s = boardSummary(all);
	const out = [`The board (${summaryLine(s)}):`];
	const live = all.filter((t) => t.state === "open" || t.state === "claimed");
	if (live.length === 0) out.push(s.done > 0 ? "- every task is done" : "- empty");
	const order = (t: BoardTask) => (t.state === "claimed" ? 2 : blockedOn(t, all).length > 0 ? 0 : 1);
	for (const t of [...live].sort((a, b) => order(a) - order(b) || a.id - b.id)) out.push(`- ${taskLine(t, all, now)}`);
	return out;
}

/** The board for a tool's answer: boardLines, then the last `doneMax` done tasks (newest last). */
export function boardListing(all: BoardTask[], now = Date.now(), doneMax = 10): string[] {
	const out = boardLines(all, now);
	const done = all.filter((t) => t.state === "done").sort((a, b) => (a.doneAt ?? a.at) - (b.doneAt ?? b.at));
	const shown = done.slice(-doneMax);
	if (shown.length > 0) {
		out.push(done.length > shown.length ? `Done (the last ${shown.length} of ${done.length}):` : "Done:");
		for (const t of shown) out.push(`- ${taskLine(t, all, now)}`);
	}
	return out;
}
