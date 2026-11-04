import { discoverAgents } from "../lib/agents.ts";
import { type ExtensionContext, type SessionInfo, SessionManager, SessionSelectorComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { envPolicy, loadConfig, saveUserConfig } from "../lib/config.ts";
import { buildLaunch, workerEnv, fallbackName, isolationDefault, prepareIsolation } from "../lib/dispatch.ts";
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
				cwd: dispatchCwd,
				cwdFilter: opts.cwdFilter,
				origin: opts.origin,
				highlightId: opts.origin,
				banner: opts.banner,
				worktreeDefault: isolationDefault(config.worktreeIsolation, false),
				launch: (task, o = {}) => {
					const name = o.name ?? fallbackName(task);
					// M10: only a new session can start in a worktree; a resumed one keeps its cwd
					const fresh = !o.sessionFile;
					const want = fresh && (o.worktree ?? isolationDefault(config.worktreeIsolation, false));
					const iso = prepareIsolation(o.cwd ?? dispatchCwd, name, want, fresh && o.worktree === true);
					const cwd = iso.cwd;
					const sessionFile = o.sessionFile ?? SessionManager.create(cwd).getSessionFile();
					if (!sessionFile) {
						iso.discard();
						throw new Error("could not allocate a session file");
					}
					const launch = buildLaunch({
						task,
						cwd,
						sessionFile,
						name,
						origin: o.origin ?? "dispatch",
						argv: process.argv,
						execPath: process.execPath,
						env: process.env,
						...envPolicy(config),
						piVersion: VERSION,
						// a resumed session keeps its own model unless the view chose one
						// (an agent's own model and thinking level over the configured defaults)
						model: o.model ?? (o.origin === "adopt" || o.agent?.model ? undefined : config.dispatchModel),
						thinking: o.thinking ?? (o.origin === "adopt" || o.agent?.thinking ? undefined : config.dispatchThinking),
						...(o.agent ? { agent: o.agent } : {}),
					});
					return { ...launch, ...(iso.worktree ? { worktree: iso.worktree, discard: iso.discard } : {}), ...(iso.note ? { note: iso.note } : {}) };
				},
				agents: () => discoverAgents(dispatchCwd),
				...(config.dispatchAgent ? { defaultAgent: config.dispatchAgent } : {}),
				launchShell: (command, cwd) => ({
					kind: "shell" as const,
					cwd,
					sessionFile: "",
					command: [process.env.SHELL || "/bin/sh", "-lc", command],
					env: workerEnv(process.env, envPolicy(config)),
					...(config.inheritEnv && config.workspaceEnv !== "off" ? { workspaceEnv: config.workspaceEnv } : {}),
					...(config.envDenyList.length ? { envDeny: config.envDenyList, ...(config.envAllowList.length ? { envForce: config.envAllowList } : {}) } : {}),
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
				// M23: pi's own /resume list: search, this directory or all of them, sort
				sessionSelector: ({ cwd, onSelect, onCancel, requestRender, busy }) => {
					const seen = new Map<string, SessionInfo>();
					const keep = (list: SessionInfo[]) => {
						for (const s of list) seen.set(s.path, s);
						return list;
					};
					const selector = new SessionSelectorComponent(
						(onProgress, signal) => SessionManager.list(cwd, undefined, onProgress, signal).then(keep),
						(onProgress, signal) => SessionManager.listAll(onProgress, signal).then(keep),
						(path) => {
							const s = seen.get(path);
							onSelect({
								path,
								name: s?.name || fallbackName(s?.firstMessage || "session"),
								cwd: s?.cwd || cwd,
								modified: s ? s.modified.getTime() : Date.now(),
							});
						},
						onCancel,
						onCancel,
						requestRender,
						undefined,
						ctx.sessionManager.getSessionFile(),
					);
					// a session a background job or another pi is writing is never deleted from here
					const list = selector.getSessionList() as unknown as {
						onDeleteSession?: (path: string) => Promise<void>;
						onError?: (message: string) => void;
					};
					const remove = list.onDeleteSession;
					list.onDeleteSession = async (path) => {
						if (busy(path) || readWriterLock(path)) {
							list.onError?.("in use by a running session: stop it first");
							return;
						}
						await remove?.(path);
					};
					return selector;
				},
				defaultModel: () => config.dispatchModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				scopedModels: () => {
					try {
						return ctx.scopedModels.map((m) => `${m.model.provider}/${m.model.id}`);
					} catch {
						return [];
					}
				},
				setTitle: (title) => ctx.ui.setTitle(title),
				groupBy: config.groupBy,
				onGroupBy: (groupBy) => saveUserConfig({ groupBy }),
				notify: (row, kind) => {
					const { title, body } = notifyText(row, kind);
					const seq = notifySequence(resolveNotify(config.notify), title, body);
					if (seq) process.stdout.write(seq);
				},
				fullscreen: config.fullscreen,
				rowDetails: config.rowDetails,
				subagents: config.agentViewSubagents,
				done: () => done(),
			});
			void view.start();
			return view;
		}, config.fullscreen ? { overlay: true, overlayOptions: FULLSCREEN } : undefined);
	} finally {
		g[VIEWS] = (g[VIEWS] ?? 1) - 1;
	}
}
