// M58/M72: a task's review: its diff against base (committed and not), a file at a time, the
// person's comments under their lines; c comments, b sends back with them, m merges. Moved out
// of the view in M72 (docs/plans/hub-overlays.md): it holds no view, only its host and the
// slice of the port it uses.
import { Input, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BoardTask, ReviewComment } from "../../lib/board.ts";
import { commentAnchor, commentOn, outdatedIn } from "../../lib/review.ts";
import { type DiffFile, type DiffLine, type TaskDiff, taskDiff } from "../../lib/task-diff.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import type { RoostPort } from "../roost-port.ts";
import { CONTROL, oneLine, wrap } from "../text.ts";

/** What the overlay asks of the daemon. */
export interface ReviewPort {
	tasks: Pick<RoostPort["tasks"], "list" | "comment" | "uncomment">;
}

/** What the overlay needs of the view. */
export type ReviewHost = Pick<OverlayHost<ReviewPort>, "port" | "theme" | "say" | "close" | "requestRender" | "current" | "notice" | "termRows" | "taskDiff">;

export interface ReviewOpts {
	/** The task under review. */
	id: number;
	/** A line of `/tasks` (`merge 4`, `back 4 note`): the view's command, which says what came of it. */
	tasksCommand(line: string): Promise<void>;
	/** Where Esc goes (the workspace overlay it came from); also called when the diff could not be loaded. */
	onClose?: () => void;
}

/** Loads the task and its diff first; `undefined` when that failed (the host has been told). */
export async function createReviewOverlay(host: ReviewHost, opts: ReviewOpts): Promise<Overlay | undefined> {
	const { port } = host;
	const { id, onClose } = opts;
	const t = host.theme;
	const diffOf = host.taskDiff ?? taskDiff;
	let task: BoardTask | undefined;
	let diff: TaskDiff | undefined;
	let fi = 0;
	let ri = -1; // -1: the file's first line of diff
	let top = 0;
	let input: { kind: "comment" | "back"; box: Input } | undefined;
	let busy = false;
	let closed = false;
	let self: Overlay | undefined;
	const load = async (): Promise<void> => {
		const { tasks } = await port.tasks.list();
		task = tasks.find((x) => x.id === id);
		const w = task?.workspace;
		if (!task || !w || !w.path) throw new Error(`#${id} has no workspace to review`);
		const d = await diffOf(w.path, w.baseRef);
		if (!d) throw new Error(`#${id}: git could not diff ${w.branch} against ${w.baseRef}`);
		diff = d;
		fi = Math.min(fi, Math.max(0, d.files.length - 1));
	};
	try {
		await load();
	} catch (err) {
		host.say((err as Error).message, "error");
		onClose?.();
		return undefined;
	}
	const comments = () => task?.workspace?.comments ?? [];
	// the files, and one more holding the comments on files no longer in the diff
	const filesOf = (): DiffFile[] => {
		const fs = diff?.files ?? [];
		const there = new Set(fs.map((f) => f.path));
		return comments().some((c) => !there.has(c.file)) ? [...fs, { path: "", status: "M", binary: false, hunks: [] }] : fs;
	};
	type Row = { kind: "hunk"; text: string; h: number } | { kind: "line"; line: DiffLine; h: number } | { kind: "note"; text: string } | { kind: "stale"; c: ReviewComment };
	const rowsOf = (f: DiffFile | undefined): Row[] => {
		if (!f) return [];
		// comments not under a line of it now (outdated), first; d deletes them there
		if (!f.path) {
			const there = new Set((diff?.files ?? []).map((x) => x.path));
			return comments().filter((c) => !there.has(c.file)).map((c) => ({ kind: "stale", c }));
		}
		const out: Row[] = outdatedIn(f, comments()).map((c) => ({ kind: "stale", c }));
		if (f.summary) return [...out, { kind: "note", text: f.summary }];
		if (f.binary) return [...out, { kind: "note", text: "binary file" }];
		if (f.hunks.length === 0) return [...out, { kind: "note", text: f.status === "R" ? "renamed, its text unchanged" : f.status === "A" ? "an empty file" : f.status === "D" ? "an empty file, deleted" : "its text unchanged (its mode changed)" }];
		f.hunks.forEach((hk, h) => {
			out.push({ kind: "hunk", text: hk.header, h });
			for (const line of hk.lines) out.push({ kind: "line", line, h });
		});
		return out;
	};
	const anchor = commentAnchor;
	// a comment sits under its line while that line is where it was; otherwise it is outdated (kept)
	const placed = (f: DiffFile, rows: Row[]) => {
		const at = new Map<number, ReviewComment[]>();
		for (const c of comments()) {
			if (c.file !== f.path) continue;
			const r = rows.findIndex((x) => x.kind === "line" && commentOn(c, f.path, x.line));
			if (r >= 0) at.set(r, [...(at.get(r) ?? []), c]);
		}
		return { at };
	};
	const clean = (s: string) => s.replace(/\t/g, "    ").replace(CONTROL, " ").replace(/[\x80-\x9f]/g, " ");
	// merge and back close the review when they did it (the task merged, at work again); else it stays
	const act = (verb: string, extra = "") => {
		if (busy) return host.say("busy: try again in a moment", "muted");
		busy = true;
		void opts
			.tasksCommand(`${verb} ${id}${extra ? ` ${extra}` : ""}`)
			.then(() => reload())
			.finally(() => {
				busy = false;
				const stage = task?.workspace?.stage;
				if ((verb === "merge" && stage === "merged") || (verb === "back" && stage === "working")) close();
			});
	};
	const reload = async () => {
		try {
			await load();
		} catch (err) {
			// a merged task's worktree is gone: nothing to diff any more
			if (task?.workspace?.stage !== "merged") host.say((err as Error).message, "error");
		}
		if (!closed) host.requestRender();
	};
	const close = () => {
		if (closed || host.current() !== self) return;
		host.close();
		onClose?.();
	};
	const moveLine = (rows: Row[], to: number) => {
		ri = Math.max(0, Math.min(rows.length - 1, to));
	};
	return (self = {
		render(width: number) {
			const room = Math.max(4, (host.termRows() || 30) - 9);
			const files = filesOf();
			fi = Math.min(fi, Math.max(0, files.length - 1));
			const f = files[fi];
			const rows = rowsOf(f);
			if (ri < 0) ri = Math.max(0, rows.findIndex((r) => r.kind === "line"));
			moveLine(rows, ri);
			const { at } = f ? placed(f, rows) : { at: new Map<number, ReviewComment[]>() };
			const hunks = f?.hunks.length ?? 0;
			const cur = rows[ri];
			const h = cur && (cur.kind === "line" || cur.kind === "hunk") ? cur.h + 1 : 0;
			const name = !f ? "no changes" : !f.path ? "comments on files not in the diff now" : clean(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);
			const head = `#${id} ${oneLine(task?.title ?? "")} · ${f?.path ? `${f.status} ` : ""}${name}`;
			const facts = [files.length > 1 ? `file ${fi + 1}/${files.length}` : "", hunks > 0 ? `hunk ${h || 1}/${hunks}` : "", comments().length > 0 ? `${comments().length} comment${comments().length === 1 ? "" : "s"}` : "", diff?.truncated ? "diff cut short" : ""].filter(Boolean).join(" · ");
			const out = [t.bold(truncateToWidth(oneLine(head), width)), t.fg("dim", truncateToWidth(facts || " ", width)), t.fg("dim", "─".repeat(Math.max(1, Math.min(width, 120))))];
			// the body: the rows with the comments under theirs, the cursor in view
			const body: { text: string; row: number }[] = [];
			rows.forEach((r, i) => {
				const mark = i === ri ? t.fg("accent", "▶") : " ";
				if (r.kind === "note") body.push({ text: `${mark} ${t.fg("dim", r.text)}`, row: i });
				else if (r.kind === "stale") body.push({ text: `${mark} ${t.fg("warning", truncateToWidth(clean(`✎ ${f?.path ? "outdated" : r.c.file} (line ${r.c.line}): ${oneLine(r.c.text)}`), Math.max(1, width - 2)))}`, row: i });
				else if (r.kind === "hunk") body.push({ text: `${mark} ${t.fg("dim", truncateToWidth(clean(r.text), Math.max(1, width - 2)))}`, row: i });
				else {
					const l = r.line;
					const no = String(l.newNo ?? l.oldNo ?? "").padStart(5);
					const text = truncateToWidth(clean(`${l.kind} ${l.text}`), Math.max(1, width - 8), "…");
					body.push({ text: `${mark}${t.fg("dim", no)} ${l.kind === "+" ? t.fg("success", text) : l.kind === "-" ? t.fg("error", text) : text}`, row: i });
				}
				for (const c of at.get(i) ?? []) for (const w of wrap(clean(`└ ✎ ${oneLine(c.text)}`), Math.max(1, width - 8))) body.push({ text: `       ${t.fg("warning", w)}`, row: i });
			});
			const first = body.findIndex((b) => b.row === ri);
			let last = first;
			while (last + 1 < body.length && body[last + 1]!.row === ri) last++;
			if (first < top) top = first;
			if (last >= top + room) top = last - room + 1;
			top = Math.max(0, Math.min(top, Math.max(0, body.length - room)));
			out.push(...body.slice(top, top + room).map((b) => b.text));
			if (files.length === 0) out.push(t.fg("dim", "  nothing changed against base"));
			out.push("");
			if (input) out.push(...input.box.render(width));
			const n = host.notice();
			if (n && n.until > Date.now()) out.push(t.fg(n.tone, truncateToWidth(oneLine(n.text), width)));
			const keys = input
				? `Enter ${input.kind === "comment" ? "keep the comment" : "send back with the comments"} · Esc cancel`
				: "j/k line · n/p hunk · ]/[ file · c comment · d delete comment · b send back · m merge · r reload · Esc back";
			out.push(t.fg("dim", truncateToWidth(keys, width)));
			return out.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		},
		handleInput(data: string) {
			const key = parseKey(data);
			const files = filesOf();
			const f = files[fi];
			const rows = rowsOf(f);
			if (input) {
				if (key === "escape" || key === "ctrl+c") input = undefined;
				else if (key === "enter") {
					// busy: the text stays in the box for another Enter
					if (busy) return host.say("busy: Enter again in a moment", "muted");
					const text = oneLine(input.box.getValue()).trim();
					const kind = input.kind;
					input = undefined;
					if (kind === "back") return act("back", text);
					const r = rows[ri];
					if (!text || !f?.path || r?.kind !== "line") return;
					busy = true;
					void port.tasks
						.comment(id, { file: f.path, ...anchor(r.line), text, tip: diff?.tip })
						.then((res) => {
							if (task?.workspace && res.task?.workspace) task.workspace.comments = res.task.workspace.comments;
						})
						.catch((err: unknown) => host.say((err as Error).message, "error"))
						.finally(() => {
							busy = false;
							host.requestRender();
						});
				} else input.box.handleInput(data);
				return;
			}
			if (key === "escape" || data === "q" || key === "ctrl+c") return close();
			if (data === "j" || key === "down") return moveLine(rows, ri + 1);
			if (data === "k" || key === "up") return moveLine(rows, ri - 1);
			if (key === "pageDown") return moveLine(rows, ri + 10);
			if (key === "pageUp") return moveLine(rows, ri - 10);
			if (data === "n" || data === "p") {
				// to the first line of the next (previous) hunk; p from a hunk's start goes to the one before
				const cur = rows[ri];
				const h = cur && (cur.kind === "line" || cur.kind === "hunk") ? cur.h : data === "n" ? -1 : Number.MAX_SAFE_INTEGER;
				const want = data === "n" ? h + 1 : h - 1;
				const at = rows.findIndex((r) => r.kind === "hunk" && r.h === want);
				if (at >= 0) moveLine(rows, at + 1 < rows.length ? at + 1 : at);
				return;
			}
			if (data === "]" || data === "[") {
				const to = fi + (data === "]" ? 1 : -1);
				if (to >= 0 && to < files.length) {
					fi = to;
					// the first line of its diff (past its outdated comments and its first hunk's header)
					const next = rowsOf(files[to]);
					const first = next.findIndex((r) => r.kind === "line");
					ri = first >= 0 ? first : 0;
					top = 0;
				}
				return;
			}
			if (data === "r") return void reload();
			if (data === "c") {
				if (rows[ri]?.kind !== "line") return host.say("c comments on a line of the diff", "muted");
				input = { kind: "comment", box: new Input({ prompt: "comment › " }) };
				input.box.focused = true;
				return;
			}
			if (data === "d") {
				if (!f || busy) return;
				const r = rows[ri];
				const mine = r?.kind === "stale" ? [r.c] : r?.kind === "line" ? placed(f, rows).at.get(ri) : undefined;
				if (!mine || mine.length === 0) return host.say("no comment here", "muted");
				const c = mine[mine.length - 1]!;
				busy = true;
				void port.tasks
					.uncomment(id, { file: c.file, line: c.line, at: c.at })
					.then((res) => {
						if (task?.workspace) task.workspace.comments = res.task?.workspace?.comments;
					})
					.catch((err: unknown) => host.say((err as Error).message, "error"))
					.finally(() => {
						busy = false;
						host.requestRender();
					});
				return;
			}
			if (data === "b") {
				input = { kind: "back", box: new Input({ prompt: `#${id} back › ` }) };
				input.box.focused = true;
				return;
			}
			if (data === "m") return act("merge");
		},
		dispose() {
			closed = true;
		},
	});
}
