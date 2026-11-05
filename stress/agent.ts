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

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const jitter = () => sleep(50 + Math.random() * 150);
const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code ?? "";
/** What it did on the board (<STRESS_LOG>/<job>.board.log): `claim N`, `done N`, `refused N code`, errors. */
const blog = (line: string) => {
	if (log) appendFileSync(join(log, `${id}.board.log`), `${line}\n`);
};

/**
 * M49: the board under load. Take open tasks one at a time (a claim refused as conflict
 * or blocked is another session's: pick again), finish each, until nothing is open or
 * claimed. A request lost to a daemon restart is retried from the board as it stands:
 * a task this session holds is finished first.
 */
async function workBoard(): Promise<void> {
	for (;;) {
		let tasks: Awaited<ReturnType<RoostAgent["tasks"]>>;
		try {
			tasks = await agent!.tasks();
		} catch (e) {
			blog(`list-error ${codeOf(e) || (e as Error).message}`);
			await jitter();
			continue;
		}
		const byId = new Map(tasks.map((t) => [t.id, t]));
		const mine = tasks.find((t) => t.state === "claimed" && t.owner?.id === id);
		const pick =
			mine ??
			(() => {
				const open = tasks.filter((t) => t.state === "open" && t.after.every((d) => !byId.has(d) || byId.get(d)!.state === "done" || byId.get(d)!.state === "dropped"));
				// some contention: one of the first three
				return open.length > 0 ? open[Math.floor(Math.random() * Math.min(open.length, 3))] : undefined;
			})();
		if (!pick) {
			// others still work, or a dependency is about to open; nothing at all: done
			if (tasks.some((t) => t.state === "open" || t.state === "claimed")) {
				await jitter();
				continue;
			}
			return;
		}
		if (!mine) {
			try {
				await agent!.claimTask(pick.id);
			} catch (e) {
				const code = codeOf(e);
				blog(`refused ${pick.id} ${code || (e as Error).message}`);
				if (!code) await jitter(); // a lost answer: the board says whether the claim went through
				continue;
			}
			blog(`claim ${pick.id}`);
		}
		if (work) await sleep(work);
		for (;;) {
			try {
				await agent!.taskDone(pick.id, `by ${id}`);
				break;
			} catch (e) {
				const code = codeOf(e);
				blog(`done-error ${pick.id} ${code || (e as Error).message}`);
				if (code === "bad_request" || code === "unsupported") break;
				await jitter();
			}
		}
		blog(`done ${pick.id}`);
	}
}

let boarding: Promise<void> | undefined;
/** The board, once at a time: a hand-over that comes while on it is noted, not a second run. */
function board(): Promise<void> {
	if (!boarding) {
		agent!.report({ state: "working", summary: `on board t=${Date.now()}` });
		boarding = workBoard().finally(() => {
			boarding = undefined;
			agent!.report({ state: "done", summary: `board done t=${Date.now()}` });
		});
	}
	return boarding;
}

const agent = RoostAgent.fromEnv({
	name: "stress",
	version: "1",
	onReply: async (r) => {
		if (log) appendFileSync(join(log, `${id}.log`), `${r.seq}\t${r.text}\n`);
		handled++;
		if (r.text.startsWith("board")) {
			await board();
			return;
		}
		agent!.report({ state: "working", summary: `on ${r.text} t=${Date.now()}` });
		if (work) await new Promise((res) => setTimeout(res, work));
		agent!.report({ state: "done", summary: `handled ${handled} t=${Date.now()}` });
	},
});
if (!agent) process.exit(2);
agent.report({ state: "done", summary: `ready t=${Date.now()}` });
setInterval(() => {}, 60_000);
