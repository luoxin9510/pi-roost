// M29: a job's identity and roost's own settings, under neutral names (ROOST_*) for any
// agent, with the names pi-roost used first (PI_*) still set and read. The new name wins.

/** What a worker reads to find its job; each entry: [new name, old name]. */
export const JOB_ENV = {
	id: ["ROOST_JOB_ID", "PI_JOB_ID"],
	token: ["ROOST_JOB_TOKEN", "PI_JOB_TOKEN"],
	socket: ["ROOST_SOCKET", "PI_DAEMON_SOCK"],
	dir: ["ROOST_JOB_DIR", "PI_JOB_DIR"],
} as const;

/** Every name that makes a process a job's worker: never inherited by another job. */
export const JOB_ENV_NAMES: readonly string[] = [...Object.values(JOB_ENV).flat(), "PI_ROOST_RESTORE"];

/** The environment a job's worker starts with: both names of each. */
export function jobEnv(o: { id: string; token?: string; socket: string; dir: string }): Record<string, string> {
	const out: Record<string, string> = {};
	const set = (names: readonly string[], v: string | undefined) => {
		if (v !== undefined) for (const n of names) out[n] = v;
	};
	set(JOB_ENV.id, o.id);
	set(JOB_ENV.token, o.token);
	set(JOB_ENV.socket, o.socket);
	set(JOB_ENV.dir, o.dir);
	return out;
}

/** The first set name of a JOB_ENV entry. */
export function readJobEnv(env: NodeJS.ProcessEnv, which: keyof typeof JOB_ENV): string | undefined {
	for (const n of JOB_ENV[which]) if (env[n]) return env[n];
	return undefined;
}

/** A roost setting from the environment: ROOST_<name>, else PI_ROOST_<name>. */
export function roostEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[`ROOST_${name}`] || env[`PI_ROOST_${name}`] || undefined;
}
