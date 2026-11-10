// M68: the Watches module through its own interface: fake ports, an in-memory store and a
// manual clock; no daemon, no waiting.
import { describe, expect, it } from "vitest";
import { MAX_WATCHES, type Relation, WATCH_TTL_MS } from "../lib/comms.ts";
import { OpError } from "../lib/op.ts";
import type { RoostEvent } from "../lib/events.ts";
import type { JobStateName } from "../lib/protocol.ts";
import { createWatches, type Watch, type Watches, type WatchedRow, type WatchesStore } from "../lib/watches.ts";
import { manualClock } from "./support/clock.ts";

const H = 3600_000;
const T0 = 1_000_000;

interface Peer {
	key: string;
	name: string;
	jobId: string | null;
	refuses?: boolean;
}

const lead: Peer = { key: "/s/lead.jsonl", name: "lead", jobId: null };
const agentA: Peer = { key: "/s/a.jsonl", name: "a", jobId: "ja" };

const row = (id: string, name: string, state: JobStateName, over: Partial<WatchedRow> = {}): WatchedRow => ({ id, name, state, waitingFor: null, question: null, summary: null, error: null, ...over });

function setup(opts: { initial?: unknown; startAt?: number; ttlMs?: number; maxPerWatcher?: number; defaults?: boolean } = {}) {
	const { clock, advance } = manualClock(opts.startAt ?? T0);
	let saved: unknown = opts.initial;
	const writes: unknown[] = [];
	const state = { saveFails: false, deliverThrows: false };
	const store: WatchesStore = {
		read: () => (saved === undefined ? undefined : JSON.parse(JSON.stringify(saved))),
		write(v) {
			if (state.saveFails) throw new Error("disk full");
			saved = JSON.parse(JSON.stringify(v));
			writes.push(saved);
		},
	};
	const jobs = new Map<string, WatchedRow>([
		["jw", row("jw", "worker", "working")],
		["jb", row("jb", "buddy", "working")],
		["ja", row("ja", "a", "working")],
	]);
	/** Jobs whose record exists but whose row does not (hidden). */
	const rowless = new Set<string>();
	const relations = new Map<string, Relation>();
	const unreachable = new Set<string>();
	const delivered: { key: string; text: string; meta: { from: string; relation: Relation } }[] = [];
	const events: Omit<RoostEvent, "seq" | "at">[] = [];
	const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
	const make = (): Watches<Peer> =>
		createWatches<Peer>({
			sessions: {
				refusesItems: (p) => p.refuses === true,
				keyOf: (p) => p.key,
				name: (p) => p.name,
				jobId: (p) => p.jobId,
				find(p, to) {
					const hit = [...jobs.values()].find((j) => j.id === to || j.name === to);
					if (hit) return { key: `/s/${hit.name}.jsonl`, id: hit.id, role: "job" };
					if (to === "lead" || to === "fg1") return { key: lead.key, id: "fg1", role: "foreground" };
					throw new OpError("not_found", `no reachable session "${to}"`);
				},
			},
			jobs: {
				exists: (id) => jobs.has(id),
				row: (id) => (rowless.has(id) ? undefined : jobs.get(id)),
				relation: (watcherKey, id) => relations.get(`${watcherKey}>${id}`) ?? "child",
				async deliver(key, text, meta) {
					if (state.deliverThrows) throw new Error("socket gone");
					delivered.push({ key, text, meta });
					return { outcome: unreachable.has(key) ? "stopped" : "delivered", reached: !unreachable.has(key) };
				},
			},
			store,
			record: (e) => void events.push(e),
			log: (level, msg, extra) => void logs.push({ level, msg, extra }),
			clock,
			...(opts.defaults ? {} : { ttlMs: opts.ttlMs ?? 2 * H, maxPerWatcher: opts.maxPerWatcher ?? 3 }),
		});
	const w = make();
	const set = (id: string, st: JobStateName, over: Partial<WatchedRow> = {}) => {
		const r = row(id, jobs.get(id)!.name, st, over);
		jobs.set(id, r);
		return r;
	};
	/** The watches in the file. */
	const filed = () => (saved ?? []) as Watch[];
	return { w, make, advance, store, jobs, rowless, relations, unreachable, delivered, events, logs, state, set, filed, writes, setSaved: (v: unknown) => void (saved = v) };
}

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: OpError) => `${e.code}: ${e.message}`);

describe("the watch op", () => {
	it("keeps a watch for a job that is working, and says so", async () => {
		const t = setup();
		expect(await t.w.add(lead, { id: "worker", when: "idle" })).toEqual({ id: "jw", name: "worker", when: "idle", fired: false });
		expect(t.filed()).toEqual([{ watcher: lead.key, watcherName: "lead", watcherId: null, id: "jw", when: "idle", at: T0 }]);
		expect(t.delivered).toEqual([]);
		expect(t.logs).toContainEqual({ level: "info", msg: "watch", extra: { id: "jw", watcher: lead.key, when: "idle" } });
	});

	it("a watching job is kept with its job id; the id is found by id or by name, trimmed", async () => {
		const t = setup();
		await t.w.add(agentA, { id: "  jb ", when: "ended" });
		expect(t.filed()).toEqual([{ watcher: agentA.key, watcherName: "a", watcherId: "ja", id: "jb", when: "ended", at: T0 }]);
	});

	it("refuses a peer that takes no agent items, before anything else", async () => {
		const t = setup();
		expect(await code(t.w.add({ ...agentA, refuses: true }, { id: "", when: "x" }))).toBe("unsupported: a watch is told as a notice: say agent-items in your hello to take one");
	});

	it("refuses a missing id, and a when that is neither idle nor ended", async () => {
		const t = setup();
		expect(await code(t.w.add(lead, undefined))).toBe("bad_request: id required");
		expect(await code(t.w.add(lead, { id: "   ", when: "idle" }))).toBe("bad_request: id required");
		expect(await code(t.w.add(lead, { id: 7, when: "idle" }))).toBe("bad_request: id required");
		expect(await code(t.w.add(lead, { id: "jw", when: "soon" }))).toBe("bad_request: when must be idle or ended");
		expect(await code(t.w.add(lead, { id: "jw" }))).toBe("bad_request: when must be idle or ended");
		expect(t.filed()).toEqual([]);
	});

	it("a session cannot watch itself; a foreground session is not watched", async () => {
		const t = setup();
		expect(await code(t.w.add({ key: "/s/worker.jsonl", name: "worker", jobId: "jw" }, { id: "worker", when: "idle" }))).toBe("bad_request: a session cannot watch itself");
		expect(await code(t.w.add(agentA, { id: "lead", when: "idle" }))).toBe("unsupported: a foreground session is not watched (it has no job state)");
		expect(t.filed()).toEqual([]);
	});

	it("an unknown session, and a job with no row, are not found", async () => {
		const t = setup();
		expect(await code(t.w.add(lead, { id: "nope", when: "idle" }))).toBe('not_found: no reachable session "nope"');
		t.rowless.add("jw");
		expect(await code(t.w.add(lead, { id: "jw", when: "idle" }))).toBe("not_found: no such job: jw");
		expect(t.filed()).toEqual([]);
	});

	it("says at once when it is already so, and keeps nothing", async () => {
		const t = setup();
		t.set("jw", "blocked", { waitingFor: "question", question: "Which branch?" });
		expect(await t.w.add(lead, { id: "jw", when: "idle" })).toEqual({ id: "jw", name: "worker", when: "idle", fired: true });
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]!.text).toContain("Which branch?");
		expect(t.writes).toEqual([]);
		expect(t.events).toEqual([expect.objectContaining({ kind: "notice", id: "jw", who: "lead", whoId: null, text: "is idle" })]);
	});

	it("for its end: already stopped or failed fires; done or working does not", async () => {
		const t = setup();
		t.set("jw", "done", { summary: "ok" });
		expect(await t.w.add(lead, { id: "jw", when: "ended" })).toMatchObject({ fired: false });
		t.set("jw", "stopped");
		expect(await t.w.add(lead, { id: "jw", when: "ended" })).toMatchObject({ fired: true });
		t.set("jb", "failed", { error: "boom" });
		expect(await t.w.add(lead, { id: "jb", when: "ended" })).toMatchObject({ fired: true });
		expect(t.delivered.map((d) => d.meta.from)).toEqual(["worker", "buddy"]);
		expect(t.events.map((e) => e.text)).toEqual(["ended", "ended"]);
		expect(t.delivered[1]!.text).toContain("boom");
	});

	it("the same watch asked again is one, with its clock restarted", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		t.advance(H);
		await t.w.add(lead, { id: "jw", when: "idle" });
		expect(t.filed()).toHaveLength(1);
		expect(t.filed()[0]!.at).toBe(T0 + H);
		// idle and ended on the same job are two
		await t.w.add(lead, { id: "jw", when: "ended" });
		expect(t.filed().map((x) => x.when)).toEqual(["idle", "ended"]);
	});

	it("a session keeps so many watches; asking again for one it has still works; another session has its own", async () => {
		const t = setup({ maxPerWatcher: 2 });
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(lead, { id: "jb", when: "idle" });
		expect(await code(t.w.add(lead, { id: "jw", when: "ended" }))).toBe("full: at most 2 watches at a time");
		expect(t.filed()).toHaveLength(2);
		expect(await t.w.add(lead, { id: "jw", when: "idle" })).toMatchObject({ fired: false });
		expect(t.filed()).toHaveLength(2);
		await t.w.add(agentA, { id: "jw", when: "idle" });
		expect(t.filed()).toHaveLength(3);
		// one that fires at once is not kept, so not counted (nor refused at the limit)
		t.set("jb", "done");
		expect(await t.w.add(lead, { id: "jb", when: "idle" })).toMatchObject({ fired: true });
		expect(t.filed().filter((x) => x.watcher === lead.key)).toHaveLength(2);
	});

	it("the defaults: 20 a session, 12 hours", async () => {
		expect(MAX_WATCHES).toBe(20);
		const t = setup({ defaults: true });
		for (let i = 0; i < 20; i++) {
			t.jobs.set(`j${i}`, row(`j${i}`, `n${i}`, "working"));
			await t.w.add(lead, { id: `j${i}`, when: "idle" });
		}
		expect(await code(t.w.add(lead, { id: "jw", when: "idle" }))).toBe("full: at most 20 watches at a time");
		t.advance(WATCH_TTL_MS - 1);
		t.w.sweep();
		expect(t.filed()).toHaveLength(20);
		t.advance(1);
		t.w.sweep();
		expect(t.filed()).toHaveLength(0);
	});

	it("a file that cannot be written is logged; the watch still stands in memory", async () => {
		const t = setup();
		t.state.saveFails = true;
		expect(await t.w.add(lead, { id: "jw", when: "idle" })).toMatchObject({ fired: false });
		expect(t.logs).toContainEqual({ level: "error", msg: "watches not saved", extra: { error: "Error: disk full" } });
		t.state.saveFails = false;
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toHaveLength(1);
	});
});

describe("a job's state changed", () => {
	it("working fires nothing", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(lead, { id: "jw", when: "ended" });
		await t.w.stateChanged(t.set("jw", "working"));
		expect(t.delivered).toEqual([]);
		expect(t.filed()).toHaveLength(2);
	});

	it.each<[JobStateName, Partial<WatchedRow>]>([
		["blocked", { waitingFor: "question", question: "Which branch?" }],
		["done", { summary: "All green." }],
		["failed", { error: "boom" }],
		["stopped", {}],
	])("an idle watch fires on %s", async (st, over) => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.stateChanged(t.set("jw", st, over));
		expect(t.delivered).toHaveLength(1);
		expect(t.filed()).toEqual([]);
		for (const v of Object.values(over)) if (st !== "blocked" || v === over.question) expect(t.delivered[0]!.text).toContain(String(v));
	});

	it.each<[JobStateName, boolean]>([
		["blocked", false],
		["done", false],
		["failed", true],
		["stopped", true],
	])("an ended watch on %s: fires %s", async (st, fires) => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "ended" });
		await t.w.stateChanged(t.set("jw", st));
		expect(t.delivered).toHaveLength(fires ? 1 : 0);
		expect(t.filed()).toHaveLength(fires ? 0 : 1);
	});

	it("a watch for its end waits through done and fires on the stop", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "ended" });
		await t.w.stateChanged(t.set("jw", "done", { summary: "ok" }));
		expect(t.delivered).toEqual([]);
		await t.w.stateChanged(t.set("jw", "stopped"));
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]!.text).toContain("has ended (stopped)");
	});

	it("tells the watcher once: a second change says nothing more", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.stateChanged(t.set("jw", "blocked", { question: "Which branch?" }));
		await t.w.stateChanged(t.set("jw", "working"));
		await t.w.stateChanged(t.set("jw", "blocked", { question: "And now?" }));
		expect(t.delivered).toHaveLength(1);
		expect(t.events.filter((e) => e.kind === "notice")).toHaveLength(1);
	});

	it("the notice: delivered to the watcher's session, from the job, with the relation, in an envelope", async () => {
		const t = setup();
		t.relations.set(`${lead.key}>jw`, "child");
		t.relations.set(`${agentA.key}>jw`, "sibling");
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(agentA, { id: "jw", when: "idle" });
		await t.w.stateChanged(t.set("jw", "blocked", { waitingFor: "question", question: "Which branch?" }));
		expect(t.delivered.map((d) => [d.key, d.meta])).toEqual([
			[lead.key, { from: "worker", relation: "child" }],
			[agentA.key, { from: "worker", relation: "sibling" }],
		]);
		const text = t.delivered[0]!.text;
		expect(text).toContain('from="worker"');
		expect(text).toContain('id="jw"');
		expect(text).toContain('relation="child"');
		expect(text).toContain('kind="notice"');
		expect(text).toContain("waits for an answer. Question: Which branch?");
		expect(t.delivered[1]!.text).toContain('relation="sibling"');
		expect(t.logs.filter((l) => l.msg === "watch fired")).toEqual([
			{ level: "info", msg: "watch fired", extra: { id: "jw", watcher: lead.key, when: "idle", outcome: "delivered" } },
			{ level: "info", msg: "watch fired", extra: { id: "jw", watcher: agentA.key, when: "idle", outcome: "delivered" } },
		]);
	});

	it("is recorded for each watcher told: who, which job, the words", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(agentA, { id: "jw", when: "idle" });
		await t.w.stateChanged(t.set("jw", "done", { summary: "ok" }));
		expect(t.events).toEqual([
			{ kind: "notice", id: "jw", name: "worker", who: "lead", whoId: null, text: "is idle" },
			{ kind: "notice", id: "jw", name: "worker", who: "a", whoId: "ja", text: "is idle" },
		]);
	});

	it("an end is recorded as ended", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.stateChanged(t.set("jw", "failed", { error: "boom" }));
		expect(t.events).toEqual([expect.objectContaining({ text: "ended" })]);
		expect(t.delivered[0]!.text).toContain("has ended (failed: boom)");
	});

	it("a watcher that is gone is not recorded as told, and the watch is forgotten", async () => {
		const t = setup();
		t.unreachable.add(lead.key);
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toHaveLength(1);
		expect(t.events).toEqual([]);
		expect(t.filed()).toEqual([]);
		expect(t.logs).toContainEqual({ level: "info", msg: "watch fired", extra: { id: "jw", watcher: lead.key, when: "idle", outcome: "stopped" } });
	});

	it("a delivery that throws is logged, not raised; the next watcher is still told", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(agentA, { id: "jw", when: "idle" });
		t.state.deliverThrows = true;
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.events).toEqual([]);
		expect(t.logs.filter((l) => l.msg === "watch notice failed")).toEqual([
			{ level: "warn", msg: "watch notice failed", extra: { id: "jw", watcher: lead.key, error: "Error: socket gone" } },
			{ level: "warn", msg: "watch notice failed", extra: { id: "jw", watcher: agentA.key, error: "Error: socket gone" } },
		]);
		expect(t.filed()).toEqual([]);
	});

	it("only the watches on that job fire; the file keeps the rest", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(lead, { id: "jb", when: "idle" });
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.filed().map((x) => x.id)).toEqual(["jb"]);
	});

	it("a change nobody watches writes nothing", async () => {
		const t = setup();
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.writes).toEqual([]);
	});
});

describe("a job removed, a watcher gone", () => {
	it("the watched job removed tells every watcher it ended, idle or ended alike", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(agentA, { id: "jw", when: "ended" });
		await t.w.add(lead, { id: "jb", when: "idle" });
		await t.w.removed("jw", "worker");
		expect(t.delivered.map((d) => [d.key, d.meta.from])).toEqual([
			[lead.key, "worker"],
			[agentA.key, "worker"],
		]);
		expect(t.delivered[0]!.text).toContain("has ended");
		expect(t.events.map((e) => [e.who, e.text])).toEqual([
			["lead", "ended"],
			["a", "ended"],
		]);
		expect(t.filed().map((x) => x.id)).toEqual(["jb"]);
	});

	it("a job nobody watches removed says nothing", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jb", when: "idle" });
		await t.w.removed("jw", "worker");
		expect(t.delivered).toEqual([]);
		expect(t.filed()).toHaveLength(1);
	});

	it("the watcher gone drops its watches and no one else's", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(lead, { id: "jb", when: "idle" });
		await t.w.add(agentA, { id: "jw", when: "idle" });
		t.w.watcherGone(lead.key);
		expect(t.filed().map((x) => x.watcher)).toEqual([agentA.key]);
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered.map((d) => d.key)).toEqual([agentA.key]);
	});

	it("a watcher with no watches changes nothing and writes nothing", async () => {
		const t = setup();
		await t.w.add(agentA, { id: "jw", when: "idle" });
		const n = t.writes.length;
		t.w.watcherGone(lead.key);
		expect(t.writes).toHaveLength(n);
		expect(t.filed()).toHaveLength(1);
	});
});

describe("expiry", () => {
	it("a watch that never fires expires at its ttl, and the file follows", async () => {
		const t = setup({ ttlMs: 2 * H });
		await t.w.add(lead, { id: "jw", when: "idle" });
		t.advance(2 * H - 1);
		t.w.sweep();
		expect(t.filed()).toHaveLength(1);
		t.advance(1);
		t.w.sweep();
		expect(t.filed()).toEqual([]);
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toEqual([]);
	});

	it("an expiry is by each watch's own time", async () => {
		const t = setup({ ttlMs: 2 * H });
		await t.w.add(lead, { id: "jw", when: "idle" });
		t.advance(H);
		await t.w.add(lead, { id: "jb", when: "idle" });
		t.advance(H + 1);
		t.w.sweep();
		expect(t.filed().map((x) => x.id)).toEqual(["jb"]);
	});

	it("a sweep drops watches on jobs that are gone", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		await t.w.add(lead, { id: "jb", when: "idle" });
		t.jobs.delete("jw");
		t.w.sweep();
		expect(t.filed().map((x) => x.id)).toEqual(["jb"]);
	});

	it("a sweep with nothing to drop writes nothing", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		const n = t.writes.length;
		t.w.sweep();
		expect(t.writes).toHaveLength(n);
	});

	it("an expired watch does not hold its place against the limit", async () => {
		const t = setup({ ttlMs: H, maxPerWatcher: 1 });
		await t.w.add(lead, { id: "jw", when: "idle" });
		t.advance(H);
		t.w.sweep();
		expect(await t.w.add(lead, { id: "jb", when: "idle" })).toMatchObject({ fired: false });
	});
});

describe("the file and a restart", () => {
	const good = (over: Partial<Watch> = {}): Watch => ({ watcher: lead.key, watcherName: "lead", watcherId: null, id: "jw", when: "idle", at: T0, ...over });

	it("a restart over the same store keeps the watches, and they fire", async () => {
		const t = setup();
		await t.w.add(lead, { id: "jw", when: "idle" });
		const again = t.make();
		again.load();
		await again.stateChanged(t.set("jw", "blocked", { question: "Still there?" }));
		expect(t.delivered).toHaveLength(1);
		expect(t.delivered[0]!.text).toContain("Still there?");
		expect(t.filed()).toEqual([]);
	});

	it("nothing is held before load()", async () => {
		const t = setup({ initial: [good()] });
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toEqual([]);
	});

	it("a restart expires by the age the file carries", async () => {
		const t = setup({ ttlMs: 2 * H });
		await t.w.add(lead, { id: "jw", when: "idle" });
		t.advance(2 * H);
		const again = t.make();
		again.load();
		await again.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toEqual([]);
	});

	it("load drops the expired, the ones on jobs that are gone, and the malformed; keeps the rest", async () => {
		const t = setup({
			ttlMs: 2 * H,
			initial: [
				good(),
				good({ at: T0 - 2 * H }),
				good({ id: "gone" }),
				good({ watcher: "" }),
				good({ id: "" }),
				good({ when: "soon" as "idle" }),
				good({ at: "yesterday" as unknown as number }),
				null,
				good({ id: "jb", when: "ended" }),
			],
		});
		t.w.load();
		await t.w.stateChanged(t.set("jb", "stopped"));
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toHaveLength(2);
		// what was kept is all that was written back
		expect(t.filed()).toEqual([]);
	});

	it.each([undefined, "x", { a: 1 }, null])("a file that is not a list (%j) is no watches", async (initial) => {
		const t = setup({ initial });
		t.w.load();
		await t.w.stateChanged(t.set("jw", "done"));
		expect(t.delivered).toEqual([]);
	});

	it("load writes nothing", () => {
		const t = setup({ initial: [good({ id: "gone" })] });
		t.w.load();
		expect(t.writes).toEqual([]);
	});

	it("the format: watcher, watcherName, watcherId, id, when, at", async () => {
		const t = setup();
		await t.w.add(agentA, { id: "jw", when: "ended" });
		expect(Object.keys(t.filed()[0]!).sort()).toEqual(["at", "id", "watcher", "watcherId", "watcherName", "when"]);
	});
});
