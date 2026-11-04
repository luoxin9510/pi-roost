import { readFileSync } from "node:fs";
import { connect } from "node:net";
import type { DaemonClient } from "./client.ts";
import { hostSocketPath } from "./paths.ts";
import type { JobRow } from "./protocol.ts";
import { screenPath } from "./store.ts";

export const CONTINUE = "Continue where you left off.";
const START_TIMEOUT_MS = 15_000;

/** A failed run was cut off: restarting it should carry on; anything else just reopens. */
export const resumePrompt = (row: JobRow): string | undefined =>
	row.kind !== "shell" && row.state === "failed" ? CONTINUE : undefined;

function hostReady(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect(socketPath);
		sock.once("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.once("error", () => resolve(false));
	});
}

/** The last screen, dimmed, with a starting line at the bottom (AT-1). */
export function startingFrame(id: string, cols: number, rows: number): string {
	let lines: string[] = [];
	try {
		lines = readFileSync(screenPath(id), "utf8").replace(/\n+$/, "").split("\n");
	} catch {
		// never painted: just the starting line
	}
	const body = lines.slice(-(rows - 1)).map((l) => l.slice(0, cols));
	return `\x1b[2J\x1b[H\x1b[2m${body.join("\r\n")}\x1b[0m\x1b[${rows};1H\x1b[7m Session is starting… \x1b[0m`;
}

/** M22: how long a respawn request may take before the attach gives up. */
const RESPAWN_TIMEOUT_MS = 20_000;

/**
 * AT-1: make sure a job has a live worker before attaching. A reaped or ended job
 * is started again from its session file; meanwhile the last screen is shown dimmed.
 */
export async function ensureLive(
	client: DaemonClient,
	row: JobRow,
	out?: { write(s: string): unknown; columns?: number; rows?: number },
): Promise<void> {
	if (row.pid !== null) return;
	// M22: the terminal is the caller's meanwhile (its TUI stopped): never wait for ever
	let timer: NodeJS.Timeout | undefined;
	const { results } = await Promise.race([
		client.request("respawn", { id: row.id, prompt: resumePrompt(row) }),
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("the background service did not answer")), RESPAWN_TIMEOUT_MS);
		}),
	]).finally(() => clearTimeout(timer));
	const r = results[0];
	if (r?.error) throw new Error(r.error);
	out?.write(startingFrame(row.id, out.columns || 80, out.rows || 24));
	const deadline = Date.now() + START_TIMEOUT_MS;
	const socket = hostSocketPath(row.id);
	while (!(await hostReady(socket))) {
		if (Date.now() > deadline) throw new Error(`${row.name} did not start`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
