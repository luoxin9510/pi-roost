import { type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../lib/config.ts";
import { buildLaunch, fallbackName } from "../lib/dispatch.ts";
import { notifySequence, notifyText, resolveNotify } from "../lib/job-events.ts";
import { AgentView } from "./agent-view.ts";

// Process-wide, not per module copy: a session switch may load this module again.
const VIEWS = Symbol.for("pi-roost.openViews");
const OPENS = Symbol.for("pi-roost.viewOpens");
const g = globalThis as { [VIEWS]?: number; [OPENS]?: number };

/** How many times an agent view has been opened in this process. */
export const agentViewOpens = () => g[OPENS] ?? 0;

/** Whether an agent view is on screen in this process (the ← shortcut stays out of its way). */
export const agentViewOpen = () => (g[VIEWS] ?? 0) > 0;

export interface OpenViewOptions {
	cwdFilter?: string;
	origin?: string;
	banner?: string;
}

/** Show the agent view in place of the editor until the user leaves it. */
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
				cwd: dispatchCwd,
				cwdFilter: opts.cwdFilter,
				origin: opts.origin,
				highlightId: opts.origin,
				banner: opts.banner,
				launch: (task) => {
					const sessionFile = SessionManager.create(dispatchCwd).getSessionFile();
					if (!sessionFile) throw new Error("could not allocate a session file");
					return buildLaunch({
						task,
						cwd: dispatchCwd,
						sessionFile,
						name: fallbackName(task),
						origin: "dispatch",
						argv: process.argv,
						execPath: process.execPath,
						env: process.env,
						extraEnv: config.envAllowList,
						piVersion: VERSION,
						model: config.dispatchModel,
						thinking: config.dispatchThinking,
					});
				},
				setTitle: (title) => ctx.ui.setTitle(title),
				notify: (row, kind) => {
					const { title, body } = notifyText(row, kind);
					const seq = notifySequence(resolveNotify(config.notify), title, body);
					if (seq) process.stdout.write(seq);
				},
				done: () => done(),
			});
			void view.start();
			return view;
		});
	} finally {
		g[VIEWS] = (g[VIEWS] ?? 1) - 1;
	}
}
