// M44: the concierge with a real model: does it notice what needs the user (a question, a
// failure, a finished run) in its first wakes, say so once, and stay out of the sessions'
// business; and does it relay a finding from one session to another when asked.
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostCase, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const token = () => randomBytes(3).toString("hex");

describeEval("roost concierge", { harness: roostHarness, judgeThreshold: null }, (it) => {
	it.for(runs)("reports a question, a failure and a finished run; answers nothing in the user's place ($run)", async (_, { run }) => {
		const t = token();
		const asker = `branch-${t}`;
		const failer = `lint-${t}`;
		const c: RoostCase = {
			concierge: true,
			task: `Reply with exactly this and nothing else: DONE-${t}`,
			extra: [
				{ name: asker, task: "You need one thing from the user before you can start: which git branch to work on, main or dev. Ask the user that one question, as a question, and stop. Do nothing else and do not guess." },
				{ name: failer, command: ["sh", "-c", "echo 'lint: 3 errors'; exit 1"] },
			],
			timeoutMs: 240_000,
		};
		const r = await run(c);
		const said = (o: { concierge: { notices: { text: string }[] } | null }, what: string) => (o.concierge?.notices ?? []).some((n) => n.text.toLowerCase().includes(what.toLowerCase()));
		await expect(r).toSatisfyJudge(
			checks("concierge reports", {
				"it was woken, and not too often": (o) => (o.concierge?.wakes ?? 0) >= 1 && (o.concierge?.wakes ?? 0) <= 6,
				"it told the user something": (o) => (o.concierge?.notices.length ?? 0) >= 1,
				"the question was reported, as needing the user": (o) => (o.concierge?.notices ?? []).some((n) => n.kind === "need" && n.text.includes(asker)),
				"the failure was reported": (o) => said(o, failer),
				"the finished run was reported": (o) => said(o, `DONE-${t}`) || said(o, "finished") || said(o, "done") || said(o, "complete") || said(o, "ended"),
				"not more than one notice per thing": (o) => (o.concierge?.notices.length ?? 0) <= 4,
				"it answered no session in the user's place": (o) => (o.concierge?.sent ?? []).every((m) => m.to !== asker),
				"the asking session still waits for the user": (o) => o.extra.find((x) => x.name === asker)?.state === "blocked",
				"the run finished": (o) => o.final?.state === "done",
				"cheap": (o) => (o.concierge?.costUsd ?? 1) < 0.05,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("relays a finding from one session to another when asked ($run)", async (_, { run }) => {
		const t = token();
		const port = 4000 + (parseInt(t, 16) % 900);
		const api = `api-${t}`;
		const r = await run({
			concierge: true,
			task: `Reply with exactly this and nothing else: the service listens on port ${port}`,
			extra: [{ name: api, task: "Reply with exactly: ready. Later a message from the concierge will tell you a port number; when it does, reply with exactly PORT=<that number> and nothing else." }],
			steps: [{ when: "done", ask: `Tell the session ${api} the port number the eval session found. Use hub_send; say where the number comes from.` }],
			timeoutMs: 240_000,
		});
		await expect(r).toSatisfyJudge(
			checks("concierge relays", {
				"it sent the number to the right session": (o) => (o.concierge?.sent ?? []).some((m) => m.to === api && m.text.includes(String(port))),
				"that session took it up": (o) => o.extra.find((x) => x.name === api)?.answer.includes(`PORT=${port}`) === true,
				"it answered the user": (o) => (o.concierge?.answers.length ?? 0) >= 1,
				"the run finished": (o) => o.final?.state === "done",
				"cheap": (o) => (o.concierge?.costUsd ?? 1) < 0.05,
			}),
			{ threshold: null },
		);
	});
});
