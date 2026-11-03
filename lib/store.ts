import { mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./atomic.ts";
import { jobDir, jobTmpDir, jobsDir } from "./paths.ts";

export interface JobRecord {
	id: string;
	name: string;
	cwd: string;
	sessionFile: string; // may not exist yet: pi writes lazily
	command: string[]; // full argv: [execPath, piCli, ...args]
	env: Record<string, string>; // allow-listed env captured at dispatch
	model?: string;
	thinking?: string;
	origin: "bg" | "dispatch" | "adopt" | "fork";
	/** DI-6: a shell command instead of pi; absent means pi. */
	kind?: "pi" | "shell";
	createdAt: number; // ms epoch
	piVersion?: string;
	roostVersion: string;
	/** M9: spawned by roost_spawn: the spawner's session (or `peer:<id>`), the tree's root. */
	parentSession?: string;
	rootSession?: string;
	/** M10: its own git worktree (made at dispatch, cleaned up on rm). */
	worktree?: { path: string; branch: string; repo: string; base: string };
}

export interface JobState {
	state: "working" | "blocked" | "done" | "failed" | "stopped";
	hostPid?: number;
	hostToken?: string; // processStartToken of the host
	startedAt: number;
	endedAt?: number;
	updatedAt: number;
	pinned?: boolean;
	[k: string]: unknown;
}

export interface ExitRecord {
	code: number | null;
	signal: string | null;
	at: number;
}

const jobFile = (id: string) => join(jobDir(id), "job.json");
const stateFile = (id: string) => join(jobDir(id), "state.json");
export const screenPath = (id: string) => join(jobDir(id), "screen.txt");
export const exitPath = (id: string) => join(jobDir(id), "exit.json");

export function createJob(record: JobRecord, state: JobState): void {
	mkdirSync(jobDir(record.id), { recursive: true, mode: 0o700 });
	mkdirSync(jobTmpDir(record.id), { recursive: true, mode: 0o700 });
	writeJsonAtomic(jobFile(record.id), record);
	writeJsonAtomic(stateFile(record.id), state);
}

export const readJob = (id: string): JobRecord | undefined => readJson<JobRecord>(jobFile(id));
export const readState = (id: string): JobState | undefined => readJson<JobState>(stateFile(id));
export const readExit = (id: string): ExitRecord | undefined => readJson<ExitRecord>(exitPath(id));
export const writeExit = (id: string, rec: ExitRecord): void => writeJsonAtomic(exitPath(id), rec);
export const clearExit = (id: string): void => rmSync(exitPath(id), { force: true });

// The host's own record of its worker: state.json has a single writer, the daemon.
const workerFile = (id: string) => join(jobDir(id), "worker.json");
export const writeWorker = (id: string, pid: number): void => writeJsonAtomic(workerFile(id), { pid, at: Date.now() });
export const clearWorker = (id: string): void => rmSync(workerFile(id), { force: true });
export function readWorkerPid(id: string): number | undefined {
	const pid = readJson<{ pid?: unknown }>(workerFile(id))?.pid;
	return typeof pid === "number" ? pid : undefined;
}

/** The argv a host starts: a respawn replaces the dispatch command (no first prompt again). */
export function launchCommand(rec: JobRecord, st: JobState | undefined): string[] {
	const c = st?.command;
	return Array.isArray(c) && c.length > 0 && c.every((v) => typeof v === "string") ? (c as string[]) : rec.command;
}

/** A first prompt as pi's argv: pi reads an argument starting with @ as a file, even after --. */
export const taskArg = (task: string): string => (task.startsWith("@") ? ` ${task}` : task);

/**
 * Command for restarting a job from its session file: the dispatch command without
 * its first prompt (already in the session), optionally with a new one. A session
 * pi never wrote never saw the first prompt, so it keeps it.
 *
 * M8: a written session also drops the dispatch's --model, --provider and --thinking.
 * pi records the model and thinking level in the session and restores them on
 * resume, but a flag would win over that: a model switched while the job ran
 * (/model from the agent view) would be undone by every respawn.
 */
export function respawnCommand(rec: JobRecord, sessionWritten: boolean, prompt?: string): string[] {
	if (!sessionWritten) return rec.command;
	const at = rec.command.indexOf("--", 2);
	const base = withoutFlags(at === -1 ? rec.command : rec.command.slice(0, at), SESSION_RESTORED_FLAGS);
	return prompt ? [...base, "--", taskArg(prompt)] : base;
}

const SESSION_RESTORED_FLAGS = ["--model", "--provider", "--thinking"];

/** argv without these value flags, in both `--flag value` and `--flag=value` form (argv[0..1] kept). */
function withoutFlags(argv: string[], flags: string[]): string[] {
	const out = argv.slice(0, 2);
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]!;
		if (flags.includes(arg)) i++;
		else if (!flags.some((f) => arg.startsWith(`${f}=`))) out.push(arg);
	}
	return out;
}

export function updateState(id: string, patch: Partial<JobState>): JobState {
	const cur = readState(id);
	if (!cur) throw new Error(`no state for job ${id}`);
	const next: JobState = { ...cur, ...patch, updatedAt: Date.now() };
	writeJsonAtomic(stateFile(id), next);
	return next;
}

export function listJobIds(): string[] {
	let names: string[];
	try {
		names = readdirSync(jobsDir());
	} catch {
		return [];
	}
	return names.filter((n) => existsSync(jobFile(n)));
}

export function removeJob(id: string): void {
	rmSync(jobDir(id), { recursive: true, force: true });
}
