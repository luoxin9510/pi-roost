// M52: the board's projects: a repository's root, a worktree counting as its repository.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BoardTask, boardLines, manyProjects, onBoardOf, projectLabel, projectOf } from "../lib/board.ts";

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
