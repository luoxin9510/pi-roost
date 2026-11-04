import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { readJson } from "../lib/atomic.ts";
import { REPAINT_MARKER } from "../lib/attach.ts";
import { loadConfig } from "../lib/config.ts";
import { clip, messageText } from "../lib/heuristics.ts";
import {
	type AwayLog,
	awayIsEmpty,
	emptyAway,
	NAME_SYSTEM,
	PROGRESS_SYSTEM,
	parseField,
	parseTurnSummary,
	RECAP_SYSTEM,
	recapList,
	splitModelRef,
	TURN_SYSTEM,
	transcriptTail,
} from "../lib/summarizer.ts";
import type { WorkerTracker } from "../lib/worker-state.ts";

const PROGRESS_MS = Number(process.env.PI_ROOST_PROGRESS_MS) || 5 * 60_000; // SM-2
// the first one sooner, so a long turn does not sit on an empty row for five minutes
const FIRST_PROGRESS_MS = Math.min(PROGRESS_MS, Number(process.env.PI_ROOST_FIRST_PROGRESS_MS) || 45_000);
const ASK_TIMEOUT_MS = 20_000;
const RECAP_WAIT_MS = 4_000;
export const RECAP_ENTRY = "pi-roost-recap";

interface Deps {
	tracker: WorkerTracker;
	send: () => void;
	ctx: () => ExtensionContext | undefined;
}

/**
 * SM-4: one completion through the worker's own model registry (custom providers
 * and their auth apply); nothing when no summary model is configured or it fails.
 */
export async function askSummaryModel(
	ctx: ExtensionContext,
	system: string,
	user: string,
	timeoutMs = ASK_TIMEOUT_MS,
): Promise<string | undefined> {
	try {
		const ref = splitModelRef(loadConfig(ctx.cwd).summaryModel);
		if (!ref) return undefined;
		const registry = ctx.modelRegistry;
		const model = registry.find(ref.provider, ref.id);
		if (!model) return undefined;
		const reply = await registry.complete(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			// no thinking for a one-line answer (models that think by default, such as
			// claude-haiku-5-5, spent the whole budget on it); room to spare where it cannot be off
			{ thinkingEnabled: false, maxTokens: 1024, signal: AbortSignal.timeout(timeoutMs) } as never,
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
		return messageText(reply);
	} catch {
		return undefined;
	}
}

export const summaryModelSet = (ctx: ExtensionContext) => !!splitModelRef(loadConfig(ctx.cwd).summaryModel);

/** The conversation as short plain lines, for the summary model. */
export function transcriptLines(ctx: ExtensionContext): string[] {
	const lines: string[] = [];
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type !== "message") continue;
		const m = e.message as { role: string; content?: unknown; toolName?: string };
		const text = clip(messageText(m), 600);
		if (m.role === "user" && text) lines.push(`user: ${text}`);
		else if (m.role === "assistant") {
			const calls = Array.isArray(m.content)
				? (m.content as { type?: string; name?: string }[]).filter((c) => c.type === "toolCall").map((c) => c.name)
				: [];
			if (text) lines.push(`assistant: ${text}`);
			if (calls.length > 0) lines.push(`assistant calls: ${calls.join(", ")}`);
		} else if (m.role === "toolResult" && text) lines.push(`tool ${m.toolName ?? ""}: ${clip(text, 200)}`);
	}
	return lines;
}

function firstUserText(ctx: ExtensionContext): string | undefined {
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "user") {
			const t = messageText(e.message as { content?: unknown }).trim();
			if (t) return t;
		}
	}
	return undefined;
}

/** SM-2 (turn-end and long-turn summaries) and DI-9 (auto-name). */
export function registerSummaries(pi: ExtensionAPI, d: Deps): void {
	let progress: NodeJS.Timeout | undefined;
	let firstProgress: NodeJS.Timeout | undefined;
	let naming = false;

	const stopProgress = () => {
		clearInterval(progress);
		clearTimeout(firstProgress);
		progress = undefined;
		firstProgress = undefined;
	};

	pi.on("agent_start", () => {
		const ctx = d.ctx();
		if (!ctx || !summaryModelSet(ctx)) return;
		stopProgress();
		const run = d.tracker.runId();
		const tick = async () => {
			const c = d.ctx();
			if (!c) return stopProgress();
			const text = await askSummaryModel(c, PROGRESS_SYSTEM, transcriptTail(transcriptLines(c)));
			const line = text ? parseField(text, "summary", 80) : undefined;
			if (line && d.tracker.applyProgressSummary(run, line)) d.send();
		};
		firstProgress = setTimeout(() => void tick(), FIRST_PROGRESS_MS);
		progress = setInterval(() => void tick(), PROGRESS_MS);
		firstProgress.unref?.();
		progress.unref?.();
	});

	// DI-9: an unnamed session gets a name from its first prompt (the user message is
	// in the session only once it ends, after agent_start)
	pi.on("message_end", (event) => {
		if (naming || event.message.role !== "user") return;
		const ctx = d.ctx();
		if (!ctx || !summaryModelSet(ctx) || ctx.sessionManager.getSessionName()) return;
		const task = firstUserText(ctx) ?? messageText(event.message as { content?: unknown }).trim();
		if (!task) return;
		naming = true;
		void askSummaryModel(ctx, NAME_SYSTEM, clip(task, 2000)).then((text) => {
			const name = text ? parseField(text, "name", 60) : undefined;
			const c = d.ctx();
			if (name && c === ctx && !c.sessionManager.getSessionName()) pi.setSessionName(name);
		});
	});

	pi.on("agent_settled", (event) => {
		stopProgress();
		const ctx = d.ctx();
		if (event.aborted || !ctx || !summaryModelSet(ctx)) return;
		const run = d.tracker.runId();
		void askSummaryModel(ctx, TURN_SYSTEM, transcriptTail(transcriptLines(ctx))).then((text) => {
			const s = text ? parseTurnSummary(text) : undefined;
			if (s && d.ctx() === ctx && d.tracker.applyTurnSummary(run, s)) d.send();
		});
	});

	pi.on("session_shutdown", () => {
		stopProgress();
		naming = false;
	});
}

/**
 * Host-written attach flag (its own file: state.json is the daemon's to rewrite).
 * The host writes it, then signals the worker with SIGUSR2. The signal goes to the
 * process the host started: launch pi directly, not through a wrapper without a handler.
 */
function attachedNow(): boolean {
	return attachedFile()?.attached === true;
}

function attachedFile(): { attached?: unknown; at?: unknown; replay?: unknown } | undefined {
	const dir = process.env.PI_JOB_DIR;
	if (!dir) return undefined;
	return readJson<{ attached?: unknown; at?: unknown; replay?: unknown }>(join(dir, "attached.json"));
}

const REPAINT_DELAY_MS = 15;

/** The attach this process last repainted for (module-wide: it outlives a session switch). */
let handledAt: unknown;
/** True once a session's TUI is in hand: only then do reports promise a repaint. */
let repaintReady = false;

export function attachRepaintReady(): boolean {
	return repaintReady;
}

/**
 * M14 (kept for hosts from before M21, which wait for this repaint; a newer host shows
 * its own copy of the screen and says `replay` in attached.json, and then this does
 * nothing). M14: attach feels like `pi --resume`. Nobody watched while this pi started, so the
 * terminal it set up (fullscreen pi's alternate screen, mouse, kitty keyboard, …) was the
 * host's, and what is on the user's screen is the view they came from. On each attach
 * this pi stops its TUI and starts it again on the real terminal, which answers its
 * queries now, then draws the session once (synchronized), as a fresh start does. It
 * first writes REPAINT_MARKER: the host holds back what pi drew for a screen the user is
 * not on and forwards from there.
 */
export function registerAttachRepaint(pi: ExtensionAPI): void {
	let tui: TUI | undefined;
	let timer: NodeJS.Timeout | undefined;
	let onSignal: (() => void) | undefined;
	const repaint = () => {
		timer = undefined;
		const t = tui;
		if (!t || !attachedNow()) return;
		process.stdout.write(REPAINT_MARKER);
		try {
			t.stop({ preserveScreen: true });
		} catch {}
		try {
			t.start();
			t.requestRender(true);
		} catch {
			// a TUI between sessions: the next session draws it
		}
	};
	const check = () => {
		const f = attachedFile();
		// a takeover writes a new time while it stays attached
		if (f?.attached !== true || f.at === handledAt) return;
		handledAt = f.at;
		// M21: the host shows the screen as it is; a repaint now would only draw it twice
		if (f.replay === true) return;
		clearTimeout(timer);
		timer = setTimeout(repaint, REPAINT_DELAY_MS);
		timer.unref?.();
	};
	pi.on("session_start", (_event, ctx) => {
		if (onSignal) process.off("SIGUSR2", onSignal);
		onSignal = undefined;
		if (!ctx.hasUI || !process.env.PI_JOB_DIR) return;
		// a widget that draws nothing, for the TUI it is given (the factory runs now)
		ctx.ui.setWidget(
			"pi-roost-attach",
			(t) => {
				tui = t;
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "belowEditor" },
		);
		repaintReady = tui !== undefined;
		onSignal = check;
		process.on("SIGUSR2", onSignal);
		// attached while no session listened (a session switch, a start): repaint now
		check();
	});
	pi.on("session_shutdown", () => {
		if (onSignal) process.off("SIGUSR2", onSignal);
		onSignal = undefined;
		clearTimeout(timer);
		tui = undefined;
		repaintReady = false;
	});
}

const GUARD = Symbol.for("pi-roost.sigusr2-guard");

/** AT-5: on attach, a TUI-only line about what happened while nobody watched. */
export function registerRecap(pi: ExtensionAPI, d: Deps): void {
	// SIGUSR2 would end the process while no session listens (between /new's two sessions)
	const g = globalThis as { [GUARD]?: true };
	if (!g[GUARD]) {
		g[GUARD] = true;
		process.on("SIGUSR2", () => {});
	}
	let away: AwayLog = emptyAway();
	let attached = false;
	let onSignal: (() => void) | undefined;

	pi.registerEntryRenderer<{ text?: string }>(RECAP_ENTRY, (entry, _opts, theme) => {
		const text = typeof entry.data?.text === "string" ? entry.data.text : "";
		return text ? new Text(theme.fg("dim", `↺ While you were away: ${text}`), 1, 0) : undefined;
	});

	const showRecap = async (log: AwayLog, ctx: ExtensionContext) => {
		let text = recapList(log);
		if (summaryModelSet(ctx)) {
			const reply = await askSummaryModel(
				ctx,
				RECAP_SYSTEM,
				`Events: ${text}\n\nRecent transcript:\n${transcriptTail(transcriptLines(ctx), 3000)}`,
				RECAP_WAIT_MS,
			);
			const recap = reply ? parseField(reply, "recap", 300) : undefined;
			if (recap) text = recap;
		}
		if (d.ctx() === ctx) pi.appendEntry(RECAP_ENTRY, { text });
	};

	pi.on("tool_execution_start", (event) => {
		if (attached || event.parentToolCallId) return;
		away.tools[event.toolName] = (away.tools[event.toolName] ?? 0) + 1;
	});
	pi.on("agent_settled", () => {
		if (attached) return;
		away.turns++;
		const r = d.tracker.report();
		if (r.state === "failed") away.failures++;
		if (r.waitingFor === "question" && r.question) away.questions.push(r.question);
	});

	pi.on("session_start", (event, ctx) => {
		attached = attachedNow();
		if (event.reason !== "reload") away = emptyAway();
		if (onSignal) process.off("SIGUSR2", onSignal);
		onSignal = () => {
			const now = attachedNow();
			if (now && !attached && !awayIsEmpty(away) && d.ctx() === ctx) void showRecap(away, ctx);
			if (now !== attached) away = emptyAway();
			attached = now;
		};
		process.on("SIGUSR2", onSignal);
	});
	pi.on("session_shutdown", () => {
		if (onSignal) process.off("SIGUSR2", onSignal);
		onSignal = undefined;
	});
}
