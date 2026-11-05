import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../lib/config.ts";
import { piHubOptions } from "./hub-options.ts";
import { AgentView } from "../../hub/agent-view.ts";

// Process-wide, not per module copy: a session switch may load this module again.
const VIEWS = Symbol.for("pi-roost.openViews");
const OPENS = Symbol.for("pi-roost.viewOpens");
const g = globalThis as { [VIEWS]?: number; [OPENS]?: number };

/** How many times an agent view has been opened in this process. */
export const agentViewOpens = () => g[OPENS] ?? 0;

// The pi instance's slash commands (DI-5), set by the extension: openAgentView only has a ctx.
const COMMANDS = Symbol.for("pi-roost.commands");
type CommandSource = () => { name: string; source: string }[];
export function setCommandSource(fn: CommandSource | undefined): void {
	(globalThis as { [COMMANDS]?: CommandSource })[COMMANDS] = fn;
}
const commandSource = () => (globalThis as { [COMMANDS]?: CommandSource })[COMMANDS];

/** Whether an agent view is on screen in this process (the ← shortcut stays out of its way). */
export const agentViewOpen = () => (g[VIEWS] ?? 0) > 0;

export interface OpenViewOptions {
	cwdFilter?: string;
	origin?: string;
	banner?: string;
}

// covers the conversation; percentages follow terminal resizes
const FULLSCREEN = { width: "100%", maxHeight: "100%", row: 0, col: 0 } as const;

/** Show the agent view (full screen, or in place of the editor) until the user leaves it. */
export async function openAgentView(ctx: ExtensionContext, opts: OpenViewOptions = {}): Promise<void> {
	if (!ctx.hasUI) return;
	const dispatchCwd = opts.cwdFilter ?? ctx.cwd;
	const config = loadConfig(dispatchCwd);
	g[VIEWS] = (g[VIEWS] ?? 0) + 1;
	g[OPENS] = agentViewOpens() + 1;
	try {
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const view = new AgentView({
				tui,
				theme,
				cwdFilter: opts.cwdFilter,
				origin: opts.origin,
				highlightId: opts.origin,
				banner: opts.banner,
				...piHubOptions({
					cwd: dispatchCwd,
					argv: process.argv,
					commands: () => commandSource()?.() ?? [],
					models: () => {
						try {
							return ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
						} catch {
							return [];
						}
					},
					scopedModels: () => {
						try {
							return ctx.scopedModels.map((m) => `${m.model.provider}/${m.model.id}`);
						} catch {
							return [];
						}
					},
					currentSession: () => {
						try {
							return ctx.sessionManager.getSessionFile();
						} catch {
							return undefined;
						}
					},
					sessionDir: () => sessionDirOf(ctx),
				}),
				setTitle: (title) => ctx.ui.setTitle(title),
				done: () => done(),
			});
			void view.start();
			return view;
		}, config.fullscreen ? { overlay: true, overlayOptions: FULLSCREEN } : undefined);
	} finally {
		g[VIEWS] = (g[VIEWS] ?? 1) - 1;
	}
}

/** M23: the session directory of this pi (a --session-dir included), if it can tell. */
function sessionDirOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionDir();
	} catch {
		return undefined;
	}
}

