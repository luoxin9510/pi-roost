import { describe, expect, it } from "vitest";
import { allowListedEnv, buildLaunch, fallbackName, passthroughArgs } from "../lib/dispatch.ts";

describe("passthroughArgs", () => {
	it("keeps extension, model and offline flags and absolutises paths", () => {
		const argv = ["-ne", "--offline", "-e", "ext/a.ts", "--extension=/abs/b.ts", "-e", "builtin:mcp", "--model", "x/y", "--bg", "task words", "--session", "s.jsonl"];
		expect(passthroughArgs(argv, "/work")).toEqual([
			"-ne", "--offline", "-e", "/work/ext/a.ts", "--extension=/abs/b.ts", "-e", "builtin:mcp", "--model", "x/y",
		]);
	});
});

describe("allowListedEnv", () => {
	it("keeps PATH, LC_* and proxies in any case, drops secrets", () => {
		const env = allowListedEnv({ PATH: "/bin", LC_ALL: "C", https_proxy: "p", ANTHROPIC_API_KEY: "k", PI_JOB_ID: "x" });
		expect(env).toEqual({ PATH: "/bin", LC_ALL: "C", https_proxy: "p" });
	});
});

describe("fallbackName", () => {
	it("takes the first six words", () => {
		expect(fallbackName("  run the regression and summarise all failures please ")).toBe("run the regression and summarise all");
	});
});

describe("buildLaunch", () => {
	it("repeats extension flags, overrides model and thinking, appends the task", () => {
		const launch = buildLaunch({
			task: "fix the flaky test",
			cwd: "/work",
			sessionFile: "/s/a.jsonl",
			name: "fix",
			origin: "dispatch",
			argv: ["node", "/pi/cli.js", "--agents", "-e", "/x/roost.ts", "--model", "a/b", "--thinking=low"],
			execPath: "/bin/node",
			env: { PATH: "/bin", SECRET: "s" },
			model: "c/d",
			thinking: "high",
		});
		expect(launch.command).toEqual([
			"/bin/node", "/pi/cli.js", "--session", "/s/a.jsonl", "-e", "/x/roost.ts", "--model", "c/d", "--thinking", "high", "--", "fix the flaky test",
		]);
		expect(launch.env).toEqual({ PATH: "/bin" });
		expect(launch).toMatchObject({ model: "c/d", thinking: "high", origin: "dispatch" });
	});
});

describe("respawnCommand", () => {
	const rec = { command: ["node", "pi.js", "--session", "/s.jsonl", "--model", "m", "--", "the task"] } as never;
	it("drops the first prompt once the session exists, optionally adding a new one", async () => {
		const { respawnCommand } = await import("../lib/store.ts");
		expect(respawnCommand(rec, true)).toEqual(["node", "pi.js", "--session", "/s.jsonl", "--model", "m"]);
		expect(respawnCommand(rec, true, "go on")).toEqual(["node", "pi.js", "--session", "/s.jsonl", "--model", "m", "--", "go on"]);
		expect(respawnCommand(rec, false, "go on")).toEqual((rec as { command: string[] }).command);
	});
});

describe("@ at the start of a task", () => {
	it("is not read by pi as a file argument", () => {
		const l = buildLaunch({ task: "@someone please look", cwd: "/w", sessionFile: "/s.jsonl", name: "x", origin: "dispatch", argv: ["node", "/pi.js"], execPath: "node", env: {} });
		expect(l.command.at(-1)).toBe(" @someone please look");
	});
});
