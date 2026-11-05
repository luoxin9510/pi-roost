import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checks, type RoostOutcome } from "../evals/harness.ts";

const outcome = (o: Partial<RoostOutcome> = {}): RoostOutcome => ({
	ok: true,
	error: null,
	final: { state: "done", status: "idle", waitingFor: null, summary: null, question: null, error: null },
	states: ["working", "done"],
	answer: "42",
	transcript: [],
	files: {},
	children: [],
	repliesPending: 0,
	costUsd: 0.001,
	tokens: 10,
	ms: 1000,
	ackP50: null,
	...o,
});

describe("M37 eval checks", () => {
	const saved = process.env.ROOST_EVAL_DIR;
	afterEach(() => {
		if (saved === undefined) delete process.env.ROOST_EVAL_DIR;
		else process.env.ROOST_EVAL_DIR = saved;
	});

	it("scores the share of checks that pass and names the ones that fail", () => {
		delete process.env.ROOST_EVAL_DIR;
		const j = checks("c", { done: (o) => o.final?.state === "done", answer: (o) => o.answer === "50", throws: () => { throw new Error("x"); } });
		const r = j.assess({ output: outcome() });
		expect(r.score).toBeCloseTo(1 / 3);
		expect(r.metadata.rationale).toBe("failed: answer, throws");
	});

	it("a run that could not finish scores 0, whatever its checks say", () => {
		delete process.env.ROOST_EVAL_DIR;
		const r = checks("c", { anything: () => true }).assess({ output: outcome({ ok: false, error: "timed out" }) });
		expect(r.score).toBe(0);
		expect(r.metadata.rationale).toBe("all checks pass");
	});

	it("keeps each result as an observation", () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-evals-"));
		process.env.ROOST_EVAL_DIR = dir;
		checks("c", { done: () => false }).assess({ output: outcome() });
		const obs = JSON.parse(readFileSync(join(dir, "observations.jsonl"), "utf8").trim());
		expect(obs).toMatchObject({ case: "c", score: 0, failed: ["done"], costUsd: 0.001 });
	});
});
