#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { attachToHost } from "../lib/attach.ts";
import { DaemonClient, DaemonError } from "../lib/client.ts";
import { hostControl } from "../lib/hostclient.ts";
import { daemonLogPath, hostSocketPath, runtimeDir } from "../lib/paths.ts";
import type { JobRow } from "../lib/protocol.ts";
import { screenPath } from "../lib/store.ts";
import { ROOST_VERSION } from "../lib/version.ts";

const USAGE = `pi-roost ${ROOST_VERSION} — background pi sessions

usage:
  pi-roost attach <id|name>        open a background session (Ctrl+Z detaches)
  pi-roost logs <id|name>          print its current or last screen
  pi-roost stop <id|name>          stop it
  pi-roost rm <id|name>            stop it and delete its record
  pi-roost --json [--all] [--cwd <dir>]
                                   list jobs as JSON (--all includes ended > 48 h ago)
  pi-roost daemon status|logs|stop [--keep-workers]

start one with: pi --bg "<task>"`;

const ENDED_CUTOFF_MS = 48 * 60 * 60 * 1000;

class UsageError extends Error {}

const isLive = (row: JobRow) => row.state === "working" || row.state === "blocked";

async function withDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
	const client = await DaemonClient.connectOrStart();
	try {
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
	const row = await withDaemon((c) => findRow(c, query));
	if (!isLive(row)) throw new DaemonError(`${row.id} · ${row.name} is ${row.state}; nothing to attach to`, "not_live");
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new DaemonError("attach needs a terminal", "no_tty");
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
		await c.request(op, { id: row.id });
		process.stdout.write(`${op === "stop" ? "stopped" : "removed"} · ${row.id} · ${row.name}\n`);
	});
}

async function cmdJson(args: string[]): Promise<void> {
	const all = args.includes("--all");
	const cwdAt = args.indexOf("--cwd");
	const cwd = cwdAt === -1 ? undefined : args[cwdAt + 1];
	if (cwdAt !== -1 && !cwd) throw new UsageError("--cwd needs a directory");
	const { jobs } = await withDaemon((c) => c.request("list", { all, cwd: cwd ? resolvePath(cwd) : undefined }));
	const now = Date.now();
	const rows = all ? jobs : jobs.filter((j) => j.endedAt === null || now - j.endedAt < ENDED_CUTOFF_MS);
	process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
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
			case "stop":
			case "rm":
				await cmdStopOrRm(cmd, rest[0]);
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
