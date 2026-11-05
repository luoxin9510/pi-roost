// M37: core behaviours of roost with a real pi, graded by checks on what roost saw.
// ROOST_EVAL_RUNS=N repeats each case (one run never shows stability).
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostCase, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const ended = (o: { final: { state: string } | null }) => o.final?.state === "done";
const has = (s: string, w: string) => s.toUpperCase().includes(w);

describeEval("roost core", { harness: roostHarness, judgeThreshold: null }, (it) => {
	it.for(runs)("a task runs to done, its file written ($run)", async (_, { run }) => {
		const c: RoostCase = { task: "Create a file named hello.txt whose whole content is exactly: hello roost" };
		const r = await run(c);
		await expect(r).toSatisfyJudge(
			checks("task to done", {
				"done": ended,
				"working then done": (o) => o.states.indexOf("working") >= 0 && o.states.lastIndexOf("done") > o.states.indexOf("working"),
				"file written": (o) => o.files["hello.txt"]?.trim() === "hello roost",
				"cost known": (o) => (o.costUsd ?? 0) > 0,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("a reply continues the session ($run)", async (_, { run }) => {
		const r = await run({
			task: "What is 7 times 6? Answer with just the number.",
			steps: [{ when: "done", reply: "Now add 8 to that. Answer with just the number." }],
		});
		await expect(r).toSatisfyJudge(
			checks("reply continues", {
				"done": ended,
				"first answer": (o) => o.transcript.some((t) => t.kind === "assistant" && t.text.includes("42")),
				"answer uses the session": (o) => o.answer.includes("50"),
				"reply acked": (o) => o.repliesPending === 0,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("a steer joins the work under way ($run)", async (_, { run }) => {
		const r = await run({
			task: "Use the bash tool to run `sleep 12`, then tell me the word DONE.",
			steps: [{ when: "working", afterMs: 4000, reply: "Also: at the very end, say the word BANANA too.", mode: "steer" }],
		});
		await expect(r).toSatisfyJudge(
			checks("steer", {
				"done": ended,
				"did the work": (o) => has(o.answer, "DONE") || o.transcript.some((t) => t.kind === "assistant" && has(t.text, "DONE")),
				"took the steer": (o) => o.transcript.some((t) => t.kind === "assistant" && has(t.text, "BANANA")),
				// a steer joins the run: it does not wait for the work to end first (a follow-up would)
				"in the same run": (o) => o.states.slice(o.states.indexOf("reply (steer)") + 1).filter((s) => s === "done").length === 1,
				"reply acked": (o) => o.repliesPending === 0,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("a subagent reports back to its parent ($run)", async (_, { run }) => {
		const r = await run({
			task: "Use the roost_spawn tool to start one subagent with the task: Reply with exactly the word CHILD. Wait for its report to reach you, then tell me the word it replied with.",
			timeoutMs: 300_000,
		});
		await expect(r).toSatisfyJudge(
			checks("subagent", {
				"done": ended,
				"one child": (o) => o.children.length === 1,
				"child done": (o) => o.children.every((c) => c.state === "done"),
				"report reached the parent": (o) => has(o.answer, "CHILD"),
			}),
			{ threshold: null },
		);
	});
});
