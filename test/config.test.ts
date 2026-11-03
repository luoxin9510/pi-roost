import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../lib/config.ts";

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

	it("project settings override user settings; bad values and files are ignored", () => {
		writeFileSync(join(home, "roost.json"), JSON.stringify({ leftArrowOpensAgents: false, reapIdleMinutes: 30, groupBy: "sideways" }));
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "roost.json"), JSON.stringify({ reapIdleMinutes: 5, envAllowList: ["CORP_API", 3] }));
		expect(loadConfig(project)).toMatchObject({ leftArrowOpensAgents: false, reapIdleMinutes: 5, envAllowList: ["CORP_API"], groupBy: "state" });
		writeFileSync(join(project, ".pi", "roost.json"), "{ not json");
		expect(loadConfig(project).reapIdleMinutes).toBe(30);
	});
});
