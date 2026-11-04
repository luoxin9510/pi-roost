import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { formatList } from "../lib/list-format.ts";
import type { JobRow } from "../lib/protocol.ts";

let n = 0;
const row = (over: Partial<JobRow> = {}): JobRow => {
	n++;
	const now = Date.now();
	return {
		id: `abcd000${n}`,
		cwd: "/home/u/proj",
		kind: "pi",
		startedAt: now - 120_000,
		state: "working",
		pid: 1,
		status: "busy",
		waitingFor: null,
		sessionFile: `/s/${n}.jsonl`,
		name: `task ${n}`,
		endedAt: null,
		summary: "running tests",
		question: null,
		choices: [],
		model: null,
		thinking: null,
		context: null,
		error: null,
		stateSince: now - 60_000,
		reaped: false,
		pinned: false,
		order: null,
		orderKey: null,
		...over,
	};
};

describe("pi-roost list", () => {
	it("waiting first, subagents left out unless asked, fits the width", () => {
		const done = row({ state: "done", status: "idle", pid: null, summary: "All green", endedAt: Date.now() - 1000 });
		const waiting = row({ state: "blocked", status: "waiting", question: "Which branch?" });
		const working = row();
		const child = row({ name: "kid", parentSession: "/s/x.jsonl", parentOpen: true });
		const out = formatList([done, working, waiting, child], { width: 80, home: "/home/u" });
		const lines = out.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^ID +STATE +NAME/);
		expect(lines[1]).toContain("Which branch?");
		expect(lines[2]).toContain("running tests");
		expect(lines[3]).toContain("All green");
		expect(lines[3]).toContain("~/proj");
		expect(out).not.toContain("kid");
		expect(lines.at(-1)).toBe("1 subagent not shown (--subagents)");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
		expect(formatList([child], { subagents: true })).toContain("↳ kid");
		for (const l of formatList([done, working, waiting], { width: 40 }).split("\n")) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
		expect(formatList([])).toBe("no background sessions\n");
	});
});
