// M74: the usage overlay on its own: a fake host holding the view's rows.
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageOverlay } from "../hub/overlays/usage.ts";
import { fakeHost, jobRow } from "./support/overlay-host.ts";
import { expectCloseKeys, KEY, strip, tagTheme } from "./support/overlay-keys.ts";

const NOW = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

const OPUS = "anthropic/claude-opus-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const spent = (cost: number, today: number, models: Record<string, { cost: number; tokens: number }>, sub = false) => {
	const d = new Date(NOW);
	d.setHours(0, 0, 0, 0);
	return { input: 12_000, output: 3_000, cacheRead: 40_000, cacheWrite: 1_000, cost, today, day: d.getTime(), sub, models };
};

function open(rows: ReturnType<typeof jobRow>[], over: { termRows?: number; tag?: boolean } = {}) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	const h = fakeHost(undefined as never, { ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}) });
	for (const r of rows) h.rows.set(r.id, r);
	return { ...h, overlay: createUsageOverlay(h.host) };
}

const two = () => [
	jobRow({ id: "a", name: "big job", model: OPUS, usage: spent(12.5, 2, { [OPUS]: { cost: 12.5, tokens: 56_000 } }) }),
	jobRow({ id: "b", name: "small job", model: HAIKU, usage: spent(0.3, 0.3, { [HAIKU]: { cost: 0.3, tokens: 56_000 } }, true) }),
];

describe("M74: the usage overlay", () => {
	it("totals, then by model (dearest first), then by session (dearest first), the keys", () => {
		const out = strip(open(two()).overlay.render(140));
		expect(out).toEqual([
			"Usage · sessions in this view",
			"",
			"  today $2.30 · all $12.80 · 112k tokens · $0.30 of it on a subscription (as if billed per token)",
			"",
			"  By model",
			"  claude-opus-5-5                             $12.50     56k tok  1 session",
			"  claude-haiku-5-5                             $0.30     56k tok  1 session",
			"",
			"  By session",
			"  big job                                     $12.50     56k tok  $2.00 today  claude-opus-5-5",
			"  small job                                    $0.30     56k tok  $0.30 today  (sub)  claude-haiku-5-5",
			"",
			"↑↓ scroll · Esc close",
		]);
	});

	it("colours: title bold; a subscription's tag and the model dim; the keys dim", () => {
		const out = open(two(), { tag: true }).overlay.render(140);
		expect(out[0]).toBe("**Usage · sessions in this view**");
		expect(out[4]).toBe("**  By model**");
		expect(out[8]).toBe("**  By session**");
		expect(out[10]).toContain("⟨dim⟩  (sub)⟨/dim⟩  ⟨dim⟩claude-haiku-5-5⟨/dim⟩");
		expect(out[out.length - 1]).toBe("⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩");
	});

	it("a session that spent nothing is left out; none spent says so (no totals)", () => {
		const idle = jobRow({ id: "i", name: "idle" });
		const zero = jobRow({ id: "z", name: "zero", usage: { ...spent(0, 0, {}), input: 0, output: 0 } });
		const out = strip(open([idle, zero]).overlay.render(100));
		expect(out).toEqual(["Usage · sessions in this view", "", "  nothing spent yet (sessions report what they spend as they work)", "", "↑↓ scroll · Esc close"]);
		// tokens without a cost count
		const tokens = jobRow({ id: "t", name: "tokens only", usage: { ...spent(0, 0, {}), input: 5, output: 5 } });
		expect(strip(open([tokens]).overlay.render(100)).join("\n")).toContain("tokens only");
	});

	it("reads the rows as they are at each render", () => {
		const { overlay, rows } = open(two());
		expect(strip(overlay.render(100)).join("\n")).toContain("small job");
		rows.delete("b");
		const after = strip(overlay.render(100)).join("\n");
		expect(after).not.toContain("small job");
		expect(after).not.toContain("on a subscription");
		rows.clear();
		expect(strip(overlay.render(100)).join("\n")).toContain("nothing spent yet");
	});

	it("a model and a session each say 1 session / 2 sessions; no 'today' for a session with none", () => {
		const a = jobRow({ id: "a", name: "a", model: OPUS, usage: spent(1, 0, { [OPUS]: { cost: 1, tokens: 10 } }) });
		const b = jobRow({ id: "b", name: "b", model: OPUS, usage: spent(2, 0, { [OPUS]: { cost: 2, tokens: 10 } }) });
		const out = strip(open([a, b]).overlay.render(100)).join("\n");
		expect(out).toContain("2 sessions");
		expect(out).not.toContain(" today  ");
		expect(out).not.toMatch(/\d today\s*$/m);
	});

	it("a name of several lines is one line; a long one is cut; every line fits the width", () => {
		const long = jobRow({ id: "l", name: "a name\nthat runs on and on and on and on and on and on and on", model: HAIKU, usage: spent(1, 1, {}) });
		for (const w of [100, 50, 30]) {
			for (const l of open([long, ...two()]).overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
		}
		expect(strip(open([long]).overlay.render(100)).join("\n")).toContain("a name that runs on");
	});

	it("scrolls: ↑↓ one line, PgUp/PgDn ten, never past the ends; Esc/Enter/Ctrl+C/q close, other keys do not", () => {
		const many = Array.from({ length: 40 }, (_, i) => jobRow({ id: `s${i}`, name: `session ${String(i).padStart(2, "0")}`, usage: spent(100 - i, 0, {}) }));
		const { overlay } = open(many);
		const first = () => strip(overlay.render(100))[0];
		expect(first()).toBe("Usage · sessions in this view");
		overlay.handleInput!(KEY.down);
		expect(first()).toBe("");
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("Usage · sessions in this view");
		overlay.handleInput!(KEY.pageDown);
		const at10 = strip(overlay.render(100))[0];
		expect(at10).not.toBe("Usage · sessions in this view");
		overlay.handleInput!("\x1b[5~");
		expect(first()).toBe("Usage · sessions in this view");
		for (let i = 0; i < 20; i++) overlay.handleInput!(KEY.pageDown);
		const end = strip(overlay.render(100));
		expect(end).toHaveLength(24 + 2);
		expect(end.slice(-3)[0]).toBe("  session 39" + end.slice(-3)[0]!.slice(12));
		overlay.handleInput!(KEY.pageDown);
		expect(strip(overlay.render(100))).toEqual(end);
		expectCloseKeys(() => open(many));
	});

	it("a page is ten lines, a line is one; keys pressed before a render cannot push the top above the first line", () => {
		const many = Array.from({ length: 40 }, (_, i) => jobRow({ id: `s${i}`, name: `session ${String(i).padStart(2, "0")}`, usage: spent(100 - i, 0, {}) }));
		const all = strip(open(many, { termRows: 200 }).overlay.render(100));
		const o = open(many).overlay;
		const first = () => strip(o.render(100))[0];
		o.handleInput!(KEY.pageDown);
		expect(first()).toBe(all[10]);
		o.handleInput!(KEY.down);
		o.handleInput!(KEY.down);
		o.handleInput!(KEY.down);
		o.handleInput!(KEY.up);
		expect(first()).toBe(all[12]);
		o.handleInput!("\x1b[5~");
		o.handleInput!("\x1b[5~");
		o.handleInput!(KEY.pageDown);
		expect(first()).toBe(all[10]);
		const p = open(many).overlay;
		p.handleInput!(KEY.up);
		p.handleInput!(KEY.up);
		p.handleInput!(KEY.down);
		expect(strip(p.render(100))[0]).toBe(all[1]);
		const q = open(many).overlay;
		q.handleInput!("\x1b[5~");
		q.handleInput!("\x1b[5~");
		q.handleInput!(KEY.pageDown);
		expect(strip(q.render(100))[0]).toBe(all[10]);
	});

	it("the name column is two fifths of the width (12 to 40 wide)", () => {
		const long = jobRow({ id: "l", name: "n".repeat(60), usage: spent(1, 0, {}) });
		const line = (w: number) => strip(open([long]).overlay.render(w)).find((l) => l.includes("nnn"))!;
		expect(line(100).match(/n+/)![0]).toHaveLength(37); // cut with "..."
		expect(line(60).match(/n+/)![0]).toHaveLength(21);
		expect(line(20).match(/n+/)![0]).toHaveLength(9);
	});

	it("models with the same cost go by tokens, most first", () => {
		const a = jobRow({ id: "a", name: "a", model: "p/few", usage: spent(1, 0, { "p/few": { cost: 1, tokens: 10 } }) });
		const b = jobRow({ id: "b", name: "b", model: "p/many", usage: spent(1, 0, { "p/many": { cost: 1, tokens: 90 } }) });
		const text = strip(open([a, b]).overlay.render(100)).join("\n");
		expect(text.indexOf("many")).toBeLessThan(text.indexOf("few"));
	});

	it("the room follows the terminal's height (30 when unknown), at least 3 lines", () => {
		const many = Array.from({ length: 40 }, (_, i) => jobRow({ id: `s${i}`, name: `s${i}`, usage: spent(100 - i, 0, {}) }));
		expect(open(many, { termRows: 20 }).overlay.render(100)).toHaveLength(14 + 2);
		expect(open(many, { termRows: 0 }).overlay.render(100)).toHaveLength(24 + 2);
		expect(open(many, { termRows: 2 }).overlay.render(100)).toHaveLength(3 + 2);
	});
});
