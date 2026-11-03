import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, slugOf, validWorktree, worktreeLine, worktreeStatus } from "../lib/worktree.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function repo(commit = true): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "roost-wt-")));
	dirs.push(d);
	git(d, "init", "-q", "-b", "main");
	mkdirSync(join(d, "src"));
	writeFileSync(join(d, "src", "a.txt"), "a\n");
	if (commit) {
		git(d, "add", ".");
		git(d, "commit", "-q", "-m", "init");
	}
	return d;
}

let n = 0;
const rand = () => (n++).toString(16).padStart(4, "0");

describe("worktree", () => {
	it("slugs names", () => {
		expect(slugOf("Fix the flaky test!")).toBe("fix-the-flaky-test");
		expect(slugOf("修复")).toBe("task");
		expect(slugOf("a".repeat(50))).toHaveLength(32);
	});

	it("creates under the main checkout, maps the subdirectory, excludes the folder once", async () => {
		const r = repo();
		const w = createWorktree(join(r, "src"), "Do it", rand);
		expect(w.path.startsWith(join(r, ".pi", "worktrees", "do-it-"))).toBe(true);
		expect(w.branch).toMatch(/^roost\/do-it-/);
		expect(w.cwd).toBe(join(w.path, "src"));
		expect(w.repo).toBe(r);
		expect(w.base).toMatch(/^[0-9a-f]{40}$/);
		expect(w.sourceDirty).toBe(false);
		expect(git(r, "status", "--porcelain")).toBe("");
		expect(await validWorktree(w)).toBe(true);
		// from inside that worktree, the next one still goes under the main checkout
		const w2 = createWorktree(w.cwd, "Do it", rand);
		expect(w2.path.startsWith(join(r, ".pi", "worktrees"))).toBe(true);
		const exclude = readFileSync(join(r, ".git", "info", "exclude"), "utf8");
		expect(exclude.match(/\/\.pi\/worktrees\//g)).toHaveLength(1);
	});

	it("refuses outside a repository and without commits", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "roost-wt-")));
		dirs.push(plain);
		expect(() => createWorktree(plain, "x")).toThrow(/not in a git repository/);
		expect(() => createWorktree(repo(false), "x")).toThrow(/no commits/);
	});

	it("notes a dirty source checkout", async () => {
		const r = repo();
		writeFileSync(join(r, "src", "a.txt"), "changed\n");
		expect(createWorktree(r, "x", rand).sourceDirty).toBe(true);
	});

	it("rejects records that are not its worktrees", async () => {
		const r = repo();
		const w = createWorktree(r, "x", rand);
		expect(await validWorktree({ ...w, branch: "main" })).toBe(false);
		expect(await validWorktree({ ...w, path: r })).toBe(false);
		expect(await validWorktree({ ...w, base: "nope" })).toBe(false);
		// a real worktree, but not one of ours
		git(r, "worktree", "add", "-q", "-b", "roost/other-0001", join(r, "elsewhere"));
		expect(await validWorktree({ ...w, path: join(r, "elsewhere"), branch: "roost/other-0001" })).toBe(false);
	});

	it("removes a clean worktree and its empty branch", async () => {
		const r = repo();
		const w = createWorktree(r, "x", rand);
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: true, branchKept: false });
		expect(existsSync(w.path)).toBe(false);
		expect(git(r, "branch", "--list", w.branch)).toBe("");
	});

	it("keeps the branch when it has commits, and says so in the report line", async () => {
		const r = repo();
		const w = createWorktree(r, "x", rand);
		writeFileSync(join(w.path, "src", "a.txt"), "b\n");
		git(w.path, "commit", "-q", "-am", "work");
		const st = await worktreeStatus(w);
		expect(st).toEqual({ exists: true, dirty: false, ahead: 1 });
		expect(worktreeLine(w, st)).toBe(`Worktree: ${w.path} · branch ${w.branch} · 1 commit on it`);
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: true, branchKept: true, reason: "1 commit on the branch" });
		expect(existsSync(w.path)).toBe(false);
		expect(git(r, "branch", "--list", w.branch)).toContain(w.branch);
	});

	it("keeps a worktree with uncommitted or untracked changes, or one in use", async () => {
		const r = repo();
		const w = createWorktree(r, "x", rand);
		writeFileSync(join(w.path, "new.txt"), "x\n");
		expect(worktreeLine(w, await worktreeStatus(w))).toContain("uncommitted changes");
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: false, branchKept: true, reason: "it has uncommitted changes" });
		expect(existsSync(join(w.path, "new.txt"))).toBe(true);
		const w2 = createWorktree(r, "y", rand);
		expect(await cleanupWorktree(w2, true)).toMatchObject({ removed: false, reason: "another session uses it" });
		expect(existsSync(w2.path)).toBe(true);
	});

	it("keeps a worktree that switched branches", async () => {
		const r = repo();
		const w = createWorktree(r, "x", rand);
		git(w.path, "switch", "-q", "-c", "other");
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: false, reason: "it is no longer on its branch" });
	});

	it("prunes a worktree deleted by hand", async () => {
		const r = repo();
		const w = createWorktree(r, "x", rand);
		rmSync(w.path, { recursive: true, force: true });
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: true, branchKept: false });
		expect(git(r, "worktree", "list")).not.toContain(w.path);
	});
});

describe("prepareIsolation", () => {
	it("explicit requests fail outside a repository; defaults fall back with a note", async () => {
		const { prepareIsolation, isolationDefault } = await import("../lib/dispatch.ts");
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "roost-wt-")));
		dirs.push(plain);
		expect(() => prepareIsolation(plain, "x", true, true)).toThrow(/not in a git repository/);
		expect(prepareIsolation(plain, "x", true, false)).toMatchObject({ cwd: plain, note: expect.stringContaining("no worktree") });
		expect(prepareIsolation(plain, "x", false, false).worktree).toBeUndefined();
		const r = repo();
		const iso = prepareIsolation(join(r, "src"), "x", true, true);
		expect(iso.cwd.startsWith(join(r, ".pi", "worktrees"))).toBe(true);
		iso.discard();
		expect(existsSync(iso.worktree!.path)).toBe(false);
		expect(git(r, "branch", "--list", iso.worktree!.branch)).toBe("");
		expect([isolationDefault("off", true), isolationDefault("children", true), isolationDefault("children", false), isolationDefault("all", false)]).toEqual([false, true, false, true]);
	});
});
