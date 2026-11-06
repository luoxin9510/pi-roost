#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { attachToHost } from "../lib/attach.ts";
import { formatList } from "../lib/list-format.ts";
import { DaemonClient, DaemonError, requestOnce } from "../lib/client.ts";
import { hostControl } from "../lib/hostclient.ts";
import { ensureLive } from "../lib/resume.ts";
import { cleanupText } from "../lib/worktree.ts";
import { daemonLogPath, hostSocketPath, runtimeDir } from "../lib/paths.ts";
import { findPiPackage, piCliOf, usePiPackage } from "../lib/pi-resolve.ts";
import { agoText, untilText } from "../lib/schedule.ts";
import { eventAgo, eventLine, type RoostEvent } from "../lib/events.ts";
import type { JobRow } from "../lib/protocol.ts";
import { screenPath } from "../lib/store.ts";
import { taskDiff } from "../lib/task-diff.ts";
import { commentAnchor, reviewLines } from "../lib/review.ts";
import { ROOST_VERSION } from "../lib/version.ts";

const USAGE = `pi-roost ${ROOST_VERSION} — background pi sessions

usage:
  pi-roost hub [dir]               the agent view in this terminal, without a pi session
                                   (new sessions start in dir; needs pi on the PATH)
  pi-roost schedule [list]         scheduled tasks (add them in the agent view: /schedule)
  pi-roost schedule run|pause|resume|rm <name>
  pi-roost list [--all] [--subagents] [--cwd <dir>]
                                   list background sessions (as the agent view does)
  pi-roost attach <id|name>        open a background session (Ctrl+Z detaches);
                                   an ended one is started again first
  pi-roost logs <id|name>          print its current or last screen
  pi-roost log [-n <count>] [--follow] [<id|name>]
                                   what happened lately (tasks, questions, results,
                                   messages), oldest first; --follow keeps printing
  pi-roost reply <id|name> <text>  send a reply (queued as a follow-up while it works)
  pi-roost stop <id|name>          stop it
  pi-roost rm <id|name>            stop it and delete its record
  pi-roost respawn <id|name>       start an ended session again (or restart a live one)
  pi-roost respawn --all           restart live and reaped sessions (after an upgrade)
  pi-roost --json [--all] [--cwd <dir>]
                                   list jobs as JSON (--all includes ended > 48 h ago)
  pi-roost review <task>           a task's diff against its base, with the review's comments
  pi-roost review <task> comment <file>:<line> <text>
                                   a comment on that line (its number in the new version)
  pi-roost review <task> back [note]
                                   send it back to its session with the comments
  pi-roost daemon status|logs|stop [--keep-workers]

start one with: pi --bg "<task>"`;

const ENDED_CUTOFF_MS = 48 * 60 * 60 * 1000;

class UsageError extends Error {}

// A finished turn still has a live worker to attach to; only the process matters.
const isLive = (row: JobRow) => row.pid !== null;

let skewWarned = false;

/** DM-9: a daemon from another pi-roost version keeps running old code. */
async function warnSkew(client: DaemonClient): Promise<void> {
	if (skewWarned) return;
	skewWarned = true;
	const { version } = await client.request("ping", {});
	if (version !== ROOST_VERSION) {
		process.stderr.write(
			`warning: the background service is pi-roost ${version}, this is ${ROOST_VERSION}; run: pi-roost daemon stop --keep-workers && pi-roost respawn --all\n`,
		);
	}
}

async function withDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
	const client = await DaemonClient.connectOrStart();
	try {
		await warnSkew(client);
		return await fn(client);
	} finally {
		client.close();
	}
}

async function findRow(client: DaemonClient, query: string | undefined): Promise<JobRow> {
	if (!query) throw new UsageError("missing <id|name>");
	const { id } = await client.request("resolve", { query });
	const { jobs } = await client.request("list", { all: true });
	const row = jobs.find((j) => j.id === id);
	if (!row) throw new DaemonError(`no job ${id}`, "not_found");
	return row;
}

function readScreen(id: string): string | undefined {
	try {
		return readFileSync(screenPath(id), "utf8");
	} catch {
		return undefined;
	}
}

async function cmdAttach(query: string | undefined): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new DaemonError("attach needs a terminal", "no_tty");
	const row = await withDaemon(async (c) => {
		const r = await findRow(c, query);
		// AT-1: a reaped or ended session starts again; its last screen shows meanwhile
		await ensureLive(c, r, process.stdout);
		return r;
	});
	const reason = await attachToHost(hostSocketPath(row.id), { stdin: process.stdin, stdout: process.stdout });
	const note =
		reason === "exit" ? "session ended" : reason === "takeover" ? "attached elsewhere" : reason === "error" ? "connection lost" : "detached";
	// The worker left the cursor wherever its editor was; print below its last frame.
	process.stdout.write(`\x1b[${process.stdout.rows || 24};1H\r\n${note} · ${row.id} · ${row.name}\r\n`);
}

async function cmdLogs(query: string | undefined): Promise<void> {
	const row = await withDaemon((c) => findRow(c, query));
	let text: string | undefined;
	if (isLive(row)) {
		try {
			text = ((await hostControl(row.id, "snapshot")) as { text: string }).text;
		} catch {
			// host just went away: fall back to the last snapshot on disk
		}
	}
	text ??= readScreen(row.id);
	if (text === undefined) throw new DaemonError(`no screen recorded for ${row.id}`, "no_screen");
	process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function cmdStopOrRm(op: "stop" | "rm", query: string | undefined): Promise<void> {
	await withDaemon(async (c) => {
		const row = await findRow(c, query);
		const r = await c.request(op, { id: row.id });
		process.stdout.write(`${op === "stop" ? "stopped" : "removed"} · ${row.id} · ${row.name}\n`);
		const w = "worktree" in r ? r.worktree : undefined;
		if (w) process.stdout.write(`  ${cleanupText(w)}\n`);
	});
}

async function cmdReply(query: string | undefined, words: string[]): Promise<void> {
	const text = words.join(" ").trim();
	if (!text) throw new UsageError("reply needs text");
	await withDaemon(async (c) => {
		const row = await findRow(c, query);
		// M51: sent again (once taken) when the answer is lost to a restart of the service
		let cur = c;
		const r = await requestOnce(
			async () => {
				if (cur.isClosed) cur = await DaemonClient.connectOrStart();
				return cur;
			},
			"reply",
			{ id: row.id, text },
			{ tag: "cli" },
		).finally(() => {
			if (cur !== c) cur.close();
		});
		const what = r.stopped
			? "stopped"
			: r.delivered
				? "sent"
				: r.respawned
					? "sent · restarting the session"
					: r.saved
						? `saved for its next start${r.error ? ` (could not restart it: ${r.error})` : ""}`
						: "not delivered (the session is not running)";
		process.stdout.write(`${what} · ${row.id} · ${row.name}\n`);
		if ((!r.delivered && !r.saved) || r.error) process.exitCode = 1;
	});
}

async function cmdRespawn(args: string[]): Promise<void> {
	await withDaemon(async (c) => {
		const all = args.includes("--all");
		const query = args.find((a) => a !== "--all");
		if (!all && !query) throw new UsageError("respawn needs <id|name> or --all");
		const id = all ? undefined : (await findRow(c, query)).id;
		const { results } = await c.request("respawn", all ? { all: true } : { id, restart: true });
		for (const r of results) {
			process.stdout.write(`${r.error ? `failed: ${r.error}` : r.started ? "started" : "already running"} · ${r.id}\n`);
			if (r.error) process.exitCode = 1;
		}
		if (all && results.length === 0) process.stdout.write("nothing to respawn\n");
	});
}

/** M39: list and manage schedules (adding one needs pi: the agent view's /schedule). */
async function cmdSchedule(args: string[]): Promise<void> {
	const [verb = "list", name, ...more] = args;
	if (verb === "list" && !name) {
		const { schedules } = await withDaemon((c) => c.request("schedules", {}));
		if (schedules.length === 0) {
			process.stdout.write("no schedules (add one in the agent view: /schedule <name> <when> <task>)\n");
			return;
		}
		const now = Date.now();
		for (const s of schedules) {
			const next = s.paused ? "paused" : s.nextAt === null ? "never" : `next ${untilText(s.nextAt, now)}`;
			const last = s.lastRunAt ? `last ${agoText(now - s.lastRunAt)} ago (${s.lastJob})` : "not run yet";
			process.stdout.write(`${s.name}  ${s.when}  ${next}  ${last}\n  ${s.task ?? ""}\n  ${s.agent}  ${s.cwd}${s.model ? `  ${s.model}` : ""}\n`);
			if (s.lastSkip) process.stdout.write(`  skipped ${agoText(now - s.lastSkip.at)} ago: ${s.lastSkip.why}\n`);
		}
		return;
	}
	if (!name || more.length > 0 || !["run", "pause", "resume", "rm"].includes(verb)) throw new UsageError("schedule [list] | schedule run|pause|resume|rm <name>");
	await withDaemon(async (c) => {
		if (verb === "rm") {
			await c.request("schedule-rm", { name });
			process.stdout.write(`removed ${name}\n`);
		} else if (verb === "run") {
			const r = await c.request("schedule-run", { name });
			process.stdout.write(`started ${r.id}\n`);
		} else {
			const r = await c.request("schedule-pause", { name, paused: verb === "pause" });
			process.stdout.write(r.paused || r.nextAt === null ? `paused ${name}\n` : `${name}: next run ${untilText(r.nextAt)}\n`);
		}
	});
}

/** M43: the event feed, oldest first; --follow polls for more (Ctrl+C ends it). */
async function cmdLog(args: string[]): Promise<void> {
	const follow = args.includes("--follow") || args.includes("-f");
	const nAt = args.indexOf("-n");
	const limit = nAt === -1 ? 50 : Number(args[nAt + 1]);
	if (nAt !== -1 && !(limit > 0)) throw new UsageError("-n needs a count");
	const rest = args.filter((a, i) => a !== "--follow" && a !== "-f" && i !== nAt && i !== nAt + 1);
	if (rest.length > 1) throw new UsageError("log [-n <count>] [--follow] [<id|name>]");
	await withDaemon(async (c) => {
		const id = rest[0] ? (await c.request("resolve", { query: rest[0] })).id : undefined;
		const print = (events: RoostEvent[]) => {
			const now = Date.now();
			for (const e of events) process.stdout.write(`${eventAgo(e.at, now).padStart(4)} ago  ${eventLine(e)}\n`);
		};
		let { events, cursor } = await c.request("events", { limit, id });
		print(events);
		if (events.length === 0 && !follow) process.stdout.write("nothing happened yet\n");
		while (follow) {
			await new Promise((r) => setTimeout(r, 1000));
			({ events, cursor } = await c.request("events", { after: cursor, id }));
			print(events);
		}
	});
}

/** M58: a task's review from the terminal: the diff with its comments; comment; back. */
async function cmdReview(args: string[]): Promise<void> {
	const id = Number((args[0] ?? "").replace(/^#/, ""));
	if (!Number.isInteger(id) || id <= 0) throw new UsageError("review <task> [comment <file>:<line> <text> | back [note]]");
	await withDaemon(async (c) => {
		const { tasks } = await c.request("task", { action: "list" });
		const t = tasks.find((x) => x.id === id);
		const w = t?.workspace;
		if (!t || !w || !w.path) throw new Error(`#${id} has no workspace to review`);
		const verb = args[1];
		if (verb === "back") {
			const r = await c.request("task", { action: "back", id, note: args.slice(2).join(" ") || undefined });
			process.stdout.write(`#${id} back to work · ${r.note ?? ""}\n`);
			return;
		}
		const d = await taskDiff(w.path, w.baseRef);
		if (!d) throw new Error(`#${id}: git could not diff ${w.branch} against ${w.baseRef}`);
		if (verb === "comment") {
			const m = /^(.+):(\d+)$/.exec(args[2] ?? "");
			const text = args.slice(3).join(" ").trim();
			if (!m || !text) throw new UsageError("review <task> comment <file>:<line> <text>");
			const file = m[1]!;
			const n = Number(m[2]);
			// the line's text, when the diff shows it (an outdated mark needs it)
			const line = d.files.find((f) => f.path === file)?.hunks.flatMap((h) => h.lines).find((l) => (l.newNo ?? l.oldNo) === n);
			const r = await c.request("task", { action: "comment", id, comment: { file, line: n, text, ...(line ? { lineText: commentAnchor(line).lineText } : {}), tip: d.tip } });
			process.stdout.write(`#${id}: ${r.note ?? "kept"}${line ? "" : " (that line is not in the diff)"}\n`);
			return;
		}
		if (verb !== undefined) throw new UsageError("review <task> [comment <file>:<line> <text> | back [note]]");
		process.stdout.write(`#${id} ${t.title} · ${w.branch} against ${w.baseRef} (${d.base.slice(0, 8)}..${d.tip.slice(0, 8)}${w.stage ? ` · ${w.stage}` : ""})\n\n`);
		for (const l of reviewLines(d, w.comments ?? [])) process.stdout.write(`${l}\n`);
	});
}

async function cmdList(args: string[]): Promise<void> {
	const rows = await listRows(args);
	process.stdout.write(formatList(rows, { subagents: args.includes("--subagents") || args.includes("--all"), width: process.stdout.columns || 100 }));
}

async function listRows(args: string[]): Promise<JobRow[]> {
	const all = args.includes("--all");
	const cwdAt = args.indexOf("--cwd");
	const cwd = cwdAt === -1 ? undefined : args[cwdAt + 1];
	if (cwdAt !== -1 && !cwd) throw new UsageError("--cwd needs a directory");
	const { jobs } = await withDaemon((c) => c.request("list", { all, cwd: cwd ? resolvePath(cwd) : undefined }));
	const now = Date.now();
	return all ? jobs : jobs.filter((j) => j.endedAt === null || now - j.endedAt < ENDED_CUTOFF_MS);
}

async function cmdJson(args: string[]): Promise<void> {
	process.stdout.write(`${JSON.stringify(await listRows(args), null, 2)}\n`);
}

async function cmdDaemon(sub: string | undefined, args: string[]): Promise<void> {
	if (sub === "logs") {
		const file = daemonLogPath();
		if (!existsSync(file)) throw new DaemonError(`no daemon log at ${file}`, "no_log");
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		process.stdout.write(`${lines.slice(-50).join("\n")}\n`);
		return;
	}
	if (sub !== "status" && sub !== "stop") throw new UsageError("daemon needs status, logs or stop");
	let client: DaemonClient;
	try {
		client = await DaemonClient.connect();
	} catch {
		process.stdout.write(`daemon not running (socket dir ${runtimeDir()})\n`);
		return;
	}
	try {
		if (sub === "stop") {
			const keepWorkers = args.includes("--keep-workers");
			await client.request("shutdown", { keepWorkers });
			process.stdout.write(keepWorkers ? "daemon stopped; workers kept running\n" : "daemon stopped\n");
			return;
		}
		const s = await client.request("status", {});
		if (s.version !== ROOST_VERSION) {
			process.stderr.write(
				`warning: daemon is ${s.version}, this client is ${ROOST_VERSION}; run pi-roost daemon stop --keep-workers\n`,
			);
		}
		process.stdout.write(
			[
				`version     ${s.version}`,
				`pid         ${s.pid}`,
				`socket dir  ${s.socketDir}`,
				`jobs        ${s.liveJobs} live / ${s.totalJobs} total`,
				`node-pty    ${s.ptyError ? `failed: ${s.ptyError}` : "ok"}`,
				`up since    ${new Date(s.startedAt).toISOString()}`,
				"",
			].join("\n"),
		);
	} finally {
		client.close();
	}
}

/**
 * M33: the standalone hub. It is pi's adapter (it launches pi sessions and draws with
 * pi-tui), loaded by path like the host (the CLI itself imports no pi package): from
 * dist/ when installed, from the checkout's .ts when run from source.
 */
async function cmdHub(rest: string[]): Promise<void> {
	const cwd = resolvePath(rest[0] ?? process.cwd());
	if (!existsSync(cwd)) throw new UsageError(`no such directory: ${cwd}`);
	const pkg = findPiPackage();
	const piCli = pkg ? piCliOf(pkg) : undefined;
	if (!pkg || !piCli)
		throw new Error(
			"the hub needs pi (it runs pi sessions and draws with pi's terminal library): put pi on your PATH, or set ROOST_PI_PACKAGE to the directory of its package (@earendil-works/pi-coding-agent)",
		);
	usePiPackage(pkg);
	const entry = new URL(import.meta.url.endsWith(".ts") ? "../adapters/pi/hub-main.ts" : "../adapters/pi/hub-main.js", import.meta.url);
	const hub = (await import(entry.href)) as { runHub: (o: { cwd: string; piCli: string }) => Promise<void> };
	await hub.runHub({ cwd, piCli });
}

async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	try {
		switch (cmd) {
			case "attach":
				await cmdAttach(rest[0]);
				break;
			case "logs":
				await cmdLogs(rest[0]);
				break;
			case "reply":
				await cmdReply(rest[0], rest.slice(1));
				break;
			case "stop":
			case "rm":
				await cmdStopOrRm(cmd, rest[0]);
				break;
			case "respawn":
				await cmdRespawn(rest);
				break;
			case "hub":
				await cmdHub(rest);
				break;
			case "schedule":
			case "schedules":
				await cmdSchedule(rest);
				break;
			case "list":
			case "ls":
				await cmdList(rest);
				break;
			case "log":
				await cmdLog(rest);
				break;
			case "review":
				await cmdReview(rest);
				break;
			case "--json":
				await cmdJson(rest);
				break;
			case "daemon":
				await cmdDaemon(rest[0], rest.slice(1));
				break;
			case undefined:
			case "-h":
			case "--help":
				process.stdout.write(`${USAGE}\n`);
				return cmd === undefined ? 2 : 0;
			case "-v":
			case "--version":
				process.stdout.write(`${ROOST_VERSION}\n`);
				break;
			default:
				throw new UsageError(`unknown command: ${cmd}`);
		}
		return 0;
	} catch (err) {
		if (err instanceof UsageError) {
			process.stderr.write(`pi-roost: ${err.message}\n\n${USAGE}\n`);
			return 2;
		}
		process.stderr.write(`pi-roost: ${(err as Error).message}\n`);
		return 1;
	}
}

main(process.argv.slice(2)).then((code) => process.exit(code));
