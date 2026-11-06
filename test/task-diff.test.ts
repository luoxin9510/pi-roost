import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DIFF_FILE_MAX_LINES, DIFF_LINE_MAX, parseUnifiedDiff, taskDiff } from "../lib/task-diff.ts";
import { createTaskWorktree } from "../lib/task-git.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

function repo(): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "roost-td-")));
	dirs.push(d);
	git(d, "init", "-q", "-b", "main");
	writeFileSync(join(d, "a.txt"), "a\nb\nc\n");
	writeFileSync(join(d, "gone.txt"), "bye\n");
	writeFileSync(join(d, "old.txt"), body);
	git(d, "add", ".");
	git(d, "commit", "-q", "-m", "init");
	return d;
}

let n = 0;
const rand = () => (n++).toString(16).padStart(4, "0");
const task = () => {
	const r = repo();
	const w = createTaskWorktree(r, 1, "do it", rand);
	return { r, w, p: w.path };
};
const commitAll = (dir: string, msg = "x") => {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", msg);
};

describe("parseUnifiedDiff", () => {
	it("parses a modification with numbered lines", () => {
		const t = ["diff --git a/x.txt b/x.txt", "index 1..2 100644", "--- a/x.txt", "+++ b/x.txt", "@@ -1,3 +1,3 @@ ctx", " a", "-b", "+B", " c", ""].join("\n");
		const [f] = parseUnifiedDiff(t);
		expect(f).toMatchObject({ path: "x.txt", status: "M", binary: false });
		expect(f!.hunks[0]!.header).toBe("@@ -1,3 +1,3 @@ ctx");
		expect(f!.hunks[0]!.lines).toEqual([
			{ kind: " ", text: "a", oldNo: 1, newNo: 1 },
			{ kind: "-", text: "b", oldNo: 2, newNo: null },
			{ kind: "+", text: "B", oldNo: null, newNo: 2 },
			{ kind: " ", text: "c", oldNo: 3, newNo: 3 },
		]);
	});
	it("handles new and deleted files", () => {
		const t = [
			"diff --git a/n.txt b/n.txt", "new file mode 100644", "index 0..1", "--- /dev/null", "+++ b/n.txt", "@@ -0,0 +1,2 @@", "+one", "+two",
			"diff --git a/d.txt b/d.txt", "deleted file mode 100644", "index 1..0", "--- a/d.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", "",
		].join("\n");
		const fs = parseUnifiedDiff(t);
		expect(fs.map((f) => [f.path, f.status])).toEqual([["n.txt", "A"], ["d.txt", "D"]]);
		expect(fs[0]!.hunks[0]!.lines.map((l) => l.newNo)).toEqual([1, 2]);
		expect(fs[1]!.hunks[0]!.lines[0]).toEqual({ kind: "-", text: "bye", oldNo: 1, newNo: null });
	});
	it("handles a rename with and without changes", () => {
		const t = [
			"diff --git a/o.txt b/p q.txt", "similarity index 90%", "rename from o.txt", "rename to p q.txt", "index 1..2 100644", "--- a/o.txt", "+++ b/p q.txt\t", "@@ -1 +1 @@", "-x", "+y",
			"diff --git a/s.txt b/t.txt", "similarity index 100%", "rename from s.txt", "rename to t.txt", "",
		].join("\n");
		const fs = parseUnifiedDiff(t);
		expect(fs[0]).toMatchObject({ path: "p q.txt", oldPath: "o.txt", status: "R" });
		expect(fs[0]!.hunks[0]!.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([["-", 1, null], ["+", null, 1]]);
		expect(fs[1]).toMatchObject({ path: "t.txt", oldPath: "s.txt", status: "R", hunks: [] });
	});
	it("marks binary files", () => {
		const t = ["diff --git a/b.bin b/b.bin", "new file mode 100644", "index 0..1", "Binary files /dev/null and b/b.bin differ", ""].join("\n");
		expect(parseUnifiedDiff(t)).toEqual([{ path: "b.bin", status: "A", binary: true, hunks: [] }]);
	});
	it("decodes quoted paths with octal escapes", () => {
		const t = ['diff --git "a/caf\\303\\251\\t.txt" "b/caf\\303\\251\\t.txt"', "index 1..2 100644", '--- "a/caf\\303\\251\\t.txt"', '+++ "b/caf\\303\\251\\t.txt"', "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
		expect(parseUnifiedDiff(t)[0]!.path).toBe("café\t.txt");
	});
	it("skips 'No newline' markers and reads omitted counts", () => {
		const t = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file", ""].join("\n");
		const h = parseUnifiedDiff(t)[0]!.hunks;
		expect(h[0]!.lines.map((l) => l.text)).toEqual(["a", "b"]);
	});
	it("keeps a mode-only change as a file with no hunks", () => {
		const t = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", ""].join("\n");
		expect(parseUnifiedDiff(t)).toEqual([{ path: "run.sh", status: "M", binary: false, hunks: [] }]);
	});
	it("does not mistake content that looks like headers for headers", () => {
		const t = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", "--- not a header", "+++ not either", " keep", "-z", "+w", ""].join("\n");
		const f = parseUnifiedDiff(t);
		expect(f).toHaveLength(1);
		expect(f[0]!.hunks[0]!.lines.map((l) => l.text)).toEqual(["-- not a header", "++ not either", "keep", "z", "w"]);
	});
	it("cuts long lines", () => {
		const t = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1 @@", "+" + "z".repeat(DIFF_LINE_MAX + 50), ""].join("\n");
		expect(parseUnifiedDiff(t)[0]!.hunks[0]!.lines[0]!.text).toHaveLength(DIFF_LINE_MAX);
	});
	it("gives a summary for a file over the line limit", () => {
		const n = DIFF_FILE_MAX_LINES + 5;
		const t = ["diff --git a/x b/x", "new file mode 100644", "--- /dev/null", "+++ b/x", `@@ -0,0 +1,${n} @@`, ...Array.from({ length: n }, () => "+l"), ""].join("\n");
		const f = parseUnifiedDiff(t)[0]!;
		expect(f.hunks).toEqual([]);
		expect(f.summary).toBe(`${n} lines changed: open it in your editor`);
	});
	it("returns nothing for empty text", () => {
		expect(parseUnifiedDiff("")).toEqual([]);
	});
});

describe("taskDiff", () => {
	it("shows modify, add, delete and rename with change, committed and not", async () => {
		const { p } = task();
		writeFileSync(join(p, "a.txt"), "a\nB\nc\n");
		unlinkSync(join(p, "gone.txt"));
		commitAll(p);
		renameSync(join(p, "old.txt"), join(p, "new.txt"));
		writeFileSync(join(p, "new.txt"), body.replace("line 10", "line ten"));
		git(p, "add", "-A");
		writeFileSync(join(p, "added.txt"), "x\n");
		git(p, "add", "added.txt");
		const d = (await taskDiff(p, "main"))!;
		expect(d.truncated).toBe(false);
		expect(d.tip).toBe(git(p, "rev-parse", "HEAD"));
		const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
		expect(by["a.txt"]).toMatchObject({ status: "M" });
		expect(by["a.txt"]!.hunks[0]!.lines.some((l) => l.kind === "+" && l.text === "B")).toBe(true);
		expect(by["gone.txt"]).toMatchObject({ status: "D" });
		expect(by["added.txt"]).toMatchObject({ status: "A" });
		expect(by["new.txt"]).toMatchObject({ status: "R", oldPath: "old.txt" });
		expect(d.files.map((f) => f.path)).toEqual([...d.files.map((f) => f.path)].sort());
	});
	it("lists untracked files as added", async () => {
		const { p } = task();
		writeFileSync(join(p, "u.txt"), "one\ntwo\n");
		const f = (await taskDiff(p, "main"))!.files.find((x) => x.path === "u.txt")!;
		expect(f).toMatchObject({ status: "A", binary: false });
		expect(f.hunks[0]!.header).toBe("@@ -0,0 +1,2 @@");
		expect(f.hunks[0]!.lines).toEqual([
			{ kind: "+", text: "one", oldNo: null, newNo: 1 },
			{ kind: "+", text: "two", oldNo: null, newNo: 2 },
		]);
	});
	it("marks binary files, tracked and untracked", async () => {
		const { p } = task();
		writeFileSync(join(p, "u.bin"), Buffer.from([1, 0, 2, 3]));
		writeFileSync(join(p, "t.bin"), Buffer.from([0, 9, 9]));
		commitAll(p);
		const d = (await taskDiff(p, "main"))!;
		expect(d.files.find((f) => f.path === "u.bin")).toMatchObject({ binary: true, hunks: [] });
		expect(d.files.find((f) => f.path === "t.bin")).toMatchObject({ binary: true, hunks: [] });
	});
	it("leaves out commits made on base after the worktree was made", async () => {
		const { r, p } = task();
		writeFileSync(join(r, "later.txt"), "later\n");
		git(r, "add", "later.txt");
		git(r, "commit", "-q", "-m", "later");
		writeFileSync(join(p, "mine.txt"), "mine\n");
		commitAll(p);
		const d = (await taskDiff(p, "main"))!;
		expect(d.files.map((f) => f.path)).toEqual(["mine.txt"]);
	});
	it("turns a file over the line limit into a summary", async () => {
		const { p } = task();
		const n = DIFF_FILE_MAX_LINES + 10;
		writeFileSync(join(p, "big.txt"), "l\n".repeat(n));
		writeFileSync(join(p, "big2.txt"), "l\n".repeat(n));
		git(p, "add", "big2.txt");
		const d = (await taskDiff(p, "main"))!;
		for (const name of ["big.txt", "big2.txt"]) {
			const f = d.files.find((x) => x.path === name)!;
			expect(f.hunks).toEqual([]);
			expect(f.summary).toBe(`${n} lines changed: open it in your editor`);
		}
	});
	it("handles a space and non-ASCII names", async () => {
		const { p } = task();
		mkdirSync(join(p, "d d"));
		writeFileSync(join(p, "d d", "my file.txt"), "s\n");
		writeFileSync(join(p, "café 日本.txt"), "c\n");
		writeFileSync(join(p, "u café.txt"), "u\n");
		git(p, "add", "d d", "café 日本.txt");
		const paths = (await taskDiff(p, "main"))!.files.map((f) => f.path);
		expect(paths).toContain("d d/my file.txt");
		expect(paths).toContain("café 日本.txt");
		expect(paths).toContain("u café.txt");
	});
	it("returns undefined when the base does not exist or the path is not a repo", async () => {
		const { p } = task();
		expect(await taskDiff(p, "nope")).toBeUndefined();
		expect(await taskDiff(join(p, "does-not-exist"), "main")).toBeUndefined();
	});
	it("has no files when nothing changed", async () => {
		const { p } = task();
		const d = (await taskDiff(p, "main"))!;
		expect(d.files).toEqual([]);
		expect(d.base).toBe(d.tip);
	});
});
