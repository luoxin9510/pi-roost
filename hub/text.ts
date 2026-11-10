// M72: small text helpers the hub and its overlays share.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Control characters other than newlines would corrupt the line-based renderer.
export const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

export function oneLine(text: string): string {
	return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

export function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/)) {
			if (!word) continue;
			if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) {
				out.push(line);
				line = "";
			}
			line = line ? `${line} ${word}` : word;
		}
		if (line) out.push(truncateToWidth(line, width));
	}
	return out.slice(0, 6);
}
