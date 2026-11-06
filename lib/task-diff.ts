// M58: a task's diff against its base, parsed into files, hunks and numbered lines for the review screen.
import { spawn } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { GIT_ENV } from "./worktree.ts";

export type DiffLineKind = "+" | "-" | " ";
export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	oldNo: number | null;
	newNo: number | null;
}
/** header: the "@@ -a,b +c,d @@ ctx" line */
export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}
export interface DiffFile {
	/** the new path (the old path for a deletion) */
	path: string;
	/** set for a rename (or copy) */
	oldPath?: string;
	status: "A" | "M" | "D" | "R";
	binary: boolean;
	/** set when the file is too big to show: its text instead of hunks */
	summary?: string;
	hunks: DiffHunk[];
}
export interface TaskDiff {
	base: string;
	tip: string;
	files: DiffFile[];
	truncated: boolean;
}

/** A file whose hunks exceed this many lines: summary only. */
export const DIFF_FILE_MAX_LINES = 2000;
/** Or whose diff text exceeds this. */
export const DIFF_FILE_MAX_BYTES = 256 * 1024;
/** The whole diff output read; beyond: truncated, later files dropped. */
export const DIFF_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
/** A line's text is kept at most this many characters. */
export const DIFF_LINE_MAX = 2000;

/** Decode a C-style quoted path as git prints it (octal escapes are UTF-8 bytes). */
function unquote(s: string): string {
	if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
	const bytes: number[] = [];
	const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	const body = s.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const c = body[i]!;
		if (c !== "\\") {
			bytes.push(...Buffer.from(c, "utf8"));
			continue;
		}
		const m = /^[0-7]{1,3}/.exec(body.slice(i + 1));
		if (m) {
			bytes.push(parseInt(m[0], 8) & 0xff);
			i += m[0].length;
		} else if (body[i + 1] !== undefined && simple[body[i + 1]!] !== undefined) {
			bytes.push(simple[body[i + 1]!]!);
			i++;
		} else bytes.push(92);
	}
	return Buffer.from(bytes).toString("utf8");
}

/** A path from a "--- a/x", "+++ b/x" or "rename to x" line; undefined for /dev/null. */
function headerPath(raw: string, prefix: string): string | undefined {
	// git adds a tab after names that contain spaces
	let s = raw.replace(/\t.*$/, "");
	if (s.startsWith('"')) s = unquote(s);
	if (s === "/dev/null") return undefined;
	return prefix && s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** The path out of "a/x b/x" (the same path on both sides), for files with no other path line. */
function pathFromGitLine(rest: string): string | undefined {
	if (rest.startsWith('"')) {
		// a quoted first name: find the end of it
		const m = /^"(?:[^"\\]|\\.)*"/.exec(rest);
		if (m) return headerPath(m[0], "a/");
	}
	if (rest.startsWith("a/")) {
		const len = (rest.length - 5) / 2;
		if (Number.isInteger(len) && len > 0 && rest.slice(2, 2 + len) === rest.slice(rest.length - len)) return rest.slice(2, 2 + len);
	}
	const m = /^a\/(.*) b\/(.*)$/.exec(rest);
	return m ? m[2] : undefined;
}

const cut = (s: string) => (s.length > DIFF_LINE_MAX ? s.slice(0, DIFF_LINE_MAX) : s);

interface Draft {
	path?: string;
	oldPath?: string;
	fromPath?: string;
	toPath?: string;
	status: DiffFile["status"];
	binary: boolean;
	hunks: DiffHunk[];
	bytes: number;
	changed: number;
	lineCount: number;
}

function finish(d: Draft): DiffFile {
	const path = (d.status === "D" ? d.fromPath ?? d.path : d.toPath ?? d.path) ?? d.path ?? "";
	const f: DiffFile = { path, status: d.status, binary: d.binary, hunks: d.hunks };
	if (d.oldPath !== undefined && d.oldPath !== path) f.oldPath = d.oldPath;
	if (d.lineCount > DIFF_FILE_MAX_LINES || d.bytes > DIFF_FILE_MAX_BYTES) {
		f.hunks = [];
		f.summary = `${d.changed} lines changed: open it in your editor`;
	}
	return f;
}

/** Parse the text of `git diff` into files. Never throws. */
export function parseUnifiedDiff(text: string): DiffFile[] {
	const out: DiffFile[] = [];
	const lines = text.split("\n");
	let d: Draft | undefined;
	let hunk: DiffHunk | undefined;
	let oldNo = 0;
	let newNo = 0;
	let oldLeft = 0;
	let newLeft = 0;
	const flush = () => {
		if (d) out.push(finish(d));
		d = undefined;
		hunk = undefined;
		oldLeft = newLeft = 0;
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// inside a hunk the counts say how many content lines follow
		if (d && hunk && (oldLeft > 0 || newLeft > 0)) {
			d.bytes += line.length + 1;
			d.lineCount++;
			const c = line[0];
			if (c === "+" && newLeft > 0) {
				hunk.lines.push({ kind: "+", text: cut(line.slice(1)), oldNo: null, newNo: newNo++ });
				newLeft--;
				d.changed++;
			} else if (c === "-" && oldLeft > 0) {
				hunk.lines.push({ kind: "-", text: cut(line.slice(1)), oldNo: oldNo++, newNo: null });
				oldLeft--;
				d.changed++;
			} else if (oldLeft > 0 && newLeft > 0) {
				hunk.lines.push({ kind: " ", text: cut(line.slice(1)), oldNo: oldNo++, newNo: newNo++ });
				oldLeft--;
				newLeft--;
			} else d.lineCount--;
			continue;
		}
		if (line.startsWith("diff --git ")) {
			flush();
			d = { status: "M", binary: false, hunks: [], bytes: 0, changed: 0, lineCount: 0 };
			d.path = pathFromGitLine(line.slice(11));
			d.bytes += line.length + 1;
			continue;
		}
		if (!d) continue;
		d.bytes += line.length + 1;
		if (line.startsWith("\\")) continue;
		if (line.startsWith("@@")) {
			const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!m) continue;
			oldNo = Number(m[1]);
			newNo = Number(m[3]);
			oldLeft = m[2] === undefined ? 1 : Number(m[2]);
			newLeft = m[4] === undefined ? 1 : Number(m[4]);
			hunk = { header: line, lines: [] };
			d.hunks.push(hunk);
			continue;
		}
		if (line.startsWith("new file mode")) d.status = "A";
		else if (line.startsWith("deleted file mode")) d.status = "D";
		else if (line.startsWith("rename from ")) {
			d.status = "R";
			d.oldPath = headerPath(line.slice(12), "");
		} else if (line.startsWith("rename to ")) {
			d.status = "R";
			d.toPath = headerPath(line.slice(10), "");
		} else if (line.startsWith("copy from ")) d.oldPath = headerPath(line.slice(10), "");
		else if (line.startsWith("copy to ")) {
			d.status = "A";
			d.toPath = headerPath(line.slice(8), "");
		} else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) d.binary = true;
		else if (line.startsWith("--- ")) d.fromPath = headerPath(line.slice(4), "a/");
		else if (line.startsWith("+++ ")) d.toPath = headerPath(line.slice(4), "b/") ?? d.toPath;
	}
	flush();
	return out;
}

/** Run git without a shell and read at most `cap` bytes of its output. Never throws. */
function gitText(cwd: string, args: string[], cap: number, timeout = 60_000): Promise<{ code: number; text: string; capped: boolean }> {
	return new Promise((done) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let capped = false;
		let settled = false;
		const child = spawn("git", ["-C", cwd, ...args], { env: GIT_ENV(), stdio: ["ignore", "pipe", "ignore"] });
		const end = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done({ code, text: Buffer.concat(chunks).toString("utf8"), capped });
		};
		const timer = setTimeout(() => {
			child.kill();
			end(128);
		}, timeout);
		child.stdout.on("data", (b: Buffer) => {
			if (capped) return;
			const room = cap - size;
			if (b.length > room) {
				chunks.push(b.subarray(0, room));
				size = cap;
				capped = true;
				child.kill();
			} else {
				chunks.push(b);
				size += b.length;
			}
		});
		child.on("error", () => end(128));
		child.on("close", (code) => end(capped ? 0 : (code ?? 128)));
	});
}

/** An untracked file as an added file with one all-plus hunk. */
async function untrackedFile(root: string, rel: string): Promise<DiffFile | undefined> {
	const full = join(root, rel);
	let st;
	try {
		st = await lstat(full);
	} catch {
		return undefined;
	}
	const file: DiffFile = { path: rel, status: "A", binary: false, hunks: [] };
	let buf: Buffer;
	if (st.isSymbolicLink()) {
		try {
			buf = Buffer.from(await readlink(full), "utf8");
		} catch {
			return undefined;
		}
	} else if (st.isFile()) {
		if (st.size > DIFF_FILE_MAX_BYTES) {
			file.summary = "file is too large to show: open it in your editor";
			return file;
		}
		try {
			buf = await readFile(full);
		} catch {
			return undefined;
		}
	} else return undefined;
	if (buf.subarray(0, 8000).includes(0)) {
		file.binary = true;
		return file;
	}
	const rows = buf.toString("utf8").split("\n");
	if (rows[rows.length - 1] === "") rows.pop();
	if (rows.length > DIFF_FILE_MAX_LINES) {
		file.summary = `${rows.length} lines changed: open it in your editor`;
		return file;
	}
	if (rows.length > 0) {
		file.hunks.push({
			header: `@@ -0,0 +1,${rows.length} @@`,
			lines: rows.map((t, i) => ({ kind: "+" as const, text: cut(t), oldNo: null, newNo: i + 1 })),
		});
	}
	return file;
}

/**
 * Everything the task changed against where it branched: committed and uncommitted tracked changes,
 * plus untracked files. undefined when git cannot say (no such base, worktree gone). Read-only.
 */
export async function taskDiff(path: string, baseRef: string): Promise<TaskDiff | undefined> {
	const mb = await gitText(path, ["merge-base", "HEAD", `refs/heads/${baseRef}`], 4096);
	const base = mb.text.trim();
	if (mb.code !== 0 || !base) return undefined;
	const head = await gitText(path, ["rev-parse", "HEAD"], 4096);
	const tip = head.text.trim();
	if (head.code !== 0 || !tip) return undefined;
	const [df, others] = await Promise.all([
		gitText(path, ["diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", base], DIFF_TOTAL_MAX_BYTES),
		gitText(path, ["ls-files", "--others", "--exclude-standard", "-z"], DIFF_TOTAL_MAX_BYTES),
	]);
	if (df.code !== 0) return undefined;
	let text = df.text;
	let truncated = df.capped;
	if (truncated) {
		// drop the file that was cut in the middle
		const at = text.lastIndexOf("\ndiff --git ");
		text = at < 0 ? "" : text.slice(0, at + 1);
	}
	const files = parseUnifiedDiff(text);
	if (!truncated && others.code === 0) {
		let used = Buffer.byteLength(text);
		for (const rel of others.text.split("\0").filter(Boolean)) {
			const f = await untrackedFile(path, rel);
			if (!f) continue;
			used += f.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.text.length + 2, 0), 0);
			if (used > DIFF_TOTAL_MAX_BYTES) {
				truncated = true;
				break;
			}
			files.push(f);
		}
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { base, tip, files, truncated };
}
