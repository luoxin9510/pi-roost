/**
 * M33: what the agent view needs from pi, for a hub inside pi (openAgentView) and for the
 * standalone one (`pi-roost hub`): how pi jobs are launched and resumed, models, presets,
 * agents and profiles. What the host pi knows (its models, its session) comes in `h`.
 */
import { join } from "node:path";
import { type SessionInfo, SessionManager, SessionSelectorComponent, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentViewOptions } from "../../hub/agent-view.ts";
import { discoverAgents } from "../../lib/agents.ts";
import { CONCIERGE_DEFAULTS, CONCIERGE_NAME, CONCIERGE_ROLE_ENV } from "../../lib/concierge.ts";
import { envPolicy, loadConfig, loadUserConfig, saveUserConfig, saveUserPreset } from "../../lib/config.ts";
import { buildLaunch, buildProfileLaunch, fallbackName, isolationDefault, prepareIsolation, workerEnv } from "../../lib/dispatch.ts";
import { notifySequence, notifyText, resolveNotify } from "../../lib/job-events.ts";
import { readWriterLock } from "../../lib/locks.ts";
import { RUN_SLOT } from "../../lib/schedule.ts";

export interface PiHost {
	/** Directory new jobs start in. */
	cwd: string;
	/** The command line jobs repeat (pi's CLI, its -e extensions and model flags). */
	argv: string[];
	commands: () => { name: string; source: string }[];
	/** Models with credentials, "provider/id". */
	models: () => string[];
	scopedModels: () => string[];
	/** The session the host pi is in (it cannot be resumed in the background). */
	currentSession: () => string | undefined;
	sessionDir: () => string | undefined;
}

export type PiHubOptions = Omit<AgentViewOptions, "tui" | "theme" | "setTitle" | "done">;

export function piHubOptions(h: PiHost): PiHubOptions {
	const dispatchCwd = h.cwd;
	const config = loadConfig(dispatchCwd);
	return {
		cwd: dispatchCwd,
		worktreeDefault: isolationDefault(config.worktreeIsolation, false),
		launch: (task, o = {}) => {
			const name = o.name ?? fallbackName(task);
			// M10: only a new session can start in a worktree; a resumed one keeps its cwd
			const fresh = !o.sessionFile;
			const want = fresh && (o.worktree ?? isolationDefault(config.worktreeIsolation, false));
			// M26: a fan-out outside a repository shares the directory (said in the note)
			const iso = prepareIsolation(o.cwd ?? dispatchCwd, name, want, fresh && o.worktree === true && !o.fanout);
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
				argv: h.argv,
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
		// M39: each run gets its own session in this directory's session folder, as pi names one
		scheduleLaunch: (task, o) => {
			const dir = SessionManager.create(o.cwd).getSessionDir();
			return buildLaunch({
				task,
				cwd: o.cwd,
				sessionFile: join(dir, `${RUN_SLOT}.jsonl`),
				name: fallbackName(task),
				origin: "dispatch",
				argv: h.argv,
				execPath: process.execPath,
				env: process.env,
				...envPolicy(config),
				piVersion: VERSION,
				model: o.model ?? config.dispatchModel,
				thinking: o.thinking ?? config.dispatchThinking,
			});
		},
		// M44: the concierge: a pi session in this directory on the configured cheap model, no task
		// (the daemon wakes it); its role is said in its environment
		conciergeLaunch: () => {
			const cfg = loadUserConfig().concierge ?? CONCIERGE_DEFAULTS;
			const sessionFile = SessionManager.create(dispatchCwd).getSessionFile();
			if (!sessionFile) throw new Error("could not allocate a session file");
			const launch = buildLaunch({
				task: "",
				cwd: dispatchCwd,
				sessionFile,
				name: CONCIERGE_NAME,
				origin: "dispatch",
				argv: h.argv,
				execPath: process.execPath,
				env: process.env,
				...envPolicy(config),
				piVersion: VERSION,
				model: cfg.model,
				thinking: cfg.thinking,
			});
			return { ...launch, env: { ...launch.env, [CONCIERGE_ROLE_ENV]: "concierge" } };
		},
		// M30: read again each time (an edited roost.json counts at once)
		profiles: () => Object.keys(loadConfig(dispatchCwd).agentProfiles ?? {}),
		launchProfile: (profile, task, o) => {
			const conf = loadConfig(dispatchCwd);
			const def = conf.agentProfiles?.[profile];
			if (!def) throw new Error(`no agent profile ${profile} in your roost.json`);
			const name = fallbackName(task);
			const want = o.worktree ?? isolationDefault(conf.worktreeIsolation, false);
			const iso = prepareIsolation(o.cwd, name, want, o.worktree === true);
			const launch = buildProfileLaunch({
				name,
				profile,
				def,
				task,
				cwd: iso.cwd,
				env: process.env,
				...envPolicy(conf),
				...(o.model ? { model: o.model } : {}),
				...(o.thinking ? { thinking: o.thinking } : {}),
			});
			return { ...launch, ...(iso.worktree ? { worktree: iso.worktree, discard: iso.discard } : {}), ...(iso.note ? { note: iso.note } : {}) };
		},
		agents: () => discoverAgents(dispatchCwd),
		// M27: read again each time (a save from another hub, or an edited file)
		presets: () => loadConfig(dispatchCwd).presets ?? {},
		savePreset: saveUserPreset,
		userPreset: (name) => name in (loadUserConfig().presets ?? {}),
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
		commands: h.commands,
		models: h.models,
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
				// this pi's session directory (a --session-dir too)
				(onProgress, signal) => SessionManager.list(cwd, h.sessionDir(), onProgress, signal).then(keep),
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
				h.currentSession(),
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
			return {
				render: (width: number) => selector.render(width),
				handleInput: (data: string) => selector.handleInput(data),
				get focused() {
					return selector.focused;
				},
				set focused(v: boolean) {
					selector.focused = v;
				},
				// its session lists may still be loading
				dispose: () => (selector as unknown as { cancelLoads?: () => void }).cancelLoads?.(),
			};
		},
		defaultModel: () => config.dispatchModel ?? launchDefaultModel(dispatchCwd, h.argv),
		currentSession: h.currentSession,
		scopedModels: h.scopedModels,
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
	};
}

/**
 * M23: what a session started from here runs without a chosen model: the hub's own
 * `--model` (new sessions inherit its command line), else pi's default from settings.
 */
let defaultCache: { cwd: string; at: number; value: string | undefined } | undefined;
function launchDefaultModel(cwd: string, argv: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--model" && argv[i + 1]) return argv[i + 1];
		if (argv[i]?.startsWith("--model=")) return argv[i]!.slice("--model=".length);
	}
	// read on render: a few seconds' cache
	if (defaultCache && defaultCache.cwd === cwd && Date.now() - defaultCache.at < 5000) return defaultCache.value;
	let value: string | undefined;
	try {
		const s = SettingsManager.create(cwd);
		const model = s.getDefaultModel();
		const provider = s.getDefaultProvider();
		value = model ? (model.includes("/") || !provider ? model : `${provider}/${model}`) : undefined;
	} catch {
		value = undefined;
	}
	defaultCache = { cwd, at: Date.now(), value };
	return value;
}
