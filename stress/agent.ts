// M35: the agent of the stress runs, on the TypeScript client. Every reply it handles
// is appended to <STRESS_LOG>/<job>.log (seq and text), so the run can check each was
// handled exactly once and in order. Its state changes (sent at once) carry the time in
// their summary, so subscribers can measure how late events reach them.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { RoostAgent } from "../lib/agent-client.ts";
import { readJobEnv } from "../lib/identity.ts";

const log = process.env.STRESS_LOG;
const work = Number(process.env.STRESS_WORK_MS) || 0;
const id = readJobEnv(process.env, "id") ?? "unknown";
let handled = 0;

const agent = RoostAgent.fromEnv({
	name: "stress",
	version: "1",
	onReply: async (r) => {
		if (log) appendFileSync(join(log, `${id}.log`), `${r.seq}\t${r.text}\n`);
		handled++;
		agent!.report({ state: "working", summary: `on ${r.text} t=${Date.now()}` });
		if (work) await new Promise((res) => setTimeout(res, work));
		agent!.report({ state: "done", summary: `handled ${handled} t=${Date.now()}` });
	},
});
if (!agent) process.exit(2);
agent.report({ state: "done", summary: `ready t=${Date.now()}` });
setInterval(() => {}, 60_000);
