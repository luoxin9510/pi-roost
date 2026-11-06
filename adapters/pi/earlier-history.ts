// M53: entering a session from the hub shows its whole conversation. pi's chat starts at
// the latest compaction (it renders what the model still has in context, and clears the
// chat when it compacts), so what came before is in the session file but not on the
// screen. This puts it back above the chat, a few messages at a time: each time the
// transcript is scrolled to its top (the wheel, PgUp, Home), the next older ones load,
// drawn by pi's own message components, and the view stays where it was.

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	parseSkillBlock,
	type SessionEntry,
	SkillInvocationMessageComponent,
	sessionEntryToContextMessages,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";

/** How many messages one scroll to the top loads. */
export const HISTORY_CHUNK = 12;

type Message = ReturnType<typeof sessionEntryToContextMessages>[number];
type AnyMessage = Message & { role: string; [k: string]: unknown };

/**
 * The entries of the current branch pi's chat leaves out: those before the latest
 * compaction's first kept entry (as pi's buildContextEntries). None without a compaction.
 */
export function earlierEntries(branch: readonly SessionEntry[]): SessionEntry[] {
	let at = -1;
	for (let i = 0; i < branch.length; i++) if (branch[i]!.type === "compaction") at = i;
	if (at < 0) return [];
	const firstKept = (branch[at] as { firstKeptEntryId?: string }).firstKeptEntryId;
	const kept = branch.findIndex((e, i) => i < at && e.id === firstKept);
	return branch.slice(0, kept >= 0 ? kept : at);
}

/** One shown message: a user prompt, an assistant turn (its tool calls with their results), … */
export interface HistoryUnit {
	message: AnyMessage;
	/** tool call id → its result, for an assistant message's calls */
	results: Map<string, AnyMessage>;
}

const userText = (m: AnyMessage): string => {
	const c = m.content as string | { type: string; text?: string }[] | undefined;
	if (typeof c === "string") return c;
	return (c ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
};

/** The messages to show, oldest first: what pi would draw for these entries. */
export function historyUnits(entries: readonly SessionEntry[]): HistoryUnit[] {
	const results = new Map<string, AnyMessage>();
	const units: HistoryUnit[] = [];
	for (const entry of entries) {
		let messages: AnyMessage[];
		try {
			messages = sessionEntryToContextMessages(entry) as AnyMessage[];
		} catch {
			continue;
		}
		for (const m of messages) {
			if (m.role === "toolResult") {
				if (typeof m.toolCallId === "string") results.set(m.toolCallId, m);
				continue;
			}
			if (m.role === "system") continue;
			if (m.role === "user" && !userText(m)) continue;
			if (m.role === "custom" && !m.display) continue;
			units.push({ message: m, results });
		}
	}
	return units;
}

export interface DrawOptions {
	tui: TUI;
	cwd: string;
	hideThinking: boolean;
	outputPad: number;
	toolsExpanded: boolean;
}

/** pi's built-in tools, for their renderers (an extension's own renderer is not reachable). */
const BUILT_IN: Record<string, (cwd: string) => unknown> = {
	read: createReadToolDefinition,
	bash: createBashToolDefinition,
	powershell: createPowerShellToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};
const builtIns = new Map<string, unknown>();
function builtInTool(name: string, cwd: string): unknown {
	const make = BUILT_IN[name];
	if (!make) return undefined;
	const key = `${name}\0${cwd}`;
	if (!builtIns.has(key)) {
		let def: unknown;
		try {
			def = make(cwd);
		} catch {}
		if (builtIns.size > 64) builtIns.clear();
		builtIns.set(key, def);
	}
	return builtIns.get(key);
}

/** pi's components for one message (as its chat draws them on a resume). */
export function drawUnit(u: HistoryUnit, o: DrawOptions): Component {
	const md = getMarkdownTheme();
	const box = new Container();
	const m = u.message as never as AnyMessage & Record<string, never>;
	switch (u.message.role) {
		case "user": {
			const text = userText(u.message);
			box.addChild(new Spacer(1));
			// a skill's invocation folds, and the user's own words follow it (as in pi)
			const skill = parseSkillBlock(text);
			if (skill) {
				const c = new SkillInvocationMessageComponent(skill, md, o.outputPad);
				c.setExpanded(o.toolsExpanded);
				box.addChild(c);
				if (skill.userMessage) {
					box.addChild(new Spacer(1));
					box.addChild(new UserMessageComponent(skill.userMessage, md, o.outputPad));
				}
			} else box.addChild(new UserMessageComponent(text, md, o.outputPad));
			break;
		}
		case "assistant": {
			box.addChild(new AssistantMessageComponent(m as never, o.hideThinking, md, undefined, o.outputPad));
			const content = (u.message.content as { type: string; id?: string; name?: string; arguments?: unknown }[] | undefined) ?? [];
			for (const c of content) {
				if (c.type !== "toolCall" || !c.id) continue;
				const tool = new ToolExecutionComponent(String(c.name), c.id, c.arguments, { showImages: false, outputPad: o.outputPad }, builtInTool(String(c.name), o.cwd) as never, o.tui, o.cwd);
				tool.setExpanded(o.toolsExpanded);
				const result = u.results.get(c.id);
				const stop = u.message.stopReason;
				if (stop === "aborted" || stop === "error") {
					tool.updateResult({ content: [{ type: "text", text: stop === "aborted" ? "Operation aborted" : String(u.message.errorMessage || "Error") }], isError: true });
				} else if (result) tool.updateResult(result as never);
				box.addChild(tool);
			}
			break;
		}
		case "bashExecution": {
			const b = new BashExecutionComponent(String(u.message.command ?? ""), o.tui, u.message.excludeFromContext === true, o.outputPad);
			if (typeof u.message.output === "string" && u.message.output) b.appendOutput(u.message.output);
			b.setComplete(
				u.message.exitCode as number | undefined,
				u.message.cancelled === true,
				u.message.truncated ? ({ truncated: true } as never) : undefined,
				u.message.fullOutputPath as string | undefined,
			);
			box.addChild(b);
			break;
		}
		case "custom": {
			const c = new CustomMessageComponent(m as never, undefined, md, o.outputPad);
			c.setExpanded(o.toolsExpanded);
			box.addChild(c);
			break;
		}
		case "compactionSummary": {
			box.addChild(new Spacer(1));
			const c = new CompactionSummaryMessageComponent(m as never, md, o.outputPad);
			c.setExpanded(o.toolsExpanded);
			box.addChild(c);
			break;
		}
		case "branchSummary": {
			box.addChild(new Spacer(1));
			const c = new BranchSummaryMessageComponent(m as never, md, o.outputPad);
			c.setExpanded(o.toolsExpanded);
			box.addChild(c);
			break;
		}
	}
	return box;
}

/** The part of pi's ScrollView this reads: where the view is; its scroll position is moved. */
export interface ScrollLike {
	readonly scrollTop: number;
	/** 0 before its first layout (its position means nothing yet) */
	readonly viewportHeight?: number;
	scrollTo(top: number, options?: { disableFollow?: boolean }): void;
}

/**
 * pi's transcript: the primary ScrollView under the TUI's layout root (fullscreen pi);
 * none for pi on the terminal's main screen.
 */
export function transcriptView(root: unknown): (ScrollLike & { children: Component[] }) | undefined {
	const seen = new Set<unknown>();
	const walk = (node: unknown, depth: number): (ScrollLike & { children: Component[] }) | undefined => {
		if (!node || typeof node !== "object" || depth > 8 || seen.has(node)) return undefined;
		seen.add(node);
		const n = node as { primary?: unknown; scrollTo?: unknown; scrollTop?: unknown; children?: unknown; entries?: unknown };
		if (n.primary === true && typeof n.scrollTo === "function" && typeof n.scrollTop === "number" && Array.isArray(n.children)) return n as never;
		const next: unknown[] = [];
		if (Array.isArray(n.entries)) for (const e of n.entries) next.push((e as { component?: unknown })?.component);
		if (Array.isArray(n.children)) next.push(...n.children);
		for (const c of next) {
			const found = walk(c, depth + 1);
			if (found) return found;
		}
		return undefined;
	};
	return walk(root, 0);
}

/**
 * Keep the view on the same lines when `delta` lines are put above them. pi lays the
 * transcript out after rendering it (the content is measured, then the position is
 * clamped to it), so the position is moved now, inside the render. A ScrollView without
 * that field (another pi) is left at the top: the loaded lines show from their start.
 */
function keepPlace(view: ScrollLike, delta: number): void {
	if (delta <= 0) return;
	const v = view as unknown as { currentScrollTop?: unknown };
	if (typeof v.currentScrollTop === "number") v.currentScrollTop = v.currentScrollTop + delta;
}

export interface HistoryDeps {
	view: () => ScrollLike | undefined;
	draw: (u: HistoryUnit) => Component;
	/** the line above the loaded messages: how many are left, or that this is the start */
	note: (left: number) => string;
	requestRender: () => void;
}

/** The earlier messages above pi's chat, loaded when the transcript is at its top. */
export class EarlierHistory implements Component {
	private units: HistoryUnit[] = [];
	private shown = 0;
	private drawn = new Map<HistoryUnit, Component>();
	private lookedAgain = false;

	private readonly deps: HistoryDeps;

	constructor(deps: HistoryDeps) {
		this.deps = deps;
	}

	/** A new session or branch, or another compaction: nothing loaded yet. */
	set(units: HistoryUnit[]): void {
		this.units = units;
		this.shown = 0;
		this.drawn.clear();
		this.lookedAgain = false;
	}

	get total(): number {
		return this.units.length;
	}

	get loaded(): number {
		return this.shown;
	}

	private lines(width: number): string[] {
		if (this.units.length === 0) return [];
		const out = [this.deps.note(this.units.length - this.shown)];
		for (let i = this.units.length - this.shown; i < this.units.length; i++) {
			const u = this.units[i]!;
			let c = this.drawn.get(u);
			if (!c) {
				try {
					c = this.deps.draw(u);
				} catch {
					c = { render: () => [], invalidate: () => {} };
				}
				this.drawn.set(u, c);
			}
			try {
				out.push(...c.render(width));
			} catch {}
		}
		return out;
	}

	render(width: number): string[] {
		const view = this.deps.view();
		// no transcript (pi leaving fullscreen prints its document): nothing, not a stale hint
		if (!view) return [];
		// not laid out yet (its first frame), or not at the top: as it is
		if (this.units.length === 0 || this.shown >= this.units.length || view.scrollTop > 0) return this.lines(width);
		if (view.viewportHeight === 0) {
			// laid out after this render: look again once (a short chat fills the screen then)
			if (!this.lookedAgain) {
				this.lookedAgain = true;
				setImmediate(() => this.deps.requestRender());
			}
			return this.lines(width);
		}
		// at the top: the next older ones go above what is shown
		const before = this.lines(width).length;
		this.shown = Math.min(this.units.length, this.shown + HISTORY_CHUNK);
		const lines = this.lines(width);
		keepPlace(view, lines.length - before);
		// once more: a screen not full yet loads on until it is (or the start is shown)
		setImmediate(() => this.deps.requestRender());
		return lines;
	}

	invalidate(): void {
		for (const c of this.drawn.values()) c.invalidate?.();
	}
}

/**
 * M53: in a session pi-roost runs, the conversation from before the latest compaction
 * loads above the chat as the transcript is scrolled up (fullscreen pi; on the main
 * screen there is no transcript view to put it in).
 */
export function registerEarlierHistory(pi: ExtensionAPI): void {
	let tui: TUI | undefined;
	let ctxNow: ExtensionContext | undefined;
	let history: EarlierHistory | undefined;
	let mountedIn: { children: Component[] } | undefined;
	let muted = (s: string) => s;

	const unmount = () => {
		if (mountedIn && history) {
			const at = mountedIn.children.indexOf(history);
			if (at >= 0) mountedIn.children.splice(at, 1);
		}
		mountedIn = undefined;
	};
	// pi's document is [header, loaded resources, chat]: the history goes just above the chat
	const mount = () => {
		if (!tui || !history) return;
		// inside pi's layout: whatever is found, nothing here may throw
		try {
			const view = transcriptView((tui as unknown as { layoutRoot?: unknown }).layoutRoot);
			const doc = view?.children[0] as { children?: Component[] } | undefined;
			if (!doc || !Array.isArray(doc.children)) return;
			if (doc === mountedIn && doc.children.includes(history)) return;
			// pi 1.5.0's document: [header, loaded resources, chat], the chat a container
			const chat = doc.children.at(-1) as { children?: unknown } | undefined;
			if (doc.children.length < 2 || !Array.isArray(chat?.children)) return;
			unmount();
			doc.children.splice(doc.children.length - 1, 0, history);
			mountedIn = doc as { children: Component[] };
			tui.requestRender();
		} catch {}
	};
	const refresh = (ctx: ExtensionContext) => {
		ctxNow = ctx;
		if (!history) return;
		let units: HistoryUnit[] = [];
		try {
			units = historyUnits(earlierEntries(ctx.sessionManager.getBranch()));
		} catch {}
		history.set(units);
		tui?.requestRender();
	};

	pi.on("session_start", (_event, ctx) => {
		unmount();
		tui = undefined;
		if (!ctx.hasUI) return;
		// a widget that draws nothing, for the TUI it is given (the factory runs now); it mounts
		// the history once pi's fullscreen layout is up
		ctx.ui.setWidget(
			"pi-roost-history",
			(t, theme) => {
				tui = t;
				muted = (s) => theme.fg("muted", s);
				return {
					render: () => {
						mount();
						return [];
					},
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
		if (!tui) return;
		const settings = (() => {
			try {
				return pi.getSettings() as { hideThinkingBlock?: boolean; outputPad?: number };
			} catch {
				return {};
			}
		})();
		history = new EarlierHistory({
			view: () => (tui ? transcriptView((tui as unknown as { layoutRoot?: unknown }).layoutRoot) : undefined),
			draw: (u) =>
				drawUnit(u, {
					tui: tui!,
					cwd: ctxNow?.cwd ?? process.cwd(),
					hideThinking: settings.hideThinkingBlock === true,
					outputPad: settings.outputPad ?? 1,
					toolsExpanded: (() => {
						try {
							return ctxNow?.ui.getToolsExpanded() ?? false;
						} catch {
							return false;
						}
					})(),
				}),
			note: (left) =>
				muted(
					left > 0
						? `  ↑ ${left} earlier message${left === 1 ? "" : "s"} (before compaction): scroll up to load`
						: "  ── the start of the session ──",
				),
			requestRender: () => tui?.requestRender(),
		});
		refresh(ctx);
	});
	pi.on("session_compact", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", () => {
		unmount();
		history = undefined;
		tui = undefined;
		ctxNow = undefined;
	});
}
