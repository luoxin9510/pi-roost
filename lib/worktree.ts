// M10 (PRD C7): a new background session in its own git worktree, and its cleanup on rm.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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
	/** M15: ignored files and folders copied in by .worktreeinclude. */
	included: string[];
}

export const INCLUDE_FILE = ".worktreeinclude";

const nulList = (out: string | undefined) => (out ?? "").split("\0").filter(Boolean);

const INCLUDED_ARGS = (file: string) => ["ls-files", "-z", "--others", "--ignored", "--directory", `--exclude-from=${file}`];
const IGNORED_ARGS = ["ls-files", "-z", "--others", "--ignored", "--directory", "--exclude-standard"];

/**
 * M15 (Claude Code's .worktreeinclude): of the entries an include file (gitignore syntax)
 * names, the ones git ignores; tracked files are in a worktree anyway. Folders come as
 * one entry ending in "/". Never pi-roost's own worktrees.
 */
function includedOf(listed: string[], ignored: string[]): string[] {
	const set = new Set(ignored);
	const dirs = ignored.filter((e) => e.endsWith("/"));
	const own = `${WORKTREES_DIR.split(sep).join("/")}/`;
	return listed.filter((e) => !e.startsWith(own) && !own.startsWith(e) && (set.has(e) || dirs.some((d) => e.startsWith(d))));
}

/** What `dir`'s .worktreeinclude names, or `includeFile` instead (the source checkout's). */
export function includedEntries(dir: string, includeFile = join(dir, INCLUDE_FILE)): string[] {
	if (!existsSync(includeFile)) return [];
	const listed = nulList(tryGit(dir, INCLUDED_ARGS(includeFile)));
	return listed.length === 0 ? [] : includedOf(listed, nulList(tryGit(dir, IGNORED_ARGS)));
}

/** The same, for the daemon: never blocks its event loop. */
async function includedEntriesAsync(dir: string, includeFile: string): Promise<string[]> {
	if (!existsSync(includeFile)) return [];
	const listed = nulList(await gitAsync(dir, INCLUDED_ARGS(includeFile), 20_000));
	return listed.length === 0 ? [] : includedOf(listed, nulList(await gitAsync(dir, IGNORED_ARGS, 20_000)));
}

/** Copy the .worktreeinclude entries of `from` into `to` (copy-on-write where the disk can); what fails is skipped. */
function copyIncluded(from: string, to: string): string[] {
	const done: string[] = [];
	for (const e of includedEntries(from)) {
		const rel = e.replace(/\/$/, "");
		try {
			mkdirSync(dirname(join(to, rel)), { recursive: true });
			cpSync(join(from, rel), join(to, rel), { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false, mode: constants.COPYFILE_FICLONE });
			done.push(e);
		} catch {
			// a socket, a permission: the session does without it
		}
	}
	return done;
}

/** Folders of dependencies and caches, rebuilt from the repository: never anyone's work. */
const REBUILT = new Set(["node_modules", ".venv", "venv", ".tox", "__pycache__", ".pytest_cache", ".mypy_cache", "target", ".gradle", ".next", ".nuxt", ".turbo", ".parcel-cache", ".pnpm-store", "bower_components"]);
const TREE_MAX = 5000;

/** The same as in the source checkout: a file's bytes, a link's target. */
function sameEntry(a: string, b: string): boolean {
	try {
		const sa = lstatSync(a);
		const sb = lstatSync(b);
		if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
		if (sa.isFile() && sb.isFile()) return sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
		return false;
	} catch {
		return false;
	}
}

/** Every file below `a` is the same at `b` (a folder too big to check is not). */
function sameTree(a: string, b: string): boolean {
	let n = 0;
	const walk = (rel: string): boolean => {
		for (const d of readdirSync(join(a, rel), { withFileTypes: true })) {
			if (++n > TREE_MAX) return false;
			const r = join(rel, d.name);
			if (d.isDirectory()) {
				if (!walk(r)) return false;
			} else if (!sameEntry(join(a, r), join(b, r))) return false;
		}
		return true;
	};
	try {
		return walk("");
	} catch {
		return false;
	}
}

/**
 * An ignored entry of the worktree that rm may delete: one the source checkout's
 * .worktreeinclude covers and that holds nothing new: a dependency folder, or files the
 * same as where they came from. An edited .env, a new file in an included folder, is work.
 */
function replaceable(w: WorktreeInfo, entry: string, included: ReadonlySet<string>, dirs: string[]): boolean {
	if (!included.has(entry) && !dirs.some((d) => entry.startsWith(d))) return false;
	const rel = entry.replace(/\/$/, "");
	if (entry.endsWith("/")) return REBUILT.has(basename(rel)) || sameTree(join(w.path, rel), join(w.repo, rel));
	return sameEntry(join(w.path, rel), join(w.repo, rel));
}

/** `git status --porcelain -z --ignored` as entries (no quoting, any file name). */
function statusEntries(out: string | undefined): { code: string; path: string }[] | undefined {
	if (out === undefined) return undefined;
	const parts = out.split("\0");
	const list: { code: string; path: string }[] = [];
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;
		if (p.length < 4) continue;
		const code = p.slice(0, 2);
		list.push({ code, path: p.slice(3) });
		// a rename or copy names its source next
		if (code[0] === "R" || code[0] === "C") i++;
	}
	return list;
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--ignored"];

/** Ignored entries that .worktreeinclude did not bring in, or that changed since. */
function uncovered(w: WorktreeInfo, entries: { code: string; path: string }[], inc: string[]): boolean {
	const set = new Set(inc);
	const dirs = inc.filter((e) => e.endsWith("/"));
	return entries.some((e) => e.code === "!!" && !replaceable(w, e.path, set, dirs));
}

/** The source checkout's include list: the worktree's copy is the session's to edit. */
const sourceInclude = (w: WorktreeInfo) => join(w.repo, INCLUDE_FILE);
const hasIgnored = (entries: { code: string }[]) => entries.some((e) => e.code === "!!");

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
		maxBuffer: 64 * 1024 * 1024,
	}).trim();
}

const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });

/** The daemon's git: never blocks its event loop, never throws. */
function gitAsync(cwd: string, args: string[], timeout = 5_000): Promise<string | undefined> {
	return new Promise((done) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, env: GIT_ENV(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => done(err ? undefined : String(stdout).trim()));
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
	const included = copyIncluded(top, path);
	return { path, branch, repo: top, base, cwd: existsSync(inside) ? inside : path, sourceDirty, included };
}

/**
 * Undo createWorktree after a dispatch the daemon refused. Even then only what holds
 * nothing: a clean worktree (ignored files count), a branch still at its base.
 */
export function discardWorktree(w: WorktreeInfo): void {
	if (existsSync(w.path)) {
		const entries = statusEntries(tryGit(w.path, STATUS_ARGS));
		if (!entries || entries.some((x) => x.code !== "!!")) return;
		if (hasIgnored(entries) && uncovered(w, entries, includedEntries(w.path, sourceInclude(w)))) return;
		if (tryGit(w.repo, ["worktree", "remove", "--", w.path]) === undefined) return;
	}
	if (tryGit(w.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]) === w.base) tryGit(w.repo, ["branch", "-D", "--", w.branch]);
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
	/** Files git ignores (.env, build output, node_modules): rm would delete them. */
	ignored: boolean;
	/** Commits on the branch beyond base (null when git cannot say). */
	ahead: number | null;
	/** The branch still points at base: deleting it loses nothing. */
	atBase: boolean;
}

export async function worktreeStatus(w: WorktreeInfo): Promise<WorktreeStatus> {
	const exists = existsSync(w.path);
	const [porcelain, count, tip] = await Promise.all([
		exists ? gitAsync(w.path, STATUS_ARGS) : Promise.resolve(""),
		gitAsync(existsSync(w.repo) ? w.repo : w.path, ["rev-list", "--count", `${w.base}..refs/heads/${w.branch}`]),
		gitAsync(existsSync(w.repo) ? w.repo : w.path, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`]),
	]);
	const entries = statusEntries(porcelain) ?? [{ code: "??", path: "?" }];
	const ahead = count !== undefined && /^\d+$/.test(count) ? Number(count) : null;
	return {
		exists,
		dirty: exists && entries.some((e) => e.code !== "!!"),
		ignored: exists && hasIgnored(entries) && uncovered(w, entries, await includedEntriesAsync(w.path, sourceInclude(w))),
		ahead,
		atBase: tip === w.base,
	};
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
		if (st.ignored) return out(false, true, "it has files git ignores (.env, build output, dependencies)");
		// no --force: git still refuses if a change appeared since the check
		if ((await gitAsync(w.repo, ["worktree", "remove", "--", w.path], 20_000)) === undefined) return out(false, true, "git worktree remove failed");
	} else await gitAsync(w.repo, ["worktree", "prune"]);
	// a branch moved anywhere (even behind base) keeps whatever it points at
	if (st.atBase && (await gitAsync(w.repo, ["branch", "-D", "--", w.branch])) !== undefined) return out(true, false);
	const reason = st.ahead ? `${st.ahead} commit${st.ahead === 1 ? "" : "s"} on the branch` : st.atBase ? undefined : "the branch moved";
	return out(true, true, reason);
}

/** What rm did with a session's worktree, for the CLI and the view. */
export function cleanupText(r: CleanupResult): string {
	if (!r.removed) return `worktree kept: ${r.path} (${r.reason ?? "kept"})`;
	return r.branchKept ? `worktree removed · branch ${r.branch} kept${r.reason ? ` (${r.reason})` : ""}` : "worktree and branch removed";
}

/** Where a worktree session is shown relative to (its repo), for messages. */
export const worktreeLabel = (w: WorktreeInfo): string => `${w.branch} (${relative(w.repo, w.path) || w.path})`;

/** M26: what a session changed in its worktree since it started (commits and uncommitted work). */
export interface WorktreeChange {
	files: number;
	insertions: number;
	deletions: number;
	/** New files git does not track yet (not in the counts above). */
	untracked: number;
}

export async function worktreeChange(path: string, base: string): Promise<WorktreeChange | undefined> {
	const [stat, others] = await Promise.all([gitAsync(path, ["diff", "--shortstat", base]), gitAsync(path, ["ls-files", "--others", "--exclude-standard"])]);
	if (stat === undefined || others === undefined) return undefined;
	const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
	return {
		files: num(/(\d+) files? changed/),
		insertions: num(/(\d+) insertions?\(\+\)/),
		deletions: num(/(\d+) deletions?\(-\)/),
		untracked: others ? others.split("\n").filter(Boolean).length : 0,
	};
}

/** "3 files +40 −12 · 1 new", or "no changes". */
export function changeText(c: WorktreeChange): string {
	const parts: string[] = [];
	if (c.files > 0) parts.push(`${c.files} file${c.files === 1 ? "" : "s"} +${c.insertions} −${c.deletions}`);
	if (c.untracked > 0) parts.push(`${c.untracked} new`);
	return parts.length > 0 ? parts.join(" · ") : "no changes";
}
