// M74: the log overlay on its own: a fake port, a fake host.
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogOverlay, type LogOpts } from "../hub/overlays/log.ts";
import type { RoostEvent } from "../lib/events.ts";
import { fakeHost, tick } from "./support/overlay-host.ts";
import { expectCloseKeys, KEY, strip, tagTheme } from "./support/overlay-keys.ts";
import { fakePort } from "./support/roost-port.ts";

const NOW = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

const ev = (seq: number, ago: number, over: Partial<RoostEvent> = {}): RoostEvent => ({ seq, at: NOW - ago, kind: "dispatch", id: "j1", name: "fix tests", who: "user", ...over });

async function open(feed: () => RoostEvent[] | Promise<RoostEvent[]>, opts: LogOpts = {}, over: { termRows?: number; tag?: boolean } = {}) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	const p = fakePort({ "events.list": async () => ({ events: await feed(), cursor: 0 }) });
	const h = fakeHost(p.port, { ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}) });
	const overlay = await createLogOverlay(h.host, opts);
	return { ...h, overlay: overlay!, maybe: overlay, calls: p.calls };
}

const some = () => [ev(1, 7200_000), ev(2, 600_000, { kind: "state", state: "done", from: "working", text: "all green" }), ev(3, 5_000, { kind: "message", who: "lead", text: "use main" })];

describe("M74: the log overlay", () => {
	it("asks for 500 events, once; title, newest first with its age, the keys", async () => {
		const { overlay, calls } = await open(some);
		overlay.render(100);
		expect(calls).toEqual([{ path: "events.list", args: [{ limit: 500 }] }]);
		expect(overlay.render(100)).toEqual(["Log · what happened lately (newest first)", "", "    5s  lead → fix tests: use main", "   10m  fix tests finished: all green", "    2h  started fix tests ← user", "", "r reload · ↑↓ scroll · Esc close"]);
	});

	it("the tone of each kind: failed error, blocked warning, done success, message/report/notice accent, the rest muted", async () => {
		const feed = [
			ev(1, 9000, { kind: "state", state: "failed", text: "x" }),
			ev(2, 8000, { kind: "state", state: "blocked", text: "q" }),
			ev(3, 7000, { kind: "state", state: "done" }),
			ev(4, 6000, { kind: "message", who: "a" }),
			ev(5, 5000, { kind: "report", who: "a" }),
			ev(6, 4000, { kind: "notice", who: "a" }),
			ev(7, 3000, { kind: "state", state: "working", from: "blocked" }),
			ev(8, 2000, { kind: "dispatch" }),
			ev(9, 1000, { kind: "reply" }),
		];
		const out = (await open(() => feed, {}, { tag: true })).overlay.render(100);
		const tones = out.slice(2, 11).map((l) => /⟨dim⟩[^⟩]*⟨\/dim⟩  ⟨([a-z]+)⟩/.exec(l)![1]);
		expect(tones).toEqual(["muted", "muted", "muted", "accent", "accent", "accent", "success", "warning", "error"]);
		expect(out[0]).toBe("**Log · what happened lately (newest first)**");
		expect(out[out.length - 1]).toBe("⟨dim⟩r reload · ↑↓ scroll · Esc close⟨/dim⟩");
	});

	it("only a state event's state sets its tone; a line is one line whatever the event carries", async () => {
		const feed = [ev(1, 3000, { kind: "dispatch", state: "failed" }), ev(2, 2000, { kind: "dispatch", state: "blocked" }), ev(3, 1000, { kind: "dispatch", state: "done" }), ev(4, 500, { kind: "resume", why: "two\nlines", text: null })];
		const out = (await open(() => feed, {}, { tag: true })).overlay.render(100);
		expect(out.slice(2, 6).map((l) => /⟨dim⟩[^⟩]*⟨\/dim⟩  ⟨([a-z]+)⟩/.exec(l)![1])).toEqual(["muted", "muted", "muted", "muted"]);
		expect(out[2]).toContain("restarts by itself (two lines)");
		expect(out).toHaveLength(2 + 4 + 2);
	});

	it("a page is ten lines, a line is one; keys pressed before a render cannot push the top above the first line", async () => {
		const feed = Array.from({ length: 60 }, (_, i) => ev(i + 1, (60 - i) * 1000, { kind: "message", who: "lead", text: `note ${i}` }));
		const all = strip((await open(() => feed, {}, { termRows: 200 })).overlay.render(100));
		const first = (o: { render(w: number): string[] }) => strip(o.render(100))[0];
		const a = (await open(() => feed)).overlay;
		a.handleInput!(KEY.pageDown);
		expect(first(a)).toBe(all[10]);
		a.handleInput!(KEY.down);
		a.handleInput!(KEY.down);
		a.handleInput!(KEY.down);
		a.handleInput!(KEY.up);
		expect(first(a)).toBe(all[12]);
		const b = (await open(() => feed)).overlay;
		b.handleInput!(KEY.up);
		b.handleInput!(KEY.up);
		b.handleInput!(KEY.down);
		expect(first(b)).toBe(all[1]);
		const c = (await open(() => feed)).overlay;
		c.handleInput!("\x1b[5~");
		c.handleInput!("\x1b[5~");
		c.handleInput!(KEY.pageDown);
		expect(first(c)).toBe(all[10]);
		// the end: a full room, not one line short
		const d = (await open(() => feed)).overlay;
		for (let i = 0; i < 20; i++) d.handleInput!(KEY.pageDown);
		expect(d.render(100)).toHaveLength(24 + 2);
	});

	it("a title and a filter: only what it accepts, under its title", async () => {
		const { overlay } = await open(some, { only: (e) => e.kind === "message", title: "Log · lint (newest first)" });
		expect(strip(overlay.render(100))).toEqual(["Log · lint (newest first)", "", "    5s  lead → fix tests: use main", "", "r reload · ↑↓ scroll · Esc close"]);
	});

	it("keeps the newest 200 of what the daemon sent, after the filter", async () => {
		const feed = Array.from({ length: 300 }, (_, i) => ev(i + 1, (300 - i) * 1000, { kind: "message", who: "lead", text: `note ${i}` }));
		const { overlay } = await open(() => feed, {}, { termRows: 400 });
		const text = strip(overlay.render(100)).join("\n");
		expect(text).toContain("note 299");
		expect(text).toContain("note 100");
		expect(text).not.toContain("note 99\n");
		const evens = await open(() => feed, { only: (e) => e.seq % 2 === 0 }, { termRows: 400 });
		const kept = strip(evens.overlay.render(100)).filter((l) => l.includes("note")).length;
		expect(kept).toBe(150);
	});

	it("nothing yet: says so and opens nothing; with a filter it says nothing from the concierge", async () => {
		const a = await open(() => []);
		expect(a.maybe).toBeUndefined();
		expect(a.said).toEqual([{ text: "nothing happened yet (the log starts with the next task, reply or message)", tone: undefined }]);
		const b = await open(some, { only: () => false });
		expect(b.maybe).toBeUndefined();
		expect(b.said).toEqual([{ text: "nothing from the concierge yet", tone: undefined }]);
	});

	it("a failed load says the error and opens nothing", async () => {
		const a = await open(() => Promise.reject(new Error("daemon down")));
		expect(a.maybe).toBeUndefined();
		expect(a.said).toEqual([{ text: "daemon down", tone: "error" }]);
	});

	it("r reads the feed again and draws it; a failed reload keeps what is shown, quietly", async () => {
		let feed: () => RoostEvent[] | Promise<RoostEvent[]> = some;
		const { overlay, log, calls, said } = await open(() => feed());
		const before = log.renders;
		feed = () => [...some(), ev(4, 1000, { kind: "message", who: "lead", text: "fresh" })];
		overlay.handleInput!("r");
		await tick();
		expect(calls).toHaveLength(2);
		expect(log.renders).toBe(before + 1);
		expect(strip(overlay.render(100)).join("\n")).toContain("lead → fix tests: fresh");
		feed = () => Promise.reject(new Error("gone"));
		overlay.handleInput!("r");
		await tick();
		expect(calls).toHaveLength(3);
		expect(log.renders).toBe(before + 1);
		expect(said).toEqual([]);
		expect(strip(overlay.render(100)).join("\n")).toContain("fresh");
		// the filter applies again on a reload
		const f = await open(() => [ev(1, 1000, { kind: "message", who: "a", text: "keep" }), ev(2, 500)], { only: (e) => e.kind === "message" });
		f.overlay.handleInput!("r");
		await tick();
		expect(strip(f.overlay.render(100)).join("\n")).not.toContain("started");
	});

	it("scrolls: ↑↓ one line, PgUp/PgDn ten, never past the ends; Esc/Enter/Ctrl+C/q close, others do not", async () => {
		const feed = Array.from({ length: 60 }, (_, i) => ev(i + 1, (60 - i) * 1000, { kind: "message", who: "lead", text: `note ${i}` }));
		const { overlay } = await open(() => feed);
		const first = () => strip(overlay.render(100))[0]!;
		expect(first()).toBe("Log · what happened lately (newest first)");
		overlay.handleInput!(KEY.down);
		expect(first()).toBe("");
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("Log · what happened lately (newest first)");
		overlay.handleInput!(KEY.pageDown);
		expect(first()).toContain("note 51");
		overlay.handleInput!(KEY.pageDown);
		expect(first()).toContain("note 41");
		overlay.handleInput!("\x1b[5~");
		expect(first()).toContain("note 51");
		overlay.handleInput!("\x1b[5~");
		overlay.handleInput!("\x1b[5~");
		expect(first()).toBe("Log · what happened lately (newest first)");
		for (let i = 0; i < 20; i++) overlay.handleInput!(KEY.pageDown);
		const end = strip(overlay.render(100));
		expect(end[end.length - 3]).toContain("note 0");
		overlay.handleInput!(KEY.down);
		expect(strip(overlay.render(100))).toEqual(end);
		// one overlay per key (expectCloseKeys asks for a fresh one each time)
		const pool = await Promise.all(Array.from({ length: 16 }, () => open(() => feed)));
		expectCloseKeys(() => pool.pop()!);
	});

	it("every line fits the width; a multi-line text is one line; the room follows the terminal's height", async () => {
		const wide = [ev(1, 1000, { kind: "message", who: "lead", text: "x".repeat(300) }), ev(2, 2000, { kind: "message", who: "lead", text: "a\nb" })];
		for (const w of [100, 40, 20]) for (const l of (await open(() => wide)).overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
		const many = Array.from({ length: 60 }, (_, i) => ev(i + 1, (60 - i) * 1000));
		expect((await open(() => many, {}, { termRows: 20 })).overlay.render(100)).toHaveLength(14 + 2);
		expect((await open(() => many, {}, { termRows: 0 })).overlay.render(100)).toHaveLength(24 + 2);
		expect((await open(() => many, {}, { termRows: 2 })).overlay.render(100)).toHaveLength(3 + 2);
	});
});
