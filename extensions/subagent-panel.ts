// M12: the session's own subagents (roost_spawn children) in a panel below the prompt,
// as in Claude Code: ↓ on an empty prompt selects a row, Enter opens (attaches to) it,
// its own detach keys come back here. PRD: "PRD: pi-roost 会话内子 agent 面板（M12）".
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, decodeKittyPrintable, Input, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { attachToHost, type DetachReason } from "../lib/attach.ts";
import { DaemonClient } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { hostSocketPath, isScratchSession } from "../lib/paths.ts";
import type { Event, JobRow } from "../lib/protocol.ts";
import { ensureLive } from "../lib/resume.ts";
import { ageOf, iconOf, sentenceOf } from "../lib/view-model.ts";
import { focusedOf, isPromptEditor } from "./foreground.ts";
import { agentViewOpen } from "./open-view.ts";
import { hasChildren } from "./peer-link.ts";

const WIDGET_KEY = "pi-roost-subagents";
const RENDER_MS = 250;
const SPIN_MS = 120;
const NAME_MAX = 24;
const NARROW = 40;
const SHORT = 12;

type ArmKey = "open" | "stop" | "stopAll";
const ALL = "*";
const FINISHED_HINT = "/subagents to see subagents";

const RANK: Record<JobRow["state"], number> = { blocked: 0, working: 1, failed: 2, done: 3, stopped: 4 };

/** M13 (Claude Code): a failed or stopped subagent's row, and a finished one in /subagents, stay this long. */
export const LINGER_MS = 30_000;

/**
 * Which rows the panel holds. `panel`: running and waiting subagents, failed and
 * stopped ones for LINGER_MS (a finished one leaves at once). `list` (/subagents): also
 * finished ones for LINGER_MS. `all` (/subagents all): every subagent there is.
 */
export type PanelMode = "panel" | "list" | "all";

export function shownIn(r: JobRow, now: number, mode: PanelMode): boolean {
	if (mode === "all" || r.state === "working" || r.state === "blocked") return true;
	const recent = now - r.stateSince < LINGER_MS;
	return r.state === "done" ? mode === "list" && recent : recent;
}

const bySpawn = (a: JobRow, b: JobRow) => RANK[a.state] - RANK[b.state] || a.startedAt - b.startedAt || a.id.localeCompare(b.id);

export interface TreeRow {
	row: JobRow;
	depth: number;
}

/**
 * This session's subagents as a tree (Claude Code shows nested subagents as one): each
 * row, then the rows below it, waiting and working first at each level. A row that is
 * no longer shown stays while something below it still is, so a path leads to it.
 */
export function panelTree(all: JobRow[], session: string | undefined, opts: { now?: number; mode?: PanelMode; hidden?: ReadonlySet<string> } = {}): TreeRow[] {
	if (!session) return [];
	const now = opts.now ?? Date.now();
	const mode = opts.mode ?? "panel";
	const hidden = opts.hidden ?? new Set<string>();
	const kids = new Map<string, JobRow[]>();
	for (const r of all) {
		if (!r.parentSession) continue;
		kids.set(r.parentSession, [...(kids.get(r.parentSession) ?? []), r]);
	}
	const seen = new Set<string>();
	const walk = (file: string, depth: number): TreeRow[] => {
		const out: TreeRow[] = [];
		for (const k of [...(kids.get(file) ?? [])].sort(bySpawn)) {
			if (seen.has(k.id)) continue;
			seen.add(k.id);
			const below = k.sessionFile && k.sessionFile !== file ? walk(k.sessionFile, depth + 1) : [];
			if (below.length > 0 || (!hidden.has(k.id) && shownIn(k, now, mode))) out.push({ row: k, depth }, ...below);
		}
		return out;
	};
	return walk(session, 0);
}

/** Rows below each row of the tree ("(+N)", Claude Code's count of descendants in the panel). */
export function descendantCounts(tree: TreeRow[]): Map<string, number> {
	const out = new Map<string, number>();
	tree.forEach((t, i) => {
		let n = 0;
		for (let j = i + 1; j < tree.length && tree[j]!.depth > t.depth; j++) n++;
		if (n > 0) out.set(t.row.id, n);
	});
	return out;
}

export interface PanelView {
	rows: JobRow[];
	descendants: Map<string, number>;
	/** M13: how deep each row sits in the tree (0: this session's own subagent). */
	depth?: ReadonlyMap<string, number>;
	/** M13: a subagent finished just now: "/subagents to see subagents" (Claude Code's footer). */
	finished?: boolean;
	focused: boolean;
	sel: number;
	maxRows: number;
	now: number;
	frame: number;
	/** Terminal height: a short terminal gets one summary line. */
	termRows: number;
	/** A row that just needs input or finished (SP-13). */
	flash?: ReadonlySet<string>;
	/** Replaces the key hint: a key that needs pressing again. */
	notice?: string;
	/** SP-16: the message being written to the selected child, rendered by the caller. */
	composer?: (width: number) => string;
}

type Fg = (color: Parameters<Theme["fg"]>[0], text: string) => string;

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** The panel's lines; every line fits `width` (pi-tui ends the session on a wider one). */
export function renderPanel(v: PanelView, width: number, fg: Fg, bold: (s: string) => string = (s) => s): string[] {
	if (width < 1) return [];
	if (v.rows.length === 0) return v.finished ? [truncateToWidth(fg("dim", `  ${FINISHED_HINT}`), width)] : [];
	const fit = (s: string) => truncateToWidth(s, width);
	const busy = v.rows.filter((r) => r.state === "working" && r.status === "busy").length;
	const waiting = v.rows.filter((r) => r.state === "blocked").length;
	if (v.termRows > 0 && v.termRows < SHORT) {
		const parts = [`${v.rows.length} subagent${v.rows.length === 1 ? "" : "s"}`];
		if (waiting) parts.push(`${waiting} waiting`);
		if (busy) parts.push(`${busy} working`);
		parts.push(v.focused ? "Esc back" : "↓");
		return [fit(fg("dim", `  ${parts.join(" · ")}`))];
	}
	const max = Math.max(1, v.maxRows);
	const overflow = v.rows.length > max;
	const shownCount = overflow ? Math.max(1, max - 1) : v.rows.length;
	// keep the selection on screen
	const start = overflow ? Math.min(Math.max(0, v.sel - shownCount + 1), v.rows.length - shownCount) : 0;
	const shown = v.rows.slice(start, start + shownCount);
	const indent = (r: JobRow) => {
		const d = v.depth?.get(r.id) ?? 0;
		return d > 0 ? `${"  ".repeat(d - 1)}└ ` : "";
	};
	const nameW = Math.max(...shown.map((r) => visibleWidth(indent(r)) + Math.min(NAME_MAX, visibleWidth(oneLine(r.name)))));
	const lines: string[] = [];
	for (const [i, r] of shown.entries()) {
		const index = start + i;
		const selected = v.focused && index === v.sel;
		const icon = iconOf(r, v.frame);
		const pre = indent(r);
		const name = truncateToWidth(oneLine(r.name), Math.max(1, Math.min(NAME_MAX, nameW - visibleWidth(pre))), "…");
		const pad = " ".repeat(Math.max(0, nameW - visibleWidth(pre) - visibleWidth(name)));
		const lead = selected ? fg("accent", "› ") : "  ";
		const nameText = (pre ? fg("dim", pre) : "") + (selected ? bold(name) : v.flash?.has(r.id) ? fg("warning", name) : name);
		if (width < NARROW) {
			lines.push(fit(`${lead}${fg(icon.tone, icon.glyph)} ${nameText}`));
			continue;
		}
		const more = v.descendants.get(r.id);
		const tail = [
			fg("dim", ageOf(r, v.now)),
			fg(r.state === "blocked" ? "warning" : r.state === "failed" ? "error" : "muted", oneLine(r.state === "stopped" ? `stopped${r.summary ? ` · ${r.summary}` : ""}` : sentenceOf(r))),
			...(r.worktree ? [fg("dim", `⎇ ${oneLine(r.worktree.branch)}`)] : []),
			...(more ? [fg("dim", `(+${more})`)] : []),
		].join("  ");
		lines.push(fit(`${lead}${fg(icon.tone, icon.glyph)} ${nameText}${pad}  ${tail}`));
		if (selected && v.composer && width > 6) lines.push(fit(`    ${v.composer(width - 4)}`));
	}
	if (overflow) lines.push(fit(fg("dim", `  … ${v.rows.length - shownCount} more (/agents)`)));
	if (v.notice && v.focused) lines.push(fit(fg("warning", `  ${oneLine(v.notice)}`)));
	else {
		const keys = v.composer
			? "  ↵ send · Esc cancel"
			: v.focused
				? "  ↵ open · m message · x stop · K stop all · Esc back"
				: `  ↓ select subagent${v.rows.length === 1 ? "" : "s"}${v.finished ? ` · ${FINISHED_HINT}` : ""}`;
		lines.push(fit(fg("dim", keys)));
	}
	return lines;
}

export type PanelKey = "down" | "up" | "open" | "stop" | "stopAll" | "message" | "back" | "other";

export function keyOf(data: string): PanelKey | undefined {
	if (isKeyRelease(data)) return undefined;
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) return "open";
	// plain text, or a terminal that encodes printable keys as CSI-u
	const ch = data.length === 1 ? data : decodeKittyPrintable(data);
	if (ch === "x") return "stop";
	if (ch === "K") return "stopAll";
	if (ch === "m") return "message";
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) return "back";
	return "other";
}

/** Register the panel: foreground sessions and workers alike (an attached worker shows its own children). */
export function registerSubagentPanel(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let client: DaemonClient | undefined;
	/** Bumped by unwatch: a connect from an earlier session drops itself. */
	let gen = 0;
	let connectingGen = -1;
	let watching = false;
	let backoff = 2000;
	/** A key that needs pressing again (Enter on an ended child, x on a running one). */
	let armed: { id: string; key: ArmKey; at: number; count?: number } | undefined;
	/** SP-16: a message being written to one child. */
	let composer: { id: string; input: Input } | undefined;
	const ARM_MS = 2500;
	const flashTimers = new Set<NodeJS.Timeout>();
	let all = new Map<string, JobRow>();
	let rows: JobRow[] = [];
	let tree: TreeRow[] = [];
	/** M13: what the panel holds; /subagents widens it while the panel is selected. */
	let mode: PanelMode = "panel";
	/** M13: until then the footer says "/subagents to see subagents" (a subagent finished). */
	let finishedUntil = 0;
	let expiryTimer: NodeJS.Timeout | undefined;
	const hidden = new Set<string>();
	const flash = new Set<string>();
	let focused = false;
	let sel = 0;
	/** The selected child, so a re-sort (a child finished) does not move the selection. */
	let selId: string | undefined;
	let attached = false;
	let dialogs = 0;
	let frame = 0;
	let spin: NodeJS.Timeout | undefined;
	let spinMs = 0;
	let renderTimer: NodeJS.Timeout | undefined;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let stopKeys: (() => void) | undefined;
	let lastStates = new Map<string, string>();
	let maxRows = 5;
	let enabled = false;

	const session = () => {
		try {
			return ctx?.sessionManager.getSessionFile();
		} catch {
			return undefined;
		}
	};

	function recompute(): void {
		const now = Date.now();
		tree = panelTree([...all.values()], session(), { hidden, now, mode });
		if (tree.length === 0 && focused) {
			unfocus();
			tree = panelTree([...all.values()], session(), { hidden, now, mode });
		}
		rows = tree.map((t) => t.row);
		scheduleExpiry(now);
		const at = selId ? rows.findIndex((r) => r.id === selId) : -1;
		select(at >= 0 ? at : sel);
		// a spinner while a child is busy, else a tick a second for the ages of live ones
		const busy = rows.some((r) => r.state === "working" && r.status === "busy");
		const live = rows.some((r) => r.pid !== null);
		const want = busy ? SPIN_MS : live ? 1000 : 0;
		if (want !== spinMs) {
			clearInterval(spin);
			spin = undefined;
			spinMs = want;
			if (want > 0) {
				spin = setInterval(() => {
					frame++;
					requestRender();
				}, want);
				spin.unref?.();
			}
		}
	}

	/** Leaving the panel drops a half-written message with it, and what /subagents added. */
	function unfocus(): void {
		focused = false;
		composer = undefined;
		mode = "panel";
	}

	/** M13: look again when a lingering row or the footer hint is due to go. */
	function scheduleExpiry(now: number): void {
		clearTimeout(expiryTimer);
		expiryTimer = undefined;
		let next = finishedUntil > now ? finishedUntil : Infinity;
		if (mode !== "all") {
			for (const r of rows) {
				if (r.state === "working" || r.state === "blocked") continue;
				const at = r.stateSince + LINGER_MS;
				if (at > now) next = Math.min(next, at);
			}
		}
		if (next === Infinity) return;
		expiryTimer = setTimeout(
			() => {
				expiryTimer = undefined;
				recompute();
				requestRender();
			},
			Math.max(50, next - now + 20),
		);
		expiryTimer.unref?.();
	}

	/** A subagent of this session, at any depth. */
	function isMine(job: JobRow): boolean {
		const me = session();
		const byFile = new Map([...all.values()].map((r) => [r.sessionFile, r]));
		const seen = new Set<string>();
		for (let p = job.parentSession; p; p = byFile.get(p)?.parentSession) {
			if (p === me) return true;
			if (seen.has(p)) return false;
			seen.add(p);
		}
		return false;
	}

	function select(i: number): void {
		sel = Math.max(0, Math.min(i, rows.length - 1));
		selId = rows[sel]?.id;
	}

	function requestRender(): void {
		if (attached || renderTimer) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			if (!attached) tui?.requestRender();
		}, RENDER_MS);
		renderTimer.unref?.();
	}

	const component: Component = {
		render: (width: number) => {
			const theme = themeOf();
			if (!enabled || !theme) return [];
			return renderPanel(
				{
					rows,
					descendants: descendantCounts(tree),
					depth: new Map(tree.map((t) => [t.row.id, t.depth])),
					finished: Date.now() < finishedUntil,
					focused,
					sel,
					maxRows,
					now: Date.now(),
					frame,
					termRows: tui?.terminal.rows ?? 0,
					flash,
					notice: armedNotice(),
					...(composer && rows[sel]?.id === composer.id ? { composer: (w: number) => composer!.input.render(w)[0] ?? "" } : {}),
				},
				width,
				(c, t) => theme.fg(c, t),
				(t) => theme.bold(t),
			);
		},
		invalidate: () => {},
	};
	let theme: Theme | undefined;
	const themeOf = () => theme;

	function armedNotice(): string | undefined {
		if (!armed || Date.now() - armed.at > ARM_MS) return undefined;
		if (armed.key === "stopAll") {
			const n = armed.count ?? 0;
			return `K again stops ${n} running subagent${n === 1 ? "" : "s"}`;
		}
		const row = rows.find((r) => r.id === armed!.id);
		if (!row) return undefined;
		return armed.key === "open" ? `${oneLine(row.name)} is ${row.state} · ↵ again starts it` : `x again stops ${oneLine(row.name)}`;
	}

	/** True when this is the second press of `key` on `row` in time; otherwise arms it. */
	function confirmed(row: { id: string }, key: ArmKey): boolean {
		const now = Date.now();
		if (armed && armed.id === row.id && armed.key === key && now - armed.at <= ARM_MS) {
			armed = undefined;
			return true;
		}
		armed = { id: row.id, key, at: now, ...(key === "stopAll" ? { count: rows.filter((r) => r.pid !== null).length } : {}) };
		const t = setTimeout(() => {
			flashTimers.delete(t);
			requestRender();
		}, ARM_MS + 50);
		t.unref?.();
		flashTimers.add(t);
		return false;
	}

	function onEvent(e: Event): void {
		if (e.event === "job") {
			all.set(e.job.id, e.job);
			const before = lastStates.get(e.job.id);
			const now = e.job.state;
			lastStates.set(e.job.id, now);
			// M13: a finished subagent leaves the panel; the footer says where it went
			if (before && before !== now && now === "done" && isMine(e.job)) finishedUntil = Date.now() + LINGER_MS;
			// SP-13: a child that starts waiting or fails stands out until the panel is used
			if (before && before !== now && (now === "blocked" || now === "failed") && isMine(e.job)) {
				flash.add(e.job.id);
				const t = setTimeout(() => {
					flashTimers.delete(t);
					flash.delete(e.job.id);
					requestRender();
				}, 5000);
				t.unref?.();
				flashTimers.add(t);
			}
		} else if (e.event === "removed") {
			all.delete(e.id);
			hidden.delete(e.id);
		} else return;
		recompute();
		requestRender();
	}

	async function watch(): Promise<void> {
		if (!enabled || !ctx) return;
		watching = true;
		const my = gen;
		if (client || connectingGen === my) return;
		connectingGen = my;
		let c: DaemonClient | undefined;
		try {
			// never starts the daemon: the panel only shows what is there
			c = await DaemonClient.connect();
			c.onEvent(onEvent);
			await c.request("subscribe", {});
			const { jobs } = await c.request("list", { all: true });
			if (my !== gen || !watching) return c.close();
			all = new Map(jobs.map((j) => [j.id, j]));
			lastStates = new Map(jobs.map((j) => [j.id, j.state]));
			client = c;
			backoff = 2000;
			const live = c;
			c.onClose(() => {
				if (client !== live) return;
				client = undefined;
				if (watching && my === gen) scheduleReconnect();
			});
			recompute();
			requestRender();
		} catch {
			c?.close();
			if (watching && my === gen) scheduleReconnect();
		} finally {
			if (connectingGen === my) connectingGen = -1;
		}
	}

	function scheduleReconnect(): void {
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => void watch(), backoff);
		reconnectTimer.unref?.();
		backoff = Math.min(backoff * 2, 30_000);
	}

	function unwatch(): void {
		gen++;
		watching = false;
		armed = undefined;
		composer = undefined;
		for (const t of flashTimers) clearTimeout(t);
		flashTimers.clear();
		flash.clear();
		clearTimeout(reconnectTimer);
		clearTimeout(expiryTimer);
		expiryTimer = undefined;
		finishedUntil = 0;
		clearTimeout(renderTimer);
		renderTimer = undefined;
		clearInterval(spin);
		spin = undefined;
		spinMs = 0;
		const c = client;
		client = undefined;
		c?.close();
		all = new Map();
		rows = [];
		tree = [];
		unfocus();
	}

	async function enter(row: JobRow): Promise<void> {
		const t = tui;
		const c = ctx;
		if (!t || !c) return;
		let reason: DetachReason = "error";
		let failure: string | undefined;
		composer = undefined;
		attached = true;
		try {
			t.stop();
			if (row.pid === null) {
				process.stdout.write(`starting ${oneLine(row.name)} …\r\n`);
				const daemon = client ?? (await DaemonClient.connectOrStart());
				try {
					await ensureLive(daemon, row, process.stdout);
				} finally {
					if (daemon !== client) daemon.close();
				}
			}
			reason = await attachToHost(hostSocketPath(row.id), { stdin: process.stdin, stdout: process.stdout });
		} catch (err) {
			failure = (err as Error).message;
		} finally {
			attached = false;
			t.start();
			t.requestRender(true);
		}
		try {
			if (failure) c.ui.notify(`pi-roost: could not open ${oneLine(row.name)}: ${oneLine(failure)}`, "error");
			else if (reason === "takeover") c.ui.notify(`pi-roost: ${oneLine(row.name)} was opened elsewhere`, "warning");
			else if (reason === "exit") c.ui.notify(`pi-roost: ${oneLine(row.name)} ended`, "info");
			else if (reason === "error" || reason === "closed") c.ui.notify(`pi-roost: lost the connection to ${oneLine(row.name)}`, "error");
		} catch {
			// a stale context after a session switch
		}
		if (!client && watching) void watch();
	}

	async function stopOrHide(row: JobRow): Promise<void> {
		if (row.pid === null) {
			hidden.add(row.id); // gone from here, still in the agent view
			recompute();
			return requestRender();
		}
		try {
			const c = client ?? (await DaemonClient.connect());
			try {
				await c.request("stop", { id: row.id });
			} finally {
				if (c !== client) c.close();
			}
			ctx?.ui.notify(`pi-roost: stopping ${oneLine(row.name)} · x on it again hides it`, "info");
		} catch (err) {
			ctx?.ui.notify(`pi-roost: could not stop ${oneLine(row.name)}: ${(err as Error).message}`, "error");
		}
	}

	/** Stop every running child; one that fails does not keep the others running. */
	async function stopAll(): Promise<string> {
		const live = rows.filter((r) => r.pid !== null);
		if (live.length === 0) return "no subagent is running";
		const c = client ?? (await DaemonClient.connect());
		let results: PromiseSettledResult<unknown>[];
		try {
			results = await Promise.allSettled(live.map((r) => c.request("stop", { id: r.id })));
		} finally {
			if (c !== client) c.close();
		}
		const ok = results.filter((x) => x.status === "fulfilled").length;
		const plural = (n: number) => `${n} subagent${n === 1 ? "" : "s"}`;
		return ok === live.length ? `stopping ${plural(ok)}` : `stopping ${ok} of ${plural(live.length)} (the others could not be stopped)`;
	}

	function openComposer(row: JobRow, draft = ""): void {
		const short = truncateToWidth(oneLine(row.name), 12, "…");
		const input = new Input({ prompt: `message ${short} › ` });
		input.focused = true;
		if (draft) input.setValue(draft);
		const id = row.id;
		input.onSubmit = (value) => {
			const text = value.trim();
			if (!text) return;
			composer = undefined;
			tui?.requestRender();
			void sendMessage(id, text).then((sent) => {
				// not sent: the text comes back to be sent later or copied
				const row = rows.find((r) => r.id === id);
				if (!sent && row && focused && !composer && rows[sel]?.id === id) {
					openComposer(row, text);
					tui?.requestRender();
				}
			});
		};
		input.onEscape = () => {
			composer = undefined;
			tui?.requestRender();
		};
		composer = { id, input };
	}

	/** SP-16: as a reply from the user (it starts a run that reports back, M9). */
	async function sendMessage(id: string, text: string): Promise<boolean> {
		const name = oneLine(rows.find((r) => r.id === id)?.name ?? id);
		const say = (m: string, tone: "info" | "warning" | "error") => {
			try {
				ctx?.ui.notify(`pi-roost: ${m}`, tone);
			} catch {}
		};
		try {
			const c = client ?? (await DaemonClient.connectOrStart());
			try {
				const r = await c.request("reply", { id, text });
				if (r.stopped) say(`${name} is stopped: open it (↵ twice) to start it, then send again`, "warning");
				else if (r.delivered) say(`sent · ${name}`, "info");
				else if (r.respawned) say(`sent · starting ${name} again`, "info");
				else if (r.saved) say(`saved for ${name}; it is sent when it starts${r.error ? ` (${r.error})` : ""}`, "warning");
				else say(`not delivered: ${name} is not running`, "error");
				return !!(r.delivered || r.respawned || r.saved);
			} finally {
				if (c !== client) c.close();
			}
		} catch (err) {
			say(`could not send to ${name}: ${(err as Error).message}`, "error");
			return false;
		}
	}

	function onInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!enabled || attached || rows.length === 0) return undefined;
		if (composer && focused) {
			// everything goes to the message being written (Enter sends, Esc cancels)
			if (!rows.some((r) => r.id === composer!.id)) composer = undefined;
			else {
				if (!isKeyRelease(data)) composer.input.handleInput(data);
				tui?.requestRender();
				return { consume: true };
			}
		}
		const key = keyOf(data);
		if (!key) return undefined;
		if (!focused) {
			if (key !== "down") return undefined;
			if (dialogs > 0 || agentViewOpen() || !isPromptEditor(focusedOf(tui))) return undefined;
			if ((ctx?.ui.getEditorText() ?? "x").length > 0) return undefined;
			focused = true;
			select(0);
			flash.clear();
			tui?.requestRender();
			return { consume: true };
		}
		switch (key) {
			case "down":
				select(sel + 1);
				break;
			case "up":
				if (sel === 0) {
					unfocus();
					recompute();
				} else select(sel - 1);
				break;
			case "back":
				unfocus();
				recompute();
				break;
			case "open": {
				const row = rows[sel];
				// an ended child starts again only on a second press (a reaped one just wakes up)
				if (row && (row.pid !== null || row.reaped || confirmed(row, "open"))) void enter(row);
				break;
			}
			case "stop": {
				const row = rows[sel];
				// stopping loses the turn in progress: press twice; hiding a stopped one does not
				if (row && (row.pid === null || confirmed(row, "stop"))) void stopOrHide(row);
				break;
			}
			case "stopAll": {
				if (!rows.some((r) => r.pid !== null)) {
					ctx?.ui.notify("pi-roost: no subagent is running", "info");
					break;
				}
				if (confirmed({ id: ALL }, "stopAll")) {
					void stopAll()
						.then((m) => ctx?.ui.notify(`pi-roost: ${m}`, "info"))
						.catch((err: unknown) => ctx?.ui.notify(`pi-roost: ${(err as Error).message}`, "error"));
				}
				break;
			}
			case "message": {
				const row = rows[sel];
				if (row) openComposer(row);
				break;
			}
			default:
				// typing goes back to the prompt, with the key
				unfocus();
				recompute();
				tui?.requestRender();
				return undefined;
		}
		tui?.requestRender();
		return { consume: true };
	}

	pi.on("ui_prompt_start", () => {
		dialogs++;
		unfocus();
		recompute();
		composer = undefined;
	});
	pi.on("ui_prompt_end", () => {
		dialogs = Math.max(0, dialogs - 1);
	});

	pi.on("session_start", (_event, c) => {
		stopKeys?.();
		stopKeys = undefined;
		unwatch();
		dialogs = 0;
		hidden.clear();
		// off until every check passes: headless and scratch sessions never connect
		enabled = false;
		ctx = undefined;
		if (!c.hasUI || pi.getFlag("agents") === true || typeof pi.getFlag("bg") === "string") return;
		const file = c.sessionManager.getSessionFile();
		if (isScratchSession(file)) return;
		const config = loadConfig(c.cwd);
		if (!config.subagentPanel) return;
		enabled = true;
		ctx = c;
		maxRows = config.subagentPanelRows;
		c.ui.setWidget(
			WIDGET_KEY,
			(t, th) => {
				tui = t;
				theme = th;
				return component;
			},
			{ placement: "belowEditor" },
		);
		stopKeys = c.ui.onTerminalInput(onInput);
		if (hasChildren(file)) void watch();
	});

	// the first child of this session: start watching
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "roost_spawn" && !event.isError) void watch();
	});

	pi.registerCommand("subagents", {
		description: "Select this session's subagents below the prompt, with the ones that just finished (all: every one it ever had; stop: stop them all)",
		getArgumentCompletions: (prefix: string) => {
			const opts = [
				{ value: "all", label: "all", description: "every subagent of this session, finished ones too" },
				{ value: "stop", label: "stop", description: "stop every running subagent of this session" },
			].filter((o) => o.value.startsWith(prefix));
			return opts.length > 0 ? opts : null;
		},
		handler: async (args, c) => {
			if (!enabled) return c.ui.notify("pi-roost: the subagent panel is off here", "info");
			await watch();
			for (let i = 0; i < 20 && !client && connectingGen !== -1; i++) await new Promise((r) => setTimeout(r, 50));
			const arg = args.trim();
			if (arg === "stop") {
				const n = rows.filter((r) => r.pid !== null).length;
				if (n === 0) return c.ui.notify("pi-roost: no subagent is running", "info");
				if (!(await c.ui.confirm("Stop subagents", `Stop ${n} running subagent${n === 1 ? "" : "s"} of this session?`))) return;
				try {
					return c.ui.notify(`pi-roost: ${await stopAll()}`, "info");
				} catch (err) {
					return c.ui.notify(`pi-roost: could not stop the subagents: ${(err as Error).message}`, "error");
				}
			}
			// M13: as Claude Code's /tasks, finished subagents are listed for a while too
			mode = arg === "all" ? "all" : "list";
			recompute();
			if (rows.length === 0) {
				mode = "panel";
				recompute();
				return c.ui.notify(arg === "all" ? "pi-roost: this session has no subagents" : "pi-roost: no subagent finished just now · /subagents all lists every one", "info");
			}
			composer = undefined;
			focused = true;
			finishedUntil = 0;
			select(0);
			tui?.requestRender();
		},
	});

	pi.on("session_shutdown", () => {
		stopKeys?.();
		stopKeys = undefined;
		unwatch();
		try {
			ctx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {}
		ctx = undefined;
		tui = undefined;
		theme = undefined;
		enabled = false;
	});
}
