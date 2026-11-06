import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./atomic.ts";
import { roostHome } from "./paths.ts";
import { gitAsync } from "./worktree.ts";

/** M56: a repository's commands and limits, read from its base branch. */
export interface ProjectConfig {
	verify?: string;
	setup?: string;
	verifyTimeout: number;
	maxRounds: number;
}

export const VERIFY_TIMEOUT_DEFAULT = 600;
export const VERIFY_TIMEOUT_MAX = 3600;
export const MAX_ROUNDS_DEFAULT = 3;
const MAX_ROUNDS_MAX = 10;
const COMMAND_MAX = 2000;

const defaults = (): ProjectConfig => ({ verifyTimeout: VERIFY_TIMEOUT_DEFAULT, maxRounds: MAX_ROUNDS_DEFAULT });

/** M56: the fields present in `raw`, validated; problems are collected, never thrown. */
function parseFields(raw: unknown): { fields: Partial<ProjectConfig>; errors: string[] } {
	const errors: string[] = [];
	const fields: Partial<ProjectConfig> = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { fields, errors: ["project config must be a JSON object"] };
	const o = raw as Record<string, unknown>;
	for (const key of ["verify", "setup"] as const) {
		if (!(key in o)) continue;
		const v = o[key];
		if (typeof v !== "string" || v.trim() === "") errors.push(`${key}: must be a non-empty string`);
		else if (/[\r\n]/.test(v)) errors.push(`${key}: must be a single line`);
		else if (v.length > COMMAND_MAX) errors.push(`${key}: longer than ${COMMAND_MAX} characters`);
		else fields[key] = v;
	}
	if ("verifyTimeout" in o) {
		const v = o.verifyTimeout;
		if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= VERIFY_TIMEOUT_MAX) fields.verifyTimeout = v;
		else errors.push(`verifyTimeout: must be an integer from 1 to ${VERIFY_TIMEOUT_MAX} (seconds)`);
	}
	if ("maxRounds" in o) {
		const v = o.maxRounds;
		if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_ROUNDS_MAX) fields.maxRounds = v;
		else errors.push(`maxRounds: must be an integer from 1 to ${MAX_ROUNDS_MAX}`);
	}
	return { fields, errors };
}

export function parseProjectConfig(raw: unknown): { config: ProjectConfig; error?: string } {
	const { fields, errors } = parseFields(raw);
	return { config: { ...defaults(), ...fields }, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

export function overridePath(repo: string): string {
	return join(roostHome(), "projects", `${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.json`);
}

export function readOverride(repo: string): Partial<ProjectConfig> {
	const raw = readJson<unknown>(overridePath(repo));
	return raw === undefined ? {} : parseFields(raw).fields;
}

/** M56: the base branch's file (never the worktree's), overlaid field by field by the personal override. */
export async function readProjectConfig(repo: string, baseRef: string): Promise<{ config: ProjectConfig; error?: string; source: "base" | "none" }> {
	const spec = `refs/heads/${baseRef}:.roost/project.json`;
	const exists = (await gitAsync(repo, ["cat-file", "-e", spec])) !== undefined;
	let parsed: { config: ProjectConfig; error?: string } = { config: defaults() };
	if (exists) {
		const text = await gitAsync(repo, ["show", spec], 10_000);
		if (text === undefined) parsed = { config: defaults(), error: "could not read .roost/project.json" };
		else {
			try {
				parsed = parseProjectConfig(JSON.parse(text));
			} catch (err) {
				parsed = { config: defaults(), error: `.roost/project.json is not valid JSON: ${(err as Error).message}` };
			}
		}
	}
	const config = { ...parsed.config, ...readOverride(repo) };
	return { config, ...(parsed.error ? { error: parsed.error } : {}), source: exists ? "base" : "none" };
}

export const commandHash = (command: string): string => createHash("sha256").update(command).digest("hex");

type Approvals = Record<string, Record<string, { command: string; at: number }>>;
const approvalsPath = () => join(roostHome(), "approvals.json");
const readApprovals = (): Approvals => {
	const a = readJson<unknown>(approvalsPath());
	return typeof a === "object" && a !== null && !Array.isArray(a) ? (a as Approvals) : {};
};

export function isApproved(repo: string, command: string): boolean {
	const entry = readApprovals()[repo]?.[commandHash(command)];
	return !!entry && typeof entry === "object";
}

export function approve(repo: string, commands: string[]): void {
	const all = readApprovals();
	const mine = typeof all[repo] === "object" && all[repo] !== null ? all[repo] : {};
	for (const command of commands) mine[commandHash(command)] = { command, at: Date.now() };
	all[repo] = mine;
	mkdirSync(roostHome(), { recursive: true });
	writeJsonAtomic(approvalsPath(), all);
}

export function verifyLogPath(taskId: number, round: number): string {
	const dir = join(roostHome(), "verify");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${taskId}-${round}.log`);
}

/** M56: the end of a log, for the session and the note: control characters other than \n and \t removed. */
export function readLogTail(path: string, lines = 40, maxChars = 4000): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return "";
	}
	// eslint-disable-next-line no-control-regex
	text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n+$/, "");
	let out = text.split("\n").slice(-lines).join("\n");
	if (out.length > maxChars) out = out.slice(out.length - maxChars);
	return out;
}

/** M56: argv of a shell job; the command's output goes to the file named by ROOST_VERIFY_LOG. */
export function verifyCommand(command: string): string[] {
	// the whole script's output goes to the log (a redirect after the command would take only its last part: `a; b >log`)
	return ["/bin/sh", "-c", `exec >"$ROOST_VERIFY_LOG" 2>&1\n${command}`];
}
