// M55: the git side of a task's life: its worktree, committing, syncing with base, merging into base.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addWorktree, GIT_ENV, mainCheckout, real, slugOf, tryGit, WorktreeError } from "./worktree.ts";

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** Never throws: the exit code, and both streams trimmed. */
function run(cwd: string, args: string[], timeout = 60_000): Promise<Run> {
	return new Promise((done) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, env: { ...GIT_ENV(), GIT_OPTIONAL_LOCKS: "1" }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 128) : 0;
			done({ code, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
		});
	});
}

const lastLines = (r: Run, n = 3) =>
	[r.stderr, r.stdout]
		.filter(Boolean)
		.join("\n")
		.split("\n")
		.filter(Boolean)
		.slice(-n)
		.join("\n") || `git exited with ${r.code}`;

/** `t<id>-<slug>-<4 hex>`: the part before the hex is at most 32 characters. */
export function taskTag(id: number, title: string, rand: () => string = () => randomBytes(2).toString("hex")): string {
	const head = `t${id}-`;
	return `${head}${slugOf(title, 32 - head.length)}-${rand()}`;
}

export interface TaskWorktree {
	path: string;
	branch: string;
	repo: string;
	base: string;
	baseRef: string;
	cwd: string;
	sourceDirty: boolean;
	included: string[];
}

/** A worktree and branch for a task, from the tip of the branch checked out in the main checkout. */
export function createTaskWorktree(repoDir: string, id: number, title: string, rand?: () => string): TaskWorktree {
	if (!existsSync(repoDir)) throw new WorktreeError(`not a git repository: ${repoDir}`);
	if (tryGit(repoDir, ["rev-parse", "--is-bare-repository"]) === "true") throw new WorktreeError("a bare repository has no checkout to start a task from");
	const top0 = tryGit(repoDir, ["rev-parse", "--show-toplevel"]);
	if (!top0) throw new WorktreeError(`not a git repository: ${repoDir}`);
	const main = mainCheckout(real(top0));
	const baseRef = tryGit(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!baseRef) throw new WorktreeError("the main checkout is on a detached HEAD: check out a branch first");
	const base = tryGit(main, ["rev-parse", "--verify", `refs/heads/${baseRef}^{commit}`]);
	if (!base) throw new WorktreeError("the repository has no commits yet: a worktree needs one");
	const w = addWorktree({ top: main, cwd: main, base, repo: main, tagOf: () => taskTag(id, title, rand) });
	return { path: w.path, branch: w.branch, repo: main, base, baseRef, cwd: w.path, sourceDirty: w.sourceDirty, included: w.included };
}

/** No tracked or untracked changes (ignored files are fine); undefined when git fails. */
export async function worktreeClean(path: string): Promise<boolean | undefined> {
	const r = await run(path, ["status", "--porcelain", "-z"]);
	return r.code === 0 ? r.stdout === "" : undefined;
}

async function mergeInProgress(path: string): Promise<boolean> {
	return (await run(path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
}

export async function commitAll(path: string, message: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
	if (await mergeInProgress(path)) return { ok: false, error: "a merge is in progress: resolve it and finish the merge first" };
	const st = await run(path, ["status", "--porcelain", "-z"]);
	if (st.code !== 0) return { ok: false, error: lastLines(st) };
	if (st.stdout === "") return { ok: false, error: "nothing to commit" };
	const add = await run(path, ["add", "-A"]);
	if (add.code !== 0) return { ok: false, error: lastLines(add) };
	const c = await run(path, ["commit", "-q", "-m", message]);
	if (c.code !== 0) return { ok: false, error: lastLines(c) };
	const sha = await revParse(path, "HEAD");
	return sha ? { ok: true, sha } : { ok: false, error: "committed, but HEAD cannot be read" };
}

export async function revParse(dir: string, ref: string): Promise<string | undefined> {
	const r = await run(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return r.code === 0 && r.stdout ? r.stdout : undefined;
}

export async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
	return (await run(dir, ["merge-base", "--is-ancestor", a, b])).code === 0;
}

export async function hasIdentity(dir: string): Promise<boolean> {
	const [n, e] = await Promise.all([run(dir, ["config", "user.name"]), run(dir, ["config", "user.email"])]);
	return n.code === 0 && n.stdout !== "" && e.code === 0 && e.stdout !== "";
}

export type SyncResult = { kind: "clean"; moved: boolean } | { kind: "conflict"; files: string[] } | { kind: "error"; message: string };

const unmerged = async (path: string): Promise<string[] | undefined> => {
	const r = await run(path, ["diff", "--name-only", "--diff-filter=U"]);
	return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : undefined;
};

/** Merge base into the task branch, in its worktree. A conflict stays in progress there. */
export async function syncWithBase(path: string, baseRef: string): Promise<SyncResult> {
	const ref = `refs/heads/${baseRef}`;
	if (await mergeInProgress(path)) {
		const files = await unmerged(path);
		if (files === undefined) return { kind: "error", message: "cannot read the merge state" };
		if (files.length > 0) return { kind: "conflict", files };
		return { kind: "error", message: "finish the merge: commit it" };
	}
	if (!(await revParse(path, ref))) return { kind: "error", message: `base branch ${baseRef} not found` };
	if (await isAncestor(path, ref, "HEAD")) return { kind: "clean", moved: false };
	const m = await run(path, ["merge", "--no-edit", ref], 120_000);
	if (m.code === 0) return { kind: "clean", moved: true };
	if (await mergeInProgress(path)) {
		const files = await unmerged(path);
		if (files && files.length > 0) return { kind: "conflict", files };
	}
	return { kind: "error", message: lastLines(m) };
}

export async function abortSync(path: string): Promise<boolean> {
	if (!(await mergeInProgress(path))) return false;
	return (await run(path, ["merge", "--abort"])).code === 0;
}

/** The checkout (main or linked) that has refs/heads/<baseRef> checked out. */
export async function findCheckout(repo: string, baseRef: string): Promise<string | null> {
	const r = await run(repo, ["worktree", "list", "--porcelain"]);
	if (r.code !== 0) return null;
	let path = "";
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice(9);
		else if (line === `branch refs/heads/${baseRef}` && path) return real(path);
	}
	return null;
}

export type MergeResult = { kind: "merged"; into: string } | { kind: "moved" } | { kind: "refused"; reason: string } | { kind: "failed"; message: string; baseMoved: boolean };

export async function mergeIntoBase(o: { repo: string; branch: string; baseRef: string; tip: string; oldBase: string; mode: "ff" | "no-ff" }): Promise<MergeResult> {
	const ref = `refs/heads/${o.baseRef}`;
	const baseNow = () => revParse(o.repo, ref);
	const checkout = await findCheckout(o.repo, o.baseRef);
	if (checkout) {
		if (await mergeInProgress(checkout)) return { kind: "refused", reason: `a merge is in progress in ${checkout}` };
		const clean = await worktreeClean(checkout);
		if (clean !== true) return { kind: "refused", reason: clean === false ? `${checkout} has uncommitted changes: commit or stash them first` : `cannot read the state of ${checkout}` };
		const cur = await baseNow();
		if (cur !== o.oldBase) return { kind: "moved" };
		const args = o.mode === "ff" ? ["merge", "--ff-only", "--quiet", o.tip] : ["merge", "--no-ff", "--no-edit", "-m", `Merge ${o.branch}`, o.tip];
		const m = await run(checkout, args, 120_000);
		if (m.code === 0) return { kind: "merged", into: (await baseNow()) ?? o.tip };
		// whatever happened, never leave a half-made merge in someone's checkout
		if (await mergeInProgress(checkout)) await run(checkout, ["merge", "--abort"]);
		const after = await baseNow();
		if (after && after !== o.oldBase && (await isAncestor(o.repo, o.tip, after))) return { kind: "merged", into: after };
		if (after === o.oldBase) return { kind: "failed", message: lastLines(m), baseMoved: false };
		if (o.mode === "ff") return { kind: "moved" };
		return { kind: "failed", message: lastLines(m), baseMoved: true };
	}
	if ((await baseNow()) !== o.oldBase) return { kind: "moved" };
	const u = await run(o.repo, ["update-ref", ref, o.tip, o.oldBase]);
	if (u.code === 0) return { kind: "merged", into: o.tip };
	const after = await baseNow();
	if (after && after !== o.oldBase) return (await isAncestor(o.repo, o.tip, after)) ? { kind: "merged", into: after } : { kind: "moved" };
	return { kind: "failed", message: lastLines(u), baseMoved: false };
}

/** After a merge: remove a clean worktree, delete the branch if it is exactly what was merged. */
export async function cleanupMergedTask(t: { repo: string; path: string; branch: string; tip: string; baseRef: string }): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; reason?: string }> {
	let worktreeRemoved = false;
	if (existsSync(t.path)) {
		const clean = await worktreeClean(t.path);
		if (clean !== true) return { worktreeRemoved: false, branchDeleted: false, reason: clean === false ? "the worktree has uncommitted changes" : "cannot read the worktree" };
		const rm1 = await run(t.repo, ["worktree", "remove", "--", t.path], 30_000);
		if (rm1.code !== 0) return { worktreeRemoved: false, branchDeleted: false, reason: lastLines(rm1, 1) };
		worktreeRemoved = true;
	} else await run(t.repo, ["worktree", "prune"]);
	const cur = await revParse(t.repo, `refs/heads/${t.branch}`);
	if (cur === undefined) return { worktreeRemoved, branchDeleted: false };
	if (cur !== t.tip) return { worktreeRemoved, branchDeleted: false, reason: "the branch has moved since the merge" };
	if (!(await isAncestor(t.repo, t.tip, `refs/heads/${t.baseRef}`))) return { worktreeRemoved, branchDeleted: false, reason: "the branch is not in base" };
	const d = await run(t.repo, ["branch", "-D", "--", t.branch]);
	return d.code === 0 ? { worktreeRemoved, branchDeleted: true } : { worktreeRemoved, branchDeleted: false, reason: lastLines(d, 1) };
}

/** Orders pi-roost's own merges in one repository: a lock file in the common git dir. */
export async function withMergeLock<T>(repo: string, fn: () => Promise<T>, staleMs = 600_000): Promise<T | { locked: true }> {
	const c = await run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (c.code !== 0 || !c.stdout) return { locked: true };
	const dir = resolve(repo, c.stdout);
	const file = join(dir, "roost-merge.lock");
	await mkdir(dir, { recursive: true }).catch(() => undefined);
	let taken = false;
	for (let i = 0; i < 2 && !taken; i++) {
		try {
			const fh = await open(file, "wx");
			await fh.writeFile(String(process.pid));
			await fh.close();
			taken = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { locked: true };
			const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => undefined);
			if (age === undefined) continue; // vanished: try again
			if (age <= staleMs) return { locked: true };
			await rm(file, { force: true });
		}
	}
	if (!taken) return { locked: true };
	try {
		return await fn();
	} finally {
		await rm(file, { force: true });
	}
}
