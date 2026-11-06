// M62: the ADE loop with a real model (docs/plans/ade-roadmap.md, M54–M60): a task started
// in its own worktree as /tasks start does; the session works there, commits, and calls
// roost_task_done; the repository's verify runs; a failure goes back to the session with
// its output, the session fixes it; review; the user merges into base locally.
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostOutcome, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const token = () => randomBytes(3).toString("hex");
const stages = (o: RoostOutcome) => o.taskEvents.filter((e) => e.why === "stage").map((e) => e.text);

describeEval("roost workspaces", { harness: roostHarness, judgeThreshold: null }, (it) => {
	it.for(runs)("a task in its worktree: committed, verified, in review, merged into base ($run)", async (_, { run }) => {
		const t = token();
		const r = await run({
			task: "",
			git: true,
			files: { "check.sh": `#!/bin/sh\ngrep -qx "TOKEN-${t}" token.txt || { echo "token.txt must hold exactly the line TOKEN-${t}"; exit 1; }\necho ok\n` },
			workspace: {
				title: `Write token.txt`,
				detail: `Create the file token.txt at the top of the repository with exactly one line: TOKEN-${t}`,
				verify: "sh check.sh",
				approve: true,
				merge: true,
			},
			timeoutMs: 300_000,
		});
		await expect(r).toSatisfyJudge(
			checks("workspace loop", {
				"it went to review through verify": (o) => stages(o).some((s) => s.includes("verifying")) && stages(o).some((s) => s.includes("in review")),
				"verify passed": (o) => o.workspace?.verifyOk === true,
				"the user's merge went into main": (o) => o.workspace?.stage === "merged" && (o.workspace.merged ?? "").startsWith("merged into main"),
				"main has the work, committed by the session": (o) => (o.files["token.txt"] ?? "").trim() === `TOKEN-${t}` && (o.workspace?.baseLog.length ?? 0) >= 2,
				"the worktree is gone after the merge": (o) => o.workspace?.worktreeLeft === false,
				"the session never merged": (o) => !o.taskEvents.some((e) => e.why === "stage" && e.text.includes("merg") && e.who !== "user" && e.who !== "roost"),
				"cheap": (o) => (o.costUsd ?? 1) < 0.15,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("verify fails on what only it knows; the session reads the output, fixes, passes ($run)", async (_, { run }) => {
		const t = token();
		// the exact greeting is said only by the check's failure
		const want = `Hello, Ada! Welcome to roost ${t}.`;
		const r = await run({
			task: "",
			git: true,
			files: {
				"check.sh": `#!/bin/sh\ngot=$(sh greet.sh Ada 2>&1)\n[ "$got" = "${want}" ] || { echo "greet.sh Ada printed: $got"; echo "expected exactly: ${want}"; exit 1; }\necho ok\n`,
			},
			workspace: {
				title: "Write greet.sh",
				detail: "Create greet.sh: a POSIX sh script that prints a greeting for the name given as its first argument (sh greet.sh Ada).",
				verify: "sh check.sh",
				maxRounds: 3,
				approve: true,
				merge: true,
			},
			timeoutMs: 400_000,
		});
		await expect(r).toSatisfyJudge(
			checks("workspace verify loop", {
				"a verify failed and went back to the session": (o) => stages(o).some((s) => s.includes("working") && s.includes("verify failed")),
				"then it passed": (o) => o.workspace?.verifyOk === true,
				"merged into main": (o) => o.workspace?.stage === "merged",
				"main's greet.sh prints what the check wants": (o) => (o.files["greet.sh"] ?? "").includes("Welcome to roost"),
				"cheap": (o) => (o.costUsd ?? 1) < 0.25,
			}),
			{ threshold: null },
		);
	});
});
