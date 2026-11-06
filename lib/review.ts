// M58: a task's review: where a comment sits on a diff, and the review as text (the CLI's).
import type { ReviewComment } from "./board.ts";
import type { DiffFile, DiffLine, TaskDiff } from "./task-diff.ts";

/** Where a comment on this line is kept: its number (new side, else old) and its text with its kind. */
export const commentAnchor = (l: DiffLine): { line: number; lineText: string } => ({ line: l.newNo ?? l.oldNo ?? 0, lineText: `${l.kind}${l.text}` });

/** The comment is about this line: same file, same number, and (when it kept it) the same text. */
export function commentOn(c: ReviewComment, file: string, l: DiffLine): boolean {
	const a = commentAnchor(l);
	return c.file === file && c.line === a.line && (!c.lineText || c.lineText === a.lineText);
}

/** The comments of a file not under any of its lines now (the line moved or changed): outdated, kept. */
export function outdatedIn(f: DiffFile, comments: ReviewComment[]): ReviewComment[] {
	return comments.filter((c) => c.file === f.path && !f.hunks.some((h) => h.lines.some((l) => commentOn(c, f.path, l))));
}

/** The review as plain lines: each file, its hunks, the comments under their lines; comments on files not in the diff last. */
export function reviewLines(d: TaskDiff, comments: ReviewComment[]): string[] {
	const out: string[] = [];
	const clean = (s: string) => s.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
	for (const f of d.files) {
		out.push(`${f.status} ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`);
		for (const c of outdatedIn(f, comments)) out.push(`  ✎ outdated (line ${c.line}): ${c.text}`);
		if (f.summary) out.push(`  ${f.summary}`);
		else if (f.binary) out.push("  binary file");
		for (const h of f.hunks) {
			out.push(`  ${clean(h.header)}`);
			for (const l of h.lines) {
				out.push(`${String(l.newNo ?? l.oldNo ?? "").padStart(5)} ${l.kind} ${clean(l.text)}`);
				for (const c of comments) if (commentOn(c, f.path, l)) out.push(`        └ ✎ ${c.text}`);
			}
		}
		out.push("");
	}
	const files = new Set(d.files.map((f) => f.path));
	const elsewhere = comments.filter((c) => !files.has(c.file));
	for (const c of elsewhere) out.push(`✎ ${c.file}:${c.line} (not in the diff now): ${c.text}`);
	if (d.files.length === 0) out.push("nothing changed against base");
	if (d.truncated) out.push("(the diff was cut short: it is larger than pi-roost shows)");
	return out;
}
