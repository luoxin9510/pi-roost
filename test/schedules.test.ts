// M67: the Schedules module through its own interface: a fake jobs port, an in-memory store
// and a manual clock; no daemon, no waiting.
import { describe, expect, it } from "vitest";
import type { RoostEvent } from "../lib/events.ts";
import type { DispatchArgs } from "../lib/protocol.ts";
import { createSchedules, type Schedules, type SchedulesStore } from "../lib/schedules.ts";
import type { Schedule } from "../lib/schedule.ts";
import { manualClock } from "./support/clock.ts";

const H = 3600_000;
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);

const template = (over: Partial<DispatchArgs> = {}): DispatchArgs =>
	({ cwd: "/work", sessionFile: "/work/{{run}}.jsonl", command: ["/bin/sh", "-c", "x", "/work/{{run}}.jsonl"], name: "x", origin: "dispatch", ...over }) as DispatchArgs;

type Log = { level: string; msg: string; extra?: Record<string, unknown> };

function setup(opts: { initial?: unknown; tickMs?: number; startAt?: number; store?: SchedulesStore } = {}) {
	const { clock, advance, pending } = manualClock(opts.startAt ?? T0);
	let saved: unknown = opts.initial;
	const store: SchedulesStore = opts.store ?? { read: () => (saved === undefined ? undefined : JSON.parse(JSON.stringify(saved))), write: (v) => void (saved = JSON.parse(JSON.stringify(v))) };
	const events: Omit<RoostEvent, "seq" | "at">[] = [];
	const logs: Log[] = [];
	const dispatched: { launch: DispatchArgs; extra: { schedule: string } }[] = [];
	const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown>[] }[] = [];
	const running = new Set<string>();
	const state = { shuttingDown: false, failWith: null as Error | null, gate: null as Promise<void> | null, n: 0, tickThrows: false };
	const make = (): Schedules =>
		createSchedules({
			jobs: {
				async dispatch(launch, extra) {
					dispatched.push({ launch, extra });
					if (state.gate) await state.gate;
					if (state.failWith) throw state.failWith;
					const id = `job${++state.n}`;
					return { id, name: launch.name ?? "?" };
				},
				stillRunning: (id) => !!id && running.has(id),
				shuttingDown: () => {
					if (state.tickThrows) {
						state.tickThrows = false;
						throw new Error("boom");
					}
					return state.shuttingDown;
				},
			},
			store,
			record: (e) => void events.push(e),
			log: (level, msg, extra) => void logs.push({ level, msg, extra }),
			span: (name, attrs, fn) => {
				const rec = { name, attrs, set: [] as Record<string, unknown>[] };
				spans.push(rec);
				return fn({ setAttributes: (a) => void rec.set.push(a) });
			},
			isDir: (p) => p === "/work",
			clock,
			tickMs: opts.tickMs ?? 15_000,
		});
	return { clock, advance, pending, make, events, logs, dispatched, spans, running, state, saved: () => saved as Schedule[] };
}

const saved = (over: Record<string, unknown> = {}) => ({
	name: "nightly",
	when: "every 1h",
	launch: template(),
	paused: false,
	catchUp: true,
	createdAt: T0 - 2 * H,
	anchor: T0 - 2 * H,
	nextAt: T0 - 60_000,
	...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Schedules: ops", () => {
	it("adds a schedule: the row, the file, the log; lists sorted", async () => {
		const t = setup();
		const s = t.make();
		const row = await s.op("schedule-add", { name: "hourly", when: " every 1h ", launch: template(), task: "check the build" });
		expect(row).toEqual({ name: "hourly", when: "every 1h", task: "check the build", agent: "pi", cwd: "/work", model: null, paused: false, catchUp: true, nextAt: T0 + H, lastRunAt: null, lastJob: null, lastSkip: null });
		expect(t.saved()).toHaveLength(1);
		expect(t.saved()[0]).toMatchObject({ name: "hourly", createdAt: T0, anchor: T0, nextAt: T0 + H, paused: false, catchUp: true, task: "check the build" });
		expect(t.logs).toEqual([{ level: "info", msg: "schedule added", extra: { name: "hourly", when: "every 1h", nextAt: T0 + H } }]);
		await s.op("schedule-add", { name: "alpha", when: "every 2h", launch: template(), catchUp: false });
		const list = (await s.op("schedules", {})) as { schedules: { name: string; catchUp: boolean }[] };
		expect(list.schedules.map((x) => [x.name, x.catchUp])).toEqual([
			["alpha", false],
			["hourly", true],
		]);
	});

	it("refuses bad adds with their codes and words", async () => {
		const t = setup();
		const s = t.make();
		const add = (a: Record<string, unknown>) => s.op("schedule-add", { name: "ok", when: "every 1h", launch: template(), ...a });
		await add({});
		await expect(add({})).rejects.toMatchObject({ code: "exists", message: "a schedule named ok exists (remove it first)" });
		await expect(add({ name: "../x" })).rejects.toMatchObject({ code: "bad_request", message: "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit" });
		await expect(add({ name: 5 })).rejects.toMatchObject({ code: "bad_request" });
		await expect(add({ name: "b", when: "hourly" })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("every 30m") });
		await expect(add({ name: "c", launch: template({ sessionFile: "/work/x.jsonl" }) })).rejects.toMatchObject({ code: "bad_request", message: "launch: its sessionFile must hold {{run}}" });
		await expect(add({ name: "d", launch: undefined })).rejects.toMatchObject({ code: "bad_request", message: "launch: missing" });
		await expect(add({ name: "e", launch: template({ cwd: "/nowhere" }) })).rejects.toMatchObject({ code: "bad_request", message: "cwd is not a directory: /nowhere" });
		const wt = { ...template({ kind: "shell", sessionFile: "" }), worktree: { path: "/x", branch: "b", repo: "/r", base: "main" } };
		await expect(add({ name: "f", launch: wt })).rejects.toMatchObject({ code: "bad_request", message: "launch: a scheduled run has no worktree" });
		expect(t.saved()).toHaveLength(1);
	});

	it("limits to 100 schedules", async () => {
		const t = setup({ initial: Array.from({ length: 100 }, (_, i) => saved({ name: `s${i}`, nextAt: T0 + H })) });
		const s = t.make();
		await expect(s.op("schedule-add", { name: "more", when: "every 1h", launch: template() })).rejects.toMatchObject({ code: "limit", message: "100 schedules at most" });
	});

	it("keeps the task to 2000 characters; a command's agent is shell, a profile's its name", async () => {
		const t = setup();
		const s = t.make();
		const row = (await s.op("schedule-add", { name: "long", when: "daily 03:00", launch: template({ kind: "shell", sessionFile: "", profile: "fake" }), task: "x".repeat(3000) })) as { task: string; agent: string };
		expect(row.task).toHaveLength(2000);
		expect(row.agent).toBe("fake");
		const cmd = (await s.op("schedule-add", { name: "cmd", when: "daily 03:00", launch: template({ kind: "shell", sessionFile: "" }) })) as { agent: string; task: null };
		expect(cmd).toMatchObject({ agent: "shell", task: null });
	});

	it("pauses (no next run) and resumes (counted from now); removes; unknown names are not_found", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "hourly", when: "every 1h", launch: template() });
		expect(await s.op("schedule-pause", { name: "hourly", paused: true })).toMatchObject({ paused: true, nextAt: null });
		t.advance(30 * 60_000);
		expect(await s.op("schedule-pause", { name: "hourly", paused: false })).toMatchObject({ paused: false, nextAt: T0 + 30 * 60_000 + H });
		expect(t.saved()[0]).toMatchObject({ anchor: T0 + 30 * 60_000, paused: false });
		// anything but true resumes
		expect(await s.op("schedule-pause", { name: "hourly" })).toMatchObject({ paused: false });
		expect(await s.op("schedule-rm", { name: "hourly" })).toEqual({ name: "hourly" });
		expect(t.saved()).toEqual([]);
		expect(t.logs.at(-1)).toEqual({ level: "info", msg: "schedule removed", extra: { name: "hourly" } });
		for (const op of ["schedule-rm", "schedule-pause", "schedule-run"] as const) await expect(s.op(op, { name: "hourly" })).rejects.toMatchObject({ code: "not_found", message: "no schedule named hourly" });
		await expect(s.op("schedule-rm", {})).rejects.toMatchObject({ code: "not_found", message: "no schedule named undefined" });
	});

	it("refuses an unknown op", async () => {
		const s = setup().make();
		await expect(s.op("nope" as never, {})).rejects.toMatchObject({ code: "bad_request", message: "unknown op: nope" });
	});

	it("a store that cannot write is logged, not thrown", async () => {
		const t = setup({ store: { read: () => undefined, write: () => { throw new Error("disk full"); } } });
		const s = t.make();
		await s.op("schedule-add", { name: "a", when: "every 1h", launch: template() });
		expect(t.logs.find((l) => l.level === "error")).toEqual({ level: "error", msg: "schedules not saved", extra: { error: "Error: disk full" } });
	});
});

describe("Schedules: runs", () => {
	it("run now: a session named after the schedule, the event, the log, the span; nextAt untouched", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "check", when: "daily 03:00", launch: template() });
		const before = (await s.op("schedules", {})) as { schedules: { nextAt: number }[] };
		const r = (await s.op("schedule-run", { name: "check" })) as { name: string; id: string };
		expect(r).toEqual({ name: "check", id: "job1" });
		expect(t.dispatched).toHaveLength(1);
		const d = t.dispatched[0]!;
		expect(d.extra).toEqual({ schedule: "check" });
		expect(d.launch).toMatchObject({ name: "check", requestId: undefined, cwd: "/work" });
		expect(d.launch.sessionFile).toMatch(/^\/work\/2026-01-05T10-00-00-000Z_[0-9a-f-]{36}\.jsonl$/);
		expect(d.launch.command[3]).toBe(d.launch.sessionFile);
		expect(t.events).toEqual([{ kind: "schedule", id: "job1", name: "check", who: "check", why: "now" }]);
		expect(t.logs.at(-1)).toEqual({ level: "info", msg: "schedule ran", extra: { schedule: "check", id: "job1", why: "now" } });
		expect(t.spans).toEqual([{ name: "roost.schedule.run", attrs: { schedule: "check", why: "now" }, set: [] }]);
		const after = ((await s.op("schedules", {})) as { schedules: { nextAt: number; lastRunAt: number; lastJob: string; lastSkip: unknown }[] }).schedules[0]!;
		expect(after).toMatchObject({ nextAt: before.schedules[0]!.nextAt, lastRunAt: T0, lastJob: "job1", lastSkip: null });
		expect(t.saved()[0]).toMatchObject({ lastRunAt: T0, lastJob: "job1" });
	});

	it("run now while the previous run is going: busy, said in lastSkip, saved, span marked skipped", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "check", when: "daily 03:00", launch: template() });
		await s.op("schedule-run", { name: "check" });
		t.running.add("job1");
		t.advance(5000);
		await expect(s.op("schedule-run", { name: "check" })).rejects.toMatchObject({ code: "busy", message: "the previous run (job1) is still going" });
		const row = ((await s.op("schedules", {})) as { schedules: { lastSkip: unknown; lastJob: string }[] }).schedules[0]!;
		expect(row.lastSkip).toEqual({ at: T0 + 5000, why: "the previous run (job1) is still going" });
		expect(row.lastJob).toBe("job1");
		expect(t.saved()[0]!.lastSkip).toEqual({ at: T0 + 5000, why: "the previous run (job1) is still going" });
		expect(t.spans[1]!.set).toEqual([{ skipped: true }]);
		expect(t.dispatched).toHaveLength(1);
		// it finished: the next one starts and the skip is cleared
		t.running.clear();
		await s.op("schedule-run", { name: "check" });
		expect(t.dispatched).toHaveLength(2);
		expect(t.saved()[0]!.lastSkip).toBeUndefined();
		expect(t.saved()[0]!.lastJob).toBe("job2");
	});

	it("two runs asked at once start one; the other is busy", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "twice", when: "daily 03:00", launch: template() });
		let open!: () => void;
		t.state.gate = new Promise<void>((r) => (open = r));
		const both = Promise.allSettled([s.op("schedule-run", { name: "twice" }), s.op("schedule-run", { name: "twice" })]);
		await flush();
		open();
		const res = await both;
		expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(res.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "busy", message: "a run of it is starting" } });
		expect(t.dispatched).toHaveLength(1);
		expect(t.events).toHaveLength(1);
	});

	it("a dispatch that fails is said in lastSkip and logged; the error goes on", async () => {
		const t = setup();
		const s = t.make();
		await s.op("schedule-add", { name: "bad", when: "daily 03:00", launch: template() });
		t.state.failWith = new Error("cwd is gone");
		await expect(s.op("schedule-run", { name: "bad" })).rejects.toThrow("cwd is gone");
		expect(t.saved()[0]!.lastSkip).toEqual({ at: T0, why: "cwd is gone" });
		expect(t.logs.at(-1)).toEqual({ level: "warn", msg: "schedule run failed", extra: { schedule: "bad", error: "Error: cwd is gone" } });
		expect(t.events).toEqual([]);
		// the next try is not held by the failure
		t.state.failWith = null;
		await expect(s.op("schedule-run", { name: "bad" })).resolves.toMatchObject({ id: "job1" });
	});

	it("starts a run when its slot comes due on the tick, then keeps its rhythm", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 40_000, catchUp: false })], tickMs: 15_000 });
		const s = t.make();
		s.start();
		t.advance(30_000);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		t.advance(30_000); // ticks at 45 s: due since 40 s
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.dispatched[0]!.extra).toEqual({ schedule: "nightly" });
		expect(t.events).toEqual([{ kind: "schedule", id: "job1", name: "nightly", who: "nightly", why: "due" }]);
		// the next whole hour from its anchor (T0 - 2h), counted from the tick's time
		const row = t.saved()[0]!;
		expect(row.lastRunAt).toBe(T0 + 45_000);
		expect(row.lastJob).toBe("job1");
		expect(row.nextAt).toBe(T0 + H);
		t.advance(H - 75_000); // T0 + 1h - 15 s
		await flush();
		expect(t.dispatched).toHaveLength(1);
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(2);
		expect(t.saved()[0]!.nextAt).toBe(T0 + 2 * H);
	});

	it("the next slot is set at least a second ahead of the run (a slot due in under a second is not taken twice)", async () => {
		// every minute from an anchor that puts the next slot 500 ms after the tick
		const t = setup({ initial: [saved({ when: "every 1m", anchor: T0 + 15_000 + 500 - 60_000, nextAt: T0 + 10_000, catchUp: false })], tickMs: 15_000 });
		const s = t.make();
		s.start();
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.saved()[0]!.nextAt).toBe(T0 + 15_000 + 1000);
	});

	it("a tick that throws is logged and the next tick still comes", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 20_000, catchUp: false })], tickMs: 15_000 });
		const s = t.make();
		s.start();
		t.state.tickThrows = true;
		t.advance(15_000);
		await flush();
		expect(t.logs).toContainEqual({ level: "error", msg: "schedule tick failed", extra: { error: "Error: boom" } });
		expect(t.pending()).toBe(1);
		t.advance(15_000); // ticks at 30 s: due since 20 s
		await flush();
		expect(t.dispatched).toHaveLength(1);
	});

	it("a due schedule whose previous run is still going is skipped: recorded in lastSkip, no event, next slot kept", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, catchUp: false, lastJob: "old" })] });
		t.running.add("old");
		const s = t.make();
		s.start();
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		expect(t.events).toEqual([]);
		expect(t.saved()[0]).toMatchObject({ lastSkip: { at: T0 + 15_000, why: "the previous run (old) is still going" }, nextAt: T0 + H, lastJob: "old" });
		expect(t.spans[0]).toMatchObject({ attrs: { schedule: "nightly", why: "due" }, set: [{ skipped: true }] });
		// it ends: the next slot runs
		t.running.clear();
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(1);
		expect(t.saved()[0]!.lastSkip).toBeUndefined();
	});

	it("a paused schedule does not run; a resumed one runs on its new rhythm", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, catchUp: false })] });
		const s = t.make();
		s.start();
		await s.op("schedule-pause", { name: "nightly", paused: true });
		t.advance(2 * H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		await s.op("schedule-pause", { name: "nightly", paused: false });
		t.advance(H - 1);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
	});

	it("a removed schedule does not run", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, catchUp: false })] });
		const s = t.make();
		s.start();
		await s.op("schedule-rm", { name: "nightly" });
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
	});

	it("a tick while the daemon is going down starts nothing", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, catchUp: false })] });
		const s = t.make();
		s.start();
		t.state.shuttingDown = true;
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
	});

	it("stop() clears the tick: nothing runs after it, no timer waits", async () => {
		const t = setup({ initial: [saved({ nextAt: T0 + 10_000, catchUp: false })] });
		const s = t.make();
		expect(t.pending()).toBe(0);
		s.start();
		expect(t.pending()).toBe(1);
		t.advance(5000);
		s.stop();
		expect(t.pending()).toBe(0);
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
		// start twice arms one
		s.start();
		s.start();
		expect(t.pending()).toBe(1);
		s.stop();
	});
});

describe("Schedules: start and the file", () => {
	it("catch-up: a run missed while off runs once at start (catchUp), or is moved to the next slot", async () => {
		const t = setup({ initial: [saved({ name: "missed", nextAt: T0 - 3 * H }), saved({ name: "skipped", catchUp: false }), saved({ name: "ahead", nextAt: T0 + H })] });
		const s = t.make();
		s.start();
		await flush();
		expect(t.dispatched.map((d) => d.extra.schedule)).toEqual(["missed"]);
		expect(t.events).toEqual([{ kind: "schedule", id: "job1", name: "missed", who: "missed", why: "catch-up" }]);
		const rows = Object.fromEntries(t.saved().map((x) => [x.name, x]));
		expect(rows.missed).toMatchObject({ lastRunAt: T0, lastJob: "job1", nextAt: T0 + H });
		expect(rows.skipped).toMatchObject({ nextAt: T0 + H });
		expect(rows.skipped!.lastRunAt).toBeUndefined();
		expect(rows.ahead!.nextAt).toBe(T0 + H);
		// not twice on the first tick
		t.advance(15_000);
		await flush();
		expect(t.dispatched).toHaveLength(1);
	});

	it("catch-up leaves a paused schedule alone", async () => {
		const t = setup({ initial: [saved({ paused: true, nextAt: null })] });
		const s = t.make();
		s.start();
		t.advance(H);
		await flush();
		expect(t.dispatched).toHaveLength(0);
	});

	it("a bad entry in the file is dropped with a warning; the good ones stay", async () => {
		const t = setup({ initial: [saved({ name: "good" }), saved({ name: "badwhen", when: "hourly" }), saved({ name: "badlaunch", launch: { cwd: "/work" } }), saved({ name: "../evil" }), null, "junk"] });
		const s = t.make();
		const list = (await s.op("schedules", {})) as { schedules: { name: string }[] };
		expect(list.schedules.map((x) => x.name)).toEqual(["good"]);
		const warns = t.logs.filter((l) => l.level === "warn");
		expect(warns.map((w) => [w.msg, w.extra?.name])).toEqual([
			["schedule dropped", "badwhen"],
			["schedule dropped", "badlaunch"],
			["schedule dropped", undefined],
		]);
	});

	it("a file that is not a list is ignored", async () => {
		const s = setup({ initial: { schedules: [] } }).make();
		expect(await s.op("schedules", {})).toEqual({ schedules: [] });
	});

	it("an entry edited by hand is made good: missing times, flags", async () => {
		const t = setup({ initial: [{ name: "hand", when: "every 1h", launch: template() }, saved({ name: "rest", paused: true, nextAt: 5 })] });
		const s = t.make();
		const rows = ((await s.op("schedules", {})) as { schedules: { name: string; paused: boolean; catchUp: boolean; nextAt: number | null }[] }).schedules;
		expect(rows.find((r) => r.name === "hand")).toMatchObject({ paused: false, catchUp: true, nextAt: T0 + H });
		expect(rows.find((r) => r.name === "rest")).toMatchObject({ paused: true, nextAt: null });
	});

	it("a restart (a new module over the same store) keeps the schedules, their pause and their last run", async () => {
		const t = setup();
		const first = t.make();
		await first.op("schedule-add", { name: "kept", when: "weekdays 09:00", launch: template(), catchUp: false });
		await first.op("schedule-add", { name: "resting", when: "every 1h", launch: template() });
		await first.op("schedule-pause", { name: "resting", paused: true });
		await first.op("schedule-run", { name: "kept" });
		first.stop();
		const second = t.make();
		const rows = ((await second.op("schedules", {})) as { schedules: { name: string; paused: boolean; catchUp: boolean; lastJob: string | null }[] }).schedules;
		expect(rows.map((r) => [r.name, r.paused, r.catchUp, r.lastJob])).toEqual([
			["kept", false, false, "job1"],
			["resting", true, true, null],
		]);
		second.start();
		t.advance(2 * H);
		await flush();
		expect(t.dispatched.filter((d) => d.extra.schedule === "resting")).toHaveLength(0);
	});
});
