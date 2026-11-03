import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { DaemonClient } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { buildLaunch, fallbackName } from "../lib/dispatch.ts";
import { messageText } from "../lib/heuristics.ts";
import { daemonSocketPath, isScratchSession, scratchDir } from "../lib/paths.ts";
import { agentViewOpen, openAgentView } from "./open-view.ts";

const TOOL_WAIT_MS = 10_000; // BG-2
const SETTLE_GRACE_MS = 250;
const HINT_MS = 10_000; // BG-11
const POLL_MS = 10_000;
const CONTINUE = "Continue where you left off.";
const STATUS_KEY = "pi-roost";

/**
 * Foreground role: every plain interactive pi. Moves its conversation to the
 * background with ← on an empty prompt or /bg (PRD §6.6, C4, C5) and shows the
 * footer hint. Nothing connects to the daemon until it is needed (C10).
 */
export function registerForeground(pi: ExtensionAPI): void {
	let running = false;
	let toolsRunning = 0;
	let dialogs = 0;
	let moving: { skip: () => void } | undefined;
	const settledWaiters = new Set<(aborted: boolean) => void>();
	const toolWaiters = new Set<() => void>();
	let stopKeys: (() => void) | undefined;
	let stopFooter: (() => void) | undefined;

	pi.on("agent_start", () => {
		running = true;
	});
	pi.on("agent_settled", (event) => {
		running = false;
		toolsRunning = 0;
		for (const w of settledWaiters) w(event.aborted);
		for (const w of toolWaiters) w();
	});
	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) toolsRunning++;
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		toolsRunning = Math.max(0, toolsRunning - 1);
		if (toolsRunning === 0) for (const w of toolWaiters) w();
	});
	pi.on("ui_prompt_start", () => {
		dialogs++;
	});
	pi.on("ui_prompt_end", () => {
		dialogs = Math.max(0, dialogs - 1);
	});

	pi.on("session_start", (_event, ctx) => {
		dialogs = 0;
		stopKeys?.();
		stopFooter?.();
		stopKeys = stopFooter = undefined;
		if (!ctx.hasUI || pi.getFlag("agents") === true || typeof pi.getFlag("bg") === "string") return;
		if (isScratchSession(ctx.sessionManager.getSessionFile())) return;
		const config = loadConfig(ctx.cwd);
		if (config.leftArrowOpensAgents) {
			stopKeys = ctx.ui.onTerminalInput((data) => {
				if (isKeyRelease(data) || !matchesKey(data, Key.left)) return undefined;
				if (dialogs > 0 || agentViewOpen()) return undefined;
				if (moving) {
					moving.skip(); // BG-2: ← again skips the wait
					return { consume: true };
				}
				if (ctx.ui.getEditorText().length > 0) return undefined;
				// Only commands get a context that can switch sessions: submit /bg instead.
				ctx.ui.setEditorText("/bg");
				return { data: "\r" };
			});
		}
		stopFooter = startFooter(ctx, config.leftArrowOpensAgents);
	});
	pi.on("session_shutdown", () => {
		stopKeys?.();
		stopFooter?.();
		stopKeys = stopFooter = undefined;
	});

	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		if (moving) return;
		moving = { skip: () => {} };
		try {
			await moveToBackground(ctx, args.trim());
		} finally {
			moving = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};
	pi.registerCommand("bg", { description: "Move this conversation to the background [prompt]", handler });
	pi.registerCommand("background", { description: "Move this conversation to the background [prompt]", handler });

	async function moveToBackground(ctx: ExtensionCommandContext, prompt: string): Promise<void> {
		const original = ctx.sessionManager.getSessionFile();
		if (!original) return ctx.ui.notify("pi-roost: this session is not saved (--no-session); nothing to move", "warning");
		if (isScratchSession(original)) return ctx.ui.notify("pi-roost: this is an empty hand-off session", "info");
		if (dialogs > 0) return ctx.ui.notify("pi-roost: answer the open dialog first", "warning");

		let firstPrompt = prompt;
		if (running) {
			let userStopped = false;
			const settled = new Promise<void>((resolve) => {
				const w = (aborted: boolean) => {
					settledWaiters.delete(w);
					if (aborted) userStopped = true;
					resolve();
				};
				settledWaiters.add(w);
			});
			if (toolsRunning > 0) {
				ctx.ui.setStatus(STATUS_KEY, "Moving to background after the current tool… (← again to skip)");
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, TOOL_WAIT_MS);
					const w = () => {
						clearTimeout(timer);
						toolWaiters.delete(w);
						resolve();
					};
					toolWaiters.add(w);
					moving = { skip: w };
				});
			}
			// A user's Esc ends the tool first and settles the run a moment later: give that
			// a chance to arrive before deciding the turn is still ours to interrupt.
			if (running && !userStopped) await Promise.race([settled, new Promise((r) => setTimeout(r, SETTLE_GRACE_MS))]);
			if (userStopped) return ctx.ui.notify("pi-roost: you stopped the turn; the conversation stays here", "info");
			if (dialogs > 0) return ctx.ui.notify("pi-roost: a dialog opened; answer it first", "warning");
			if (running) {
				ctx.abort();
				await Promise.race([settled, ctx.waitForIdle()]);
				// BG-4: an interrupted turn picks up again in the background
				firstPrompt = prompt ? `${CONTINUE}\n\n${prompt}` : CONTINUE;
			}
		}

		const name = ctx.sessionManager.getSessionName() ?? conversationName(ctx) ?? "conversation";
		const cwd = ctx.cwd;
		const argv = process.argv;
		const config = loadConfig(cwd);
		mkdirSync(scratchDir(), { recursive: true, mode: 0o700 });
		const scratch = join(scratchDir(), `${Date.now()}-${process.pid}.jsonl`);

		// C4: leave the file first (its writer lock goes with session_shutdown), then let
		// the daemon start the one new writer. The scratch session is never written.
		const result = await ctx.switchSession(scratch, {
			withSession: async (next) => {
				let id: string;
				let client: DaemonClient | undefined;
				try {
					client = await DaemonClient.connectOrStart();
					({ id } = await client.request(
						"dispatch",
						buildLaunch({
							task: firstPrompt,
							cwd,
							sessionFile: original,
							name,
							origin: "adopt",
							argv,
							execPath: process.execPath,
							env: process.env,
							extraEnv: config.envAllowList,
							piVersion: VERSION,
						}),
					));
				} catch (err) {
					next.ui.notify(`pi-roost: could not move to the background: ${(err as Error).message}`, "error");
					await next.switchSession(original);
					return;
				} finally {
					client?.close();
				}
				await openAgentView(next, { origin: id, banner: "Your conversation moved to the background" });
			},
		});
		if (result.cancelled) ctx.ui.notify("pi-roost: another extension cancelled the switch", "warning");
	}
}

/** DI-9 fallback for an unnamed conversation: its first user message. */
function conversationName(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message as { content?: unknown });
		if (text.trim()) return fallbackName(text);
	}
	return undefined;
}

/** BG-11: "← for agents" at first, then waiting/done counts while the daemon runs. */
function startFooter(ctx: ExtensionContext, leftArrow: boolean): () => void {
	const key = leftArrow ? "←" : "/agents";
	let stopped = false;
	let lastDone: number | undefined;
	ctx.ui.setStatus(STATUS_KEY, `${key} for agents`);
	const poll = async () => {
		if (stopped) return;
		// C10: no socket, no daemon, no connection
		if (!existsSync(daemonSocketPath())) return ctx.ui.setStatus(STATUS_KEY, undefined);
		let client: DaemonClient | undefined;
		try {
			client = await DaemonClient.connect();
			const { jobs } = await client.request("list", {});
			if (stopped) return;
			const waiting = jobs.filter((j) => j.state === "blocked").length;
			const done = jobs.filter((j) => j.state === "done" && j.pid !== null).length;
			const newlyDone = lastDone !== undefined && done > lastDone ? done - lastDone : 0;
			lastDone = done;
			const text = waiting > 0 ? `${key} ${waiting} agent${waiting === 1 ? "" : "s"}` : newlyDone > 0 ? `${key} ${newlyDone} done` : undefined;
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} finally {
			client?.close();
		}
	};
	const first = setTimeout(() => {
		void poll();
	}, HINT_MS);
	const timer = setInterval(() => void poll(), POLL_MS);
	first.unref?.();
	timer.unref?.();
	return () => {
		stopped = true;
		clearTimeout(first);
		clearInterval(timer);
	};
}
