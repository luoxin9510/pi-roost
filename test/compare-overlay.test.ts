// M74: the compare overlay on its own: a fake host holding the view's rows, a spy for the view's keepOne.
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompareOverlay, type CompareOpts } from "../hub/overlays/compare.ts";
import { DOUBLE_PRESS_MS } from "../hub/overlay-host.ts";
import type { JobRow } from "../lib/protocol.ts";
import type { WorktreeChange, worktreeChange } from "../lib/worktree.ts";
import { fakeHost, jobRow, tick } from "./support/overlay-host.ts";
import { KEY, strip, tagTheme } from "./support/overlay-keys.ts";

const NOW = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

const wt = (b: string, path = `/wt/${b}`) => ({ path, branch: b, base: "abc" });
const fan = (): JobRow[] => [
	jobRow({ id: "a", name: "fix it · one", model: "a/one", fanout: "f1", state: "done", startedAt: NOW - 60_000, stateSince: NOW - 60_000, summary: "Fixed by retrying.", worktree: wt("a"), usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.42, today: 0.42, day: 0, sub: false, models: {} } }),
	jobRow({ id: "b", name: "fix it · two", model: "b/two", fanout: "f1", state: "done", startedAt: NOW - 60_000, stateSince: NOW - 60_000, summary: "Rewrote the test.", worktree: wt("b") }),
	jobRow({ id: "c", name: "fix it · three", model: "c/three", fanout: "f1", state: "working", startedAt: NOW - 60_000, stateSince: NOW - 60_000, summary: "still at it" }),
];
const changed = async (path: string): Promise<WorktreeChange | undefined> => (path.endsWith("a") ? { files: 1, insertions: 3, deletions: 1, untracked: 0 } : { files: 0, insertions: 0, deletions: 0, untracked: 2 });

function open(rows: JobRow[], over: { opts?: Partial<CompareOpts>; termRows?: number; tag?: boolean; change?: typeof worktreeChange | null; timers?: boolean; host?: object } = {}) {
	vi.useFakeTimers({ toFake: over.timers ? ["Date", "setTimeout"] : ["Date"] });
	vi.setSystemTime(NOW);
	const kept: { keep: JobRow; others: JobRow[] }[] = [];
	const change = over.change === undefined ? changed : (over.change ?? undefined);
	const h = fakeHost(undefined as never, { ...(change ? { worktreeChange: change } : {}), ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}), ...over.host });
	for (const r of rows) h.rows.set(r.id, r);
	const overlay = createCompareOverlay(h.host, {
		ids: rows.map((r) => r.id),
		fanoutId: "f1",
		keepOne: async (keep, others) => void kept.push({ keep, others }),
		...over.opts,
	});
	return { ...h, overlay, kept, text: (w = 120) => strip(overlay.render(w)).join("\n") };
}

describe("M74: the compare overlay", () => {
	it("one column per session in the order given: the model, state and age, cost, changes, text; the chosen one marked; the keys", async () => {
		const { overlay } = open(fan());
		await tick();
		const out = strip(overlay.render(120)).map((l) => l.replace(/ +/g, " ").trimEnd());
		expect(out).toEqual([
			"Compare · fix it · 3 sessions",
			"",
			"› one two three",
			" done · 0s done · 0s working · 1m",
			" $0.42 · 2k tok no usage yet no usage yet",
			" 1 file +3 −1 2 new no worktree",
			"",
			" Fixed by retrying. Rewrote the test. still at it",
			"",
			"← → choose · Enter open · k keep this one (deletes the others) · r refresh · Esc close",
		]);
		// each column is (120 − 2×2) / 3 = 38 wide, a gap of 2, an unchosen head indented by 2
		expect(strip(overlay.render(120))[2]).toMatch(/^› one {37}two {37}three/);
	});

	it("a subscription session says (sub); a column shows the question, else the summary, else the error; control characters are cleaned", async () => {
		const rows = [
			jobRow({ id: "a", name: "t · a", model: "a/one", fanout: "f1", question: "Which branch?", summary: "ignored", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1, today: 0, day: 0, sub: true, models: {} } }),
			jobRow({ id: "b", name: "t · b", model: "b/two", fanout: "f1", summary: null, error: "it broke" }),
			jobRow({ id: "c", name: "t · c", model: "c/three", fanout: "f1", summary: "ok\x1b]0;pwned\x07\tdone\x1b[2J" }),
		];
		const text = open(rows).text(160);
		expect(text).toContain("$1.00 · 2 tok (sub)");
		expect(text).toContain("Which branch?");
		expect(text).not.toContain("ignored");
		expect(text).toContain("it broke");
		expect(text).toContain("ok  done");
		expect(text).not.toMatch(/\x1b\]|\x07|\x1b\[2J|\t/);
	});

	it("colours: title bold, the chosen head accent and bold, the age dim, the cost and changes muted, the keys dim", async () => {
		const o = open(fan(), { tag: true });
		await tick();
		const out = o.overlay.render(120);
		expect(out[5]).toContain("⟨muted⟩  1 file +3 −1⟨/muted⟩");
		expect(out[5]).toContain("⟨muted⟩  no worktree⟨/muted⟩");
		expect(out[0]).toBe("**Compare · fix it · 3 sessions**");
		expect(out[2]).toContain("⟨accent⟩**› one**⟨/accent⟩");
		expect(out[2]).toContain("**  two**");
		expect(out[3]).toContain("⟨dim⟩  done · 0s⟨/dim⟩");
		expect(out[4]).toContain("⟨muted⟩  $0.42 · 2k tok⟨/muted⟩");
		expect(out[out.length - 1]).toBe("⟨dim⟩← → choose · Enter open · k keep this one (deletes the others) · r refresh · Esc close⟨/dim⟩");
	});

	it("narrow (columns under 24): the chosen one in full, the others one line each, cut at the width", async () => {
		const o = open(fan());
		await tick();
		const out = strip(o.overlay.render(40));
		expect(out.slice(0, 3)).toEqual(["Compare · fix it · 3 sessions", "", "› one"]);
		expect(out).toContain("  1 file +3 −1");
		expect(out).toContain("  two · done · - · 2 new");
		expect(out).toContain("  three · working · - · no worktree");
		for (const w of [40, 25, 10]) for (const l of o.overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
		// a column is 24 wide at 3 sessions: 3×24 + 2×2 = 76
		expect(strip(o.overlay.render(76))[2]).toMatch(/^› one {2,}two {2,}three/);
		expect(strip(o.overlay.render(75))[2]).toBe("› one");
	});

	it("the title is the first session's name less its model tag; a name of several lines is one", () => {
		expect(open(fan()).text()).toContain("Compare · fix it · 3 sessions");
		const rows = fan();
		rows[0]!.name = "renamed\nby pi";
		expect(open(rows).text()).toContain("Compare · renamed by pi · 3 sessions");
		const p = fan();
		p[0]!.model = null;
		expect(open(p).text()).toContain("Compare · fix it · one · 3 sessions");
	});

	it("without a model a column is headed by the session's name", () => {
		const rows = fan().map((r) => ({ ...r, model: null }));
		expect(open(rows).text(160)).toContain("› fix it · one");
	});

	it("the room: columns and narrow list are cut to the terminal's height (at least 6)", () => {
		const long = fan();
		long[0]!.summary = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		expect(open(long, { termRows: 30 }).overlay.render(120)).toHaveLength(2 + (30 - 7 - 2) + 2);
		expect(open(long, { termRows: 0 }).overlay.render(120)).toHaveLength(2 + (30 - 7 - 2) + 2);
		expect(open(long, { termRows: 3 }).overlay.render(120)).toHaveLength(2 + (6 - 2) + 2);
		expect(open(long, { termRows: 3 }).overlay.render(40).length).toBeLessThanOrEqual(2 + 5 + 2 + 2);
	});

	it("the tokens are input, output and the cache, both ways", () => {
		const rows = fan();
		rows[0]!.usage = { input: 1000, output: 500, cacheRead: 40_000, cacheWrite: 8_500, cost: 0.42, today: 0, day: 0, sub: false, models: {} };
		expect(open(rows).text()).toContain("$0.42 · 50k tok");
	});

	it("a session without a model is headed by its name on one line", () => {
		const rows = fan();
		rows[1]!.model = null;
		rows[1]!.name = "second\nattempt";
		expect(open(rows).text(160)).toContain("  second attempt");
	});

	it("control characters in a column's text are dropped, line breaks stay", () => {
		const rows = fan();
		rows[0]!.summary = "a\x07b\x01c\nsecond line";
		const text = open(rows).text();
		expect(text).toContain("abc");
		expect(text).toContain("second line");
		expect(text).not.toMatch(/[\x01\x07]/);
	});

	it("the text wraps to the column less its indent of two", () => {
		const rows = fan();
		rows[0]!.summary = "x".repeat(36);
		// columns are 38 wide at 120: 36 characters fit after the indent
		expect(open(rows).text(120)).toMatch(/^ {2}x{36} /m);
		rows[0]!.summary = "x".repeat(37);
		expect(open(rows).text(120)).toMatch(/^ {2}x{36} .*\n {2}x /m);
		// a very narrow terminal still wraps at four
		const narrow = open(rows).text(6);
		expect(narrow).toMatch(/^ {2}xxxx$/m);
	});

	it("narrow with another column chosen: that one in full, the first as one line; a list cut to the room", () => {
		const o = open(fan());
		o.overlay.handleInput!(KEY.right);
		const out = strip(o.overlay.render(40));
		expect(out.slice(0, 4)).toEqual(["Compare · fix it · 3 sessions", "", "  one · done · $0.42 · …", "› two"]);
		const long = fan();
		long[1]!.summary = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const l = open(long, { termRows: 30 });
		l.overlay.handleInput!(KEY.right);
		// room 23 less 3 sessions less 2: 18 lines of the chosen one, 2 others, the title, the keys
		expect(l.overlay.render(40)).toHaveLength(2 + 18 + 2 + 2);
		const tiny = open(long, { termRows: 3 });
		tiny.overlay.handleInput!(KEY.right);
		expect(tiny.overlay.render(40)).toHaveLength(2 + 5 + 2 + 2);
	});

	it("the k prompt: shown for two seconds exactly; a clock near zero does not read as armed", () => {
		const o = open(fan());
		o.overlay.handleInput!("k");
		vi.setSystemTime(NOW + DOUBLE_PRESS_MS - 1);
		expect(o.text()).toContain("k again");
		vi.setSystemTime(NOW + DOUBLE_PRESS_MS);
		expect(o.text()).not.toContain("k again");
		const early = open(fan());
		vi.setSystemTime(500);
		expect(early.text()).not.toContain("k again");
		// and the first press is a first press at that time
		early.overlay.handleInput!("k");
		expect(early.kept).toEqual([]);
		expect(early.text()).toContain("k again");
		early.overlay.handleInput!("k");
		expect(early.kept).toHaveLength(1);
	});

	it("k k with every session gone keeps nothing", () => {
		const o = open(fan());
		o.overlay.handleInput!("k");
		o.rows.clear();
		o.overlay.handleInput!("k");
		expect(o.kept).toEqual([]);
		expect(o.log.closes).toBe(1);
	});

	describe("what each worktree changed", () => {
		it("asks for each worktree with a base, once on opening; '…' until it answers, then the text; a render follows each answer", async () => {
			const asked: [string, string][] = [];
			const o = open(fan(), { change: async (p, b) => (asked.push([p, b]), changed(p)) });
			expect(o.text()).toContain("…");
			expect(o.log.renders).toBe(0);
			await tick();
			expect(asked).toEqual([["/wt/a", "abc"], ["/wt/b", "abc"]]);
			expect(o.log.renders).toBe(2);
			expect(o.text()).not.toContain("…");
		});

		it("no worktree, or one without a base: 'no worktree', nothing asked", async () => {
			const rows = fan();
			rows[1]!.worktree = { path: "/wt/b", branch: "b", base: "" } as never;
			const change = vi.fn(changed);
			const o = open(rows, { change });
			expect(o.text(200)).toContain("no worktree");
			await tick();
			expect(change).toHaveBeenCalledTimes(1);
			expect(o.text(200).match(/no worktree/g)).toHaveLength(2);
		});

		it("nothing back: 'no diff (its base is gone?)' while the directory exists, 'worktree gone' when it does not; an error is '?'", async () => {
			const rows = [
				jobRow({ id: "a", name: "t · a", model: "a/one", fanout: "f1", worktree: wt("a", "/tmp") }),
				jobRow({ id: "b", name: "t · b", model: "b/two", fanout: "f1", worktree: wt("b", "/nowhere/b") }),
				jobRow({ id: "c", name: "t · c", model: "c/three", fanout: "f1", worktree: wt("c", "/nowhere/c") }),
			];
			const o = open(rows, { change: async (p) => (p.endsWith("c") ? Promise.reject(new Error("git")) : undefined) });
			await tick();
			const text = o.text(200);
			expect(text).toContain("no diff (its base is gone?)");
			expect(text).toContain("worktree gone");
			expect(text).toMatch(/ \?\s/);
		});

		it("the change reader comes from the host, else this machine's (a nonexistent path says gone)", async () => {
			const o = open(fan(), { change: null });
			await tick(20);
			expect(o.text(200)).toContain("worktree gone");
		});

		it("an answer after the overlay was disposed draws nothing", async () => {
			const o = open(fan());
			o.overlay.dispose!();
			await tick();
			expect(o.log.renders).toBe(0);
		});

		it("r reads them again (the rows' worktrees as they are now)", async () => {
			let files = 1;
			const o = open(fan(), { change: async () => ({ files, insertions: 0, deletions: 0, untracked: 0 }) });
			await tick();
			expect(o.text(200)).toContain("1 file");
			files = 5;
			o.overlay.handleInput!("r");
			await tick();
			expect(o.text(200)).toContain("5 files");
			o.rows.get("a")!.worktree = undefined;
			o.overlay.handleInput!("r");
			expect(o.text(200)).toContain("no worktree");
		});
	});

	describe("keys", () => {
		it("← → and Tab choose a column, never past the first or the last; the start is selectedId (else the first)", () => {
			const o = open(fan());
			const head = () => strip(o.overlay.render(120))[2]!.replace(/ +/g, " ").trim();
			expect(head()).toMatch(/^› one /);
			o.overlay.handleInput!(KEY.left);
			expect(head()).toMatch(/^› one /);
			o.overlay.handleInput!("\x1b[C");
			expect(head()).toMatch(/^one › two /);
			o.overlay.handleInput!("\t");
			expect(head()).toMatch(/› three$/);
			o.overlay.handleInput!("\x1b[C");
			o.overlay.handleInput!("\t");
			expect(head()).toMatch(/› three$/);
			o.overlay.handleInput!(KEY.left);
			expect(head()).toMatch(/› two /);
			expect(strip(open(fan(), { opts: { selectedId: "b" } }).overlay.render(120))[2]).toMatch(/^ {2}one .*› two/);
			expect(strip(open(fan(), { opts: { selectedId: "zzz" } }).overlay.render(120))[2]).toMatch(/^› one/);
		});

		it("Esc, Ctrl+C and q close (also q in kitty encoding); Enter, letters and ↑↓ do not close except Enter's open", () => {
			for (const k of [KEY.esc, KEY.ctrlC, "q", "\x1b[113u"]) {
				const o = open(fan());
				o.overlay.handleInput!(k);
				expect(o.log.closes, JSON.stringify(k)).toBe(1);
				expect(o.attached).toEqual([]);
			}
			for (const k of [KEY.up, KEY.down, "x", "Q", " "]) {
				const o = open(fan());
				o.overlay.handleInput!(k);
				expect(o.log.closes, JSON.stringify(k)).toBe(0);
			}
		});

		it("a key release does nothing", () => {
			const o = open(fan());
			o.overlay.handleInput!("\x1b[113;1:3u"); // q released
			o.overlay.handleInput!("\x1b[107;1:3u"); // k released
			expect(o.log.closes).toBe(0);
			expect(o.said).toEqual([]);
		});

		it("Enter closes, moves the view's cursor to the chosen row, and attaches to it", async () => {
			const o = open(fan());
			o.overlay.handleInput!(KEY.right);
			o.overlay.handleInput!(KEY.enter);
			expect(o.log.closes).toBe(1);
			expect(o.selected).toEqual(["b"]);
			expect(o.attached).toEqual(["b"]);
		});

		it("Enter: closed, then the cursor moved, then attached (in that order)", () => {
			const order: string[] = [];
			const o = open(fan(), {
				host: { close: () => void order.push("close"), attachTo: async (id: string) => void order.push(`attach ${id}`), selectRow: (id: string) => void order.push(`select ${id}`) },
			});
			o.overlay.handleInput!(KEY.enter);
			expect(order).toEqual(["close", "select a", "attach a"]);
		});

		it("a failed attach is said as an error", async () => {
			const o = open(fan(), { host: { attachTo: async () => Promise.reject(new Error("no terminal")) } });
			o.overlay.handleInput!(KEY.enter);
			await tick();
			expect(o.said).toEqual([{ text: "Error: no terminal", tone: "error" }]);
		});

		it("Enter on a column whose session is gone closes and attaches to nothing", () => {
			const o = open(fan());
			o.overlay.handleInput!(KEY.right);
			o.rows.clear();
			o.overlay.handleInput!(KEY.enter);
			expect(o.log.closes).toBe(1);
			expect(o.attached).toEqual([]);
			expect(o.selected).toEqual([]);
		});
	});

	describe("rows that go while it is open", () => {
		it("a session removed leaves the others; the chosen column stays in range; choosing stops at the last one left", () => {
			const o = open(fan());
			o.overlay.handleInput!(KEY.right);
			o.overlay.handleInput!(KEY.right);
			o.rows.delete("b");
			o.rows.delete("c");
			expect(strip(o.overlay.render(120))[2]).toMatch(/^› one/);
			expect(o.text()).toContain("1 sessions");
			o.overlay.handleInput!(KEY.right);
			o.rows.set("b", fan()[1]!);
			expect(strip(o.overlay.render(120))[2]).toMatch(/^› one {2,}two/);
			o.overlay.handleInput!(KEY.right);
			o.overlay.handleInput!(KEY.right);
			expect(strip(o.overlay.render(120))[2]).toMatch(/one {2,}› two/);
		});

		it("none left: renders nothing and closes itself (once the render is over)", async () => {
			const o = open(fan());
			o.rows.clear();
			expect(o.overlay.render(120)).toEqual([]);
			expect(o.log.closes).toBe(0);
			await Promise.resolve();
			expect(o.log.closes).toBe(1);
		});

		it("a row that changes is drawn as it is now", () => {
			const o = open(fan());
			o.rows.get("c")!.state = "failed";
			expect(o.text()).toContain("failed · 0s");
		});
	});

	describe("k", () => {
		it("without a fan-out (marked rows): says so, arms nothing, the keys do not offer it; k k keeps nothing", () => {
			const o = open(fan(), { opts: { fanoutId: undefined } });
			expect(o.text()).not.toContain("k keep");
			o.overlay.handleInput!("k");
			o.overlay.handleInput!("k");
			expect(o.said).toEqual([
				{ text: "k keeps one of a fan-out; for marked rows use Ctrl+X", tone: "warning" },
				{ text: "k keeps one of a fan-out; for marked rows use Ctrl+X", tone: "warning" },
			]);
			expect(o.kept).toEqual([]);
			expect(o.log.closes).toBe(0);
			expect(o.text()).not.toContain("k again");
		});

		it("the first k asks again (warning colour, no close); the second within two seconds closes and keeps the chosen one, the others handed over in order", () => {
			const o = open(fan(), { tag: true });
			o.overlay.handleInput!(KEY.right);
			o.overlay.handleInput!("k");
			const out = o.overlay.render(120);
			expect(out[out.length - 1]).toBe("⟨warning⟩k again: keep this one, delete the others (pinned ones stay)⟨/warning⟩");
			expect(o.kept).toEqual([]);
			expect(o.log.closes).toBe(0);
			vi.setSystemTime(NOW + DOUBLE_PRESS_MS - 1);
			o.overlay.handleInput!("k");
			expect(o.log.closes).toBe(1);
			expect(o.kept.map((k) => [k.keep.id, k.others.map((r) => r.id)])).toEqual([["b", ["a", "c"]]]);
			expect(o.kept[0]!.keep).toBe(o.rows.get("b"));
		});

		it("pinned rows are handed over among the others (the view's keepOne leaves them); a kitty k works", () => {
			const rows = fan();
			rows[1]!.pinned = true;
			const o = open(rows);
			o.overlay.handleInput!("\x1b[107u");
			o.overlay.handleInput!("\x1b[107u");
			expect(o.kept.map((k) => [k.keep.id, k.others.map((r) => [r.id, r.pinned])])).toEqual([["a", [["b", true], ["c", false]]]]);
		});

		it("the second k too late is a first press again; exactly two seconds still counts", () => {
			const o = open(fan());
			o.overlay.handleInput!("k");
			vi.setSystemTime(NOW + DOUBLE_PRESS_MS);
			o.overlay.handleInput!("k");
			expect(o.kept).toHaveLength(1);
			const late = open(fan());
			late.overlay.handleInput!("k");
			vi.setSystemTime(NOW + DOUBLE_PRESS_MS + 1);
			late.overlay.handleInput!("k");
			expect(late.kept).toEqual([]);
			expect(late.log.closes).toBe(0);
			expect(late.text()).toContain("k again");
			vi.setSystemTime(NOW + DOUBLE_PRESS_MS + 5);
			late.overlay.handleInput!("k");
			expect(late.kept).toHaveLength(1);
		});

		it("the prompt goes back when the time runs out, and a render is asked for then; not after it was disposed", () => {
			const o = open(fan(), { timers: true });
			o.overlay.handleInput!("k");
			expect(o.text()).toContain("k again");
			vi.advanceTimersByTime(DOUBLE_PRESS_MS + 49);
			expect(o.log.renders).toBe(0);
			vi.advanceTimersByTime(1);
			expect(o.log.renders).toBe(1);
			expect(o.text()).not.toContain("k again");
			const d = open(fan(), { timers: true });
			d.overlay.handleInput!("k");
			d.overlay.dispose!();
			vi.advanceTimersByTime(DOUBLE_PRESS_MS + 100);
			expect(d.log.renders).toBe(0);
		});

		it("another key between the two presses disarms it (also a key release does not)", () => {
			for (const between of [KEY.right, KEY.left, "r", "x"]) {
				const o = open(fan());
				o.overlay.handleInput!("k");
				o.overlay.handleInput!(between);
				expect(o.text(), JSON.stringify(between)).not.toContain("k again");
				o.overlay.handleInput!("k");
				expect(o.kept, JSON.stringify(between)).toEqual([]);
			}
			const o = open(fan());
			o.overlay.handleInput!("k");
			o.overlay.handleInput!("\x1b[120;1:3u");
			o.overlay.handleInput!("k");
			expect(o.kept).toHaveLength(1);
		});

		it("a third k after keeping starts over", () => {
			const o = open(fan());
			o.overlay.handleInput!("k");
			o.overlay.handleInput!("k");
			o.overlay.handleInput!("k");
			expect(o.kept).toHaveLength(1);
			expect(o.text()).toContain("k again");
		});
	});
});
