// M65: a Task's worktree made, or made again from its branch, off the daemon's thread
// (git's checkout and the copy of included files take as long as the repository needs).
import { parentPort, workerData } from "node:worker_threads";
import { createTaskWorktree, restoreTaskWorktree } from "./task-git.ts";
import { WorktreeError } from "./worktree.ts";

const job = workerData as { op: "create"; repo: string; id: number; title: string } | { op: "restore"; repo: string; path: string; branch: string };
try {
	const result = job.op === "create" ? createTaskWorktree(job.repo, job.id, job.title) : (restoreTaskWorktree(job.repo, job.path, job.branch), null);
	parentPort!.postMessage({ ok: true, result });
} catch (err) {
	parentPort!.postMessage({ ok: false, worktree: err instanceof WorktreeError, message: (err as Error).message ?? String(err) });
}
