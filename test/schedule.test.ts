import { describe, expect, it } from "vitest";
import { checkTemplate, nextCron, nextRun, parseCron, parseScheduleInput, parseWhen, RUN_SLOT, runLaunch, runSlot, templateAgent, untilText } from "../lib/schedule.ts";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const show = (t: number | null) => {
	if (t === null) return null;
	const d = new Date(t);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} (${d.getDay()})`;
};

describe("M39: schedules", () => {
	it("parses cron fields: lists, ranges, steps, Sunday as 0 or 7", () => {
		const c = parseCron("*/15 9-17 * * 1-5");
		expect([...c.minute]).toEqual([0, 15, 30, 45]);
		expect([...c.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
		expect(c.domAndDow).toBe(false);
		expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
		expect([...parseCron("5,10 0 1 1 *").minute]).toEqual([5, 10]);
		expect([...parseCron("0 0 1/10 * *").dom]).toEqual([1, 11, 21, 31]);
		for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "a * * * *", "5-1 * * * *"]) {
			expect(() => parseCron(bad), bad).toThrow();
		}
	});

	it("finds the next matching minute in local time", () => {
		const weekdays9 = parseCron("0 9 * * 1-5");
		// Friday 2026-11-06 10:00 → Monday 2026-11-09 9:00
		expect(show(nextCron(weekdays9, at(2026, 11, 6, 10)))).toBe("2026-11-9 9:00 (1)");
		// exactly at a match: the next one, not the same minute
		expect(show(nextCron(weekdays9, at(2026, 11, 9, 9)))).toBe("2026-11-10 9:00 (2)");
		expect(show(nextCron(parseCron("30 * * * *"), at(2026, 11, 5, 13, 30)))).toBe("2026-11-5 14:30 (4)");
		// end of month and year
		expect(show(nextCron(parseCron("0 0 1 * *"), at(2026, 12, 15)))).toBe("2027-1-1 0:00 (5)");
		expect(show(nextCron(parseCron("0 12 29 2 *"), at(2026, 3, 1)))).toBe("2028-2-29 12:00 (2)");
		// day of month and day of week both given: either (cron's rule)
		expect(show(nextCron(parseCron("0 8 13 * 5"), at(2026, 11, 5)))).toBe("2026-11-6 8:00 (5)");
		// never (31 February)
		expect(nextCron(parseCron("0 0 31 2 *"), at(2026, 1, 1))).toBeNull();
	});

	it("reads when: every, daily, weekdays, cron", () => {
		expect(parseWhen("every 30m")).toEqual({ every: 30 * 60_000 });
		expect(parseWhen("every 2h")).toEqual({ every: 2 * 3600_000 });
		expect(parseWhen("EVERY 1d")).toEqual({ every: 86_400_000 });
		const daily = parseWhen("daily 9:05");
		expect("cron" in daily && [...daily.cron.hour, ...daily.cron.minute]).toEqual([9, 5]);
		const wd = parseWhen("weekdays 18:00");
		expect("cron" in wd && [...wd.cron.dow]).toEqual([1, 2, 3, 4, 5]);
		expect("cron" in parseWhen('cron "0 9 * * 1"')).toBe(true);
		for (const bad of ["every 0m", "every 5s", "daily 25:00", "daily 9:60", "hourly", "cron 1 2 3", ""]) expect(() => parseWhen(bad), bad).toThrow();
	});

	it("every counts from the schedule's start; a run after a gap goes to the next slot", () => {
		const start = at(2026, 11, 5, 10);
		const h = parseWhen("every 1h");
		expect(nextRun(h, start, start)).toBe(start + 3600_000);
		expect(nextRun(h, start + 3600_000, start)).toBe(start + 2 * 3600_000);
		// the service was off for a while: the next slot after now, not a burst of missed ones
		expect(nextRun(h, start + 5.5 * 3600_000, start)).toBe(start + 6 * 3600_000);
	});

	it("fills each run's session file and command, and keeps only templates it can run", () => {
		const t = { kind: "pi" as const, cwd: "/w", sessionFile: `/s/${RUN_SLOT}.jsonl`, command: ["node", "pi", "--session", `/s/${RUN_SLOT}.jsonl`, "--", "task"], env: {}, name: "n", origin: "dispatch" as const };
		const slot = runSlot(at(2026, 11, 5, 9));
		expect(slot).toMatch(/^2026-11-0\dT\d\d-00-00-000Z_[0-9a-f-]{36}$/);
		const r = runLaunch(t, slot);
		expect(r.sessionFile).toBe(`/s/${slot}.jsonl`);
		expect(r.command[3]).toBe(`/s/${slot}.jsonl`);
		expect(t.sessionFile).toContain(RUN_SLOT);
		expect(() => checkTemplate(t)).not.toThrow();
		expect(() => checkTemplate({ ...t, sessionFile: "/s/a.jsonl" })).toThrow(/sessionFile/);
		expect(() => checkTemplate({ ...t, kind: "shell" })).toThrow(/no sessionFile/);
		expect(() => checkTemplate({ ...t, cwd: "rel" })).toThrow(/cwd/);
	});

	it("reads /schedule <name> <when> <task>", () => {
		expect(parseScheduleInput("nightly every 2h check the build and fix it")).toEqual({ name: "nightly", when: "every 2h", task: "check the build and fix it" });
		expect(parseScheduleInput("standup weekdays 9:30 summarise yesterday's commits")).toMatchObject({ when: "weekdays 9:30" });
		expect(parseScheduleInput('mon cron "0 9 * * 1" plan the week')).toEqual({ name: "mon", when: 'cron "0 9 * * 1"', task: "plan the week" });
		expect(parseScheduleInput("q cron 0 */6 * * * look at open issues")).toEqual({ name: "q", when: "cron 0 */6 * * *", task: "look at open issues" });
		expect(parseScheduleInput("a every 1h line one\nline two")).toMatchObject({ task: "line one\nline two" });
		expect(parseScheduleInput("nightly every 2h")).toHaveProperty("error");
		expect(parseScheduleInput("../x every 2h task")).toHaveProperty("error");
		expect(parseScheduleInput("x daily 25:00 task")).toHaveProperty("error");
		expect(parseScheduleInput("x hourly task")).toHaveProperty("error");
	});

	it("says how long until a run", () => {
		const now = 1_000_000_000_000;
		expect(untilText(now - 5, now)).toBe("now");
		expect(untilText(now + 30_000, now)).toBe("in <1m");
		expect(untilText(now + 5 * 60_000, now)).toBe("in 5m");
		expect(untilText(now + 125 * 60_000, now)).toBe("in 2h 05m");
		expect(untilText(now + 50 * 3600_000, now)).toBe("in 2d 2h");
	});

	it("never goes back in the hour a DST change repeats, nor skips past", () => {
		const tz = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			// 2026-11-01: 01:00-02:00 happens twice (EDT, then EST); 06:30Z is 01:30 EST, the second time
			const after = Date.UTC(2026, 10, 1, 6, 30);
			for (const expr of ["* * * * *", "*/5 * * * *", "0 * * * *", "30 1 * * *"]) {
				const next = nextCron(parseCron(expr), after);
				expect(next, expr).not.toBeNull();
				expect(next! > after, expr).toBe(true);
				expect(next! - after, expr).toBeLessThan(25 * 3600_000);
			}
			expect(nextCron(parseCron("* * * * *"), after)).toBe(after + 60_000);
			// spring forward (2026-03-08, 02:00-03:00 does not exist): a 02:30 run waits a day
			const spring = nextCron(parseCron("30 2 * * *"), Date.UTC(2026, 2, 8, 5, 0));
			expect(new Date(spring!).toISOString()).toBe("2026-03-09T06:30:00.000Z");
		} finally {
			if (tz === undefined) delete process.env.TZ;
			else process.env.TZ = tz;
		}
	});

	it("a leading * keeps cron's day rule (and); a task saying {{run}} is left alone", () => {
		expect(parseCron("0 0 */2 * 1").domAndDow).toBe(false);
		expect(parseCron("0 0 1 * 1").domAndDow).toBe(true);
		const file = `/s/${RUN_SLOT}.jsonl`;
		const t = { kind: "pi" as const, cwd: "/w", sessionFile: file, command: ["pi", "--session", file, "--", `explain ${RUN_SLOT}`], env: {}, name: "n", origin: "dispatch" as const };
		const r = runLaunch(t, "SLOT");
		expect(r.command).toEqual(["pi", "--session", "/s/SLOT.jsonl", "--", `explain ${RUN_SLOT}`]);
		expect(() => checkTemplate({ ...t, command: ["pi", "--", "x"] })).toThrow(/name its sessionFile/);
	});

	it("M40: a command or a terminal agent is a template too, run as it is each time", () => {
		const cmd = { kind: "shell" as const, cwd: "/w", sessionFile: "", command: ["sh", "-lc", "make"], env: {}, name: "n", origin: "dispatch" as const };
		expect(() => checkTemplate(cmd)).not.toThrow();
		expect(runLaunch(cmd, "SLOT")).toEqual(cmd);
		expect(templateAgent(cmd)).toBe("shell");
		expect(templateAgent({ ...cmd, profile: "claude" })).toBe("claude");
		expect(templateAgent({ ...cmd, kind: undefined, sessionFile: `/s/${RUN_SLOT}.jsonl` })).toBe("pi");
		expect(() => checkTemplate({ ...cmd, sessionFile: "/s/x.jsonl" })).toThrow(/no sessionFile/);
		expect(() => checkTemplate({ ...cmd, worktree: { path: "/x", branch: "b", repo: "/r", base: "m" } })).toThrow(/worktree/);
	});
});
