// NT-3: programmatic access for other extensions and scripts.
//
//   import { spawn, list, attach } from "pi-roost/api";
//   const { id } = await spawn({ task: "run the regression", cwd: process.cwd() });
//
// Everything goes through the per-user daemon (started on demand).
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { attachToHost, type DetachReason } from "./attach.ts";
import { join } from "node:path";
import { DaemonClient, packageRoot } from "./client.ts";
import { buildLaunch, fallbackName, prepareIsolation, refusedByDaemon } from "./dispatch.ts";
import { envPolicy, loadConfig } from "./config.ts";
import { hostSocketPath } from "./paths.ts";
import type { JobRow } from "./protocol.ts";
import { ensureLive } from "./resume.ts";

export type { JobRow } from "./protocol.ts";

export interface SpawnOptions {
	/** The first prompt (≥ 1 character). */
	task: string;
	cwd: string;
	name?: string;
	/** "provider/id" */
	model?: string;
	thinking?: string;
	/** Names always carried into the worker (M20: it inherits this process's environment anyway; these pass envDenyList). */
	env?: string[];
	/** The pi to run: defaults to the one running this code (process.argv[1]). */
	piCli?: string;
	/**
	 * Load pi-roost into the worker with -e. Workers normally get it from your installed
	 * pi packages; set this when pi-roost is not installed (a checkout, tests).
	 */
	loadExtension?: boolean;
	/** M10: run in its own git worktree and branch (fails outside a git repository). */
	worktree?: boolean;
}

async function withClient<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T> {
	const c = await DaemonClient.connectOrStart();
	try {
		return await fn(c);
	} finally {
		c.close();
	}
}

/** Start a background pi session; resolves once the daemon has started it. */
export async function spawn(opts: SpawnOptions): Promise<{ id: string; name: string; worktree?: { path: string; branch: string } }> {
	const task = opts.task.trim();
	if (!task) throw new Error("task is empty");
	const cli = opts.piCli ?? process.argv[1];
	// called from a plain script, argv[1] is that script: running it again as the worker would recurse
	if (!cli || (!opts.piCli && !/(^|[/\\])(pi|cli\.js|pi\.js)$/.test(cli) && !cli.includes("pi-coding-agent"))) {
		throw new Error("pass piCli (the path of pi's cli) when spawn is not called from inside pi");
	}
	const name = opts.name ?? fallbackName(task);
	const iso = prepareIsolation(opts.cwd, name, opts.worktree === true, true);
	const sessionFile = SessionManager.create(iso.cwd).getSessionFile();
	if (!sessionFile) {
		iso.discard();
		throw new Error("could not allocate a session file");
	}
	const argv = [
		process.argv[0] ?? process.execPath,
		cli,
		...(opts.loadExtension ? ["-e", join(packageRoot(), "extensions", "index.ts")] : []),
	];
	try {
		const r = await withClient((c) =>
			c.request(
				"dispatch",
				buildLaunch({
					task,
					cwd: iso.cwd,
					sessionFile,
					name,
					origin: "dispatch",
					argv,
					execPath: process.execPath,
					env: process.env,
					// the user's environment settings; opts.env names always go
					...(() => {
						const p = envPolicy(loadConfig(iso.cwd));
						return { ...p, extraEnv: [...p.extraEnv, ...(opts.env ?? [])] };
					})(),
					model: opts.model,
					thinking: opts.thinking,
					worktree: iso.worktree,
				}),
			),
		);
		return iso.worktree ? { ...r, worktree: { path: iso.worktree.path, branch: iso.worktree.branch } } : r;
	} catch (err) {
		if (refusedByDaemon(err)) iso.discard();
		throw err;
	}
}

/** Background sessions, newest first; `all` includes long-finished ones. */
export function list(opts: { cwd?: string; all?: boolean } = {}): Promise<JobRow[]> {
	return withClient(async (c) => (await c.request("list", { cwd: opts.cwd, all: opts.all })).jobs);
}

/**
 * Hand this process's terminal to a session until it detaches (Ctrl+Z, or ← on its
 * empty prompt). An ended session is started again first. Needs a TTY.
 */
export async function attach(id: string): Promise<DetachReason> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("attach needs a terminal");
	await withClient(async (c) => {
		const row = (await c.request("list", { all: true })).jobs.find((j) => j.id === id);
		if (!row) throw new Error(`no job ${id}`);
		await ensureLive(c, row, process.stdout);
	});
	return attachToHost(hostSocketPath(id), { stdin: process.stdin, stdout: process.stdout });
}
