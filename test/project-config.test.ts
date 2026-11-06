import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roostEnv } from "../lib/identity.ts";
import {
	approve, commandHash, isApproved, overridePath, parseProjectConfig, readLogTail, readOverride, readProjectConfig, verifyCommand, verifyLogPath,
} from "../lib/project-config.ts";

const dirs: string[] = [];
let home: string;
beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "roost-pc-home-")));
	dirs.push(home);
	process.env.PI_ROOST_HOME = home;
});
afterEach(() => {
	delete process.env.PI_ROOST_HOME;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function repo(file?: string): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "roost-pc-")));
	dirs.push(d);
	git(d, "init", "-q", "-b", "main");
	writeFileSync(join(d, "a.txt"), "a\n");
	if (file !== undefined) {
		mkdirSync(join(d, ".roost"));
		writeFileSync(join(d, ".roost", "project.json"), file);
	}
	git(d, "add", ".");
	git(d, "commit", "-q", "-m", "init");
	return d;
}

describe("M56: parseProjectConfig", () => {
	it("defaults and valid fields", () => {
		expect(parseProjectConfig({})).toEqual({ config: { verifyTimeout: 600, maxRounds: 3 } });
		expect(parseProjectConfig({ verify: "npm test", setup: "npm ci", verifyTimeout: 30, maxRounds: 5, extra: 1 }).config).toEqual({
			verify: "npm test", setup: "npm ci", verifyTimeout: 30, maxRounds: 5,
		});
	});
	it("drops invalid fields with an error", () => {
		const r = parseProjectConfig({ verify: "a\nb", setup: "  ", verifyTimeout: 5000, maxRounds: 1.5 });
		expect(r.config).toEqual({ verifyTimeout: 600, maxRounds: 3 });
		expect(r.error).toMatch(/verify.*setup.*verifyTimeout.*maxRounds/);
		expect(parseProjectConfig({ verify: "x".repeat(2001) }).config.verify).toBeUndefined();
		expect(parseProjectConfig({ verify: "x".repeat(2000) }).config.verify).toBeDefined();
		expect(parseProjectConfig({ verifyTimeout: 0 }).config.verifyTimeout).toBe(600);
		expect(parseProjectConfig({ maxRounds: 11 }).config.maxRounds).toBe(3);
		expect(parseProjectConfig({ maxRounds: 10, verifyTimeout: 3600 }).error).toBeUndefined();
	});
	it("non-object gives defaults and an error", () => {
		for (const v of [null, "x", 3, [1]]) {
			const r = parseProjectConfig(v);
			expect(r.config).toEqual({ verifyTimeout: 600, maxRounds: 3 });
			expect(r.error).toBeTruthy();
		}
	});
});

describe("M56: readProjectConfig", () => {
	it("reads the base branch, not the working copy or another branch", async () => {
		const r = repo(JSON.stringify({ verify: "base-verify" }));
		writeFileSync(join(r, ".roost", "project.json"), JSON.stringify({ verify: "dirty" }));
		expect((await readProjectConfig(r, "main")).config.verify).toBe("base-verify");
		git(r, "checkout", "-q", "-b", "other");
		writeFileSync(join(r, ".roost", "project.json"), JSON.stringify({ verify: "other-branch" }));
		git(r, "commit", "-qam", "other");
		const res = await readProjectConfig(r, "main");
		expect(res.config.verify).toBe("base-verify");
		expect(res.source).toBe("base");
	});
	it("missing file", async () => {
		const r = await readProjectConfig(repo(), "main");
		expect(r).toEqual({ config: { verifyTimeout: 600, maxRounds: 3 }, source: "none" });
		expect((await readProjectConfig(repo(), "nope")).source).toBe("none");
	});
	it("invalid JSON and invalid fields", async () => {
		const bad = await readProjectConfig(repo("{ nope"), "main");
		expect(bad.config).toEqual({ verifyTimeout: 600, maxRounds: 3 });
		expect(bad.error).toMatch(/JSON/);
		const f = await readProjectConfig(repo(JSON.stringify({ verify: "ok", maxRounds: 99 })), "main");
		expect(f.config.verify).toBe("ok");
		expect(f.config.maxRounds).toBe(3);
		expect(f.error).toMatch(/maxRounds/);
	});
	it("the override wins field by field", async () => {
		const r = repo(JSON.stringify({ verify: "base", setup: "base-setup", maxRounds: 2 }));
		mkdirSync(join(home, "projects"), { recursive: true });
		writeFileSync(overridePath(r), JSON.stringify({ verify: "mine", verifyTimeout: 60, maxRounds: 0 }));
		expect(readOverride(r)).toEqual({ verify: "mine", verifyTimeout: 60 });
		expect((await readProjectConfig(r, "main")).config).toEqual({ verify: "mine", setup: "base-setup", verifyTimeout: 60, maxRounds: 2 });
	});
	it("overridePath is stable and under roostHome", () => {
		expect(roostEnv("HOME")).toBe(home);
		expect(overridePath("/x/y")).toBe(overridePath("/x/y"));
		expect(overridePath("/x/y")).not.toBe(overridePath("/x/z"));
		expect(overridePath("/x/y")).toMatch(/projects[\\/][0-9a-f]{16}\.json$/);
		expect(overridePath("/x/y").startsWith(home)).toBe(true);
	});
});

describe("M56: approvals", () => {
	it("round trip; a changed command is not approved; others kept", () => {
		expect(isApproved("/r", "npm test")).toBe(false);
		approve("/r", ["npm test", "npm ci"]);
		approve("/other", ["make"]);
		approve("/r", ["npm run lint"]);
		expect(isApproved("/r", "npm test")).toBe(true);
		expect(isApproved("/r", "npm ci")).toBe(true);
		expect(isApproved("/r", "npm test ")).toBe(false);
		expect(isApproved("/r", "make")).toBe(false);
		expect(isApproved("/other", "make")).toBe(true);
		expect(commandHash("a")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("M56: logs and commands", () => {
	it("verifyLogPath makes the dir", () => {
		const p = verifyLogPath(4, 2);
		expect(p).toBe(join(home, "verify", "4-2.log"));
		expect(existsSync(join(home, "verify"))).toBe(true);
	});
	it("readLogTail bounds and cleans", () => {
		const p = join(home, "l.log");
		expect(readLogTail(p)).toBe("");
		writeFileSync(p, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
		const t = readLogTail(p).split("\n");
		expect(t).toHaveLength(40);
		expect(t.at(-1)).toBe("line 99");
		expect(readLogTail(p, 2)).toBe("line 98\nline 99");
		writeFileSync(p, "a\u001b[31mred\u0000\tb\r\nend\n");
		expect(readLogTail(p)).toBe("a[31mred\tb\nend");
		writeFileSync(p, "x".repeat(10000) + "END");
		const c = readLogTail(p);
		expect(c).toHaveLength(4000);
		expect(c.endsWith("END")).toBe(true);
	});
	it("verifyCommand keeps the command text verbatim in the shell script", () => {
		// never a real test command here: `npm test` would run this file again, and again
		const cmd = `echo "it's" && true`;
		const argv = verifyCommand(cmd);
		expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		expect(argv[2]).toBe(`exec >"$ROOST_VERIFY_LOG" 2>&1\n${cmd}`);
		const log = join(home, "o.log");
		execFileSync(argv[0]!, argv.slice(1), { env: { ...process.env, ROOST_VERIFY_LOG: log } });
		expect(readLogTail(log)).toBe("it's");
		// every part of a command list is logged, not only the last
		const two = join(home, "two.log");
		try {
			execFileSync("/bin/sh", verifyCommand("echo first; echo second >&2; exit 3").slice(1), { env: { ...process.env, ROOST_VERIFY_LOG: two } });
		} catch {}
		expect(readLogTail(two)).toBe("first\nsecond");
	});
});
