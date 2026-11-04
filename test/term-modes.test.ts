import { describe, expect, it } from "vitest";
import { ModeTracker, StreamTail } from "../lib/term-modes.ts";

describe("M21: modes the snapshot does not carry", () => {
	it("follows cursor visibility, mouse encodings, focus, kitty keyboard flags, modifyOtherKeys", () => {
		const m = new ModeTracker();
		expect(m.restore()).toBe("");
		m.feed("x\x1b[?25l\x1b[?1006;1004h\x1b[>1u\x1b[>4;2mtext");
		expect(m.restore()).toBe("\x1b[?25l\x1b[?1006h\x1b[?1004h\x1b[>1u\x1b[>4;2m");
		m.feed("\x1b[?25h\x1b[?1006l\x1b[>3u\x1b[<u\x1b[=5;2u");
		// the stack: 1, 3 popped, then 1 | 5
		expect(m.restore()).toBe("\x1b[?1004h\x1b[>5u\x1b[>4;2m");
		m.feed("\x1b[<9u\x1b[>4m\x1b[?1004l");
		expect(m.restore()).toBe("");
	});

	it("a sequence cut between two chunks counts once", () => {
		const m = new ModeTracker();
		m.feed("abc\x1b[?10");
		m.feed("06h\x1b[");
		m.feed(">1u");
		expect(m.restore()).toBe("\x1b[?1006h\x1b[>1u");
	});

	it("keeps a kitty stack per screen; resets on RIS; cursor shape, charset, scroll region", () => {
		const m = new ModeTracker();
		m.feed("\x1b[>1u\x1b[?1049h\x1b[>8u");
		expect(m.restore()).toBe("\x1b[>8u");
		m.feed("\x1b[<u\x1b[?1049l");
		expect(m.restore()).toBe("\x1b[>1u");
		m.feed("\x1b[5 q\x1b(0\x1b[3;20r");
		expect(m.restore()).toBe("\x1b[>1u\x1b[5 q\x1b(0");
		expect(m.scrollRegion()).toEqual([3, 20]);
		m.resized();
		expect(m.scrollRegion()).toBeUndefined();
		m.feed("\x1bc");
		expect(m.restore()).toBe("");
	});
});

describe("M21: the unfinished sequence at a chunk's end", () => {
	it("is kept until it ends, across chunks and kinds", () => {
		const t = new StreamTail();
		t.feed("text \x1b[3");
		expect(t.text()).toBe("\x1b[3");
		t.feed("1;4");
		expect(t.text()).toBe("\x1b[31;4");
		t.feed("mok");
		expect(t.text()).toBe("");
		t.feed("\x1b]0;title");
		expect(t.text()).toBe("\x1b]0;title");
		t.feed(" more\x1b");
		expect(t.text()).toBe("\x1b]0;title more\x1b");
		t.feed("\\after\x1b(");
		expect(t.text()).toBe("\x1b(");
		t.feed("B\x1b\x1b[");
		expect(t.text()).toBe("\x1b[");
		t.feed("H");
		expect(t.text()).toBe("");
	});
});

