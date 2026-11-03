// M12: the session's own subagents (roost_spawn children) in a panel below the prompt,
// as in Claude Code: ↓ on an empty prompt selects a row, Enter opens (attaches to) it,
// its own detach keys come back here. PRD: "PRD: pi-roost 会话内子 agent 面板（M12）".
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

const RANK: Record<JobRow["state"], number> = { blocked: 0, working: 1, failed: 2, done: 3, stopped: 4 };

/** This session's children, waiting and working first, then in the order they were spawned. */
export function childrenOf(all: JobRow[], session: string | undefined, hidden: ReadonlySet<string> = new Set()): JobRow[] {
	if (!session) return [];
	return all
		.filter((r) => r.parentSession === session && !hidden.has(r.id))
		.sort((a, b) => RANK[a.state] - RANK[b.state] || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** Descendants below each child (shown as "(+N)"; they are not rows of their own). */
export function descendantCounts(all: JobRow[], children: JobRow[]): Map<string, number> {
	const kids = new Map<string, JobRow[]>();
	for (const r of all) {
		if (!r.parentSession) continue;
		const list = kids.get(r.parentSession) ?? [];
		list.push(r);
		kids.set(r.parentSession, list);
	}
	const out = new Map<string, number>();
	for (const c of children) {
		let n = 0;
		const seen = new Set<string>([c.id]);
		const stack = [...(kids.get(c.sessionFile) ?? [])];
		while (stack.length > 0) {
			const r = stack.pop()!;
			if (seen.has(r.id)) continue;
			seen.add(r.id);
			n++;
			stack.push(...(kids.get(r.sessionFile) ?? []));
		}
		if (n > 0) out.set(c.id, n);
	}
	return out;
}

export interface PanelView {
	rows: JobRow[];
	descendants: Map<string, number>;
	focused: boolean;
	sel: number;
	maxRows: number;
	now: number;
	frame: number;
	/** Terminal height: a short terminal gets one summary line. */
	termRows: number;
	/** A row that just needs input or finished (SP-13). */
	flash?: ReadonlySet<string>;
}

type Fg = (color: Parameters<Theme["fg"]>[0], text: string) => string;

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** The panel's lines; every line fits `width` (pi-tui ends the session on a wider one). */
export function renderPanel(v: PanelView, width: number, fg: Fg, bold: (s: string) => string = (s) => s): string[] {
	if (v.rows.length === 0 || width < 1) return [];
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
	const shownCount = overflow ? max - 1 : v.rows.length;
	// keep the selection on screen
	const start = overflow ? Math.min(Math.max(0, v.sel - shownCount + 1), v.rows.length - shownCount) : 0;
	const shown = v.rows.slice(start, start + shownCount);
	const nameW = Math.min(NAME_MAX, Math.max(...shown.map((r) => visibleWidth(oneLine(r.name)))));
	const lines: string[] = [];
	for (const [i, r] of shown.entries()) {
		const index = start + i;
		const selected = v.focused && index === v.sel;
		const icon = iconOf(r, v.frame);
		const name = truncateToWidth(oneLine(r.name), nameW, "…");
		const pad = " ".repeat(Math.max(0, nameW - visibleWidth(name)));
		const lead = selected ? fg("accent", "› ") : "  ";
		const nameText = selected ? bold(name) : v.flash?.has(r.id) ? fg("warning", name) : name;
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
	}
	if (overflow) lines.push(fit(fg("dim", `  … ${v.rows.length - shownCount} more (/agents)`)));
	const hint = v.focused ? "  ↵ open · x stop · Esc back" : `  ↓ select subagent${v.rows.length === 1 ? "" : "s"}`;
	lines.push(fit(fg("dim", hint)));
	return lines;
}

export type PanelKey = "down" | "up" | "open" | "stop" | "back" | "other";

export function keyOf(data: string): PanelKey | undefined {
	if (isKeyRelease(data)) return undefined;
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) return "open";
	if (data === "x") return "stop";
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) return "back";
	return "other";
}

/** Register the panel: foreground sessions and workers alike (an attached worker shows its own children). */
export function registerSubagentPanel(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let client: DaemonClient | undefined;
	let connecting = false;
	let watching = false;
	let all = new Map<string, JobRow>();
	let rows: JobRow[] = [];
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
	let enabled = true;

	const session = () => {
		try {
			return ctx?.sessionManager.getSessionFile();
		} catch {
			return undefined;
		}
	};

	function recompute(): void {
		rows = childrenOf([...all.values()], session(), hidden);
		if (rows.length === 0) focused = false;
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
					descendants: descendantCounts([...all.values()], rows),
					focused,
					sel,
					maxRows,
					now: Date.now(),
					frame,
					termRows: tui?.terminal.rows ?? 0,
					flash,
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

	function onEvent(e: Event): void {
		if (e.event === "job") {
			all.set(e.job.id, e.job);
			const before = lastStates.get(e.job.id);
			const now = e.job.state;
			lastStates.set(e.job.id, now);
			// SP-13: a child that starts waiting or finishes stands out until the panel is used
			if (before && before !== now && (now === "blocked" || now === "done" || now === "failed") && e.job.parentSession === session()) {
				flash.add(e.job.id);
				setTimeout(() => {
					flash.delete(e.job.id);
					requestRender();
				}, 5000).unref?.();
			}
		} else if (e.event === "removed") {
			all.delete(e.id);
			hidden.delete(e.id);
		} else return;
		recompute();
		requestRender();
	}

	async function watch(): Promise<void> {
		if (!enabled || client || connecting || !ctx) return;
		watching = true;
		connecting = true;
		let c: DaemonClient | undefined;
		try {
			// never starts the daemon: the panel only shows what is there
			c = await DaemonClient.connect();
			c.onEvent(onEvent);
			await c.request("subscribe", {});
			const { jobs } = await c.request("list", { all: true });
			if (!watching) return c.close();
			all = new Map(jobs.map((j) => [j.id, j]));
			lastStates = new Map(jobs.map((j) => [j.id, j.state]));
			client = c;
			const live = c;
			c.onClose(() => {
				if (client !== live) return;
				client = undefined;
				if (watching) scheduleReconnect();
			});
			recompute();
			requestRender();
		} catch {
			c?.close();
			if (watching) scheduleReconnect();
		} finally {
			connecting = false;
		}
	}

	function scheduleReconnect(): void {
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => void watch(), 2000);
		reconnectTimer.unref?.();
	}

	function unwatch(): void {
		watching = false;
		clearTimeout(reconnectTimer);
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
		focused = false;
	}

	async function enter(row: JobRow): Promise<void> {
		const t = tui;
		const c = ctx;
		if (!t || !c) return;
		let reason: DetachReason = "error";
		let failure: string | undefined;
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
			ctx?.ui.notify(`pi-roost: stopping ${oneLine(row.name)} · x again hides it`, "info");
		} catch (err) {
			ctx?.ui.notify(`pi-roost: could not stop ${oneLine(row.name)}: ${(err as Error).message}`, "error");
		}
	}

	function onInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (!enabled || attached || rows.length === 0) return undefined;
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
				if (sel === 0) focused = false;
				else select(sel - 1);
				break;
			case "back":
				focused = false;
				break;
			case "open": {
				const row = rows[sel];
				if (row) void enter(row);
				break;
			}
			case "stop": {
				const row = rows[sel];
				if (row) void stopOrHide(row);
				break;
			}
			default:
				// typing goes back to the prompt, with the key
				focused = false;
				tui?.requestRender();
				return undefined;
		}
		tui?.requestRender();
		return { consume: true };
	}

	pi.on("ui_prompt_start", () => {
		dialogs++;
		focused = false;
	});
	pi.on("ui_prompt_end", () => {
		dialogs = Math.max(0, dialogs - 1);
	});

	pi.on("session_start", (_event, c) => {
		ctx = c;
		stopKeys?.();
		stopKeys = undefined;
		unwatch();
		dialogs = 0;
		hidden.clear();
		if (!c.hasUI || pi.getFlag("agents") === true || typeof pi.getFlag("bg") === "string") return;
		const file = c.sessionManager.getSessionFile();
		if (isScratchSession(file)) return;
		const config = loadConfig(c.cwd);
		enabled = config.subagentPanel;
		maxRows = config.subagentPanelRows;
		if (!enabled) return;
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
		description: "Select this session's subagents in the panel below the prompt",
		handler: async (_args, c) => {
			await watch();
			if (rows.length === 0) return c.ui.notify("pi-roost: this session has no subagents", "info");
			focused = true;
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
	});
}
