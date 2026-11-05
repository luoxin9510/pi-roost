// M47: the shared task board with a real model: does a session work the board (read it,
// claim an open task, do it, mark it done, take the next; one that waited on the first
// becomes claimable once it is done); does the concierge, as the lead, hand an open task
// to an idle session (never claiming one itself), and does that session take it up.
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostCase, type RoostOutcome, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const token = () => randomBytes(3).toString("hex");

const WORKER = "You are one worker on a team that shares a task board. Loop: read the board (roost_tasks); if a task is open (not blocked, not claimed), claim it (roost_task_claim), do exactly what it says, then mark it done (roost_task_done, with a one-line result); then read the board again. A claim refused as blocked or conflict is not yours: take another. When no task is open or blocked, stop and reply with exactly this and nothing else: ";

describeEval("roost task board", { harness: roostHarness, judgeThreshold: null }, (it) => {
	it.for(runs)("a session works the board: claims, does, marks done; a task that waited becomes claimable ($run)", async (_, { run }) => {
		const t = token();
		const c: RoostCase = {
			tasks: [
				{ title: `Write the file alpha.txt in the working directory with exactly one line: ALPHA-${t}` },
				{ title: `Write the file beta.txt in the working directory with exactly one line: BETA-${t} (alpha.txt exists by then: do not touch it)`, after: [1] },
			],
			task: `${WORKER}DONE-${t}`,
			timeoutMs: 240_000,
		};
		const r = await run(c);
		const ev = (o: RoostOutcome, why: string) => o.taskEvents.filter((e) => e.why === why);
		await expect(r).toSatisfyJudge(
			checks("task board worked", {
				"both tasks are done": (o) => o.board.length === 2 && o.board.every((x) => x.state === "done"),
				"both were claimed by the session, then done": (o) => ev(o, "claim").length >= 2 && ev(o, "done").length === 2,
				"#2 was claimed only after #1 was done": (o) => {
					const done1 = o.taskEvents.findIndex((e) => e.why === "done" && e.text.startsWith("#1 "));
					const claim2 = o.taskEvents.findIndex((e) => e.why === "claim" && e.text.startsWith("#2 "));
					return done1 >= 0 && claim2 > done1;
				},
				"the files say so": (o) => (o.files["alpha.txt"] ?? "").includes(`ALPHA-${t}`) && (o.files["beta.txt"] ?? "").includes(`BETA-${t}`),
				"the run finished with the word": (o) => o.final?.state === "done" && o.answer.includes(`DONE-${t}`),
				"cheap": (o) => (o.costUsd ?? 1) < 0.1,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("the concierge leads: an open task is handed to an idle session, which takes it up; it claims none itself ($run)", async (_, { run }) => {
		const t = token();
		const worker = `worker-${t}`;
		const r = await run({
			concierge: true,
			tasks: [{ title: `Write the file gamma.txt in the working directory with exactly one line: GAMMA-${t}`, detail: "A small file; say its path in the result." }],
			task: `Reply with exactly this and nothing else: DONE-${t}`,
			extra: [
				{
					name: worker,
					task: "Reply with exactly: ready. Then wait. If a message hands you a task from the board (Task #n), claim it (roost_task_claim), do exactly what it says, mark it done (roost_task_done, with a one-line result), and reply with exactly: did it.",
				},
			],
			// time for the digest with the idle worker and the open task, the hand-over, and the work
			steps: [{ when: "done", waitMs: 90_000 }],
			timeoutMs: 300_000,
		});
		await expect(r).toSatisfyJudge(
			checks("task board led", {
				"the concierge handed the task to the worker": (o) => o.taskEvents.some((e) => e.why === "assign" && e.who === "concierge" && e.text.includes(worker)),
				"the worker claimed it and marked it done": (o) => o.taskEvents.some((e) => e.why === "claim" && e.who === worker) && o.board[0]?.state === "done",
				"the concierge claimed nothing itself": (o) => !o.taskEvents.some((e) => e.why === "claim" && e.who === "concierge"),
				"the file says so": (o) => (o.files["gamma.txt"] ?? "").includes(`GAMMA-${t}`),
				"the run finished": (o) => o.final?.state === "done",
				"cheap": (o) => (o.concierge?.costUsd ?? 1) < 0.1,
			}),
			{ threshold: null },
		);
	});
});
