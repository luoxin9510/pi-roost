// M69/M70: the Concierge module through its own interface: its state, wakes, heartbeat, ops and
// standing orders in process. Fake ports, in-memory stores, a manual clock (no real waits).
import { describe, expect, it } from "vitest";
import { CONCIERGE_DEFAULTS, ORDER_MAX, ORDER_TEXT_MAX, type ConciergeConfig, undoText } from "../lib/concierge.ts";
import { type Concierge, createConcierge, type ConciergePeer } from "../lib/concierge-module.ts";
import { clipText, type RoostEvent } from "../lib/events.ts";
import type { DispatchArgs, Event, JobRow } from "../lib/protocol.ts";
import { OpError } from "../lib/op.ts";
import { localMidnight } from "../lib/usage.ts";
import { manualClock } from "./support/clock.ts";

type Conn = { peer?: ConciergePeer };
const hub: Conn = {};
const cc: Conn = { peer: { kind: "job", id: "j1" } };
const other: Conn = { peer: { kind: "job", id: "j9" } };
const T0 = 1_000_000;
const flush = () => new Promise((r) => setTimeout(r, 0));
const LAUNCH = { kind: "pi", cwd: "/x", command: ["pi"] } as DispatchArgs;

type Ev = Omit<RoostEvent, "seq" | "at">;
interface Opts {
	cfg?: Partial<ConciergeConfig>;
	coalesceMs?: number;
	retryMs?: number;
	tickMs?: number;
	heartbeatMs?: number;
	/** A restart: the files, the jobs and the feed of an earlier setup. */
	from?: { jobs: Map<string, { live: boolean }>; feed: RoostEvent[]; saved(): unknown; savedOrders(): unknown };
	saved?: unknown;
	savedOrders?: unknown;
}

function setup(o: Opts = {}) {
	const { clock, advance, pending } = manualClock(T0);
	const jobs = new Map<string, { live: boolean }>(o.from ? [...o.from.jobs].map(([k, v]) => [k, { ...v }]) : []);
	const rows = new Map<string, JobRow>();
	const feed: RoostEvent[] = o.from ? [...o.from.feed] : [];
	const delivered: string[] = [];
	const pushed: Event[] = [];
	const recorded: Ev[] = [];
	const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
	const dispatches: { launch: DispatchArgs; extra?: unknown }[] = [];
	const respawns: string[] = [];
	const terminated: string[] = [];
	const replies: { args: { id: string; text: string; mode?: string }; by?: unknown }[] = [];
	const hubCalls: { what: string; id: string }[] = [];
	const pushedJobs: string[] = [];
	const launches = new Map<string, unknown>();
	const used = new Set<string>();
	const paths = new Set<string>(["/work"]);
	const states = new Map<string, string>();
	const ctl = {
		cfg: { ...CONCIERGE_DEFAULTS, ...o.cfg } as ConciergeConfig,
		shutting: false,
		failDeliver: 0,
		result: { outcome: "delivered", reached: true } as { outcome: string; reached: boolean },
		gate: null as Promise<void> | null,
		replyResult: { delivered: true, saved: false } as { delivered: boolean; saved: boolean; error?: string },
		replyFails: false,
		respawnFails: false,
		asHubFails: false,
		configThrows: false,
		storeThrows: false,
		ordersThrow: false,
		saves: 0,
		orderSaves: 0,
		board: [] as never[],
	};
	let saved: unknown = o.from ? o.from.saved() : o.saved;
	let savedOrders: unknown = o.from ? o.from.savedOrders() : o.savedOrders;
	let n: number = o.from ? o.from.jobs.size : 0;
	const record = (e: Ev) => {
		recorded.push(e);
		feed.push({ ...e, seq: feed.length + 1, at: clock.now() } as RoostEvent);
	};
	const c: Concierge<Conn> = createConcierge<Conn>({
		sessions: {
			require: (conn) => {
				if (!conn.peer) throw new OpError("unauthorized", "not a peer");
				return conn.peer;
			},
			optional: (conn) => conn.peer,
			asHub: async (_conn, what, id) => {
				hubCalls.push({ what, id });
				if (ctl.asHubFails) throw new Error("asHub failed");
				return {};
			},
		},
		jobs: {
			exists: (id) => jobs.has(id),
			live: (id) => !!jobs.get(id)?.live,
			row: (id) => rows.get(id),
			list: () => [...rows.values()],
			stateOf: (id) => states.get(id),
			launchOf: (id) => launches.get(id) as never,
			sessionFileUsed: (f) => used.has(f),
			pathExists: (p) => paths.has(p),
			async dispatch(launch, extra) {
				dispatches.push({ launch, extra });
				const id: string = `j${++n}`;
				jobs.set(id, { live: true });
				return { id, name: launch.name ?? "x" };
			},
			respawn: async (id) => {
				respawns.push(id);
				if (ctl.respawnFails) throw new Error("respawn failed");
				jobs.get(id)!.live = true;
			},
			terminate: async (id) => {
				terminated.push(id);
				jobs.get(id)!.live = false;
			},
			reply: async (args, by) => {
				replies.push({ args, by });
				if (ctl.replyFails) throw new Error("reply failed");
				return ctl.replyResult;
			},
			async deliver(_id, text) {
				delivered.push(text);
				if (ctl.gate) await ctl.gate;
				if (ctl.failDeliver > 0) {
					ctl.failDeliver--;
					throw new Error("queue full");
				}
				return { ...ctl.result };
			},
			pushJob: (id) => void pushedJobs.push(id),
		},
		events: {
			since: ({ after }) => ({ events: feed.filter((e) => e.seq > after), cursor: feed.length }),
			cursor: () => feed.length,
		},
		store: {
			read: () => saved,
			write: (v) => {
				if (ctl.storeThrows) throw new Error("disk full");
				ctl.saves++;
				saved = JSON.parse(JSON.stringify(v));
			},
		},
		ordersStore: {
			read: () => savedOrders,
			write: (v) => {
				if (ctl.ordersThrow) throw new Error("disk full");
				ctl.orderSaves++;
				savedOrders = JSON.parse(JSON.stringify(v));
			},
		},
		record,
		push: (e) => void pushed.push(e),
		log: (level, msg, extra) => void logs.push({ level, msg, extra }),
		config: () => {
			if (ctl.configThrows) throw new Error("config broke");
			return ctl.cfg;
		},
		board: () => ctl.board,
		shuttingDown: () => ctl.shutting,
		clock,
		coalesceMs: o.coalesceMs ?? 5000,
		retryMs: o.retryMs ?? 60_000,
		tickMs: o.tickMs ?? 30_000,
		heartbeatMs: o.heartbeatMs,
	});
	const turnOn = () => c.op("concierge", hub, { action: "on", launch: LAUNCH });
	/** A session of the fleet. */
	const addRow = (id: string, name: string, over: Partial<JobRow> = {}) => {
		jobs.set(id, { live: true });
		const row = { id, name, state: "working", waitingFor: null, question: null, stateSince: T0, usage: null, model: null, ...over } as unknown as JobRow;
		rows.set(id, row);
		return row;
	};
	/** The next delivery waits until `release()`. */
	const hold = () => {
		let release!: () => void;
		ctl.gate = new Promise<void>((r) => (release = () => ((ctl.gate = null), r())));
		return release;
	};
	/** Something happened in the fleet (not the concierge's). */
	const happen = (text = "x", over: Partial<Ev> = {}) => record({ kind: "state", id: "w1", name: "worker", state: "done", text, ...over });
	/** Moves time by `ms` (in steps, letting a wake that started finish between them). */
	const go = async (ms: number, step = ms) => {
		for (let left = ms; left > 0; left -= step) {
			advance(Math.min(step, left));
			await flush();
		}
	};
	/** On, and the first wake (the fleet as it stands) done. */
	const up = async () => {
		await turnOn();
		await flush();
		delivered.length = 0;
	};
	const st = () => saved as Record<string, any>;
	const ord = () => savedOrders as { next: number; orders: any[] };
	return { c, advance, pending, delivered, pushed, record, recorded, turnOn, jobs, feed, rows, logs, dispatches, respawns, terminated, replies, hubCalls, pushedJobs, launches, used, paths, states, ctl, addRow, hold, happen, go, up, saved: () => saved, savedOrders: () => savedOrders, st, ord };
}

const statuses = (t: ReturnType<typeof setup>) => t.pushed.filter((e) => e.event === "concierge");
const err = (code: string, msg?: string | RegExp) => ({ code, ...(msg ? { message: msg } : {}) });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: OpError) => `${e.code}: ${e.message}`);

describe("on and off", () => {
	it("the first on dispatches a pi session named concierge in its role, keeps the state, wakes it at once with the fleet", async () => {
		const t = setup();
		expect(t.c.status()).toMatchObject({ on: false, id: null, live: false, state: null });
		t.happen("old news");
		const s = await t.turnOn();
		expect(s).toMatchObject({ on: true, id: "j1", live: true });
		expect(t.dispatches).toEqual([{ launch: { kind: "pi", cwd: "/x", command: ["pi"], name: "concierge", requestId: undefined }, extra: { role: "concierge" } }]);
		// the backlog is not its concern: the cursor is where the feed stands
		expect(t.st()).toMatchObject({ id: "j1", on: true, cursor: 1, onAt: T0, notice: null, answer: null });
		// at on, and after the first wake
		expect(statuses(t)).toHaveLength(2);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain('<roost-digest why="heartbeat">');
		expect(t.delivered[0]).toContain("Nothing happened since.");
		expect(t.delivered[0]).not.toContain("old news");
		expect(t.c.status()).toMatchObject({ lastWakeAt: T0, wakesLastHour: 1 });
		expect(t.st()).toMatchObject({ lastWakeAt: T0, wakes: [T0] });
	});

	it("on needs a pi launch for the first start: not a shell, not a profile, not nothing", async () => {
		const t = setup();
		const bad = "bad_request: the concierge is a pi session: the hub builds its launch";
		expect(await code(t.c.op("concierge", hub, { action: "on" }))).toBe(bad);
		expect(await code(t.c.op("concierge", hub, { action: "on", launch: "pi" }))).toBe(bad);
		expect(await code(t.c.op("concierge", hub, { action: "on", launch: { ...LAUNCH, kind: "shell" } }))).toBe(bad);
		expect(await code(t.c.op("concierge", hub, { action: "on", launch: { ...LAUNCH, profile: "aider" } }))).toBe(bad);
		expect(t.dispatches).toHaveLength(0);
		expect(t.c.status()).toMatchObject({ on: false, id: null });
		expect(t.saved()).toBeUndefined();
	});

	it("the first on forgets the last notice and answer; an on of an existing job keeps them", async () => {
		const t = setup({ saved: { id: "j1", on: false, notice: { kind: "need", text: "old", at: 1 }, answer: { text: "old answer", at: 2 }, wakes: [5] } });
		t.jobs.set("j1", { live: false });
		t.c.load();
		expect(t.c.status()).toMatchObject({ notice: { text: "old" }, answer: { text: "old answer" } });
		t.jobs.delete("j1");
		await t.turnOn();
		expect(t.c.status()).toMatchObject({ notice: null, answer: null, id: "j1" });
		expect(t.st().wakes).not.toContain(5);
		const t2 = setup();
		await t2.up();
		await t2.c.op("concierge-say", cc, { kind: "need", text: "n" });
		await t2.c.op("concierge-say", cc, { kind: "answer", text: "a" });
		await t2.c.op("concierge", hub, { action: "off" });
		await t2.c.op("concierge", hub, { action: "on" });
		expect(t2.c.status()).toMatchObject({ notice: { kind: "need", text: "n" }, answer: { text: "a" } });
	});

	it("an on of the job it has respawns it (no dispatch), moves the cursor to now, clears lastWakeAt, wakes at once", async () => {
		const t = setup();
		await t.up();
		t.addRow("a1", "alpha");
		t.happen("while on");
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.terminated).toEqual(["j1"]);
		t.happen("while off");
		await t.go(1000);
		const s = await t.c.op("concierge", hub, { action: "on" });
		expect(s).toMatchObject({ on: true, id: "j1", live: true, behind: 0, lastWakeAt: null });
		expect(t.dispatches).toHaveLength(1);
		expect(t.respawns).toEqual(["j1"]);
		expect(t.st()).toMatchObject({ on: true, cursor: 2, onAt: T0 + 1000 });
		await flush();
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain('why="heartbeat"');
		expect(t.delivered[0]).not.toContain("while off");
		expect(t.delivered[0]).not.toContain("since your last wake");
		// the fleet as it stands, not what happened
		expect(t.delivered[0]).toContain("The fleet (1 session):");
		expect(t.delivered[0]).toContain("- a1  alpha  working");
	});

	it("an on of a job that is already running is as it is: no wake, no save, no respawn", async () => {
		const t = setup();
		await t.up();
		const saves = t.ctl.saves;
		const status = t.c.status();
		expect(await t.c.op("concierge", hub, { action: "on" })).toEqual(status);
		await flush();
		expect(t.ctl.saves).toBe(saves);
		expect(t.respawns).toEqual([]);
		expect(t.delivered).toHaveLength(0);
		expect(t.dispatches).toHaveLength(1);
	});

	it("an on of a job that ended (the flag still on) respawns it; a failed respawn is logged and it is on", async () => {
		const t = setup();
		await t.up();
		t.jobs.get("j1")!.live = false;
		t.ctl.respawnFails = true;
		expect(await t.c.op("concierge", hub, { action: "on" })).toMatchObject({ on: true, id: "j1" });
		expect(t.respawns).toEqual(["j1"]);
		expect(t.logs.filter((l) => l.msg === "concierge restart failed")).toEqual([{ level: "warn", msg: "concierge restart failed", extra: { error: "Error: respawn failed" } }]);
		expect(t.logs.some((l) => l.msg === "concierge on")).toBe(true);
	});

	it("an on of a job that is up but was switched off does not respawn it", async () => {
		const t = setup();
		await t.up();
		t.jobs.get("j1")!.live = true;
		await t.c.op("concierge", hub, { action: "off" });
		t.jobs.get("j1")!.live = true;
		await t.c.op("concierge", hub, { action: "on" });
		expect(t.respawns).toEqual([]);
	});

	it("an on whose job was removed starts a new one from the launch", async () => {
		const t = setup();
		await t.up();
		t.jobs.delete("j1");
		const s = await t.turnOn();
		expect(s).toMatchObject({ on: true, id: "j2" });
		expect(t.dispatches).toHaveLength(2);
	});

	it("two on at once share one start", async () => {
		const t = setup();
		const [a, b] = await Promise.all([t.turnOn(), t.turnOn()]);
		expect(t.dispatches).toHaveLength(1);
		expect(a).toEqual(b);
		await flush();
		expect(t.delivered).toHaveLength(1);
		// the slot is free again: a later on is a new call
		t.jobs.delete("j1");
		await t.turnOn();
		expect(t.dispatches).toHaveLength(2);
	});

	it("an on that fails frees the slot", async () => {
		const t = setup();
		expect(await code(t.c.op("concierge", hub, { action: "on" }))).toMatch(/^bad_request/);
		expect(await t.turnOn()).toMatchObject({ on: true });
	});

	it("off terminates only a live job; says so in the log and to the hubs", async () => {
		const t = setup();
		expect(await t.c.op("concierge", hub, { action: "off" })).toMatchObject({ on: false, id: null });
		expect(t.terminated).toEqual([]);
		await t.up();
		const pushes = statuses(t).length;
		expect(await t.c.op("concierge", hub, { action: "off" })).toMatchObject({ on: false, id: "j1", live: false });
		expect(t.terminated).toEqual(["j1"]);
		expect(t.st()).toMatchObject({ on: false, id: "j1" });
		expect(statuses(t)).toHaveLength(pushes + 1);
		expect(t.logs.at(-1)).toMatchObject({ level: "info", msg: "concierge off", extra: { id: "j1" } });
		// off again: the job is not live, nothing to terminate
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.terminated).toEqual(["j1"]);
	});

	it("off cancels a wake that was waiting and the one remembered", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		expect(t.pending()).toBe(1);
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.pending()).toBe(0);
		await t.go(60_000);
		expect(t.delivered).toHaveLength(0);
	});

	it("status says what it is: the job, the wakes, what is behind (its own left out), the cost, the policy", async () => {
		const t = setup({ cfg: { dailyBudgetUsd: 2, answer: "routine", act: true } });
		await t.up();
		t.addRow("j1", "concierge", {
			state: "working",
			model: "m/x",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 9, today: 0.5, day: localMidnight(T0), sub: false, models: {} },
		});
		t.happen("a");
		t.happen("mine", { id: "j1" });
		t.happen("by me", { whoId: "j1" });
		expect(t.c.status()).toEqual({
			on: true,
			id: "j1",
			state: "working",
			live: true,
			model: "m/x",
			wakesLastHour: 1,
			lastWakeAt: T0,
			behind: 1,
			costToday: 0.5,
			budget: 2,
			overBudget: false,
			notice: null,
			policy: { answer: "routine", act: true },
			orders: 0,
			answered: null,
			answer: null,
		});
		// the cost is today's: another day's is not
		t.rows.get("j1")!.usage!.day = localMidnight(T0) - 86_400_000;
		expect(t.c.status().costToday).toBe(0);
		// wakes older than an hour are not counted; behind is not counted while off
		await t.go(3600_000 + 1);
		expect(t.c.status().wakesLastHour).toBe(0);
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.c.status().behind).toBe(0);
	});

	it("an unknown action is refused with what it may be; status changes nothing", async () => {
		const t = setup();
		expect(await code(t.c.op("concierge", hub, { action: "nope" }))).toBe("bad_request: action must be on, off, status, answer, act or undo");
		expect(await code(t.c.op("concierge", hub, undefined))).toMatch(/^bad_request/);
		await t.c.op("concierge", hub, { action: "status" });
		expect(t.saved()).toBeUndefined();
		expect(t.pushed).toEqual([]);
		expect(await code(t.c.op("nope" as never, hub, {}))).toBe("bad_request: unknown op: nope");
	});

	it("starts again over the same files: the state, the cursor and the orders are kept; a removed job is off", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge-say", cc, { kind: "need", text: "n" });
		await t.c.op("concierge-order", hub, { action: "add", text: "keep me" });
		t.happen("later");
		await t.go(5000);
		const t2 = setup({ from: t });
		t2.c.load();
		expect(t2.c.status()).toMatchObject({ on: true, id: "j1", lastWakeAt: T0, orders: 1, notice: { kind: "need", text: "n" } });
		expect((await t2.c.op("concierge-order", hub, { action: "list" })) as any).toMatchObject({ orders: [{ id: 1, text: "keep me" }] });
		// its job went while the service was off
		t.jobs.delete("j1");
		const t3 = setup({ from: t });
		t3.c.load();
		expect(t3.c.status()).toMatchObject({ on: false, id: null, orders: 1 });
	});

	it("loads a state file defensively: bad pieces are dropped, the rest kept", () => {
		const t = setup({
			saved: {
				id: "j1",
				on: "yes",
				cursor: "7",
				onAt: 5,
				lastWakeAt: "x",
				wakes: [1, "x", 3],
				notice: { kind: "info" },
				answer: { text: "ok", at: 4 },
				policy: { answer: "sometimes", act: true },
				answered: [{ id: "a", text: "t", at: 1 }, { id: "b" }, ...Array.from({ length: 25 }, (_, i) => ({ id: `k${i}`, text: "t", at: i, name: "n", undone: false }))],
			},
		});
		t.jobs.set("j1", { live: false });
		t.c.load();
		const s = t.c.status();
		expect(s).toMatchObject({ on: false, id: "j1", lastWakeAt: null, notice: null, answer: { text: "ok", at: 4 }, policy: { answer: "never", act: false } });
		expect(s.answered).toMatchObject({ id: "k24" });
		// a garbage file is nothing
		for (const junk of [null, 5, "x", undefined]) {
			const u = setup({ saved: junk });
			u.c.load();
			expect(u.c.status()).toMatchObject({ on: false, id: null });
		}
		const p = setup({ saved: { id: "j1", on: true, policy: { answer: "always", act: false } } });
		p.jobs.set("j1", { live: false });
		p.c.load();
		expect(p.c.status()).toMatchObject({ on: true, policy: { answer: "always", act: false } });
		expect(p.c.mayAct()).toBe(false);
	});
});

describe("wakes", () => {
	it("a burst of nudges is one wake after the coalesce wait, with the events since the cursor; the cursor moves on", async () => {
		const t = setup();
		await t.up();
		const pushes = statuses(t).length;
		for (let i = 0; i < 3; i++) {
			t.happen(`thing ${i}`);
			t.c.nudge();
		}
		// the hub is told once that something is behind
		expect(statuses(t)).toHaveLength(pushes + 1);
		expect(t.pending()).toBe(1);
		await t.go(4999);
		expect(t.delivered).toHaveLength(0);
		await t.go(1);
		expect(t.delivered).toHaveLength(1);
		const d = t.delivered[0]!;
		expect(d).toContain('<roost-digest why="events">\n3 events since your last wake');
		for (let i = 0; i < 3; i++) expect(d).toContain(`worker finished: thing ${i}`);
		expect(t.st()).toMatchObject({ cursor: 3, lastWakeAt: T0 + 5000, wakes: [T0, T0 + 5000] });
		expect(t.pending()).toBe(0);
		expect(t.c.status()).toMatchObject({ behind: 0, wakesLastHour: 2 });
		// the next wake is what came after
		t.happen("fourth");
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered[1]).toContain("1 event since");
		expect(t.delivered[1]).not.toContain("thing 0");
		expect(t.delivered[1]).toContain("fourth");
	});

	it("the digest is the events minus its own, with the fleet minus its own row and the board and orders", async () => {
		const t = setup();
		await t.up();
		t.addRow("j1", "concierge");
		t.addRow("w1", "worker", { state: "blocked", waitingFor: "question", question: "Which?" });
		t.happen("mine", { id: "j1" });
		t.happen("by me", { whoId: "j1" });
		t.happen("news");
		await t.c.op("concierge-order", hub, { action: "add", text: "rule one" });
		t.c.nudge();
		await t.go(5000);
		const d = t.delivered[0]!;
		expect(d).toContain("1 event since");
		expect(d).toContain("news");
		expect(d).not.toContain("mine");
		expect(d).not.toContain("by me");
		expect(d).toContain("The fleet (1 session):");
		expect(d).toContain("worker  waits for question");
		expect(d).not.toContain("- j1");
		expect(d).toContain("- #1 rule one");
	});

	it("only its own events: nothing is sent, the cursor moves on and is saved", async () => {
		const t = setup();
		await t.up();
		t.happen("mine", { id: "j1" });
		t.happen("by me", { whoId: "j1" });
		t.c.nudge();
		const saves = t.ctl.saves;
		await t.go(5000);
		expect(t.delivered).toHaveLength(0);
		expect(t.st().cursor).toBe(2);
		expect(t.ctl.saves).toBe(saves + 1);
		expect(t.st().wakes).toEqual([T0]);
		// a wake with nothing new at all saves nothing
		t.c.nudge();
		await t.go(5000);
		expect(t.ctl.saves).toBe(saves + 1);
	});

	it("a nudge during a wake is remembered and is a wake after it", async () => {
		const t = setup();
		await t.up();
		t.happen("alpha");
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		// waking: no timer is added, the nudge is remembered
		t.happen("beta");
		t.c.nudge();
		t.c.nudge();
		expect(t.pending()).toBe(0);
		release();
		await flush();
		expect(t.st().cursor).toBe(1);
		expect(t.pending()).toBe(1);
		await t.go(5000);
		expect(t.delivered).toHaveLength(2);
		expect(t.delivered[1]).toContain("beta");
		expect(t.delivered[1]).not.toContain("alpha");
		expect(t.st().cursor).toBe(2);
	});

	it("a heartbeat asked for during a wake comes after it, as a heartbeat", async () => {
		const t = setup({ heartbeatMs: 120_000 });
		await t.up();
		t.c.start();
		t.happen("one");
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		// an `on` meanwhile (off, on) asks for the fleet now: remembered, one wake at a time
		await t.c.op("concierge", hub, { action: "off" });
		await t.go(1);
		await t.c.op("concierge", hub, { action: "on" });
		expect(t.delivered).toHaveLength(1);
		release();
		await flush();
		// the first wake is not the new epoch's to record; the remembered heartbeat goes out
		expect(t.delivered).toHaveLength(2);
		expect(t.delivered[1]).toContain('why="heartbeat"');
		expect(t.st().lastWakeAt).toBe(T0 + 5001);
	});

	it("nothing wakes it when it is off, has no job, or the daemon is going down", async () => {
		const t = setup();
		t.happen();
		t.c.nudge();
		expect(t.pending()).toBe(0);
		await t.up();
		t.ctl.shutting = true;
		t.c.nudge();
		expect(t.pending()).toBe(0);
		t.ctl.shutting = false;
		await t.c.op("concierge", hub, { action: "off" });
		t.c.nudge();
		expect(t.pending()).toBe(0);
		// a job that no longer exists is not woken
		await t.c.op("concierge", hub, { action: "on" });
		await flush();
		t.delivered.length = 0;
		t.happen();
		t.c.nudge();
		t.jobs.delete("j1");
		await t.go(5000);
		expect(t.delivered).toHaveLength(0);
		// a wake that was waiting when the daemon went down does not go
		const u = setup();
		await u.up();
		u.happen();
		u.c.nudge();
		u.ctl.shutting = true;
		await u.go(5000);
		expect(u.delivered).toHaveLength(0);
	});

	it("a wake that could not be delivered is tried again after the retry wait, with what happened meanwhile; coalesce and retry share one slot", async () => {
		const t = setup();
		await t.up();
		t.happen("first");
		t.c.nudge();
		t.ctl.failDeliver = 1;
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		expect(t.st().cursor).toBe(0);
		expect(t.logs.find((l) => l.msg === "concierge not woken")).toEqual({ level: "warn", msg: "concierge not woken", extra: { why: "events", error: "Error: queue full" } });
		expect(t.pending()).toBe(1);
		// a nudge during the pending retry adds no timer
		t.happen("second");
		t.c.nudge();
		expect(t.pending()).toBe(1);
		await t.go(59_999);
		expect(t.delivered).toHaveLength(1);
		await t.go(1);
		expect(t.delivered).toHaveLength(2);
		expect(t.delivered[1]).toContain("first");
		expect(t.delivered[1]).toContain("second");
		expect(t.st().cursor).toBe(2);
		expect(t.pending()).toBe(0);
	});

	it("no retry is armed while the daemon goes down; a failed wake does not leave a remembered nudge", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		t.c.nudge();
		t.ctl.failDeliver = 1;
		t.ctl.shutting = true;
		release();
		await flush();
		expect(t.pending()).toBe(0);
		t.ctl.shutting = false;
		await t.go(120_000);
		expect(t.delivered).toHaveLength(1);
	});

	it("a delivery that did not reach the session leaves the cursor, the wakes and the orders alone", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge-order", hub, { action: "add", text: "x", when: "every 1m" });
		t.happen("first-undelivered");
		t.c.nudge();
		t.ctl.result = { outcome: "queued-full", reached: false };
		const saves = t.ctl.saves;
		const osaves = t.ctl.orderSaves;
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		expect(t.st().cursor).toBe(0);
		expect(t.st().wakes).toEqual([T0]);
		expect(t.ctl.saves).toBe(saves);
		expect(t.ctl.orderSaves).toBe(osaves);
		expect(t.logs.filter((l) => l.msg === "concierge woken").at(-1)).toMatchObject({ extra: { why: "events", events: 1, outcome: "queued-full" } });
		expect(t.pending()).toBe(0);
		// the next wake still brings what was not delivered (the cursor did not move in memory either)
		t.ctl.result = { outcome: "delivered", reached: true };
		t.happen("second-news");
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(2);
		expect(t.delivered[1]).toContain("first-undelivered");
		expect(t.delivered[1]).toContain("second-news");
	});

	it("a delivery that found the session stopped turns it off, and says so", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		t.ctl.result = { outcome: "stopped", reached: false };
		const pushes = statuses(t).length;
		await t.go(5000);
		expect(t.c.status().on).toBe(false);
		expect(t.st()).toMatchObject({ on: false, cursor: 0 });
		expect(statuses(t)).toHaveLength(pushes + 1);
	});

	it("turned off while the wake started it: not left running, the cursor not moved", async () => {
		const t = setup();
		await t.up();
		t.jobs.get("j1")!.live = false;
		t.happen();
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.terminated).toEqual([]);
		// the delivery started the session
		t.jobs.get("j1")!.live = true;
		release();
		await flush();
		expect(t.terminated).toEqual(["j1"]);
		expect(t.st().cursor).toBe(0);
		expect(t.st().on).toBe(false);
		// on again during the wake that was started: the wake is not recorded
		const u = setup();
		await u.up();
		u.happen();
		u.c.nudge();
		const rel = u.hold();
		await u.go(5000);
		await u.c.op("concierge", hub, { action: "off" });
		await u.go(1);
		await u.c.op("concierge", hub, { action: "on" });
		rel();
		await flush();
		expect(u.terminated).toEqual(["j1"]);
		expect(u.st().lastWakeAt).not.toBe(T0 + 5000);
		expect(u.c.status().on).toBe(true);
	});

	it("held while over its daily budget (said once); the hub's flag follows the cost; under again it is woken", async () => {
		const t = setup({ cfg: { dailyBudgetUsd: 0.05 } });
		await t.up();
		const usage = (today: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: today, today, day: localMidnight(T0), sub: false, models: {} });
		t.addRow("j1", "concierge", { usage: usage(0.05) });
		t.happen();
		t.c.nudge();
		const pushes = statuses(t).length;
		await t.go(5000);
		expect(t.delivered).toHaveLength(0);
		expect(t.c.status()).toMatchObject({ overBudget: true, costToday: 0.05, budget: 0.05 });
		expect(t.st().cursor).toBe(0);
		expect(t.logs.filter((l) => l.msg === "concierge over budget")).toEqual([{ level: "info", msg: "concierge over budget", extra: { spent: 0.05, budget: 0.05 } }]);
		expect(statuses(t)).toHaveLength(pushes + 1);
		expect((statuses(t).at(-1) as any).status.overBudget).toBe(true);
		// held again: said once
		t.c.nudge();
		await t.go(5000);
		expect(t.logs.filter((l) => l.msg === "concierge over budget")).toHaveLength(1);
		// the day turns over (another day's cost is not today's)
		t.rows.get("j1")!.usage = usage(0.05);
		t.rows.get("j1")!.usage!.day -= 86_400_000;
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		expect(t.logs.at(-2)).toMatchObject({ msg: "concierge within budget", extra: { spent: 0, budget: 0.05 } });
		expect(t.c.status().overBudget).toBe(false);
		// no budget (0): never over
		t.ctl.cfg = { ...t.ctl.cfg, dailyBudgetUsd: 0 };
		t.rows.get("j1")!.usage = usage(99);
		t.happen();
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(2);
	});

	it("an under-budget cost does not hold it; a first on clears the flag", async () => {
		const t = setup({ cfg: { dailyBudgetUsd: 1 } });
		await t.up();
		t.addRow("j1", "concierge", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.99, today: 0.99, day: localMidnight(T0), sub: false, models: {} } });
		t.happen();
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		expect(t.c.status().overBudget).toBe(false);
	});

	it("over the hourly cap a wake is held and tried again every retry wait until the hour has room", async () => {
		const t = setup({ cfg: { wakesPerHour: 2 } });
		await t.up();
		t.happen("a");
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		t.delivered.length = 0;
		// the cap is 2 and two are spent (at on, at 5 s)
		t.happen("b");
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(0);
		expect(t.logs.filter((l) => l.msg === "concierge wake held")[0]).toEqual({ level: "info", msg: "concierge wake held", extra: { wakes: 2, cap: 2 } });
		expect(t.c.status()).toMatchObject({ behind: 1, wakesLastHour: 2 });
		expect(t.st().cursor).toBe(1);
		expect(t.pending()).toBe(1);
		// a nudge meanwhile adds no timer
		t.c.nudge();
		expect(t.pending()).toBe(1);
		await t.go(59_000);
		expect(t.logs.filter((l) => l.msg === "concierge wake held")).toHaveLength(1);
		await t.go(1000);
		expect(t.logs.filter((l) => l.msg === "concierge wake held")).toHaveLength(2);
		// the first wake falls out of the hour
		await t.go(3600_000 - 60_000 - 5000 + 60_000);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain("b");
		expect(t.pending()).toBe(0);
	});

	it("the heartbeat is held by the cap too, and tried again", async () => {
		const t = setup({ cfg: { wakesPerHour: 1 }, heartbeatMs: 60_000, tickMs: 10_000 });
		await t.up();
		t.c.start();
		await t.go(60_000);
		expect(t.delivered).toHaveLength(0);
		expect(t.logs.some((l) => l.msg === "concierge wake held")).toBe(true);
	});

	it("start nudges once for what happened while the service was off, and arms the heartbeat once", async () => {
		const t = setup();
		await t.up();
		t.happen("while down");
		const t2 = setup({ from: t, saved: undefined });
		t2.c.load();
		// the cursor the file kept is behind the feed
		expect(t2.c.status().behind).toBe(1);
		t2.c.start();
		t2.c.start();
		expect(t2.pending()).toBe(2);
		await t2.go(5000);
		expect(t2.delivered).toHaveLength(1);
		expect(t2.delivered[0]).toContain("while down");
		t2.c.stop();
	});
});

describe("the heartbeat and the tick", () => {
	it("a heartbeat wakes it when it has been idle for the period (the first wake counts), and the tick chain keeps its period", async () => {
		const t = setup({ heartbeatMs: 120_000 });
		await t.up();
		t.c.start();
		await t.go(90_000);
		expect(t.delivered).toHaveLength(0);
		await t.go(29_999);
		expect(t.delivered).toHaveLength(0);
		await t.go(1);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain('<roost-digest why="heartbeat">');
		expect(t.delivered[0]).toContain("Nothing happened since.");
		expect(t.delivered[0]).toContain("since your last wake 2m ago");
		expect(t.st()).toMatchObject({ lastWakeAt: T0 + 120_000 });
		// and again a period later, not sooner
		await t.go(119_000);
		expect(t.delivered).toHaveLength(1);
		await t.go(1000);
		expect(t.delivered).toHaveLength(2);
		expect(t.pending()).toBe(1);
		t.c.stop();
	});

	it("the setting's heartbeat is used when the module has no override; off means none", async () => {
		const t = setup({ cfg: { heartbeat: "every 2m" } });
		await t.up();
		t.c.start();
		await t.go(119_000);
		expect(t.delivered).toHaveLength(0);
		await t.go(1000);
		expect(t.delivered).toHaveLength(1);
		const u = setup({ cfg: { heartbeat: "off" } });
		await u.up();
		u.c.start();
		await u.go(24 * 3600_000);
		expect(u.delivered).toHaveLength(0);
		// the override beats the setting
		const v = setup({ cfg: { heartbeat: "off" }, heartbeatMs: 60_000 });
		await v.up();
		v.c.start();
		await v.go(60_000);
		expect(v.delivered).toHaveLength(1);
	});

	it("a heartbeat counts from the start when no wake reached it", async () => {
		const t = setup({ heartbeatMs: 120_000 });
		t.ctl.result = { outcome: "x", reached: false };
		await t.turnOn();
		await flush();
		t.ctl.result = { outcome: "delivered", reached: true };
		t.delivered.length = 0;
		t.c.start();
		await t.go(119_999);
		expect(t.delivered).toHaveLength(0);
		await t.go(1);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).not.toContain("since your last wake");
	});

	it("the tick wakes nothing when off, going down, waiting on a coalesce, or waking", async () => {
		const t = setup({ heartbeatMs: 60_000 });
		t.c.start();
		await t.go(120_000);
		expect(t.delivered).toHaveLength(0);
		await t.up();
		t.ctl.shutting = true;
		await t.go(60_000);
		expect(t.delivered).toHaveLength(0);
		t.ctl.shutting = false;
		// a wake already waiting for its coalesce: the tick leaves it (it comes at 125 s)
		t.happen();
		t.c.nudge();
		await t.go(4000);
		expect(t.delivered).toHaveLength(0);
		await t.go(1000);
		expect(t.delivered).toHaveLength(1);
		// a wake under way: the tick does not start a second
		t.delivered.length = 0;
		const release = t.hold();
		await t.go(90_000, 30_000);
		expect(t.delivered).toHaveLength(1);
		await t.go(120_000, 30_000);
		expect(t.delivered).toHaveLength(1);
		release();
		await flush();
		t.c.stop();
	});

	it("a tick that throws is logged, and the chain goes on", async () => {
		const t = setup({ heartbeatMs: 60_000 });
		await t.up();
		t.c.start();
		t.ctl.configThrows = true;
		await t.go(30_000);
		expect(t.logs.filter((l) => l.msg === "concierge tick failed")).toEqual([{ level: "error", msg: "concierge tick failed", extra: { error: "Error: config broke" } }]);
		expect(t.pending()).toBe(1);
		t.ctl.configThrows = false;
		await t.go(30_000);
		expect(t.delivered).toHaveLength(1);
		t.c.stop();
	});

	it("the tick looks at the budget, so the hub's flag is right without a wake", async () => {
		const t = setup({ cfg: { dailyBudgetUsd: 0.1 }, heartbeatMs: 60_000 });
		await t.up();
		t.addRow("j1", "concierge", { usage: { input: 0, output: 0, cacheRead: 0, cost: 1, cacheWrite: 0, today: 1, day: localMidnight(T0), sub: false, models: {} } });
		t.c.start();
		await t.go(60_000);
		expect(t.delivered).toHaveLength(0);
		expect(t.c.status().overBudget).toBe(true);
		expect(statuses(t).some((e) => (e as any).status.overBudget)).toBe(true);
	});

	it("an order on a clock that is due is a wake of its own, once; its next time is saved; the chain keeps its period", async () => {
		const t = setup();
		await t.up();
		t.c.start();
		await t.c.op("concierge-order", hub, { action: "add", text: "check the board", when: "every 1m" });
		expect(t.ord().orders[0]).toMatchObject({ nextAt: T0 + 60_000 });
		await t.go(30_000);
		expect(t.delivered).toHaveLength(0);
		await t.go(30_000);
		expect(t.delivered).toHaveLength(1);
		const d = t.delivered[0]!;
		expect(d).toContain('<roost-digest why="order">\n1 standing order due, 0 events');
		expect(d).toContain("Due now (carry these out, then hub_note_done each):");
		expect(d).toContain("- #1 every 1m · check the board");
		expect(d).toContain("Standing orders (apply one when what is above meets it, once per occurrence):");
		expect(t.ord().orders[0]).toMatchObject({ nextAt: T0 + 120_000, count: 0, lastAt: null });
		expect(t.st().lastWakeAt).toBe(T0 + 60_000);
		// not again at the next tick, but at the next time; five minutes make five wakes
		await t.go(30_000);
		expect(t.delivered).toHaveLength(1);
		await t.go(4 * 60_000 - 30_000, 30_000);
		expect(t.delivered).toHaveLength(5);
		expect(t.pending()).toBe(1);
		t.c.stop();
	});

	it("an order that is not on a clock is never due; a bad `when` in the file ends its clock after a wake", async () => {
		const t = setup({ cfg: { heartbeat: "off" } });
		await t.up();
		t.c.start();
		await t.c.op("concierge-order", hub, { action: "add", text: "when build ends" });
		await t.go(3600_000, 30_000);
		expect(t.delivered).toHaveLength(0);
		t.c.stop();
	});

	it("a wake held back by the cap carries the order later; one wake takes it for the others", async () => {
		const t = setup({ cfg: { wakesPerHour: 1 }, retryMs: 10_000 });
		await t.up();
		t.c.start();
		await t.c.op("concierge-order", hub, { action: "add", text: "o", when: "every 1m" });
		await t.go(60_000);
		expect(t.delivered).toHaveLength(0);
		expect(t.logs.some((l) => l.msg === "concierge wake held")).toBe(true);
		expect(t.ord().orders[0].nextAt).toBe(T0 + 60_000);
		// the hour passes; the held wake (an order wake) goes with the order in it
		await t.go(3600_000 - 60_000 + 10_000);
		expect(t.delivered.length).toBeGreaterThan(0);
		expect(t.delivered[0]).toContain('why="order"');
		t.c.stop();
	});

	it("a retry of an order wake whose order is gone is an events wake: nothing to send", async () => {
		const t = setup({ retryMs: 10_000 });
		await t.up();
		await t.c.op("concierge-order", hub, { action: "add", text: "o", when: "every 1m" });
		t.c.start();
		t.ctl.failDeliver = 1;
		await t.go(60_000, 30_000);
		expect(t.delivered).toHaveLength(1);
		// the tick must not start a second one meanwhile: the retry waits in the slot
		await t.c.op("concierge-order", hub, { action: "rm", id: 1 });
		await t.go(10_000);
		expect(t.delivered).toHaveLength(1);
		expect(t.st().cursor).toBe(2);
		expect(t.pending()).toBe(1);
		t.c.stop();
	});

	it("stop clears every timer and nothing re-arms after", async () => {
		const t = setup({ heartbeatMs: 60_000 });
		await t.up();
		t.c.start();
		t.happen();
		t.c.nudge();
		expect(t.pending()).toBe(2);
		t.c.stop();
		expect(t.pending()).toBe(0);
		await t.go(600_000);
		expect(t.delivered).toHaveLength(0);
		expect(t.pending()).toBe(0);
		// stop twice is fine; a start again arms the heartbeat again (and nudges once)
		t.c.stop();
		t.c.start();
		expect(t.pending()).toBe(2);
		t.c.stop();
	});

	it("a retry pending when the tick runs is cleared by stop", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		t.ctl.failDeliver = 1;
		await t.go(5000);
		expect(t.pending()).toBe(1);
		t.c.stop();
		expect(t.pending()).toBe(0);
	});
});

describe("say and ask", () => {
	it("say is the concierge's own: a notice or an answer, in the feed, saved, pushed", async () => {
		const t = setup();
		await t.up();
		expect(await code(t.c.op("concierge-say", hub, { kind: "info", text: "x" }))).toBe("unauthorized: not a peer");
		expect(await code(t.c.op("concierge-say", other, { kind: "info", text: "x" }))).toBe("unsupported: only the concierge says things to the hub");
		expect(await code(t.c.op("concierge-say", { peer: { kind: "fg", id: "j1" } }, { kind: "info", text: "x" }))).toMatch(/^unsupported/);
		expect(t.recorded).toEqual([]);
		// the text is checked before the kind
		expect(await code(t.c.op("concierge-say", cc, { kind: "shout", text: "" }))).toBe("bad_request: empty text");
		expect(await code(t.c.op("concierge-say", cc, { kind: "info", text: " \x01\x02 " }))).toBe("bad_request: empty text");
		expect(await code(t.c.op("concierge-say", cc, { kind: "info" }))).toBe("bad_request: empty text");
		expect(await code(t.c.op("concierge-say", cc, { kind: "shout", text: "x" }))).toBe("bad_request: kind must be info, need or answer");
		expect(await code(t.c.op("concierge-say", cc, undefined))).toBe("bad_request: empty text");
		const pushes = statuses(t).length;
		expect(await t.c.op("concierge-say", cc, { kind: "need", text: "  worker\x01asks \n which  " })).toEqual({});
		expect(t.c.status().notice).toEqual({ kind: "need", text: "worker asks \n which", at: T0 });
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j1", name: "concierge", who: "concierge", whoId: "j1", why: "need", text: "worker asks which" });
		expect(t.st().notice).toMatchObject({ kind: "need" });
		expect(statuses(t)).toHaveLength(pushes + 1);
		await t.go(10);
		await t.c.op("concierge-say", cc, { kind: "info", text: "i" });
		expect(t.c.status().notice).toEqual({ kind: "info", text: "i", at: T0 + 10 });
		await t.c.op("concierge-say", cc, { kind: "answer", text: "a".repeat(5000) });
		expect(t.c.status().answer).toEqual({ text: "a".repeat(4000), at: T0 + 10 });
		expect(t.c.status().notice).toMatchObject({ text: "i" });
		expect(t.recorded.at(-1)).toMatchObject({ why: "answer", text: clipText("a".repeat(5000)) });
		expect(t.st().answer.text).toHaveLength(4000);
		await t.c.op("concierge-say", cc, { kind: "info", text: "n".repeat(900) });
		expect((t.c.status().notice as any).text).toHaveLength(500);
	});

	it("ask is the user's question as a reply to the concierge's session", async () => {
		const t = setup();
		expect(await code(t.c.op("concierge-ask", hub, { text: "  " }))).toBe("bad_request: empty question");
		expect(await code(t.c.op("concierge-ask", hub, { text: 5 }))).toBe("bad_request: empty question");
		expect(await code(t.c.op("concierge-ask", hub, {}))).toBe("bad_request: empty question");
		expect(await code(t.c.op("concierge-ask", hub, { text: "hi" }))).toBe("unavailable: the concierge is off (/concierge on)");
		await t.up();
		expect(await t.c.op("concierge-ask", hub, { text: "  what is blocked?  " })).toEqual({ id: "j1" });
		expect(t.replies).toEqual([{ args: { id: "j1", text: "what is blocked?" }, by: undefined }]);
		await t.c.op("concierge", hub, { action: "off" });
		expect(await code(t.c.op("concierge-ask", hub, { text: "hi" }))).toMatch(/^unavailable/);
		await t.c.op("concierge", hub, { action: "on" });
		t.jobs.delete("j1");
		expect(await code(t.c.op("concierge-ask", hub, { text: "hi" }))).toMatch(/^unavailable/);
		expect(t.replies).toHaveLength(1);
	});
});

describe("policy", () => {
	it("the concierge reads it; the hub sets it: answer and act, kept, in the feed, pushed", async () => {
		const t = setup();
		expect(await code(t.c.op("concierge-policy", hub, {}))).toBe("unauthorized: not a peer");
		await t.up();
		expect(await code(t.c.op("concierge-policy", other, {}))).toBe("unsupported: only the concierge does this");
		expect(await t.c.op("concierge-policy", cc, {})).toEqual({ answer: "never", act: false });
		expect(t.c.mayAct()).toBe(false);
		const pushes = statuses(t).length;
		expect(await code(t.c.op("concierge", hub, { action: "answer", answer: "sometimes" }))).toBe("bad_request: answer must be never, routine or always");
		expect(await code(t.c.op("concierge", hub, { action: "answer" }))).toMatch(/^bad_request/);
		expect(await code(t.c.op("concierge", hub, { action: "act", act: "yes" }))).toBe("bad_request: act must be true or false");
		expect(await code(t.c.op("concierge", hub, { action: "act" }))).toMatch(/^bad_request/);
		expect(t.saved()).toMatchObject({});
		const s = await t.c.op("concierge", hub, { action: "answer", answer: "routine" });
		expect((s as any).policy).toEqual({ answer: "routine", act: false });
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j1", name: "concierge", who: "user", why: "policy", text: "answer: routine" });
		expect(t.st().policy).toEqual({ answer: "routine", act: false });
		expect(statuses(t)).toHaveLength(pushes + 1);
		expect(t.logs.at(-1)).toMatchObject({ msg: "concierge policy", extra: { answer: "routine", act: false } });
		expect(((await t.c.op("concierge", hub, { action: "act", act: true })) as any).policy).toEqual({ answer: "routine", act: true });
		expect(t.recorded.at(-1)).toMatchObject({ text: "act: on" });
		expect(t.c.mayAct()).toBe(true);
		expect(await t.c.op("concierge-policy", cc, {})).toEqual({ answer: "routine", act: true });
		await t.c.op("concierge", hub, { action: "act", act: false });
		expect(t.recorded.at(-1)).toMatchObject({ text: "act: off" });
		expect(t.c.mayAct()).toBe(false);
	});

	it("the setting is the policy until the hub sets one; a set keeps the setting's other half; no job: no event", async () => {
		const t = setup({ cfg: { answer: "always", act: true } });
		expect(t.c.status().policy).toEqual({ answer: "always", act: true });
		expect(t.c.mayAct()).toBe(true);
		await t.c.op("concierge", hub, { action: "answer", answer: "never" });
		expect(t.c.status().policy).toEqual({ answer: "never", act: true });
		expect(t.recorded).toEqual([]);
		// once set, the policy is the hub's: the setting no longer moves it
		t.ctl.cfg = { ...t.ctl.cfg, act: false };
		expect(t.c.status().policy).toEqual({ answer: "never", act: true });
		const u = setup({ cfg: { answer: "always", act: true } });
		await u.c.op("concierge", hub, { action: "act", act: false });
		expect(u.c.status().policy).toEqual({ answer: "always", act: false });
		expect(u.recorded).toEqual([]);
	});
});

describe("suggest", () => {
	async function blocked(t: ReturnType<typeof setup>, over: Partial<JobRow> = {}) {
		await t.up();
		t.addRow("j1", "concierge");
		return t.addRow("w1", "worker", { state: "blocked", waitingFor: "question", question: "Which branch?", stateSince: T0 + 50, ...over });
	}

	it("who may, which session, what text, what state: in that order", async () => {
		const t = setup();
		const w = await blocked(t);
		expect(await code(t.c.op("concierge-suggest", hub, { id: "worker", text: "main" }))).toBe("unauthorized: not a peer");
		expect(await code(t.c.op("concierge-suggest", other, { id: "worker", text: "main" }))).toBe("unsupported: only the concierge does this");
		expect(await code(t.c.op("concierge-suggest", cc, undefined))).toBe("bad_request: id required");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "  ", text: "main" }))).toBe("bad_request: id required");
		expect(await code(t.c.op("concierge-suggest", cc, { id: 4, text: "main" }))).toBe("bad_request: id required");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "nobody", text: "main" }))).toBe("not_found: no session nobody");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "j1", text: "main" }))).toBe("bad_request: that is you");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "concierge", text: "main" }))).toBe("bad_request: that is you");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "worker", text: " \x01 " }))).toBe("bad_request: empty suggestion");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "worker", text: "/stop" }))).toBe("bad_request: a suggestion is plain text, not a command");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "worker", text: "!ls" }))).toBe("bad_request: a suggestion is plain text, not a command");
		// text before state
		w.state = "working" as never;
		expect(await code(t.c.op("concierge-suggest", cc, { id: "worker", text: "" }))).toBe("bad_request: empty suggestion");
		expect(await code(t.c.op("concierge-suggest", cc, { id: "worker", text: "main" }))).toBe("bad_request: worker is not waiting for an answer (working)");
		expect(t.recorded).toEqual([]);
		expect(t.pushedJobs).toEqual([]);
		expect(t.c.suggestionField("w1", {})).toEqual({});
	});

	it("keeps it by the job (found by id or name) with the question it was for, saved, in the feed, on the row", async () => {
		const t = setup();
		await blocked(t);
		expect(await t.c.op("concierge-suggest", cc, { id: " worker ", text: "main\x01now", why: "  others use\nmain " })).toEqual({ id: "w1", name: "worker" });
		expect(t.st().suggestions.w1).toEqual({ text: "main now", why: "others use\nmain", at: T0, question: "Which branch?" });
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "w1", name: "worker", who: "concierge", whoId: "j1", why: "suggest", text: "main now" });
		expect(t.pushedJobs).toEqual(["w1"]);
		expect(t.c.suggestionField("w1", { state: "blocked", question: "Which branch?" })).toEqual({ suggested: { text: "main now", why: "others use\nmain", at: T0 } });
		// by id; no why: null; text and why are cut
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "x".repeat(3000), why: "y".repeat(900) });
		expect(t.st().suggestions.w1.text).toHaveLength(2000);
		expect(t.st().suggestions.w1.why).toHaveLength(500);
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "again" });
		expect(t.st().suggestions.w1).toMatchObject({ text: "again", why: null });
		expect(t.pushedJobs).toEqual(["w1", "w1", "w1"]);
	});

	it("a suggestion for a row without a question is for no question", async () => {
		const t = setup();
		await blocked(t, { question: null, waitingFor: "dialog" as never });
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "ok" });
		expect(t.st().suggestions.w1.question).toBeNull();
		expect(t.c.suggestionField("w1", { state: "blocked", question: "" })).toMatchObject({ suggested: { text: "ok" } });
		expect(t.c.suggestionField("w1", { state: "blocked" })).toMatchObject({ suggested: { text: "ok" } });
		expect(t.c.suggestionField("w1", { state: "blocked", question: "Now a question" })).toEqual({ suggested: null });
	});

	it("is on the row only while the row waits with the same question; gone with the reply, the row moving on, the job removed", async () => {
		const t = setup();
		await blocked(t);
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "main" });
		expect(t.c.suggestionField("w1", { state: "working", question: "Which branch?" })).toEqual({ suggested: null });
		expect(t.c.suggestionField("w1", { state: "blocked", question: "Another?" })).toEqual({ suggested: null });
		expect(t.c.suggestionField("w1", { state: "blocked", question: 7 })).toEqual({ suggested: null });
		expect(t.c.suggestionField("zz", { state: "blocked" })).toEqual({});
		const saves = t.ctl.saves;
		expect(t.c.dropSuggestion("zz")).toBe(false);
		expect(t.ctl.saves).toBe(saves);
		expect(t.c.dropSuggestion("w1")).toBe(true);
		expect(t.ctl.saves).toBe(saves + 1);
		expect(t.st().suggestions).toEqual({});
		expect(t.c.dropSuggestion("w1")).toBe(false);
		expect(t.c.suggestionField("w1", { state: "blocked", question: "Which branch?" })).toEqual({});
		// removed(other job) drops its suggestion; the concierge's job is not touched
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "main" });
		t.c.removed("w1");
		expect(t.st().suggestions).toEqual({});
		expect(t.c.status().on).toBe(true);
		t.c.removed("unknown");
	});

	it("removing the concierge's own job is the concierge off, said so", async () => {
		const t = setup();
		await t.up();
		const pushes = statuses(t).length;
		t.c.removed("j1");
		expect(t.c.status()).toMatchObject({ on: false, id: null });
		expect(t.st()).toMatchObject({ on: false, id: null });
		expect(statuses(t)).toHaveLength(pushes + 1);
		expect(t.c.isConcierge("j1")).toBe(false);
	});

	it("a suggestion for a row that no longer waits is dropped when the files load", () => {
		const good = { text: "a", why: null, at: 1, question: "q" };
		const t = setup({
			saved: {
				id: "j1",
				on: false,
				suggestions: { ok: good, gone: good, moved: good, notext: { ...good, text: "" }, noat: { text: "a", why: null }, junk: 5, noq: { text: "a", at: 2 } },
			},
		});
		for (const id of ["j1", "ok", "moved", "notext", "noat", "junk", "noq"]) t.jobs.set(id, { live: false });
		for (const id of ["ok", "notext", "noat", "junk", "noq", "gone"]) t.states.set(id, "blocked");
		t.states.set("moved", "working");
		t.c.load();
		expect(Object.keys(t.c.dropSuggestion("ok") ? { ok: 1 } : {})).toEqual(["ok"]);
		expect(t.c.dropSuggestion("gone")).toBe(false);
		expect(t.c.dropSuggestion("moved")).toBe(false);
		expect(t.c.dropSuggestion("notext")).toBe(false);
		expect(t.c.dropSuggestion("noat")).toBe(false);
		expect(t.c.dropSuggestion("junk")).toBe(false);
		expect(t.c.suggestionField("noq", { state: "blocked" })).toMatchObject({ suggested: { text: "a", why: undefined, at: 2 } });
	});
});

describe("reply and undo", () => {
	async function waiting(over: Partial<ConciergeConfig> = { answer: "routine" }) {
		const t = setup({ cfg: over });
		await t.up();
		t.addRow("j1", "concierge");
		t.addRow("w1", "worker", { state: "blocked", waitingFor: "question", question: "Proceed?", stateSince: T0 });
		return t;
	}

	it("who may, the policy first, then the session, the text, the wait", async () => {
		const t = await waiting({ answer: "never" });
		expect(await code(t.c.op("concierge-reply", hub, { id: "worker", text: "yes" }))).toBe("unauthorized: not a peer");
		expect(await code(t.c.op("concierge-reply", other, { id: "worker", text: "yes" }))).toBe("unsupported: only the concierge does this");
		// never: refused before anything else, nothing named is looked at
		expect(await code(t.c.op("concierge-reply", cc, { id: "nobody", text: "" }))).toBe("policy: the user answers questions (answer: never): suggest the answer instead (hub_suggest)");
		await t.c.op("concierge", hub, { action: "answer", answer: "routine" });
		expect(await code(t.c.op("concierge-reply", cc, undefined))).toBe("bad_request: id required");
		expect(await code(t.c.op("concierge-reply", cc, { id: "nobody", text: "yes" }))).toBe("not_found: no session nobody");
		expect(await code(t.c.op("concierge-reply", cc, { id: "j1", text: "yes" }))).toBe("bad_request: that is you");
		expect(await code(t.c.op("concierge-reply", cc, { id: "worker", text: "" }))).toBe("bad_request: empty answer");
		expect(await code(t.c.op("concierge-reply", cc, { id: "worker", text: "/stop" }))).toBe("bad_request: an answer is plain text, not a command");
		expect(await code(t.c.op("concierge-reply", cc, { id: "worker", text: "!rm" }))).toBe("bad_request: an answer is plain text, not a command");
		const w = t.rows.get("w1")!;
		w.state = "working" as never;
		expect(await code(t.c.op("concierge-reply", cc, { id: "worker", text: "yes" }))).toBe("bad_request: worker is not waiting for an answer to a question (working, question)");
		w.state = "blocked" as never;
		w.waitingFor = "dialog" as never;
		expect(await code(t.c.op("concierge-reply", cc, { id: "worker", text: "yes" }))).toBe("bad_request: worker is not waiting for an answer to a question (blocked, dialog)");
		expect(t.replies).toEqual([]);
		// always lets it as well
		await t.c.op("concierge", hub, { action: "answer", answer: "always" });
		w.waitingFor = "question" as never;
		expect(await t.c.op("concierge-reply", cc, { id: "worker", text: "yes" })).toEqual({ id: "w1", name: "worker" });
	});

	it("answers in the user's place: the reply goes as the concierge's, is kept for undo, spends the suggestion", async () => {
		const t = await waiting();
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "yes" });
		t.pushedJobs.length = 0;
		await t.go(10);
		const pushes = statuses(t).length;
		expect(await t.c.op("concierge-reply", cc, { id: "worker", text: " yes, proceed\x01 ", why: "it asked to proceed" })).toEqual({ id: "w1", name: "worker" });
		expect(t.replies).toEqual([{ args: { id: "w1", text: "yes, proceed" }, by: { who: "concierge", whoId: "j1" } }]);
		expect(t.c.status().answered).toEqual({ id: "w1", name: "worker", text: "yes, proceed", at: T0 + 10, undone: false });
		expect(t.st().answered).toHaveLength(1);
		expect(t.st().suggestions).toEqual({});
		expect(t.pushedJobs).toEqual(["w1"]);
		expect(statuses(t)).toHaveLength(pushes + 1);
		expect(t.logs.at(-1)).toEqual({ level: "info", msg: "concierge answered", extra: { id: "w1", why: "it asked to proceed" } });
		// saved (not delivered) is kept too; neither is an error
		t.ctl.replyResult = { delivered: false, saved: true };
		await t.c.op("concierge-reply", cc, { id: "w1", text: "again" });
		expect(t.st().answered).toHaveLength(2);
		t.ctl.replyResult = { delivered: false, saved: false, error: "gone" };
		expect(await code(t.c.op("concierge-reply", cc, { id: "w1", text: "third" }))).toBe("unavailable: not delivered to worker: gone");
		t.ctl.replyResult = { delivered: false, saved: false };
		expect(await code(t.c.op("concierge-reply", cc, { id: "w1", text: "third" }))).toBe("unavailable: not delivered to worker");
		expect(t.st().answered).toHaveLength(2);
	});

	it("keeps the last 20 answers; the text is cut at 4000", async () => {
		const t = await waiting();
		for (let i = 0; i < 22; i++) await t.c.op("concierge-reply", cc, { id: "w1", text: `a${i}` });
		expect(t.st().answered.map((a: any) => a.text)).toEqual(Array.from({ length: 20 }, (_, i) => `a${i + 2}`));
		await t.c.op("concierge-reply", cc, { id: "w1", text: "z".repeat(5000) });
		expect(t.replies.at(-1)!.args.text).toHaveLength(4000);
	});

	it("undo: nothing answered is not found; at work the session is steered; the status says which was undone", async () => {
		const t = await waiting();
		expect(await code(t.c.op("concierge", hub, { action: "undo" }))).toBe("not_found: nothing to undo: the concierge has answered no session");
		await t.c.op("concierge-reply", cc, { id: "w1", text: "yes, proceed" });
		t.replies.length = 0;
		t.rows.get("w1")!.state = "working" as never;
		await t.go(10);
		const s = (await t.c.op("concierge", hub, { action: "undo" })) as any;
		expect(s.answered).toMatchObject({ text: "yes, proceed", undone: true });
		expect(t.replies).toEqual([{ args: { id: "w1", text: undoText("yes, proceed"), mode: "steer" }, by: undefined }]);
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "w1", name: "worker", who: "user", why: "undo", text: "yes, proceed" });
		expect(t.st().answered).toEqual([expect.objectContaining({ undone: true })]);
		expect(t.logs.at(-1)).toEqual({ level: "info", msg: "concierge answer undone", extra: { id: "w1", how: "steer" } });
		expect(await code(t.c.op("concierge", hub, { action: "undo" }))).toMatch(/^not_found/);
	});

	it("undo of a session that still waits with that question is a reply; one that waits for something newer, or ended, or is gone, is marked only", async () => {
		const t = await waiting();
		await t.c.op("concierge-reply", cc, { id: "w1", text: "one" });
		await t.go(100);
		// still waiting, since before the answer: a reply (no mode)
		await t.c.op("concierge", hub, { action: "undo" });
		expect(t.replies.at(-1)).toEqual({ args: { id: "w1", text: undoText("one") }, by: undefined });
		// waiting since after the answer (a new question): marked only
		await t.c.op("concierge-reply", cc, { id: "w1", text: "two" });
		t.replies.length = 0;
		t.rows.get("w1")!.stateSince = T0 + 5000;
		await t.c.op("concierge", hub, { action: "undo" });
		expect(t.replies).toEqual([]);
		const undone = () => t.replies.filter((r) => r.args.text.includes("came from the concierge"));
		// waiting for a dialog; a done session; a job that is gone; a row that is gone
		for (const [state, waitingFor] of [["blocked", "dialog"], ["done", null], ["done", "question"]] as const) {
			await t.c.op("concierge-reply", cc, { id: "w1", text: "x" }).catch(() => {});
			Object.assign(t.rows.get("w1")!, { state, waitingFor, stateSince: 0 });
			await t.c.op("concierge", hub, { action: "undo" }).catch(() => {});
			Object.assign(t.rows.get("w1")!, { state: "blocked", waitingFor: "question", stateSince: 0 });
		}
		expect(undone()).toEqual([]);
		await t.c.op("concierge-reply", cc, { id: "w1", text: "y" });
		t.jobs.delete("w1");
		await t.c.op("concierge", hub, { action: "undo" });
		t.jobs.set("w1", { live: true });
		await t.c.op("concierge-reply", cc, { id: "w1", text: "z" });
		t.rows.delete("w1");
		await t.c.op("concierge", hub, { action: "undo" });
		expect(undone()).toEqual([]);
	});

	it("undoes the newest answer not yet undone; an undo whose reply fails is logged and still done", async () => {
		const t = await waiting();
		await t.c.op("concierge-reply", cc, { id: "w1", text: "first" });
		await t.c.op("concierge-reply", cc, { id: "w1", text: "second" });
		t.rows.get("w1")!.state = "working" as never;
		t.ctl.replyFails = true;
		const s1 = (await t.c.op("concierge", hub, { action: "undo" })) as any;
		expect(s1.answered).toMatchObject({ text: "second", undone: true });
		expect(t.logs.find((l) => l.msg === "concierge undo not delivered")).toEqual({ level: "warn", msg: "concierge undo not delivered", extra: { id: "w1", error: "Error: reply failed" } });
		t.ctl.replyFails = false;
		const s2 = (await t.c.op("concierge", hub, { action: "undo" })) as any;
		expect(s2.answered).toMatchObject({ text: "first", undone: true });
		expect(t.st().answered.map((a: any) => [a.text, a.undone])).toEqual([
			["second", true],
			["first", true],
		]);
	});
});

describe("act", () => {
	const dispatchArgs = (over: Record<string, unknown> = {}) => ({ kind: "pi", cwd: "/work", sessionFile: "/work/new.jsonl", command: ["pi", "--flag", "--", "do it"], name: "extra", ...over });

	async function acting(act = true) {
		const t = setup({ cfg: { act } });
		await t.up();
		t.addRow("j1", "concierge");
		t.addRow("w1", "worker");
		t.launches.set("j1", { kind: "pi", command: ["node", "pi.js", "--session", "/s/own.jsonl", "--model", "a/b", "--flag", "--"], env: { PATH: "/bin", ROOST_ROLE: "concierge", ROOST_JOB_ID: "j1", ROOST_SOCKET: "/s", PI_ROOST_JOB: "j1", PI_JOB_X: "1", KEEP: "1" } });
		return t;
	}

	it("who may, the policy, then what", async () => {
		const t = await acting(false);
		expect(await code(t.c.op("concierge-act", hub, { what: "stop", id: "worker" }))).toBe("unauthorized: not a peer");
		expect(await code(t.c.op("concierge-act", other, { what: "stop", id: "worker" }))).toBe("unsupported: only the concierge does this");
		const msg = "policy: the concierge may not start, stop or restart sessions (act: off): ask the user to";
		expect(await code(t.c.op("concierge-act", cc, { what: "stop", id: "worker" }))).toBe(msg);
		expect(await code(t.c.op("concierge-act", cc, { what: "nonsense" }))).toBe(msg);
		expect(await code(t.c.op("concierge-act", cc, { what: "dispatch", launch: dispatchArgs() }))).toBe(msg);
		expect(t.hubCalls).toEqual([]);
		expect(t.dispatches).toHaveLength(1);
		await t.c.op("concierge", hub, { action: "act", act: true });
		expect(await code(t.c.op("concierge-act", cc, { what: "nonsense" }))).toBe("bad_request: what must be stop, respawn or dispatch");
		expect(await code(t.c.op("concierge-act", cc, undefined))).toBe("bad_request: what must be stop, respawn or dispatch");
	});

	it("stop and respawn run as the hub's op on the session named; each is in the feed with its reason", async () => {
		const t = await acting();
		expect(await code(t.c.op("concierge-act", cc, { what: "stop" }))).toBe("bad_request: id required");
		expect(await code(t.c.op("concierge-act", cc, { what: "stop", id: "ghost" }))).toBe("not_found: no session ghost");
		expect(await code(t.c.op("concierge-act", cc, { what: "stop", id: "concierge" }))).toBe("bad_request: that is you");
		expect(await code(t.c.op("concierge-act", cc, { what: "respawn", id: "j1" }))).toBe("bad_request: that is you");
		expect(t.hubCalls).toEqual([]);
		expect(await t.c.op("concierge-act", cc, { what: "stop", id: "worker", why: "  the user asked " })).toEqual({ id: "w1", name: "worker" });
		expect(await t.c.op("concierge-act", cc, { what: "respawn", id: "w1" })).toEqual({ id: "w1", name: "worker" });
		expect(t.hubCalls).toEqual([
			{ what: "stop", id: "w1" },
			{ what: "respawn", id: "w1" },
		]);
		expect(t.recorded.slice(-2)).toEqual([
			{ kind: "concierge", id: "w1", name: "worker", who: "concierge", whoId: "j1", why: "act", text: "stopped worker: the user asked" },
			{ kind: "concierge", id: "w1", name: "worker", who: "concierge", whoId: "j1", why: "act", text: "restarted worker" },
		]);
		// the hub's op failing: nothing is recorded
		t.ctl.asHubFails = true;
		const n = t.recorded.length;
		await expect(t.c.op("concierge-act", cc, { what: "stop", id: "w1" })).rejects.toThrow("asHub failed");
		expect(t.recorded).toHaveLength(n);
	});

	it("dispatch starts a session built from the concierge's own launch and records it", async () => {
		const t = await acting();
		const r = await t.c.op("concierge-act", cc, { what: "dispatch", launch: dispatchArgs(), why: "a standing order" });
		expect(r).toEqual({ id: "j2", name: "extra" });
		expect(t.dispatches.at(-1)).toEqual({
			launch: {
				kind: "pi",
				cwd: "/work",
				sessionFile: "/work/new.jsonl",
				command: ["node", "pi.js", "--session", "/work/new.jsonl", "--model", "a/b", "--flag", "--", "do it"],
				env: { PATH: "/bin", KEEP: "1" },
				name: "extra",
				origin: "dispatch",
			},
			extra: undefined,
		});
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j2", name: "extra", who: "concierge", whoId: "j1", why: "act", text: "started extra: a standing order" });
		await t.c.op("concierge-act", cc, { what: "dispatch", launch: dispatchArgs({ sessionFile: "/work/new2.jsonl" }) });
		expect(t.recorded.at(-1)!.text).toBe("started extra");
		await t.c.op("concierge-act", cc, { what: "stop", id: "w1", why: "w".repeat(500) });
		expect(t.recorded.at(-1)!.text).toBe(`stopped worker: ${"w".repeat(200)}`);
	});

	it("the launch is the daemon's: refusals in order", async () => {
		const t = await acting();
		const L = (over: Record<string, unknown>) => t.c.launch(dispatchArgs(over) as never);
		const bad = (m: string) => `bad_request: ${m}`;
		const run = (f: () => unknown) => {
			try {
				f();
				return "ok";
			} catch (e) {
				return `${(e as OpError).code}: ${(e as OpError).message}`;
			}
		};
		expect(run(() => t.c.launch(undefined as never))).toBe(bad("launch required"));
		expect(run(() => t.c.launch({} as never))).toBe(bad("launch required"));
		expect(run(() => t.c.launch({ command: "pi" } as never))).toBe(bad("launch required"));
		expect(run(() => L({ kind: "shell" }))).toBe(bad("the concierge starts pi sessions only"));
		expect(run(() => L({ profile: "aider" }))).toBe(bad("the concierge starts pi sessions only"));
		expect(run(() => L({ worktree: { path: "/w" } }))).toBe(bad("the concierge starts pi sessions only"));
		t.paths.add("rel");
		for (const cwd of [undefined, "", "rel", "/nowhere", 5]) expect(run(() => L({ cwd }))).toBe(bad("launch: cwd must be a directory"));
		t.used.add("/work/used.jsonl");
		t.paths.add("/work/exists.jsonl");
		for (const sessionFile of [undefined, "", "rel.jsonl", "/work/x.txt", "/work/exists.jsonl", "/work/used.jsonl", 3]) expect(run(() => L({ sessionFile }))).toBe(bad("launch: a new session file"));
		expect(run(() => L({ command: ["pi", "--", "a", "b"] }))).toBe(bad("launch: one task after --"));
		expect(run(() => L({ command: ["pi", "--", "/tasks merge"] }))).toBe(bad("a task is plain text, not a command (/, !) or a file (@)"));
		expect(run(() => L({ command: ["pi", "--", "@file"] }))).toMatch(/plain text/);
		expect(run(() => L({}))).toBe("ok");
		// its own launch must be known: none, a shell, too short, not --session
		for (const own of [undefined, { kind: "shell", command: ["a", "b", "--session", "c"] }, { kind: "pi", command: ["a", "b", "--session"] }, { kind: "pi", command: ["a", "b", "--resume", "c"] }, { kind: "pi", command: "x" }]) {
			if (own) t.launches.set("j1", own);
			else t.launches.delete("j1");
			expect(run(() => L({}))).toBe(bad("the concierge's own launch is unknown: it cannot start sessions now"));
		}
		const u = setup();
		expect(() => u.c.launch(dispatchArgs() as never)).toThrow(/own launch is unknown/);
	});

	it("builds from the concierge's own: its program, its flags, the task; the model and thinking only of the right shape", async () => {
		const t = await acting();
		const L = (over: Record<string, unknown>) => t.c.launch(dispatchArgs(over) as never);
		// no task: none after "--"; no "--" in its own: all its flags
		expect(L({ command: ["evil"] }).command).toEqual(["node", "pi.js", "--session", "/work/new.jsonl", "--model", "a/b", "--flag"]);
		t.launches.set("j1", { kind: "pi", command: ["node", "pi.js", "--session", "/s/own.jsonl", "--model=a/b", "--thinking", "low", "-x"], piVersion: "1.2.3" });
		const a = L({ model: "p/m-1.5:v@2", thinking: "high", name: "n".repeat(100) });
		expect(a).toEqual({
			kind: "pi",
			cwd: "/work",
			sessionFile: "/work/new.jsonl",
			command: ["node", "pi.js", "--session", "/work/new.jsonl", "-x", "--model", "p/m-1.5:v@2", "--thinking", "high", "--", "do it"],
			env: {},
			name: "n".repeat(80),
			origin: "dispatch",
			model: "p/m-1.5:v@2",
			thinking: "high",
			piVersion: "1.2.3",
		});
		// a shape that is not provider/model, a thinking level pi does not know: ignored
		const b = L({ model: "no-slash", thinking: "extreme", name: "" });
		expect(b.command).toEqual(["node", "pi.js", "--session", "/work/new.jsonl", "--model=a/b", "--thinking", "low", "-x", "--", "do it"]);
		expect(b.name).toBe("session");
		expect("model" in b).toBe(false);
		expect("thinking" in b).toBe(false);
		expect(L({ model: "a b/c" }).model).toBeUndefined();
		expect(L({ name: 5 }).name).toBe("session");
		expect(L({ kind: "weird" }).kind).toBe("pi");
		// what the concierge sent beyond that is not used
		const c = L({ env: { EVIL: "1" }, workspaceEnv: { A: "1" }, envDeny: ["X"], envForce: { B: "2" }, piVersion: "9" });
		expect(c.env).toEqual({});
		expect("workspaceEnv" in c || "envDeny" in c || "envForce" in c).toBe(false);
		expect(c.piVersion).toBe("1.2.3");
		// its own policy for the child comes from its record
		t.launches.set("j1", { kind: "pi", command: ["node", "pi.js", "--session", "/s/o.jsonl"], workspaceEnv: { W: "1" }, envDeny: ["D"], envForce: { F: "1" } });
		const d = L({});
		expect(d).toMatchObject({ workspaceEnv: { W: "1" }, envDeny: ["D"], envForce: { F: "1" } });
		expect("piVersion" in d).toBe(false);
		expect(d.command).toEqual(["node", "pi.js", "--session", "/work/new.jsonl", "--", "do it"]);
	});
});

describe("standing orders", () => {
	it("keeps, lists, drops: the user's from the hub, its own from the concierge; in the feed once it has a job", async () => {
		const t = setup();
		// before it ever had a job there is no feed entry
		const first = (await t.c.op("concierge-order", hub, { action: "add", text: "  no job\n yet " })) as any;
		expect(first.order).toEqual({ id: 1, text: "no job yet", when: null, by: "user", at: T0, lastAt: null, nextAt: null, count: 0 });
		expect(t.recorded).toEqual([]);
		await t.up();
		const pushes = statuses(t).length;
		const clock = (await t.c.op("concierge-order", cc, { action: "add", text: "say what is blocked", when: "  every 1m " })) as any;
		expect(clock.order).toEqual({ id: 2, text: "say what is blocked", when: "every 1m", by: "concierge", at: T0, lastAt: null, nextAt: T0 + 60_000, count: 0 });
		expect(clock.orders.map((o: any) => o.id)).toEqual([1, 2]);
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j1", name: "concierge", who: "concierge", whoId: "j1", why: "order-kept", text: "#2 every 1m · say what is blocked" });
		await t.c.op("concierge-order", hub, { action: "add", text: "plain" });
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j1", name: "concierge", who: "user", whoId: null, why: "order-kept", text: "#3 plain" });
		expect(statuses(t)).toHaveLength(pushes + 2);
		expect(t.logs.find((l) => l.msg === "standing order kept" && l.extra!.id === 2)).toEqual({ level: "info", msg: "standing order kept", extra: { id: 2, by: "concierge", when: "every 1m" } });
		expect(t.ord()).toMatchObject({ next: 4 });
		expect(t.ord().orders.map((o) => o.id)).toEqual([1, 2, 3]);
		expect(t.c.status().orders).toBe(3);
		expect(((await t.c.op("concierge-order", hub, { action: "list" })) as any).orders.map((o: any) => o.id)).toEqual([1, 2, 3]);
		expect(((await t.c.op("concierge-order", hub, { action: "list" })) as any).order).toBeUndefined();
		// drop: the id is never used again
		const rm = (await t.c.op("concierge-order", hub, { action: "rm", id: 3 })) as any;
		expect(rm.orders.map((o: any) => o.id)).toEqual([1, 2]);
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j1", name: "concierge", who: "user", whoId: null, why: "order-dropped", text: "#3 plain" });
		expect(t.ord().next).toBe(4);
		expect(((await t.c.op("concierge-order", hub, { action: "add", text: "four" })) as any).order.id).toBe(4);
		expect(t.logs.find((l) => l.msg === "standing order dropped")).toEqual({ level: "info", msg: "standing order dropped", extra: { id: 3, by: "user" } });
	});

	it("refuses what is not an order, a bad clock, a full list; names the action", async () => {
		const t = setup();
		const add = (a: Record<string, unknown>) => code(t.c.op("concierge-order", hub, { action: "add", ...a }));
		expect(await add({ text: "" })).toBe("bad_request: empty order");
		expect(await add({ text: " \n " })).toBe("bad_request: empty order");
		expect(await add({ text: 5 })).toBe("bad_request: empty order");
		expect(await add({ text: "x", when: "whenever" })).toMatch(/^bad_request: when: when: "every 30m"/);
		expect(await add({ text: "x", when: "every 0m" })).toBe("bad_request: when: every: one minute at least");
		expect(t.c.status().orders).toBe(0);
		expect(t.ctl.orderSaves).toBe(0);
		// a blank `when` or a non-string is none
		expect(((await t.c.op("concierge-order", hub, { action: "add", text: "a", when: "  " })) as any).order.when).toBeNull();
		expect(((await t.c.op("concierge-order", hub, { action: "add", text: "b", when: 5 })) as any).order.when).toBeNull();
		// the text is one line and cut
		const long = ((await t.c.op("concierge-order", hub, { action: "add", text: `x\ny${"z".repeat(ORDER_TEXT_MAX + 50)}` })) as any).order;
		expect(long.text).toHaveLength(ORDER_TEXT_MAX);
		expect(long.text.startsWith("x y")).toBe(true);
		for (let i = 0; i < ORDER_MAX - 3; i++) await t.c.op("concierge-order", hub, { action: "add", text: `o${i}` });
		expect(t.c.status().orders).toBe(ORDER_MAX);
		expect(await add({ text: "one too many" })).toBe(`full: ${ORDER_MAX} standing orders at most; drop one first`);
		expect(t.c.status().orders).toBe(ORDER_MAX);
		expect(await code(t.c.op("concierge-order", hub, { action: "zzz", id: 1 }))).toBe("bad_request: action must be add, rm, list or applied");
	});

	it("rm and applied name an order that exists; a number or its string", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge-order", hub, { action: "add", text: "mine" });
		await t.c.op("concierge-order", cc, { action: "add", text: "its" });
		for (const id of [9, "9", "abc", undefined, 1.5, null]) expect(await code(t.c.op("concierge-order", hub, { action: "rm", id }))).toMatch(/^not_found: no standing order #/);
		expect(await code(t.c.op("concierge-order", hub, { action: "rm", id: 9 }))).toBe("not_found: no standing order #9");
		expect(await code(t.c.op("concierge-order", hub, { action: "rm" }))).toBe("not_found: no standing order #undefined");
		// the user's order is the user's to drop; the concierge drops its own; the hub drops any
		expect(await code(t.c.op("concierge-order", cc, { action: "rm", id: 1 }))).toBe("unsupported: #1 is the user's order: only the hub drops it");
		expect(t.c.status().orders).toBe(2);
		await t.c.op("concierge-order", cc, { action: "rm", id: "2" });
		expect(t.recorded.at(-1)).toMatchObject({ who: "concierge", whoId: "j1", why: "order-dropped", text: "#2 its" });
		await t.c.op("concierge-order", cc, { action: "add", text: "its again" });
		await t.c.op("concierge-order", hub, { action: "rm", id: 3 });
		await t.c.op("concierge-order", hub, { action: "rm", id: 1 });
		expect(t.c.status().orders).toBe(0);
		expect(t.ord()).toEqual({ next: 4, orders: [] });
	});

	it("applied is the concierge's to say: counted, dated, in the feed with its note or the order's text", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge-order", hub, { action: "add", text: "when build ends, tell deploy" });
		expect(await code(t.c.op("concierge-order", hub, { action: "applied", id: 1 }))).toBe("unsupported: the concierge marks an order applied");
		expect(await code(t.c.op("concierge-order", cc, { action: "applied", id: 5 }))).toBe("not_found: no standing order #5");
		await t.go(1000);
		const osaves = t.ctl.orderSaves;
		const r = (await t.c.op("concierge-order", cc, { action: "applied", id: 1, text: " told deploy:\x01 build passed " })) as any;
		expect(r.order).toMatchObject({ id: 1, count: 1, lastAt: T0 + 1000 });
		expect(t.recorded.at(-1)).toEqual({ kind: "concierge", id: "j1", name: "concierge", who: "concierge", whoId: "j1", why: "order", text: "#1 told deploy: build passed" });
		expect(t.ctl.orderSaves).toBe(osaves + 1);
		expect(t.ord().orders[0]).toMatchObject({ count: 1, lastAt: T0 + 1000 });
		await t.c.op("concierge-order", cc, { action: "applied", id: 1 });
		expect(t.recorded.at(-1)!.text).toBe("#1 when build ends, tell deploy");
		expect(t.c.status().orders).toBe(1);
		expect(((await t.c.op("concierge-order", hub, { action: "list" })) as any).orders[0]).toMatchObject({ count: 2 });
		// an order applied never moves its clock
		expect(t.ord().orders[0].nextAt).toBeNull();
	});

	it("applied without a job of its own records on the peer's id", async () => {
		const t = setup();
		await t.c.op("concierge-order", hub, { action: "add", text: "o" });
		await t.c.op("concierge-order", cc, { action: "applied", id: 1 });
		expect(t.recorded.at(-1)).toMatchObject({ id: "j1", why: "order" });
		// with a job, the event is about it, whoever says it
		const u = setup();
		await u.up();
		await u.c.op("concierge-order", hub, { action: "add", text: "o" });
		await u.c.op("concierge-order", other, { action: "applied", id: 1 });
		expect(u.recorded.at(-1)).toMatchObject({ id: "j1", whoId: "j9", why: "order" });
	});

	it("the digest lists them all, the ones kept by the concierge marked", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge-order", hub, { action: "add", text: "user rule" });
		await t.c.op("concierge-order", cc, { action: "add", text: "own rule" });
		t.happen();
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered[0]).toContain("- #1 user rule\n");
		expect(t.delivered[0]).toContain("- #2 own rule (kept by you)");
	});

	it("loads the file as the daemon keeps it ({next, orders}) and a bare list; bad entries are dropped and said", async () => {
		const entry = (o: Record<string, unknown>) => ({ id: 1, text: "t", when: null, by: "user", at: 100, lastAt: null, nextAt: null, count: 0, ...o });
		const t = setup({
			savedOrders: {
				next: 20,
				orders: [
					entry({ id: 3, when: "every 1m", nextAt: 555, lastAt: 7, count: 2, by: "concierge", at: 50 }),
					entry({ id: 0 }),
					entry({ id: -1 }),
					entry({ id: 1.5 }),
					entry({ id: 4, text: "" }),
					entry({ id: 5, text: 7 }),
					entry({ id: 6, when: "whenever" }),
					entry({ id: 7, by: "other", at: "x", count: -1, nextAt: 9, lastAt: "no" }),
					entry({ id: 8, when: "every 2m", at: 0, nextAt: "soon" }),
					entry({ id: 9, text: `${"x".repeat(600)}`, count: 1.5 }),
					null,
					5,
				],
			},
		});
		t.c.load();
		const list = ((await t.c.op("concierge-order", hub, { action: "list" })) as any).orders;
		expect(list.map((o: any) => o.id)).toEqual([3, 7, 8, 9]);
		expect(list[0]).toEqual({ id: 3, text: "t", when: "every 1m", by: "concierge", at: 50, lastAt: 7, nextAt: 555, count: 2 });
		expect(list[1]).toEqual({ id: 7, text: "t", when: null, by: "user", at: T0, lastAt: null, nextAt: null, count: 0 });
		// a clock without a nextAt gets the next time after now, counted from when it was made
		expect(list[2]).toMatchObject({ when: "every 2m", at: 0, nextAt: 120_000 * Math.floor(T0 / 120_000) + 120_000 });
		expect(list[3].text).toHaveLength(500);
		expect(list[3].count).toBe(0);
		expect(t.logs.filter((l) => l.msg === "standing order dropped").map((l) => l.extra!.id)).toEqual([6]);
		// the next id is past everything used
		expect(((await t.c.op("concierge-order", hub, { action: "add", text: "n" })) as any).order.id).toBe(20);
		// a bare list is taken too; with no `next`, past the largest id
		const u = setup({ savedOrders: [entry({ id: 4, text: "old" }), entry({ id: 2, text: "older" })] });
		u.c.load();
		expect(((await u.c.op("concierge-order", hub, { action: "list" })) as any).orders.map((o: any) => o.text)).toEqual(["older", "old"]);
		expect(((await u.c.op("concierge-order", hub, { action: "add", text: "n" })) as any).order.id).toBe(5);
		// `next` below the ids in use does not reuse any
		const v = setup({ savedOrders: { next: 2, orders: [entry({ id: 6 })] } });
		v.c.load();
		expect(((await v.c.op("concierge-order", hub, { action: "add", text: "n" })) as any).order.id).toBe(7);
		// an empty file, junk, a file without a list: no orders
		for (const junk of [undefined, null, 5, "x", {}, { orders: "no" }]) {
			const w = setup({ savedOrders: junk });
			w.c.load();
			expect(w.c.status().orders).toBe(0);
			expect(((await w.c.op("concierge-order", hub, { action: "add", text: "n" })) as any).order.id).toBe(1);
		}
	});

	it("keeps their ids over a restart: a dropped #5 is not the next order's", async () => {
		const t = setup();
		for (let i = 0; i < 5; i++) await t.c.op("concierge-order", hub, { action: "add", text: `o${i}` });
		await t.c.op("concierge-order", hub, { action: "rm", id: 5 });
		const t2 = setup({ from: t });
		t2.c.load();
		expect(((await t2.c.op("concierge-order", hub, { action: "add", text: "n" })) as any).order.id).toBe(6);
	});

	it("a clock order that came due while the service was off is due at once, once", async () => {
		const t = setup({ savedOrders: { next: 2, orders: [{ id: 1, text: "morning", when: "every 1m", by: "user", at: 0, lastAt: null, nextAt: T0 - 5000, count: 0 }] } });
		await t.up();
		t.c.load();
		t.c.start();
		t.delivered.length = 0;
		await t.go(30_000);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain("Due now");
		expect(t.ord().orders[0].nextAt).toBeGreaterThan(T0 + 30_000);
		await t.go(60_000, 30_000);
		expect(t.delivered).toHaveLength(2);
		t.c.stop();
	});

	it("a file that cannot be written is logged, not thrown", async () => {
		const t = setup();
		await t.up();
		t.ctl.storeThrows = true;
		t.ctl.ordersThrow = true;
		await t.c.op("concierge-say", cc, { kind: "info", text: "i" });
		await t.c.op("concierge-order", hub, { action: "add", text: "o" });
		expect(t.logs.filter((l) => l.level === "error").map((l) => l.msg)).toEqual(["concierge state not saved", "standing orders not saved"]);
		expect(t.logs.filter((l) => l.level === "error").map((l) => l.extra)).toEqual([{ error: "Error: disk full" }, { error: "Error: disk full" }]);
		expect(t.c.status().orders).toBe(1);
	});
});

describe("names and the rest", () => {
	it("the name is its own; a namesake is no concierge", async () => {
		const t = setup();
		expect(t.c.safeName("zzz", "concierge")).toBeNull();
		expect(t.c.safeName("zzz", "other")).toBe("other");
		expect(t.c.safeName("zzz", null)).toBeNull();
		expect(t.c.safeName("zzz", undefined)).toBeNull();
		await t.up();
		expect(t.c.safeName("zzz", "concierge")).toBeNull();
		expect(t.c.safeName("j1", "concierge")).toBe("concierge");
		expect(t.c.safeName("j1", null)).toBeNull();
	});

	it("who is the concierge: the job, the peer that is a job, its events", async () => {
		const t = setup();
		expect(t.c.isConcierge("j1")).toBe(false);
		expect(t.c.isConcierge(null)).toBe(false);
		expect(t.c.isConcierge(undefined)).toBe(false);
		expect(t.c.isConcierge("")).toBe(false);
		expect(t.c.own({ id: "j1" })).toBe(false);
		expect(t.c.own({ id: "x", whoId: null })).toBe(false);
		await t.up();
		expect(t.c.isConcierge("j1")).toBe(true);
		expect(t.c.isConcierge("j2")).toBe(false);
		expect(t.c.isPeer({ kind: "job", id: "j1" })).toBe(true);
		expect(t.c.isPeer({ kind: "fg", id: "j1" })).toBe(false);
		expect(t.c.isPeer({ kind: "job", id: "j2" })).toBe(false);
		expect(t.c.own({ id: "j1" })).toBe(true);
		expect(t.c.own({ id: "x", whoId: "j1" })).toBe(true);
		expect(t.c.own({ id: "x", whoId: null })).toBe(false);
		expect(t.c.own({ id: "x" })).toBe(false);
		// off keeps the job: it is still the concierge's
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.c.isConcierge("j1")).toBe(true);
	});
});

// Found by taking each guard of the module out in turn (M70): what the tests above did not see.
describe("edges", () => {
	it("a state file with a bad id, cursor, wakes, answer, policy or answered entries is cleaned; the next save writes it clean", async () => {
		const t = setup({
			saved: {
				id: "",
				on: true,
				cursor: "x",
				wakes: [1, "x", 3],
				answer: { at: 4 },
				policy: { answer: "always", act: "yes" },
				answered: [
					...Array.from({ length: 22 }, (_, i) => ({ id: `k${i}`, text: "t", at: i, name: "n", undone: false })),
					{ text: "t", at: 1, name: "n", undone: false },
					{ id: "a", at: 1, name: "n", undone: false },
					{ id: "a", text: "t", name: "n", undone: false },
				],
			},
		});
		t.feed.push({ seq: 1, at: 1, kind: "state", id: "w", name: "w" } as RoostEvent, { seq: 2, at: 1, kind: "state", id: "w", name: "w" } as RoostEvent);
		t.c.load();
		expect(t.c.status()).toMatchObject({ id: null, answer: null, policy: { answer: "never", act: false } });
		await t.c.op("concierge", hub, { action: "act", act: true });
		expect(t.st()).toMatchObject({ id: null, cursor: 0, wakes: [1, 3] });
		expect(t.st().answered.map((a: any) => a.id)).toEqual(Array.from({ length: 20 }, (_, i) => `k${i + 2}`));
		expect(t.st().answered).toHaveLength(20);
		// a cursor that is not a number is zero: all of the feed is behind
		const u = setup({ saved: { id: "j1", on: true, cursor: "x" } });
		u.jobs.set("j1", { live: true });
		u.feed.push({ seq: 1, at: 1, kind: "state", id: "w", name: "w" } as RoostEvent, { seq: 2, at: 1, kind: "state", id: "w", name: "w" } as RoostEvent);
		u.c.load();
		expect(u.c.status().behind).toBe(2);
	});

	it("an order file entry: a `when` that is not a string is no clock; one that does not parse drops the order even with a nextAt; a text of control characters is kept", async () => {
		const e = (o: Record<string, unknown>) => ({ id: 1, text: "t", when: null, by: "user", at: 100, lastAt: null, nextAt: null, count: 0, ...o });
		const t = setup({ savedOrders: [e({ id: 1, when: 5 }), e({ id: 2, when: "whenever", nextAt: 5 }), e({ id: 3, text: "\x01\x02" })] });
		t.c.load();
		const list = ((await t.c.op("concierge-order", hub, { action: "list" })) as any).orders;
		expect(list.map((o: any) => [o.id, o.when, o.nextAt])).toEqual([
			[1, null, null],
			[3, null, null],
		]);
		expect(list[1].text).toBe("\x01\x02");
		expect(t.logs.filter((l) => l.msg === "standing order dropped").map((l) => l.extra!.id)).toEqual([2]);
	});

	it("a clock that never comes (a date that does not exist) has no next time and is never due", async () => {
		const t = setup({ cfg: { heartbeat: "off" } });
		await t.up();
		t.c.start();
		const r = (await t.c.op("concierge-order", hub, { action: "add", text: "never", when: "cron 0 0 31 2 *" })) as any;
		expect(r.order).toMatchObject({ when: "cron 0 0 31 2 *", nextAt: null });
		await t.go(10 * 60_000, 30_000);
		expect(t.delivered).toHaveLength(0);
		t.c.stop();
	});

	it("the next time of a late order counts from when it was made, not from the wake", async () => {
		const t = setup({ tickMs: 40_000, cfg: { heartbeat: "off" } });
		await t.up();
		t.c.start();
		await t.c.op("concierge-order", hub, { action: "add", text: "o", when: "every 1m" });
		await t.go(80_000, 40_000);
		expect(t.delivered).toHaveLength(1);
		expect(t.ord().orders[0].nextAt).toBe(T0 + 120_000);
		t.c.stop();
	});

	it("an order wake and a heartbeat due at the same tick are one wake", async () => {
		const t = setup({ heartbeatMs: 30_000 });
		await t.up();
		t.c.start();
		await t.c.op("concierge-order", hub, { action: "add", text: "o", when: "every 1m" });
		await t.go(60_000, 30_000);
		expect(t.delivered.map((d) => /why="(\w+)"/.exec(d)![1])).toEqual(["heartbeat", "order"]);
		t.c.stop();
	});

	it("the tick leaves a wake that is waiting for its coalesce, and one under way; off or going down it does not even look at the budget", async () => {
		const t = setup({ heartbeatMs: 30_000 });
		await t.up();
		t.c.start();
		await t.go(28_000, 28_000);
		t.happen("late news");
		t.c.nudge();
		// the tick at 30 s finds the heartbeat due and the coalesce pending: the coalesced wake (33 s) is the one
		await t.go(2000);
		expect(t.delivered).toHaveLength(0);
		await t.go(3000);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain('why="events"');
		// under way: the tick at 90 s finds the heartbeat due and wakes; the one at 120 s must not remember a second
		t.delivered.length = 0;
		const release = t.hold();
		await t.go(60_000, 5000);
		expect(t.delivered).toHaveLength(1);
		await t.go(30_000, 5000);
		expect(t.delivered).toHaveLength(1);
		release();
		await flush();
		expect(t.delivered).toHaveLength(1);
		t.c.stop();
		// the budget flag is the tick's business only while it is on and the daemon is up
		const over = (u: ReturnType<typeof setup>) => u.addRow("j1", "concierge", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, today: 5, day: localMidnight(T0), sub: false, models: {} } });
		const u = setup({ cfg: { dailyBudgetUsd: 1 }, heartbeatMs: 30_000 });
		await u.up();
		over(u);
		await u.c.op("concierge", hub, { action: "off" });
		u.c.start();
		await u.go(30_000);
		expect(u.c.status().overBudget).toBe(false);
		const v = setup({ cfg: { dailyBudgetUsd: 1 }, heartbeatMs: 30_000 });
		await v.up();
		over(v);
		v.ctl.shutting = true;
		v.c.start();
		await v.go(30_000);
		expect(v.c.status().overBudget).toBe(false);
	});

	it("an on of a job that is up but switched off goes through: cursor, a wake, the flag; a launch of null is refused", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge", hub, { action: "off" });
		t.jobs.get("j1")!.live = true;
		t.happen("meanwhile");
		const s = await t.c.op("concierge", hub, { action: "on" });
		expect(s).toMatchObject({ on: true, behind: 0 });
		expect(t.st()).toMatchObject({ on: true, cursor: 1 });
		await flush();
		expect(t.delivered).toHaveLength(1);
		const u = setup();
		expect(await code(u.c.op("concierge", hub, { action: "on", launch: null }))).toMatch(/^bad_request/);
	});

	it("an on saves its state before the wake (a wake that does not reach leaves it), and strips the request id of the launch", async () => {
		const t = setup();
		await t.up();
		await t.c.op("concierge", hub, { action: "off" });
		t.ctl.result = { outcome: "x", reached: false };
		t.happen("while off");
		await t.go(1000);
		await t.c.op("concierge", hub, { action: "on" });
		await flush();
		expect(t.st()).toMatchObject({ on: true, cursor: 1, onAt: T0 + 1000 });
		const u = setup();
		await u.c.op("concierge", hub, { action: "on", launch: { ...LAUNCH, requestId: "r1" } });
		expect(u.dispatches[0]!.launch.requestId).toBeUndefined();
		expect("requestId" in u.dispatches[0]!.launch).toBe(true);
	});

	it("a new concierge job starts within budget: the flag the old one left is not pushed with the new one's first status", async () => {
		const t = setup({ cfg: { dailyBudgetUsd: 1 } });
		await t.up();
		t.addRow("j1", "concierge", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, today: 5, day: localMidnight(T0), sub: false, models: {} } });
		t.happen();
		t.c.nudge();
		await t.go(5000);
		expect(t.c.status().overBudget).toBe(true);
		t.c.removed("j1");
		t.rows.delete("j1");
		t.pushed.length = 0;
		await t.turnOn();
		expect((t.pushed[0] as any).status.overBudget).toBe(false);
	});

	it("a switch off clears the pending wake so the next nudge is a wake again", async () => {
		const t = setup();
		await t.up();
		t.happen("a");
		t.c.nudge();
		await t.c.op("concierge", hub, { action: "off" });
		await t.c.op("concierge", hub, { action: "on" });
		await flush();
		t.delivered.length = 0;
		t.happen("b");
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain("b");
	});

	it("a hold by the cap while a wake is already waiting adds no second timer; a held heartbeat is tried again as a heartbeat", async () => {
		const t = setup({ cfg: { wakesPerHour: 1 } });
		await t.up();
		t.happen();
		t.c.nudge();
		t.jobs.get("j1")!.live = false;
		expect(t.pending()).toBe(1);
		// an `on` of the ended job wakes it at once: held by the cap, while the coalesce is pending
		await t.c.op("concierge", hub, { action: "on" });
		expect(t.pending()).toBe(1);
		t.c.stop();
		// a held heartbeat is a heartbeat when it goes (no tick here to ask again)
		const u = setup({ cfg: { wakesPerHour: 1 } });
		await u.up();
		await u.c.op("concierge", hub, { action: "off" });
		await u.c.op("concierge", hub, { action: "on" });
		expect(u.delivered).toHaveLength(0);
		expect(u.pending()).toBe(1);
		await u.go(3600_000 + 60_000, 60_000);
		expect(u.delivered).toHaveLength(1);
		expect(u.delivered[0]).toContain('why="heartbeat"');
	});

	it("a wake exactly an hour after the one that filled the cap goes", async () => {
		const t = setup({ cfg: { wakesPerHour: 1 } });
		await t.up();
		await t.go(3600_000 - 5000, 600_000);
		t.happen();
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
	});

	it("the digest carries the board", async () => {
		const t = setup();
		await t.up();
		t.ctl.board = [{ id: 1, title: "write the docs", detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: T0, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: null, waiting: [] }] as never;
		t.happen();
		t.c.nudge();
		await t.go(5000);
		expect(t.delivered[0]).toContain("The board (");
		expect(t.delivered[0]).toContain("write the docs");
	});

	it("a failed delivery forgets the nudge that came meanwhile (the retry covers it)", async () => {
		const t = setup();
		await t.up();
		t.happen("a");
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		t.happen("b");
		t.c.nudge();
		t.ctl.failDeliver = 1;
		release();
		await flush();
		expect(t.pending()).toBe(1);
		await t.go(60_000);
		expect(t.delivered).toHaveLength(2);
		expect(t.pending()).toBe(0);
	});

	it("a nudge that came while it was off or replaced is nobody's: nothing goes out after", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		// off, on (a heartbeat is remembered), off again, then the wake ends
		await t.c.op("concierge", hub, { action: "off" });
		await t.c.op("concierge", hub, { action: "on" });
		await t.c.op("concierge", hub, { action: "off" });
		expect(t.terminated).toEqual(["j1", "j1"]);
		release();
		await flush();
		expect(t.delivered).toHaveLength(1);
		// a wake of a switched off concierge does not terminate it again
		expect(t.terminated).toEqual(["j1", "j1"]);
	});

	it("a wake for a job that was replaced meanwhile is not recorded and does not stop the old job", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		t.c.removed("j1");
		await t.turnOn();
		expect(t.c.status().id).toBe("j2");
		release();
		await flush();
		expect(t.terminated).toEqual([]);
		expect(t.st().wakes).toEqual([T0 + 5000]);
		expect(t.st().id).toBe("j2");
	});

	it("a wake the first `on` started, for a job replaced in the same instant, is not recorded", async () => {
		const t = setup();
		const release = t.hold();
		await t.turnOn();
		expect(t.delivered).toHaveLength(1);
		t.c.removed("j1");
		await t.turnOn();
		expect(t.c.status().id).toBe("j2");
		release();
		await flush();
		expect(t.terminated).toEqual([]);
		expect(t.st()).toMatchObject({ id: "j2", wakes: [T0] });
		expect(t.delivered).toHaveLength(2);
	});

	it("an on during a wake: the wake is not the new epoch's to record", async () => {
		const t = setup();
		await t.up();
		t.happen();
		t.c.nudge();
		const release = t.hold();
		await t.go(5000);
		await t.c.op("concierge", hub, { action: "off" });
		await t.go(1);
		await t.c.op("concierge", hub, { action: "on" });
		release();
		await flush();
		expect(t.st().wakes).toEqual([T0, T0 + 5001]);
		expect(t.st().cursor).toBe(1);
	});

	it("what was remembered during a wake: a heartbeat is not turned into an events wake by a later nudge", async () => {
		const t = setup();
		await t.up();
		t.happen("x");
		t.c.nudge();
		// the ended job is `on` again while a coalesce is pending: the first wake is under way, the timer comes during it
		t.jobs.get("j1")!.live = false;
		const release = t.hold();
		await t.c.op("concierge", hub, { action: "on" });
		t.jobs.get("j1")!.live = false;
		await t.c.op("concierge", hub, { action: "on" });
		await t.go(5000);
		expect(t.delivered).toHaveLength(1);
		release();
		await flush();
		expect(t.delivered).toHaveLength(2);
		expect(t.delivered[1]).toContain('why="heartbeat"');
	});

	it("an events wake that came during a wake is still a wake after it", async () => {
		const t = setup();
		await t.up();
		t.happen("x");
		t.c.nudge();
		t.jobs.get("j1")!.live = false;
		const release = t.hold();
		await t.c.op("concierge", hub, { action: "on" });
		// the coalesce timer fires during the wake the `on` started
		await t.go(5000);
		t.happen("y");
		release();
		await flush();
		expect(t.pending()).toBe(1);
		await t.go(5000);
		expect(t.delivered.length).toBeGreaterThanOrEqual(2);
		expect(t.delivered.at(-1)).toContain("y");
	});

	it("act policy is kept and pushed; an order dropped is pushed; a long suggestion is clipped in the feed", async () => {
		const t = setup();
		await t.up();
		const n = statuses(t).length;
		await t.c.op("concierge", hub, { action: "act", act: true });
		expect(t.st().policy).toEqual({ answer: "never", act: true });
		expect(statuses(t)).toHaveLength(n + 1);
		await t.c.op("concierge-order", hub, { action: "add", text: "o" });
		const m = statuses(t).length;
		await t.c.op("concierge-order", hub, { action: "rm", id: 1 });
		expect(statuses(t)).toHaveLength(m + 1);
		t.addRow("j1", "concierge");
		t.addRow("w1", "worker", { state: "blocked", waitingFor: "question", question: "q" });
		await t.c.op("concierge-suggest", cc, { id: "w1", text: "s".repeat(1000) });
		expect(t.recorded.at(-1)!.text).toBe(clipText("s".repeat(1000)));
		expect(t.recorded.at(-1)!.text).toHaveLength(300);
	});
});
