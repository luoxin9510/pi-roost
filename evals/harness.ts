/**
 * M37: the eval harness (docs/plans/evals.md). Each case runs in a roost of its own (an
 * isolated home, runtime directory and daemon), with a real agent (pi through its worker,
 * loaded from this checkout), driven as the hub drives it: a dispatch, replies when the
 * case's steps say so, the row followed through the daemon's events. What comes back is
 * deterministic to grade: the row's states in order, the final row, the transcript, the
 * files in the workspace, the subagents, cost and latency.
 *
 * Env: ROOST_EVAL_MODEL (default anthropic/claude-haiku-5-5), ROOST_EVAL_THINKING (low),
 * ROOST_EVAL_DIR (where observations go; evals/run.ts sets it), ROOST_EVAL_KEEP=1.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type JsonValue } from "vitest-evals/harness";
import { DaemonClient } from "../lib/client.ts";
import { buildLaunch } from "../lib/dispatch.ts";
import type { Event, JobRow, ReplyMode } from "../lib/protocol.ts";
import { readState } from "../lib/store.ts";
import { parseTelemetry, percentiles } from "../lib/telemetry.ts";
import { transcriptItems } from "../lib/transcript.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "extensions", "index.ts");

/** One interaction the case makes once the row reaches a state. */
export interface Step {
	/** The row's state that triggers it ("working" waits `afterMs` into the work). */
	when: "working" | "blocked" | "done";
	reply: string;
	mode?: ReplyMode;
	afterMs?: number;
}

export interface RoostCase {
	task: string;
	/** Workspace files, by relative path. */
	files?: Record<string, string>;
	/** Make the workspace a git repository (worktree cases). */
	git?: boolean;
	steps?: Step[];
	/** The whole run, from dispatch to a settled row (default 180 s). */
	timeoutMs?: number;
	model?: string;
	thinking?: string;
}

export interface RoostOutcome {
	[k: string]: JsonValue;
	ok: boolean;
	error: string | null;
	final: { state: string; status: string | null; waitingFor: string | null; summary: string | null; question: string | null; error: string | null } | null;
	/** The row's states as the hub saw them, consecutive repeats dropped. */
	states: string[];
	/** The last thing the agent said. */
	answer: string;
	transcript: { kind: string; text: string }[];
	files: Record<string, string>;
	children: { name: string; state: string; summary: string | null }[];
	repliesPending: number;
	costUsd: number | null;
	tokens: number | null;
	ms: number;
	ackP50: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function piCli(): string {
	const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
	return execFileSync("node", ["-e", `console.log(require("fs").realpathSync(${JSON.stringify(bin)}))`], { encoding: "utf8" }).trim();
}

function filesOf(dir: string, max = 64 * 1024): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			if (name === ".git" || name === "node_modules" || name === ".pi") continue;
			const p = join(d, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.size <= max) out[relative(dir, p)] = readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

/** Run one case in a roost of its own. */
export async function runCase(c: RoostCase, label = "case"): Promise<RoostOutcome> {
	const root = mkdtempSync(join(tmpdir(), "roost-eval-"));
	const home = join(root, "home");
	const rt = mkdtempSync("/tmp/re-");
	const work = join(root, "work");
	mkdirSync(home, { recursive: true });
	mkdirSync(work, { recursive: true });
	for (const [f, text] of Object.entries(c.files ?? {})) {
		mkdirSync(dirname(join(work, f)), { recursive: true });
		writeFileSync(join(work, f), text);
	}
	if (c.git) {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: work });
		execFileSync("git", ["-c", "user.email=eval@example.invalid", "-c", "user.name=eval", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: work });
	}
	// pi's own directory, empty but for the user's logins: the user's settings, system
	// prompt, extensions and skills would make the runs theirs. A link, not a copy: pi
	// writes refreshed tokens through it, and a copy would leave the user's login stale.
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const userAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	if (existsSync(join(userAgentDir, "auth.json"))) symlinkSync(join(userAgentDir, "auth.json"), join(agentDir, "auth.json"));
	const telemetry = join(root, "telemetry.jsonl");
	const saved = { ...process.env };
	Object.assign(process.env, {
		PI_ROOST_HOME: home,
		PI_ROOST_RUNTIME_DIR: rt,
		PI_ROOST_CONFIG_DIR: home,
		PI_ROOST_HOST_ENTRY: join(ROOT, "host", "main.ts"),
		ROOST_TELEMETRY: telemetry,
		PI_CODING_AGENT_DIR: agentDir,
	});
	// a Claude Code session around this run would mark the agents as its children
	for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE")) delete process.env[k];
	let daemon: ChildProcess | undefined;
	let client: DaemonClient | undefined;
	const t0 = Date.now();
	const states: string[] = [];
	let row: JobRow | undefined;
	const rows = new Map<string, JobRow>();
	let error: string | null = null;
	const sessionFile = join(root, "session.jsonl");
	try {
		daemon = spawn(process.execPath, [join(ROOT, "daemon", "main.ts")], { stdio: "ignore", env: process.env, detached: true });
		daemon.unref();
		for (let i = 0; i < 200 && !client; i++) {
			try {
				client = await DaemonClient.connect();
				await client.request("ping", {});
			} catch {
				client = undefined;
				await sleep(50);
			}
		}
		if (!client) throw new Error("the daemon did not start");
		let jobId: string | undefined;
		client.onEvent((e: Event) => {
			if (e.event !== "job") return;
			rows.set(e.job.id, e.job);
			if (e.job.id !== jobId) return;
			row = e.job;
			const s = row.state === "blocked" ? `blocked:${row.waitingFor ?? "?"}` : row.state;
			if (states[states.length - 1] !== s) states.push(s);
		});
		await client.request("subscribe", {});
		const launch = buildLaunch({
			task: c.task,
			cwd: work,
			sessionFile,
			name: label,
			origin: "dispatch",
			argv: [process.execPath, piCli(), "-ne", "-e", EXT],
			execPath: process.execPath,
			env: process.env,
			model: c.model ?? process.env.ROOST_EVAL_MODEL ?? "anthropic/claude-haiku-5-5",
			thinking: c.thinking ?? process.env.ROOST_EVAL_THINKING ?? "low",
		});
		jobId = (await client.request("dispatch", launch)).id;
		const steps = [...(c.steps ?? [])];
		const deadline = t0 + (c.timeoutMs ?? 180_000);
		let workingSince = 0;
		let settledAt = 0;
		for (;;) {
			if (Date.now() > deadline) throw new Error(`timed out (states: ${states.join(" → ")})`);
			await sleep(200);
			const r = row;
			if (!r) continue;
			if (r.state === "working") {
				workingSince ||= Date.now();
				settledAt = 0;
			} else workingSince = 0;
			const next = steps[0];
			if (next) {
				const ready =
					next.when === "working"
						? r.state === "working" && Date.now() - workingSince >= (next.afterMs ?? 0)
						: (next.when === "done" ? r.state === "done" : r.state === "blocked") && r.pid !== null;
				if (ready) {
					steps.shift();
					// before the request: the row may move before its answer comes
					states.push(`reply${next.mode === "steer" ? " (steer)" : ""}`);
					await client.request("reply", { id: r.id, text: next.reply, ...(next.mode ? { mode: next.mode } : {}), requestId: `${label}-${steps.length}` });
					// the row must leave the state that triggered the step before the next one counts
					await sleep(1500);
				}
				continue;
			}
			// settled: not working for 3 s, nothing pending
			if (r.state === "working") continue;
			settledAt ||= Date.now();
			const pending = readState(r.id)?.pendingReplies;
			if (Date.now() - settledAt >= 3000 && !(Array.isArray(pending) && pending.length > 0)) break;
		}
	} catch (err) {
		error = (err as Error).message;
	}
	// what it left
	let transcript: { kind: string; text: string }[] = [];
	try {
		transcript = transcriptItems(readFileSync(sessionFile, "utf8")).map((i) =>
			i.kind === "tool" ? { kind: "tool", text: `${i.name} ${i.args}${i.result ? ` → ${i.result.slice(0, 300)}` : ""}` } : { kind: i.kind, text: i.text },
		);
	} catch {}
	const answer = [...transcript].reverse().find((t) => t.kind === "assistant")?.text ?? "";
	const children = [...rows.values()].filter((j) => j.parentSession === sessionFile).map((j) => ({ name: j.name, state: j.state, summary: j.summary }));
	const tel = existsSync(telemetry) ? parseTelemetry(readFileSync(telemetry, "utf8")) : [];
	const ack = percentiles(tel.filter((r) => r.t === "metric" && r.name === "roost.reply.ack_latency").map((r) => (r as { value: number }).value));
	const used = [...rows.values()].flatMap((j) => (j.usage ? [j.usage] : []));
	const final = row
		? { state: row.state, status: row.status, waitingFor: row.waitingFor, summary: row.summary, question: row.question, error: row.error }
		: null;
	const outcome: RoostOutcome = {
		ok: error === null,
		error,
		final,
		states,
		answer,
		transcript,
		files: filesOf(work),
		children,
		repliesPending: row ? ((readState(row.id)?.pendingReplies as unknown[] | undefined)?.length ?? 0) : 0,
		// everything this roost ran (the case's session and its subagents), cache included
		costUsd: used.length ? used.reduce((a, u) => a + u.cost, 0) : null,
		tokens: used.length ? used.reduce((a, u) => a + u.input + u.output + u.cacheRead + u.cacheWrite, 0) : null,
		ms: Date.now() - t0,
		ackP50: ack?.p50 ?? null,
	};
	// the end: everything stops, the roost goes
	try {
		for (const id of rows.keys()) await client?.request("stop", { id }).catch(() => {});
		await client?.request("shutdown", {}).catch(() => {});
	} catch {}
	client?.close();
	await sleep(500);
	try {
		if (daemon?.pid) process.kill(daemon.pid, "SIGKILL");
	} catch {}
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	if (process.env.ROOST_EVAL_KEEP !== "1") rmSync(root, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
	return outcome;
}

/** The harness: one case in, its outcome out, the transcript as the run's events. */
export const roostHarness = createHarness<RoostCase, RoostOutcome>({
	name: "roost",
	run: async ({ input }) => {
		const out = await runCase(input, "eval");
		return {
			output: out,
			events: out.transcript.map((t) =>
				t.kind === "user" || t.kind === "assistant"
					? { type: "message" as const, role: t.kind, content: t.text }
					: { type: "message" as const, role: "assistant" as const, content: `[${t.kind}] ${t.text}` },
			),
			usage: { provider: "roost", model: input.model ?? process.env.ROOST_EVAL_MODEL ?? "anthropic/claude-haiku-5-5" },
		};
	},
});

/**
 * A judge of named checks over the outcome: the score is the share that pass; the ones
 * that fail are named. Each result is also kept as an observation (ROOST_EVAL_DIR).
 */
export function checks(name: string, list: Record<string, (o: RoostOutcome) => boolean>) {
	return {
		name,
		assess: ({ output }: { output: RoostOutcome }) => {
			const failed = Object.entries(list)
				.filter(([, f]) => {
					try {
						return !f(output);
					} catch {
						return true;
					}
				})
				.map(([k]) => k);
			const total = Object.keys(list).length;
			const score = output.ok ? (total - failed.length) / total : 0;
			const dir = process.env.ROOST_EVAL_DIR;
			if (dir) {
				appendFileSync(
					join(dir, "observations.jsonl"),
					`${JSON.stringify({ case: name, score, failed, error: output.error, states: output.states, costUsd: output.costUsd, tokens: output.tokens, ms: output.ms, ackP50: output.ackP50, answer: output.answer.slice(0, 500) })}\n`,
				);
			}
			return { score, metadata: { rationale: failed.length ? `failed: ${failed.join(", ")}${output.error ? ` (${output.error})` : ""}` : "all checks pass" } };
		},
	};
}
