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
	createdAt: number; // ms epoch
	piVersion?: string;
	roostVersion: string;
}

export interface JobState {
	state: "working" | "blocked" | "done" | "failed" | "stopped";
	hostPid?: number;
	hostToken?: string; // processStartToken of the host
	workerPid?: number;
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
