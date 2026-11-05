// M41: the other agents roost runs, with real models: one task on two models in their
// own worktrees (fan-out), pi as a terminal agent (level 0: a typed reply, stop and a
// resume), and a protocol agent (level 1, Python client) driven by pi's print mode.
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostCase, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const ended = (o: { final: { state: string } | null }) => o.final?.state === "done";
const SECOND_MODEL = process.env.ROOST_EVAL_SECOND_MODEL ?? "anthropic/claude-haiku-4-5";

describeEval("roost agents", { harness: roostHarness, judgeThreshold: null }, (it) => {
	it.for(runs)("one task on two models, each in its own worktree ($run)", async (_, { run }) => {
		const c: RoostCase = {
			task: "Create a file named note.txt whose whole content is exactly: from a fan-out",
			git: true,
			fanout: [process.env.ROOST_EVAL_MODEL ?? "anthropic/claude-haiku-5-5", SECOND_MODEL],
			timeoutMs: 240_000,
		};
		const r = await run(c);
		await expect(r).toSatisfyJudge(
			checks("fan-out", {
				"two sessions, one fan-out": (o) => o.fanout.length === 2 && new Set(o.fanout.map((f) => f.fanout)).size === 1 && o.fanout[0]!.fanout !== null,
				"both done": (o) => o.fanout.every((f) => f.state === "done"),
				"each in its own worktree": (o) => new Set(o.fanout.map((f) => f.branch)).size === 2 && o.fanout.every((f) => f.branch?.startsWith("roost/")),
				"each wrote the file there": (o) => o.fanout.every((f) => f.files["note.txt"]?.trim() === "from a fan-out"),
				"the main tree untouched": (o) => !("note.txt" in o.files),
				"/compare sees the change": (o) => o.fanout.every((f) => f.change !== null && f.change.files + f.change.untracked === 1),
				"two models": (o) => new Set(o.fanout.map((f) => f.model)).size === 2,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("pi as a terminal agent: read from its screen, a typed reply, stop and resume ($run)", async (_, { run }) => {
		const r = await run({
			agent: "term",
			task: "What is 6 times 7? Answer with just the number.",
			steps: [
				{ when: "done", reply: "Now add 8 to that. Answer with just the number." },
				{ when: "done", stop: true },
				{ when: "stopped", reply: "Now add 1 more. Answer with just the number." },
			],
			timeoutMs: 240_000,
		});
		await expect(r).toSatisfyJudge(
			checks("terminal agent", {
				"working seen from the screen": (o) => o.states.indexOf("working") >= 0,
				"done from the screen": (o) => o.states.indexOf("done") > o.states.indexOf("working"),
				"first answer on screen": (o) => o.screen.includes("42"),
				"the typed reply was answered": (o) => o.screen.includes("50"),
				"stopped, then resumed by a reply": (o) => o.states.includes("stop") && o.states.slice(o.states.indexOf("stop")).includes("working"),
				"the resumed session kept its context": (o) => o.screen.includes("51") && o.command.includes("--continue"),
				"ends done": ended,
				"nothing pending": (o) => o.repliesPending === 0,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("a protocol agent (Python client) driven by pi's print mode ($run)", async (_, { run }) => {
		const r = await run({
			agent: "protocol",
			task: "What is 6 times 7? Answer with just the number.",
			steps: [{ when: "done", reply: "Now add 8 to that. Answer with just the number." }],
			timeoutMs: 240_000,
		});
		await expect(r).toSatisfyJudge(
			checks("protocol agent", {
				"said hello": (o) => (o.capabilities ?? []).includes("replies") && o.agentName === "pi-print",
				"the first task came as a reply, reported done": (o) => o.states.indexOf("done") > 0,
				"its report is the answer": (o) => o.summaries.some((s) => s.includes("42")),
				"the reply had the first turn's context": (o) => o.final?.summary?.includes("50") === true,
				"ends done": ended,
				"replies acked": (o) => o.repliesPending === 0,
				"the model it reported": (o) => o.final !== null && o.model === (process.env.ROOST_EVAL_MODEL ?? "anthropic/claude-haiku-5-5"),
			}),
			{ threshold: null },
		);
	});
});
