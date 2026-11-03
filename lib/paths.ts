import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function roostHome(): string {
	return process.env.PI_ROOST_HOME || join(homedir(), ".pi", "agent", "roost");
}

export function runtimeDir(): string {
	if (process.env.PI_ROOST_RUNTIME_DIR) return process.env.PI_ROOST_RUNTIME_DIR;
	if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, "pi-roost");
	return `/tmp/pi-roost-${process.getuid?.() ?? 0}`;
}

export const jobsDir = () => join(roostHome(), "jobs");
export const jobDir = (id: string) => join(jobsDir(), id);
export const jobTmpDir = (id: string) => join(jobDir(id), "tmp");
export const daemonSocketPath = () => join(runtimeDir(), "daemon.sock");
export const hostSocketPath = (id: string) => join(runtimeDir(), `host-${id}.sock`);
export const daemonLockPath = () => join(runtimeDir(), "daemon.lock");
export const daemonLogPath = () => join(roostHome(), "daemon.log");
export const rosterPath = () => join(roostHome(), "roster.json");
/** Throwaway sessions a foreground pi switches to after handing its own off (C4). */
export const scratchDir = () => join(roostHome(), "scratch");
export const isScratchSession = (file: string | undefined) => !!file && resolve(file).startsWith(`${resolve(scratchDir())}/`);

export function ensureDirs(): void {
	mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
	const rt = runtimeDir();
	mkdirSync(rt, { recursive: true, mode: 0o700 });
	chmodSync(rt, 0o700);
	const st = lstatSync(rt);
	if (st.isSymbolicLink()) throw new Error(`runtime dir ${rt} is a symlink`);
	if (!st.isDirectory()) throw new Error(`runtime dir ${rt} is not a directory`);
	if (process.getuid && st.uid !== process.getuid()) {
		throw new Error(`runtime dir ${rt} is not owned by the current user`);
	}
}
