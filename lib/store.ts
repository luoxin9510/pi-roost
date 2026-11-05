import { mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./atomic.ts";
import { jobDir, jobTmpDir, jobsDir } from "./paths.ts";
import type { ProfileTerm } from "./profiles.ts";

export interface JobRecord {
	id: string;
	name: string;
	cwd: string;
	sessionFile: string; // may not exist yet: pi writes lazily
	command: string[]; // full argv: [execPath, piCli, ...args]
	env: Record<string, string>; // env captured at dispatch (M20: the whole env unless inheritEnv is off)
	/** M20: how the worker's environment follows its workspace (absent: as carried). */
	workspaceEnv?: "shell" | "direnv" | "off";
	/** M20: names (or `PREFIX*`) a workspace's environment may not set. */
	envDeny?: string[];
	/** M20: names that pass envDeny (envAllowList). */
	envForce?: string[];
	model?: string;
	thinking?: string;
	/** M18: the agent it runs as. */
	agent?: string;
	/** M26: the fan-out it belongs to. */
	fanout?: string;
	origin: "bg" | "dispatch" | "adopt" | "fork";
	/** DI-6: a shell command instead of pi; absent means pi. */
	kind?: "pi" | "shell";
	/** M30: a level 0 agent run from this profile (kind "shell": no worker, no session file). */
	profile?: string;
	/** M39: started by this schedule. */
	schedule?: string;
	/** M40: a profile whose `resume` takes its last session up (auto-resume applies). */
	resumable?: boolean;
	/** M30: how its screen is read and how replies are typed into it. */
	term?: ProfileTerm;
	/** M30: the argv that reopens it (a reply to it once it has ended). */
	resumeCommand?: string[];
	/** M31: its agent speaks the roost agent protocol (identity, reports, protocol replies). */
	agentProtocol?: boolean;
	/** M36: the request id it was dispatched with (a resend finds this job). */
	requestId?: string;
	/** M44: the hub's own agent. */
	role?: "concierge";
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
export const stateFile = (id: string) => join(jobDir(id), "state.json");
export const screenPath = (id: string) => join(jobDir(id), "screen.txt");
export const exitPath = (id: string) => join(jobDir(id), "exit.json");
/** M30: a level 0 agent's terminal signals, written by its host. */
export const termPath = (id: string) => join(jobDir(id), "term.json");

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
 * M8: a written session also drops the dispatch's --model, --provider and --thinking:
 * they would undo a model switched while the job ran (/model from the agent view).
 * `last` is what the worker last reported running; it is passed instead, because pi
 * does not always record it in the session (a resumed session's model only once it
 * has answered, a thinking level only when it changes). Without it pi restores what
 * the session recorded.
 */
export function respawnCommand(
	rec: JobRecord,
	sessionWritten: boolean,
	prompt?: string,
	last: { model?: unknown; thinking?: unknown } = {},
): string[] {
	if (!sessionWritten) return rec.command;
	const at = rec.command.indexOf("--", 2);
	const base = withoutFlags(at === -1 ? rec.command : rec.command.slice(0, at), SESSION_RESTORED_FLAGS);
	if (typeof last.model === "string" && /^[^/\s-][^\s]*\/\S+$/.test(last.model)) base.push("--model", last.model);
	if (typeof last.thinking === "string" && /^[a-z]+$/.test(last.thinking)) base.push("--thinking", last.thinking);
	return prompt ? [...base, "--", taskArg(prompt)] : base;
}

/** Flags pi restores from a written session by itself (and would override it if given). */
export const SESSION_RESTORED_FLAGS = ["--model", "--provider", "--thinking"];

/**
 * argv without these value flags, in both `--flag value` and `--flag=value` form; the
 * first `keep` entries (execPath, cli) are kept as they are. The value after a flag goes
 * with it, whatever it looks like: argv here comes from passthroughArgs, which only
 * copies known flags with their values.
 */
export function withoutFlags(argv: string[], flags: string[], keep = 2): string[] {
	const out = argv.slice(0, keep);
	for (let i = keep; i < argv.length; i++) {
		const arg = argv[i]!;
		if (flags.includes(arg)) i++;
		else if (!flags.some((f) => arg.startsWith(`${f}=`))) out.push(arg);
	}
	return out;
}

/**
 * M35: state the daemon may not lose in a machine crash: what the user said and has not
 * been taken yet, choices the user made, how a job ends or starts again. A worker's
 * report (state, summary, usage ...) is not: the next report replaces it, and a write
 * that skips fsync costs the daemon's loop a fraction of a millisecond, not eight.
 */
const DURABLE_KEYS = new Set(["requestIds", "pendingReplies", "replySeq", "pinned", "order", "orderKey", "pendingName", "typeTask", "jobToken", "command", "endedAt", "stopRequested", "supersededBy", "restartedAt", "removeAt", "resumeAt"]);

/** `durable` overrides the rule above (an ack is not: a lost one only means a resend). */
export function updateState(id: string, patch: Partial<JobState>, durable?: boolean): JobState {
	const cur = readState(id);
	if (!cur) throw new Error(`no state for job ${id}`);
	const next: JobState = { ...cur, ...patch, updatedAt: Date.now() };
	writeJsonAtomic(stateFile(id), next, durable ?? Object.keys(patch).some((k) => DURABLE_KEYS.has(k)));
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

/** M30: a level 0 agent (a profile job), as opposed to a plain shell command. */
export const isProfileJob = (rec: Pick<JobRecord, "kind" | "profile"> | undefined): boolean => rec?.kind === "shell" && typeof rec.profile === "string" && rec.profile !== "";

/** M31: a profile job whose agent speaks the protocol: a worker as pi's, not a terminal read from outside. */
export const isProtocolJob = (rec: Pick<JobRecord, "kind" | "profile" | "agentProtocol"> | undefined): boolean => isProfileJob(rec) && rec?.agentProtocol === true;

/** M30/M31: a job whose terminal roost reads and types into (a profile job that does not speak the protocol). */
export const isTermJob = (rec: Pick<JobRecord, "kind" | "profile" | "agentProtocol"> | undefined): boolean => isProfileJob(rec) && rec?.agentProtocol !== true;
