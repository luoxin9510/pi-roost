import { describe, expect, it } from "vitest";
import { checksOf, hyperlink, linkStep, prFromGh, prLabel, prQuery, prUrlsIn, readyForReview } from "../lib/pr.ts";
import { registerPrLinks } from "../adapters/pi/pr-links.ts";

const U = "https://github.com/o/r/pull/12";

describe("pull requests", () => {
	it("finds links the way Claude Code does", () => {
		expect(prUrlsIn(`Created ${U}\nsee ${U}/files and https://github.com/o/r/issues/3`)).toEqual([U]);
		expect(linkStep("gh pr create --fill", `${U}\n`)).toEqual({ urls: [U], lookup: false, retry: true });
		expect(linkStep("gh pr merge 12", `${U}`).urls).toEqual([]);
		expect(linkStep("cd x && git push -u origin HEAD", "")).toMatchObject({ lookup: true });
		expect(linkStep("gh pr checkout 12", "")).toMatchObject({ lookup: true });
		expect(linkStep("ls", "")).toEqual({ urls: [], lookup: false, retry: false });
	});

	it("reads gh's view: checks, review, state", () => {
		expect(checksOf([])).toBe("none");
		expect(checksOf([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("passing");
		expect(checksOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
		expect(checksOf([{ conclusion: "FAILURE" }, { status: "QUEUED" }])).toBe("failing");
		const base = { number: 12, url: U, state: "OPEN", isDraft: false };
		expect(prFromGh({ ...base, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }] })).toMatchObject({ status: "passing", needsReview: false });
		expect(prFromGh({ ...base, reviewDecision: "", statusCheckRollup: [] })).toMatchObject({ status: "passing", needsReview: true });
		expect(prFromGh({ ...base, reviewDecision: "REVIEW_REQUIRED" })).toMatchObject({ status: "pending", needsReview: true });
		expect(prFromGh({ ...base, reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "FAILURE" }] })).toMatchObject({ status: "failing", needsReview: true });
		expect(prFromGh({ ...base, isDraft: true })).toMatchObject({ status: "draft", needsReview: false });
		expect(prFromGh({ ...base, state: "MERGED" })).toMatchObject({ status: "merged" });
		expect(prFromGh({ ...base, state: "CLOSED" })).toMatchObject({ status: "closed" });
		expect(prFromGh({ url: U })).toBeUndefined();
	});

	it("labels, colours, links, readiness, queries", async () => {
		const a = { number: 7, url: U, status: "merged" as const, needsReview: false };
		const b = { number: 9, url: "https://github.com/o/r/pull/9", status: "failing" as const, needsReview: true };
		expect(prLabel([a])).toEqual({ text: "#7", tone: "accent", url: U });
		expect(prLabel([a, b])).toEqual({ text: "2 PRs", tone: "warning" });
		expect(prLabel([])).toBeUndefined();
		expect(readyForReview([a])).toBe(false);
		expect(readyForReview([a, b])).toBe(true);
		expect(hyperlink("#7", U, {})).toBe(`\u001b]8;;${U}\u0007#7\u001b]8;;\u0007`);
		expect(hyperlink("#7", U, { FORCE_HYPERLINK: "0" })).toBe("#7");
		expect(prQuery("#12")).toEqual({ number: 12 });
		expect(prQuery(U)).toEqual({ number: 12, url: U });
		expect(prQuery("fix #12")).toBeUndefined();
		expect(prQuery(`${U}/files`)).toEqual({ number: 12, url: U });
		expect(prQuery(`${U}#discussion_r1`)).toEqual({ number: 12, url: U });
		expect(prUrlsIn("https://github.com/o/r/pull/12abc http://localhost/o/r/pull/3 http://10.0.0.1/o/r/pull/4")).toEqual([]);
		const { rowHasPr } = await import("../lib/pr.ts");
		expect(rowHasPr([{ number: 12, url: U, status: "passing", needsReview: false }], { number: 12, url: "http://GitHub.com/o/r/pull/12" })).toBe(true);
		expect(checksOf([{ conclusion: "CANCELLED" }])).toBe("passing");
		expect(checksOf([{ state: "PENDING" }])).toBe("pending");
	});

	it("the worker links what gh prints and looks the branch up after a push, retrying", async () => {
		const on = new Map<string, (e: any, c?: any) => void>();
		const pi = { on: (k: string, f: (e: any) => void) => on.set(k, f) } as never;
		let changed = 0;
		const answers: (string | undefined)[] = [undefined, undefined, "https://github.com/o/r/pull/30"];
		const links = registerPrLinks(pi, () => changed++, async () => answers.shift());
		on.get("session_start")!({}, { cwd: "/w" });
		const run = async (id: string, command: string, text = "") => {
			on.get("tool_execution_start")!({ toolName: "bash", toolCallId: id, args: { command } });
			on.get("tool_execution_end")!({ toolName: "bash", toolCallId: id, result: { content: [{ type: "text", text }] }, isError: false });
			await new Promise((r) => setTimeout(r, 5));
		};
		await run("1", "gh pr comment 12 -b hi", `${U}#issuecomment-1`);
		expect(links.links()).toEqual([U]);
		await run("2", "git push origin HEAD");
		expect(links.links()).toHaveLength(1);
		await run("3", "git status");
		await run("4", "ls"); // not a retry
		await run("5", "gh api repos/o/r/pulls -f title=x");
		expect(links.links()).toEqual([U, "https://github.com/o/r/pull/30"]);
		expect(changed).toBe(2);
	});
});
