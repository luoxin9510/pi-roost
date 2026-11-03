import { type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveUserConfig } from "../lib/config.ts";
import { allowListedEnv, buildLaunch, fallbackName } from "../lib/dispatch.ts";
import { readWriterLock } from "../lib/locks.ts";
import { notifySequence, notifyText, resolveNotify } from "../lib/job-events.ts";
import { AgentView } from "./agent-view.ts";

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
				launch: (task, o = {}) => {
					const cwd = o.cwd ?? dispatchCwd;
					const sessionFile = o.sessionFile ?? SessionManager.create(cwd).getSessionFile();
					if (!sessionFile) throw new Error("could not allocate a session file");
					return buildLaunch({
						task,
						cwd,
						sessionFile,
						name: o.name ?? fallbackName(task),
						origin: o.origin ?? "dispatch",
						argv: process.argv,
						execPath: process.execPath,
						env: process.env,
						extraEnv: config.envAllowList,
						piVersion: VERSION,
						// a resumed session keeps its own model unless the view chose one
						model: o.model ?? (o.origin === "adopt" ? undefined : config.dispatchModel),
						thinking: o.thinking ?? (o.origin === "adopt" ? undefined : config.dispatchThinking),
					});
				},
				launchShell: (command, cwd) => ({
					kind: "shell" as const,
					cwd,
					sessionFile: "",
					command: [process.env.SHELL || "/bin/sh", "-lc", command],
					env: allowListedEnv(process.env, config.envAllowList),
					name: `! ${fallbackName(command)}`,
					origin: "dispatch" as const,
				}),
				commands: () => commandSource()?.() ?? [],
				models: () => {
					try {
						return ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
					} catch {
						return [];
					}
				},
				resumable: async (cwd) =>
					// a session another pi is writing cannot be run here (writer lock)
					(await SessionManager.list(cwd)).filter((s) => !readWriterLock(s.path)).map((s) => ({
						path: s.path,
						name: s.name || fallbackName(s.firstMessage || "session"),
						cwd: s.cwd,
						modified: s.modified.getTime(),
					})),
				setTitle: (title) => ctx.ui.setTitle(title),
				groupBy: config.groupBy,
				onGroupBy: (groupBy) => saveUserConfig({ groupBy }),
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
