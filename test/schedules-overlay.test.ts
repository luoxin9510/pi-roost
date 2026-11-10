// M73: the schedules overlay on its own: a fake port, a fake host.
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSchedulesOverlay } from "../hub/overlays/schedules.ts";
import type { ScheduleRow } from "../lib/protocol.ts";
import { fakeHost } from "./support/overlay-host.ts";
import { expectCloseKeys, KEY, strip, tagTheme } from "./support/overlay-keys.ts";
import { fakePort } from "./support/roost-port.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
afterEach(() => vi.useRealTimers());

const sch = (name: string, extra: Partial<ScheduleRow> = {}): ScheduleRow => ({ name, when: "every 2h", task: "check the build", agent: "pi", cwd: "/w", model: null, paused: false, catchUp: false, nextAt: NOW + 90 * MIN, lastRunAt: NOW - 30 * MIN, lastJob: null, lastSkip: null, ...extra });

async function open(list: ScheduleRow[], over: { termRows?: number; tag?: boolean } = {}) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	const p = fakePort({ "schedules.list": () => ({ schedules: list }) });
	const h = fakeHost(p.port, { ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}) });
	const overlay = await createSchedulesOverlay(h.host);
	return { ...h, overlay: overlay!, maybe: overlay, calls: p.calls };
}

describe("M73: the schedules overlay", () => {
	it("asks the daemon for the list, once, and renders the title, each schedule in two lines, the keys", async () => {
		const { overlay, calls } = await open([sch("nightly")]);
		overlay.render(100);
		overlay.render(100);
		expect(calls).toEqual([{ path: "schedules.list", args: [] }]);
		expect(overlay.render(100)).toEqual(["Schedules", "", "nightly  every 2h  · next in 1h 30m · last 30m ago", "  check the build  · pi · /w", "", "/schedule run|pause|resume|rm <name> · ↑↓ scroll · Esc close"]);
	});

	it("none: says how to add one, opens nothing", async () => {
		const { maybe, said } = await open([]);
		expect(maybe).toBeUndefined();
		expect(said).toEqual([{ text: 'no schedules: /schedule <name> <every 1h | daily 09:00 | weekdays 09:00 | cron "…"> <task>', tone: undefined }]);
	});

	it("a failed load throws to the command, which says it", async () => {
		const h = fakeHost(fakePort({ "schedules.list": () => Promise.reject(new Error("daemon down")) }).port);
		await expect(createSchedulesOverlay(h.host)).rejects.toThrow("daemon down");
		expect(h.said).toEqual([]);
	});

	it("a paused one says paused (warning) in place of its next run", async () => {
		const out = (await open([sch("tests", { paused: true })], { tag: true })).overlay.render(100);
		expect(out[2]).toBe("⟨accent⟩tests⟨/accent⟩  every 2h  · ⟨warning⟩paused⟨/warning⟩ · last 30m ago");
	});

	it("an unpaused one with no next run says never; a paused one with none says paused", async () => {
		const out = (await open([sch("once", { nextAt: null }), sch("both", { nextAt: null, paused: true })])).overlay.render(100);
		expect(out[2]).toContain("· never · last 30m ago");
		expect(out[4]).toContain("· paused ·");
	});

	it("a schedule that never ran says so", async () => {
		expect((await open([sch("new", { lastRunAt: null })])).overlay.render(100)[2]).toContain("· not run yet");
	});

	it("the second line: the task on one line, the agent, the directory, the model when there is one, all dim", async () => {
		const out = (await open([sch("deps", { task: "update the\ndependencies", agent: "codex", cwd: "/p/x", model: "o3-mini" }), sch("blank", { task: null })], { tag: true })).overlay.render(200);
		expect(out[3]).toBe("⟨dim⟩  update the dependencies  · codex · /p/x · o3-mini⟨/dim⟩");
		expect(out[5]).toBe("⟨dim⟩    · pi · /w⟨/dim⟩");
	});

	it("the last skip, when there is one: how long ago and why, on one line, warning", async () => {
		const out = (await open([sch("a", { lastSkip: { at: NOW - 5 * MIN, why: "the previous run\nwas still going" } }), sch("b")], { tag: true })).overlay.render(200);
		expect(out[4]).toBe("⟨warning⟩  skipped 5m ago: the previous run was still going⟨/warning⟩");
		expect(out[5]).toContain("⟨accent⟩b⟨/accent⟩");
	});

	it("cuts every line to the width", async () => {
		const out = (await open([sch("long", { task: "x".repeat(200), lastSkip: { at: NOW, why: "y".repeat(200) } })])).overlay.render(40);
		for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
	});

	it("fits the terminal: rows - 6 lines, a blank, the keys; 30 when unknown; at least 3", async () => {
		const many = Array.from({ length: 30 }, (_, i) => sch(`s${i}`));
		expect((await open(many, { termRows: 20 })).overlay.render(100)).toHaveLength(14 + 2);
		expect((await open(many, { termRows: 0 })).overlay.render(100)).toHaveLength(24 + 2);
		expect((await open(many, { termRows: 4 })).overlay.render(100)).toHaveLength(3 + 2);
	});

	it("scrolls with ↑↓ and clamps at both ends", async () => {
		const many = Array.from({ length: 10 }, (_, i) => sch(`s${i}`));
		const { overlay } = await open(many, { termRows: 9 });
		const first = () => strip(overlay.render(200))[0]!;
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		expect(first()).toContain("s0  every 2h");
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("");
		for (let i = 0; i < 100; i++) overlay.handleInput!(KEY.down);
		const end = strip(overlay.render(200));
		expect(end.slice(0, 3)).toEqual(["  check the build  · pi · /w", "s9  every 2h  · next in 1h 30m · last 30m ago", "  check the build  · pi · /w"]);
		overlay.handleInput!(KEY.up);
		expect(strip(overlay.render(200))[0]).not.toBe(end[0]);
	});

	it("a short list is shown whole, in colour, however it was scrolled", async () => {
		const { overlay } = await open([sch("a")], { tag: true });
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		const whole = ["**Schedules**", "", "⟨accent⟩a⟨/accent⟩  every 2h  · next in 1h 30m · last 30m ago", "⟨dim⟩  check the build  · pi · /w⟨/dim⟩", "", "⟨dim⟩/schedule run|pause|resume|rm <name> · ↑↓ scroll · Esc close⟨/dim⟩"];
		expect(overlay.render(200)).toEqual(whole);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(overlay.render(200)).toEqual(whole);
		expect(visibleWidth((await open([sch("a")])).overlay.render(20).at(-1)!)).toBeLessThanOrEqual(20);
	});

	it("after the terminal got smaller, shows from the top, not the end", async () => {
		let rows = 60;
		const h = fakeHost(fakePort({ "schedules.list": () => ({ schedules: [sch("a"), sch("b")] }) }).port, { termRows: () => rows });
		const overlay = (await createSchedulesOverlay(h.host))!;
		overlay.render(100);
		rows = 9;
		expect(overlay.render(100)[0]).toBe("Schedules");
	});

	it("Esc, Enter, Ctrl+C and q close it; other keys do not", async () => {
		const made = await Promise.all(Array.from({ length: 12 }, () => open([sch("x")])));
		let i = 0;
		expectCloseKeys(() => ({ overlay: made[i]!.overlay, log: made[i++]!.log }));
	});
});
