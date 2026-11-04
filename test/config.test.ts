import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig, saveUserPreset } from "../lib/config.ts";

let home: string;
let project: string;
const saved = process.env.PI_ROOST_CONFIG_DIR;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cfg-h-"));
	project = mkdtempSync(join(tmpdir(), "cfg-p-"));
	process.env.PI_ROOST_CONFIG_DIR = home;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
	if (saved === undefined) delete process.env.PI_ROOST_CONFIG_DIR;
	else process.env.PI_ROOST_CONFIG_DIR = saved;
});

describe("loadConfig", () => {
	it("defaults without files", () => {
		expect(loadConfig(project)).toEqual(DEFAULTS);
	});

	it("project settings override user settings except the env allow-list; bad values and files are ignored", () => {
		writeFileSync(join(home, "roost.json"), JSON.stringify({ leftArrowOpensAgents: false, reapIdleMinutes: 30, groupBy: "sideways", envAllowList: ["MINE", 3] }));
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "roost.json"), JSON.stringify({ reapIdleMinutes: 5, envAllowList: ["AWS_SECRET_ACCESS_KEY"] }));
		expect(loadConfig(project)).toMatchObject({ leftArrowOpensAgents: false, reapIdleMinutes: 5, envAllowList: ["MINE"], groupBy: "state" });
		writeFileSync(join(project, ".pi", "roost.json"), "{ not json");
		expect(loadConfig(project).reapIdleMinutes).toBe(30);
	});
});

describe("M27 presets", () => {
	it("takes valid presets only, merges the user's and a project's by name, and saves to the user's file", () => {
		writeFileSync(
			join(home, "roost.json"),
			JSON.stringify({
				groupBy: "directory",
				presets: {
					review: { model: "a/one", thinking: "high", agent: "reviewer", worktree: false },
					wide: { fanout: ["a/one", "b/two", "a/one"], dir: "api" },
					"bad name!": { model: "a/one" },
					odd: { model: "noslash", thinking: "LOUD", dir: "../../etc", fanout: ["a/one"], agent: "../x" },
				},
			}),
		);
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "roost.json"), JSON.stringify({ presets: { review: { model: "c/three" }, abs: { dir: "/etc" } } }));
		const p = loadConfig(project).presets!;
		expect(p.review).toEqual({ model: "c/three" });
		expect(p.wide).toEqual({ fanout: ["a/one", "b/two"], dir: "api" });
		expect(p.odd).toEqual({});
		expect(p.abs).toEqual({});
		expect("bad name!" in p).toBe(false);

		saveUserPreset("fast", { model: "b/two" });
		saveUserPreset("wide", null);
		const file = JSON.parse(readFileSync(join(home, "roost.json"), "utf8"));
		expect(file.groupBy).toBe("directory");
		expect(Object.keys(file.presets).sort()).toEqual(["bad name!", "fast", "odd", "review"]);
		expect(() => saveUserPreset("../evil", {})).toThrow();
	});
});
