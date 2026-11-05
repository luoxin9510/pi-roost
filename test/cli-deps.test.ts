import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { truncateToWidth as tuiTruncate, visibleWidth as tuiWidth } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "../lib/text-width.ts";

// The CLI, the daemon and the host run with plain node from the package folder: pi's
// own packages (peer dependencies) are not there (`npm run install:local` omits them).
const RUNTIME = new Set(["node-pty", "@xterm/headless", "@xterm/addon-serialize"]);

function external(entry: string): string[] {
	const seen = new Set<string>();
	const bad: string[] = [];
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const m of readFileSync(file, "utf8").matchAll(/^import\s+(type\s+)?[^"']*["']([^"']+)["']/gm)) {
			const spec = m[2]!;
			if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
			else if (!m[1] && !spec.startsWith("node:") && !RUNTIME.has(spec)) bad.push(`${relative(process.cwd(), file)} -> ${spec}`);
		}
	};
	walk(resolve(entry));
	return bad;
}

describe("processes that run without pi", () => {
	it("import nothing from pi's packages", () => {
		for (const entry of ["bin/pi-roost.ts", "daemon/main.ts", "host/main.ts"]) expect(external(entry), entry).toEqual([]);
	});

	it("M29: the shared library imports no pi package (only lib/api.ts, pi's extension API, does)", () => {
		const bad: string[] = [];
		for (const f of readdirSync("lib")) {
			if (!f.endsWith(".ts") || f === "api.ts") continue;
			for (const m of readFileSync(`lib/${f}`, "utf8").matchAll(/^import\s+(?:type\s+)?[^"']*["']([^"']+)["']/gm)) {
				if (m[1]!.startsWith("@earendil-works/")) bad.push(`lib/${f} -> ${m[1]}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it("measure text as pi-tui does", () => {
		for (const s of ["plain", "调查不稳定的测试", "emoji 🚀 ok", "é", "\u001b[31mred\u001b[0m", "ｆｕｌｌ"]) {
			expect(visibleWidth(s), s).toBe(tuiWidth(s));
			for (const w of [0, 1, 3, 6]) expect(visibleWidth(truncateToWidth(s, w)), `${s} @${w}`).toBeLessThanOrEqual(Math.max(w, 0));
		}
		// (pi-tui adds resets around the ellipsis; the text is the same)
		expect(truncateToWidth("hello world", 6)).toBe(tuiTruncate("hello world", 6, "…").replace(/\u001b\[0m/g, ""));
	});
});
