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
		expect(st).toEqual({ exists: true, dirty: false, ignored: false, ahead: 1, atBase: false });
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

	it("keeps ignored files and a branch moved behind base", async () => {
		const r = repo();
		writeFileSync(join(r, ".gitignore"), ".env\n");
		git(r, "add", ".");
		git(r, "commit", "-q", "-m", "ignore");
		const w = createWorktree(r, "x", rand);
		writeFileSync(join(w.path, ".env"), "SECRET=1\n");
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: false, reason: expect.stringContaining("ignores") });
		expect(existsSync(join(w.path, ".env"))).toBe(true);
		rmSync(join(w.path, ".env"));
		git(w.path, "reset", "-q", "--hard", "HEAD~1");
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: true, branchKept: true, reason: "the branch moved" });
		expect(git(r, "branch", "--list", w.branch)).toContain(w.branch);
	});

	it("discard after a refused dispatch removes only what holds nothing", async () => {
		const { discardWorktree } = await import("../lib/worktree.ts");
		const r = repo();
		const dirty = createWorktree(r, "d", rand);
		writeFileSync(join(dirty.path, "work.txt"), "x\n");
		discardWorktree(dirty);
		expect(existsSync(join(dirty.path, "work.txt"))).toBe(true);
		const committed = createWorktree(r, "c", rand);
		writeFileSync(join(committed.path, "src", "a.txt"), "c\n");
		git(committed.path, "commit", "-q", "-am", "c");
		discardWorktree(committed);
		expect(existsSync(committed.path)).toBe(false);
		expect(git(r, "branch", "--list", committed.branch)).toContain(committed.branch);
		const clean = createWorktree(r, "e", rand);
		discardWorktree(clean);
		expect(existsSync(clean.path)).toBe(false);
		expect(git(r, "branch", "--list", clean.branch)).toBe("");
	});

	it("M15: .worktreeinclude copies ignored files it names; rm removes them unless edited", async () => {
		const r = repo();
		writeFileSync(join(r, ".gitignore"), ".env\nnode_modules/\nsecret.key\n");
		writeFileSync(join(r, ".worktreeinclude"), ".env\nnode_modules/\nsrc/a.txt\n");
		git(r, "add", ".");
		git(r, "commit", "-q", "-m", "include");
		writeFileSync(join(r, ".env"), "TOKEN=1\n");
		writeFileSync(join(r, "secret.key"), "k\n");
		mkdirSync(join(r, "node_modules", "dep"), { recursive: true });
		writeFileSync(join(r, "node_modules", "dep", "index.js"), "x\n");
		const w = createWorktree(r, "inc", rand);
		expect(w.included.sort()).toEqual([".env", "node_modules/"]);
		expect(readFileSync(join(w.path, ".env"), "utf8")).toBe("TOKEN=1\n");
		expect(existsSync(join(w.path, "node_modules", "dep", "index.js"))).toBe(true);
		// ignored but not named: not copied; tracked: there anyway
		expect(existsSync(join(w.path, "secret.key"))).toBe(false);
		expect((await worktreeStatus(w)).ignored).toBe(false);
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: true });
		// an edited copy is work
		const w2 = createWorktree(r, "inc2", rand);
		writeFileSync(join(w2.path, ".env"), "TOKEN=2\n");
		expect(await cleanupWorktree(w2, false)).toMatchObject({ removed: false, reason: expect.stringContaining("ignores") });
		// a new ignored file it did not bring in is work too
		const w3 = createWorktree(r, "inc3", rand);
		writeFileSync(join(w3.path, "secret.key"), "mine\n");
		expect(await cleanupWorktree(w3, false)).toMatchObject({ removed: false });
		// the undo after a refused dispatch removes a fresh one with its copies
		const w4 = createWorktree(r, "inc4", rand);
		const { discardWorktree } = await import("../lib/worktree.ts");
		discardWorktree(w4);
		expect(existsSync(w4.path)).toBe(false);
	});

	it("M15: any file name; a new file in an included folder is work; the worktree's own list does not count", async () => {
		const r = repo();
		writeFileSync(join(r, ".gitignore"), "*.local\nconfig/\n");
		writeFileSync(join(r, ".worktreeinclude"), "*.local\nconfig/\n");
		git(r, "add", ".");
		git(r, "commit", "-q", "-m", "include");
		writeFileSync(join(r, "é 名字.local"), "u\n");
		mkdirSync(join(r, "config"));
		writeFileSync(join(r, "config", "a.json"), "{}\n");
		const w = createWorktree(r, "uni", rand);
		expect(w.included.sort()).toEqual(["config/", "é 名字.local"]);
		expect((await worktreeStatus(w)).ignored).toBe(false);
		// a file the session added to an included folder
		writeFileSync(join(w.path, "config", "b.json"), "{}\n");
		expect((await worktreeStatus(w)).ignored).toBe(true);
		expect(await cleanupWorktree(w, false)).toMatchObject({ removed: false });
		// widening its own .worktreeinclude does not make its files disposable
		const w2 = createWorktree(r, "own", rand);
		writeFileSync(join(w2.path, ".worktreeinclude"), "*.local\nconfig/\n*.mine\n");
		writeFileSync(join(w2.path, ".gitignore"), "*.local\nconfig/\n*.mine\n");
		git(w2.path, "commit", "-q", "-am", "widen");
		writeFileSync(join(w2.path, "notes.mine"), "work\n");
		expect((await worktreeStatus(w2)).ignored).toBe(true);
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
	it("only a refusal by the daemon allows the undo", async () => {
		const { refusedByDaemon } = await import("../lib/dispatch.ts");
		const { DaemonError } = await import("../lib/client.ts");
		expect(refusedByDaemon(new DaemonError("limit", "limit"))).toBe(true);
		expect(refusedByDaemon(new DaemonError("daemon connection closed", "closed"))).toBe(false);
		expect(refusedByDaemon(new Error("spawn timed out"))).toBe(false);
	});

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
