/**
 * M39: scheduled tasks. A schedule is a dispatch template (what the hub would start)
 * and when: `every 30m`, `daily 09:00`, `weekdays 09:00`, or a five-field cron
 * expression, in local time. The background service starts a run when one is due; a
 * run is a session like any other. Node only: the dispatch template was made by the side
 * that knows the agent (pi's adapter), with `{{run}}` where each run's own session file
 * name goes.
 */
import { randomUUID } from "node:crypto";
import type { DispatchArgs } from "./protocol.ts";

export const RUN_SLOT = "{{run}}";

export interface Schedule {
	name: string;
	/** As the user wrote it (`every 2h`, `daily 09:00`, `cron 0 9 * * 1-5`). */
	when: string;
	/** What runs: a dispatch whose sessionFile and command hold `{{run}}`. */
	launch: DispatchArgs;
	paused: boolean;
	/** Run once on start when a run was due while the service was off (default true). */
	catchUp: boolean;
	/** The task as typed (shown in lists). */
	task?: string;
	createdAt: number;
	/** What `every` counts from: when it was made, or last resumed. */
	anchor: number;
	/** The next run (ms epoch), or null while paused. */
	nextAt: number | null;
	lastRunAt?: number;
	lastJob?: string;
	/** Why the last due run did not start (the previous one still running, an error). */
	lastSkip?: { at: number; why: string };
}

export const SCHEDULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

// ---- when ------------------------------------------------------------------------------

type Field = Set<number>;
export interface Cron {
	minute: Field;
	hour: Field;
	dom: Field;
	month: Field;
	dow: Field;
	/** Day of month and day of week both restricted: either matches (cron's rule). */
	domAndDow: boolean;
}

function field(text: string, min: number, max: number, name: string): { set: Field; any: boolean } {
	const set: Field = new Set();
	for (const part of text.split(",")) {
		const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!m) throw new Error(`cron ${name}: ${part}`);
		const step = m[4] === undefined ? 1 : Number(m[4]);
		let lo = min;
		let hi = max;
		if (m[1] !== "*") {
			lo = Number(m[2]);
			hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
		}
		if (step < 1 || lo < min || hi > max || lo > hi) throw new Error(`cron ${name}: ${part} (${min}-${max})`);
		for (let v = lo; v <= hi; v += step) set.add(v);
	}
	// a leading * (with a step too) leaves the day rule as "and", as cron does
	return { set, any: text.startsWith("*") };
}

export function parseCron(expr: string): Cron {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error("cron needs five fields: minute hour day-of-month month day-of-week");
	const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
	const d = field(dow, 0, 7, "day of week");
	// 7 is Sunday too
	if (d.set.has(7)) {
		d.set.delete(7);
		d.set.add(0);
	}
	const dm = field(dom, 1, 31, "day of month");
	return {
		minute: field(mi, 0, 59, "minute").set,
		hour: field(h, 0, 23, "hour").set,
		dom: dm.set,
		month: field(mo, 1, 12, "month").set,
		dow: d.set,
		domAndDow: !dm.any && !d.any,
	};
}

/**
 * The first minute after `after` the cron matches (local time), within ~5 years. Steps
 * never go back: in the hour a DST change repeats, a local setter can land an hour
 * earlier; a step that would is made a minute forward instead.
 */
export function nextCron(c: Cron, after: number): number | null {
	// the next whole minute, in epoch time (a local setter could land in the other occurrence of a repeated hour)
	let t = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
	const limit = after + 5 * 366 * 24 * 3600_000;
	const dayOk = (d: Date) => {
		const dom = c.dom.has(d.getDate());
		const dow = c.dow.has(d.getDay());
		return c.domAndDow ? dom || dow : dom && dow;
	};
	const step = (move: (d: Date) => void) => {
		const prev = t.getTime();
		const d = new Date(prev);
		move(d);
		t = d.getTime() > prev ? d : new Date(prev + 60_000);
	};
	while (t.getTime() <= limit) {
		if (!c.month.has(t.getMonth() + 1)) {
			step((d) => {
				d.setMonth(d.getMonth() + 1, 1);
				d.setHours(0, 0, 0, 0);
			});
			continue;
		}
		if (!dayOk(t)) {
			step((d) => {
				d.setDate(d.getDate() + 1);
				d.setHours(0, 0, 0, 0);
			});
			continue;
		}
		if (!c.hour.has(t.getHours())) {
			step((d) => d.setHours(d.getHours() + 1, 0, 0, 0));
			continue;
		}
		if (!c.minute.has(t.getMinutes())) {
			t = new Date(t.getTime() + 60_000);
			continue;
		}
		return t.getTime() > after ? t.getTime() : null;
	}
	return null;
}

export type When = { every: number } | { cron: Cron };

const UNIT: Record<string, number> = { m: 60_000, h: 3600_000, d: 86_400_000 };

/** `every 30m` (1m at least), `daily 09:00`, `weekdays 09:00`, `cron <five fields>`. */
export function parseWhen(text: string): When {
	const s = text.trim();
	let m = /^every\s+(\d+)\s*([mhd])$/i.exec(s);
	if (m) {
		const ms = Number(m[1]) * UNIT[m[2]!.toLowerCase()]!;
		if (ms < 60_000) throw new Error("every: one minute at least");
		return { every: ms };
	}
	m = /^(daily|weekdays)\s+(\d{1,2}):(\d{2})$/i.exec(s);
	if (m) {
		const h = Number(m[2]);
		const mi = Number(m[3]);
		if (h > 23 || mi > 59) throw new Error(`${m[1]}: a time of day, HH:MM`);
		return { cron: parseCron(`${mi} ${h} * * ${m[1]!.toLowerCase() === "daily" ? "*" : "1-5"}`) };
	}
	m = /^cron\s+(.+)$/i.exec(s);
	if (m) return { cron: parseCron(m[1]!.replace(/^["']|["']$/g, "")) };
	throw new Error('when: "every 30m", "daily 09:00", "weekdays 09:00" or "cron <minute hour day month weekday>"');
}

/** The run after `after`. `every` counts from `from` (the schedule's start, or its last run). */
export function nextRun(when: When, after: number, from: number = after): number | null {
	if ("every" in when) {
		const n = Math.floor((after - from) / when.every) + 1;
		return from + Math.max(1, n) * when.every;
	}
	return nextCron(when.cron, after);
}

// ---- a run ----------------------------------------------------------------------------

/** A run's own session file name, as pi names one (`<time>_<uuid>`). */
export function runSlot(now: number = Date.now()): string {
	return `${new Date(now).toISOString().replace(/[:.]/g, "-")}_${randomUUID()}`;
}

/** The dispatch for one run: `{{run}}` filled in the session file and the command. */
export function runLaunch(template: DispatchArgs, slot: string): DispatchArgs {
	const file = template.sessionFile.split(RUN_SLOT).join(slot);
	// the session file's own argument only: a task that says {{run}} is left as written
	return { ...template, sessionFile: file, command: template.command.map((x) => (x === template.sessionFile ? file : x)) };
}

/** A template a schedule may keep: a pi job whose session file has the run slot. */
export function checkTemplate(t: unknown): asserts t is DispatchArgs {
	const a = t as DispatchArgs;
	if (!a || typeof a !== "object") throw new Error("launch: missing");
	if (a.kind === "shell") throw new Error("launch: a pi session (scheduled commands are not supported yet)");
	if (typeof a.sessionFile !== "string" || !a.sessionFile.includes(RUN_SLOT)) throw new Error(`launch: its sessionFile must hold ${RUN_SLOT}`);
	if (Array.isArray(a.command) && !a.command.includes(a.sessionFile)) throw new Error("launch: its command must name its sessionFile");
	if (!Array.isArray(a.command) || a.command.length === 0 || !a.command.every((x) => typeof x === "string")) throw new Error("launch: command");
	if (typeof a.cwd !== "string" || !a.cwd.startsWith("/")) throw new Error("launch: cwd");
}

// ---- what the hub and the CLI read and show ------------------------------------------

/**
 * `/schedule <name> <when> <task>`: when is `every 30m`, `daily 09:00`, `weekdays 09:00`,
 * `cron "<five fields>"` or `cron` and five fields.
 */
export function parseScheduleInput(text: string): { name: string; when: string; task: string } | { error: string } {
	const m = /^(\S+)\s+(every\s+\d+\s*[mhd]|(?:daily|weekdays)\s+\d{1,2}:\d{2}|cron\s+"[^"]+"|cron\s+'[^']+'|cron(?:\s+\S+){5})\s+([\s\S]+)$/i.exec(text.trim());
	if (!m) return { error: 'schedule: <name> <every 30m | daily 09:00 | weekdays 09:00 | cron "0 9 * * 1-5"> <task>' };
	const [, name, when, task] = m as unknown as [string, string, string, string];
	if (!SCHEDULE_NAME.test(name)) return { error: `not a schedule name: ${name} (letters, digits, _ . -)` };
	try {
		parseWhen(when);
	} catch (err) {
		return { error: (err as Error).message };
	}
	return { name, when: when.replace(/\s+/g, " "), task: task.trim() };
}

/** "in 3h 05m", "in 2d 4h", "now", for a time ahead. */
export function untilText(at: number, now: number = Date.now()): string {
	const ms = at - now;
	if (ms < 60_000) return ms <= 0 ? "now" : "in <1m";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `in ${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `in ${h}h ${String(m % 60).padStart(2, "0")}m`;
	return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "5m", "3h", "2d": how long ago, roughly. */
export function agoText(ms: number): string {
	const m = Math.max(0, Math.floor(ms / 60_000));
	if (m < 1) return "<1m";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
