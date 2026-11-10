// M73: shared bits of the read-only scrolling overlays' tests: raw keys, a theme that shows
// its colours, and the "which keys close it / scroll it" check.
import { expect } from "vitest";
import type { Overlay, OverlayHost } from "../../hub/overlay-host.ts";

export const KEY = { esc: "\x1b", enter: "\r", ctrlC: "\x03", up: "\x1b[A", down: "\x1b[B", pageDown: "\x1b[6~", left: "\x1b[D" };

/** A theme that writes the colour into the text: `⟨accent⟩x⟨/accent⟩`; bold is `**x**`. */
export const tagTheme: OverlayHost<never>["theme"] = { fg: (c, t) => `⟨${c}⟩${t}⟨/${c}⟩`, bold: (t) => `**${t}**` };

export const strip = (lines: string[]): string[] => lines.map((l) => l.replace(/⟨\/?[a-z]+⟩|\*\*/g, ""));

/** Esc, Enter, Ctrl+C and q close it; other keys (↑↓, letters, Left) do not. */
export function expectCloseKeys(make: () => { overlay: Overlay; log: { closes: number } }) {
	for (const k of [KEY.esc, KEY.enter, KEY.ctrlC, "q"]) {
		const { overlay, log } = make();
		overlay.handleInput!(k);
		expect(log.closes, JSON.stringify(k)).toBe(1);
	}
	for (const k of [KEY.up, KEY.down, KEY.left, KEY.pageDown, "x", "r", "Q", " "]) {
		const { overlay, log } = make();
		overlay.handleInput!(k);
		expect(log.closes, JSON.stringify(k)).toBe(0);
	}
}
