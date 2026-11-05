#!/usr/bin/env node
/**
 * M35: roost's stress run (docs/plans/evals.md). A real daemon and real hosts in an
 * isolated home, fake agents only (no model cost). Scenarios:
 *
 *   sessions  N agents dispatched at once, M hubs watching
 *   replies   K replies to each, in bursts: each handled once, in order
 *   chaos     the daemon killed (SIGKILL) and restarted under the reply storm, some
 *             hosts killed, a hub that never reads; then replies to the killed ones
 *   soak      the reply storm repeated for a while, memory and descriptors watched
 *
 * Every run checks the invariants, measures (client side, from telemetry, from ps) and
 * holds the numbers to budgets; it exits 1 when one fails. The report goes to
 * stress/.runs/<time>/ (report.json, report.txt, telemetry.jsonl, the agents' logs).
 *
 *   node stress/run.ts [sessions|replies|chaos|soak ...] [--jobs 50] [--replies 20]
 *                      [--hubs 3] [--soak-minutes 10] [--work-ms 0] [--keep]
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, DaemonError } from "../lib/client.ts";
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
const SCENARIOS = ["sessions", "replies", "chaos", "soak"] as const;
type Scenario = (typeof SCENARIOS)[number];
const picked = argv.filter((a): a is Scenario => (SCENARIOS as readonly string[]).includes(a));
const scenarios: Scenario[] = picked.length > 0 ? picked : ["sessions", "replies", "chaos"];
const JOBS = flag("jobs", 50);
const REPLIES = flag("replies", 20);
const HUBS = flag("hubs", 3);
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
};

// ---- an isolated roost -----------------------------------------------------------

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
	daemon = spawn(process.execPath, [join(ROOT, "daemon", "main.ts")], { stdio: "ignore", env: process.env, detached: true });
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
const dispatchMs: number[] = [];
const failures: string[] = [];
const notes: string[] = [];
const results: Record<string, unknown> = {};

/** A hub: subscribes and measures how late each state change reaches it. */
async function hub(): Promise<DaemonClient> {
	const c = await DaemonClient.connect();
	c.onEvent((e: Event) => {
		if (e.event !== "job") return;
		const m = / t=(\d+)$/.exec(e.job.summary ?? "");
		if (m) lags.push(Date.now() - Number(m[1]));
	});
	await c.request("subscribe", {});
	return c;
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
			await c().request("reply", { id, text });
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
		if (check.duplicates > 0) notes.push(`chaos: ${check.duplicates} reply handled twice after a lost response (resent by the client: needs request ids)`);
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
		`event lag (hubs)     ${p(lag)}`,
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
