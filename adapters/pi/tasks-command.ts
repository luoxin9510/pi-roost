// M59: /tasks in any pi session (and so from the phone, through pi-mobile): the task
// board of the session's repository and the workspace actions a person takes. It speaks
// to the daemon as a person does (the hub, the CLI), on a connection of its own: a slash
// command is typed by a person (pi runs no command a model writes, and the concierge's
// answers to a session are refused when they start with "/").
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BoardTask, projectLabel, projectOf } from "../../lib/board.ts";
import { DaemonClient } from "../../lib/client.ts";
import { workspaceEntries, wsCounts, wsIcon } from "../../lib/workspace-view.ts";
import { startTaskInPi } from "./task-start.ts";

export const TASKS_USAGE = "/tasks [start | merge | back <id> [note] | verify | pass | shelve | approve <id> | cleanup [yes]]";
const APPROVE_MS = 30_000;

/** The board of a repository as lines for a notice: the counts, then each task with its icon and stage. */
export function tasksText(tasks: BoardTask[], scope: string): string {
	const entries = workspaceEntries(tasks);
	const out = [`${scope} · ${wsCounts(entries)}`];
	for (const e of entries) {
		const w = e.task.workspace;
		const where = w ? `${w.stage === "review" ? "in review" : w.stage}${w.note ? ` (${w.note.replace(/\s+/g, " ").slice(0, 80)})` : ""}` : "open";
		out.push(`${wsIcon(e.task).glyph} #${e.task.id} ${e.task.title.replace(/\s+/g, " ").slice(0, 60)} · ${where}`);
	}
	return out.join("\n");
}

export function registerTasksCommand(pi: ExtensionAPI, connect: () => Promise<DaemonClient> = () => DaemonClient.connectOrStart()): void {
	let shown: { id: number; hash: string; at: number } | undefined;
	pi.registerCommand("tasks", {
		description: "The task board of this repository: start, merge, send back, shelve tasks in their worktrees",
		handler: async (raw: string, ctx: ExtensionContext) => {
			const say = (text: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, level);
			const [verb = "", ...rest] = raw.trim().split(/\s+/).filter(Boolean);
			const id = Number((rest[0] ?? "").replace(/^#/, ""));
			const hasId = Number.isInteger(id) && id > 0;
			let client: DaemonClient | undefined;
			try {
				client = await connect();
				const c = client;
				const call = (args: Record<string, unknown>) => c.request("task", args as never);
				const here = projectOf(ctx.cwd);
				if (!verb || verb === "list") {
					const { tasks } = await call({ action: "list", ...(here ? { project: here } : {}) });
					return say(tasksText(tasks, here ? projectLabel(here) : "all projects"));
				}
				if (verb === "cleanup") {
					const r = await call({ action: "cleanup", dry: rest[0] !== "yes" });
					return say(`${rest[0] === "yes" ? "Cleaned up" : "Left behind (/tasks cleanup yes removes it)"}:\n${r.note ?? ""}`);
				}
				if (!hasId) return say(TASKS_USAGE, "warning");
				switch (verb) {
					case "start":
						return say(await startTaskInPi(call as never, ctx, id));
					case "merge":
					case "verify":
					case "pass":
					case "shelve": {
						const r = await call({ action: verb, id });
						return say(`#${id}: ${r.note ?? r.task?.workspace?.stage ?? "done"}`);
					}
					case "back": {
						const r = await call({ action: "back", id, note: rest.slice(1).join(" ") || undefined });
						return say(`#${id} back to work · ${r.note ?? ""}`);
					}
					case "approve": {
						// shown first; approved by the same command again within 30 s (what was shown)
						if (!shown || shown.id !== id || Date.now() - shown.at >= APPROVE_MS) {
							const r = await call({ action: "approve", id, dry: true });
							if (!r.hash) return say(r.note ?? "nothing to approve", "warning");
							shown = { id, hash: r.hash, at: Date.now() };
							return say(`${r.note} · they run in your account: /tasks approve ${id} again within 30 s to approve`, "warning");
						}
						const hash = shown.hash;
						shown = undefined;
						const r = await call({ action: "approve", id, hash });
						return say(r.note ?? "approved");
					}
					default:
						return say(TASKS_USAGE, "warning");
				}
			} catch (err) {
				say((err as Error).message, "error");
			} finally {
				client?.close();
			}
		},
	});
}
