// M37: core behaviours of roost with a real pi, graded by checks on what roost saw.
// ROOST_EVAL_RUNS=N repeats each case (one run never shows stability).
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostCase, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const ended = (o: { final: { state: string } | null }) => o.final?.state === "done";
// Words no sentence has by chance, matched as written, in the last answer: a mention of
// "plum" or "when done" must not pass for the thing itself.

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
			task: "Use the bash tool to run `sleep 12`. When it has finished, reply with the word SLEPT-4X.",
			steps: [{ when: "working", afterMs: 4000, reply: "Also: in your final reply, add the word PLUM-9K.", mode: "steer" }],
		});
		await expect(r).toSatisfyJudge(
			checks("steer", {
				"done": ended,
				"did the work": (o) => o.transcript.some((t) => t.kind === "tool" && t.text.includes("sleep 12")) && o.answer.includes("SLEPT-4X"),
				"took the steer": (o) => o.answer.includes("PLUM-9K"),
				// a steer joins the run: it does not wait for the work to end first (a follow-up would)
				"in the same run": (o) => o.states.slice(o.states.indexOf("reply (steer)") + 1).filter((s) => s === "done").length === 1,
				"reply acked": (o) => o.repliesPending === 0,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("a subagent reports back to its parent ($run)", async (_, { run }) => {
		// only the subagent reads it: the parent can know it from the report alone
		const secret = `K${randomBytes(4).toString("hex").toUpperCase()}`;
		const r = await run({
			task: "Use the roost_spawn tool to start one subagent with this task: Read the file secret.txt and reply with its content only. Do not read secret.txt yourself. Wait for the subagent's report to reach you, then tell me the content it found.",
			files: { "secret.txt": `${secret}\n` },
			timeoutMs: 300_000,
		});
		await expect(r).toSatisfyJudge(
			checks("subagent", {
				"done": ended,
				"one child": (o) => o.children.length === 1,
				"child done": (o) => o.children.every((c) => c.state === "done"),
				"parent did not read it": (o) => !o.transcript.some((t) => t.kind === "tool" && !t.text.startsWith("roost_") && t.text.includes("secret.txt")),
				"report reached the parent": (o) => o.answer.includes(secret),
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("a run killed mid-work carries on by itself ($run)", async (_, { run }) => {
		const r = await run({
			task: "Use the bash tool to run `sleep 15`. After it, create a file named result.txt whose whole content is exactly: carried on",
			steps: [{ when: "working", afterMs: 6000, kill: "worker" }],
			timeoutMs: 240_000,
		});
		await expect(r).toSatisfyJudge(
			checks("interrupted", {
				"done": ended,
				"killed, then working again": (o) => o.states.indexOf("kill") >= 0 && o.states.slice(o.states.indexOf("kill")).includes("done"),
				"one automatic restart": (o) => o.restarts === 1,
				"the work finished": (o) => o.files["result.txt"]?.trim() === "carried on",
			}),
			{ threshold: null },
		);
	});
});
