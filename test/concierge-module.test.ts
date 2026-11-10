// M69: the Concierge module through its own interface (a smoke test: the seams are usable).
// Its rules are tested in process in M70. Fake ports, in-memory stores, a manual clock.
import { describe, expect, it } from "vitest";
import { CONCIERGE_DEFAULTS } from "../lib/concierge.ts";
import { createConcierge, type ConciergePeer } from "../lib/concierge-module.ts";
import type { RoostEvent } from "../lib/events.ts";
import type { DispatchArgs, Event, JobRow } from "../lib/protocol.ts";
import { OpError } from "../lib/op.ts";
import { manualClock } from "./support/clock.ts";

type Conn = { peer?: ConciergePeer };
const hub: Conn = {};
const T0 = 1_000_000;

function setup() {
	const { clock, advance, pending } = manualClock(T0);
	const jobs = new Map<string, { live: boolean }>();
	const feed: RoostEvent[] = [];
	const delivered: string[] = [];
	const pushed: Event[] = [];
	const recorded: Omit<RoostEvent, "seq" | "at">[] = [];
	let saved: unknown;
	let savedOrders: unknown;
	let n = 0;
	const record = (e: Omit<RoostEvent, "seq" | "at">) => {
		recorded.push(e);
		feed.push({ ...e, seq: feed.length + 1, at: clock.now() } as RoostEvent);
	};
	const c = createConcierge<Conn>({
		sessions: {
			require: (conn) => {
				if (!conn.peer) throw new OpError("unauthorized", "not a peer");
				return conn.peer;
			},
			optional: (conn) => conn.peer,
			asHub: async () => ({}),
		},
		jobs: {
			exists: (id) => jobs.has(id),
			live: (id) => !!jobs.get(id)?.live,
			row: () => undefined,
			list: () => [] as JobRow[],
			stateOf: () => undefined,
			launchOf: () => undefined,
			sessionFileUsed: () => false,
			pathExists: () => false,
			async dispatch() {
				const id = `j${++n}`;
				jobs.set(id, { live: true });
				return { id, name: "concierge" };
			},
			respawn: async () => undefined,
			terminate: async (id) => void (jobs.get(id)!.live = false),
			reply: async () => ({ delivered: true, saved: false }),
			async deliver(_id, text) {
				delivered.push(text);
				return { outcome: "delivered", reached: true };
			},
			pushJob: () => {},
		},
		events: {
			since: ({ after }) => ({ events: feed.filter((e) => e.seq > after), cursor: feed.length }),
			cursor: () => feed.length,
		},
		store: { read: () => saved, write: (v) => void (saved = JSON.parse(JSON.stringify(v))) },
		ordersStore: { read: () => savedOrders, write: (v) => void (savedOrders = JSON.parse(JSON.stringify(v))) },
		record,
		push: (e) => void pushed.push(e),
		log: () => {},
		config: () => CONCIERGE_DEFAULTS,
		board: () => [],
		shuttingDown: () => false,
		clock,
		coalesceMs: 5000,
		retryMs: 60_000,
		tickMs: 30_000,
	});
	const turnOn = () => c.op("concierge", hub, { action: "on", launch: { kind: "pi", cwd: "/x", command: ["pi"] } as DispatchArgs });
	return { c, advance, pending, delivered, pushed, record, recorded, turnOn, jobs, feed };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createConcierge", () => {
	it("is off at first, on after `on`, off after `off`", async () => {
		const t = setup();
		expect(t.c.status()).toMatchObject({ on: false, id: null });
		expect(await t.turnOn()).toMatchObject({ on: true, id: "j1" });
		expect(t.c.isConcierge("j1")).toBe(true);
		expect(await t.c.op("concierge", hub, { action: "off" })).toMatchObject({ on: false });
		expect(t.jobs.get("j1")!.live).toBe(false);
	});

	it("keeps, lists and drops a standing order", async () => {
		const t = setup();
		const added = (await t.c.op("concierge-order", hub, { action: "add", text: "say what finished" })) as { order: { id: number } };
		expect(added.order.id).toBe(1);
		expect(t.c.status().orders).toBe(1);
		expect(((await t.c.op("concierge-order", hub, { action: "list" })) as { orders: unknown[] }).orders).toHaveLength(1);
		await t.c.op("concierge-order", hub, { action: "rm", id: 1 });
		expect(t.c.status().orders).toBe(0);
	});

	it("refuses an unknown action and an op that needs a peer from the hub", async () => {
		const t = setup();
		await expect(t.c.op("concierge", hub, { action: "nope" })).rejects.toMatchObject({ code: "bad_request" });
		await expect(t.c.op("concierge-policy", hub, {})).rejects.toMatchObject({ code: "unauthorized" });
	});

	it("wakes on a clock order when the tick finds it due", async () => {
		const t = setup();
		await t.turnOn();
		await flush();
		t.delivered.length = 0;
		t.c.start();
		await t.c.op("concierge-order", hub, { action: "add", text: "check the board", when: "every 1m" });
		t.advance(30_000);
		await flush();
		expect(t.delivered).toHaveLength(0);
		t.advance(60_000);
		await flush();
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]).toContain("check the board");
		t.c.stop();
	});

	it("coalesces a burst of events into one wake after the wait", async () => {
		const t = setup();
		await t.turnOn();
		await flush();
		t.delivered.length = 0;
		for (let i = 0; i < 3; i++) {
			t.record({ kind: "state", id: "other", name: "other" });
			t.c.nudge();
		}
		t.advance(4000);
		await flush();
		expect(t.delivered).toHaveLength(0);
		t.advance(1500);
		await flush();
		expect(t.delivered).toHaveLength(1);
	});

	it("does not count its own events as news", async () => {
		const t = setup();
		await t.turnOn();
		await flush();
		t.delivered.length = 0;
		const ev = { id: "j1", name: "concierge" };
		expect(t.c.own(ev)).toBe(true);
		expect(t.c.own({ id: "x", whoId: "j1" })).toBe(true);
		expect(t.c.own({ id: "x", whoId: null })).toBe(false);
	});

	it("keeps its name its own", async () => {
		const t = setup();
		await t.turnOn();
		expect(t.c.safeName("zzz", "concierge")).toBeNull();
		expect(t.c.safeName("j1", "concierge")).toBe("concierge");
	});

	it("stop clears every timer", async () => {
		const t = setup();
		await t.turnOn();
		await flush();
		t.c.start();
		t.c.nudge();
		expect(t.pending()).toBeGreaterThan(0);
		t.c.stop();
		expect(t.pending()).toBe(0);
	});
});
