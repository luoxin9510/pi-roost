// M26/M74: the compare overlay (/compare): the sessions of a fan-out (or marked rows) side by
// side, one column each, with what each changed in its worktree. Moved out of the view in M74
// (docs/plans/hub-overlays.md). Which rows to compare, and what "keep one" does to the view
// (the cursor, the marks, the notice), stay the view's: they come in as `ids` and `keepOne`.
import { existsSync } from "node:fs";
import { decodeKittyPrintable, isKeyRelease, parseKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { JobRow } from "../../lib/protocol.ts";
import { formatCost } from "../../lib/usage.ts";
import { ageOf, formatTokens, shortModel } from "../../lib/view-model.ts";
import { changeText, worktreeChange } from "../../lib/worktree.ts";
import { DOUBLE_PRESS_MS, type Overlay, type OverlayHost } from "../overlay-host.ts";
import { CONTROL, oneLine } from "../text.ts";

/** What the overlay needs of the view (no daemon: `keepOne` is the view's). */
export type CompareHost = Pick<OverlayHost<never>, "theme" | "say" | "close" | "requestRender" | "attachTo" | "selectRow" | "rows" | "termRows" | "worktreeChange">;

export interface CompareOpts {
	/** The sessions to compare, in column order. */
	ids: string[];
	/** Their fan-out when they are one (k keeps one of a fan-out only). */
	fanoutId?: string;
	/** The column to start on, when it is one of `ids`. */
	selectedId?: string;
	/** k twice: keep `keep`, delete `others` (the overlay has closed itself). */
	keepOne(keep: JobRow, others: JobRow[]): Promise<void>;
}

/** The overlay's lines at `width`: the columns, or (narrow) the chosen one in full and one line for each other. */
function compareLines(host: CompareHost, rows: JobRow[], index: number, changes: Map<string, string>, width: number, room: number): string[] {
	const t = host.theme;
	const now = Date.now();
	// pi may have named the sessions since (each its own way): the first one's name, less its model
	const first = rows[0]!;
	const tag = first.model ? ` · ${shortModel(first.model)}` : "";
	const title = tag && first.name.endsWith(tag) ? first.name.slice(0, -tag.length) : first.name;
	const out = [t.bold(truncateToWidth(`Compare · ${oneLine(title)} · ${rows.length} sessions`, width)), ""];
	const block = (r: JobRow, w: number, sel: boolean): string[] => {
		const u = r.usage;
		const tokens = u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
		const head = `${sel ? "›" : " "} ${r.model ? shortModel(r.model) : oneLine(r.name)}`;
		const lines = [
			sel ? t.fg("accent", t.bold(head)) : t.bold(head),
			t.fg("dim", `  ${r.state} · ${ageOf(r, now)}`),
			t.fg("muted", `  ${u ? `${formatCost(u.cost)} · ${formatTokens(tokens)} tok${u.sub ? " (sub)" : ""}` : "no usage yet"}`),
			t.fg("muted", `  ${changes.get(r.id) ?? "…"}`),
			"",
		];
		const text = r.question ?? r.summary ?? r.error ?? "";
		// a model's text: no escape sequences or tabs reach the terminal (lines stay)
		const clean = stripTerminalSequences(text).replace(/\t/g, "  ").replace(CONTROL, "");
		const body = wrapTextWithAnsi(clean, Math.max(4, w - 2)).map((l) => `  ${l}`);
		return [...lines, ...body].map((l) => truncateToWidth(l, w));
	};
	const gap = 2;
	const colW = Math.floor((width - gap * (rows.length - 1)) / rows.length);
	if (colW >= 24) {
		const blocks = rows.map((r, i) => block(r, colW, i === index));
		const height = Math.min(room - 2, Math.max(...blocks.map((b) => b.length)));
		for (let y = 0; y < height; y++) {
			out.push(
				blocks
					.map((b) => {
						const l = b[y] ?? "";
						return l + " ".repeat(Math.max(0, colW - visibleWidth(l)));
					})
					.join(" ".repeat(gap)),
			);
		}
		return out;
	}
	// narrow: the chosen one in full, the others as one line each
	rows.forEach((r, i) => {
		if (i === index) out.push(...block(r, width, true).slice(0, Math.max(5, room - rows.length - 2)));
		else out.push(truncateToWidth(`  ${r.model ? shortModel(r.model) : oneLine(r.name)} · ${r.state} · ${r.usage ? formatCost(r.usage.cost) : "-"} · ${changes.get(r.id) ?? "…"}`, width));
	});
	return out;
}

/**
 * M26: one column per session, ← → choose, Enter opens it, r reads the worktrees again, k twice
 * keeps it (a fan-out only). Rows are read from the host each time, so it follows the list; it
 * closes itself when none of them is left. Reads each worktree's change when it opens.
 */
export function createCompareOverlay(host: CompareHost, opts: CompareOpts): Overlay {
	const { ids, fanoutId } = opts;
	const changes = new Map<string, string>();
	let index = Math.max(0, ids.indexOf(opts.selectedId ?? ""));
	let keepArmed = 0;
	let closed = false;
	const change = host.worktreeChange ?? worktreeChange;
	const present = (): JobRow[] => ids.map((id) => host.rows().get(id)).filter((r): r is JobRow => r !== undefined);
	const load = () => {
		for (const id of ids) {
			const wt = host.rows().get(id)?.worktree;
			if (!wt?.base) {
				changes.set(id, "no worktree");
				continue;
			}
			void change(wt.path, wt.base)
				.then((c) => changes.set(id, c ? changeText(c) : existsSync(wt.path) ? "no diff (its base is gone?)" : "worktree gone"))
				.catch(() => changes.set(id, "?"))
				.finally(() => {
					if (!closed) host.requestRender();
				});
		}
	};
	load();
	return {
		render(width: number) {
			const rows = present();
			if (rows.length === 0) {
				queueMicrotask(() => host.close());
				return [];
			}
			index = Math.min(index, rows.length - 1);
			const room = Math.max(6, (host.termRows() || 30) - 7);
			const armed = keepArmed > 0 && Date.now() - keepArmed < DOUBLE_PRESS_MS;
			const keys = armed
				? "k again: keep this one, delete the others (pinned ones stay)"
				: `← → choose · Enter open${fanoutId ? " · k keep this one (deletes the others)" : ""} · r refresh · Esc close`;
			return [...compareLines(host, rows, index, changes, width, room), "", host.theme.fg(armed ? "warning" : "dim", truncateToWidth(keys, width))];
		},
		handleInput(data: string) {
			if (isKeyRelease(data)) return;
			const key = parseKey(data);
			// a letter as typed, also when the terminal encodes it (kitty CSI u)
			const ch = decodeKittyPrintable(data) ?? data;
			const count = ids.filter((id) => host.rows().has(id)).length;
			if (ch !== "k") keepArmed = 0;
			if (key === "escape" || key === "ctrl+c" || ch === "q") host.close();
			else if (key === "left") index = Math.max(0, index - 1);
			else if (key === "right" || key === "tab") index = Math.min(count - 1, index + 1);
			else if (ch === "r") load();
			else if (key === "enter") {
				const row = present()[index];
				host.close();
				if (row) {
					host.selectRow(row.id);
					void host.attachTo(row.id).catch((err: unknown) => host.say(String(err), "error"));
				}
			} else if (ch === "k") {
				// keeping one deletes the others: only among the sessions of one fan-out
				if (!fanoutId) return host.say("k keeps one of a fan-out; for marked rows use Ctrl+X", "warning");
				const now = Date.now();
				if (!keepArmed || now - keepArmed > DOUBLE_PRESS_MS) {
					keepArmed = now;
					// the prompt goes back when the double press runs out
					setTimeout(() => {
						if (!closed) host.requestRender();
					}, DOUBLE_PRESS_MS + 50).unref?.();
					return;
				}
				keepArmed = 0;
				const rows = present();
				const keep = rows[index];
				host.close();
				if (keep) void opts.keepOne(keep, rows.filter((r) => r.id !== keep.id));
			}
		},
		dispose() {
			closed = true;
		},
	};
}
