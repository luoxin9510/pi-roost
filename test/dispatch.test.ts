import { describe, expect, it } from "vitest";
import { allowListedEnv, fallbackName, passthroughArgs } from "../lib/dispatch.ts";

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
