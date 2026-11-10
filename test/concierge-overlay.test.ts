// M73: the standing orders and the concierge's answer on their own: a fake port, a fake host.
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnswerOverlay, createOrdersOverlay } from "../hub/overlays/concierge.ts";
import type { StandingOrder } from "../lib/concierge.ts";
import { fakeHost } from "./support/overlay-host.ts";
import { expectCloseKeys, KEY, strip, tagTheme } from "./support/overlay-keys.ts";
import { fakePort } from "./support/roost-port.ts";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
afterEach(() => vi.useRealTimers());

const order = (id: number, text: string, extra: Partial<StandingOrder> = {}): StandingOrder => ({ id, text, when: null, by: "user", at: NOW - 3600_000, lastAt: null, nextAt: null, count: 0, ...extra });

async function orders(list: StandingOrder[], over: { termRows?: number; tag?: boolean; fail?: Error } = {}) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	const p = fakePort({
		"concierge.orders.list": () => {
			if (over.fail) throw over.fail;
			return { orders: list };
		},
	});
	const h = fakeHost(p.port, { ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}) });
	const overlay = await createOrdersOverlay(h.host);
	return { ...h, overlay: overlay!, calls: p.calls, maybe: overlay };
}

describe("M73: the standing orders overlay", () => {
	it("asks the daemon for the list, once, and renders title, orders and keys", async () => {
		const { overlay, calls } = await orders([order(1, "tell deploy the result")]);
		expect(calls).toEqual([{ path: "concierge.orders.list", args: [] }]);
		overlay.render(100);
		overlay.render(100);
		expect(calls).toHaveLength(1);
		expect(overlay.render(100)).toEqual(["Standing orders · what the concierge keeps in mind", "", "  #1 tell deploy the result · yours", "", "/concierge orders add <rule> · /concierge orders rm <id>", "", "↑↓ scroll · Esc close"]);
	});

	it("no orders: says so (muted), opens nothing", async () => {
		const { maybe, said, log } = await orders([]);
		expect(maybe).toBeUndefined();
		expect(said).toEqual([{ text: "no standing orders · /concierge orders add <rule> (or tell the concierge: ? remember …)", tone: "muted" }]);
		expect(log.closes).toBe(0);
	});

	it("a failed load throws to the command, which says it", async () => {
		const p = fakePort({ "concierge.orders.list": () => Promise.reject(new Error("daemon down")) });
		const h = fakeHost(p.port);
		await expect(createOrdersOverlay(h.host)).rejects.toThrow("daemon down");
		expect(h.said).toEqual([]);
	});

	it("lists newest first (the list reversed); marks the user's, not the concierge's", async () => {
		const { overlay } = await orders([order(1, "first"), order(2, "second", { by: "concierge" }), order(3, "third")], { tag: true });
		const out = overlay.render(100);
		expect(out[2]).toBe("  ⟨muted⟩#3 third⟨/muted⟩⟨dim⟩ · yours⟨/dim⟩");
		expect(out[3]).toBe("  ⟨muted⟩#2 second⟨/muted⟩");
		expect(out[4]).toBe("  ⟨muted⟩#1 first⟨/muted⟩⟨dim⟩ · yours⟨/dim⟩");
		expect(out[0]).toBe("**Standing orders · what the concierge keeps in mind**");
	});

	it("an order on a clock is accent, with its when and how often it applied", async () => {
		const { overlay } = await orders([order(1, "say what is blocked", { when: "every 30m", count: 2, lastAt: NOW - 3 * MIN, by: "concierge" })], { tag: true });
		expect(overlay.render(100)[2]).toBe("  ⟨accent⟩#1 every 30m · say what is blocked (applied ×2, 3m ago)⟨/accent⟩");
	});

	it("a clock with a control character in it is shown on one line", async () => {
		const { overlay } = await orders([order(1, "rule", { when: "every\n30m\x07" })]);
		expect(overlay.render(100)[2]).toBe("  #1 every 30m · rule · yours");
	});

	it("puts a rule on one line and cuts every line to the width", async () => {
		const { overlay } = await orders([order(1, "two\nlines " + "x".repeat(300))]);
		const out = overlay.render(40);
		expect(out[2]).toContain("two lines");
		for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
	});

	it("fits the terminal: rows - 6 lines, a blank, the keys; 30 when unknown; at least 3", async () => {
		const many = Array.from({ length: 60 }, (_, i) => order(i + 1, `rule ${i}`));
		expect((await orders(many, { termRows: 20 })).overlay.render(100)).toHaveLength(14 + 2);
		expect((await orders(many, { termRows: 0 })).overlay.render(100)).toHaveLength(24 + 2);
		expect((await orders(many, { termRows: 4 })).overlay.render(100)).toHaveLength(3 + 2);
	});

	it("scrolls with ↑↓ and clamps at both ends", async () => {
		const many = Array.from({ length: 20 }, (_, i) => order(i + 1, `rule ${i}`));
		const { overlay } = await orders(many, { termRows: 9 });
		const first = () => strip(overlay.render(200))[0]!;
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		expect(first()).toBe("  #20 rule 19 · yours");
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("");
		for (let i = 0; i < 100; i++) overlay.handleInput!(KEY.down);
		const end = strip(overlay.render(200));
		expect(end.slice(0, 3)).toEqual(["  #1 rule 0 · yours", "", "/concierge orders add <rule> · /concierge orders rm <id>"]);
		overlay.handleInput!(KEY.up);
		expect(strip(overlay.render(200))[0]).not.toBe(end[0]);
	});

	it("a short list is shown whole, in colour, however it was scrolled; every line fits a narrow width", async () => {
		const { overlay } = await orders([order(1, "rule")], { tag: true });
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		const whole = ["**Standing orders · what the concierge keeps in mind**", "", "  ⟨muted⟩#1 rule⟨/muted⟩⟨dim⟩ · yours⟨/dim⟩", "", "⟨dim⟩/concierge orders add <rule> · /concierge orders rm <id>⟨/dim⟩", "", "⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩"];
		expect(overlay.render(200)).toEqual(whole);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(overlay.render(200)).toEqual(whole);
		const plain = await orders([order(1, "rule " + "x".repeat(80))]);
		for (const l of plain.overlay.render(20)) expect(visibleWidth(l), l).toBeLessThanOrEqual(20);
	});

	it("after the terminal got smaller, shows from the top, not the end", async () => {
		let rows = 60;
		const h = fakeHost(fakePort({ "concierge.orders.list": () => ({ orders: [order(1, "a"), order(2, "b"), order(3, "c")] }) }).port, { termRows: () => rows });
		const overlay = (await createOrdersOverlay(h.host))!;
		overlay.render(100);
		rows = 9;
		expect(overlay.render(100)[0]).toBe("Standing orders · what the concierge keeps in mind");
	});

	it("Esc, Enter, Ctrl+C and q close it; other keys do not", async () => {
		const made = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(() => orders([order(1, "x")])));
		let i = 0;
		expectCloseKeys(() => ({ overlay: made[i]!.overlay, log: made[i++]!.log }));
	});
});

function answer(text: string, over: { termRows?: number; tag?: boolean } = {}) {
	const h = fakeHost<never>(undefined as never, { ...(over.termRows !== undefined ? { termRows: () => over.termRows! } : {}), ...(over.tag ? { theme: tagTheme } : {}) });
	return { ...h, overlay: createAnswerOverlay(h.host, { answer: text }) };
}

describe("M73: the concierge's answer overlay", () => {
	it("renders the title, the answer indented, the keys", () => {
		expect(answer("fix tests waits for a branch name.", { tag: true }).overlay.render(100)).toEqual(["**Concierge**", "", "  fix tests waits for a branch name.", "", "⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩"]);
	});

	it("keeps the answer's own line breaks and wraps long lines at the width - 2 (4 at least), each indented", () => {
		const out = answer("one\ntwo " + "word ".repeat(12)).overlay.render(30);
		expect(out.slice(2, -2).every((l) => l.startsWith("  ") && visibleWidth(l) <= 30)).toBe(true);
		expect(out[2]).toBe("  one");
		expect(out.slice(3, -2).length).toBeGreaterThan(2);
		expect(out.slice(3, -2).join(" ").replace(/\s+/g, " ")).toContain("two word word");
		// the text gets the width less its two-space indent
		expect(answer("x".repeat(28)).overlay.render(30).slice(2, -2)).toEqual(["  " + "x".repeat(28)]);
		expect(answer("x".repeat(29)).overlay.render(30).slice(2, -2)).toHaveLength(2);
		// a width below 6 still wraps at 4
		const narrow = answer("abcdefghij").overlay.render(5);
		expect(narrow.slice(2, -2)).toEqual(["  abcd", "  efgh", "  ij"]);
	});

	it("turns a tab into two spaces; drops terminal escapes and control characters", () => {
		const out = answer("tab\tseparated \x1b[31mred\x1b[0m and \x07bell\x00 \x9fend").overlay.render(100);
		expect(out[2]).toBe("  tab  separated red and bell end");
	});

	it("cuts the title and the keys to a narrow width", () => {
		const out = answer("x").overlay.render(8);
		expect(visibleWidth(out[0]!)).toBeLessThanOrEqual(8);
		expect(visibleWidth(out.at(-1)!)).toBeLessThanOrEqual(8);
		expect(out.at(-1)).toContain("↑↓");
	});

	it("a short answer is shown whole, however it was scrolled", () => {
		const { overlay } = answer("hi", { tag: true });
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		const whole = ["**Concierge**", "", "  hi", "", "⟨dim⟩↑↓ scroll · Esc close⟨/dim⟩"];
		expect(overlay.render(100)).toEqual(whole);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.up);
		expect(overlay.render(100)).toEqual(whole);
	});

	it("scrolls with ↑↓ and clamps at both ends", () => {
		const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const { overlay } = answer(text, { termRows: 9 });
		const first = () => strip(overlay.render(100))[0]!;
		overlay.handleInput!(KEY.up);
		overlay.handleInput!(KEY.down);
		overlay.handleInput!(KEY.down);
		expect(first()).toBe("  line 0");
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("");
		for (let i = 0; i < 100; i++) overlay.handleInput!(KEY.down);
		expect(strip(overlay.render(100)).slice(0, 3)).toEqual(["  line 17", "  line 18", "  line 19"]);
		overlay.handleInput!(KEY.up);
		expect(first()).toBe("  line 16");
	});

	it("fits the terminal: rows - 6 lines; 30 rows when unknown; at least 3", () => {
		const text = Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n");
		expect(answer(text, { termRows: 20 }).overlay.render(100)).toHaveLength(14 + 2);
		expect(answer(text, { termRows: 0 }).overlay.render(100)).toHaveLength(24 + 2);
		expect(answer(text, { termRows: 4 }).overlay.render(100)).toHaveLength(3 + 2);
	});

	it("after the terminal got smaller, shows from the top, not the end", () => {
		let rows = 60;
		const h = fakeHost<never>(undefined as never, { termRows: () => rows });
		const overlay = createAnswerOverlay(h.host, { answer: "a\nb\nc" });
		overlay.render(100);
		rows = 9;
		expect(overlay.render(100)[0]).toBe("Concierge");
	});

	it("Esc, Enter, Ctrl+C and q close it; other keys do not", () => {
		expectCloseKeys(() => {
			const a = answer("x");
			return { overlay: a.overlay, log: a.log };
		});
	});
});
