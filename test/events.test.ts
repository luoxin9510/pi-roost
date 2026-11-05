import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clipText, EVENT_TEXT_MAX, eventAgo, eventLine, EventLog, stateMatters } from "../lib/events.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "roost-ev-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("M43: the event log", () => {
	it("appends, numbers, answers a cursor, and comes back from its file", () => {
		const log = new EventLog(join(dir, "events.jsonl"));
		expect(log.cursor()).toBe(0);
		expect(log.since()).toEqual({ events: [], cursor: 0 });
		const a = log.append({ kind: "dispatch", id: "j1", name: "one", who: "user" });
		const b = log.append({ kind: "state", id: "j1", name: "one", state: "done", from: "working", text: "finished" });
		const c = log.append({ kind: "dispatch", id: "j2", name: "two", who: "user" });
		expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
		expect(log.cursor()).toBe(3);
		// after a cursor: only what came after it, oldest first
		expect(log.since({ after: 1 }).events.map((e) => e.seq)).toEqual([2, 3]);
		expect(log.since({ after: 3 }).events).toEqual([]);
		// no cursor: the newest `limit`
		expect(log.since({ limit: 2 }).events.map((e) => e.seq)).toEqual([2, 3]);
		// one job's
		expect(log.since({ id: "j2" }).events.map((e) => e.seq)).toEqual([3]);
		expect(log.since({ id: "j1", after: 1 }).events.map((e) => e.seq)).toEqual([2]);
		// another instance on the same file sees the same, and goes on numbering
		const again = new EventLog(join(dir, "events.jsonl"));
		expect(again.cursor()).toBe(3);
		expect(again.all().map((e) => e.kind)).toEqual(["dispatch", "state", "dispatch"]);
		expect(again.append({ kind: "removed", id: "j1", name: "one" }).seq).toBe(4);
	});

	it("keeps the last `max` events, in memory and in the file; a damaged line is skipped", () => {
		const path = join(dir, "events.jsonl");
		const log = new EventLog(path, { max: 5 });
		for (let i = 0; i < 12; i++) log.append({ kind: "reply", id: "j", name: "j", text: `r${i}` });
		expect(log.all().map((e) => e.text)).toEqual(["r7", "r8", "r9", "r10", "r11"]);
		expect(log.cursor()).toBe(12);
		// the file was rewritten once it held twice the window
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines.length).toBeLessThanOrEqual(10);
		expect(JSON.parse(lines.at(-1)!).text).toBe("r11");
		// a line cut short (a crash mid-write) is skipped on load
		const again = new EventLog(path, { max: 5 });
		expect(again.all().length).toBeGreaterThan(0);
		expect(new EventLog(join(dir, "none.jsonl")).all()).toEqual([]);
	});

	it("clips texts to one short line", () => {
		expect(clipText("  a\n  b\t c ")).toBe("a b c");
		expect(clipText("")).toBeNull();
		expect(clipText(undefined)).toBeNull();
		expect(clipText("x".repeat(EVENT_TEXT_MAX + 50))!.length).toBe(EVENT_TEXT_MAX);
	});

	it("knows which state changes matter", () => {
		expect(stateMatters("working", "blocked")).toBe(true);
		expect(stateMatters("working", "done")).toBe(true);
		expect(stateMatters("working", "failed")).toBe(true);
		expect(stateMatters("working", "stopped")).toBe(true);
		expect(stateMatters("done", "working")).toBe(true);
		expect(stateMatters("blocked", "working")).toBe(true);
		expect(stateMatters("working", "working")).toBe(false);
		expect(stateMatters(undefined, "working")).toBe(false);
		expect(stateMatters(null, "working")).toBe(false);
	});

	it("says each event in one line, with how long ago", () => {
		const at = 0;
		const line = (e: Parameters<typeof eventLine>[0]) => eventLine(e);
		expect(line({ seq: 1, at, kind: "dispatch", id: "j", name: "fix tests", who: "user" })).toBe("started fix tests ← user");
		expect(line({ seq: 1, at, kind: "state", id: "j", name: "fix tests", state: "blocked", waitingFor: "question", text: "Which branch?" })).toBe("fix tests asks: Which branch?");
		expect(line({ seq: 1, at, kind: "state", id: "j", name: "fix tests", state: "blocked", waitingFor: "dialog" })).toBe("fix tests is in a dialog");
		expect(line({ seq: 1, at, kind: "state", id: "j", name: "fix tests", state: "done", text: "All green." })).toBe("fix tests finished: All green.");
		expect(line({ seq: 1, at, kind: "state", id: "j", name: "fix tests", state: "failed", text: "exit 1" })).toBe("fix tests failed: exit 1");
		expect(line({ seq: 1, at, kind: "state", id: "j", name: "fix tests", state: "stopped" })).toBe("fix tests stopped");
		expect(line({ seq: 1, at, kind: "state", id: "j", name: "fix tests", state: "working", from: "done" })).toBe("fix tests works again (was done)");
		expect(line({ seq: 1, at, kind: "reply", id: "j", name: "fix tests", who: "user", text: "use main" })).toBe("user → fix tests: use main");
		expect(line({ seq: 1, at, kind: "message", id: "j", name: "fix tests", who: "lead", text: "status?" })).toBe("lead → fix tests: status?");
		expect(line({ seq: 1, at, kind: "report", id: "j", name: "child", who: "lead", text: "Status: done." })).toBe("child reported to lead: Status: done.");
		expect(line({ seq: 1, at, kind: "notice", id: "j", name: "child", who: "lead", text: "is idle" })).toBe("lead was told child is idle");
		expect(line({ seq: 1, at, kind: "resume", id: "j", name: "fix tests", why: "crash", text: "killed" })).toBe("fix tests restarts by itself (crash): killed");
		expect(line({ seq: 1, at, kind: "schedule", id: "j", name: "nightly", who: "nightly", why: "due" })).toBe("schedule nightly started nightly (due)");
		expect(line({ seq: 1, at, kind: "removed", id: "j", name: "fix tests" })).toBe("fix tests removed");
		expect(eventAgo(0, 30_000)).toBe("30s");
		expect(eventAgo(0, 5 * 60_000)).toBe("5m");
		expect(eventAgo(0, 3 * 3600_000)).toBe("3h");
		expect(eventAgo(0, 3 * 24 * 3600_000)).toBe("3d");
	});
});
