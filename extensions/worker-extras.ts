import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readJson } from "../lib/atomic.ts";
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
			{ maxTokens: 400, signal: AbortSignal.timeout(timeoutMs) },
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
	let naming = false;

	const stopProgress = () => {
		clearInterval(progress);
		progress = undefined;
	};

	pi.on("agent_start", () => {
		const ctx = d.ctx();
		if (!ctx || !summaryModelSet(ctx)) return;
		stopProgress();
		const run = d.tracker.runId();
		progress = setInterval(async () => {
			const c = d.ctx();
			if (!c) return stopProgress();
			const text = await askSummaryModel(c, PROGRESS_SYSTEM, transcriptTail(transcriptLines(c)));
			const line = text ? parseField(text, "summary", 80) : undefined;
			if (line && d.tracker.applyProgressSummary(run, line)) d.send();
		}, PROGRESS_MS);
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

/** Host-written attach flag: the host sets it, then signals the worker (SIGUSR2). */
function attachedNow(): boolean {
	const dir = process.env.PI_JOB_DIR;
	if (!dir) return false;
	return readJson<{ attached?: unknown }>(join(dir, "state.json"))?.attached === true;
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

	pi.on("session_start", (_event, ctx) => {
		attached = attachedNow();
		away = emptyAway();
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
