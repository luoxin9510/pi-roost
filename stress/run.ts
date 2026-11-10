#!/usr/bin/env node
/**
 * M35: roost's stress run (docs/plans/evals.md). A real daemon and real hosts in an
 * isolated home, fake agents only (no model cost). Scenarios:
 *
 *   sessions  N agents dispatched at once, M hubs watching
 *   replies   K replies to each, in bursts: each handled once, in order
 *   chaos     the daemon killed (SIGKILL) and restarted under the reply storm, some
 *             hosts killed, a hub that never reads; then replies to the killed ones
 *   board     M49: T tasks on the shared board (every fifth waiting on the one before),
 *             every agent told to work it (claim, finish, next); the hub hands tasks out
 *             meanwhile; the daemon killed and restarted mid-race. Then: every task done
 *             exactly once, by one session, after what it waited on; no claim released;
 *             the store consistent; the `task` op within budget
 *   soak      the reply storm repeated for a while, memory and descriptors watched
 *
 * Every run checks the invariants, measures (client side, from telemetry, from ps) and
 * holds the numbers to budgets; it exits 1 when one fails. The report goes to
 * stress/.runs/<time>/ (report.json, report.txt, telemetry.jsonl, the agents' logs).
 *
 *   node stress/run.ts [sessions|replies|chaos|board|soak ...] [--jobs 50] [--replies 20]
 *                      [--hubs 3] [--tasks 120] [--soak-minutes 10] [--work-ms 0] [--keep]
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, DaemonError } from "../lib/client.ts";
import type { RoostEvent } from "../lib/events.ts";
import { sweepOrphans } from "../lib/orphans.ts";
import { daemonSocketPath } from "../lib/paths.ts";
import type { Event, JobRow } from "../lib/protocol.ts";
import { readState } from "../lib/store.ts";
import { parseTelemetry, percentiles } from "../lib/telemetry.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- arguments -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, def: number) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
};
const SCENARIOS = ["sessions", "replies", "chaos", "board", "soak"] as const;
type Scenario = (typeof SCENARIOS)[number];
const picked = argv.filter((a): a is Scenario => (SCENARIOS as readonly string[]).includes(a));
const scenarios: Scenario[] = picked.length > 0 ? picked : ["sessions", "replies", "chaos", "board"];
const JOBS = flag("jobs", 50);
const REPLIES = flag("replies", 20);
const HUBS = flag("hubs", 3);
const TASKS = flag("tasks", 120);
const SOAK_MIN = flag("soak-minutes", 10);
const WORK_MS = flag("work-ms", 0);
const KEEP = argv.includes("--keep");

/** What a run may not exceed (ms, MB). Over budget fails the run. */
const BUDGET = {
	dispatchP95: 3000,
	allReadyMs: 30_000 + JOBS * 200,
	ackP95: 3000,
	eventLagP95: 1000,
	daemonRssMB: 400,
	storm: 120_000 + JOBS * REPLIES * 20,
	/** M49: a `task` op (a claim under contention among them) */
	taskP95: 1000,
	board: 120_000 + TASKS * 500,
};

// ---- an isolated roost -----------------------------------------------------------

// M78: what an earlier killed run left behind goes first
sweepOrphans((l) => console.log(`[stress] ${l}`));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(ROOT, "stress", ".runs", stamp);
mkdirSync(join(out, "logs"), { recursive: true });
const home = mkdtempSync("/tmp/roost-stress-");
const rt = mkdtempSync("/tmp/rs-");
Object.assign(process.env, {
	PI_ROOST_HOME: home,
	PI_ROOST_RUNTIME_DIR: rt,
	PI_ROOST_CONFIG_DIR: home,
	PI_ROOST_HOST_ENTRY: join(ROOT, "host", "main.ts"),
	ROOST_TELEMETRY: join(out, "telemetry.jsonl"),
	// the idle reaper and cleanup stay out of the measurements
	PI_ROOST_REAP_MINUTES: "100000",
	PI_ROOST_CLEANUP_DAYS: "0",
});
const work = mkdtempSync("/tmp/roost-stress-w-");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeout: number, what: string): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error(`timed out: ${what}`);
		await sleep(50);
	}
}

let daemon: ChildProcess | undefined;
async function startDaemon(): Promise<DaemonClient> {
	daemon = spawn(process.execPath, [join(ROOT, "daemon", "main.ts")], { stdio: "ignore", env: { ...process.env, PI_ROOST_PARENT_PID: String(process.pid) }, detached: true });
	daemon.unref();
	return waitFor(
		async () => {
			try {
				const c = await DaemonClient.connect();
				await c.request("ping", {});
				return c;
			} catch {
				return undefined;
			}
		},
		10_000,
		"the daemon to listen",
	);
}

// ---- measurements ----------------------------------------------------------------

const samples: { at: number; rssMB: number; cpu: number; fds: number }[] = [];
let sampler: NodeJS.Timeout | undefined;
function sampleDaemon(): void {
	const pid = daemon?.pid;
	if (!pid) return;
	try {
		const [rss, cpu] = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
		let fds = -1;
		try {
			fds = execFileSync("lsof", ["-p", String(pid)], { encoding: "utf8" }).split("\n").length - 2;
		} catch {}
		samples.push({ at: Date.now(), rssMB: Math.round((rss ?? 0) / 1024), cpu: cpu ?? 0, fds });
	} catch {}
}

const lags: number[] = [];
/**
 * M49: when the daemon was down (killed, then back; agents reconnect with a backoff of up to
 * a few seconds): a report made then reaches the hubs late by design, and is counted apart.
 */
const outages: [number, number][] = [];
const OUTAGE_GRACE_MS = 5000;
let lagsInOutage = 0;
let hubsClosing = false;
const dispatchMs: number[] = [];
const failures: string[] = [];
const notes: string[] = [];
const results: Record<string, unknown> = {};

/**
 * A hub: subscribes and measures how late each state change reaches it. It connects again
 * when the daemon went (chaos), as the agent view does.
 */
async function hub(): Promise<{ close(): void }> {
	// a row comes again when something else about it changes (it went idle, a restarted daemon
	// took it back): the first sight of a report is its lag; the same report again is not
	const seen = new Set<string>();
	let c: DaemonClient | undefined;
	const attach = async (): Promise<void> => {
		const fresh = await DaemonClient.connect();
		try {
			await fresh.request("subscribe", {});
		} catch (e) {
			fresh.close();
			throw e;
		}
		fresh.onEvent((e: Event) => {
			if (e.event !== "job") return;
			// "ready" is stamped before the agent connected: its start, measured as allReadyMs
			const m = / t=(\d+)$/.exec(e.job.summary ?? "");
			if (!m || (e.job.summary ?? "").startsWith("ready")) return;
			const key = `${e.job.id} ${m[1]}`;
			if (seen.has(key)) return;
			seen.add(key);
			const at = Number(m[1]);
			if (outages.some(([from, to]) => at >= from && at <= to)) lagsInOutage++;
			else lags.push(Date.now() - at);
		});
		fresh.onClose(() => {
			if (hubsClosing) return;
			void waitFor(async () => {
				try {
					await attach();
					return true;
				} catch {
					return undefined;
				}
			}, 30_000, "a hub back").catch(() => {});
		});
		c = fresh;
	};
	await attach();
	return { close: () => c?.close() };
}

/** A hub that subscribes and never reads: the daemon must not stall on it. */
function deafHub(): void {
	const s = connect(daemonSocketPath());
	s.on("error", () => {});
	s.on("connect", () => {
		s.write(`${JSON.stringify({ id: 1, op: "subscribe", args: {} })}\n`);
		s.pause();
	});
}

// ---- the jobs --------------------------------------------------------------------

const logs = join(out, "logs");
/** What each job was sent, in order (text), and texts whose request failed (may or may not have arrived). */
const sent = new Map<string, string[]>();
const unsure = new Map<string, Set<string>>();

async function dispatchAll(client: DaemonClient, n: number): Promise<string[]> {
	const ids = await Promise.all(
		Array.from({ length: n }, async (_, i) => {
			const t0 = Date.now();
			const { id } = await client.request("dispatch", {
				cwd: work,
				sessionFile: "",
				kind: "shell",
				profile: "stress",
				protocol: true,
				command: [process.execPath, join(ROOT, "stress", "agent.ts")],
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", STRESS_LOG: logs, ...(WORK_MS ? { STRESS_WORK_MS: String(WORK_MS) } : {}) },
				name: `stress ${i}`,
				origin: "dispatch",
				term: { submit: "\r", settleMs: 3000 },
			});
			dispatchMs.push(Date.now() - t0);
			sent.set(id, []);
			return id;
		}),
	);
	return ids;
}

async function rows(client: DaemonClient): Promise<Map<string, JobRow>> {
	return new Map((await client.request("list", {})).jobs.map((j) => [j.id, j]));
}

/** One reply; `full` waits and tries again; a lost connection is reported to the caller. */
async function reply(c: () => DaemonClient, id: string, text: string): Promise<void> {
	for (let tries = 0; ; tries++) {
		try {
			// M36: the same request id on every try: a resend is taken once
			await c().request("reply", { id, text, requestId: `${id}.${text}` });
			sent.get(id)!.push(text);
			return;
		} catch (err) {
			if (err instanceof DaemonError && err.code === "full" && tries < 200) {
				await sleep(100);
				continue;
			}
			throw err;
		}
	}
}

/** The storm: K replies to each job, the jobs at once, each job's in order. */
async function storm(c: () => DaemonClient, ids: string[], k: number, tag: string, onError: (id: string, text: string) => Promise<void>): Promise<void> {
	await Promise.all(
		ids.map(async (id) => {
			for (let i = 1; i <= k; i++) {
				const text = `${tag}-${i}`;
				try {
					await reply(c, id, text);
				} catch {
					await onError(id, text);
				}
			}
		}),
	);
}

function handledOf(id: string): string[] {
	try {
		return readFileSync(join(logs, `${id}.log`), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("\t")[1]!);
	} catch {
		return [];
	}
}

async function drained(client: DaemonClient, ids: string[], timeout: number): Promise<void> {
	await waitFor(
		async () => {
			for (const id of ids) {
				const p = readState(id)?.pendingReplies;
				if (Array.isArray(p) && p.length > 0) return false;
				if (handledOf(id).length < (sent.get(id)?.length ?? 0)) return false;
			}
			return true;
		},
		timeout,
		"every reply handled and acked",
	);
	void client;
}

/** Each job handled what it was sent, in order, once (a text in `unsure` may be missing or twice). */
function checkReplies(ids: string[]): { jobs: number; replies: number; duplicates: number; missing: number; outOfOrder: number } {
	let replies = 0;
	let duplicates = 0;
	let missing = 0;
	let outOfOrder = 0;
	for (const id of ids) {
		const want = sent.get(id) ?? [];
		const got = handledOf(id);
		const maybe = unsure.get(id) ?? new Set();
		replies += got.length;
		const seen = new Map<string, number>();
		for (const t of got) seen.set(t, (seen.get(t) ?? 0) + 1);
		for (const [t, n] of seen) if (n > 1) {
			duplicates += n - 1;
			if (!maybe.has(t)) failures.push(`${id}: "${t}" handled ${n} times`);
		}
		const wanted = new Set(want);
		for (const t of seen.keys()) if (!wanted.has(t)) failures.push(`${id}: "${t}" handled, never sent`);
		for (const t of want) if (!seen.has(t)) {
			missing++;
			failures.push(`${id}: "${t}" sent, never handled`);
		}
		// order: the sent texts appear in the order they were sent
		const pos = want.map((t) => got.indexOf(t)).filter((p) => p >= 0);
		for (let i = 1; i < pos.length; i++) if (pos[i]! < pos[i - 1]!) {
			outOfOrder++;
			failures.push(`${id}: "${want[i]}" handled before an earlier reply`);
			break;
		}
	}
	return { jobs: ids.length, replies, duplicates, missing, outOfOrder };
}

// ---- scenarios -------------------------------------------------------------------

async function main(): Promise<void> {
	let client = await startDaemon();
	sampler = setInterval(sampleDaemon, 1000);
	const hubs = await Promise.all(Array.from({ length: HUBS }, hub));
	const t0 = Date.now();
	const ids = await dispatchAll(client, JOBS);
	await waitFor(
		async () => {
			const r = await rows(client);
			return ids.every((id) => r.get(id)?.pid && /^ready|^handled/.test(r.get(id)?.summary ?? ""));
		},
		BUDGET.allReadyMs + 30_000,
		"every agent up and reporting",
	);
	const allReady = Date.now() - t0;
	results.sessions = { jobs: JOBS, hubs: HUBS, dispatch: percentiles(dispatchMs), allReadyMs: allReady };
	if (percentiles(dispatchMs)!.p95 > BUDGET.dispatchP95) failures.push(`dispatch p95 ${percentiles(dispatchMs)!.p95} ms > ${BUDGET.dispatchP95}`);
	if (allReady > BUDGET.allReadyMs) failures.push(`all ready in ${allReady} ms > ${BUDGET.allReadyMs}`);

	const live = () => client;
	if (scenarios.includes("replies")) {
		const s0 = Date.now();
		await storm(live, ids, REPLIES, "r", async (id, text) => void failures.push(`${id}: reply ${text} failed without chaos`));
		await drained(client, ids, BUDGET.storm);
		results.replies = { perJob: REPLIES, ms: Date.now() - s0, ...checkReplies(ids) };
	}

	if (scenarios.includes("chaos")) {
		deafHub();
		const victims = ids.slice(0, Math.max(1, Math.floor(ids.length / 10)));
		const killedHosts: number[] = [];
		let restarted = false;
		const s0 = Date.now();
		// mid-storm: the daemon dies hard and comes back; some hosts die hard
		const chaos = (async () => {
			await sleep(1500);
			const killAt = Date.now();
			try {
				process.kill(daemon!.pid!, "SIGKILL");
			} catch {}
			for (const id of victims) {
				const pid = readState(id)?.hostPid;
				if (typeof pid === "number") {
					try {
						process.kill(pid, "SIGKILL");
						killedHosts.push(pid);
					} catch {}
				}
			}
			await sleep(500);
			client = await startDaemon();
			outages.push([killAt, Date.now() + OUTAGE_GRACE_MS]);
			restarted = true;
		})();
		await storm(live, ids, REPLIES, "c", async (id, text) => {
			// the request may or may not have reached the daemon: resend once it is back
			let set = unsure.get(id);
			if (!set) unsure.set(id, (set = new Set()));
			set.add(text);
			await waitFor(() => restarted, 30_000, "the daemon back");
			await reply(live, id, text);
		});
		await chaos;
		// the killed ones ended (the new daemon saw their hosts gone); the storm's next reply
		// to each started it again, and everything pending reached the new agent
		const daemonLog = () => {
			try {
				return readFileSync(join(home, "daemon.log"), "utf8");
			} catch {
				return "";
			}
		};
		await waitFor(() => victims.every((id) => daemonLog().includes(`"finalize","id":"${id}"`)), 30_000, "killed hosts seen as ended");
		for (const id of victims) await reply(live, id, "after-kill");
		const restartedJobs = victims.filter((id) => daemonLog().includes(`"respawn","id":"${id}"`)).length;
		if (restartedJobs < victims.length) failures.push(`only ${restartedJobs} of ${victims.length} killed jobs started again on a reply`);
		await drained(client, ids, BUDGET.storm);
		const check = checkReplies(ids);
		results.chaos = { ms: Date.now() - s0, daemonKilled: true, hostsKilled: killedHosts.length, restartedByReply: victims.length, resentAfterError: [...unsure.values()].reduce((n, s) => n + s.size, 0), ...check };
		// M36: with request ids a resend after a lost answer is taken once: no duplicate is allowed
		if (check.duplicates > 0) failures.push(`chaos: ${check.duplicates} replies handled twice despite request ids`);
	}

	if (scenarios.includes("board")) {
		const s0 = Date.now();
		// the feed from here on, collected as it grows (the log keeps the last 1000 only)
		let cursor = (await client.request("events", { limit: 1 })).cursor;
		const feed: RoostEvent[] = [];
		const collect = async () => {
			try {
				const r = await live().request("events", { after: cursor, limit: 1000 });
				for (const e of r.events) if (e.seq > cursor) feed.push(e);
				cursor = Math.max(cursor, ...r.events.map((e) => e.seq));
			} catch {}
		};
		// T tasks, every fifth waiting on the one before
		const taskIds: number[] = [];
		for (let i = 0; i < TASKS; i++) {
			const { task } = await client.request("task", { action: "add", title: `task ${i}`, after: i % 5 === 4 ? [taskIds[i - 1]!] : undefined });
			taskIds.push(task!.id);
		}
		// the hub hands tasks out first (the concierge's path is the same op): M50, the agents
		// take messages; one told of a task goes to the board
		let handed = 0;
		let notHanded = 0;
		let assignErrors = 0;
		let takenMeanwhile = 0;
		for (const t of (await client.request("task", { action: "list" })).tasks.filter((t) => t.state === "open" && t.after.length === 0).slice(0, 20)) {
			const to = ids[Math.floor(Math.random() * ids.length)]!;
			try {
				const r = await client.request("task", { action: "assign", id: t.id, to });
				if (r.sent === "delivered" || r.sent === "queued") handed++;
				else notHanded++;
			} catch (e) {
				// an agent told of an earlier one is on the board already: this task may be claimed by now
				if ((e as DaemonError).code === "bad_request") takenMeanwhile++;
				else assignErrors++;
			}
		}
		if (handed === 0 || assignErrors > 0) failures.push(`board: hand-overs ${handed} reached, ${notHanded} not, ${assignErrors} errors`);
		await collect();
		// every agent told to work the board; mid-race the daemon dies hard and comes back
		let restarted = false;
		let killed = false;
		const boardChaos = (async () => {
			await sleep(1500);
			const killAt = Date.now();
			try {
				process.kill(daemon!.pid!, "SIGKILL");
				killed = true;
			} catch {}
			await sleep(500);
			client = await startDaemon();
			outages.push([killAt, Date.now() + OUTAGE_GRACE_MS]);
			restarted = true;
		})();
		await storm(live, ids, 1, "board", async (id, text) => {
			await waitFor(() => restarted, 30_000, "the daemon back");
			await reply(live, id, text);
		});
		await boardChaos;
		await waitFor(
			async () => {
				await collect();
				const r = await rows(client);
				return ids.every((id) => /^board done/.test(r.get(id)?.summary ?? ""));
			},
			BUDGET.board,
			"every agent done with the board",
		);
		await collect();
		// the invariants: every task done once, by one session, after what it waited on; nothing released; the store consistent
		const tasks = (await client.request("task", { action: "list" })).tasks;
		const notDone = tasks.filter((t) => t.state !== "done");
		if (notDone.length) failures.push(`board: ${notDone.length} tasks not done: ${notDone.slice(0, 5).map((t) => `#${t.id} ${t.state}${t.owner ? ` by ${t.owner.name}` : ""}`).join(", ")}`);
		const taskEvents = feed.filter((e) => e.kind === "task");
		const first = (why: string, id: number) => taskEvents.findIndex((e) => e.why === why && (e.text ?? "").startsWith(`#${id} `));
		for (const t of tasks) {
			const dones = taskEvents.filter((e) => e.why === "done" && (e.text ?? "").startsWith(`#${t.id} `)).length;
			if (dones !== 1) failures.push(`board: #${t.id} finished ${dones} times in the feed`);
			for (const d of t.after) {
				const ci = first("claim", t.id);
				const di = first("done", d);
				if (ci >= 0 && di >= 0 && ci < di) failures.push(`board: #${t.id} was claimed before #${d}, which it waited on, was done`);
				if (ci >= 0 && di < 0) failures.push(`board: #${t.id} was claimed while #${d} was never done`);
			}
		}
		const releases = taskEvents.filter((e) => e.why === "release");
		if (releases.length) failures.push(`board: ${releases.length} claims released although every session lived (${releases.slice(0, 3).map((e) => e.text).join("; ")})`);
		// the agents' own logs agree: each task finished by exactly one of them
		const finishedBy = new Map<number, string[]>();
		let conflicts = 0;
		let blockedRefusals = 0;
		let lost = 0;
		let handedSeen = 0;
		for (const id of ids) {
			let lines: string[] = [];
			try {
				lines = readFileSync(join(logs, `${id}.board.log`), "utf8").split("\n").filter(Boolean);
			} catch {}
			for (const l of lines) {
				const [verb, n, code] = l.split(" ");
				if (verb === "done") finishedBy.set(Number(n), [...(finishedBy.get(Number(n)) ?? []), id]);
				else if (verb === "handed") handedSeen++;
				else if (verb === "refused" && code === "conflict") conflicts++;
				else if (verb === "refused" && code === "blocked") blockedRefusals++;
				else if (verb === "refused" || verb === "list-error" || verb === "done-error") lost++;
			}
		}
		for (const [n, by] of finishedBy) if (by.length > 1) failures.push(`board: #${n} finished by ${by.length} sessions (${by.join(", ")})`);
		for (const t of tasks) if (!finishedBy.has(t.id) && t.state === "done") failures.push(`board: #${t.id} is done but no agent says it finished it`);
		// every hand-over reached its agent once (a resend after the restart is not taken twice)
		if (handedSeen !== handed) failures.push(`board: ${handed} hand-overs reached the agents, which took ${handedSeen}`);
		const saved = JSON.parse(readFileSync(join(home, "tasks.json"), "utf8")) as { next: number; tasks: { id: number }[] };
		const savedIds = saved.tasks.map((t) => t.id);
		if (new Set(savedIds).size !== savedIds.length) failures.push("board: tasks.json has a duplicate id");
		if (saved.next <= Math.max(0, ...savedIds)) failures.push(`board: tasks.json next ${saved.next} is not past the last id`);
		results.board = {
			tasks: TASKS,
			done: tasks.filter((t) => t.state === "done").length,
			daemonKilled: killed,
			handed,
			handedSeen,
			takenMeanwhile,
			conflicts,
			blockedRefusals,
			requestsLost: lost,
			releases: releases.length,
			events: taskEvents.length,
			ms: Date.now() - s0,
		};
	}

	if (scenarios.includes("soak")) {
		const until = Date.now() + SOAK_MIN * 60_000;
		let rounds = 0;
		while (Date.now() < until) {
			rounds++;
			await storm(live, ids, 5, `s${rounds}`, async (id, text) => void failures.push(`${id}: soak reply ${text} failed`));
			await drained(client, ids, BUDGET.storm);
		}
		const first = samples[0];
		const last = samples[samples.length - 1];
		results.soak = { minutes: SOAK_MIN, rounds, rssMB: { first: first?.rssMB, last: last?.rssMB }, fds: { first: first?.fds, last: last?.fds }, ...checkReplies(ids) };
	}

	// the end: everything stops, nothing is left behind
	for (const id of ids) await client.request("stop", { id }).catch(() => {});
	await waitFor(async () => {
		const r = await rows(client);
		return ids.every((id) => r.get(id)?.endedAt);
	}, 60_000, "every job stopped");
	await client.request("shutdown", {}).catch(() => {});
	hubsClosing = true;
	for (const h of hubs) h.close();
	client.close();
	clearInterval(sampler);
	await sleep(1500);
	const orphans = ids.map((id) => readState(id)?.hostPid).filter((pid): pid is number => typeof pid === "number" && alive(pid));
	if (orphans.length) failures.push(`hosts left running: ${orphans.join(", ")}`);
	const sockets = existsSync(rt) ? readdirSync(rt).filter((f) => f.endsWith(".sock")) : [];
	if (sockets.length) failures.push(`sockets left: ${sockets.join(", ")}`);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ---- the report ------------------------------------------------------------------

function report(): void {
	const tel = existsSync(process.env.ROOST_TELEMETRY!) ? parseTelemetry(readFileSync(process.env.ROOST_TELEMETRY!, "utf8")) : [];
	const hist = (name: string) => percentiles(tel.filter((r) => r.t === "metric" && r.name === name).map((r) => (r as { value: number }).value));
	const ops = new Map<string, number[]>();
	for (const r of tel) if (r.t === "span" && r.name.startsWith("roost.op.")) {
		const list = ops.get(r.name) ?? [];
		list.push(r.ms);
		ops.set(r.name, list);
	}
	const opErrors = tel.filter((r) => r.t === "span" && r.name.startsWith("roost.op.") && r.status.status === "error").length;
	const ack = hist("roost.reply.ack_latency");
	const lag = percentiles(lags);
	const rss = Math.max(0, ...samples.map((s) => s.rssMB));
	if (ack && !scenarios.includes("chaos") && ack.p95 > BUDGET.ackP95) failures.push(`reply ack p95 ${ack.p95} ms > ${BUDGET.ackP95}`);
	// M49: the board's op, under the race (a request the restart cut short is counted by its client, not here)
	const task = percentiles(ops.get("roost.op.task") ?? []);
	if (scenarios.includes("board") && task && task.p95 > BUDGET.taskP95) failures.push(`task op p95 ${task.p95} ms > ${BUDGET.taskP95}`);
	if (lag && lag.p95 > BUDGET.eventLagP95) failures.push(`event lag p95 ${lag.p95} ms > ${BUDGET.eventLagP95}`);
	if (rss > BUDGET.daemonRssMB) failures.push(`daemon RSS ${rss} MB > ${BUDGET.daemonRssMB}`);
	const data = {
		at: new Date().toISOString(),
		scenarios,
		options: { jobs: JOBS, replies: REPLIES, hubs: HUBS, workMs: WORK_MS, soakMinutes: SOAK_MIN },
		budget: BUDGET,
		results,
		latency: {
			replyDeliver: hist("roost.reply.deliver_latency"),
			replyAck: ack,
			eventLag: lag,
			eventLagDuringOutage: lagsInOutage,
			hostStart: hist("roost.host.start"),
			hostReady: hist("roost.host.ready"),
			ops: Object.fromEntries([...ops].map(([k, v]) => [k.slice("roost.op.".length), percentiles(v)])),
		},
		opErrors,
		daemon: { rssMBMax: rss, cpuMax: Math.max(0, ...samples.map((s) => s.cpu)), fdsMax: Math.max(0, ...samples.map((s) => s.fds)), samples: samples.length },
		notes,
		failures,
		ok: failures.length === 0,
	};
	writeFileSync(join(out, "report.json"), `${JSON.stringify(data, null, 2)}\n`);
	const p = (x: ReturnType<typeof percentiles>) => (x ? `p50 ${x.p50} · p95 ${x.p95} · p99 ${x.p99} · max ${x.max} (n ${x.n})` : "-");
	const lines = [
		`roost stress · ${data.at} · ${scenarios.join(", ")} · ${JOBS} jobs × ${REPLIES} replies · ${HUBS} hubs`,
		"",
		...Object.entries(results).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
		"",
		`dispatch (client)    ${p(percentiles(dispatchMs))}`,
		`reply delivered      ${p(data.latency.replyDeliver)}`,
		`reply acked          ${p(ack)}`,
		`event lag (hubs)     ${p(lag)}${lagsInOutage ? ` · ${lagsInOutage} more made while the daemon was down (not counted)` : ""}`,
		`host start           ${p(data.latency.hostStart)}`,
		...[...ops].sort().map(([k, v]) => `op ${k.slice(9).padEnd(17)} ${p(percentiles(v))}`),
		`request errors       ${opErrors}`,
		`daemon               RSS max ${rss} MB · CPU max ${data.daemon.cpuMax}% · fds max ${data.daemon.fdsMax}`,
		"",
		...notes.map((n) => `note: ${n}`),
		...(failures.length ? ["FAILED:", ...failures.slice(0, 50).map((f) => `  ${f}`), ...(failures.length > 50 ? [`  … ${failures.length - 50} more`] : [])] : ["OK: invariants held, within budget"]),
		"",
		`report: ${out}`,
	];
	writeFileSync(join(out, "report.txt"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
}

function cleanup(): void {
	try {
		if (daemon?.pid && alive(daemon.pid)) process.kill(daemon.pid, "SIGKILL");
	} catch {}
	// a run that stopped half way leaves hosts (and their agents): they go with it
	for (const id of sent.keys()) {
		const pid = readState(id)?.hostPid;
		if (typeof pid === "number" && alive(pid)) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
	}
	if (!KEEP) {
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	}
	rmSync(rt, { recursive: true, force: true });
}

main()
	.catch((err) => failures.push(`run aborted: ${(err as Error).message}`))
	.finally(() => {
		clearInterval(sampler);
		try {
			report();
		} finally {
			cleanup();
			process.exit(failures.length ? 1 : 0);
		}
	});
