// M57/M59/M65: a task started in its own worktree from a pi process (the concierge's
// hub_task_start, the /tasks command in a pi session): the daemon makes the worktree
// (prepare), the pi launch is built here in it, the start is sent to the daemon.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { type BoardTask, taskPrompt } from "../../lib/board.ts";
import { CONCIERGE_ROLE_ENV } from "../../lib/concierge.ts";
import { envPolicy, loadConfig } from "../../lib/config.ts";
import { buildLaunch, fallbackName } from "../../lib/dispatch.ts";
import type { DispatchArgs } from "../../lib/protocol.ts";

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

type TaskCall = (args: Record<string, unknown>) => Promise<{ tasks: BoardTask[]; job?: { id: string; name: string }; note?: string; workspace?: { path: string; branch: string; sourceDirty?: boolean } }>;

/** Starts task `id` in its worktree (M65: the daemon's, prepared for it); says what happened. */
export async function startTaskInPi(call: TaskCall, ctx: Pick<ExtensionContext, "cwd">, id: number, model?: string): Promise<string> {
	const { tasks } = await call({ action: "list" });
	const t = tasks.find((x) => x.id === id);
	if (!t) throw new Error(`no task #${id}`);
	if (!t.project) throw new Error(`#${t.id} is for any session: a workspace is a repository's`);
	const w = (await call({ action: "prepare", id: t.id })).workspace;
	if (!w) throw new Error(`#${t.id}: no worktree came back`);
	// a launch that cannot be built leaves the prepared worktree to the daemon (it removes it after a while)
	const launch = dispatchLaunch(ctx, { task: taskPrompt(t), cwd: w.path, name: fallbackName(t.title), model });
	const r = await call({ action: "start", id: t.id, launch });
	const dirty = w.sourceDirty ? " (uncommitted changes in the main checkout are not in it)" : "";
	return r.job ? `Started #${t.id} in ${w.branch}${dirty}: ${r.job.name} works on it; it goes to review when done.` : `#${t.id}: ${r.note ?? "starting"}`;
}
