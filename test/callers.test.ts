import { describe, expect, it } from "vitest";
import { allow, callerOf, ORDER_ACTIONS, POLICY, policyKey, TASK_ACTIONS } from "../lib/callers.ts";

const concierge = (id: string) => id === "cc";
const person = callerOf({}, concierge);
const unregistered = callerOf({ agentSide: true }, concierge);
const job = callerOf({ peer: { kind: "job", id: "j1" } }, concierge);
const fg = callerOf({ peer: { kind: "fg", id: "f1" } }, concierge);
const cc = callerOf({ peer: { kind: "job", id: "cc" } }, concierge);

describe("M63: callers", () => {
	it("judges a connection: no word is the Person; an agent's word without a peer, Unregistered; a peer a Session or the Concierge", () => {
		expect(person).toEqual({ kind: "person" });
		expect(unregistered).toEqual({ kind: "unregistered" });
		expect(job).toEqual({ kind: "session", form: "job", id: "j1" });
		expect(fg).toEqual({ kind: "session", form: "fg", id: "f1" });
		expect(cc).toEqual({ kind: "concierge", id: "cc" });
		// a peer is a peer, whatever else the connection said
		expect(callerOf({ peer: { kind: "fg", id: "f1" }, agentSide: true }, concierge).kind).toBe("session");
	});

	it("a row for every task and order action, and the op's own row for one not named", () => {
		for (const a of TASK_ACTIONS) expect(policyKey("task", a)).toBe(`task.${a}`);
		for (const a of ORDER_ACTIONS) expect(policyKey("concierge-order", a)).toBe(`concierge-order.${a}`);
		expect(policyKey("task", "nonsense")).toBe("task");
		expect(policyKey("task", undefined)).toBe("task");
		expect(policyKey("nonsense")).toBeUndefined();
		// a name from the prototype is not a row
		expect(policyKey("toString")).toBeUndefined();
		expect(policyKey("task", "constructor")).toBe("task");
	});

	it("the Person's ops: refused to everyone else with the same words", () => {
		for (const op of ["dispatch", "stop", "rm", "shutdown", "subscribe", "reply", "schedule-add"]) {
			expect(allow(person, op)).toBeNull();
			for (const c of [job, fg, cc, unregistered]) expect(allow(c, op)).toEqual({ code: "unsupported", message: expect.stringContaining("the hub's and the CLI's") });
		}
	});

	it("a session's ops are a peer's: the Person and an Unregistered agent are not one", () => {
		for (const op of ["send", "spawn", "watch", "peers"]) {
			expect(allow(job, op)).toBeNull();
			expect(allow(fg, op)).toBeNull();
			expect(allow(cc, op)).toBeNull();
			expect(allow(person, op)?.code).toBe("unauthorized");
			expect(allow(unregistered, op)?.code).toBe("unauthorized");
		}
	});

	it("the form of a session: a background one hands back, a foreground one acknowledges", () => {
		expect(allow(job, "handback")).toBeNull();
		expect(allow(cc, "handback")).toBeNull();
		expect(allow(fg, "handback")?.message).toBe("only a background session reports back");
		expect(allow(fg, "peer_ack")).toBeNull();
		expect(allow(job, "peer_ack")?.message).toBe("only foreground peers acknowledge reports");
		expect(allow(cc, "peer_ack")?.message).toBe("only foreground peers acknowledge reports");
	});

	it("a task's workspace: merging and the rest are the Person's; the Concierge starts (its policy permitting) and sends back; never a session", () => {
		for (const a of ["merge", "verify", "pass", "abort", "commit", "approve", "pr", "shelve", "comment", "uncomment"]) {
			expect(allow(person, "task", a)).toBeNull();
			expect(allow(cc, "task", a)?.code).toBe("unsupported");
		}
		expect(allow(cc, "task", "merge")?.message).toBe("/tasks merge is a person's (the hub's)");
		expect(allow(cc, "task", "start")).toBeNull();
		expect(allow(cc, "task", "back")).toBeNull();
		for (const a of ["start", "back", "merge", "approve"]) {
			expect(allow(job, "task", a)).toEqual({ code: "unsupported", message: `/tasks ${a} is the hub's` });
			expect(allow(fg, "task", a)).toEqual({ code: "unsupported", message: `/tasks ${a} is the hub's` });
		}
	});

	it("the board: claimed by a session only; dropped and handed over by the hub and the concierge; nothing for an Unregistered agent", () => {
		expect(allow(job, "task", "claim")).toBeNull();
		expect(allow(person, "task", "claim")?.code).toBe("unsupported");
		expect(allow(cc, "task", "claim")?.code).toBe("unsupported");
		expect(allow(job, "task", "drop")?.code).toBe("unsupported");
		expect(allow(cc, "task", "assign")).toBeNull();
		expect(allow(cc, "task", "cleanup")?.code).toBe("unsupported");
		for (const a of [...TASK_ACTIONS, "nonsense"]) expect(allow(unregistered, "task", a)).toEqual({ code: "unauthorized", message: "a session acts on the board after its report is accepted" });
	});

	it("identifying and reading are anyone's; an op not in the table is left to the daemon", () => {
		for (const op of ["hello", "report", "peer_register", "ack", "ping", "list", "status", "resolve"]) for (const c of [person, job, fg, cc, unregistered]) expect(allow(c, op)).toBeNull();
		expect(allow(job, "nonsense")).toBeNull();
	});

	it("every row says each kind of caller, and a refusal is unauthorized or unsupported with words", () => {
		for (const [key, p] of Object.entries(POLICY)) {
			for (const kind of ["person", "session", "concierge", "unregistered"] as const) {
				const rules = typeof p[kind] === "object" && "job" in p[kind] ? Object.values(p[kind]) : [p[kind]];
				for (const r of rules) {
					if (r === "allow") continue;
					expect(["unauthorized", "unsupported"], key).toContain((r as { code: string }).code);
					expect((r as { message: string }).message.length, key).toBeGreaterThan(0);
				}
			}
		}
	});
});
