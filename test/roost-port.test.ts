// M71: the hub's port to the daemon: each method sends the right op and arguments through the
// client and returns the result as it came; dispatch and reply keep M51's request ids.
import { describe, expect, it } from "vitest";
import { DaemonError, type DaemonClient } from "../lib/client.ts";
import type { DispatchArgs, Event } from "../lib/protocol.ts";
import { type RoostPort, roostPort } from "../hub/roost-port.ts";
import { fakePort } from "./support/roost-port.ts";

type Sent = { op: string; args: any };

function recording(answer: (op: string, args: unknown) => unknown = (op) => ({ op })) {
	const sent: Sent[] = [];
	const listeners: ((e: Event) => void)[] = [];
	const client = {
		request: async (op: string, args: unknown) => {
			sent.push({ op, args });
			return answer(op, args);
		},
		requestAt: async (op: string, args: unknown) => {
			sent.push({ op, args });
			return { result: answer(op, args), at: 7 };
		},
		onEvent: (l: (e: Event) => void) => {
			listeners.push(l);
			return () => void listeners.splice(listeners.indexOf(l), 1);
		},
		position: () => 3,
	} as unknown as DaemonClient;
	return { client, sent, listeners };
}

const launch = { cwd: "/w", command: ["pi"], name: "x", origin: "dispatch" } as unknown as DispatchArgs;
const comment = { file: "a.ts", line: 3, text: "t", tip: "abc" };

// [name, call, op, args]
const table: [string, (p: RoostPort) => Promise<unknown>, string, unknown][] = [
	["jobs.list", (p) => p.jobs.list({ cwd: "/w" }), "list", { cwd: "/w" }],
	["jobs.stop", (p) => p.jobs.stop("a"), "stop", { id: "a" }],
	["jobs.rm", (p) => p.jobs.rm("a"), "rm", { id: "a" }],
	["jobs.pin", (p) => p.jobs.pin("a", true), "pin", { id: "a", pinned: true }],
	["jobs.rename", (p) => p.jobs.rename("a", "n"), "rename", { id: "a", name: "n" }],
	["jobs.reorder", (p) => p.jobs.reorder(["a", "b"], "k"), "reorder", { ids: ["a", "b"], key: "k" }],
	["jobs.respawn", (p) => p.jobs.respawn("a"), "respawn", { id: "a" }],
	["tasks.list", (p) => p.tasks.list(), "task", { action: "list" }],
	["tasks.list project", (p) => p.tasks.list({ project: "/r" }), "task", { action: "list", project: "/r" }],
	["tasks.add", (p) => p.tasks.add({ title: "t", detail: "d", after: [1], project: "/r" }), "task", { action: "add", title: "t", detail: "d", after: [1], project: "/r" }],
	["tasks.assign", (p) => p.tasks.assign(2, "s"), "task", { action: "assign", id: 2, to: "s" }],
	["tasks.done", (p) => p.tasks.done(2, "ok"), "task", { action: "done", id: 2, result: "ok" }],
	["tasks.drop", (p) => p.tasks.drop(2), "task", { action: "drop", id: 2 }],
	["tasks.release", (p) => p.tasks.release(2), "task", { action: "release", id: 2 }],
	["tasks.prepare", (p) => p.tasks.prepare(2), "task", { action: "prepare", id: 2 }],
	["tasks.start", (p) => p.tasks.start(2, launch), "task", { action: "start", id: 2, launch }],
	["tasks.merge", (p) => p.tasks.merge(2, "no-ff"), "task", { action: "merge", id: 2, mode: "no-ff" }],
	["tasks.back", (p) => p.tasks.back(2, "again"), "task", { action: "back", id: 2, note: "again" }],
	["tasks.abort", (p) => p.tasks.abort(2), "task", { action: "abort", id: 2 }],
	["tasks.commit", (p) => p.tasks.commit(2, "m"), "task", { action: "commit", id: 2, message: "m" }],
	["tasks.approve dry", (p) => p.tasks.approve({ id: 2, dry: true }), "task", { action: "approve", id: 2, dry: true }],
	["tasks.approve hash", (p) => p.tasks.approve({ id: 2, hash: "h" }), "task", { action: "approve", id: 2, hash: "h" }],
	["tasks.verify", (p) => p.tasks.verify(2), "task", { action: "verify", id: 2 }],
	["tasks.pass", (p) => p.tasks.pass(2), "task", { action: "pass", id: 2 }],
	["tasks.comment", (p) => p.tasks.comment(2, comment), "task", { action: "comment", id: 2, comment }],
	["tasks.uncomment", (p) => p.tasks.uncomment(2, { file: "a.ts", line: 3, at: 9 }), "task", { action: "uncomment", id: 2, comment: { file: "a.ts", line: 3, at: 9 } }],
	["tasks.shelve", (p) => p.tasks.shelve(2), "task", { action: "shelve", id: 2 }],
	["tasks.cleanup", (p) => p.tasks.cleanup(true), "task", { action: "cleanup", dry: true }],
	["tasks.pr dry", (p) => p.tasks.pr({ id: 2, dry: true }), "task", { action: "pr", id: 2, dry: true }],
	["tasks.pr hash", (p) => p.tasks.pr({ id: 2, hash: "h" }), "task", { action: "pr", id: 2, hash: "h" }],
	["concierge.status", (p) => p.concierge.status(), "concierge", { action: "status" }],
	["concierge.on", (p) => p.concierge.on(), "concierge", { action: "on" }],
	["concierge.on launch", (p) => p.concierge.on(launch), "concierge", { action: "on", launch }],
	["concierge.off", (p) => p.concierge.off(), "concierge", { action: "off" }],
	["concierge.answer", (p) => p.concierge.answer("never"), "concierge", { action: "answer", answer: "never" }],
	["concierge.act", (p) => p.concierge.act(true), "concierge", { action: "act", act: true }],
	["concierge.undo", (p) => p.concierge.undo(), "concierge", { action: "undo" }],
	["concierge.ask", (p) => p.concierge.ask("q"), "concierge-ask", { text: "q" }],
	["orders.list", (p) => p.concierge.orders.list(), "concierge-order", { action: "list" }],
	["orders.add", (p) => p.concierge.orders.add("do x"), "concierge-order", { action: "add", text: "do x" }],
	["orders.add when", (p) => p.concierge.orders.add("do x", "daily 09:00"), "concierge-order", { action: "add", text: "do x", when: "daily 09:00" }],
	["orders.rm", (p) => p.concierge.orders.rm(4), "concierge-order", { action: "rm", id: 4 }],
	["schedules.list", (p) => p.schedules.list(), "schedules", {}],
	["schedules.add", (p) => p.schedules.add({ name: "n", when: "every 1h", launch, task: "t" }), "schedule-add", { name: "n", when: "every 1h", launch, task: "t" }],
	["schedules.rm", (p) => p.schedules.rm("n"), "schedule-rm", { name: "n" }],
	["schedules.pause", (p) => p.schedules.pause("n", true), "schedule-pause", { name: "n", paused: true }],
	["schedules.run", (p) => p.schedules.run("n"), "schedule-run", { name: "n" }],
	["events.list", (p) => p.events.list({ limit: 500 }), "events", { limit: 500 }],
];

describe("RoostPort adapter", () => {
	it.each(table)("%s sends one request and returns its result", async (_name, call, op, args) => {
		const { client, sent } = recording((o) => ({ answered: o }));
		const result = await call(roostPort(client));
		expect(sent).toHaveLength(1);
		expect(sent[0]!.op).toBe(op);
		expect(sent[0]!.args).toEqual(args);
		expect(result).toEqual({ answered: op });
	});

	it("jobs.listAt returns the reply and its place in the stream", async () => {
		const { client, sent } = recording(() => ({ jobs: [] }));
		expect(await roostPort(client).jobs.listAt({})).toEqual({ result: { jobs: [] }, at: 7 });
		expect(sent).toEqual([{ op: "list", args: {} }]);
	});

	it("subscribe listens before it asks, and listen/position pass through", async () => {
		const { client, sent, listeners } = recording();
		const port = roostPort(client);
		const heard: Event[] = [];
		await port.subscribe((e) => heard.push(e));
		expect(sent).toEqual([{ op: "subscribe", args: {} }]);
		expect(listeners).toHaveLength(1);
		const off = port.listen(() => {});
		expect(listeners).toHaveLength(2);
		off();
		expect(listeners).toHaveLength(1);
		expect(port.position()).toBe(3);
	});

	it("dispatch and reply carry a request id, a given one kept", async () => {
		const { client, sent } = recording(() => ({ id: "x", name: "n" }));
		const port = roostPort(client);
		await port.jobs.dispatch(launch, { tag: "hub" });
		await port.jobs.reply({ id: "a", text: "hi" }, { tag: "hub" });
		await port.jobs.reply({ id: "a", text: "hi", requestId: "mine-1" });
		expect(sent.map((s) => s.op)).toEqual(["dispatch", "reply", "reply"]);
		expect(sent[0]!.args.requestId).toMatch(/^hub\./);
		expect(sent[1]!.args).toMatchObject({ id: "a", text: "hi" });
		expect(sent[1]!.args.requestId).toMatch(/^hub\./);
		expect(sent[2]!.args.requestId).toBe("mine-1");
	});

	it("a reply lost with the connection is sent again on the connection `via` gives, with the same id", async () => {
		const sent: Sent[] = [];
		const dead = { request: async (op: string, args: unknown) => (sent.push({ op, args }), Promise.reject(new DaemonError("daemon connection closed", "closed"))) } as unknown as DaemonClient;
		const alive = { request: async (op: string, args: unknown) => (sent.push({ op, args }), { delivered: true, saved: false }) } as unknown as DaemonClient;
		const seen: number[] = [];
		const via = async (deadline: number) => (seen.push(deadline), sent.length === 0 ? dead : alive);
		const port = roostPort(dead, via);
		const r = await port.jobs.reply({ id: "a", text: "hi" }, { tag: "hub", timeoutMs: 5000 });
		expect(r).toEqual({ delivered: true, saved: false });
		expect(sent).toHaveLength(2);
		expect(sent[1]!.args.requestId).toBe(sent[0]!.args.requestId);
		expect(seen).toHaveLength(2);
	});

	it("a refusal by the daemon is not sent again", async () => {
		const sent: Sent[] = [];
		const err = Object.assign(new DaemonError("no such session", "not_found"), { fromDaemon: true });
		const client = { request: async (op: string, args: unknown) => (sent.push({ op, args }), Promise.reject(err)) } as unknown as DaemonClient;
		await expect(roostPort(client).jobs.reply({ id: "a", text: "x" })).rejects.toBe(err);
		expect(sent).toHaveLength(1);
	});
});

describe("fakePort", () => {
	it("records calls by path and answers what it is given", async () => {
		const { port, calls } = fakePort({ "tasks.list": () => ({ tasks: [] }) });
		expect(await port.tasks.list({ project: "/r" })).toEqual({ tasks: [] });
		expect(await port.tasks.merge(1, "ff")).toEqual({});
		expect(calls).toEqual([
			{ path: "tasks.list", args: [{ project: "/r" }] },
			{ path: "tasks.merge", args: [1, "ff"] },
		]);
	});
});
