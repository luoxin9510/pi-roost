// Terminal column widths for the CLI (`pi-roost list`), without pi-tui: the CLI runs
// with plain node from the package folder, where pi's own packages (peer dependencies)
// are not installed.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ZERO = /[\p{Mn}\p{Me}\p{Cf}​-‏︀-️]/u;
const WIDE = /[\p{Extended_Pictographic}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u;

function charWidth(ch: string): number {
	const cp = ch.codePointAt(0)!;
	if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (ZERO.test(ch)) return 0;
	return WIDE.test(ch) ? 2 : 1;
}

/** Columns the text takes in a terminal (escapes take none). */
export function visibleWidth(text: string): number {
	let w = 0;
	for (const ch of text.replace(ANSI, "")) w += charWidth(ch);
	return w;
}

/** The text cut to `width` columns, `ellipsis` at the end when it was cut (plain text). */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= width) return text;
	const room = Math.max(0, width - visibleWidth(ellipsis));
	let out = "";
	let w = 0;
	for (const ch of text.replace(ANSI, "")) {
		const cw = charWidth(ch);
		if (w + cw > room) break;
		out += ch;
		w += cw;
	}
	return width >= visibleWidth(ellipsis) ? out + ellipsis : out;
}
