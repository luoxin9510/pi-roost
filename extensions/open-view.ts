import { type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../lib/config.ts";
import { buildLaunch, fallbackName } from "../lib/dispatch.ts";
import { AgentView } from "./agent-view.ts";

let openViews = 0;

/** Whether an agent view is on screen in this process (the ← shortcut stays out of its way). */
export const agentViewOpen = () => openViews > 0;

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
	openViews++;
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
				done: () => done(),
			});
			void view.start();
			return view;
		});
	} finally {
		openViews--;
	}
}
