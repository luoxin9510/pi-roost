// M64: a Task's Workspace, from its start to its merge (docs/plans/workspace-module.md;
// GLOSSARY.md: Task, Workspace, Stage, Base, Verify, Review). One module owns the Stage
// machine and every action on a Workspace, the Verify queue and its slots, one merge per
// repository, and what a restart cut short. The daemon gives it two ports, each with an
// adapter of its own and one for tests: Board (the tasks, saving them, the event feed,
// the board pushed to the hub, telling a Task's holder) and Jobs (dispatching a session
// or a command, stopping one, whether a session lives). Git is not a port: tests use real
// repositories. The clock is passed in.
//
// Its promises: one action on a Task's Workspace at a time (another is a conflict); at
// most VERIFY_SLOTS Verifies at once in a repository, the rest queue; one merge per
// repository at a time (and a lock file against another daemon); a restart settles a
// merge, a Verify or a setup it cut short.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type BoardTask, blockedOn, projectLabel, REVIEW_COMMENTS_MAX, type ReviewComment, reviewText, stageLabel, TASK_NOTE_MAX, TASK_TEXT_MAX, type TaskWorkspace, type WorkspaceStage } from "./board.ts";
import { CONCIERGE_NAME } from "./concierge.ts";
import { envPolicy, loadUserConfig } from "./config.ts";
import { workerEnv } from "./dispatch.ts";
import { clipText, type RoostEvent } from "./events.ts";
import { OpError, realPath, str, taskText } from "./op.ts";
import { roostHome } from "./paths.ts";
import { approve, commandHash, isApproved, readLogTail, readProjectConfig, verifyCommand, verifyLogPath } from "./project-config.ts";
import type { DispatchArgs } from "./protocol.ts";
import { abortSync, cleanupMergedTask, commitAll, currentBranch, hasIdentity, isAncestor, mergeIntoBase, openTaskPr, prTarget, removeTaskWorktree, revParse, syncWithBase, taskWorktrees, withMergeLock, worktreeClean } from "./task-git.ts";
import { isInside, validWorktree, WORKTREES_DIR } from "./worktree.ts";

/** Who did it, as the board records it: the hub (`user`), the concierge, or a session. */
export interface BoardWho {
	who: string;
	whoId: string | null;
	sessionId: string | null;
	concierge: boolean;
	project: string | null;
}

export type WorkspaceAction = "start" | "merge" | "back" | "abort" | "commit" | "approve" | "verify" | "pass" | "comment" | "uncomment" | "shelve" | "pr";
export const WORKSPACE_ACTIONS: readonly WorkspaceAction[] = ["start", "merge", "back", "abort", "commit", "approve", "verify", "pass", "comment", "uncomment", "shelve", "pr"];

/** The board: the tasks (the module writes a Task's workspace, and marks it done when merged). */
export interface BoardPort {
	tasks: Map<number, BoardTask>;
	save(): void;
	record(e: Omit<RoostEvent, "seq" | "at">): void;
	push(): void;
	taskEvent(a: BoardWho, why: string, t: BoardTask, extra?: string): void;
	/** Whether it reached the session (delivered or queued); false when it takes no messages. */
	tellOwner(owner: { id: string; name: string }, from: string, body: string): Promise<boolean>;
	/** The tasks that waited on this one, told they can be taken. */
	tellOpened(t: BoardTask, by: string | null): void;
}

/** The jobs: sessions and commands the daemon runs. */
export interface JobsPort {
	dispatch(launch: DispatchArgs, meta?: { verifyOf?: number; setupOf?: number; task?: { id: number; title: string; path: string; branch: string; baseRef: string } }): Promise<{ id: string; name: string }>;
	stop(id: string): Promise<void>;
	remove(id: string): Promise<unknown>;
	/** Whether the session that holds a claim is live. */
	live(id: string): boolean;
	/** The jobs that ran a Task's Verify or setup (at a restart, those no run reports to are stopped and removed). */
	commandJobs(): { id: string; verifyOf?: number; setupOf?: number; running: boolean }[];
}

export interface Timer {
	clear(): void;
}
export interface Clock {
	now(): number;
	/** A timer that does not keep the process alive. */
	timer(fn: () => void, ms: number): Timer;
}
export const systemClock: Clock = {
	now: () => Date.now(),
	timer: (fn, ms) => {
		const h = setTimeout(fn, ms);
		h.unref?.();
		return { clear: () => clearTimeout(h) };
	},
};

export interface WorkspaceDeps {
	board: BoardPort;
	jobs: JobsPort;
	clock?: Clock;
	log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
	/** Whether the concierge's policy lets it start sessions. */
	conciergeMayAct(): boolean;
	/** A session the concierge starts runs what the concierge runs (M59: the daemon builds it). */
	conciergeLaunch(launch: DispatchArgs): DispatchArgs;
}

export interface Workspaces {
	/** An action on a Task's Workspace (who may has been asked: lib/callers.ts). */
	act(a: BoardWho, t: BoardTask, action: WorkspaceAction, args: Record<string, unknown>): Promise<{ job?: { id: string; name: string }; note?: string; hash?: string }>;
	/** Its Session said the Task is done: its work committed, Verify starts. */
	done(a: BoardWho, t: BoardTask, result: unknown): Promise<void>;
	/** The Task is dropped: `mark` drops it on the board; its command stops, its clean worktree goes. */
	drop(t: BoardTask, mark: () => void): Promise<string | undefined>;
	/** A Verify or setup command ended. */
	commandEnded(jobId: string, of: { verifyOf?: number; setupOf?: number }, code: number | null): void;
	/** At start: what a restart cut short. */
	settle(): void;
	/** Branches merged into Base by hand (looked at most every 10 s). */
	handMerges(): Promise<void>;
	/** What /tasks cleanup removes (dry: what it would). */
	cleanup(dry: boolean): Promise<string[]>;
}

export function createWorkspaces(deps: WorkspaceDeps): Workspaces {
	const { board, jobs } = deps;
	const clock = deps.clock ?? systemClock;
	const log = deps.log ?? (() => {});
	/** M55: a task's workspace moves on: the stage, a note for a person, an event, the counts. */
	function setStage(t: BoardTask, stage: WorkspaceStage, note: string | null, a?: BoardWho, extra?: string): void {
		const w = t.workspace;
		if (!w) return;
		w.stage = stage;
		w.note = note ? note.slice(0, TASK_NOTE_MAX) : null;
		if (stage === "merged") {
			t.state = "done";
			t.doneAt = clock.now();
			t.waiting = [];
		}
		board.save();
		const who = a ?? { who: "roost", whoId: null };
		board.record({ kind: "task", id: who.whoId ?? t.owner?.id ?? "", name: who.who, who: who.who, whoId: who.whoId, why: "stage", text: clipText(`#${t.id} ${t.title}: ${stageLabel(stage)}${note ? ` (${note})` : ""}${extra ? `: ${extra}` : ""}`) });
		board.push();
	}

	/** M58: the comments sent go (by identity: others may have come or gone meanwhile). */
	function dropSent(w: TaskWorkspace, sent: ReviewComment[]): void {
		if (!w.comments) return;
		w.comments = w.comments.filter((c) => !sent.includes(c));
		if (w.comments.length === 0) delete w.comments;
		board.save();
	}

	/** M55: repositories a merge is under way in (one at a time; the lock file guards against another daemon). */
	const mergingRepos = new Set<string>();
	/** M55: tasks an action on the workspace is under way for (start, merge, …): another waits its turn. */
	const workspaceBusy = new Set<number>();
	const BASE_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;
	const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
	/** How many times a merge goes back to the sync when base moved under it. */
	const MERGE_TRIES = 3;

	/** M56: verify and setup jobs under way, by task; the queue of tasks waiting for a slot. */
	const verifyRuns = new Map<number, { jobId: string; round: number; log: string; started: number; timer: Timer; timedOut: boolean; command: string; maxRounds: number }>();
	const setupRuns = new Map<number, { jobId: string; launch: DispatchArgs; actor: BoardWho }>();
	const setupNote = new Map<number, string>();
	const verifyQueue: number[] = [];
	/** Verifies counted in a slot while their job is being dispatched. */
	const verifyReserved = new Set<number>();
	/** At most this many verifies at once in one repository. */
	const VERIFY_SLOTS = 2;

	/** M56: a shell job running one of the repository's commands in the task's worktree. */
	async function runCommandJob(t: BoardTask, kind: "verify" | "setup", command: string, round: number): Promise<{ id: string; name: string; log: string }> {
		const w = t.workspace!;
		const log = verifyLogPath(t.id, kind === "setup" ? 0 : round);
		const config = loadUserConfig();
		const policy = envPolicy(config);
		const env = {
			...workerEnv(process.env, policy),
			ROOST_VERIFY_LOG: log,
			ROOST_TASK_ID: String(t.id),
			ROOST_WORKTREE: w.path,
			ROOST_BRANCH: w.branch,
			ROOST_BASE: w.baseRef,
		};
		const job = await jobs.dispatch(
			{
				kind: "shell",
				cwd: w.path,
				sessionFile: "",
				command: verifyCommand(command),
				env,
				...(policy.workspaceEnv !== "off" ? { workspaceEnv: policy.workspaceEnv } : {}),
				...(config.envDenyList.length ? { envDeny: config.envDenyList, ...(config.envAllowList.length ? { envForce: config.envAllowList } : {}) } : {}),
				name: `${kind} #${t.id}`,
				origin: "dispatch",
			},
			kind === "verify" ? { verifyOf: t.id } : { setupOf: t.id },
		);
		return { ...job, log };
	}

	/**
	 * M56: after the session's done (or /tasks verify): no command, or one not approved, goes
	 * to review with a note; otherwise verifying, now or when a slot frees.
	 */
	async function startVerify(t: BoardTask, a?: BoardWho, extra?: string): Promise<string> {
		const w = t.workspace!;
		const repo = t.project!;
		const { config, error } = await readProjectConfig(repo, w.baseRef);
		if (!config.verify) {
			setStage(t, "review", `not verified: no verify command in .roost/project.json${error ? ` (${error})` : ""}`, a, extra);
			return "no verify command: in review";
		}
		if (!isApproved(repo, config.verify)) {
			setStage(t, "review", `not verified: /tasks approve ${t.id} to run \`${config.verify}\``, a, extra);
			return `not verified: approve \`${config.verify}\` first`;
		}
		// counted and taken in one go (no await between): two verifies cannot both see a free slot
		const running = [...verifyRuns.keys(), ...verifyReserved].filter((id) => board.tasks.get(id)?.project === repo).length;
		if (running >= VERIFY_SLOTS || verifyRuns.has(t.id) || verifyReserved.has(t.id)) {
			if (!verifyQueue.includes(t.id) && !verifyRuns.has(t.id) && !verifyReserved.has(t.id)) verifyQueue.push(t.id);
			setStage(t, "verifying", "queued", a, extra);
			return "verify queued";
		}
		verifyReserved.add(t.id);
		const round = (w.verify?.rounds ?? 0) + 1;
		let job: { id: string; log: string };
		try {
			job = await runCommandJob(t, "verify", config.verify, round);
		} catch (err) {
			setStage(t, "review", `not verified: ${String((err as Error).message ?? err).slice(0, 200)}`, a, extra);
			return "verify did not start";
		} finally {
			verifyReserved.delete(t.id);
		}
		const timer = clock.timer(() => {
			const run = verifyRuns.get(t.id);
			if (!run || run.jobId !== job.id) return;
			run.timedOut = true;
			void jobs.stop(job.id).catch(() => {});
		}, config.verifyTimeout * 1000);
		verifyRuns.set(t.id, { jobId: job.id, round, log: job.log, started: clock.now(), timer, timedOut: false, command: config.verify, maxRounds: config.maxRounds });
		setStage(t, "verifying", `running ${config.verify}`, a, extra);
		return `verifying: ${config.verify}`;
	}

	/** M56: the next queued verifies whose repository has a free slot. */
	function pumpVerifyQueue(): void {
		for (const id of [...verifyQueue]) {
			const t = board.tasks.get(id);
			if (!t?.workspace || t.workspace.stage !== "verifying" || t.state === "dropped") {
				verifyQueue.splice(verifyQueue.indexOf(id), 1);
				continue;
			}
			const running = [...verifyRuns.keys()].filter((x) => board.tasks.get(x)?.project === t.project).length;
			if (running >= VERIFY_SLOTS) continue;
			verifyQueue.splice(verifyQueue.indexOf(id), 1);
			void startVerify(t).catch((err: unknown) => setStage(t, "review", `not verified: ${String((err as Error).message ?? err)}`));
		}
	}

	/** M56: a verify job ended: review, back to the session with the failure, or failed for a person. */
	function verifyEnded(taskId: number, jobId: string, code: number | null): void {
		const run = verifyRuns.get(taskId);
		if (!run || run.jobId !== jobId) return;
		run.timer.clear();
		verifyRuns.delete(taskId);
		const t = board.tasks.get(taskId);
		const w = t?.workspace;
		setTimeout(() => {
			void jobs.remove(jobId).catch(() => {});
			pumpVerifyQueue();
		}, 0).unref?.();
		if (!t || !w || w.stage !== "verifying" || t.state === "dropped") return;
		const secs = Math.round((clock.now() - run.started) / 1000);
		const tail = readLogTail(run.log);
		const ok = code === 0 && !run.timedOut;
		// a pass starts the count again
		const failures = ok ? 0 : (w.verify?.rounds ?? 0) + 1;
		w.verify = { ok, at: clock.now(), log: run.log, tail, rounds: failures };
		if (ok) {
			setStage(t, "review", `verified: ${run.command} (${secs}s)`);
			return;
		}
		const why = run.timedOut ? `timed out after ${secs}s` : `exit ${code ?? "?"}`;
		const last = tail.trim().split("\n").pop() ?? "";
		if (failures < run.maxRounds && t.state === "claimed" && t.owner && jobs.live(t.owner.id)) {
			setStage(t, "working", `verify failed (${why}), round ${failures} of ${run.maxRounds}`);
			board.tellOwner(t.owner, "roost", `Task #${t.id} (${t.title}): \`${run.command}\` failed (${why}). The end of its output:\n\n${tail}\n\nFix it in ${w.path}, commit, then roost_task_done again.`);
		} else setStage(t, "failed", `verify failed (${why})${last ? `: ${last.slice(0, 200)}` : ""}`);
	}

	/** M56: a setup job ended: the session starts, or the task stops for a person. */
	async function setupEnded(taskId: number, jobId: string, code: number | null): Promise<void> {
		const run = setupRuns.get(taskId);
		if (!run || run.jobId !== jobId) return;
		setTimeout(() => void jobs.remove(jobId).catch(() => {}), 0).unref?.();
		const t = board.tasks.get(taskId);
		const w = t?.workspace;
		// M59: the run holds its place until its session is dispatched (a shelve or start meanwhile is refused)
		const done = () => {
			if (setupRuns.get(taskId)?.jobId === jobId) setupRuns.delete(taskId);
		};
		if (!t || !w || t.state === "dropped") return done();
		if (code !== 0) {
			done();
			const last = readLogTail(verifyLogPath(t.id, 0)).trim().split("\n").pop() ?? "";
			setStage(t, "failed", `setup failed (exit ${code ?? "?"})${last ? `: ${last.slice(0, 200)}` : ""}`);
			return;
		}
		try {
			const job = await jobs.dispatch(run.launch, { task: { id: t.id, title: t.title, path: w.path, branch: w.branch, baseRef: w.baseRef } });
			t.state = "claimed";
			t.owner = { id: job.id, name: job.name };
			t.claimedAt = clock.now();
			setStage(t, "working", null, run.actor, `${job.name} in ${w.branch}`);
		} catch (err) {
			setStage(t, "failed", `the session did not start: ${String((err as Error).message ?? err).slice(0, 200)}`);
		} finally {
			done();
		}
	}

	/** M56: at start, what a restart cut short: verifies and setups ran in jobs that are gone. */
	function settleCommandJobs(): void {
		// verify and setup jobs from before the restart have no run to report to: stopped and removed
		for (const r of jobs.commandJobs()) {
			if (verifyRuns.get(r.verifyOf ?? -1)?.jobId === r.id || setupRuns.get(r.setupOf ?? -1)?.jobId === r.id) continue;
			void (async () => {
				if (r.running) await jobs.stop(r.id).catch(() => {});
				await jobs.remove(r.id).catch(() => {});
			})();
		}
	}

	function settleVerifies(): void {
		for (const t of board.tasks.values()) {
			const w = t.workspace;
			if (!w || t.state === "dropped") continue;
			if (w.stage === "verifying") setStage(t, "review", "not verified (interrupted)");
			else if (w.stage === "working" && w.note?.startsWith("setting up")) setStage(t, "failed", "setup interrupted: /tasks start again");
		}
	}

	/** M55: start, merge, back, abort, commit: the actions on a task's workspace. */
	async function workspaceOp(
		a: BoardWho,
		t: BoardTask,
		action: WorkspaceAction,
		args: { workspace?: unknown; launch?: unknown; mode?: unknown; note?: unknown; message?: unknown; dry?: unknown; hash?: unknown; comment?: unknown },
	): Promise<{ job?: { id: string; name: string }; note?: string; hash?: string }> {
		// one action on a task's workspace at a time (two starts, a drop during a merge)
		if (workspaceBusy.has(t.id)) throw new OpError("conflict", `#${t.id}: another action on its workspace is under way`);
		workspaceBusy.add(t.id);
		try {
			return await workspaceAction(a, t, action, args);
		} finally {
			workspaceBusy.delete(t.id);
		}
	}

	async function workspaceAction(
		a: BoardWho,
		t: BoardTask,
		action: WorkspaceAction,
		args: { workspace?: unknown; launch?: unknown; mode?: unknown; note?: unknown; message?: unknown; dry?: unknown; hash?: unknown; comment?: unknown },
	): Promise<{ job?: { id: string; name: string }; note?: string; hash?: string }> {
		// M56: trust is a person's: the repository's commands, shown, then approved
		if (action === "approve") {
			if (!t.project) throw new OpError("bad_request", `#${t.id} is for any session: no repository`);
			const baseRef = t.workspace?.baseRef || (await currentBranch(t.project));
			if (!baseRef) throw new OpError("bad_request", `${projectLabel(t.project)}: no branch checked out to read .roost/project.json from`);
			const { config, error } = await readProjectConfig(t.project, baseRef);
			const cmds = [config.verify, config.setup].filter((c): c is string => !!c);
			if (cmds.length === 0) return { note: `no commands in ${projectLabel(t.project)}'s .roost/project.json on ${baseRef}${error ? ` (${error})` : ""}` };
			const list = [config.verify ? `verify: ${config.verify}` : "", config.setup ? `setup: ${config.setup}` : ""].filter(Boolean).join(" · ");
			// what is approved is what was shown: the commands' hash travels with the confirmation
			const shown = commandHash(cmds.join("\n"));
			if (args.dry === true) return { note: list, hash: shown };
			if (args.hash !== shown) throw new OpError("conflict", `the commands changed since they were shown (now ${list}): /tasks approve ${t.id} again to see them`);
			approve(t.project, cmds);
			board.record({ kind: "task", id: "", name: a.who, who: a.who, whoId: null, why: "approve", text: clipText(`#${t.id} ${projectLabel(t.project)}: ${list}`) });
			return { note: `approved for ${projectLabel(t.project)}: ${list}` };
		}
		if (t.state === "dropped" || t.state === "done") throw new OpError("bad_request", `#${t.id} is ${t.workspace?.stage === "merged" ? "merged" : t.state}`);
		if (action === "start") {
			// M57: the Concierge, when its policy lets it start sessions (the table: a Person or the Concierge)
			if (a.concierge && !deps.conciergeMayAct()) throw new OpError("policy", "the concierge may not start sessions (act: off): ask the user to /tasks start it");
			if (!t.project) throw new OpError("bad_request", `#${t.id} is for any session: a workspace is a repository's (add it in a repository)`);
			if (t.state === "claimed" && t.owner && jobs.live(t.owner.id)) throw new OpError("conflict", `#${t.id} is claimed by ${t.owner.name}`);
			// M56: its setup runs: the session follows by itself
			if (setupRuns.has(t.id)) throw new OpError("conflict", `#${t.id} is being set up: its session starts after`);
			const waits = blockedOn(t, board.tasks.values());
			if (waits.length > 0) throw new OpError("blocked", `#${t.id} waits on ${waits.map((i) => `#${i}`).join(", ")}`);
			const w = args.workspace as { path?: unknown; branch?: unknown; baseRef?: unknown; baseSha?: unknown } | undefined;
			if (!w || !str(w.path) || !str(w.branch) || !str(w.baseRef) || !str(w.baseSha)) throw new OpError("bad_request", "workspace: {path, branch, baseRef, baseSha}");
			if (!w.branch.startsWith(`roost/t${t.id}-`)) throw new OpError("bad_request", `workspace: the branch of #${t.id} is roost/t${t.id}-…`);
			if (!BASE_REF.test(w.baseRef) || !SHA_RE.test(w.baseSha)) throw new OpError("bad_request", "workspace: baseRef a branch name, baseSha a commit id");
			if (t.workspace && (t.workspace.path !== w.path || t.workspace.branch !== w.branch)) throw new OpError("bad_request", `#${t.id} has its workspace already: ${t.workspace.branch}`);
			if (t.workspace && !["working", "review", "failed", "conflict", "shelved"].includes(t.workspace.stage)) throw new OpError("bad_request", `#${t.id} is ${stageLabel(t.workspace.stage)}: it cannot be started now`);
			// checked again when it is started again: the worktree may be gone or moved off its branch
			if (!(await validWorktree({ path: w.path, branch: w.branch, repo: t.project, base: t.workspace?.baseSha || w.baseSha }))) throw new OpError("bad_request", "workspace is not a worktree pi-roost made for this repository (or it is gone)");
			// M57: base is what the caller says only if it is: the commit on that branch, the worktree's history from it
			if (!t.workspace && (!(await isAncestor(t.project, w.baseSha, `refs/heads/${w.baseRef}`)) || !(await isAncestor(w.path, w.baseSha, "HEAD"))))
				throw new OpError("bad_request", `workspace: ${w.baseSha.slice(0, 8)} is not on ${w.baseRef} and under the worktree's branch`);
			let launch = args.launch as DispatchArgs | undefined;
			if (!launch || typeof launch !== "object") throw new OpError("bad_request", "launch: the session to start");
			if (launch.kind === "shell" || launch.worktree !== undefined) throw new OpError("bad_request", "launch: a pi session, without a worktree of its own");
			if (!str(launch.cwd) || !isInside(realPath(launch.cwd), realPath(w.path))) throw new OpError("bad_request", "launch: cwd must be inside the task's worktree");
			// M57/M59: a session the concierge starts runs what the concierge runs (the daemon builds it)
			if (a.concierge) launch = deps.conciergeLaunch(launch);
			// M56: a new worktree gets the repository's setup first (approved), then the session
			if (!t.workspace) {
				const { config } = await readProjectConfig(t.project, w.baseRef);
				if (config.setup && isApproved(t.project, config.setup)) {
					t.state = "open";
					t.owner = null;
					t.assigned = null;
					t.waiting = [];
					t.workspace = { path: w.path, branch: w.branch, baseRef: w.baseRef, baseSha: w.baseSha, stage: "working", note: `setting up: ${config.setup}` };
					let job: { id: string };
					try {
						job = await runCommandJob(t, "setup", config.setup, 0);
					} catch (err) {
						setStage(t, "failed", `setup did not start: ${String((err as Error).message ?? err).slice(0, 200)}`, a);
						throw err;
					}
					setupRuns.set(t.id, { jobId: job.id, launch, actor: a });
					setStage(t, "working", `setting up: ${config.setup}`, a);
					return { note: `setting up (${config.setup}); the session starts when it is done` };
				}
				if (config.setup) setupNote.set(t.id, "setup not run: not approved (/tasks approve)");
			}
			const job = await jobs.dispatch(launch, { task: { id: t.id, title: t.title, path: w.path, branch: w.branch, baseRef: w.baseRef } });
			t.state = "claimed";
			t.owner = { id: job.id, name: job.name };
			t.claimedAt = clock.now();
			t.assigned = null;
			t.waiting = [];
			const again = !!t.workspace;
			// M58: the prompt carried the review's comments (as many as reviewText took: the same list, the same cut)
			if (t.workspace?.comments) dropSent(t.workspace, t.workspace.comments.slice(0, reviewText(t.workspace.comments).count));
			t.workspace ??= { path: w.path, branch: w.branch, baseRef: w.baseRef, baseSha: w.baseSha, stage: "working", note: null };
			const pending = setupNote.get(t.id) ?? null;
			setupNote.delete(t.id);
			setStage(t, "working", again ? "started again" : pending, a, `${job.name} in ${w.branch}`);
			if (a.concierge) board.record({ kind: "concierge", id: job.id, name: job.name, who: CONCIERGE_NAME, whoId: a.whoId, why: "act", text: `started #${t.id} (${clipText(t.title)}) in ${w.branch}` });
			return { job };
		}
		const w = t.workspace;
		if (!w) throw new OpError("bad_request", `#${t.id} has no workspace: /tasks start it first`);
		if (!t.project) throw new OpError("bad_request", `#${t.id} has no repository`);
		// M59: on the shelf its worktree is gone: start takes it off (the hub makes the worktree again)
		if (w.stage === "shelved" && action !== "comment" && action !== "uncomment") throw new OpError("bad_request", `#${t.id} is shelved: /tasks start it to take it off the shelf`);
		// a damaged record (no path, no branch) never reaches git: `git -C ""` is the daemon's own directory
		if (action !== "back" && action !== "comment" && action !== "uncomment" && !(action === "shelve" && w.path && isAbsolute(w.path)) && (!w.path || !isAbsolute(w.path) || !w.branch || !BASE_REF.test(w.baseRef) || !existsSync(w.path))) {
			throw new OpError("bad_request", `#${t.id}: its worktree ${w.path || "(none recorded)"} is not there: look at it by hand`);
		}
		// M60: the optional exit: push the branch and open a pull request; shown first, then confirmed for the tip shown
		if (action === "pr") {
			if (w.stage !== "review") throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}: a pull request is opened from review`);
			if ((await worktreeClean(w.path)) !== true) throw new OpError("bad_request", `#${t.id}: its worktree has uncommitted changes (/tasks commit ${t.id} first)`);
			const tip = await revParse(t.project, `refs/heads/${w.branch}`);
			if (!tip) throw new OpError("bad_request", `#${t.id}: its branch ${w.branch} is gone`);
			// where it goes is shown with what goes: the remote's push URL (an agent could have changed it), the repository gh uses
			const to = await prTarget(w.path);
			if (!to.ok) throw new OpError("bad_request", `#${t.id}: ${to.reason}`);
			const what = `push ${w.branch} at ${tip.slice(0, 8)} to ${to.remote} (${to.url}) and open a pull request into ${w.baseRef}${to.repo ? ` on ${to.repo}` : " (gh picks the repository)"}`;
			// the confirmation names the commit and the place shown
			const hash = commandHash(`${tip}\n${to.remote}\n${to.url}\n${to.repo ?? ""}`);
			if (args.dry === true) return { note: what, hash };
			if (args.hash !== hash) throw new OpError("conflict", `the branch or its remote changed since it was shown: /tasks pr ${t.id} again to see it`);
			const body = [t.detail ?? "", t.result ? `Done: ${t.result}` : "", w.verify?.ok ? "Verified by the repository's verify command." : "", `Task #${t.id}, opened by pi-roost.`].filter(Boolean).join("\n\n");
			const r = await openTaskPr({ path: w.path, branch: w.branch, baseRef: w.baseRef, tip, remote: to.remote, ...(to.repo ? { repo: to.repo } : {}), title: t.title, body });
			if (!r.ok) throw new OpError("failed", r.reason);
			w.pr = { url: r.url, tip, at: clock.now() };
			// the push took a while: the note is the stage's own if something else moved it meanwhile
			if ((w.stage as string) === "review" && (t.state as string) !== "dropped") w.note = `pull request: ${r.url}`;
			board.save();
			board.taskEvent(a, "pr", t, r.url);
			board.push();
			return { note: `pushed to ${to.remote} · ${r.url}` };
		}
		// M59: put away: the worktree removed (clean only), the branch and the record kept; /tasks start brings it back
		if (action === "shelve") {
			if (!["review", "failed", "working"].includes(w.stage)) throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}: shelve one in review, failed, or working without a session`);
			if (t.state === "claimed" && t.owner && jobs.live(t.owner.id)) throw new OpError("conflict", `#${t.id}: ${t.owner.name} works in it: stop it first`);
			if (verifyRuns.has(t.id) || setupRuns.has(t.id) || verifyQueue.includes(t.id)) throw new OpError("conflict", `#${t.id}: a command runs in its worktree`);
			const r = await removeTaskWorktree(t.project, w.path);
			if (!r.ok) throw new OpError("bad_request", `#${t.id}: its worktree stays: ${r.reason} (/tasks commit ${t.id} first)`);
			t.state = "open";
			t.owner = null;
			t.claimedAt = null;
			setStage(t, "shelved", `on the shelf: branch ${w.branch} kept`, a);
			return { note: `shelved · worktree removed · branch ${w.branch} kept · /tasks start ${t.id} brings it back` };
		}
		// M58: a person's comments on lines of the task's diff, sent with `back`
		if (action === "comment" || action === "uncomment") {
			if (w.stage === "merged") throw new OpError("bad_request", `#${t.id} is merged`);
			const list = (w.comments ??= []);
			if (action === "uncomment") {
				// which one: its file, line and time (an index from a list seen earlier could name another)
				const k = (args.comment ?? {}) as Record<string, unknown>;
				const i = list.findIndex((c) => c.file === k.file && c.line === k.line && c.at === k.at);
				if (i < 0) throw new OpError("not_found", `#${t.id} has no such comment (it was sent or removed)`);
				list.splice(i, 1);
			} else {
				const c = (args.comment ?? {}) as Record<string, unknown>;
				const file = typeof c.file === "string" ? c.file.slice(0, 4096) : "";
				const text = taskText(c.text, TASK_TEXT_MAX);
				if (!file || !Number.isInteger(c.line) || (c.line as number) < 1 || !text) throw new OpError("bad_request", "comment: {file, line (from 1), text, lineText?, tip?}");
				if (list.length >= REVIEW_COMMENTS_MAX) throw new OpError("bad_request", `#${t.id} has ${REVIEW_COMMENTS_MAX} comments: send them back first`);
				// its time names it (uncomment): never the same as the last one's
				const at = Math.max(clock.now(), (list.at(-1)?.at ?? 0) + 1);
				list.push({ file, line: c.line as number, text, lineText: typeof c.lineText === "string" ? c.lineText.slice(0, 1000) : "", tip: typeof c.tip === "string" && SHA_RE.test(c.tip) ? c.tip : "", at });
			}
			if (list.length === 0) delete w.comments;
			board.save();
			board.push();
			return { note: `${list.length} comment${list.length === 1 ? "" : "s"}` };
		}
		if (action === "back") {
			const text = taskText(args.note, TASK_TEXT_MAX);
			if (!["review", "failed", "conflict"].includes(w.stage)) throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}: nothing to send back`);
			// M58: the review's comments go with it (a session started later gets them in its prompt)
			const comments = w.comments ?? [];
			const counted = comments.length > 0 ? ` (${comments.length} comment${comments.length === 1 ? "" : "s"})` : "";
			setStage(t, "working", text ? `sent back${counted}: ${text}` : `sent back${counted}`, a);
			if (t.state === "claimed" && t.owner && jobs.live(t.owner.id)) {
				const rt = reviewText(comments);
				const review = comments.length > 0 ? `\nReview comments (line numbers are of the version reviewed):\n${rt.text}` : "";
				const owner = t.owner;
				// the comments go once they reached it; those the message had no room for stay for the next send-back
				if (await board.tellOwner(owner, a.who, `Task #${t.id} (${t.title}) came back from review${text ? `: ${text}` : ""}.${review}\nWork on it in ${w.path} (branch ${w.branch}), commit, then roost_task_done again.`)) {
					dropSent(w, comments.slice(0, rt.count));
					return { note: `sent back to ${owner.name}${counted}${rt.count < comments.length ? ` (${comments.length - rt.count} did not fit: send back again)` : ""}` };
				}
				return { note: `${owner.name} takes no messages: the comments stay (/tasks start it again, or tell it)` };
			}
			return { note: "no session holds it: /tasks start it to start one (it gets the comments)" };
		}
		if (action === "verify") {
			if (w.stage !== "review" && w.stage !== "failed") throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}: verify runs from review or failed`);
			if (w.verify) w.verify.rounds = 0;
			return { note: await startVerify(t, a) };
		}
		if (action === "pass") {
			if (w.stage !== "failed") throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}, not failed`);
			setStage(t, "review", "passed by hand", a);
			return {};
		}
		if (action === "abort") {
			if (w.stage !== "conflict") throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}, not in a conflict`);
			if (!(await abortSync(w.path))) throw new OpError("bad_request", `no merge to abort in ${w.path}`);
			setStage(t, "review", "sync aborted", a);
			return {};
		}
		if (action === "commit") {
			const r = await commitAll(w.path, taskText(args.message, 500) || `work on #${t.id}: ${t.title}`);
			if (!r.ok) throw new OpError("bad_request", r.error);
			board.taskEvent(a, "commit", t, r.sha.slice(0, 8));
			return { note: `committed ${r.sha.slice(0, 8)} on ${w.branch}` };
		}
		// merge
		if (!["review", "conflict", "failed"].includes(w.stage)) throw new OpError("bad_request", `#${t.id} is ${stageLabel(w.stage)}: it merges from review`);
		const repo = t.project;
		if (mergingRepos.has(repo)) throw new OpError("conflict", `a merge in ${projectLabel(repo)} is under way`);
		const mode = args.mode === "no-ff" ? "no-ff" : "ff";
		mergingRepos.add(repo);
		try {
			const out = await withMergeLock(repo, () => mergeTask(a, t, w, repo, mode));
			if (typeof out === "object" && out && "locked" in out) throw new OpError("conflict", `another merge holds ${projectLabel(repo)}'s lock`);
			return { note: out as string };
		} catch (err) {
			// never left at merging: settled as at a restart (the tip in base: merged; else review)
			if (w.stage === "merging") {
				const base = await revParse(repo, `refs/heads/${w.baseRef}`);
				if (w.merge && base && (await isAncestor(repo, w.merge.tip, base))) await finishMerge(a, t, w, repo, w.merge.tip, base);
				else setStage(t, "review", `merge failed: ${String((err as Error).message ?? err).slice(0, 200)}`, a);
			}
			throw err;
		} finally {
			mergingRepos.delete(repo);
		}
	}

	/** M55: sync the task's branch with base, then into base; the stage says how it went. */
	async function mergeTask(a: BoardWho, t: BoardTask, w: TaskWorkspace, repo: string, mode: "ff" | "no-ff"): Promise<string> {
		if (mode === "no-ff" && !(await hasIdentity(repo))) throw new OpError("bad_request", "git user.name and user.email are not set: a merge commit needs them");
		for (let i = 0; i < MERGE_TRIES; i++) {
			const sync = await syncWithBase(w.path, w.baseRef);
			if (sync.kind === "conflict") {
				setStage(t, "conflict", `conflict in ${sync.files.slice(0, 5).join(", ")}${sync.files.length > 5 ? ` and ${sync.files.length - 5} more` : ""}`, a);
				return `conflict: resolve it in ${w.path} (or /tasks back ${t.id}, /tasks abort ${t.id}), then /tasks merge ${t.id}`;
			}
			if (sync.kind === "error") {
				setStage(t, "review", sync.message, a);
				return sync.message;
			}
			if ((await worktreeClean(w.path)) !== true) {
				setStage(t, "review", "uncommitted changes in its worktree", a);
				return `uncommitted changes in ${w.path}: /tasks commit ${t.id} or /tasks back ${t.id}`;
			}
			// what merges is the branch: the worktree must be on it (a detached HEAD's commits would not be)
			const on = await currentBranch(w.path);
			if (on !== w.branch) {
				setStage(t, "review", `its worktree is on ${on ?? "a detached HEAD"}, not ${w.branch}`, a);
				return `check out ${w.branch} in ${w.path} again, then /tasks merge ${t.id}`;
			}
			const tip = await revParse(repo, `refs/heads/${w.branch}`);
			const oldBase = await revParse(repo, `refs/heads/${w.baseRef}`);
			if (!tip || !oldBase) {
				setStage(t, "review", `cannot read ${tip ? w.baseRef : w.branch}`, a);
				return `cannot read ${tip ? w.baseRef : w.branch}`;
			}
			// the intent first: a crash from here on is settled from it
			w.merge = { tip, oldBase, at: clock.now() };
			setStage(t, "merging", null, a);
			const r = await mergeIntoBase({ repo, branch: w.branch, baseRef: w.baseRef, tip, oldBase, mode });
			if (r.kind === "moved") continue;
			if (r.kind === "refused") {
				setStage(t, "review", r.reason, a);
				return r.reason;
			}
			if (r.kind === "failed") {
				const into = await revParse(repo, `refs/heads/${w.baseRef}`);
				if (!(into && (await isAncestor(repo, tip, into)))) {
					setStage(t, "review", r.message.split("\n")[0]!.slice(0, 300), a);
					return r.message;
				}
				return finishMerge(a, t, w, repo, tip, into);
			}
			return finishMerge(a, t, w, repo, tip, r.into);
		}
		setStage(t, "review", `${w.baseRef} keeps moving: try again`, a);
		return `${w.baseRef} kept moving during the merge: /tasks merge ${t.id} again`;
	}

	/** M55: merged: the record, the dependents, then the worktree and branch go (what holds no work). */
	async function finishMerge(a: BoardWho, t: BoardTask, w: TaskWorkspace, repo: string, tip: string, into: string): Promise<string> {
		w.merge = { ...(w.merge ?? { tip, oldBase: "", at: clock.now() }), tip, into };
		const holder = t.owner;
		setStage(t, "merged", null, a, `into ${w.baseRef} at ${into.slice(0, 8)}`);
		board.tellOpened(t, null);
		// a session still working in the worktree keeps it (its directory would vanish under it): told to stop
		if (holder && jobs.live(holder.id)) {
			board.tellOwner(holder, "roost", `Task #${t.id} (${t.title}) was merged into ${w.baseRef}: your work is done; stop here.`);
			return `merged into ${w.baseRef} (${into.slice(0, 8)}) · worktree kept while ${holder.name} runs`;
		}
		const c = await cleanupMergedTask({ repo, path: w.path, branch: w.branch, tip, baseRef: w.baseRef });
		const left = [c.worktreeRemoved ? "" : `worktree kept: ${w.path}`, c.branchDeleted ? "" : `branch ${w.branch} kept`].filter(Boolean).join(" · ");
		return `merged into ${w.baseRef} (${into.slice(0, 8)})${left ? ` · ${left}${c.reason ? ` (${c.reason})` : ""}` : " · worktree and branch removed"}`;
	}

	/** M59: tasks whose branch reached base without pi-roost (merged by hand): merged, dependents told. */
	let handMergesAt = 0;
	async function settleHandMerges(): Promise<void> {
		if (clock.now() - handMergesAt < Number(process.env.PI_ROOST_HAND_MERGE_MS ?? 10_000)) return;
		handMergesAt = clock.now();
		for (const t of board.tasks.values()) {
			const w = t.workspace;
			if (!w || !t.project || t.state === "dropped" || !["review", "failed", "conflict", "shelved"].includes(w.stage) || workspaceBusy.has(t.id)) continue;
			try {
				// the reviewed tip, still the branch's, with commits of its own, in base: a person merged what was reviewed
				// (a branch reset onto base, or moved after review, is not)
				const tip = await revParse(t.project, `refs/heads/${w.branch}`);
				const base = await revParse(t.project, `refs/heads/${w.baseRef}`);
				if (!tip || !base || !w.reviewTip || tip !== w.reviewTip || tip === w.baseSha) continue;
				if (!(await isAncestor(t.project, w.baseSha, tip)) || !(await isAncestor(t.project, tip, base))) continue;
				if (existsSync(w.path) && (await worktreeClean(w.path)) !== true) continue;
				workspaceBusy.add(t.id);
				try {
					w.merge = { tip, oldBase: w.baseSha, at: clock.now() };
					await finishMerge({ who: "roost", whoId: null, sessionId: null, concierge: false, project: null }, t, w, t.project, tip, base);
					if (w.note === null) w.note = "merged by hand";
					board.save();
				} finally {
					workspaceBusy.delete(t.id);
				}
			} catch (err) {
				log("warn", "could not check a branch against base", { task: t.id, error: String(err) });
			}
		}
	}

	/** M59: what `/tasks cleanup` removes (dry: says what it would). Never a worktree with changes; never an unmerged branch. */
	async function cleanupLeftovers(dry: boolean): Promise<string[]> {
		const out: string[] = [];
		const busy = (t: BoardTask) => workspaceBusy.has(t.id) || verifyRuns.has(t.id) || setupRuns.has(t.id) || (t.state === "claimed" && !!t.owner && jobs.live(t.owner.id));
		const repos = new Set<string>();
		for (const t of board.tasks.values()) {
			if (t.project) repos.add(t.project);
			const w = t.workspace;
			if (!w || !t.project || !w.path || busy(t)) continue;
			const merged = w.stage === "merged";
			if (!(t.state === "dropped" || merged) || !existsSync(w.path)) continue;
			const clean = await worktreeClean(w.path);
			if (clean !== true) {
				out.push(`#${t.id} kept: ${w.path} has uncommitted changes`);
				continue;
			}
			if (dry) {
				out.push(`#${t.id} ${merged ? "merged" : "dropped"}: remove ${w.path}${merged ? ` and branch ${w.branch} (in ${w.baseRef})` : ` (branch ${w.branch} kept)`}`);
				continue;
			}
			if (merged && w.merge) {
				const c = await cleanupMergedTask({ repo: t.project, path: w.path, branch: w.branch, tip: w.merge.tip, baseRef: w.baseRef });
				out.push(`#${t.id}: ${c.worktreeRemoved ? "worktree removed" : "worktree kept"}${c.branchDeleted ? " · branch deleted" : ` · branch ${w.branch} kept`}${c.reason ? ` (${c.reason})` : ""}`);
			} else {
				const r = await removeTaskWorktree(t.project, w.path);
				out.push(`#${t.id}: ${r.ok ? `worktree removed · branch ${w.branch} kept` : `worktree kept (${r.reason})`}`);
			}
		}
		// worktrees of task branches whose task is gone (swept) or never got its workspace recorded
		for (const repo of repos) {
			for (const x of await taskWorktrees(repo)) {
				const t = board.tasks.get(x.id);
				if (t?.workspace && t.workspace.branch === x.branch) continue;
				// only pi-roost's (under .pi/worktrees), not one being started (made by a client moments ago, or under way)
				if (workspaceBusy.has(x.id) || !isInside(realPath(x.path), realPath(join(repo, WORKTREES_DIR)))) continue;
				try {
					if (clock.now() - statSync(x.path).mtimeMs < 10 * 60_000) continue;
				} catch {
					continue;
				}
				const clean = await worktreeClean(x.path);
				if (clean !== true) {
					out.push(`${x.branch} kept: ${x.path} has uncommitted changes (no task holds it)`);
					continue;
				}
				if (dry) out.push(`${x.branch}: remove ${x.path} (no task holds it; branch kept)`);
				else {
					const r = await removeTaskWorktree(repo, x.path);
					out.push(`${x.branch}: ${r.ok ? "worktree removed · branch kept" : `worktree kept (${r.reason})`}`);
				}
			}
		}
		// verify logs of tasks that are done, dropped or gone
		const dir = join(roostHome(), "verify");
		let logs: string[] = [];
		try {
			logs = readdirSync(dir).filter((f) => /^\d+-\d+\.log$/.test(f));
		} catch {}
		const old = logs.filter((f) => {
			const t = board.tasks.get(Number(f.split("-")[0]));
			return !t || t.state === "done" || t.state === "dropped";
		});
		if (old.length > 0) {
			if (!dry) for (const f of old) rmSync(join(dir, f), { force: true });
			out.push(`${dry ? "remove" : "removed"} ${old.length} verify log${old.length === 1 ? "" : "s"} of tasks done, dropped or gone`);
		}
		if (out.length === 0) out.push("nothing left behind");
		return out;
	}

	/** M55: at start, a merge a crash cut short is settled from its recorded intent. */
	async function settleMerges(): Promise<void> {
		for (const t of board.tasks.values()) {
			const w = t.workspace;
			if (!w || w.stage !== "merging" || !t.project) continue;
			try {
				const base = await revParse(t.project, `refs/heads/${w.baseRef}`);
				if (w.merge && base && (await isAncestor(t.project, w.merge.tip, base))) {
					await finishMerge({ who: "roost", whoId: null, sessionId: null, concierge: false, project: null }, t, w, t.project, w.merge.tip, base);
				} else setStage(t, "review", "merge interrupted: /tasks merge again");
			} catch (err) {
				log("error", "a merge could not be settled", { task: t.id, error: String(err) });
			}
		}
	}

	/** M55: its session's done sends it to review, once its work is committed (M56: Verify first). */
	async function done(a: BoardWho, t: BoardTask, result: unknown): Promise<void> {
		const w = t.workspace!;
		const mine = a.sessionId !== null && t.owner?.id === a.sessionId;
		if (!mine) throw new OpError("bad_request", `#${t.id} has its own workspace (${w.branch}): it is done when it is merged`);
		if (w.stage !== "working") throw new OpError("bad_request", `#${t.id} is ${w.stage}, not working`);
		const clean = await worktreeClean(w.path);
		if (clean === undefined) throw new OpError("bad_request", `cannot read the worktree ${w.path}`);
		if (!clean) throw new OpError("bad_request", `#${t.id}: commit your work first (git add -A && git commit), then roost_task_done again`);
		// one done at a time (a second while the first reads the config would start a second verify)
		if (workspaceBusy.has(t.id)) throw new OpError("conflict", `#${t.id}: its done is being handled`);
		workspaceBusy.add(t.id);
		try {
			t.result = taskText(result, TASK_TEXT_MAX) || null;
			// M59: the tip that went to review: only it, found in base, is "merged by hand"
			const tip = await revParse(w.path, "HEAD");
			if (tip) w.reviewTip = tip;
			await startVerify(t, a, t.result ?? undefined);
		} finally {
			workspaceBusy.delete(t.id);
		}
	}

	/** M55/M56: not while its workspace is started or merged; a command in it stops; a clean worktree goes. */
	async function drop(t: BoardTask, mark: () => void): Promise<string | undefined> {
		if (workspaceBusy.has(t.id) || t.workspace?.stage === "merging") throw new OpError("conflict", `#${t.id}: its workspace is being ${t.workspace?.stage === "merging" ? "merged" : "worked on"}: try again after`);
		mark();
		let note: string | undefined;
		const v = verifyRuns.get(t.id);
		const cmdJob = v?.jobId ?? setupRuns.get(t.id)?.jobId;
		if (cmdJob) {
			if (v) v.timer.clear();
			verifyRuns.delete(t.id);
			setupRuns.delete(t.id);
			void jobs.stop(cmdJob).catch(() => {});
			note = `its ${v ? "verify" : "setup"} was stopped · worktree kept: ${t.workspace?.path}`;
		}
		const qi = verifyQueue.indexOf(t.id);
		if (qi >= 0) verifyQueue.splice(qi, 1);
		if (!cmdJob && t.workspace && t.project && t.workspace.path) {
			const w = t.workspace;
			const clean = await worktreeClean(w.path);
			if (clean) {
				const r = await cleanupMergedTask({ repo: t.project, path: w.path, branch: w.branch, tip: "", baseRef: w.baseRef });
				note = r.worktreeRemoved ? `worktree removed · branch ${w.branch} kept` : `worktree kept: ${w.path}${r.reason ? ` (${r.reason})` : ""}`;
			} else if (clean === false) note = `worktree kept: ${w.path} has uncommitted changes`;
		}
		return note;
	}

	return {
		act: (a, t, action, args) => workspaceOp(a, t, action, args),
		done,
		drop,
		commandEnded(jobId, of, code) {
			if (of.verifyOf !== undefined) verifyEnded(of.verifyOf, jobId, code);
			if (of.setupOf !== undefined) void setupEnded(of.setupOf, jobId, code);
		},
		settle() {
			// merges a crash cut short, and command jobs no run reports to (after the daemon's roster: nothing waits on them)
			setTimeout(() => {
				void settleMerges();
				settleCommandJobs();
			}, 0).unref?.();
			// verifies and setups a restart cut short
			settleVerifies();
		},
		handMerges: settleHandMerges,
		cleanup: cleanupLeftovers,
	};
}
