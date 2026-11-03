import type { JobRow, JobStateName } from "./protocol.ts";

/** NT-2 event names on pi.events. */
export const JOB_NEEDS_INPUT = "agents:job_needs_input";
export const JOB_COMPLETED = "agents:job_completed";

export interface JobEventPayload {
	id: string;
	name: string;
	cwd: string;
	state: JobStateName;
	summary: string | null;
	question: string | null;
	error: string | null;
}

export type NotifyMode = "auto" | "osc9" | "osc777" | "bell" | "off";

interface Bus {
	emit(channel: string, data: unknown): void;
}

// Process-wide: the foreground footer and an agent view in the same pi share them,
// so a transition is announced once.
const KEY = Symbol.for("pi-roost.jobEvents");
type Shared = { bus?: Bus; last: Map<string, JobStateName> };
const shared = (): Shared => {
	const g = globalThis as { [KEY]?: Shared };
	g[KEY] ??= { last: new Map() };
	return g[KEY];
};

/** The pi.events bus of this process (set once by the extension). */
export function setJobEventBus(bus: Bus | undefined): void {
	shared().bus = bus;
}

/** "needs input" for a blocked row, "completed" for done/failed, else nothing. */
export function transitionKind(before: JobStateName | undefined, row: JobRow): "needs_input" | "completed" | undefined {
	if (before === undefined || before === row.state) return undefined;
	if (row.state === "blocked") return "needs_input";
	if (row.state === "done" || row.state === "failed") return "completed";
	return undefined;
}

/**
 * Note a row's state. Returns what it changed into when that is news: the first
 * sighting of a job only records it, and the same state is never announced twice.
 */
export function observeJob(row: JobRow): "needs_input" | "completed" | undefined {
	const s = shared();
	const before = s.last.get(row.id);
	s.last.set(row.id, row.state);
	const kind = transitionKind(before, row);
	if (!kind) return undefined;
	const payload: JobEventPayload = {
		id: row.id,
		name: row.name,
		cwd: row.cwd,
		state: row.state,
		summary: row.summary,
		question: row.question,
		error: row.error,
	};
	try {
		s.bus?.emit(kind === "needs_input" ? JOB_NEEDS_INPUT : JOB_COMPLETED, payload);
	} catch {
		// a listener's error is not ours
	}
	return kind;
}

export const forgetJob = (id: string) => shared().last.delete(id);

/** The terminal's notification for "auto": OSC 9 where it is known to work, else the bell. */
export function resolveNotify(mode: NotifyMode | undefined, env: NodeJS.ProcessEnv = process.env): Exclude<NotifyMode, "auto"> {
	if (mode && mode !== "auto") return mode;
	const term = `${env.TERM_PROGRAM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
	if (/iterm|wezterm|ghostty|kitty/.test(term) || env.KITTY_WINDOW_ID) return "osc9";
	return "bell";
}

// C0, DEL and C1 controls (U+009C ends an OSC in some terminals), and the OSC 777 separator
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f;]+/g, " ").trim().slice(0, 200);

/** NT-1: the bytes that make the terminal notify (empty for "off"). */
export function notifySequence(mode: Exclude<NotifyMode, "auto">, title: string, body: string): string {
	switch (mode) {
		case "osc9":
			return `\x1b]9;${clean(`${title}: ${body}`)}\x07`;
		case "osc777":
			return `\x1b]777;notify;${clean(title)};${clean(body)}\x07`;
		case "bell":
			return "\x07";
		default:
			return "";
	}
}

export function notifyText(row: JobRow, kind: "needs_input" | "completed"): { title: string; body: string } {
	if (kind === "needs_input") return { title: `${row.name} needs input`, body: row.question ?? row.summary ?? "waiting" };
	return {
		title: `${row.name} ${row.state === "failed" ? "failed" : "is done"}`,
		body: (row.state === "failed" ? row.error : row.summary) ?? "",
	};
}
