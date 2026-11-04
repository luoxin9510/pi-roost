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
		// M20: the whole environment by default; the allowlist only with inheritEnv off
		expect(launch.env).toEqual({ PATH: "/bin", SECRET: "s" });
		expect(launch).toMatchObject({ workspaceEnv: "shell" });
		expect(launch).toMatchObject({ model: "c/d", thinking: "high", origin: "dispatch" });
	});
});

describe("respawnCommand", () => {
	const rec = { command: ["node", "pi.js", "--session", "/s.jsonl", "--model", "m", "--", "the task"] } as never;
	it("drops the first prompt once the session exists, optionally adding a new one", async () => {
		const { respawnCommand } = await import("../lib/store.ts");
		expect(respawnCommand(rec, true)).toEqual(["node", "pi.js", "--session", "/s.jsonl"]);
		expect(respawnCommand(rec, true, "go on")).toEqual(["node", "pi.js", "--session", "/s.jsonl", "--", "go on"]);
		expect(respawnCommand(rec, false, "go on")).toEqual((rec as { command: string[] }).command);
	});

	it("M8: a written session restores its own model and thinking level, so their flags go", async () => {
		const { respawnCommand } = await import("../lib/store.ts");
		const cmd = ["node", "pi.js", "--session", "/s.jsonl", "-e", "/x.ts", "--provider", "p", "--model=p/m", "--thinking", "high", "--offline", "--", "task"];
		expect(respawnCommand({ command: cmd } as never, true)).toEqual(["node", "pi.js", "--session", "/s.jsonl", "-e", "/x.ts", "--offline"]);
		// never written: pi has not recorded the model yet, the flags still choose it
		expect(respawnCommand({ command: cmd } as never, false)).toEqual(cmd);
	});

	it("M8: what the worker last reported running is passed instead (pi does not always record it)", async () => {
		const { respawnCommand } = await import("../lib/store.ts");
		const cmd = ["node", "pi.js", "--session", "/s.jsonl", "--model", "a/x", "--thinking", "high", "--", "task"];
		expect(respawnCommand({ command: cmd } as never, true, "go", { model: "b/y", thinking: "low" })).toEqual([
			"node", "pi.js", "--session", "/s.jsonl", "--model", "b/y", "--thinking", "low", "--", "go",
		]);
		// junk in state.json is not passed to pi as flags
		expect(respawnCommand({ command: cmd } as never, true, undefined, { model: "--evil", thinking: "x y" })).toEqual(["node", "pi.js", "--session", "/s.jsonl"]);
		expect(respawnCommand({ command: cmd } as never, true, undefined, { model: null, thinking: 3 })).toEqual(["node", "pi.js", "--session", "/s.jsonl"]);
	});
});

describe("M8: moving a conversation keeps its own model", () => {
	const argv = ["node", "/pi.js", "-e", "/x.ts", "--model", "a/x", "--thinking=high", "--provider", "a", "--offline"];
	const launch = (origin: "adopt" | "fork" | "dispatch" | "bg", extra: { model?: string; thinking?: string } = {}) =>
		buildLaunch({ task: "", cwd: "/w", sessionFile: "/s.jsonl", name: "x", origin, argv, execPath: "node", env: {}, ...extra }).command.slice(2);
	it("adopt and fork drop the foreground pi's model flags; dispatch and bg keep them", () => {
		expect(launch("adopt")).toEqual(["--session", "/s.jsonl", "-e", "/x.ts", "--offline"]);
		expect(launch("fork")).toEqual(["--session", "/s.jsonl", "-e", "/x.ts", "--offline"]);
		expect(launch("dispatch")).toEqual(["--session", "/s.jsonl", "-e", "/x.ts", "--model", "a/x", "--thinking=high", "--provider", "a", "--offline"]);
		expect(launch("bg")).toContain("--model");
	});
	it("an explicit choice still wins", () => {
		expect(launch("adopt", { model: "b/y" })).toEqual(["--session", "/s.jsonl", "-e", "/x.ts", "--offline", "--model", "b/y"]);
	});
});

describe("@ at the start of a task", () => {
	it("is not read by pi as a file argument", () => {
		const l = buildLaunch({ task: "@someone please look", cwd: "/w", sessionFile: "/s.jsonl", name: "x", origin: "dispatch", argv: ["node", "/pi.js"], execPath: "node", env: {} });
		expect(l.command.at(-1)).toBe(" @someone please look");
	});
});
