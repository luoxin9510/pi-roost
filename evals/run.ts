/**
 * M37: npm run eval [-- --runs N --model provider/id --thinking level --only text]
 * Runs the eval suites with real models into evals/.runs/<time>/ and writes a report:
 * pass rate per case over its runs, the checks that failed, flaky cases, cost and time.
 * One run never claims stability; a run that could not be scored is counted as such.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { percentiles } from "../lib/telemetry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k: string) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(ROOT, "evals", ".runs", stamp);
mkdirSync(dir, { recursive: true });
const env: NodeJS.ProcessEnv = {
	...process.env,
	ROOST_EVAL_DIR: dir,
	ROOST_EVAL_RUNS: opt("runs") ?? process.env.ROOST_EVAL_RUNS ?? "1",
};
if (opt("model")) env.ROOST_EVAL_MODEL = opt("model");
if (opt("thinking")) env.ROOST_EVAL_THINKING = opt("thinking");
const protocol = {
	at: new Date().toISOString(),
	model: env.ROOST_EVAL_MODEL ?? "anthropic/claude-haiku-5-5",
	thinking: env.ROOST_EVAL_THINKING ?? "low",
	runs: Number(env.ROOST_EVAL_RUNS),
	only: opt("only") ?? null,
};
writeFileSync(join(dir, "protocol.json"), `${JSON.stringify(protocol, null, 2)}\n`);
const only = opt("only");
const vitest = ["vitest", "run", "--config", "vitest.evals.config.ts", ...(only ? ["-t", only] : [])];
const res = spawnSync("npx", vitest, { cwd: ROOT, env, stdio: "inherit" });

type Obs = { case: string; score: number; failed: string[]; error: string | null; costUsd: number | null; ms: number };
const obsFile = join(dir, "observations.jsonl");
const obs: Obs[] = existsSync(obsFile)
	? readFileSync(obsFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Obs)
	: [];
const byCase = new Map<string, Obs[]>();
for (const o of obs) byCase.set(o.case, [...(byCase.get(o.case) ?? []), o]);
const cases = [...byCase].map(([name, list]) => {
	const passed = list.filter((o) => o.score === 1).length;
	const failedChecks: Record<string, number> = {};
	for (const o of list) for (const f of o.failed) failedChecks[f] = (failedChecks[f] ?? 0) + 1;
	const costs = list.map((o) => o.costUsd).filter((c): c is number => c !== null);
	return {
		case: name,
		runs: list.length,
		passed,
		passRate: passed / list.length,
		flaky: passed > 0 && passed < list.length,
		unscored: list.filter((o) => o.error !== null).length,
		failedChecks,
		errors: [...new Set(list.map((o) => o.error).filter((e): e is string => !!e))],
		costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
		seconds: percentiles(list.map((o) => o.ms / 1000)),
	};
});
const total = obs.length;
const passed = obs.filter((o) => o.score === 1).length;
const cost = obs.reduce((a, o) => a + (o.costUsd ?? 0), 0);
const report = { protocol, total, passed, passRate: total ? passed / total : null, costUsd: cost, vitestExit: res.status, cases };
writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
const lines = [
	`roost evals ${protocol.at}  model ${protocol.model} (${protocol.thinking})  runs ${protocol.runs}`,
	"",
	...cases.map(
		(c) =>
			`${c.passRate === 1 ? "PASS " : c.flaky ? "FLAKY" : "FAIL "}  ${c.case.padEnd(16)} ${c.passed}/${c.runs}` +
			`  ${c.seconds ? `p50 ${c.seconds.p50.toFixed(0)}s` : ""}  ${c.costUsd !== null ? `$${c.costUsd.toFixed(4)}` : "cost n/a"}` +
			(Object.keys(c.failedChecks).length
				? `  failed: ${Object.entries(c.failedChecks)
						.map(([k, n]) => `${k} ×${n}`)
						.join(", ")}`
				: "") +
			(c.errors.length ? `  errors: ${c.errors.join("; ")}` : ""),
	),
	"",
	`total ${passed}/${total}  cost $${cost.toFixed(4)}${protocol.runs < 2 ? "  (one run each: not a measure of stability)" : ""}`,
	// judges never fail a test (threshold null): a failed test is a run that was not scored
	...(res.status !== 0 ? ["", `NOT SCORED: vitest exited ${res.status}; some runs left no observation (see above) and are not in the totals`] : []),
];
writeFileSync(join(dir, "report.txt"), `${lines.join("\n")}\n`);
console.log(`\n${lines.join("\n")}\n\n${dir}`);
process.exit(total === 0 || res.status !== 0 ? 1 : 0);
