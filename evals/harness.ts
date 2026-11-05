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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createHarness, type JsonValue } from "vitest-evals/harness";
import { DaemonClient } from "../lib/client.ts";
import { buildLaunch, buildProfileLaunch, prepareIsolation } from "../lib/dispatch.ts";
import type { AgentProfile } from "../lib/profiles.ts";
import type { DispatchArgs, Event, JobRow, ReplyMode } from "../lib/protocol.ts";
import { readState, readWorkerPid, screenPath } from "../lib/store.ts";
import { worktreeChange } from "../lib/worktree.ts";
import { parseTelemetry, percentiles } from "../lib/telemetry.ts";
import { transcriptItems } from "../lib/transcript.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "adapters", "pi", "index.ts");
const PI_AGENT = join(ROOT, "evals", "fixtures", "pi_agent.py");

/** One interaction the case makes once the row reaches a state. */
export interface Step {
	/**
	 * The row's state that triggers it ("working" waits `afterMs` into the work; "idle":
	 * done, or a terminal agent's notification; "stopped": after a `stop` step).
	 */
	when: "working" | "blocked" | "done" | "idle" | "stopped";
	/** What the user sends; or, instead, `kill`: the worker is killed (SIGKILL), as a crash; `stop`: the job is stopped. */
	reply?: string;
	kill?: "worker";
	stop?: true;
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
	/** M41: what runs it: pi through its worker (default), pi as a terminal agent (level 0), a protocol agent (level 1, Python). */
	agent?: "pi" | "term" | "protocol";
	/** M41: one task on these models, each in its own worktree (needs `git`). */
	fanout?: string[];
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
	/** Automatic restarts of the case's job (M38). */
	restarts: number;
	/** M41: the job's last screen (a terminal agent's), the row's texts in order, what its agent said in its hello, its command. */
	screen: string;
	summaries: string[];
	capabilities: string[] | null;
	agentName: string | null;
	model: string | null;
	command: string[];
	/** M41: the fan-out's sessions (the case's job first). */
	fanout: { name: string; state: string; model: string | null; branch: string | null; fanout: string | null; files: Record<string, string>; change: { files: number; insertions: number; deletions: number; untracked: number } | null }[];
	costUsd: number | null;
	tokens: number | null;
	ms: number;
	ackP50: number | null;
}

const DEFAULT_MODEL = "anthropic/claude-haiku-5-5";
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
			// links and special files are not followed: an agent's link must not take this outside the workspace
			const st = lstatSync(p);
			if (st.isDirectory()) walk(p);
			else if (st.isFile() && st.size <= max) out[relative(dir, p)] = readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

const ISOLATION = ["HOME", "RUNTIME_DIR", "CONFIG_DIR"] as const;

/** A request that gives up: a wedged daemon must not hold a case past its time. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * Run one case in a roost of its own. Cases run one at a time (they set process.env):
 * vitest runs a file's tests in order, and the eval config runs one file at a time.
 */
export async function runCase(c: RoostCase, label = "case"): Promise<RoostOutcome> {
	const root = mkdtempSync(join(tmpdir(), "roost-eval-"));
	const home = join(root, "home");
	const rt = mkdtempSync("/tmp/re-");
	const work = join(root, "work");
	const agentDir = join(root, "agent");
	const telemetry = join(root, "telemetry.jsonl");
	const sessionFile = join(root, "session.jsonl");
	const saved = { ...process.env };
	const t0 = Date.now();
	const deadline = t0 + (c.timeoutMs ?? 180_000);
	const left = () => Math.max(1000, deadline - Date.now());
	const statesOf = new Map<string, string[]>();
	const summariesOf = new Map<string, string[]>();
	const worktrees = new Map<string, { path: string; base: string }>();
	const ids: string[] = [];
	const rows = new Map<string, JobRow>();
	let jobId: string | undefined;
	let daemon: ChildProcess | undefined;
	let client: DaemonClient | undefined;
	let error: string | null = null;
	let outcome: RoostOutcome | undefined;
	try {
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
		mkdirSync(agentDir);
		const userAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
		if (existsSync(join(userAgentDir, "auth.json"))) symlinkSync(join(userAgentDir, "auth.json"), join(agentDir, "auth.json"));
		// Both spellings of roost's directories (ROOST_* wins over PI_ROOST_*), or a user's
		// own ROOST_HOME would point the case at the user's roost.
		for (const k of Object.keys(process.env)) if (/^(PI_)?ROOST_(?!EVAL_)/.test(k) || k.startsWith("CLAUDE")) delete process.env[k];
		const dirs = { HOME: home, RUNTIME_DIR: rt, CONFIG_DIR: home };
		for (const k of ISOLATION) {
			process.env[`ROOST_${k}`] = dirs[k];
			process.env[`PI_ROOST_${k}`] = dirs[k];
		}
		Object.assign(process.env, {
			PI_ROOST_HOST_ENTRY: join(ROOT, "host", "main.ts"),
			ROOST_TELEMETRY: telemetry,
			PI_CODING_AGENT_DIR: agentDir,
		});
		daemon = spawn(process.execPath, [join(ROOT, "daemon", "main.ts")], { stdio: "ignore", env: process.env, detached: true });
		daemon.unref();
		for (let i = 0; i < 200 && !client; i++) {
			try {
				client = await DaemonClient.connect();
				const pong = (await within(client.request("ping", {}), 2000, "ping")) as { pid?: number };
				// the daemon this case started, or nothing: never another roost
				if (pong.pid !== daemon.pid) {
					client.close();
					throw new Error(`isolation: the socket answered for pid ${pong.pid}, not the case's daemon ${daemon.pid}`);
				}
			} catch (err) {
				client = undefined;
				if ((err as Error).message.startsWith("isolation:")) throw err;
				await sleep(50);
			}
		}
		if (!client) throw new Error("the daemon did not start");
		const cl = client;
		// every row's states, kept from the first event (the job's first push can come
		// before dispatch answers with its id)
		cl.onEvent((e: Event) => {
			if (e.event !== "job") return;
			rows.set(e.job.id, e.job);
			const s = e.job.state === "blocked" ? `blocked:${e.job.waitingFor ?? "?"}` : e.job.state;
			const list = statesOf.get(e.job.id) ?? [];
			if (list[list.length - 1] !== s) list.push(s);
			statesOf.set(e.job.id, list);
			const texts = summariesOf.get(e.job.id) ?? [];
			if (e.job.summary && texts[texts.length - 1] !== e.job.summary) texts.push(e.job.summary);
			summariesOf.set(e.job.id, texts);
		});
		await within(cl.request("subscribe", {}), 5000, "subscribe");
		const model = c.model ?? process.env.ROOST_EVAL_MODEL ?? DEFAULT_MODEL;
		const thinking = c.thinking ?? process.env.ROOST_EVAL_THINKING ?? "low";
		const pi = piCli();
		// a terminal agent's or a protocol agent's own pi sessions go here (read back for the transcript)
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const piLaunch = (m: string, cwd: string, file: string): DispatchArgs =>
			buildLaunch({
				task: c.task,
				cwd,
				sessionFile: file,
				name: label,
				origin: "dispatch",
				argv: [process.execPath, pi, "-ne", "-e", EXT],
				execPath: process.execPath,
				env: process.env,
				model: m,
				thinking,
			});
		const launches: DispatchArgs[] = [];
		if (c.fanout) {
			// M26: one task per model, each in its own worktree, the sessions sharing a fan-out id
			if (!c.git) throw new Error("a fan-out needs a git workspace (git: true)");
			const fanout = randomBytes(4).toString("hex");
			c.fanout.forEach((m, i) => {
				const name = `${label} ${m}`;
				const iso = prepareIsolation(work, name, true, true);
				if (!iso.worktree) throw new Error(`no worktree: ${iso.note ?? "?"}`);
				launches.push({ ...piLaunch(m, iso.cwd, join(sessionsDir, `fanout-${i}.jsonl`)), worktree: iso.worktree, fanout, name });
			});
		} else if (c.agent === "term") {
			// pi itself as a level 0 agent: read from its screen, typed into, resumed with --continue
			const def: AgentProfile = {
				command: [process.execPath, pi, "-ne", "--session-dir", sessionsDir],
				task: "argv",
				model: ["--model", "{model}"],
				thinking: ["--thinking", "{thinking}"],
				resume: [process.execPath, pi, "-ne", "--session-dir", sessionsDir, "--continue"],
				working: "Working ─",
				settleMs: 2500,
			};
			launches.push(buildProfileLaunch({ name: label, profile: "pi-term", def, task: c.task, cwd: work, env: process.env, model, thinking }));
		} else if (c.agent === "protocol") {
			// a level 1 agent on the Python client, each reply one pi -p turn in a session of its own
			const def: AgentProfile = {
				command: ["python3", PI_AGENT, "--node", process.execPath, "--pi", pi, "--session-dir", sessionsDir],
				task: "type",
				model: ["--model", "{model}"],
				thinking: ["--thinking", "{thinking}"],
				protocol: true,
				settleMs: 1500,
			};
			launches.push(buildProfileLaunch({ name: label, profile: "pi-print", def, task: c.task, cwd: work, env: process.env, model, thinking }));
		} else launches.push(piLaunch(model, work, sessionFile));
		for (const l of launches) {
			const r = (await within(cl.request("dispatch", l), left(), "dispatch")) as { id: string };
			ids.push(r.id);
			if (l.worktree) worktrees.set(r.id, { path: l.worktree.path, base: l.worktree.base });
		}
		const id = ids[0]!;
		jobId = id;
		const states = () => statesOf.get(id) ?? [];
		const steps = [...(c.steps ?? [])];
		let workingSince = 0;
		let settledAt = 0;
		for (;;) {
			if (Date.now() > deadline) throw new Error(`timed out (states: ${states().join(" → ")})`);
			await sleep(200);
			const r = rows.get(id);
			if (!r) continue;
			if (r.state === "working") {
				workingSince ||= Date.now();
				settledAt = 0;
			} else workingSince = 0;
			const next = steps[0];
			if (next) {
				const idle = r.state === "done" || (r.state === "blocked" && r.waitingFor === "question");
				const ready =
					next.when === "working"
						? r.state === "working" && Date.now() - workingSince >= (next.afterMs ?? 0)
						: next.when === "stopped"
							? r.state === "stopped" && r.pid === null
							: (next.when === "done" ? r.state === "done" : next.when === "idle" ? idle : r.state === "blocked") && r.pid !== null;
				if (ready) {
					steps.shift();
					const seen = states().length;
					if (next.stop) {
						states().push("stop");
						await within(cl.request("stop", { id }), left(), "stop");
						const until = Date.now() + 30_000;
						while (Date.now() < until && Date.now() < deadline && rows.get(id)?.state !== "stopped") await sleep(100);
						workingSince = 0;
						settledAt = 0;
						continue;
					}
					if (next.kill) {
						const pid = readWorkerPid(id);
						states().push("kill");
						if (pid) process.kill(pid, "SIGKILL");
						// it went down and came back (or the case times out)
						const until = Date.now() + 60_000;
						while (Date.now() < until && Date.now() < deadline) {
							const w = readWorkerPid(id);
							if (w && w !== pid && rows.get(id)?.state === "working") break;
							await sleep(100);
						}
						workingSince = 0;
						continue;
					}
					// before the request: the row may move before its answer comes
					states().push(`reply${next.mode === "steer" ? " (steer)" : ""}`);
					await within(
						cl.request("reply", { id, text: next.reply ?? "", ...(next.mode ? { mode: next.mode } : {}), requestId: `${label}-${steps.length}` }),
						left(),
						"reply",
					);
					// the row must leave the state that triggered the step (a steer: the reply
					// is acked) before anything else counts
					const until = Date.now() + 30_000;
					while (Date.now() < until && Date.now() < deadline) {
						const moved = states().length > seen + 1;
						const acked = !((readState(id)?.pendingReplies as unknown[] | undefined)?.length ?? 0);
						if (next.when === "working" ? acked : moved) break;
						await sleep(100);
					}
					workingSince = 0;
				}
				continue;
			}
			// settled: nothing of this roost working (the case's job and its subagents) for
			// 3 s, no reply pending anywhere
			const busy = [...rows.values()].some((j) => j.state === "working" || ((readState(j.id)?.pendingReplies as unknown[] | undefined)?.length ?? 0) > 0);
			if (busy) {
				settledAt = 0;
				continue;
			}
			settledAt ||= Date.now();
			if (Date.now() - settledAt >= 3000) break;
		}
	} catch (err) {
		error = (err as Error).message;
	}
	try {
		// what it left
		let transcript: { kind: string; text: string }[] = [];
		try {
			// a pi session of the worker's; a terminal or protocol agent's: its newest own session
			let file = sessionFile;
			if (c.agent === "term" || c.agent === "protocol") {
				const dir = join(root, "sessions");
				const newest = readdirSync(dir)
					.filter((f) => f.endsWith(".jsonl"))
					.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
					.sort((a, b) => b.t - a.t)[0];
				if (newest) file = join(dir, newest.f);
			}
			transcript = transcriptItems(readFileSync(file, "utf8")).map((i) =>
				i.kind === "tool" ? { kind: "tool", text: `${i.name} ${i.args}${i.result ? ` → ${i.result.slice(0, 300)}` : ""}` } : { kind: i.kind, text: i.text },
			);
		} catch {}
		const answer = [...transcript].reverse().find((t) => t.kind === "assistant")?.text ?? "";
		const row = jobId ? rows.get(jobId) : undefined;
		const children = [...rows.values()].filter((j) => j.parentSession === sessionFile).map((j) => ({ name: j.name, state: j.state, summary: j.summary }));
		let ackP50: number | null = null;
		try {
			const tel = existsSync(telemetry) ? parseTelemetry(readFileSync(telemetry, "utf8")) : [];
			ackP50 = percentiles(tel.filter((r) => r.t === "metric" && r.name === "roost.reply.ack_latency").map((r) => (r as { value: number }).value))?.p50 ?? null;
		} catch {}
		let files: Record<string, string> = {};
		try {
			files = filesOf(work);
		} catch {}
		// everything this roost ran (the case's session and its subagents), cache included
		const used = [...rows.values()].flatMap((j) => (j.usage ? [j.usage] : []));
		let pending = 0;
		try {
			pending = row ? ((readState(row.id)?.pendingReplies as unknown[] | undefined)?.length ?? 0) : 0;
		} catch {}
		outcome = {
			ok: error === null,
			error,
			final: row
				? { state: row.state, status: row.status, waitingFor: row.waitingFor, summary: row.summary, question: row.question, error: row.error }
				: null,
			states: jobId ? (statesOf.get(jobId) ?? []) : [],
			answer,
			transcript,
			files,
			children,
			repliesPending: pending,
			screen: (() => {
				try {
					return jobId ? readFileSync(screenPath(jobId), "utf8").slice(-20_000) : "";
				} catch {
					return "";
				}
			})(),
			summaries: jobId ? (summariesOf.get(jobId) ?? []) : [],
			capabilities: row?.capabilities ?? null,
			agentName: (() => {
				try {
					const info = jobId ? (readState(jobId)?.agentInfo as { name?: unknown } | undefined) : undefined;
					return typeof info?.name === "string" ? info.name : null;
				} catch {
					return null;
				}
			})(),
			model: row?.model ?? null,
			command: (() => {
				try {
					const cmd = jobId ? readState(jobId)?.command : undefined;
					return Array.isArray(cmd) ? (cmd as string[]) : [];
				} catch {
					return [];
				}
			})(),
			fanout: await Promise.all(
				(c.fanout ? ids : []).map(async (i) => {
					const j = rows.get(i);
					const w = worktrees.get(i);
					let change: { files: number; insertions: number; deletions: number; untracked: number } | null = null;
					let files: Record<string, string> = {};
					try {
						if (w) {
							files = filesOf(w.path);
							change = (await worktreeChange(w.path, w.base)) ?? null;
						}
					} catch {}
					return { name: j?.name ?? i, state: j?.state ?? "?", model: j?.model ?? null, branch: j?.worktree?.branch ?? null, fanout: j?.fanout ?? null, files, change };
				}),
			),
			restarts: (() => {
				try {
					const n = jobId ? readState(jobId)?.crashRestarts : 0;
					return typeof n === "number" ? n : 0;
				} catch {
					return 0;
				}
			})(),
			costUsd: used.length ? used.reduce((a, u) => a + u.cost, 0) : null,
			tokens: used.length ? used.reduce((a, u) => a + u.input + u.output + u.cacheRead + u.cacheWrite, 0) : null,
			ms: Date.now() - t0,
			ackP50,
		};
	} finally {
		await teardown(client, daemon, rows);
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		if (process.env.ROOST_EVAL_KEEP !== "1") rmSync(root, { recursive: true, force: true });
		rmSync(rt, { recursive: true, force: true });
	}
	return outcome;
}

/** Everything the case started stops: its jobs, its daemon, any host or worker left. */
async function teardown(client: DaemonClient | undefined, daemon: ChildProcess | undefined, rows: Map<string, JobRow>): Promise<void> {
	// read before the daemon goes: the processes to check after it
	const pids = new Set<number>();
	for (const id of rows.keys()) {
		try {
			const s = readState(id) as { hostPid?: unknown } | undefined;
			if (typeof s?.hostPid === "number") pids.add(s.hostPid);
			const w = readWorkerPid(id);
			if (w) pids.add(w);
		} catch {}
	}
	if (client) {
		for (const id of rows.keys()) await within(client.request("stop", { id }), 5000, "stop").catch(() => {});
		await within(client.request("shutdown", {}), 10_000, "shutdown").catch(() => {});
		client.close();
	}
	const pid = daemon?.pid;
	for (let i = 0; pid && i < 80 && alive(pid); i++) await sleep(100);
	for (const p of [...(pid ? [pid] : []), ...pids]) {
		try {
			if (alive(p)) process.kill(p, "SIGKILL");
		} catch {}
	}
}

/** The harness: one case in, its outcome out, the transcript as the run's events. */
export const roostHarness = createHarness<RoostCase, RoostOutcome>({
	name: "roost",
	run: async ({ input }) => {
		const out = await runCase(input, "eval");
		return {
			output: out,
			// the task first: a run whose agent never answered still has an event (vitest-evals needs one)
			events: (out.transcript[0]?.kind === "user" ? out.transcript : [{ kind: "user", text: input.task }, ...out.transcript]).map((t) =>
				t.kind === "user" || t.kind === "assistant"
					? { type: "message" as const, role: t.kind, content: t.text }
					: { type: "message" as const, role: "assistant" as const, content: `[${t.kind}] ${t.text}` },
			),
			usage: { provider: "roost", model: input.model ?? process.env.ROOST_EVAL_MODEL ?? DEFAULT_MODEL },
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
			const score = output.ok && total > 0 ? (total - failed.length) / total : 0;
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
