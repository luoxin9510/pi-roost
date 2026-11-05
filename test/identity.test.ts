import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobIdentity } from "../adapters/pi/worker.ts";
import { projectConfigPath, userConfigPath } from "../lib/config.ts";
import { JOB_ENV_NAMES, jobEnv, readJobEnv, roostEnv } from "../lib/identity.ts";
import { roostHome } from "../lib/paths.ts";
import { ENV_NEVER } from "../lib/workspace-env.ts";

const saved = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("M29 neutral names", () => {
	it("a job's worker gets both names; the new one wins when reading; neither is inherited", () => {
		const env = jobEnv({ id: "j1", token: "t", socket: "/s", dir: "/d" });
		expect(env).toEqual({ ROOST_JOB_ID: "j1", PI_JOB_ID: "j1", ROOST_JOB_TOKEN: "t", PI_JOB_TOKEN: "t", ROOST_SOCKET: "/s", PI_DAEMON_SOCK: "/s", ROOST_JOB_DIR: "/d", PI_JOB_DIR: "/d" });
		expect(readJobEnv({ ROOST_JOB_ID: "new", PI_JOB_ID: "old" }, "id")).toBe("new");
		// a worker started by an older host (PI_* only) still finds its job
		expect(jobIdentity({ PI_JOB_ID: "a", PI_JOB_TOKEN: "b", PI_DAEMON_SOCK: "/c" })).toEqual({ id: "a", token: "b", socket: "/c" });
		expect(jobIdentity({ ROOST_JOB_ID: "a", ROOST_JOB_TOKEN: "b", ROOST_SOCKET: "/c" })).toEqual({ id: "a", token: "b", socket: "/c" });
		for (const n of Object.keys(env)) {
			expect(JOB_ENV_NAMES).toContain(n);
			expect(ENV_NEVER.has(n)).toBe(true);
		}
	});

	it("settings: ROOST_* before PI_ROOST_*; ~/.config/roost when it exists; a project's .roost before .pi", () => {
		expect(roostEnv("HOME", { ROOST_HOME: "/n", PI_ROOST_HOME: "/o" })).toBe("/n");
		expect(roostEnv("HOME", { PI_ROOST_HOME: "/o" })).toBe("/o");
		process.env.ROOST_HOME = "/roost-home";
		expect(roostHome()).toBe("/roost-home");

		const home = mkdtempSync(join(tmpdir(), "roost-home-"));
		dirs.push(home);
		delete process.env.ROOST_CONFIG_DIR;
		delete process.env.PI_ROOST_CONFIG_DIR;
		delete process.env.XDG_CONFIG_HOME;
		process.env.HOME = home;
		expect(userConfigPath()).toBe(join(home, ".pi", "agent", "roost.json"));
		mkdirSync(join(home, ".config", "roost"), { recursive: true });
		writeFileSync(join(home, ".config", "roost", "roost.json"), "{}");
		expect(userConfigPath()).toBe(join(home, ".config", "roost", "roost.json"));
		process.env.PI_ROOST_CONFIG_DIR = "/old";
		expect(userConfigPath()).toBe("/old/roost.json");
		process.env.ROOST_CONFIG_DIR = "/new";
		expect(userConfigPath()).toBe("/new/roost.json");

		expect(projectConfigPath(home)).toBe(join(home, ".pi", "roost.json"));
		mkdirSync(join(home, ".roost"));
		writeFileSync(join(home, ".roost", "roost.json"), "{}");
		expect(projectConfigPath(home)).toBe(join(home, ".roost", "roost.json"));
	});
});
