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
import { type BoardWho, type Clock, createWorkspaces, PREPARED_MS } from "../lib/workspace.ts";

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
/** A clock the test moves: its timers fire when it passes them. */
function manualClock() {
	let t = 0;
	const timers: { at: number; fn: () => void; done: boolean }[] = [];
	const clock: Clock = {
		now: () => t,
		timer: (fn, ms) => {
			const x = { at: t + ms, fn, done: false };
			timers.push(x);
			return { clear: () => void (x.done = true) };
		},
	};
	const advance = (ms: number) => {
		t += ms;
		for (const x of timers) if (!x.done && x.at <= t) {
			x.done = true;
			x.fn();
		}
	};
	return { clock, advance };
}

function world(clock?: Clock) {
	const tasks = new Map<number, BoardTask>();
	const events: Omit<RoostEvent, "seq" | "at">[] = [];
	const dispatched: DispatchArgs[] = [];
	const live = new Set<string>();
	const commands: { id: string; verifyOf?: number; setupOf?: number; running: boolean }[] = [];
	const stopped: string[] = [];
	const removed: string[] = [];
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
			stop: async (id) => {
				stopped.push(id);
				live.delete(id);
			},
			remove: async (id) => void removed.push(id),
			live: (id) => live.has(id),
			commandJobs: () => commands,
		},
		conciergeMayAct: () => false,
		conciergeLaunch: (l) => l,
		...(clock ? { clock } : {}),
	});
	const stages = () => events.filter((e) => e.why === "stage").map((e) => e.text);
	return { ws, tasks, events, dispatched, live, commands, stopped, removed, stages, saves: () => saves };
}

const newTask = (id: number, project: string): BoardTask => ({ id, title: "write b", detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: 0, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project, waiting: [] });

describe("M64: the Workspace module, in process", () => {
	it("a Task from its start to its merge: working, in review (no Verify command), merged into Base; the worktree goes once its session is gone", async () => {
		const r = repo();
		const { ws, tasks, dispatched, live, stages } = world();
		const t = newTask(1, r);
		tasks.set(1, t);
		// M65: the module makes the worktree (prepare), the start goes into it
		const w = (await ws.act(person, t, "prepare", {})).workspace!;
		expect(w).toMatchObject({ baseRef: "main", branch: expect.stringMatching(/^roost\/t1-write-b-/) });
		expect(existsSync(w.path)).toBe(true);
		const launch: DispatchArgs = { cwd: w.path, sessionFile: join(w.path, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" };
		const started = await ws.act(person, t, "start", { launch });
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
		const w = (await ws.act(person, t, "prepare", {})).workspace!;
		const launch: DispatchArgs = { cwd: w.path, sessionFile: join(w.path, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" };
		const args = { launch };
		const first = ws.act(person, t, "start", args);
		await expect(ws.act(person, t, "start", args)).rejects.toMatchObject({ code: "conflict" });
		await first;
	});

	it("drop: refused while its Workspace merges (before anything else is looked at), and the board is not touched", async () => {
		const { ws } = world();
		const t: BoardTask = { ...newTask(1, "/nowhere"), state: "done", workspace: { path: "/nowhere/w", branch: "roost/t1-x-0000", baseRef: "main", baseSha: "a".repeat(40), stage: "merging", note: null } };
		let marked = false;
		await expect(ws.drop(t, () => void (marked = true))).rejects.toMatchObject({ code: "conflict" });
		expect(marked).toBe(false);
	});

	it("settle: a Verify a restart cut short goes to review, a setup to failed; command jobs no run reports to are stopped and removed", async () => {
		const { ws, tasks, commands, stopped, removed } = world();
		const ws1 = { path: "/r/w1", branch: "roost/t1-a-0000", baseRef: "main", baseSha: "a".repeat(40) };
		tasks.set(1, { ...newTask(1, "/r"), workspace: { ...ws1, stage: "verifying", note: "running sh check.sh" } });
		tasks.set(2, { ...newTask(2, "/r"), workspace: { ...ws1, branch: "roost/t2-b-0000", stage: "working", note: "setting up: npm ci" } });
		tasks.set(3, { ...newTask(3, "/r"), workspace: { ...ws1, branch: "roost/t3-c-0000", stage: "working", note: null } });
		commands.push({ id: "v1", verifyOf: 1, running: true }, { id: "s2", setupOf: 2, running: false });
		ws.settle();
		expect(tasks.get(1)!.workspace).toMatchObject({ stage: "review", note: "not verified (interrupted)" });
		expect(tasks.get(2)!.workspace).toMatchObject({ stage: "failed", note: "setup interrupted: /tasks start again" });
		expect(tasks.get(3)!.workspace).toMatchObject({ stage: "working", note: null });
		await new Promise((r) => setTimeout(r, 20));
		expect(stopped).toEqual(["v1"]);
		expect(removed.sort()).toEqual(["s2", "v1"]);
	});

	it("M65: a start not prepared for is refused; a refused start removes the worktree prepared for it; prepare again holds the same one", async () => {
		const r = repo();
		const { ws, tasks } = world();
		const t = newTask(1, r);
		tasks.set(1, t);
		const launch = (cwd: string): DispatchArgs => ({ cwd, sessionFile: join(cwd, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" });
		await expect(ws.act(person, t, "start", { launch: launch(r) })).rejects.toThrow(/not prepared/);
		const w = (await ws.act(person, t, "prepare", {})).workspace!;
		expect((await ws.act(person, t, "prepare", {})).workspace?.path).toBe(w.path);
		// a launch outside its worktree: refused, the worktree and its branch gone
		await expect(ws.act(person, t, "start", { launch: launch(r) })).rejects.toMatchObject({ code: "bad_request" });
		expect(existsSync(w.path)).toBe(false);
		expect(git(r, "branch", "--list", w.branch)).toBe("");
		expect(t.workspace).toBeUndefined();
	});

	it("M65: a worktree prepared and never started is removed after PREPARED_MS", async () => {
		const r = repo();
		const { clock, advance } = manualClock();
		const { ws, tasks } = world(clock);
		const t = newTask(1, r);
		tasks.set(1, t);
		const w = (await ws.act(person, t, "prepare", {})).workspace!;
		advance(PREPARED_MS - 1);
		expect(existsSync(w.path)).toBe(true);
		advance(1);
		expect(existsSync(w.path)).toBe(false);
	});
});
