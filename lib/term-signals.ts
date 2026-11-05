/**
 * M30: what a terminal agent tells its terminal, and what its screen says, for a job
 * roost has no worker report from (a level 0 profile). The host collects the signals
 * from its terminal mirror and writes them to the job's term.json; the daemon reads them
 * with the screen and decides the row's state (inferTermState).
 */
import { createHash } from "node:crypto";
import { readJson } from "./atomic.ts";
import type { JobStateName, JobStatus, WaitingFor } from "./protocol.ts";
import { profileRegex, type ProfileTerm } from "./profiles.ts";

export interface TermSignals {
	/** OSC 0 / OSC 2: the window title the agent set. */
	title?: string;
	/** OSC 9 or OSC 777 notify: the last notification and when it came. */
	notify?: { text: string; at: number };
	/** The last BEL. */
	bellAt?: number;
	/** OSC 133: A/B (a prompt is shown) idle, C (a command runs) busy, D done → idle. */
	prompt?: "idle" | "busy";
	promptAt?: number;
	/** On the alternate screen (a full-screen TUI): its last line is not a result. */
	alt: boolean;
	/** The screen's text last changed then. */
	changedAt: number;
	at: number;
}

/** The part of xterm's Terminal the collector uses (headless or a fake in tests). */
export interface TermLike {
	parser: { registerOscHandler(ident: number, cb: (data: string) => boolean): unknown };
	onBell(cb: () => void): unknown;
	buffer: { active: { type: string } };
}

const clean = (s: string, max: number) =>
	s
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);

/**
 * Collects the signals. `changed` is called when something a reader cares about moved;
 * the host then writes the file (screen changes come in through `screen`).
 */
export class TermSignalCollector {
	private s: TermSignals;
	private hash = "";
	private readonly term: TermLike;
	private readonly changed: () => void;

	constructor(term: TermLike, changed: () => void, now = Date.now()) {
		this.term = term;
		this.changed = changed;
		this.s = { alt: false, changedAt: now, at: now };
		const title = (data: string) => {
			const t = clean(data, 200);
			if (t !== (this.s.title ?? "")) {
				this.s.title = t || undefined;
				this.changed();
			}
			return false; // xterm keeps its own handling
		};
		term.parser.registerOscHandler(0, title);
		term.parser.registerOscHandler(2, title);
		// OSC 9 (iTerm2, Windows Terminal, many agents): the payload is the message, but
		// ConEmu's 9;4 progress and other numbered sub-commands are not notifications
		term.parser.registerOscHandler(9, (data) => {
			if (/^\d+(;|$)/.test(data)) return false;
			this.note(data);
			return false;
		});
		// OSC 777;notify;title;body (rxvt, Ghostty, foot)
		term.parser.registerOscHandler(777, (data) => {
			const [cmd, title = "", body = ""] = data.split(";");
			if (cmd === "notify") this.note(body ? `${title}: ${body}` : title);
			return false;
		});
		term.parser.registerOscHandler(133, (data) => {
			const mark = data[0];
			const next = mark === "C" ? "busy" : mark === "A" || mark === "B" || mark === "D" ? "idle" : undefined;
			if (next) {
				this.s.prompt = next;
				this.s.promptAt = Date.now();
				this.changed();
			}
			return false;
		});
		term.onBell(() => {
			this.s.bellAt = Date.now();
			this.changed();
		});
	}

	private note(text: string): void {
		const t = clean(text, 300);
		this.s.notify = { text: t, at: Date.now() };
		this.changed();
	}

	/** The screen's text now: a change moves changedAt. True when it changed. */
	screen(text: string, now = Date.now()): boolean {
		const h = createHash("sha1").update(text).digest("base64");
		const alt = this.term.buffer.active.type === "alternate";
		const moved = h !== this.hash || alt !== this.s.alt;
		if (moved) {
			this.hash = h;
			this.s.alt = alt;
			this.s.changedAt = now;
		}
		return moved;
	}

	signals(now = Date.now()): TermSignals {
		return { ...this.s, at: now };
	}
}

export function readTermSignals(file: string): TermSignals | undefined {
	const v = readJson<TermSignals>(file);
	return v && typeof v === "object" && typeof v.changedAt === "number" ? v : undefined;
}

export interface TermVerdict {
	state: Extract<JobStateName, "working" | "blocked" | "done">;
	status: JobStatus;
	waitingFor: WaitingFor;
	summary: string | null;
	question: string | null;
	/** Quiet enough for typing a task in. */
	quiet: boolean;
}

/** The last non-empty line of a screen. */
export function lastLine(screen: string): string | undefined {
	const lines = screen.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i]!.trim();
		if (l) return l.slice(0, 200);
	}
	return undefined;
}

function matchedLine(re: RegExp, screen: string): string | undefined {
	const m = re.exec(screen);
	if (!m) return undefined;
	const start = screen.lastIndexOf("\n", m.index) + 1;
	const end = screen.indexOf("\n", m.index);
	return screen.slice(start, end === -1 ? undefined : end).trim().slice(0, 200) || m[0].slice(0, 200);
}

/**
 * The row of a level 0 agent, from the strongest signal down (the process's exit is the
 * daemon's, before this): the profile's regexes, OSC 133 marks, a notification or bell
 * since the last input, then the screen settling. `inputAt` is when roost last typed into
 * it (a reply or the task); `typed` whether anything was ever given to it.
 */
export function inferTermState(
	sig: TermSignals | undefined,
	screen: string,
	term: ProfileTerm,
	o: { now: number; inputAt: number; typed: boolean },
): TermVerdict {
	const changedAt = sig?.changedAt ?? o.now;
	const quiet = o.now - Math.max(changedAt, o.inputAt) >= term.settleMs;
	const summary = sig?.title || (sig?.alt ? null : (lastLine(screen) ?? null));
	const working = profileRegex(term.working);
	const waiting = profileRegex(term.waiting);
	const busy = (question: string | null = null): TermVerdict => ({ state: "working", status: "busy", waitingFor: null, summary, question, quiet: false });
	const ask = (waitingFor: WaitingFor, question: string | null): TermVerdict => ({
		state: "blocked",
		status: "waiting",
		waitingFor,
		summary: question ?? summary,
		question,
		quiet,
	});
	if (working?.test(screen)) return busy();
	// just typed into: what is on screen may still be the question it answered
	const fresh = o.now - o.inputAt < term.settleMs;
	const asked = waiting && !fresh ? matchedLine(waiting, screen) : undefined;
	if (asked) return ask("dialog", asked);
	// the agent's own marks: a command running is work, whatever the screen does
	if (sig?.prompt === "busy" && (sig.promptAt ?? 0) >= o.inputAt) return busy();
	if (!quiet) return busy();
	// it called for you (a notification or bell after what was last typed) and went quiet
	const called = Math.max(sig?.notify?.at ?? 0, sig?.bellAt ?? 0);
	if (called > o.inputAt) return ask("question", sig?.notify && sig.notify.at >= (sig.bellAt ?? 0) ? sig.notify.text || null : null);
	if (!o.typed) return ask("first-prompt", null);
	return { state: "done", status: "idle", waitingFor: null, summary, question: null, quiet };
}
