// M43: the event feed. What happened in the fleet, as a log the hub, the CLI and (M44) a
// concierge read with a cursor: not every row update, the moments that matter.
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { JobStateName, WaitingFor } from "./protocol.ts";

export type EventKind =
	/** A job was started (a task, a spawn, a schedule's run). */
	| "dispatch"
	/** A job's state changed to one that matters: it waits, finished, failed, was stopped, or started again. */
	| "state"
	/** The user (or the hub's agent) replied to a session. */
	| "reply"
	/** One session messaged another (roost_send). */
	| "message"
	/** A child reported to its parent (handback). */
	| "report"
	/** A watch fired: a session went idle or ended. */
	| "notice"
	/** A run cut short will be started again by itself (M38/M40). */
	| "resume"
	/** A schedule started a run (M39). */
	| "schedule"
	/** A job's record was removed. */
	| "removed"
	/** M44: the concierge told the user something (why: info | need), or answered a question (why: answer). */
	| "concierge";

export interface RoostEvent {
	seq: number;
	at: number;
	kind: EventKind;
	/** The job it is about (the recipient, for a message). */
	id: string;
	name: string;
	state?: JobStateName;
	/** For "state": the state it left. */
	from?: JobStateName | null;
	waitingFor?: WaitingFor;
	/** A short text: the question, the result, the message's first line, the error, the schedule's name. */
	text?: string | null;
	/** Who caused it: a session's name, "user", a schedule's name. */
	who?: string | null;
	/** The job that caused it, when a job did (names can be shared; ids cannot). */
	whoId?: string | null;
	why?: string | null;
}

/** The log keeps this many events (in memory and in its file). */
export const EVENT_LOG_MAX = 1000;
/** A text in an event is at most this long. */
export const EVENT_TEXT_MAX = 300;

export function clipText(s: string | null | undefined): string | null {
	if (typeof s !== "string") return null;
	const line = s.replace(/\s+/g, " ").trim();
	if (!line) return null;
	return line.length <= EVENT_TEXT_MAX ? line : `${line.slice(0, EVENT_TEXT_MAX - 1)}…`;
}

/** The transitions the log keeps: into waiting/done/failed/stopped, and back to work from them. */
export function stateMatters(from: JobStateName | null | undefined, to: JobStateName): boolean {
	if (from === to) return false;
	if (to !== "working") return true;
	return from === "blocked" || from === "done" || from === "failed" || from === "stopped";
}

export interface EventQuery {
	/** Events after this seq (the cursor a client holds); absent: the newest. */
	after?: number;
	/** At most this many, oldest first (default 100, at most EVENT_LOG_MAX). */
	limit?: number;
	/** Only this job's. */
	id?: string;
}

/**
 * An append-only JSON-lines file, the last EVENT_LOG_MAX entries kept. Nothing here is
 * fsynced: a crash loses the last few lines, and the feed is a convenience, not a record.
 */
export class EventLog {
	readonly path: string;
	private events: RoostEvent[] = [];
	private seq = 0;
	private max: number;
	/** Lines appended to the file since it was last rewritten. */
	private appended = 0;
	private warn: (msg: string) => void;

	constructor(path: string, opts: { max?: number; warn?: (msg: string) => void } = {}) {
		this.path = path;
		this.max = opts.max ?? EVENT_LOG_MAX;
		this.warn = opts.warn ?? (() => {});
		this.load();
	}

	private load(): void {
		let text = "";
		try {
			text = readFileSync(this.path, "utf8");
		} catch {
			return;
		}
		const out: RoostEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as RoostEvent;
				if (typeof e?.seq === "number" && typeof e.at === "number" && typeof e.kind === "string" && typeof e.id === "string") out.push(e);
			} catch {}
		}
		this.events = out.slice(-this.max);
		this.seq = out.length > 0 ? out[out.length - 1]!.seq : 0;
		this.appended = out.length;
	}

	/** The newest seq (a client's cursor starts here). */
	cursor(): number {
		return this.seq;
	}

	all(): readonly RoostEvent[] {
		return this.events;
	}

	append(e: Omit<RoostEvent, "seq" | "at"> & { at?: number }): RoostEvent {
		const ev: RoostEvent = { ...e, seq: ++this.seq, at: e.at ?? Date.now() };
		this.events.push(ev);
		if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
		try {
			if (this.appended >= this.max * 2) {
				// the file holds twice the window: rewrite it with the window
				const tmp = `${this.path}.tmp`;
				writeFileSync(tmp, `${this.events.map((x) => JSON.stringify(x)).join("\n")}\n`);
				renameSync(tmp, this.path);
				this.appended = this.events.length;
			} else {
				appendFileSync(this.path, `${JSON.stringify(ev)}\n`);
				this.appended++;
			}
		} catch (err) {
			this.warn(`event log write failed: ${String(err)}`);
		}
		return ev;
	}

	/**
	 * Events after `after` (oldest first), or the newest `limit` when `after` is absent. A
	 * cursor ahead of the log (its file was deleted, the numbering started over) is treated
	 * as absent: the newest `limit`, and the cursor returned is the new one.
	 */
	since(q: EventQuery = {}): { events: RoostEvent[]; cursor: number } {
		const limit = Math.max(1, Math.min(this.max, Math.floor(q.limit ?? 100)));
		let list = q.id ? this.events.filter((e) => e.id === q.id) : this.events;
		if (typeof q.after === "number" && q.after <= this.seq) list = list.filter((e) => e.seq > q.after!).slice(0, limit);
		else list = list.slice(-limit);
		return { events: list, cursor: this.seq };
	}
}

/** "3m", "2h", "5d": how long ago, for the hub's /log and the CLI. */
export function eventAgo(at: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/** One line for an event, as the hub's /log and `pi-roost log` show it. */
export function eventLine(e: RoostEvent): string {
	const who = e.who ? ` ← ${e.who}` : "";
	switch (e.kind) {
		case "dispatch":
			return `started ${e.name}${who}${e.text ? `: ${e.text}` : ""}`;
		case "state": {
			if (e.state === "blocked") return `${e.name} ${e.waitingFor === "dialog" ? "is in a dialog" : e.waitingFor === "first-prompt" ? "waits for its first task" : "asks"}${e.text ? `: ${e.text}` : ""}`;
			if (e.state === "done") return `${e.name} finished${e.text ? `: ${e.text}` : ""}`;
			if (e.state === "failed") return `${e.name} failed${e.text ? `: ${e.text}` : ""}`;
			if (e.state === "stopped") return `${e.name} stopped`;
			return `${e.name} works again${e.from ? ` (was ${e.from})` : ""}`;
		}
		case "reply":
			return `${e.who ?? "user"} → ${e.name}${e.text ? `: ${e.text}` : ""}`;
		case "message":
			return `${e.who ?? "?"} → ${e.name}${e.text ? `: ${e.text}` : ""}`;
		case "report":
			return `${e.name} reported to ${e.who ?? "its parent"}${e.text ? `: ${e.text}` : ""}`;
		case "notice":
			return `${e.who ?? "?"} was told ${e.name} ${e.text ?? "changed"}`;
		case "resume":
			return `${e.name} restarts by itself${e.why ? ` (${e.why})` : ""}${e.text ? `: ${e.text}` : ""}`;
		case "schedule":
			return `schedule ${e.who ?? "?"} started ${e.name}${e.why ? ` (${e.why})` : ""}`;
		case "removed":
			return `${e.name} removed`;
		case "concierge": {
			// M44: what it told the user; M45: a suggestion, the policy, an answer withdrawn, an act; M46: an order applied, kept, dropped
			const how =
				e.why === "need"
					? "concierge needs you"
					: e.why === "answer"
						? "concierge answered"
						: e.why === "suggest"
							? `concierge suggests for ${e.name}`
							: e.why === "policy"
								? "concierge policy"
								: e.why === "undo"
									? `concierge's answer to ${e.name} withdrawn`
									: e.why === "act"
										? "concierge"
										: e.why === "order"
											? "concierge applied an order"
											: e.why === "order-kept"
												? "concierge keeps an order"
												: e.why === "order-dropped"
													? "concierge dropped an order"
													: "concierge";
			return `${how}: ${e.text ?? ""}`;
		}
		default:
			return `${e.kind} ${e.name}`;
	}
}
