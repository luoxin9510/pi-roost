// Building a background job's launch request from a foreground pi process.
import { isAbsolute, resolve } from "node:path";
import { DaemonError } from "./client.ts";
import { SESSION_RESTORED_FLAGS, taskArg, withoutFlags } from "./store.ts";
import { type AgentDef, agentArgs } from "./agents.ts";
import { createWorktree, discardWorktree, type WorktreeInfo, WorktreeError } from "./worktree.ts";

const VALUE_FLAGS = new Set(["-e", "--extension", "--model", "--provider", "--thinking", "--session-dir"]);
const BOOL_FLAGS = new Set(["-ne", "--no-extensions", "--offline"]);
const PATH_FLAGS = new Set(["-e", "--extension", "--session-dir"]);

/** pi arguments a worker must repeat to load the same extensions and model. */
export function passthroughArgs(argv: string[], cwd: string): string[] {
	const abs = (name: string, value: string) =>
		PATH_FLAGS.has(name) && !value.startsWith("builtin:") && !isAbsolute(value) ? resolve(cwd, value) : value;
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		if (BOOL_FLAGS.has(arg)) out.push(arg);
		else if (VALUE_FLAGS.has(name)) {
			if (eq !== -1) out.push(`${name}=${abs(name, arg.slice(eq + 1))}`);
			else if (i + 1 < argv.length) out.push(arg, abs(name, argv[++i]!));
		}
	}
	return out;
}

const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "COLORTERM", "TMPDIR"];
const ENV_ALLOW_ANY_CASE = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

/** Environment carried into a worker (PRD envAllowList defaults plus login basics). */
export function allowListedEnv(env: NodeJS.ProcessEnv, extra: string[] = []): Record<string, string> {
	const out: Record<string, string> = {};
	const keep = (key: string) =>
		ENV_ALLOW.includes(key) ||
		extra.includes(key) ||
		key.startsWith("LC_") ||
		ENV_ALLOW_ANY_CASE.includes(key.toUpperCase());
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && keep(key)) out[key] = value;
	}
	return out;
}

/** DI-9 fallback name: the first six words of the prompt. */
export function fallbackName(task: string): string {
	const words = task.trim().split(/\s+/).slice(0, 6).join(" ");
	return words.length > 60 ? `${words.slice(0, 59)}…` : words;
}

export interface LaunchInput {
	/** First prompt; empty starts the worker idle on its session. */
	task: string;
	cwd: string;
	sessionFile: string;
	name: string;
	origin: "bg" | "dispatch" | "adopt" | "fork";
	/** The dispatching pi's own argv (process.argv), for extensions and model flags. */
	argv: string[];
	execPath: string;
	env: NodeJS.ProcessEnv;
	piVersion?: string;
	/** Extra variable names to carry (settings envAllowList). */
	extraEnv?: string[];
	/** Overrides from the agent view's /model and /thinking (DI-4). */
	model?: string;
	thinking?: string;
	/** M10: the worktree made for it (prepareIsolation); cwd is inside it. */
	worktree?: WorktreeInfo;
	/** M18: run as this agent (its model, thinking, tools and system prompt). */
	agent?: AgentDef;
}

/** The daemon dispatch request for a new background pi running `task`. */
export function buildLaunch(input: LaunchInput) {
	const pass = passthroughArgs(input.argv.slice(2), process.cwd());
	const withoutFlag = (args: string[], flag: string) => {
		const out: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === flag) i++;
			else if (!args[i]!.startsWith(`${flag}=`)) out.push(args[i]!);
		}
		return out;
	};
	// M8: moving or forking a conversation hands over a session that already records its
	// model and thinking level (maybe switched since this pi started): its own flags would
	// override them. Explicit choices below still win.
	let args = input.origin === "adopt" || input.origin === "fork" ? withoutFlags(pass, SESSION_RESTORED_FLAGS, 0) : pass;
	// M18: the agent's frontmatter over this pi's own flags; an explicit choice still wins
	if (input.agent) {
		for (const f of ["--model", "--thinking", "--tools", "--system-prompt", "--append-system-prompt"]) {
			if (agentArgs(input.agent).includes(f)) args = withoutFlag(args, f);
		}
		args = [...args, ...agentArgs(input.agent)];
	}
	if (input.model) args = [...withoutFlag(args, "--model"), "--model", input.model];
	if (input.thinking) args = [...withoutFlag(args, "--thinking"), "--thinking", input.thinking];
	return {
		cwd: input.cwd,
		sessionFile: input.sessionFile,
		// "--" so a task that starts with "-" is not read as a flag
		// pi reads a message argument starting with @ as a file to attach, even after --
		command: [
			input.execPath,
			input.argv[1]!,
			"--session",
			input.sessionFile,
			...args,
			...(input.task ? ["--", taskArg(input.task)] : []),
		],
		env: allowListedEnv(input.env, input.extraEnv),
		name: input.name,
		origin: input.origin,
		...(input.model ? { model: input.model } : {}),
		...(input.thinking ? { thinking: input.thinking } : {}),
		...(input.agent ? { agent: input.agent.name } : {}),
		...(input.agent?.model && !input.model ? { model: input.agent.model } : {}),
		...(input.agent?.thinking && !input.thinking ? { thinking: input.agent.thinking } : {}),
		...(input.piVersion ? { piVersion: input.piVersion } : {}),
		...(input.worktree ? { worktree: input.worktree } : {}),
	};
}

export interface Isolation {
	/** Where the session starts. */
	cwd: string;
	worktree?: WorktreeInfo;
	/** For the user or the spawning agent: uncommitted changes left behind, or why it is not isolated. */
	note?: string;
	/** Undo after a dispatch that never reached the daemon or that it refused (see refusedByDaemon). */
	discard: () => void;
}

/**
 * M10: whether a dispatch error means no session started, so its worktree may go. A
 * dropped connection or a timeout may come after the daemon started it: keep the worktree.
 */
export function refusedByDaemon(err: unknown): boolean {
	return err instanceof DaemonError && typeof err.code === "string" && err.code !== "closed";
}

/**
 * M10: a worktree for a new session when one is wanted. `explicit`: asked for by this
 * dispatch (an error outside a repository); otherwise a config default that falls back.
 */
export function prepareIsolation(cwd: string, name: string, want: boolean, explicit: boolean): Isolation {
	const none = (note?: string): Isolation => ({ cwd, ...(note ? { note } : {}), discard: () => {} });
	if (!want) return none();
	try {
		const w = createWorktree(cwd, name);
		const worktree: WorktreeInfo = { path: w.path, branch: w.branch, repo: w.repo, base: w.base };
		return {
			cwd: w.cwd,
			worktree,
			...(w.sourceDirty ? { note: `uncommitted changes in ${w.repo} are not in its worktree` } : {}),
			discard: () => discardWorktree(worktree),
		};
	} catch (err) {
		if (explicit || !(err instanceof WorktreeError)) throw err;
		return none(`no worktree: ${err.message}`);
	}
}

/** M10: whether a new session gets a worktree by default. */
export function isolationDefault(setting: "off" | "children" | "all", child: boolean): boolean {
	return setting === "all" || (setting === "children" && child);
}
