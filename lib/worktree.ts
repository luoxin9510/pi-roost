// M10 (PRD C7): a new background session in its own git worktree, and its cleanup on rm.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorktreeInfo {
	/** The worktree's top directory. */
	path: string;
	branch: string;
	/** Top directory of the checkout it was made from. */
	repo: string;
	/** The commit it was made from. */
	base: string;
}

export interface CreatedWorktree extends WorktreeInfo {
	/** Where the session starts: the dispatch directory's place inside the worktree. */
	cwd: string;
	/** The dispatch checkout had uncommitted changes (they are not in the worktree). */
	sourceDirty: boolean;
}

export const WORKTREES_DIR = join(".pi", "worktrees");
export const BRANCH_PREFIX = "roost/";
const GIT_TIMEOUT_MS = 20_000;

export class WorktreeError extends Error {}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
		env: GIT_ENV(),
	}).trim();
}

const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

/** The daemon's git: never blocks its event loop, never throws. */
function gitAsync(cwd: string, args: string[], timeout = 5_000): Promise<string | undefined> {
	return new Promise((done) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, env: GIT_ENV() }, (err, stdout) => done(err ? undefined : String(stdout).trim()));
	});
}

function tryGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args);
	} catch {
		return undefined;
	}
}

const real = (p: string) => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};

/** The checkout's top directory, or undefined outside a git repository. */
export function gitToplevel(cwd: string): string | undefined {
	const top = tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	return top ? real(top) : undefined;
}

/** Lowercase ASCII words of a session name, for directory and branch names. */
export function slugOf(name: string): string {
	const s = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/, "");
	return s || "task";
}

/** The main checkout (worktrees live under it, never nested in another worktree). */
function mainCheckout(top: string): string {
	const common = tryGit(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (common && basename(common) === ".git") return real(dirname(common));
	return top;
}

/** Keep .pi/worktrees/ out of `git status` without touching tracked files. */
function ensureExcluded(top: string): void {
	// --git-path: right for linked worktrees and submodules alike
	const rel = tryGit(top, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rel) return;
	const file = resolve(top, rel);
	const line = "/.pi/worktrees/";
	try {
		const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (cur.split(/\r?\n/).includes(line)) return;
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# pi-roost worktrees\n${line}\n`);
	} catch {
		// cosmetic: the worktrees only show as untracked
	}
}

/** Make a worktree and branch for a new session started from `cwd`. */
export function createWorktree(cwd: string, name: string, rand: () => string = () => randomBytes(2).toString("hex")): CreatedWorktree {
	const top = gitToplevel(cwd);
	if (!top) throw new WorktreeError(`not in a git repository: ${cwd}`);
	const base = tryGit(top, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (!base) throw new WorktreeError("the repository has no commits yet: a worktree needs one");
	const root = join(mainCheckout(top), WORKTREES_DIR);
	const slug = slugOf(name);
	let path = "";
	let branch = "";
	for (let i = 0; i < 8; i++) {
		const tag = `${slug}-${rand()}`;
		path = join(root, tag);
		branch = `${BRANCH_PREFIX}${tag}`;
		if (!existsSync(path) && tryGit(top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) break;
		path = "";
	}
	if (!path) throw new WorktreeError("could not find a free worktree name");
	mkdirSync(root, { recursive: true });
	ensureExcluded(top);
	try {
		git(top, ["worktree", "add", "--quiet", "-b", branch, "--", path, base]);
	} catch (err) {
		const msg = String((err as { stderr?: unknown }).stderr ?? (err as Error).message).trim();
		throw new WorktreeError(`git worktree add failed: ${msg.split("\n").pop()}`);
	}
	path = real(path);
	const rel = relative(top, real(cwd));
	const inside = rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(path, rel) : path;
	const sourceDirty = (tryGit(top, ["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
	return { path, branch, repo: top, base, cwd: existsSync(inside) ? inside : path, sourceDirty };
}

/** Undo createWorktree after a dispatch that failed (nothing was done in it). */
export function discardWorktree(w: WorktreeInfo): void {
	tryGit(w.repo, ["worktree", "remove", "--force", "--", w.path]);
	tryGit(w.repo, ["branch", "-D", "--", w.branch]);
}

const TAG = /^[a-z0-9-]{1,32}-[0-9a-f]{4}$/;

/**
 * Is this a worktree pi-roost made: the shape of every field, the place under the main
 * checkout's .pi/worktrees, one repository, and the branch checked out there. The daemon
 * checks it at dispatch and again before rm deletes anything.
 */
export async function validWorktree(w: unknown): Promise<boolean> {
	if (!w || typeof w !== "object") return false;
	const o = w as Record<string, unknown>;
	const s = (v: unknown): v is string => typeof v === "string" && v.length > 0;
	if (!s(o.path) || !s(o.branch) || !s(o.repo) || !s(o.base)) return false;
	if (!isAbsolute(o.path) || !isAbsolute(o.repo) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(o.base)) return false;
	const tag = basename(o.path);
	if (!TAG.test(tag) || o.branch !== `${BRANCH_PREFIX}${tag}`) return false;
	if (!existsSync(o.path) || !existsSync(o.repo)) return false;
	const common = async (d: string) => {
		const c = await gitAsync(d, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		return c ? real(c) : undefined;
	};
	const [c1, c2, top, head] = await Promise.all([
		common(o.path),
		common(o.repo),
		gitAsync(o.path, ["rev-parse", "--show-toplevel"]),
		gitAsync(o.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
	]);
	if (!c1 || c1 !== c2 || !top || real(top) !== real(o.path) || head !== o.branch) return false;
	const main = basename(c1) === ".git" ? dirname(c1) : real(o.repo);
	return real(dirname(o.path)) === join(main, WORKTREES_DIR);
}

export const isInside = (dir: string, root: string): boolean => {
	const rel = relative(root, dir);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export interface WorktreeStatus {
	exists: boolean;
	/** Uncommitted or untracked changes. */
	dirty: boolean;
	/** Commits on the branch beyond base (null when git cannot say). */
	ahead: number | null;
}

export async function worktreeStatus(w: WorktreeInfo): Promise<WorktreeStatus> {
	const exists = existsSync(w.path);
	const [porcelain, count] = await Promise.all([
		exists ? gitAsync(w.path, ["status", "--porcelain"]) : Promise.resolve(""),
		gitAsync(existsSync(w.repo) ? w.repo : w.path, ["rev-list", "--count", `${w.base}..refs/heads/${w.branch}`]),
	]);
	const ahead = count !== undefined && /^\d+$/.test(count) ? Number(count) : null;
	return { exists, dirty: exists && porcelain !== "", ahead };
}

/** The last line of a child's report (M9). */
export function worktreeLine(w: WorktreeInfo, st: WorktreeStatus): string {
	const parts = [`Worktree: ${w.path}`, `branch ${w.branch}`];
	if (st.ahead !== null) parts.push(`${st.ahead} commit${st.ahead === 1 ? "" : "s"} on it`);
	if (st.dirty) parts.push("uncommitted changes");
	return parts.join(" · ");
}

/** The worker's system-prompt note. */
export function worktreeNote(w: WorktreeInfo): string {
	return [
		"## Working copy",
		`This session works in its own git worktree, ${w.path}, on branch ${w.branch}, made from commit ${w.base.slice(0, 8)} of ${w.repo}.`,
		"Other sessions work in other checkouts, so edits here do not collide with theirs.",
		`Commit finished work on this branch. Do not switch branches, and do not edit files in ${w.repo} itself.`,
	].join("\n");
}

export interface CleanupResult {
	path: string;
	branch: string;
	removed: boolean;
	branchKept: boolean;
	reason?: string;
}

/**
 * After rm: remove what holds no work. `inUse`: another job runs inside the worktree.
 * Never deletes uncommitted changes or commits that are only on the branch.
 */
export async function cleanupWorktree(w: WorktreeInfo, inUse: boolean): Promise<CleanupResult> {
	const out = (removed: boolean, branchKept: boolean, reason?: string): CleanupResult => ({
		path: w.path,
		branch: w.branch,
		removed,
		branchKept,
		...(reason ? { reason } : {}),
	});
	if (inUse) return out(false, true, "another session uses it");
	if (!existsSync(w.repo)) return out(false, true, `its repository ${w.repo} is gone`);
	const st = await worktreeStatus(w);
	if (st.exists) {
		// only ever the worktree pi-roost made, still on its own branch
		if (!(await validWorktree(w))) return out(false, true, "it is no longer on its branch");
		if (st.dirty) return out(false, true, "it has uncommitted changes");
		if ((await gitAsync(w.repo, ["worktree", "remove", "--", w.path], 20_000)) === undefined) return out(false, true, "git worktree remove failed");
	} else await gitAsync(w.repo, ["worktree", "prune"]);
	if (st.ahead === 0 && (await gitAsync(w.repo, ["branch", "-D", "--", w.branch])) !== undefined) return out(true, false);
	return out(true, true, st.ahead === null ? undefined : `${st.ahead} commit${st.ahead === 1 ? "" : "s"} on the branch`);
}

/** What rm did with a session's worktree, for the CLI and the view. */
export function cleanupText(r: CleanupResult): string {
	if (!r.removed) return `worktree kept: ${r.path} (${r.reason ?? "kept"})`;
	return r.branchKept ? `worktree removed · branch ${r.branch} kept${r.reason ? ` (${r.reason})` : ""}` : "worktree and branch removed";
}

/** Where a worktree session is shown relative to (its repo), for messages. */
export const worktreeLabel = (w: WorktreeInfo): string => `${w.branch} (${relative(w.repo, w.path) || w.path})`;
