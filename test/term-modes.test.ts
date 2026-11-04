import { describe, expect, it } from "vitest";
import { ModeTracker } from "../lib/term-modes.ts";

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
});
