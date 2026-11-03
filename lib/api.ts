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
import { buildLaunch, fallbackName } from "./dispatch.ts";
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
	/** Environment variable names to carry into the worker besides the defaults. */
	env?: string[];
	/** The pi to run: defaults to the one running this code (process.argv[1]). */
	piCli?: string;
	/**
	 * Load pi-roost into the worker with -e. Workers normally get it from your installed
	 * pi packages; set this when pi-roost is not installed (a checkout, tests).
	 */
	loadExtension?: boolean;
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
export function spawn(opts: SpawnOptions): Promise<{ id: string; name: string }> {
	const task = opts.task.trim();
	if (!task) return Promise.reject(new Error("task is empty"));
	const sessionFile = SessionManager.create(opts.cwd).getSessionFile();
	if (!sessionFile) return Promise.reject(new Error("could not allocate a session file"));
	const argv = [
		process.argv[0] ?? process.execPath,
		opts.piCli ?? process.argv[1] ?? "pi",
		...(opts.loadExtension ? ["-e", join(packageRoot(), "extensions", "index.ts")] : []),
	];
	return withClient((c) =>
		c.request(
			"dispatch",
			buildLaunch({
				task,
				cwd: opts.cwd,
				sessionFile,
				name: opts.name ?? fallbackName(task),
				origin: "dispatch",
				argv,
				execPath: process.execPath,
				env: process.env,
				extraEnv: opts.env,
				model: opts.model,
				thinking: opts.thinking,
			}),
		),
	);
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
