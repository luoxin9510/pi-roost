import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atCandidates, atPrefix, parseInput, resolveAt } from "../lib/dispatch-input.ts";

let base: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "di-"));
	mkdirSync(join(base, "app", ".git"), { recursive: true });
	mkdirSync(join(base, "notes"));
	mkdirSync(join(base, ".pi", "worktrees", "feature-x"), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("parseInput", () => {
	it("tells tasks, shell jobs and commands apart, and takes an @dir target", () => {
		expect(parseInput("fix the tests", base)).toEqual({ kind: "task", task: "fix the tests" });
		expect(parseInput("@app fix the tests", base)).toEqual({ kind: "task", task: "fix the tests", cwd: join(base, "app") });
		expect(parseInput("email @someone about it", base)).toEqual({ kind: "task", task: "email @someone about it" });
		expect(parseInput("! npm test @app", base)).toEqual({ kind: "shell", command: "npm test", cwd: join(base, "app") });
		expect(parseInput("/model openai/gpt-x", base)).toEqual({ kind: "command", name: "model", arg: "openai/gpt-x" });
		expect(parseInput("/skill:review the diff", base)).toEqual({ kind: "command", name: "skill:review", arg: "the diff" });
	});

	it("resolves @ paths and completes candidates", () => {
		expect(resolveAt("@notes/", base)).toBe(join(base, "notes"));
		expect(resolveAt("@missing", base)).toBeUndefined();
		expect(atPrefix("fix it @ap")).toBe("ap");
		expect(atPrefix("fix it")).toBeUndefined();
		const all = atCandidates(base, ["/definitely/not/here"]);
		expect(all).toContain("app"); // a git repo
		expect(all).toContain(".pi/worktrees/feature-x");
		expect(all.indexOf("notes")).toBeGreaterThan(all.indexOf("app")); // plain folders come after repos
		expect(atCandidates(base, [join(base, "notes")], "no")).toEqual(["notes"]);
	});
});
