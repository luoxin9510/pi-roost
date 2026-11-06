// M57/M59: a task started in its own worktree from a pi process (the concierge's
// hub_task_start, the /tasks command in a pi session): the worktree made here (or made
// again from its branch when shelved), the pi launch built here, the start sent to the
// daemon; a refused start leaves no new worktree behind.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { type BoardTask, taskPrompt } from "../../lib/board.ts";
import { CONCIERGE_ROLE_ENV } from "../../lib/concierge.ts";
import { envPolicy, loadConfig } from "../../lib/config.ts";
import { buildLaunch, fallbackName, refusedByDaemon } from "../../lib/dispatch.ts";
import type { DispatchArgs } from "../../lib/protocol.ts";
import { createTaskWorktree, removeTaskWorktree, restoreTaskWorktree, type TaskWorktree } from "../../lib/task-git.ts";
import { discardWorktree } from "../../lib/worktree.ts";

/** M45: a launch for a pi session like the hub's, in a directory (the caller's unless told). */
export function dispatchLaunch(ctx: Pick<ExtensionContext, "cwd">, params: { task: string; name?: string; cwd?: string; model?: string }): DispatchArgs {
	const task = params.task.trim();
	if (!task) throw new Error("task is empty");
	const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`not a directory: ${cwd}`);
	const sessionFile = SessionManager.create(cwd).getSessionFile();
	if (!sessionFile) throw new Error("could not allocate a session file");
	const config = loadConfig(cwd);
	// not a concierge itself
	const env = { ...process.env };
	delete env[CONCIERGE_ROLE_ENV];
	return buildLaunch({
		task,
		cwd,
		sessionFile,
		name: params.name?.trim() || fallbackName(task),
		origin: "dispatch",
		argv: process.argv,
		execPath: process.execPath,
		env,
		...envPolicy(config),
		piVersion: VERSION,
		model: params.model?.trim() || undefined,
	});
}

type TaskCall = (args: Record<string, unknown>) => Promise<{ tasks: BoardTask[]; job?: { id: string; name: string }; note?: string }>;

/** Starts task `id` in its worktree; says what happened. */
export async function startTaskInPi(call: TaskCall, ctx: Pick<ExtensionContext, "cwd">, id: number, model?: string): Promise<string> {
	const { tasks } = await call({ action: "list" });
	const t = tasks.find((x) => x.id === id);
	if (!t) throw new Error(`no task #${id}`);
	if (!t.project) throw new Error(`#${t.id} is for any session: a workspace is a repository's`);
	let made: TaskWorktree | undefined;
	const w = t.workspace?.path
		? { path: t.workspace.path, branch: t.workspace.branch, baseRef: t.workspace.baseRef, baseSha: t.workspace.baseSha }
		: ((made = createTaskWorktree(t.project, t.id, t.title)), { path: made.path, branch: made.branch, baseRef: made.baseRef, baseSha: made.base });
	// M59: its worktree gone (shelved, or a shelve cut short): made again from its branch; undone when the start is refused
	let restored = false;
	if (t.workspace?.path && !existsSync(w.path)) {
		restoreTaskWorktree(t.project, w.path, w.branch);
		restored = true;
	}
	const project = t.project;
	const discard = () => {
		if (made) discardWorktree({ path: made.path, branch: made.branch, repo: made.repo, base: made.base });
		if (restored) void removeTaskWorktree(project, w.path);
	};
	let launch: DispatchArgs;
	try {
		launch = dispatchLaunch(ctx, { task: taskPrompt(t), cwd: w.path, name: fallbackName(t.title), model });
	} catch (err) {
		discard();
		throw err;
	}
	try {
		const r = await call({ action: "start", id: t.id, workspace: w, launch });
		return r.job ? `Started #${t.id} in ${w.branch}: ${r.job.name} works on it; it goes to review when done.` : `#${t.id}: ${r.note ?? "starting"}`;
	} catch (err) {
		if (refusedByDaemon(err)) discard();
		throw err;
	}
}
