import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { DaemonClient } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { buildLaunch, fallbackName } from "../lib/dispatch.ts";
import { messageText } from "../lib/heuristics.ts";
import { observeJob } from "../lib/job-events.ts";
import { daemonSocketPath, isScratchSession, scratchDir } from "../lib/paths.ts";
import { agentViewOpen, agentViewOpens, openAgentView } from "./open-view.ts";

export const TOOL_WAIT_MS = 10_000; // BG-2
export const SETTLE_GRACE_MS = 250;
const HINT_MS = 10_000; // BG-11
const POLL_MS = 10_000;
const PENDING_MS = 2_000;
const CONTINUE = "Continue where you left off.";
const STATUS_KEY = "pi-roost";
const PROBE_KEY = "pi-roost-focus";

const noop = () => {};

/** The main prompt editor, told apart from pi's selectors and extension UIs that take its place. */
export function isPromptEditor(c: Component | null | undefined): boolean {
	const e = c as { getText?: unknown; setText?: unknown; onSubmit?: unknown } | null | undefined;
	return !!e && typeof e.getText === "function" && typeof e.setText === "function" && "onSubmit" in e;
}

/** pi-tui keeps focus private in 1.5 (a public getter exists in later builds). */
export function focusedOf(tui: TUI | undefined): Component | null | undefined {
	const t = tui as (TUI & { getFocusedComponent?: () => Component | null; focusedComponent?: Component | null }) | undefined;
	return t?.getFocusedComponent ? t.getFocusedComponent() : t?.focusedComponent;
}

/** Run a UI call that may hit a context pi has already replaced. */
function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		// stale context after a session switch or shutdown
	}
}

/**
 * Foreground role: every plain interactive pi. Moves its conversation to the
 * background with ← on an empty prompt or /bg (PRD §6.6, C4, C5) and shows the
 * footer hint. Nothing connects to the daemon until it is needed (C10).
 */
export function registerForeground(pi: ExtensionAPI): void {
	let running = false;
	let compacting = false;
	let toolsRunning = 0;
	let dialogs = 0;
	/** Set while a move is under way; `skip` ends the tool wait (BG-2). */
	let moving: { skip: () => void } | undefined;
	/** ← was turned into a submitted /bg that has not reached the command yet. */
	let pendingUntil = 0;
	const settledWaiters = new Set<(aborted: boolean) => void>();
	const toolWaiters = new Set<() => void>();
	let stopKeys: (() => void) | undefined;
	let footer: Footer | undefined;

	pi.on("agent_start", () => {
		running = true;
		compacting = false;
	});
	pi.on("agent_settled", (event) => {
		running = false;
		toolsRunning = 0;
		for (const w of [...settledWaiters]) w(event.aborted);
		for (const w of [...toolWaiters]) w();
	});
	pi.on("tool_execution_start", (event) => {
		if (!event.parentToolCallId) toolsRunning++;
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		toolsRunning = Math.max(0, toolsRunning - 1);
		if (toolsRunning === 0) for (const w of [...toolWaiters]) w();
	});
	pi.on("ui_prompt_start", () => {
		dialogs++;
	});
	pi.on("ui_prompt_end", () => {
		dialogs = Math.max(0, dialogs - 1);
	});
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});

	const stopAll = () => {
		stopKeys?.();
		footer?.stop();
		stopKeys = footer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		dialogs = 0;
		compacting = false;
		pendingUntil = 0;
		stopAll();
		if (!ctx.hasUI || pi.getFlag("agents") === true || typeof pi.getFlag("bg") === "string") return;
		if (isScratchSession(ctx.sessionManager.getSessionFile())) return;
		const config = loadConfig(ctx.cwd);
		if (config.leftArrowOpensAgents) {
			// No focus API for extensions: an empty widget below the editor hands us the TUI.
			let tui: TUI | undefined;
			ctx.ui.setWidget(
				PROBE_KEY,
				(t) => {
					tui = t;
					return { render: () => [], invalidate: noop };
				},
				{ placement: "belowEditor" },
			);
			stopKeys = ctx.ui.onTerminalInput((data) => {
				if (isKeyRelease(data) || !matchesKey(data, Key.left)) return undefined;
				if (dialogs > 0) return undefined; // a dialog may open while we wait for a tool
				if (moving) {
					moving.skip(); // BG-2: ← again skips the wait
					return { consume: true };
				}
				if (Date.now() < pendingUntil) return { consume: true };
				if (agentViewOpen() || !isPromptEditor(focusedOf(tui))) return undefined;
				if (ctx.ui.getEditorText().length > 0) return undefined;
				// Only commands get a context that can switch sessions: submit /bg instead.
				ctx.ui.setEditorText("/bg");
				pendingUntil = Date.now() + PENDING_MS;
				return { data: "\r" };
			});
		}
		footer = startFooter(ctx, config.leftArrowOpensAgents, () => moving !== undefined);
	});
	pi.on("session_shutdown", () => {
		stopAll();
	});

	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		pendingUntil = 0;
		if (moving) return;
		moving = { skip: noop };
		let switched = false;
		try {
			switched = await moveToBackground(ctx, args.trim());
		} finally {
			moving = undefined;
			// after a switch ctx belongs to a runtime that is gone
			if (!switched) safely(() => ctx.ui.setStatus(STATUS_KEY, undefined));
		}
	};
	pi.registerCommand("bg", { description: "Move this conversation to the background [prompt]", handler });
	// BG-8: a copy of this conversation works in the background; this one carries on
	pi.registerCommand("fork", {
		description: "Copy this conversation into a background session [prompt]",
		handler: async (args, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file || !existsSync(file)) return ctx.ui.notify("pi-roost: nothing to fork yet (the session has no saved messages)", "warning");
			let client: DaemonClient | undefined;
			try {
				const copy = SessionManager.forkFrom(file, ctx.cwd, dirname(file)).getSessionFile();
				if (!copy) throw new Error("could not create the copy");
				const base = ctx.sessionManager.getSessionName() ?? conversationName(ctx) ?? "conversation";
				const config = loadConfig(ctx.cwd);
				client = await DaemonClient.connectOrStart();
				const { id, name } = await client.request(
					"dispatch",
					buildLaunch({
						task: args.trim(),
						cwd: ctx.cwd,
						sessionFile: copy,
						name: `${base} (fork)`,
						origin: "fork",
						argv: process.argv,
						execPath: process.execPath,
						env: process.env,
						extraEnv: config.envAllowList,
						piVersion: VERSION,
					}),
				);
				ctx.ui.notify(`session running · ${name} · ${id} — open it from /agents`, "info");
			} catch (err) {
				ctx.ui.notify(`pi-roost: could not fork: ${(err as Error).message}`, "error");
			} finally {
				client?.close();
			}
		},
	});
	pi.registerCommand("background", { description: "Move this conversation to the background [prompt]", handler });

	/** Returns whether the session was switched (ctx is stale from then on). */
	async function moveToBackground(ctx: ExtensionCommandContext, prompt: string): Promise<boolean> {
		const original = ctx.sessionManager.getSessionFile();
		const refuse = (text: string, level: "info" | "warning" = "warning") => {
			ctx.ui.notify(`pi-roost: ${text}`, level);
			return false;
		};
		if (!original) return refuse("this session is not saved (--no-session); nothing to move");
		if (isScratchSession(original)) return refuse("this is an empty hand-off session", "info");
		if (dialogs > 0) return refuse("answer the open dialog first");
		if (compacting) return refuse("the conversation is being compacted; try again when it is done");

		// pi writes a session file with its first reply: before that there is nothing to
		// move, and ← simply opens the agent view.
		if (!existsSync(original)) {
			if (running) return refuse("wait for the first reply, then move this conversation", "info");
			await openAgentView(ctx);
			return false;
		}

		let firstPrompt = prompt;
		if (running) {
			let userStopped = false;
			let onSettled: ((aborted: boolean) => void) | undefined;
			const settled = new Promise<void>((resolve) => {
				onSettled = (aborted) => {
					if (aborted) userStopped = true;
					resolve();
				};
				settledWaiters.add(onSettled);
			});
			const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
			try {
				if (toolsRunning > 0) {
					ctx.ui.setStatus(STATUS_KEY, "Moving to background after the current tool… (← again to skip)");
					let onTool: (() => void) | undefined;
					let timer: NodeJS.Timeout | undefined;
					await new Promise<void>((resolve) => {
						timer = setTimeout(resolve, TOOL_WAIT_MS);
						onTool = resolve;
						toolWaiters.add(onTool);
						moving = { skip: resolve };
					});
					clearTimeout(timer);
					if (onTool) toolWaiters.delete(onTool);
					moving = { skip: noop };
				}
				// A user's Esc ends the tool first and settles the run a moment later: give that
				// a chance to arrive before deciding the turn is still ours to interrupt.
				if (running && !userStopped) await Promise.race([settled, sleep(SETTLE_GRACE_MS)]);
				if (userStopped) return refuse("you stopped the turn; the conversation stays here", "info");
				if (dialogs > 0) return refuse("a dialog opened; answer it first");
				if (running) {
					ctx.abort();
					await Promise.race([settled, ctx.waitForIdle()]);
					// BG-4: an interrupted turn picks up again in the background
					firstPrompt = prompt ? `${CONTINUE}\n\n${prompt}` : CONTINUE;
				}
			} finally {
				if (onSettled) settledWaiters.delete(onSettled);
			}
			// Let pi finish delivering agent_settled before tearing the session down.
			await ctx.waitForIdle();
			await new Promise((r) => setImmediate(r));
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
				try {
					await openAgentView(next, { origin: id, banner: "Your conversation moved to the background" });
				} catch (err) {
					next.ui.notify(`pi-roost: agent view failed: ${(err as Error).message}`, "error");
				}
				// Leave the hand-off session for a fresh conversation beside the moved one
				// (newSession would stay in the scratch directory). Written lazily, as usual.
				const fresh = SessionManager.create(cwd, dirname(original)).getSessionFile();
				let left = false;
				try {
					left = !!fresh && !(await next.switchSession(fresh)).cancelled;
				} catch {
					// fall through to the original below
				}
				// the original belongs to the worker now: say how to get out of the hand-off session
				if (!left) next.ui.notify("pi-roost: could not open a fresh session; use /new", "warning");
			},
		});
		if (result.cancelled) return refuse("another extension cancelled the switch");
		return true;
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

interface Footer {
	stop(): void;
}

export interface FooterCounts {
	waiting: number;
	done: number;
}

/** Footer text for BG-11; `seenDone` is how many completions the user has already been told about. */
export function footerText(key: string, c: FooterCounts, seenDone: number): string | undefined {
	if (c.waiting > 0) return `${key} ${c.waiting} agent${c.waiting === 1 ? "" : "s"}`;
	if (c.done > seenDone) return `${key} ${c.done - seenDone} done`;
	return undefined;
}

/** BG-11: "← for agents" at first, then waiting/done counts while the daemon runs. */
function startFooter(ctx: ExtensionContext, leftArrow: boolean, busy: () => boolean): Footer {
	const key = leftArrow ? "←" : "/agents";
	let stopped = false;
	// completions that were already there when this session started are not news
	let seenDone: number | undefined;
	let opens = agentViewOpens();
	const set = (text: string | undefined) => {
		if (!stopped && !busy()) safely(() => ctx.ui.setStatus(STATUS_KEY, text));
	};
	set(`${key} for agents`);
	const poll = async () => {
		if (stopped) return;
		// C10: no socket, no daemon, no connection
		if (!existsSync(daemonSocketPath())) return set(undefined);
		let client: DaemonClient | undefined;
		try {
			client = await DaemonClient.connect();
			const { jobs } = await client.request("list", {});
			// NT-2 for this process's listeners; an open agent view announces its own
			if (!agentViewOpen()) for (const j of jobs) observeJob(j);
			const live = jobs.filter((j) => j.pid !== null);
			const counts = { waiting: live.filter((j) => j.state === "blocked").length, done: live.filter((j) => j.state === "done").length };
			seenDone = Math.min(seenDone ?? counts.done, counts.done);
			// "done" stays until the user opens the agent view
			if (agentViewOpen() || agentViewOpens() !== opens) seenDone = counts.done;
			opens = agentViewOpens();
			set(footerText(key, counts, seenDone));
		} catch {
			set(undefined);
		} finally {
			client?.close();
		}
	};
	const tick = () => void poll().catch(noop);
	const first = setTimeout(tick, HINT_MS);
	const timer = setInterval(tick, POLL_MS);
	first.unref?.();
	timer.unref?.();
	return {
		stop() {
			stopped = true;
			clearTimeout(first);
			clearInterval(timer);
		},
	};
}
