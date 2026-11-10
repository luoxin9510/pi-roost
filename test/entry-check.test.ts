// M76: the daemon checks the simple ops' arguments at its entry by their schemas
// (lib/protocol-schema.ts), saying what each hand check said, and refusing nothing the
// daemon took before. The daemon's own answers are in daemon/comms/callers-matrix tests.
import { describe, expect, it } from "vitest";
import { MESSAGE_MAX } from "../lib/comms.ts";
import { ORDER_TEXT_MAX } from "../lib/concierge.ts";
import { ArgSchemas, argsProblem, ENTRY_CHECKED } from "../lib/protocol-schema.ts";
import type { Schema } from "../lib/schema.ts";
import { TASK_ACTIONS } from "../lib/protocol-schema.ts";

const TASK_WORDS = `action must be one of ${TASK_ACTIONS.join(", ")}`;

/** Places a check could fail with words of its own ("must be a string"), not the daemon's. */
function unworded(s: Schema, path: string, out: string[], root = false, discriminant?: string): void {
	if (s["x-loose"]) return;
	// an object whose fields are the op's (M77: spawn's launch): its own words only
	if (s["x-shallow"]) {
		if (!s.message) out.push(path);
		return;
	}
	if (s.anyOf) {
		// a discriminated union: its words for a wrong discriminant, then the member picked
		if (!root && !s.message) out.push(path);
		for (const m of s.anyOf) unworded(m, path, out, true, s["x-discriminant"]);
		return;
	}
	if (!root && !s.message) out.push(path);
	for (const [k, p] of Object.entries(s.properties ?? {})) if (k !== discriminant) unworded(p, `${path}.${k}`, out);
	if (s.items) unworded(s.items, `${path}[]`, out);
	if (s.additionalProperties) unworded(s.additionalProperties, `${path}{}`, out);
}

describe("the entry check", () => {
	it("covers every op (M77: dispatch, spawn and task too)", () => {
		expect([...ENTRY_CHECKED].sort()).toEqual(Object.keys(ArgSchemas).sort());
		expect(argsProblem("nope", {})).toBeUndefined();
	});

	it("says `missing args` for a dispatch with none, as dispatch() did; an array was read as no fields", () => {
		expect(argsProblem("dispatch", undefined)).toBe("missing args");
		expect(argsProblem("dispatch", null)).toBe("missing args");
		expect(argsProblem("dispatch", "x")).toBe("missing args");
		expect(argsProblem("dispatch", [])).toBeUndefined();
		// a loose op's words are its module's: no arguments is not refused here
		expect(argsProblem("concierge-order", null)).toBeUndefined();
	});

	it("says only the daemon's words: each field it checks carries them, the rest is loose", () => {
		const out: string[] = [];
		for (const op of ENTRY_CHECKED) {
			const s = ArgSchemas[op as keyof typeof ArgSchemas] as Schema;
			// a union's words are the root's own (a wrong discriminant)
			if (s.anyOf && !s["x-loose"] && !s.message) out.push(op);
			unworded(s, op, out, true);
		}
		expect(out).toEqual([]);
	});

	it("takes arguments that are not an object as none", () => {
		expect(argsProblem("resolve", "x")).toBe("query required");
		expect(argsProblem("resolve", null)).toBe("query required");
		expect(argsProblem("resolve", [1])).toBe("query required");
		expect(argsProblem("ping", "x")).toBeUndefined();
		expect(argsProblem("concierge", undefined)).toBe("action must be on, off, status, answer, act or undo");
	});

	// [op, args, the daemon's words]: each hand check's refusal, now the schema's
	const refused: [string, unknown, string][] = [
		["resolve", {}, "query required"],
		["resolve", { query: "" }, "query required"],
		["stop", { id: 3 }, "id required"],
		["rm", {}, "id required"],
		["pin", { id: "" }, "id required"],
		["rename", { id: "a" }, "empty name"],
		["rename", { id: "a", name: " \n " }, "empty name"],
		["rename", { name: "x" }, "id required"],
		["reorder", { key: "k" }, "ids must be job ids"],
		["reorder", { ids: ["a", ""], key: "k" }, "ids must be job ids"],
		["reorder", { ids: ["a", 2], key: "k" }, "ids must be job ids"],
		["reorder", { ids: [] }, "key required"],
		["reply", { id: "a", text: "  " }, "empty reply"],
		["reply", { id: "a", text: 5 }, "empty reply"],
		["reply", { text: "x" }, "id required"],
		["reply", { id: "a", text: "x", requestId: "has space" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["reply", { id: "a", text: "x", requestId: "x".repeat(65) }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["reply", { id: "a", text: "x", requestId: 7 }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["hello", {}, "protocol must be a version number"],
		["hello", { protocol: 0 }, "protocol must be a version number"],
		["hello", { protocol: 1.5 }, "protocol must be a version number"],
		["hello", { protocol: "1" }, "protocol must be a version number"],
		["peer_register", { name: "x" }, "pid must be a live process"],
		["peer_register", { pid: "12" }, "pid must be a live process"],
		// not an integer: no process (process.kill throws), refused in the same words before
		["peer_register", { pid: 1.5 }, "pid must be a live process"],
		["send", { message: "hi" }, "to required"],
		["send", { to: " ", message: "hi" }, "to required"],
		["send", { to: "b" }, "empty message"],
		["send", { to: "b", message: "\n\t" }, "empty message"],
		["events", { after: "3" }, "after must be a number"],
		["events", { limit: true }, "limit must be a number"],
		["events", { id: "" }, "id must be a job id"],
		["events", { id: 4 }, "id must be a job id"],
		["watch", { when: "idle" }, "id required"],
		["watch", { id: "  ", when: "idle" }, "id required"],
		["watch", { id: "b" }, "when must be idle or ended"],
		["watch", { id: "b", when: "soon" }, "when must be idle or ended"],
		["schedule-add", {}, "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit"],
		["schedule-add", { name: "-x" }, "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit"],
		["schedule-add", { name: "x".repeat(41) }, "name: 1-40 of A-Z a-z 0-9 _ . -, starting with a letter or digit"],
		["concierge", { action: "bogus" }, "action must be on, off, status, answer, act or undo"],
		["concierge", { action: "answer" }, "answer must be never, routine or always"],
		["concierge", { action: "answer", answer: "sometimes" }, "answer must be never, routine or always"],
		["concierge", { action: "act", act: "yes" }, "act must be true or false"],
		["concierge-ask", { text: " " }, "empty question"],
		["concierge-say", { kind: "info" }, "empty text"],
		["concierge-say", { text: "x", kind: "shout" }, "kind must be info, need or answer"],
		["concierge-suggest", { text: "x" }, "id required"],
		["concierge-suggest", { id: "a", text: "" }, "empty suggestion"],
		// M77
		["dispatch", { requestId: "a b" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["dispatch", { requestId: null, cwd: "/" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["spawn", {}, "launch required"],
		["spawn", { launch: "x" }, "launch required"],
		["spawn", { launch: null }, "launch required"],
		["task", {}, TASK_WORDS],
		["task", { action: "bogus", mode: "ff" }, TASK_WORDS],
		["task", { action: 3 }, TASK_WORDS],
		["task", { action: "add" }, "a task needs a title"],
		["task", { action: "add", title: " \n " }, "a task needs a title"],
		["task", { action: "add", title: 7 }, "a task needs a title"],
		["task", { action: "add", title: "t", after: 3 }, "after must be a list of task ids"],
		["task", { action: "add", title: "t", after: null }, "after must be a list of task ids"],
	];
	it.each(refused)("%s %j: %s", (op, args, words) => {
		expect(argsProblem(op, args)).toBe(words);
	});

	// what the daemon took before (dropped, cut, filtered, or checked later in the op's own words)
	const taken: [string, unknown][] = [
		["list", { cwd: 5, all: "yes" }],
		["respawn", {}],
		["respawn", { all: true }],
		["pin", { id: "a", pinned: "yes" }],
		["shutdown", { keepWorkers: 1 }],
		["reply", { id: "a", text: " x ", mode: "sideways" }],
		["reply", { id: "a", text: "x", requestId: "a:b.c_d-1" }],
		["ack", { id: 1, token: 2 }],
		["report", { id: 1, report: { state: "done", status: "idle", summary: 4, choices: "x" } }],
		["hello", { protocol: 2, agent: "x", capabilities: [1, "a", null] }],
		["peer_register", { pid: 1, name: 3, cwd: null, session: 4 }],
		["send", { to: " b ", message: ` ${"m".repeat(MESSAGE_MAX + 10)} ` }],
		["handback", {}],
		["handback", { state: "nope", result: 3 }],
		["peer_ack", { ref: 9 }],
		["events", { after: 1.5, limit: -1 }],
		["schedule-add", { name: "nightly", when: 3, launch: "x", task: 1, catchUp: "no" }],
		["schedule-rm", { name: 3 }],
		["schedule-pause", {}],
		["schedule-run", {}],
		["concierge", { action: "on" }],
		["concierge", { action: "on", launch: "x" }],
		["concierge", { action: "status", answer: "bogus" }],
		["concierge-say", { text: "\u0001", kind: "info" }],
		["concierge-suggest", { id: "a", text: "\u0001" }],
		["concierge-reply", {}],
		["concierge-act", {}],
		["concierge-act", { what: "bogus" }],
		["concierge-order", { action: "add", text: "o".repeat(ORDER_TEXT_MAX + 10), when: 5 }],
		["concierge-order", { action: "rm", id: "3" }],
		["concierge-order", { action: "applied" }],
		["concierge-order", { action: "list", text: 3 }],
		["concierge-policy", { x: 1 }],
		// M77: a resend returns its job before anything else is read; the rest is dispatch()'s, the op's, the module's
		["dispatch", { cwd: 5, command: "x", requestId: "r-1" }],
		["dispatch", {}],
		["spawn", { launch: [] }],
		["spawn", { launch: { kind: "shell", command: 3 } }],
		["task", { action: "claim", id: "3" }],
		["task", { action: "claim" }],
		["task", { action: "list", project: 5 }],
		["task", { action: "add", title: "t".repeat(500), detail: 4, after: ["x", -1], project: 9 }],
		// control characters only: refused by the op (its words), not here
		["task", { action: "add", title: "\u0001" }],
		["task", { action: "start", id: 1, launch: 5 }],
		["task", { action: "merge", id: 1, mode: "squash" }],
		["task", { action: "comment", id: 1, comment: "x" }],
		["task", { action: "cleanup", dry: "yes" }],
		// for a job that ended, any report is taken; an order's action is looked up by its id first
		["report", { report: "x" }],
		["report", { report: { state: "nope" } }],
		["concierge-order", {}],
		["concierge-order", { action: "bogus" }],
		["concierge-order", { action: "add", text: " " }],
	];
	it.each(taken)("%s %j: taken", (op, args) => {
		expect(argsProblem(op, args)).toBeUndefined();
	});
});
