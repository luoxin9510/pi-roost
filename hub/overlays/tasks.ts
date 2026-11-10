// M47/M59/M73: the task board overlay (/tasks: open, blocked, claimed, then done, newest first)
// and the lines overlay (what /tasks cleanup found or did). Moved out of the view in M73
// (docs/plans/hub-overlays.md): both are read only and hold nothing of the view; the tasks are
// handed in by `/tasks`, which stays the view's command.
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type BoardTask, boardSummary, liveOrder, manyProjects, summaryLine, taskLine } from "../../lib/board.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import { oneLine } from "../text.ts";

/** What the overlays need of the view (no daemon: the data is handed in). */
export type TasksHost = Pick<OverlayHost<never>, "theme" | "close" | "requestRender" | "termRows">;

export interface TasksOpts {
	tasks: BoardTask[];
	/** Named in the title: "all projects", or the repository. */
	scope: string;
}

/** M47: the board as an overlay: open (claimable), blocked, claimed, then done, newest first; ↑↓ scroll, Esc closes. */
export function createTasksOverlay(host: TasksHost, opts: TasksOpts): Overlay {
	const { tasks, scope } = opts;
	const projects = manyProjects(tasks);
	let top = 0;
	const lines = (width: number): string[] => {
		const t = host.theme;
		const now = Date.now();
		const out = [t.bold(truncateToWidth(`Task board · ${scope} · ${summaryLine(boardSummary(tasks))}`, width)), ""];
		const live = tasks.filter((x) => x.state === "open" || x.state === "claimed");
		const group = (x: BoardTask) => liveOrder(x, tasks);
		for (const x of [...live].sort((a, b) => group(a) - group(b) || a.id - b.id)) {
			const g = group(x);
			const line = oneLine(taskLine(x, tasks, now, projects));
			out.push(truncateToWidth(`  ${t.fg(g === 0 ? "accent" : g === 1 ? "warning" : "muted", line)}`, width));
			if (x.detail && g !== 2) out.push(truncateToWidth(`      ${t.fg("dim", oneLine(x.detail))}`, width));
		}
		if (live.length === 0) out.push(t.fg("dim", tasks.some((x) => x.state === "done") ? "  every task is done" : "  the board is empty"));
		const done = tasks.filter((x) => x.state === "done").sort((a, b) => (b.doneAt ?? b.at) - (a.doneAt ?? a.at));
		if (done.length > 0) {
			out.push("");
			for (const x of done.slice(0, 30)) out.push(truncateToWidth(`  ${t.fg("dim", oneLine(taskLine(x, tasks, now, projects)))}`, width));
			if (done.length > 30) out.push(t.fg("dim", `  … ${done.length - 30} more done`));
		}
		out.push("", t.fg("dim", truncateToWidth("/tasks all · add <title> [after #n] [-- detail] · assign <id> <session> · done <id> [result] · rm <id> · release <id>", width)));
		return out;
	};
	return {
		render(width: number) {
			const all = lines(width);
			const room = Math.max(3, (host.termRows() || 30) - 6);
			top = Math.max(0, Math.min(top, all.length - room));
			return [...all.slice(top, top + room), "", host.theme.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
		},
	};
}

export interface LinesOpts {
	title: string;
	lines: string[];
}

/** M59: lines in an overlay (what cleanup found or did); ↑↓ scroll, Esc closes. */
export function createLinesOverlay(host: TasksHost, opts: LinesOpts): Overlay {
	const { title, lines } = opts;
	const t = host.theme;
	let top = 0;
	return {
		render(width: number) {
			const room = Math.max(3, (host.termRows() || 30) - 6);
			const body = lines.map((l) => truncateToWidth(`  ${oneLine(l)}`, width));
			top = Math.max(0, Math.min(top, Math.max(0, body.length - room)));
			return [t.bold(truncateToWidth(title, width)), "", ...body.slice(top, top + room), "", t.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
		},
	};
}
