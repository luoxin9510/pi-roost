import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	abortSync, cleanupMergedTask, commitAll, createTaskWorktree, findCheckout, hasIdentity, isAncestor, mergeIntoBase, revParse, syncWithBase, taskTag, withMergeLock, worktreeClean,
} from "../lib/task-git.ts";
import { WorktreeError, validWorktree } from "../lib/worktree.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function repo(): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "roost-tg-")));
	dirs.push(d);
	git(d, "init", "-q", "-b", "main");
	writeFileSync(join(d, "a.txt"), "a\n");
	git(d, "add", ".");
	git(d, "commit", "-q", "-m", "init");
	return d;
}

let n = 0;
const rand = () => (n++).toString(16).padStart(4, "0");
const commitFile = (dir: string, file: string, text: string, msg = file) => {
	writeFileSync(join(dir, file), text);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", msg);
	return git(dir, "rev-parse", "HEAD");
};

/** A repo with a task worktree that has one commit of its own. */
function task() {
	const r = repo();
	const w = createTaskWorktree(r, 1, "do it", rand);
	const tip = commitFile(w.path, "t.txt", "t\n");
	return { r, w, tip };
}

describe("taskTag", () => {
	it("keeps the part before the hex within 32 characters", () => {
		const tag = taskTag(9999, "a very long title that goes on and on and on", () => "abcd");
		expect(tag).toMatch(/^t9999-[a-z0-9-]+-abcd$/);
		expect(tag.slice(0, -5).length).toBeLessThanOrEqual(32);
		expect(tag).toMatch(/^[a-z0-9-]{1,32}-[0-9a-f]{4}$/);
	});
	it("falls back to task for a title with no ASCII letters", () => {
		expect(taskTag(4, "修复登录", () => "00ff")).toBe("t4-task-00ff");
	});
});

describe("createTaskWorktree", () => {
	it("branches from the checked out branch and validWorktree accepts it", async () => {
		const r = repo();
		git(r, "checkout", "-q", "-b", "dev");
		const tipDev = commitFile(r, "d.txt", "d\n");
		const w = createTaskWorktree(r, 7, "Fix users migration", rand);
		expect(w.baseRef).toBe("dev");
		expect(w.base).toBe(tipDev);
		expect(w.repo).toBe(r);
		expect(w.branch).toMatch(/^roost\/t7-fix-users-migration-[0-9a-f]{4}$/);
		expect(w.cwd).toBe(w.path);
		expect(existsSync(join(w.path, "d.txt"))).toBe(true);
		expect(git(w.path, "symbolic-ref", "--short", "HEAD")).toBe(w.branch);
		expect(await validWorktree(w)).toBe(true);
	});
	it("works from inside a linked worktree (base is the main checkout's branch)", () => {
		const r = repo();
		const first = createTaskWorktree(r, 1, "one", rand);
		const second = createTaskWorktree(first.path, 2, "two", rand);
		expect(second.repo).toBe(r);
		expect(second.baseRef).toBe("main");
	});
	it("refuses a detached HEAD, a non-repository and a bare repository", () => {
		const r = repo();
		git(r, "checkout", "-q", "--detach");
		expect(() => createTaskWorktree(r, 1, "x", rand)).toThrow(/check out a branch first/);
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "roost-tg-plain-")));
		dirs.push(plain);
		expect(() => createTaskWorktree(plain, 1, "x")).toThrow(WorktreeError);
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "roost-tg-bare-")));
		dirs.push(bare);
		git(bare, "init", "-q", "--bare");
		expect(() => createTaskWorktree(bare, 1, "x")).toThrow(/bare/);
	});
});

describe("worktreeClean / commitAll / hasIdentity", () => {
	it("worktreeClean sees tracked and untracked changes, not ignored files", async () => {
		const r = repo();
		writeFileSync(join(r, ".gitignore"), "ign\n");
		git(r, "add", ".");
		git(r, "commit", "-q", "-m", "ignore");
		expect(await worktreeClean(r)).toBe(true);
		writeFileSync(join(r, "ign"), "x");
		expect(await worktreeClean(r)).toBe(true);
		writeFileSync(join(r, "new.txt"), "x");
		expect(await worktreeClean(r)).toBe(false);
		expect(await worktreeClean(join(r, "missing"))).toBeUndefined();
	});
	it("commitAll commits everything, and says when there is nothing", async () => {
		const r = repo();
		expect(await commitAll(r, "none")).toEqual({ ok: false, error: "nothing to commit" });
		writeFileSync(join(r, "a.txt"), "changed\n");
		writeFileSync(join(r, "b.txt"), "new\n");
		const c = await commitAll(r, "work");
		expect(c.ok && c.sha).toBe(git(r, "rev-parse", "HEAD"));
		expect(git(r, "log", "-1", "--format=%s")).toBe("work");
		expect(await worktreeClean(r)).toBe(true);
	});
	it("commitAll refuses while a merge is in progress", async () => {
		const { w, r } = task();
		commitFile(r, "x.txt", "main\n");
		commitFile(w.path, "x.txt", "task\n");
		await syncWithBase(w.path, "main");
		writeFileSync(join(w.path, "x.txt"), "resolved\n");
		const c = await commitAll(w.path, "oops");
		expect(c.ok).toBe(false);
		expect(!c.ok && c.error).toMatch(/merge is in progress/);
	});
	it("commitAll reports a failing hook", async () => {
		const r = repo();
		writeFileSync(join(r, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho nope >&2\nexit 1\n");
		chmodSync(join(r, ".git", "hooks", "pre-commit"), 0o755);
		writeFileSync(join(r, "b.txt"), "b");
		const c = await commitAll(r, "x");
		expect(!c.ok && c.error).toMatch(/nope/);
	});
	it("hasIdentity reads repo-local config", async () => {
		const r = repo();
		const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		try {
			expect(await hasIdentity(r)).toBe(false);
			git(r, "config", "user.name", "x");
			expect(await hasIdentity(r)).toBe(false);
			git(r, "config", "user.email", "x@x");
			expect(await hasIdentity(r)).toBe(true);
		} finally {
			if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved.g;
			if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
			else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
		}
	});
	it("revParse and isAncestor", async () => {
		const r = repo();
		const a = git(r, "rev-parse", "HEAD");
		const b = commitFile(r, "b.txt", "b");
		expect(await revParse(r, "HEAD")).toBe(b);
		expect(await revParse(r, "nope")).toBeUndefined();
		expect(await isAncestor(r, a, b)).toBe(true);
		expect(await isAncestor(r, b, a)).toBe(false);
	});
});

describe("syncWithBase / abortSync", () => {
	it("is clean without moving when base is already in the branch", async () => {
		const { w } = task();
		expect(await syncWithBase(w.path, "main")).toEqual({ kind: "clean", moved: false });
	});
	it("merges a moved base", async () => {
		const { w, r } = task();
		commitFile(r, "m.txt", "m\n");
		expect(await syncWithBase(w.path, "main")).toEqual({ kind: "clean", moved: true });
		expect(existsSync(join(w.path, "m.txt"))).toBe(true);
		expect(await isAncestor(r, "main", w.branch)).toBe(true);
	});
	it("stops at a conflict, leaves it in progress, abortSync undoes it", async () => {
		const { w, r, tip } = task();
		commitFile(r, "x.txt", "main\n");
		commitFile(w.path, "x.txt", "task\n");
		const tip2 = git(w.path, "rev-parse", "HEAD");
		const s = await syncWithBase(w.path, "main");
		expect(s).toEqual({ kind: "conflict", files: ["x.txt"] });
		expect(await syncWithBase(w.path, "main")).toEqual({ kind: "conflict", files: ["x.txt"] });
		expect(await abortSync(w.path)).toBe(true);
		expect(git(w.path, "rev-parse", "HEAD")).toBe(tip2);
		expect(tip2).not.toBe(tip);
		expect(await abortSync(w.path)).toBe(false);
	});
	it("a resolved but uncommitted merge asks to be finished", async () => {
		const { w, r } = task();
		commitFile(r, "x.txt", "main\n");
		commitFile(w.path, "x.txt", "task\n");
		await syncWithBase(w.path, "main");
		writeFileSync(join(w.path, "x.txt"), "both\n");
		git(w.path, "add", "x.txt");
		const s = await syncWithBase(w.path, "main");
		expect(s.kind).toBe("error");
		expect(s.kind === "error" && s.message).toMatch(/finish the merge/);
		git(w.path, "commit", "-q", "--no-edit");
		expect(await syncWithBase(w.path, "main")).toEqual({ kind: "clean", moved: false });
	});
});

describe("findCheckout", () => {
	it("finds main, another worktree, or nothing", async () => {
		const r = repo();
		const w = createTaskWorktree(r, 1, "a", rand);
		expect(await findCheckout(w.path, "main")).toBe(r);
		expect(await findCheckout(r, w.branch)).toBe(w.path);
		git(r, "branch", "elsewhere");
		expect(await findCheckout(r, "elsewhere")).toBeNull();
		expect(await findCheckout(r, "nope")).toBeNull();
	});
});

describe("mergeIntoBase", () => {
	const args = (t: ReturnType<typeof task>, mode: "ff" | "no-ff", oldBase = t.w.base) => ({ repo: t.r, branch: t.w.branch, baseRef: "main", tip: t.tip, oldBase, mode });

	it("fast-forwards the main checkout", async () => {
		const t = task();
		const res = await mergeIntoBase(args(t, "ff"));
		expect(res).toEqual({ kind: "merged", into: t.tip });
		expect(git(t.r, "rev-parse", "main")).toBe(t.tip);
		expect(existsSync(join(t.r, "t.txt"))).toBe(true);
	});
	it("makes a merge commit with no-ff", async () => {
		const t = task();
		const res = await mergeIntoBase(args(t, "no-ff"));
		expect(res.kind).toBe("merged");
		expect(git(t.r, "log", "-1", "--format=%s")).toBe(`Merge ${t.w.branch}`);
		expect(git(t.r, "rev-list", "--parents", "-1", "main").split(" ")).toHaveLength(3);
		expect(res.kind === "merged" && res.into).toBe(git(t.r, "rev-parse", "main"));
	});
	it("refuses a dirty checkout and names it", async () => {
		const t = task();
		writeFileSync(join(t.r, "a.txt"), "dirty\n");
		const res = await mergeIntoBase(args(t, "ff"));
		expect(res.kind).toBe("refused");
		expect(res.kind === "refused" && res.reason).toContain(t.r);
		expect(git(t.r, "rev-parse", "main")).toBe(t.w.base);
	});
	it("merges where base is checked out in another worktree", async () => {
		const t = task();
		git(t.r, "checkout", "-q", "-b", "other");
		const other = join(t.r, ".pi", "worktrees", "basewt");
		git(t.r, "worktree", "add", "-q", other, "main");
		const res = await mergeIntoBase(args(t, "ff"));
		expect(res).toEqual({ kind: "merged", into: t.tip });
		expect(existsSync(join(other, "t.txt"))).toBe(true);
		expect(await findCheckout(t.r, "main")).toBe(realpathSync(other));
	});
	it("moves the ref when base is checked out nowhere", async () => {
		const t = task();
		git(t.r, "checkout", "-q", "-b", "other");
		const res = await mergeIntoBase(args(t, "ff"));
		expect(res).toEqual({ kind: "merged", into: t.tip });
		expect(git(t.r, "rev-parse", "main")).toBe(t.tip);
	});
	it("update-ref path in a bare-style setup: ref moved, nothing else touched", async () => {
		const t = task();
		git(t.r, "checkout", "-q", "--detach");
		const res = await mergeIntoBase(args(t, "no-ff"));
		expect(res).toEqual({ kind: "merged", into: t.tip });
	});
	it("says moved when base is no longer oldBase", async () => {
		const t = task();
		commitFile(t.r, "m.txt", "m\n");
		expect(await mergeIntoBase(args(t, "ff"))).toEqual({ kind: "moved" });
		git(t.r, "checkout", "-q", "-b", "other");
		expect(await mergeIntoBase(args(t, "ff"))).toEqual({ kind: "moved" });
	});
	it("a failing pre-merge-commit hook (no-ff) fails with base unmoved and no merge left", async () => {
		const t = task();
		writeFileSync(join(t.r, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\necho blocked >&2\nexit 1\n");
		chmodSync(join(t.r, ".git", "hooks", "pre-merge-commit"), 0o755);
		const res = await mergeIntoBase(args(t, "no-ff"));
		expect(res.kind).toBe("failed");
		expect(res.kind === "failed" && res.baseMoved).toBe(false);
		expect(res.kind === "failed" && res.message).toMatch(/blocked/);
		expect(git(t.r, "rev-parse", "main")).toBe(t.w.base);
		expect(existsSync(join(t.r, ".git", "MERGE_HEAD"))).toBe(false);
		expect(await worktreeClean(t.r)).toBe(true);
	});
	it("isAncestor sees a branch merged by hand", async () => {
		const t = task();
		git(t.r, "merge", "-q", "--no-ff", "-m", "by hand", t.w.branch);
		expect(await isAncestor(t.r, t.tip, "main")).toBe(true);
	});
});

describe("cleanupMergedTask", () => {
	it("removes a clean worktree and the merged branch", async () => {
		const t = task();
		await mergeIntoBase({ repo: t.r, branch: t.w.branch, baseRef: "main", tip: t.tip, oldBase: t.w.base, mode: "ff" });
		const res = await cleanupMergedTask({ repo: t.r, path: t.w.path, branch: t.w.branch, tip: t.tip, baseRef: "main" });
		expect(res).toEqual({ worktreeRemoved: true, branchDeleted: true });
		expect(existsSync(t.w.path)).toBe(false);
		expect(git(t.r, "branch", "--list", t.w.branch)).toBe("");
	});
	it("keeps a dirty worktree and its branch", async () => {
		const t = task();
		await mergeIntoBase({ repo: t.r, branch: t.w.branch, baseRef: "main", tip: t.tip, oldBase: t.w.base, mode: "ff" });
		writeFileSync(join(t.w.path, "wip.txt"), "wip");
		const res = await cleanupMergedTask({ repo: t.r, path: t.w.path, branch: t.w.branch, tip: t.tip, baseRef: "main" });
		expect(res.worktreeRemoved).toBe(false);
		expect(res.branchDeleted).toBe(false);
		expect(res.reason).toMatch(/uncommitted/);
		expect(existsSync(t.w.path)).toBe(true);
	});
	it("keeps a branch that moved or is not in base", async () => {
		const t = task();
		const res = await cleanupMergedTask({ repo: t.r, path: t.w.path, branch: t.w.branch, tip: t.tip, baseRef: "main" });
		expect(res.worktreeRemoved).toBe(true);
		expect(res.branchDeleted).toBe(false);
		expect(res.reason).toMatch(/not in base/);
		expect(git(t.r, "branch", "--list", t.w.branch)).not.toBe("");
	});
});

describe("withMergeLock", () => {
	it("excludes a second holder and releases afterwards", async () => {
		const r = repo();
		let inner: unknown;
		const out = await withMergeLock(r, async () => {
			inner = await withMergeLock(r, async () => "second");
			return "first";
		});
		expect(out).toBe("first");
		expect(inner).toEqual({ locked: true });
		expect(existsSync(join(r, ".git", "roost-merge.lock"))).toBe(false);
		expect(await withMergeLock(r, async () => "again")).toBe("again");
	});
	it("releases after fn throws", async () => {
		const r = repo();
		await expect(withMergeLock(r, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
		expect(existsSync(join(r, ".git", "roost-merge.lock"))).toBe(false);
	});
	it("takes over a stale lock", async () => {
		const r = repo();
		const lock = join(r, ".git", "roost-merge.lock");
		writeFileSync(lock, "999");
		expect(await withMergeLock(r, async () => "x")).toEqual({ locked: true });
		const old = new Date(Date.now() - 3_600_000);
		utimesSync(lock, old, old);
		expect(await withMergeLock(r, async () => "x")).toBe("x");
		expect(existsSync(lock)).toBe(false);
	});
});
