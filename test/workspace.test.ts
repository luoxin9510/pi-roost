// M64: the Workspace module through its own interface: the board and the jobs in memory,
// git real in a temporary repository. (M66 moves the lifecycle's rules here.)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardTask } from "../lib/board.ts";
import type { RoostEvent } from "../lib/events.ts";
import type { DispatchArgs } from "../lib/protocol.ts";
import { createTaskWorktree } from "../lib/task-git.ts";
import { type BoardWho, createWorkspaces } from "../lib/workspace.ts";

const dirs: string[] = [];
let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "roost-ws-home-"));
	dirs.push(home);
	process.env.PI_ROOST_HOME = home;
	process.env.PI_ROOST_CONFIG_DIR = home;
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.PI_ROOST_HOME;
	delete process.env.PI_ROOST_CONFIG_DIR;
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

function repo(): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "roost-ws-")));
	dirs.push(d);
	git(d, "init", "-q", "-b", "main");
	writeFileSync(join(d, "a.txt"), "a\n");
	git(d, "add", ".");
	git(d, "commit", "-q", "-m", "init");
	return d;
}

const person: BoardWho = { who: "user", whoId: null, sessionId: null, concierge: false, project: null };

/** The module with its board and jobs in memory: what it recorded, what it dispatched. */
function world() {
	const tasks = new Map<number, BoardTask>();
	const events: Omit<RoostEvent, "seq" | "at">[] = [];
	const dispatched: DispatchArgs[] = [];
	const live = new Set<string>();
	let saves = 0;
	const ws = createWorkspaces({
		board: {
			tasks,
			save: () => void saves++,
			record: (e) => void events.push(e),
			push: () => {},
			taskEvent: (a, why, t, extra) => void events.push({ kind: "task", id: a.whoId ?? "", name: a.who, who: a.who, whoId: a.whoId, why, text: `#${t.id} ${t.title}${extra ? `: ${extra}` : ""}` }),
			tellOwner: async () => true,
			tellOpened: () => {},
		},
		jobs: {
			dispatch: async (launch) => {
				dispatched.push(launch);
				const id = `j${dispatched.length}`;
				live.add(id);
				return { id, name: launch.name ?? id };
			},
			stop: async (id) => void live.delete(id),
			remove: async () => {},
			live: (id) => live.has(id),
			commandJobs: () => [],
		},
		conciergeMayAct: () => false,
		conciergeLaunch: (l) => l,
	});
	const stages = () => events.filter((e) => e.why === "stage").map((e) => e.text);
	return { ws, tasks, events, dispatched, live, stages, saves: () => saves };
}

const newTask = (id: number, project: string): BoardTask => ({ id, title: "write b", detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: 0, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project, waiting: [] });

describe("M64: the Workspace module, in process", () => {
	it("a Task from its start to its merge: working, in review (no Verify command), merged into Base; the worktree goes once its session is gone", async () => {
		const r = repo();
		const { ws, tasks, dispatched, live, stages } = world();
		const t = newTask(1, r);
		tasks.set(1, t);
		const w = createTaskWorktree(r, 1, t.title);
		const launch: DispatchArgs = { cwd: w.path, sessionFile: join(w.path, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" };
		const started = await ws.act(person, t, "start", { workspace: { path: w.path, branch: w.branch, baseRef: w.baseRef, baseSha: w.base }, launch });
		expect(started.job).toEqual({ id: "j1", name: "writer" });
		expect(dispatched).toHaveLength(1);
		expect(t).toMatchObject({ state: "claimed", owner: { id: "j1" }, workspace: { stage: "working", branch: w.branch } });

		// the session commits and says done: no verify command in the repository, so review
		writeFileSync(join(w.path, "b.txt"), "b\n");
		git(w.path, "add", "b.txt");
		git(w.path, "commit", "-q", "-m", "b");
		const session: BoardWho = { who: "writer", whoId: "j1", sessionId: "j1", concierge: false, project: r };
		await ws.done(session, t, "wrote b");
		expect(t.workspace).toMatchObject({ stage: "review" });
		expect(t.result).toBe("wrote b");

		// its session gone, the Person merges: into main, the worktree and branch removed
		live.delete("j1");
		const merged = await ws.act(person, t, "merge", {});
		expect(merged.note).toContain("merged into main");
		expect(t).toMatchObject({ state: "done", workspace: { stage: "merged" } });
		expect(git(r, "log", "--format=%s", "main")).toContain("b");
		expect(existsSync(w.path)).toBe(false);
		expect(stages()).toEqual([expect.stringContaining("working"), expect.stringContaining("in review"), expect.stringContaining("merging"), expect.stringContaining("merged")]);
	});

	it("one action on a Workspace at a time: a second while the first runs is a conflict", async () => {
		const r = repo();
		const { ws, tasks } = world();
		const t = newTask(1, r);
		tasks.set(1, t);
		const w = createTaskWorktree(r, 1, t.title);
		const launch: DispatchArgs = { cwd: w.path, sessionFile: join(w.path, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" };
		const args = { workspace: { path: w.path, branch: w.branch, baseRef: w.baseRef, baseSha: w.base }, launch };
		const first = ws.act(person, t, "start", args);
		await expect(ws.act(person, t, "start", args)).rejects.toMatchObject({ code: "conflict" });
		await first;
	});
});
