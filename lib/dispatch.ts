// Building a background job's launch request from a foreground pi process.
import { isAbsolute, resolve } from "node:path";

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
	let args = pass;
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
			...(input.task ? ["--", input.task.startsWith("@") ? ` ${input.task}` : input.task] : []),
		],
		env: allowListedEnv(input.env, input.extraEnv),
		name: input.name,
		origin: input.origin,
		...(input.model ? { model: input.model } : {}),
		...(input.thinking ? { thinking: input.thinking } : {}),
		...(input.piVersion ? { piVersion: input.piVersion } : {}),
	};
}
