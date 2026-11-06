// M52: the board's projects: a repository's root, a worktree counting as its repository.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BoardTask, blockedOn, boardLines, boardSummary, claimable, dependencyMet, manyProjects, needsYou, onBoardOf, parseWorkspace, projectLabel, projectOf, summaryLine, taskLine } from "../lib/board.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });

const task = (id: number, project: string | null, over: Partial<BoardTask> = {}): BoardTask => ({
	id,
	title: `t${id}`,
	detail: null,
	state: "open",
	after: [],
	by: { who: "user", whoId: null },
	at: 1,
	owner: null,
	claimedAt: null,
	doneAt: null,
	result: null,
	assigned: null,
	project,
	waiting: [],
	...over,
});

describe("M52: projects", () => {
	it("a directory's project is its repository's root; a worktree's is its repository's; outside one, none", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "roost-board-")));
		dirs.push(root);
		const repo = join(root, "api");
		mkdirSync(join(repo, "src", "deep"), { recursive: true });
		git(repo, "init", "-q");
		writeFileSync(join(repo, "a.txt"), "a");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "a");
		expect(projectOf(repo)).toBe(repo);
		expect(projectOf(join(repo, "src", "deep"))).toBe(repo);
		git(repo, "worktree", "add", "-q", join(root, "api-wt"), "-b", "wt");
		expect(projectOf(join(root, "api-wt"))).toBe(repo);
		const plain = join(root, "plain");
		mkdirSync(plain);
		expect(projectOf(plain)).toBeNull();
		expect(projectOf("relative/dir")).toBeNull();
		expect(projectOf(null)).toBeNull();
		expect(projectLabel(repo)).toBe("api");
		expect(projectLabel(null)).toBe("any");
	});

	it("a bare repository's worktree is the bare repository's; a nested checkout is its own", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "roost-proj-")));
		dirs.push(root);
		const src = join(root, "src");
		mkdirSync(src);
		git(src, "init", "-q");
		writeFileSync(join(src, "a"), "a");
		git(src, "add", ".");
		git(src, "commit", "-qm", "a");
		git(root, "clone", "-q", "--bare", src, join(root, "repo.git"));
		git(join(root, "repo.git"), "worktree", "add", "-q", join(root, "bw"), "-b", "bw");
		expect(projectOf(join(root, "bw"))).toBe(join(root, "repo.git"));
		// a .git file without a commondir (a submodule's checkout) is the checkout itself
		const sub = join(root, "sub");
		mkdirSync(join(root, "mods", "sub"), { recursive: true });
		mkdirSync(sub);
		writeFileSync(join(sub, ".git"), `gitdir: ${join(root, "mods", "sub")}\n`);
		expect(projectOf(sub)).toBe(sub);
	});

	it("a session sees its project's tasks and those for any session; lines name the project when there are several", () => {
		const all = [task(1, "/w/api"), task(2, "/w/web"), task(3, null)];
		expect(all.filter((t) => onBoardOf(t, "/w/api")).map((t) => t.id)).toEqual([1, 3]);
		expect(all.filter((t) => onBoardOf(t, null)).map((t) => t.id)).toEqual([3]);
		expect(manyProjects(all)).toBe(true);
		expect(manyProjects([task(1, null), task(2, null)])).toBe(false);
		const lines = boardLines(all, 10);
		expect(lines).toContain("- #1 open · [api] t1");
		expect(lines).toContain("- #3 open · [any] t3");
		expect(boardLines([task(4, "/w/api")], 10)).toContain("- #4 open · t4");
	});
});

describe("M54: workspaces on the board", () => {
	const sha = "a".repeat(40);
	const ws = (stage: string, over: Record<string, unknown> = {}) => parseWorkspace({ path: "/r/.pi/worktrees/t1-x-ab12", branch: "roost/t1-x-ab12", baseRef: "main", baseSha: sha, stage, ...over })!;

	it("a stored workspace is normalised; a damaged one is kept as failed, never dropped", () => {
		expect(parseWorkspace(undefined)).toBeNull();
		expect(parseWorkspace(null)).toBeNull();
		const ok = ws("review", { note: "x".repeat(900), verify: { ok: true, at: 5, log: "/l", tail: "t", rounds: 1 }, merge: { tip: sha, oldBase: "b".repeat(40), at: 3 }, comments: [{ file: "a.ts", line: 3, text: "why", lineText: "x", tip: sha, at: 1 }, { file: "", line: 1, text: "no file" }] });
		expect(ok).toMatchObject({ stage: "review", baseRef: "main", baseSha: sha, verify: { ok: true, rounds: 1 }, merge: { tip: sha, oldBase: "b".repeat(40) } });
		expect(ok.note).toHaveLength(500);
		expect(ok.comments).toHaveLength(1);
		expect(ok.merge!.into).toBeUndefined();
		for (const bad of [{}, "x", { path: "relative", branch: "b", stage: "review" }, { path: "/p", stage: "review" }, { path: "/p", branch: "b", stage: "sideways" }]) {
			const w = parseWorkspace(bad)!;
			expect(w.stage).toBe("failed");
			expect(w.note).toMatch(/damaged/);
		}
		expect(parseWorkspace({ path: "/p", branch: "b", stage: "working", baseSha: "nothex" })!.baseSha).toBe("");
	});

	it("dependencies: a task with a workspace holds until merged; another project's until done; dropped never holds", () => {
		const t = task(9, "/r", { after: [1, 2, 3, 4, 5] });
		const all = [
			task(1, "/r", { state: "done" }), // no workspace: done is enough
			task(2, "/r", { state: "claimed", workspace: ws("review") }), // in review: holds
			task(3, "/r", { state: "done", workspace: ws("merged") }), // merged
			task(4, "/other", { state: "claimed", workspace: ws("merged") }), // another project: done counts, not the stage
			task(5, "/r", { state: "dropped", workspace: ws("conflict") }), // dropped
			t,
		];
		expect(blockedOn(t, all)).toEqual([2, 4]);
		expect(dependencyMet(task(6, "/r", { state: "done", workspace: ws("review") }), t)).toBe(false);
		expect(taskLine(t, all)).toBe("#9 blocked on #2 (in review) #4 · t9");
	});

	it("the counts put tasks in workspaces apart, with those that need you; their lines say the stage", () => {
		const all = [
			task(1, "/r"),
			task(2, "/r", { state: "claimed", owner: { id: "j", name: "api-fix" }, workspace: ws("working") }),
			task(3, "/r", { state: "open", workspace: ws("review", { note: "not verified" }) }),
			task(4, "/r", { state: "open", workspace: ws("conflict") }),
			task(5, "/r", { state: "done", workspace: ws("merged") }),
		];
		const s = boardSummary(all);
		expect(s).toEqual({ open: 1, claimed: 0, blocked: 0, done: 1, workspaces: 3, needsYou: 2 });
		expect(summaryLine(s)).toBe("1 open · 3 in workspaces (2 need you) · 1 done");
		expect(summaryLine({ open: 0, claimed: 0, blocked: 0, done: 0, workspaces: 1, needsYou: 1 })).toBe("1 in workspace (1 needs you)");
		expect(summaryLine({ open: 1, claimed: 0, blocked: 0, done: 0 })).toBe("1 open");
		expect(needsYou(all[2]!)).toBe(true);
		// a task with a workspace is never claimable (it is started); one without is, when open and waiting on nothing
		expect(all.filter((t) => claimable(t, all)).map((t) => t.id)).toEqual([1]);
		expect(needsYou(all[1]!)).toBe(false);
		expect(taskLine(all[1]!, all)).toBe("#2 working · api-fix · t2");
		expect(taskLine(all[2]!, all)).toBe("#3 in review · t3 (not verified)");
		expect(taskLine(all[4]!, all, 1)).toMatch(/^#5 done/);
		expect(boardLines(all, 1).slice(1)).toEqual(["- #1 open · t1", "- #2 working · api-fix · t2", "- #3 in review · t3 (not verified)", "- #4 conflict · t4"]);
	});
});
