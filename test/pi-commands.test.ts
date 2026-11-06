import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PI_COMMANDS, sessionCommandsFrom } from "../lib/pi-commands.ts";

describe("M61: pi's built-in commands", () => {
	it("the list matches the installed pi's names (a pi upgrade that adds or removes one fails here)", () => {
		const pkg = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent");
		const src = readFileSync(join(pkg, "dist", "core", "slash-commands.js"), "utf8");
		const installed = [...src.matchAll(/\{ name: "([^"]+)"/g)].map((m) => m[1]!).sort();
		expect(installed.length).toBeGreaterThan(10);
		expect(PI_COMMANDS.map((c) => c.name).sort()).toEqual(installed);
	});

	it("session commands are bounded and one line", () => {
		expect(sessionCommandsFrom("x")).toEqual([]);
		expect(sessionCommandsFrom([{ name: "a", source: "skill", description: "x\ny" }, { name: "", source: "skill" }, { name: "b", source: "builtin" }])).toEqual([{ name: "a", description: "x y", source: "skill" }]);
	});
});
