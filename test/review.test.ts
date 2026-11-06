import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../lib/board.ts";
import { commentAnchor, commentOn, outdatedIn, reviewLines, termText } from "../lib/review.ts";
import type { DiffFile, TaskDiff } from "../lib/task-diff.ts";

const file: DiffFile = {
	path: "db/users.sql",
	status: "M",
	binary: false,
	hunks: [
		{
			header: "@@ -1,2 +1,3 @@",
			lines: [
				{ kind: " ", text: "create table users;", oldNo: 1, newNo: 1 },
				{ kind: "-", text: "drop index x;", oldNo: 2, newNo: null },
				{ kind: "+", text: "drop table users;", oldNo: null, newNo: 2 },
				{ kind: "+", text: "\t-- rollback", oldNo: null, newNo: 3 },
			],
		},
	],
};
const c = (line: number, lineText: string, text: string, f = "db/users.sql"): ReviewComment => ({ file: f, line, lineText, text, tip: "", at: 0 });

describe("M58: comments on a diff", () => {
	it("a comment is on its line while the line is there (number and text); else outdated", () => {
		const added = file.hunks[0]!.lines[2]!;
		expect(commentAnchor(added)).toEqual({ line: 2, lineText: "+drop table users;" });
		expect(commentAnchor(file.hunks[0]!.lines[1]!)).toEqual({ line: 2, lineText: "-drop index x;" });
		expect(commentOn(c(2, "+drop table users;", "x"), "db/users.sql", added)).toBe(true);
		// a comment kept without its text matches by number
		expect(commentOn(c(2, "", "x"), "db/users.sql", added)).toBe(true);
		expect(commentOn(c(2, "+drop table users;", "x", "other.sql"), "db/users.sql", added)).toBe(false);
		expect(outdatedIn(file, [c(2, "+drop table users;", "fine"), c(2, "+drop table people;", "moved")]).map((x) => x.text)).toEqual(["moved"]);
	});

	it("the review as text: files, hunks, comments under their lines, outdated ones and others", () => {
		const d: TaskDiff = { base: "a".repeat(40), tip: "b".repeat(40), files: [file, { path: "logo.png", status: "A", binary: true, hunks: [] }], truncated: true };
		const lines = reviewLines(d, [c(2, "+drop table users;", "drop the index first"), c(9, "+old", "stale"), c(1, "", "elsewhere", "README.md")]);
		expect(lines).toContain("M db/users.sql");
		expect(lines).toContain("  ✎ outdated (line 9): stale");
		expect(lines).toContain("    2 + drop table users;");
		expect(lines[lines.indexOf("    2 + drop table users;") + 1]).toBe("        └ ✎ drop the index first");
		expect(lines).toContain("    3 +     -- rollback");
		expect(lines).toContain("  binary file");
		expect(lines).toContain("✎ README.md:1 (not in the diff now): elsewhere");
		expect(lines.at(-1)).toContain("cut short");
	});

	it("names and comments reach a terminal without its control characters", () => {
		expect(termText("a\x1b[2Jb\nc\x9bd\te")).toBe("a [2Jb c d    e");
		const d: TaskDiff = { base: "", tip: "", truncated: false, files: [{ path: "x\x1b[2J.txt", status: "A", binary: true, hunks: [] }] };
		expect(reviewLines(d, [c(1, "", "line\none", "x\x1b[2J.txt")]).join("\n")).not.toMatch(/[\x1b\x9b]/);
	});
});
