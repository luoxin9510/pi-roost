// M55: the git side of a task's life: its worktree, committing, syncing with base, merging into base.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addWorktree, copyIncluded, GIT_ENV, mainCheckout, real, slugOf, tryGit, WorktreeError } from "./worktree.ts";

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** Never throws: the exit code, and both streams trimmed. */
function run(cwd: string, args: string[], timeout = 60_000): Promise<Run> {
	return new Promise((done) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, env: GIT_ENV(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
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

/** M55: the branch checked out in a worktree (refs/heads/… without the prefix), or undefined (detached, unreadable). */
export async function currentBranch(path: string): Promise<string | undefined> {
	const r = await run(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * M57: what a task's worktree holds against its base: the files changed since the commit
 * its branch shares with base (committed and not, tracked; new files too), the commits
 * base does not have, whether anything is uncommitted. Undefined when git cannot say (the
 * worktree gone, no base). Read-only, without the index lock.
 */
export async function taskChanges(path: string, baseRef: string): Promise<import("./workspace-view.ts").TaskChanges | undefined> {
	const mb = await run(path, ["merge-base", "HEAD", `refs/heads/${baseRef}`]);
	if (mb.code !== 0 || !mb.stdout) return undefined;
	const base = mb.stdout.trim();
	const [num, names, others, count, status] = await Promise.all([
		run(path, ["diff", "--numstat", "-M", "-z", base]),
		run(path, ["diff", "--name-status", "-M", "-z", base]),
		run(path, ["ls-files", "--others", "--exclude-standard", "-z"]),
		run(path, ["rev-list", "--count", `${base}..HEAD`]),
		run(path, ["status", "--porcelain"]),
	]);
	if (num.code !== 0 || names.code !== 0) return undefined;
	const counts = new Map<string, { add: number | null; del: number | null }>();
	const nf = num.stdout.split("\0");
	for (let i = 0; i < nf.length; i++) {
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(nf[i]!);
		if (!m) continue;
		// a rename: the path field is empty, the old and the new path follow
		let p = m[3]!;
		if (!p) {
			i += 2;
			p = nf[i] ?? "";
		}
		counts.set(p, { add: m[1] === "-" ? null : Number(m[1]), del: m[2] === "-" ? null : Number(m[2]) });
	}
	const files: { status: string; path: string; add: number | null; del: number | null }[] = [];
	const sf = names.stdout.split("\0").filter((x, i, a) => x !== "" || i < a.length - 1);
	for (let i = 0; i < sf.length; i++) {
		const st = sf[i]!;
		if (!/^[A-Z]\d*$/.test(st)) continue;
		const two = st[0] === "R" || st[0] === "C";
		const p = two ? `${sf[i + 1]} → ${sf[i + 2]}` : (sf[i + 1] ?? "");
		const key = two ? (sf[i + 2] ?? "") : p;
		i += two ? 2 : 1;
		const c = counts.get(key) ?? { add: null, del: null };
		files.push({ status: st[0]!, path: p, ...c });
	}
	for (const p of others.stdout.split("\0").filter(Boolean)) files.push({ status: "A", path: p, add: null, del: null });
	return {
		files,
		insertions: files.reduce((n, f) => n + (f.add ?? 0), 0),
		deletions: files.reduce((n, f) => n + (f.del ?? 0), 0),
		commits: Number(count.stdout) || 0,
		dirty: status.code === 0 && status.stdout.length > 0,
	};
}

/** M59: a task's worktree removed (shelved): only a clean one; its branch stays. */
export async function removeTaskWorktree(repo: string, path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!existsSync(path)) {
		await run(repo, ["worktree", "prune"]);
		return { ok: true };
	}
	const clean = await worktreeClean(path);
	if (clean !== true) return { ok: false, reason: clean === false ? "it has uncommitted changes" : "cannot read it" };
	const r = await run(repo, ["worktree", "remove", "--", path], 30_000);
	return r.code === 0 ? { ok: true } : { ok: false, reason: lastLines(r, 1) };
}

/**
 * M59: a shelved task's worktree made again at its old path from its branch (the branch
 * checked out there again, `.worktreeinclude` copied as for a new one).
 */
export function restoreTaskWorktree(repo: string, path: string, branch: string): void {
	if (existsSync(path)) throw new WorktreeError(`${path} exists: not restoring over it`);
	if (tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === undefined) throw new WorktreeError(`its branch ${branch} is gone`);
	tryGit(repo, ["worktree", "prune"]);
	if (tryGit(repo, ["worktree", "add", "--", path, branch]) === undefined) throw new WorktreeError(`git could not make ${path} from ${branch}`);
	try {
		copyIncluded(mainCheckout(repo), path);
	} catch {}
}

/** M59: the task worktrees git knows in a repository: path, branch (without refs/heads/), the task id in its name. */
export async function taskWorktrees(repo: string): Promise<{ path: string; branch: string; id: number }[]> {
	const r = await run(repo, ["worktree", "list", "--porcelain"]);
	if (r.code !== 0) return [];
	const out: { path: string; branch: string; id: number }[] = [];
	for (const block of r.stdout.split("\n\n")) {
		const path = /^worktree (.+)$/m.exec(block)?.[1];
		const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
		const id = branch ? /^roost\/t(\d+)-/.exec(branch)?.[1] : undefined;
		if (path && branch && id) out.push({ path, branch, id: Number(id) });
	}
	return out;
}
