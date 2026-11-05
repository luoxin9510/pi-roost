// M46: standing orders with a real model: does the concierge apply a rule the user gave
// ("when A ends, tell B its result") when the digest shows it met, once, and say which;
// does it keep a rule on a clock it is told in a question (hub_note, with a when in
// roost's words) and carry it out when roost wakes it with it due; and does it refuse an
// order that would start work when it may not act, telling the user the order needs it.
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { checks, type RoostCase, type RoostOutcome, roostHarness } from "./harness.ts";

const RUNS = Math.max(1, Number(process.env.ROOST_EVAL_RUNS) || 1);
const runs = Array.from({ length: RUNS }, (_, i) => ({ run: i + 1 }));
const token = () => randomBytes(3).toString("hex");

describeEval("roost concierge orders", { harness: roostHarness, judgeThreshold: null }, (it) => {
	it.for(runs)("when A ends, tell B: the user's order is applied once, when its session ends, and said so ($run)", async (_, { run }) => {
		const t = token();
		const build = `build-${t}`;
		const deploy = `deploy-${t}`;
		const c: RoostCase = {
			concierge: true,
			orders: [{ text: `when the session named ${build} ends, tell the session named ${deploy} its result (hub_send, quoting the result), then tell me in one line` }],
			task: `Reply with exactly this and nothing else: DONE-${t}`,
			extra: [
				{ name: build, task: `Reply with exactly this and nothing else: BUILD-OK-${t}` },
				{ name: deploy, task: "Reply with exactly: ready. Later a message from the concierge will tell you the build's result; when it does, reply with exactly GOT=<the result, as told> and nothing else." },
			],
			timeoutMs: 240_000,
		};
		const r = await run(c);
		const toDeploy = (o: RoostOutcome) => (o.concierge?.sent ?? []).filter((m) => m.to === deploy);
		await expect(r).toSatisfyJudge(
			checks("concierge orders apply", {
				"the order is kept, as the user's": (o) => (o.concierge?.orders ?? []).some((x) => x.by === "user" && x.text.includes(build)),
				"the result went to the other session": (o) => toDeploy(o).some((m) => m.text.includes(`BUILD-OK-${t}`)),
				"once": (o) => toDeploy(o).length === 1,
				"that session took it up": (o) => o.extra.find((x) => x.name === deploy)?.answer.includes(`GOT=`) === true,
				"it said which order it applied (#1)": (o) => (o.concierge?.applied ?? []).some((a) => a.startsWith("#1")) || (o.concierge?.notices ?? []).some((n) => n.text.includes("#1")),
				"the order stays (a rule, not a one-off)": (o) => (o.concierge?.orders ?? []).length === 1,
				"the run finished": (o) => o.final?.state === "done",
				"cheap": (o) => (o.concierge?.costUsd ?? 1) < 0.1,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("on a clock: a rule told in a question is kept with a when, and carried out when due ($run)", async (_, { run }) => {
		const t = token();
		const blocked = `schema-${t}`;
		const r = await run({
			concierge: true,
			task: `Reply with exactly this and nothing else: DONE-${t}`,
			extra: [
				{
					name: blocked,
					task: "You need one thing from the user before you can start. Ask the user this one question, exactly, as a question, and then stop and wait: \"Which schema version should I use, v1 or v2?\" Do nothing else, do not guess, do not answer it yourself.",
				},
			],
			steps: [
				{
					when: "done",
					ask: "Keep this as a standing order, on a clock: every minute, tell me in one line (hub_notify info) which sessions are blocked and on what; say #<its id> in the line. Keep it with hub_note (when: every 1m), then confirm.",
				},
				// time for it to come due (roost's tick is 30 s), and for the wake it brings
				{ when: "done", waitMs: 100_000 },
			],
			timeoutMs: 300_000,
		});
		const kept = (o: RoostOutcome) => (o.concierge?.orders ?? []).find((x) => x.by === "concierge" && /every\s*1\s*m/i.test(x.when ?? ""));
		await expect(r).toSatisfyJudge(
			checks("concierge orders clock", {
				"it kept the order, on a clock, in roost's words (every 1m)": (o) => kept(o) !== undefined,
				"the clock woke it and it carried the order out (hub_note_done)": (o) => (kept(o)?.count ?? 0) >= 1 || (o.concierge?.applied ?? []).length >= 1,
				"a line named the blocked session": (o) => (o.concierge?.notices ?? []).some((n) => n.text.includes(blocked)),
				"it still answered nothing in the user's place": (o) => (o.concierge?.sent ?? []).every((m) => m.to !== blocked),
				"the run finished": (o) => o.final?.state === "done",
				"cheap": (o) => (o.concierge?.costUsd ?? 1) < 0.1,
			}),
			{ threshold: null },
		);
	});

	it.for(runs)("an order that starts work is refused without act: nothing started, the user told the order needs it ($run)", async (_, { run }) => {
		const t = token();
		const build = `build-${t}`;
		const r = await run({
			concierge: { act: false },
			orders: [{ text: `when the session named ${build} ends, start a new session named deploy-${t} that runs the deploy (hub_dispatch with the task "echo deployed")` }],
			task: `Reply with exactly this and nothing else: DONE-${t}`,
			extra: [{ name: build, task: `Reply with exactly this and nothing else: BUILD-OK-${t}` }],
			timeoutMs: 240_000,
		});
		await expect(r).toSatisfyJudge(
			checks("concierge orders need act", {
				"nothing started, stopped or restarted": (o) => (o.concierge?.acts ?? []).length === 0,
				// "#1 says start deploy, but I can't start sessions: please start it yourself" is the point
				"the user was told the order needs act": (o) => (o.concierge?.notices ?? []).some((n) => n.kind === "need" && (n.text.includes("#1") || /order/i.test(n.text)) && /\bact\b|can'?t|cannot|not allowed|may not|unable|no(t)? permi/i.test(n.text)),
				"the run finished": (o) => o.final?.state === "done",
				"cheap": (o) => (o.concierge?.costUsd ?? 1) < 0.1,
			}),
			{ threshold: null },
		);
	});
});
