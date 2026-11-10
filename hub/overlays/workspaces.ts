// M57/M72: the workspace overlay: this repository's tasks (every project's outside one) as a
// pipeline, what needs you first; the selected one's detail beside it (below it under 100
// columns); the keys act on it. Moved out of the view in M72 (docs/plans/hub-overlays.md): it
// holds no view, only its host and the slice of the port it uses.
import { Input, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BoardTask, projectLabel } from "../../lib/board.ts";
import { taskChanges } from "../../lib/task-git.ts";
import { nextNeedsYou, overlaps, type TaskChanges, changeShort, type WsEntry, WS_GROUP_TITLES, type WsSession, workspaceEntries, wsCounts, wsDetail, wsIcon, wsKeys, wsRowText } from "../../lib/workspace-view.ts";
import { rowName, sentenceOf } from "../../lib/view-model.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import type { RoostPort } from "../roost-port.ts";
import { oneLine, wrap } from "../text.ts";

/** What the overlay asks of the daemon. */
export interface WorkspacesPort {
	tasks: Pick<RoostPort["tasks"], "list" | "pr" | "approve">;
}

/** What the overlay needs of the view. */
export type WorkspacesHost = Pick<OverlayHost<WorkspacesPort>, "port" | "theme" | "say" | "close" | "requestRender" | "attachTo" | "rows" | "current" | "notice" | "termRows" | "taskChanges">;

export interface WorkspacesOpts {
	/** The repository the hub is in (every project's tasks when null). */
	here: string | null;
	/** Open at the next task that needs you. */
	next: boolean;
	/** Open with this task selected. */
	focus?: number;
	/** A line of `/tasks` (`merge 4`, `start 9`, `back 4 note`, …): the view's command, which says what came of it. */
	tasksCommand(line: string): Promise<void>;
	/** Open the review of task `id` (the overlay has closed itself; Esc there comes back here). */
	openReview(id: number): void;
}

/**
 * Loads the tasks first; `undefined` when that failed (the host has been told). The overlay
 * follows the board: its `onEvent` reloads on a `board` event.
 */
export async function createWorkspacesOverlay(host: WorkspacesHost, opts: WorkspacesOpts): Promise<Overlay | undefined> {
	const { port } = host;
	const { here, focus } = opts;
	const t = host.theme;
	const changesOf = host.taskChanges ?? taskChanges;
	let tasks: BoardTask[] = [];
	let entries: WsEntry[] = [];
	let sel: number | undefined;
	let top = 0;
	let back: { id: number; input: Input } | undefined;
	// approve: the commands shown in full, then y (the dry call's hash goes with it)
	let confirm: { id: number; note: string; hash: string; kind: "approve" | "pr" } | undefined;
	let busy = false;
	let closed = false;
	const changes = new Map<number, { key: string; at: number; c?: TaskChanges; loading: boolean }>();
	const sessionOf = (x: BoardTask): WsSession | undefined => {
		const r = x.owner ? host.rows().get(x.owner.id) : undefined;
		return r ? { name: oneLine(rowName(r)), state: r.state, waitingFor: r.waitingFor ?? null, running: r.pid !== null } : undefined;
	};
	const selected = (): BoardTask | undefined => entries.find((e) => e.task.id === sel)?.task;
	// what each worktree holds: read again when its stage, note or verify changed, or after 5 s
	const fetchChanges = () => {
		const now = Date.now();
		for (const e of entries) {
			const w = e.task.workspace;
			if (!w || !w.path || w.stage === "merged" || !w.baseRef) continue;
			const key = `${w.stage}:${w.note ?? ""}:${w.verify?.at ?? 0}`;
			const hit = changes.get(e.task.id);
			if (hit && (hit.loading || (hit.key === key && now - hit.at < 5000))) continue;
			changes.set(e.task.id, { key, at: now, c: hit?.c, loading: true });
			void changesOf(w.path, w.baseRef).then(
				(c) => {
					changes.set(e.task.id, { key, at: Date.now(), c, loading: false });
					if (!closed) host.requestRender();
				},
				() => changes.set(e.task.id, { key, at: Date.now(), loading: false }),
			);
		}
	};
	const load = async (pickNext: boolean): Promise<void> => {
		const r = await port.tasks.list(here ? { project: here } : {});
		if (closed) return;
		tasks = r.tasks;
		entries = workspaceEntries(tasks);
		if (pickNext) sel = nextNeedsYou(entries, undefined, sessionOf) ?? sel;
		else if (focus !== undefined && sel === undefined) sel = focus;
		if (sel === undefined || !entries.some((e) => e.task.id === sel)) sel = entries[0]?.task.id;
		fetchChanges();
		host.requestRender();
	};
	let reloading: Promise<void> | undefined;
	let again = false;
	let self: Overlay | undefined;
	const reload = () => {
		// replaced by another overlay without closing: stop following the board
		if (self && host.current() !== self) closed = true;
		if (closed) return;
		// one load at a time; one more after it when asked meanwhile (its answer may predate the change)
		if (reloading) {
			again = true;
			return;
		}
		reloading = load(false)
			.catch((err: unknown) => host.say((err as Error).message, "error"))
			.finally(() => {
				reloading = undefined;
				if (again) {
					again = false;
					reload();
				}
			});
	};
	try {
		await load(opts.next);
	} catch (err) {
		host.say((err as Error).message, "error");
		return undefined;
	}
	if (opts.next && (sel === undefined || !nextNeedsYou(entries, undefined, sessionOf))) host.say(entries.length > 0 ? "nothing needs you" : "no tasks in workspaces: /tasks add, then s on it here", "muted");
	// a verb of /tasks on the selected task; the overlay reloads after it
	const act = (verb: string, x: BoardTask, extra = "") => {
		if (busy) return;
		busy = true;
		void opts.tasksCommand(`${verb} ${x.id}${extra ? ` ${extra}` : ""}`).finally(() => {
			busy = false;
			reload();
		});
	};
	// M60: tasks changing the same files (from what was read of each worktree)
	let overlapNow = new Map<number, { id: number; files: string[] }[]>();
	const listLines = (width: number): { lines: string[]; selAt: number } => {
		overlapNow = overlaps(entries, (id) => changes.get(id)?.c);
		const lines: string[] = [];
		let selAt = 0;
		let group = "";
		for (const e of entries) {
			if (e.group !== group) {
				group = e.group;
				lines.push(t.fg("dim", truncateToWidth(WS_GROUP_TITLES[e.group], width)));
			}
			const s = sessionOf(e.task);
			const icon = wsIcon(e.task, s);
			const isSel = e.task.id === sel;
			if (isSel) selAt = lines.length;
			const shared = overlapNow.has(e.task.id) ? "⚠ " : "";
			const right = `${shared}${changeShort(changes.get(e.task.id)?.c) || (e.task.workspace?.stage === "working" && s && !s.running ? "idle" : "")}`.trim();
			const head = `${isSel ? t.fg("accent", "▶") : " "} ${t.fg(icon.tone, icon.glyph)} `;
			const room = Math.max(1, width - visibleWidth(head) - (right ? visibleWidth(right) + 1 : 0));
			const text = truncateToWidth(oneLine(wsRowText(e.task, tasks)), room);
			const gap = " ".repeat(Math.max(1, width - visibleWidth(head) - visibleWidth(text) - visibleWidth(right)));
			lines.push(truncateToWidth(`${head}${isSel ? t.bold(text) : text}${right ? `${gap}${t.fg("dim", right)}` : ""}`, width));
		}
		if (entries.length === 0) lines.push(t.fg("dim", truncateToWidth(here ? "no tasks here: /tasks add <title>" : "no tasks", width)));
		return { lines, selAt };
	};
	const detailLines = (width: number, max: number): string[] => {
		const x = selected();
		if (!x) return [];
		const s = sessionOf(x);
		const row = x.owner ? host.rows().get(x.owner.id) : undefined;
		const hit = changes.get(x.id);
		const items = wsDetail(x, { session: s, sentence: row ? sentenceOf(row) : undefined, changes: hit?.c ?? (hit?.loading ? "loading" : undefined), fileMax: Math.max(2, max - 12), overlap: overlapNow.get(x.id) });
		const out = [t.bold(truncateToWidth(`#${x.id} ${oneLine(x.title)}`, width))];
		for (const it of items) {
			const label = it.label ? it.label.padEnd(7) : " ".repeat(7);
			const text = truncateToWidth(oneLine(it.text), Math.max(1, width - 8));
			out.push(`${t.fg("dim", label)} ${it.tone ? t.fg(it.tone, text) : text}`);
		}
		return out.slice(0, max);
	};
	return (self = {
		render(width: number) {
			const rows = host.termRows() || 30;
			const room = Math.max(4, rows - 8);
			const title = `${here ? projectLabel(here) : "all projects"} · workspaces`;
			const counts = wsCounts(entries);
			const pad = Math.max(1, width - visibleWidth(title) - visibleWidth(counts));
			const out = [truncateToWidth(`${t.bold(title)}${" ".repeat(pad)}${t.fg("dim", counts)}`, width), ""];
			const wide = width >= 100;
			const listW = wide ? Math.min(48, Math.floor(width * 0.42)) : width;
			const { lines: list, selAt } = listLines(listW);
			const listRoom = wide ? room : Math.max(3, Math.floor(room / 2));
			// the selection stays in view
			if (selAt < top) top = selAt;
			if (selAt >= top + listRoom) top = selAt - listRoom + 1;
			top = Math.max(0, Math.min(top, Math.max(0, list.length - listRoom)));
			const shown = list.slice(top, top + listRoom);
			if (wide) {
				const detail = detailLines(width - listW - 3, room);
				for (let i = 0; i < Math.max(shown.length, detail.length); i++) {
					const l = shown[i] ?? "";
					out.push(`${l}${" ".repeat(Math.max(0, listW - visibleWidth(l)))} ${t.fg("dim", "│")} ${detail[i] ?? ""}`);
				}
			} else {
				out.push(...shown, t.fg("dim", "─".repeat(Math.min(width, 40))), ...detailLines(width, Math.max(3, room - shown.length - 1)));
			}
			out.push("");
			if (back) out.push(...back.input.render(width));
			if (confirm) for (const l of wrap(confirm.kind === "approve" ? `approve for #${confirm.id}: ${confirm.note} · they run in your account` : `#${confirm.id}: ${confirm.note}?`, width)) out.push(t.fg("warning", l));
			const n = host.notice();
			if (n && n.until > Date.now()) out.push(t.fg(n.tone, truncateToWidth(oneLine(n.text), width)));
			const x = selected();
			const keys = back ? "Enter send back with this note (empty: none) · Esc cancel" : confirm ? `y ${confirm.kind === "approve" ? "approve these commands" : "push and open it"} · any other key: no` : [...wsKeys(x, x ? sessionOf(x) : undefined).map(([k, v]) => `${k} ${v}`), "↑↓ select", "Esc close"].join(" · ");
			out.push(t.fg("dim", truncateToWidth(keys, width)));
			return out;
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (back) {
				if (key === "escape" || key === "ctrl+c") back = undefined;
				else if (key === "enter") {
					// the task the note was written for, wherever the selection went meanwhile
					const note = oneLine(back.input.getValue()).trim();
					const x = tasks.find((y) => y.id === back!.id);
					back = undefined;
					if (x) act("back", x, note);
				} else back.input.handleInput(data);
				return;
			}
			if (confirm) {
				const c = confirm;
				confirm = undefined;
				if (data !== "y" || busy) return host.say(c.kind === "approve" ? "not approved" : "no pull request", "muted");
				busy = true;
				if (c.kind === "pr") host.say(`#${c.id}: pushing…`, "muted");
				void (c.kind === "pr" ? port.tasks.pr({ id: c.id, hash: c.hash }) : port.tasks.approve({ id: c.id, hash: c.hash }))
					.then((r) => host.say(r.note ?? "approved", "success"))
					.catch((err: unknown) => host.say((err as Error).message, "error"))
					.finally(() => {
						busy = false;
						reload();
					});
				return;
			}
			if (key === "escape" || key === "ctrl+c" || data === "q") return host.close();
			const i = entries.findIndex((e) => e.task.id === sel);
			if (key === "up" || key === "down") {
				const j = Math.max(0, Math.min(entries.length - 1, (i < 0 ? 0 : i) + (key === "up" ? -1 : 1)));
				sel = entries[j]?.task.id;
				fetchChanges();
				return;
			}
			if (key === "home" || key === "end") {
				sel = (key === "home" ? entries[0] : entries[entries.length - 1])?.task.id;
				fetchChanges();
				return;
			}
			if (data === "n" || key === "ctrl+n") {
				const to = nextNeedsYou(entries, sel, sessionOf);
				if (to === undefined) host.say("nothing needs you", "muted");
				else sel = to;
				return;
			}
			if (data === "r") {
				changes.clear();
				return reload();
			}
			const x = selected();
			if (!x) return;
			const s = sessionOf(x);
			const allowed = new Set(wsKeys(x, s).map(([k]) => k));
			// M58: Enter reviews a task with a workspace (its diff, comments); Esc comes back here
			if (key === "enter" && x.workspace?.path && x.workspace.stage !== "merged" && x.workspace.stage !== "shelved") {
				const at = x.id;
				host.close();
				return opts.openReview(at);
			}
			const attach = data === "t" || key === "right" || key === "enter";
			if (attach) {
				if (s?.running && x.owner) {
					host.close();
					return void host.attachTo(x.owner.id).catch((err: unknown) => host.say(String((err as Error).message ?? err), "error"));
				}
				if (data === "t" || key === "right") host.say(`#${x.id} has no session running${allowed.has("s") ? ": s starts one" : ""}`, "muted");
				return;
			}
			if (!allowed.has(data)) return;
			if (data === "b") {
				back = { id: x.id, input: new Input({ prompt: `#${x.id} back › ` }) };
				back.input.focused = true;
				return;
			}
			if (data === "o") {
				if (busy) return;
				busy = true;
				void port.tasks
					.pr({ id: x.id, dry: true })
					.then((r) => {
						if (r.hash) confirm = { id: x.id, note: oneLine(r.note ?? ""), hash: r.hash, kind: "pr" };
					})
					.catch((err: unknown) => host.say((err as Error).message, "error"))
					.finally(() => {
						busy = false;
						host.requestRender();
					});
				return;
			}
			if (data === "a") {
				if (busy) return;
				busy = true;
				void port.tasks
					.approve({ id: x.id, dry: true })
					.then((r) => {
						if (r.hash) confirm = { id: x.id, note: oneLine(r.note ?? ""), hash: r.hash, kind: "approve" };
						else host.say(r.note ?? "nothing to approve", "muted");
					})
					.catch((err: unknown) => host.say((err as Error).message, "error"))
					.finally(() => {
						busy = false;
						host.requestRender();
					});
				return;
			}
			const verb = { s: "start", m: "merge", v: "verify", p: "pass", x: "abort", h: "shelve" }[data];
			if (verb) act(verb, x);
		},
		onEvent(e) {
			// M57: follow the board
			if (e.event === "board") reload();
		},
		dispose() {
			closed = true;
		},
	});
}
