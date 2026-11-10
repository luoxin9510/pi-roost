// M67: the daemon's scheduled tasks as a module: the schedules and their file, the tick that
// starts a run when its slot comes due, and the ops. Ports are narrow; time is the Clock's.
import { type Clock, systemClock, type Timer } from "./clock.ts";
import { OpError } from "./op.ts";
import type { RoostEvent } from "./events.ts";
import type { DispatchArgs, ScheduleRow } from "./protocol.ts";
import { checkTemplate, nextRun, parseWhen, runLaunch, runSlot, type Schedule, SCHEDULE_NAME, templateAgent } from "./schedule.ts";

/** The jobs: sessions and commands the daemon runs. */
export interface SchedulesJobsPort {
	/** Starts a run (its record carries the schedule's name). */
	dispatch(launch: DispatchArgs, extra: { schedule: string }): Promise<{ id: string; name: string }>;
	/** Whether a run's job is still working (or starting, or about to restart); a finished one with its worker up, idle, is not. */
	stillRunning(id: string | undefined): boolean;
	/** The daemon is going down: a tick starts nothing. */
	shuttingDown(): boolean;
}

/** The file the schedules live in (the daemon's writes atomically under the roost's home). */
export interface SchedulesStore {
	read(): unknown;
	write(v: unknown): void;
}

export interface SchedulesSpan {
	setAttributes(a: Record<string, string | number | boolean | null>): void;
}

export interface SchedulesDeps {
	jobs: SchedulesJobsPort;
	store: SchedulesStore;
	record(e: Omit<RoostEvent, "seq" | "at">): void;
	log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
	/** Wraps a run in a telemetry span. */
	span<T>(name: string, attrs: Record<string, string | number | boolean | null>, fn: (span: SchedulesSpan) => Promise<T>): Promise<T>;
	isDir(path: string): boolean;
	clock?: Clock;
	/** How often the tick looks (default 15 s). */
	tickMs?: number;
}

export type ScheduleOp = "schedules" | "schedule-add" | "schedule-rm" | "schedule-pause" | "schedule-run";
export const SCHEDULE_OPS: readonly ScheduleOp[] = ["schedules", "schedule-add", "schedule-rm", "schedule-pause", "schedule-run"];

export interface Schedules {
	/** An op on the schedules (args as the socket brings them). */
	op(name: ScheduleOp, args: any): Promise<unknown>;
	/** Runs that fell due while the service was off (one now, or the next), then the tick. */
	start(): void;
	/** Clears the tick. */
	stop(): void;
}

export function createSchedules(deps: SchedulesDeps): Schedules {
	const { jobs, store, record, log } = deps;
	const clock = deps.clock ?? systemClock;
	const tickMs = deps.tickMs ?? 15_000;
	const schedules = new Map<string, Schedule>();
	/** Schedules whose run is being started (two requests at once start one). */
	const startingRuns = new Set<string>();
	let ticker: Timer | null = null;

	function load(): void {
		const saved = store.read();
		if (!Array.isArray(saved)) return;
		for (const s of saved as Schedule[]) {
			try {
				if (!s || !SCHEDULE_NAME.test(s.name)) continue;
				const when = parseWhen(s.when);
				checkTemplate(s.launch);
				// a file edited by hand: what is missing or not a number is made good
				const now = clock.now();
				if (!Number.isFinite(s.createdAt)) s.createdAt = now;
				if (!Number.isFinite(s.anchor)) s.anchor = s.createdAt;
				s.paused = s.paused === true;
				s.catchUp = s.catchUp !== false;
				if (s.paused) s.nextAt = null;
				else if (!Number.isFinite(s.nextAt)) s.nextAt = nextRun(when, now, s.anchor);
				schedules.set(s.name, s);
			} catch (err) {
				log("warn", "schedule dropped", { name: s?.name, error: String(err) });
			}
		}
	}

	function save(): void {
		try {
			store.write([...schedules.values()]);
		} catch (err) {
			log("error", "schedules not saved", { error: String(err) });
		}
	}

	function row(s: Schedule): ScheduleRow {
		return {
			name: s.name,
			when: s.when,
			task: s.task ?? null,
			agent: templateAgent(s.launch),
			cwd: s.launch.cwd,
			model: s.launch.model ?? null,
			paused: s.paused,
			catchUp: s.catchUp,
			nextAt: s.nextAt,
			lastRunAt: s.lastRunAt ?? null,
			lastJob: s.lastJob ?? null,
			lastSkip: s.lastSkip ?? null,
		};
	}

	function get(name: unknown): Schedule {
		const s = typeof name === "string" ? schedules.get(name) : undefined;
		if (!s) throw new OpError("not_found", `no schedule named ${String(name)}`);
		return s;
	}

	/**
	 * One run of a schedule: a session like any other, named after it. A due run whose
	 * previous one still runs is skipped (said in lastSkip), never stacked.
	 */
	async function run(s: Schedule, now: number, why: "due" | "catch-up" | "now"): Promise<string> {
		return deps.span("roost.schedule.run", { schedule: s.name, why }, async (span) => {
			// the next one first: an await below must not let a tick start this one twice
			// (and never one not ahead: it would run again on the next tick)
			if (why !== "now") {
				const next = nextRun(parseWhen(s.when), now, s.anchor);
				s.nextAt = next === null ? null : Math.max(next, now + 1000);
			}
			if (startingRuns.has(s.name)) throw new OpError("busy", "a run of it is starting");
			if (jobs.stillRunning(s.lastJob)) {
				s.lastSkip = { at: now, why: `the previous run (${s.lastJob}) is still going` };
				save();
				span.setAttributes({ skipped: true });
				throw new OpError("busy", s.lastSkip.why);
			}
			startingRuns.add(s.name);
			try {
				const r = await jobs.dispatch({ ...runLaunch(s.launch, runSlot(now)), name: s.name, requestId: undefined }, { schedule: s.name });
				s.lastRunAt = now;
				s.lastJob = r.id;
				s.lastSkip = undefined;
				log("info", "schedule ran", { schedule: s.name, id: r.id, why });
				record({ kind: "schedule", id: r.id, name: r.name, who: s.name, why });
				return r.id;
			} catch (err) {
				s.lastSkip = { at: now, why: (err as Error).message };
				log("warn", "schedule run failed", { schedule: s.name, error: String(err) });
				throw err;
			} finally {
				startingRuns.delete(s.name);
				save();
			}
		});
	}

	function tick(now = clock.now()): void {
		if (jobs.shuttingDown()) return;
		for (const s of schedules.values()) {
			if (s.paused || s.nextAt === null || now < s.nextAt) continue;
			void run(s, now, "due").catch(() => {});
		}
	}

	/** At start: runs that fell due while the service was off: one now (catchUp), or the next. */
	function catchUp(now = clock.now()): void {
		for (const s of schedules.values()) {
			if (s.paused || s.nextAt === null || s.nextAt > now) continue;
			if (s.catchUp) void run(s, now, "catch-up").catch(() => {});
			else {
				s.nextAt = nextRun(parseWhen(s.when), now, s.anchor);
				save();
			}
		}
	}

	function arm(): void {
		// a chain of one-shot timers (a Clock has no interval): the next is armed whatever this one did,
		// as setInterval went on after a tick that threw
		ticker = clock.timer(() => {
			try {
				tick();
			} catch (err) {
				log("error", "schedule tick failed", { error: String(err) });
			} finally {
				if (ticker) arm();
			}
		}, tickMs);
	}

	async function op(name: ScheduleOp, args: any): Promise<unknown> {
		const now = clock.now();
		switch (name) {
			case "schedules":
				return { schedules: [...schedules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(row) };
			case "schedule-add": {
				const sname = args?.name;
				if (typeof sname !== "string" || !SCHEDULE_NAME.test(sname)) throw new OpError("bad_request", "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit");
				if (schedules.has(sname)) throw new OpError("exists", `a schedule named ${sname} exists (remove it first)`);
				if (schedules.size >= 100) throw new OpError("limit", "100 schedules at most");
				let when: ReturnType<typeof parseWhen>;
				try {
					when = parseWhen(String(args?.when ?? ""));
					checkTemplate(args?.launch);
				} catch (err) {
					throw new OpError("bad_request", (err as Error).message);
				}
				if (!deps.isDir(args.launch.cwd)) throw new OpError("bad_request", `cwd is not a directory: ${args.launch.cwd}`);
				const s: Schedule = {
					name: sname,
					when: String(args.when).trim(),
					launch: args.launch,
					...(typeof args.task === "string" ? { task: args.task.slice(0, 2000) } : {}),
					paused: false,
					catchUp: args.catchUp !== false,
					createdAt: now,
					anchor: now,
					nextAt: nextRun(when, now, now),
				};
				schedules.set(sname, s);
				save();
				log("info", "schedule added", { name: sname, when: s.when, nextAt: s.nextAt });
				return row(s);
			}
			case "schedule-rm": {
				const s = get(args?.name);
				schedules.delete(s.name);
				save();
				log("info", "schedule removed", { name: s.name });
				return { name: s.name };
			}
			case "schedule-pause": {
				const s = get(args?.name);
				s.paused = args?.paused === true;
				// resumed: counted from now (an "every" does not fire at once for the time it was paused)
				if (!s.paused) s.anchor = now;
				s.nextAt = s.paused ? null : nextRun(parseWhen(s.when), now, s.anchor);
				save();
				return row(s);
			}
			case "schedule-run": {
				const s = get(args?.name);
				return { name: s.name, id: await run(s, now, "now") };
			}
		}
		throw new OpError("bad_request", `unknown op: ${String(name)}`);
	}

	load();
	return {
		op,
		start() {
			catchUp();
			if (!ticker) arm();
		},
		stop() {
			const t = ticker;
			ticker = null;
			t?.clear();
		},
	};
}
