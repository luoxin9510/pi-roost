import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { truncateToWidth as tuiTruncate, visibleWidth as tuiWidth } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "../lib/text-width.ts";

// The CLI, the daemon and the host run with plain node from the package folder: pi's
// own packages (peer dependencies) are not there (`npm run install:local` omits them).
const RUNTIME = new Set(["node-pty", "@xterm/headless", "@xterm/addon-serialize"]);

function external(entry: string, allowed: Set<string> = RUNTIME): string[] {
	const seen = new Set<string>();
	const bad: string[] = [];
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		for (const m of readFileSync(file, "utf8").matchAll(/^import\s+(type\s+)?[^"']*["']([^"']+)["']/gm)) {
			const spec = m[2]!;
			if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
			else if (!m[1] && !spec.startsWith("node:") && !allowed.has(spec)) bad.push(`${relative(process.cwd(), file)} -> ${spec}`);
		}
	};
	walk(resolve(entry));
	return bad;
}

describe("processes that run without pi", () => {
	it("import nothing from pi's packages", () => {
		for (const entry of ["bin/pi-roost.ts", "daemon/main.ts", "host/main.ts"]) expect(external(entry), entry).toEqual([]);
	});

	it("M32: the layers keep their lines (docs/plans/any-agent.md)", () => {
		const imports = (file: string) =>
			[...readFileSync(file, "utf8").matchAll(/^(?:import|export)\s+(?:type\s+)?[^"';]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
		const bad: string[] = [];
		// the core and the agent client: no pi package, nothing from an adapter
		for (const dir of ["lib", "daemon", "host", "bin"]) {
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".ts")) continue;
				for (const spec of imports(`${dir}/${f}`)) {
					if (spec.startsWith("@earendil-works/") || spec.includes("adapters/")) bad.push(`${dir}/${f} -> ${spec}`);
				}
			}
		}
		// pi's adapter is the only place pi's packages are imported; the old path only points at it
		expect(readdirSync("extensions")).toEqual(["index.ts"]);
		expect(imports("extensions/index.ts")).toEqual(["../adapters/pi/index.ts"]);
		expect(bad).toEqual([]);
	});

	it("M32: the agent client (pi-roost/agent) needs node alone, not even roost's runtime dependencies", () => {
		expect(external("lib/agent-client.ts", new Set())).toEqual([]);
	});

	it("M32: the old extension path loads pi's adapter", async () => {
		expect((await import("../extensions/index.ts")).default).toBe((await import("../adapters/pi/index.ts")).default);
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
