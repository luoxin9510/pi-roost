import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, VERSION } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { type DeliverItem, type JobIdentity, jobIdentity, Reporter } from "../../lib/agent-client.ts";
import { hostControl } from "../../lib/hostclient.ts";
import { AGENT_MESSAGE_TYPE, isAgentKind, RESULT_MAX } from "../../lib/comms.ts";
import { messageText } from "../../lib/heuristics.ts";
import { type ContextInfo, PROTOCOL_VERSION } from "../../lib/protocol.ts";
import { readJob } from "../../lib/store.ts";
import { worktreeNote } from "../../lib/worktree.ts";
import { sessionUsage, type UsageInfo } from "../../lib/usage.ts";
import { type AgentLink, registerAgentTools } from "./agent-tools.ts";
import { onMobileActivity } from "./mobile.ts";
import { type PrLinks, registerPrLinks } from "./pr-links.ts";
import { registerEarlierHistory } from "./earlier-history.ts";
import { attachRepaintReady, registerAttachRepaint, registerRecap, registerSummaries } from "./worker-extras.ts";
import {
	CUSTOM_DIALOG_MS,
	FIRST_PROMPT_MS,
	WorkerTracker,
} from "../../lib/worker-state.ts";

// M31: the transport (identity, reports, replies) is the agent client every agent uses
export { jobIdentity, Reporter, type DeliverItem, type JobIdentity } from "../../lib/agent-client.ts";

const DOUBLE_PRESS_MS = 1000;

/** The host socket of this worker's own job; it sits next to the daemon socket. */
const hostSocketOf = (job: JobIdentity) => join(dirname(job.socket), `host-${job.id}.sock`);

/**
 * AT-3: keys that would leave or kill a worker detach the attached terminal
 * instead (← on an empty prompt, /exit, a double Ctrl+C or Ctrl+D, Ctrl+Z).
 */
function registerDetachKeys(ctx: ExtensionContext, job: JobIdentity, dialogOpen: () => boolean): () => void {
	let lastCtrlC = 0;
	let lastCtrlD = 0;
	const detach = () => void hostControl(hostSocketOf(job), "detach").catch(() => {});
	return ctx.ui.onTerminalInput((data) => {
		if (isKeyRelease(data)) return undefined;
		// M22: pi suspends itself on Ctrl+Z; in the background nothing would continue it
		// (the session froze for good). Any Ctrl+Z that gets here detaches instead.
		if (matchesKey(data, Key.ctrl("z"))) {
			detach();
			return { consume: true };
		}
		// Listeners see keys before any focused component, but getEditorText() is always
		// the main editor: leave dialogs and overlays their keys.
		if (dialogOpen()) return undefined;
		if (matchesKey(data, Key.ctrl("c"))) {
			// pi clears a non-empty editor on the first press and exits on a second one
			// within 500 ms, whatever the editor held: always take the second press.
			const now = Date.now();
			const second = now - lastCtrlC < DOUBLE_PRESS_MS;
			lastCtrlC = second ? 0 : now;
			if (!second) return undefined;
			detach();
			return { consume: true };
		}
		const empty = ctx.ui.getEditorText().length === 0;
		if (matchesKey(data, Key.left) && empty) {
			detach();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter) && /^\/(?:exit|quit)$/.test(ctx.ui.getEditorText().trim())) {
			ctx.ui.setEditorText("");
			detach();
			return { consume: true };
		}
		if (matchesKey(data, Key.ctrl("d")) && empty) {
			// pi would exit on an empty prompt, which would end the background session
			const now = Date.now();
			if (now - lastCtrlD < DOUBLE_PRESS_MS) detach();
			else ctx.ui.notify("Ctrl+D again to detach (the session keeps running)", "info");
			lastCtrlD = now;
			return { consume: true };
		}
		return undefined;
	});
}

const RETRY_MS = 500;
const START_WAIT_MS = 10_000;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Replies from the agent view, handed to pi one at a time (PK-2, PK-4).
 * A prompt sent while idle starts a run asynchronously; the next reply waits
 * for that run to start and then joins as a follow-up, because a second
 * prompt before streaming begins would be rejected (and pi only logs it).
 */
export class ReplyQueue {
	private queue: DeliverItem[] = [];
	/** M9: agent items handed to pi, acknowledged once pi has them in the session. */
	private handed = new Set<number>();
	/** M9: agent items already in this session (seen, or found on start), as `job:seq`. */
	private seen = new Set<string>();
	/** M9: the agent item that started the run now starting, if one did. */
	private agentStarter: DeliverItem | undefined;
	/** M9: a user reply joined the current run (it is the user's run then). */
	private userJoined = false;
	private lastSeq = 0;
	private awaitingStart = 0;
	private timer: NodeJS.Timeout | undefined;
	private pi: ExtensionAPI;
	private env: {
		ctx: () => ExtensionContext | undefined;
		running: () => boolean;
		dialogOpen: () => boolean;
		ack: (seq: number, exact?: boolean) => void;
		/** M9: seqs restart with each job of a session; agent items are told apart by job. */
		jobId?: string;
	};

	constructor(pi: ExtensionAPI, env: ReplyQueue["env"]) {
		this.pi = pi;
		this.env = env;
	}

	add(item: DeliverItem | number, legacyText?: string): void {
		const it: DeliverItem = typeof item === "number" ? { seq: item, text: legacyText ?? "" } : item;
		const { seq } = it;
		const agent = isAgentKind(it.kind);
		if (agent && this.seen.has(this.seenKey(seq))) return this.env.ack(seq, true); // already in the session
		if (seq <= this.lastSeq || this.queue.some((q) => q.seq === seq) || this.handed.has(seq)) {
			// a resend; an agent item handed to pi is acknowledged when pi has it
			if (!this.handed.has(seq)) this.env.ack(seq, agent);
			return;
		}
		this.queue.push(it);
		this.queue.sort((a, b) => a.seq - b.seq);
		this.pump();
	}

	pump(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const ctx = this.env.ctx();
		while (ctx && this.queue.length > 0) {
			const next = this.queue[0]!;
			if (isAgentKind(next.kind)) {
				if (this.pumpAgent(ctx, next)) continue;
				this.applySettingsBehind(ctx);
				return;
			}
			if (this.applySetting(ctx, next.text)) {
				this.done(next.seq);
				continue;
			}
			if (this.env.dialogOpen()) return; // resumed by ui_prompt_end
			const running = this.env.running();
			if (running) this.awaitingStart = 0;
			if (this.awaitingStart && Date.now() - this.awaitingStart < START_WAIT_MS) return this.retry();
			if (running) {
				// M28: as pi's Enter (steer) or Alt+Enter (follow-up) while it works
				void this.pi.sendUserMessage(next.text, { deliverAs: next.mode === "steer" ? "steer" : "followUp", expandPromptTemplates: true });
				this.userJoined = true;
			} else if (ctx.isIdle()) {
				void this.pi.sendUserMessage(next.text, { expandPromptTemplates: true });
				this.awaitingStart = Date.now();
			} else return this.retry(); // compacting: prompts are refused until it ends
			this.done(next.seq);
		}
	}

	/**
	 * While an agent item waits (dialog, start, compaction), /name, /model and /thinking
	 * right behind it need not: apply them, up to the first user reply, which keeps its turn.
	 * lastSeq stays put, so a resent agent item is still recognised as not yet handed.
	 */
	private applySettingsBehind(ctx: ExtensionContext): void {
		for (let i = 1; i < this.queue.length; ) {
			const it = this.queue[i]!;
			if (isAgentKind(it.kind)) {
				i++;
				continue;
			}
			if (!this.applySetting(ctx, it.text)) return;
			this.queue.splice(i, 1);
			this.env.ack(it.seq);
		}
	}

	private done(seq: number): void {
		this.queue.shift();
		this.lastSeq = Math.max(this.lastSeq, seq);
		this.env.ack(seq);
	}

	/** M9: hand an agent message or report to pi; false when it has to wait. */
	private pumpAgent(ctx: ExtensionContext, next: DeliverItem): boolean {
		// a dialog is the user's: the message waits for it (the sender was told)
		if (this.env.dialogOpen()) return false;
		const running = this.env.running();
		if (running) this.awaitingStart = 0;
		if (this.awaitingStart && Date.now() - this.awaitingStart < START_WAIT_MS) {
			this.retry();
			return false;
		}
		const message = {
			customType: AGENT_MESSAGE_TYPE,
			content: next.text,
			display: true,
			details: { seq: next.seq, job: this.env.jobId ?? null, kind: next.kind, from: next.from ?? null, relation: next.relation ?? null },
		};
		if (running) void this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		else if (ctx.isIdle()) {
			void this.pi.sendMessage(message, { triggerTurn: true });
			this.awaitingStart = Date.now();
			this.agentStarter = next;
		} else {
			this.retry(); // compacting
			return false;
		}
		this.queue.shift();
		this.lastSeq = Math.max(this.lastSeq, next.seq);
		this.handed.add(next.seq);
		this.seen.add(this.seenKey(next.seq));
		return true;
	}

	private seenKey(seq: number): string {
		return `${this.env.jobId ?? ""}:${seq}`;
	}

	/** M9: seqs of agent items this session already holds (after a restart). */
	noteSession(ctx: ExtensionContext): void {
		for (const e of ctx.sessionManager.getBranch()) {
			const m = (e as { type?: string; message?: { role?: string; customType?: string; details?: { seq?: unknown } } }).message;
			const custom = (e.type === "custom_message" ? e : m?.role === "custom" ? m : undefined) as
				| { customType?: string; details?: { seq?: unknown; job?: unknown } }
				| undefined;
			const d = custom?.details;
			// only items of this job: another job of the same session counted its own seqs
			if (custom?.customType === AGENT_MESSAGE_TYPE && typeof d?.seq === "number" && d.job === (this.env.jobId ?? null)) {
				this.seen.add(this.seenKey(d.seq));
			}
		}
	}

	/** M9: pi took an agent item into the session. */
	messageEnded(message: { role?: string; customType?: string; details?: unknown }): void {
		const seq = (message.details as { seq?: unknown } | undefined)?.seq;
		if (message.role !== "custom" || message.customType !== AGENT_MESSAGE_TYPE || typeof seq !== "number") return;
		if (this.handed.delete(seq)) this.env.ack(seq, true);
	}

	/** M9: a run ended: whatever was steered into it is in the session by now. */
	settled(): void {
		for (const seq of this.handed) this.env.ack(seq, true);
		this.handed.clear();
	}

	/** M9: the agent item that started the run now starting (undefined: a task or the user). */
	takeAgentStart(): DeliverItem | undefined {
		const v = this.agentStarter;
		this.agentStarter = undefined;
		this.userJoined = false;
		return v;
	}

	/** M9: a user reply was steered into the current run. */
	takeUserJoined(): boolean {
		const v = this.userJoined;
		this.userJoined = false;
		return v;
	}

	private retry(): void {
		this.timer = setTimeout(() => this.pump(), RETRY_MS);
		this.timer.unref?.();
	}

	/** /name, /model, /thinking run immediately; true when the text was one of them. */
	private applySetting(ctx: ExtensionContext, text: string): boolean {
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		const warn = (m: string) => {
			try {
				ctx.ui.notify(`pi-roost: ${m}`, "warning");
			} catch {
				// a stale ctx (the session switched while setModel ran): nobody to tell
			}
		};
		if (cmd === "/name") {
			if (arg) this.pi.setSessionName(arg);
			else warn("/name needs a name");
			return true;
		}
		if (cmd === "/compact") {
			// M48: /compact from a peek: pi's own compaction, started here, not awaited
			try {
				ctx.compact();
			} catch (err) {
				warn(`cannot compact: ${String(err)}`);
			}
			return true;
		}
		if (cmd === "/thinking") {
			if (THINKING.has(arg)) this.pi.setThinkingLevel(arg as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			else warn(`/thinking needs one of ${[...THINKING].join(", ")}`);
			return true;
		}
		if (cmd === "/model") {
			const slash = arg.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
			if (!model) warn(`unknown model "${arg}" (use provider/id)`);
			// false (or a throw) when this process has no credentials for it; the agent view
			// sees the row keep its old model and says so
			else {
				void this.pi
					.setModel(model)
					.then((ok) => {
						if (ok === false) warn(`cannot switch to ${arg}: no credentials for ${model.provider} in this session`);
					})
					.catch((err: unknown) => warn(`cannot switch model: ${String(err)}`));
			}
			return true;
		}
		return false;
	}
}

/** M8: pi's context window use for the row; null when the model has no known window. */
/** M24: the session's usage as pi's footer counts it; a subscription marks it notional. */
export function usageOf(ctx: ExtensionContext, now = Date.now()): UsageInfo | null {
	try {
		const m = ctx.model;
		// pi's footer: OAuth to a provider that marks its OAuth a subscription (isUsingSubscription)
		const sub = m
			? m.provider === "kimi-coding" || (ctx.modelRegistry.isUsingOAuth(m) && ctx.modelRegistry.getProvider(m.provider)?.auth?.oauth?.isSubscription === true)
			: false;
		return sessionUsage(ctx.sessionManager.getEntries(), now, sub);
	} catch {
		return null; // a stale ctx after a session switch
	}
}

export function contextOf(ctx: ExtensionContext): ContextInfo | null {
	try {
		const u = ctx.getContextUsage();
		if (!u || !(u.contextWindow > 0)) return null;
		const tokens = typeof u.tokens === "number" ? Math.round(u.tokens) : null;
		const percent = typeof u.percent === "number" ? Math.round(u.percent * 10) / 10 : null;
		return { tokens, window: u.contextWindow, percent };
	} catch {
		return null; // a stale ctx after a session switch
	}
}

/** Worker role (PRD C6): report this session's state, take replies, detach keys. */
/**
 * The worker role. Returns the link its tools call the daemon through (M44: the
 * concierge role adds its own tools on it; `agentTools: false` leaves the roost_* ones out).
 */
export function registerWorker(pi: ExtensionAPI, job: JobIdentity, opts: { agentTools?: boolean } = {}): AgentLink {
	const tracker = new WorkerTracker();
	let reporter: Reporter | undefined;
	let firstPromptTimer: NodeJS.Timeout | undefined;
	let customTimer: NodeJS.Timeout | undefined;
	let customPending = false;
	let stopKeys: (() => void) | undefined;
	let current: ExtensionContext | undefined;
	let dialogOpen = 0;
	const replies = new ReplyQueue(pi, {
		ctx: () => current,
		running: () => tracker.isRunning(),
		dialogOpen: () => dialogOpen > 0,
		ack: (seq, exact) => reporter?.ack(seq, exact),
		jobId: job.id,
	});
	// M9: a background child reports the end of a run it was given: its task, a user's
	// reply, or a message from its parent (answering a question it asked). Runs started by
	// anything else (a sibling, a report) do not report, and parent-message runs report
	// at most MAX_MESSAGE_REPORTS times in a row, so two sessions cannot wake each other
	// forever.
	const child = process.env.PI_ROOST_CHILD === "1";
	let starter: DeliverItem | undefined;
	let messageReports = 0;
	// attachSignal: this worker handles the host's SIGUSR2 on attach and detach (AT-5)
	/** M11: when a phone (pi-mobile) last acted on this session: it counts as in use. */
	let remoteAt: number | undefined;
	// M16: pull requests this session works on (Claude Code's #N label)
	let prs: PrLinks | undefined;
	const send = (urgent = false) =>
		reporter?.update(
			{
				...tracker.report(),
				attachSignal: true,
				attachRepaint: attachRepaintReady(),
				agentItems: true,
				...(remoteAt !== undefined ? { remoteAt } : {}),
				...(prs && prs.links().length > 0 ? { prLinks: prs.links() } : {}),
			},
			urgent,
		);
	prs = registerPrLinks(pi, () => send(true));
	onMobileActivity(pi, () => {
		remoteAt = Date.now();
		send(true);
	});

	pi.on("session_start", (event, ctx: ExtensionContext) => {
		current = ctx;
		dialogOpen = 0;
		stopKeys?.();
		stopKeys = ctx.hasUI ? registerDetachKeys(ctx, job, () => dialogOpen > 0) : undefined;
		// M31: pi says what it can do, as any agent does
		reporter = new Reporter(job, (item) => replies.add(item), undefined, {
			protocol: PROTOCOL_VERSION,
			agent: { name: "pi", version: VERSION },
			capabilities: ["report", "replies", "steer", "usage", "context", "model-switch", "transcript", "peers", "agent-items"],
		});
		replies.noteSession(ctx);
		tracker.start({
			name: ctx.sessionManager.getSessionName() ?? null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			thinking: thinkingOf(pi),
			context: contextOf(ctx),
			// a reload keeps the run going; any other start is a different conversation
			fresh: event.reason !== "reload",
		});
		// respawned without a prompt (reaped, restarted, replied to): no turn will start
		if (event.reason === "startup" && process.env.PI_ROOST_RESTORE === "1") tracker.restore(lastAssistant(ctx));
		tracker.setUsage(usageOf(ctx)); // M24: what it spent before this start
		send();
		clearTimeout(firstPromptTimer);
		firstPromptTimer = setTimeout(() => {
			tracker.firstPromptTimeout(ctx.sessionManager.getBranch().filter((e) => e.type === "message").length);
			send();
		}, FIRST_PROMPT_MS);
		firstPromptTimer.unref?.();
	});

	pi.on("agent_start", () => {
		starter = replies.takeAgentStart();
		tracker.agentStart();
		send();
		replies.pump();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.parentToolCallId) return;
		tracker.toolStart(event.toolName);
		// the tool call's message is saved by now, whatever other extensions' message_end did
		tracker.setContext(contextOf(ctx));
		send();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		tracker.toolEnd();
		send();
	});
	pi.on("message_end", (event, ctx) => {
		replies.messageEnded(event.message as never);
		if (event.message.role !== "assistant") return;
		tracker.assistantMessage(event.message);
		send();
		// pi saves the message after its message_end handlers: read the context use once it
		// is in the session, or the share is one model request behind
		setImmediate(() => {
			const a = tracker.setContext(contextOf(ctx));
			const b = tracker.setUsage(usageOf(ctx)); // M24
			if (a || b) send();
		});
	});
	pi.on("agent_settled", (event, ctx) => {
		tracker.agentSettled(event.aborted);
		tracker.setContext(contextOf(ctx));
		send();
		replies.settled();
		const userJoined = replies.takeUserJoined();
		let worthy = !starter || userJoined;
		if (!worthy && starter?.kind === "message" && starter.relation === "parent" && messageReports < MAX_MESSAGE_REPORTS) {
			worthy = true;
			messageReports++;
		}
		if (!starter || userJoined) messageReports = 0;
		if (child && !event.aborted && worthy && current) void handBack(current);
		starter = undefined;
		replies.pump();
	});

	const handBack = async (ctx: ExtensionContext) => {
		const r = tracker.report();
		// a dialog is for a human; the parent cannot answer it
		if (r.waitingFor === "dialog" || (r.state !== "done" && r.state !== "blocked" && r.state !== "failed")) return;
		const last = lastAssistant(ctx);
		const result = last ? messageText(last as never).trim().slice(0, RESULT_MAX) : "";
		await reporter
			?.call("handback", { state: r.state, result: result || null, question: r.question, error: r.error })
			.catch(() => {});
	};
	pi.on("ui_prompt_start", (event) => {
		dialogOpen++;
		clearTimeout(customTimer);
		if (event.kind !== "custom") {
			tracker.dialogStart(event.kind, event.title);
			send();
			return;
		}
		// custom() is also used for non-blocking widgets: count it only once it lingers (R6)
		customPending = true;
		customTimer = setTimeout(() => {
			customPending = false;
			tracker.dialogStart(event.kind, event.title);
			send();
		}, CUSTOM_DIALOG_MS);
		customTimer.unref?.();
	});
	pi.on("ui_prompt_end", () => {
		dialogOpen = Math.max(0, dialogOpen - 1);
		clearTimeout(customTimer);
		if (customPending) customPending = false; // a short custom() was never counted
		else {
			tracker.dialogEnd();
			send();
		}
		if (dialogOpen === 0) replies.pump();
	});
	pi.on("session_info_changed", (event) => {
		tracker.rename(event.name);
		send();
	});
	pi.on("model_select", (event, ctx) => {
		tracker.setModel(`${event.model.provider}/${event.model.id}`);
		// a model with another window changes the share in use; pi may clamp the thinking level
		tracker.setContext(contextOf(ctx));
		tracker.setThinking(thinkingOf(pi));
		send();
	});
	pi.on("thinking_level_select", (event) => {
		tracker.setThinking(event.level);
		send();
	});
	// a compaction shrinks the context: the row should not keep the old share
	pi.on("session_compact", (_event, ctx) => {
		if (tracker.setContext(contextOf(ctx))) send();
	});
	// /tree moves to another branch, with another context
	pi.on("session_tree", (_event, ctx) => {
		if (tracker.setContext(contextOf(ctx))) send();
	});
	// After the tracker's handlers: pi runs handlers in registration order, and these
	// read the tracker's view of the same event (run ids, settled state).
	registerSummaries(pi, { tracker, send: () => send(true), ctx: () => current });
	registerRecap(pi, { tracker, send: () => send(), ctx: () => current });
	registerAttachRepaint(pi);
	// M53: the conversation from before the latest compaction, loaded as the transcript scrolls up
	registerEarlierHistory(pi);
	// M10: a session in its own worktree is told so, every run (it is not in the session file)
	const worktree = readJob(job.id)?.worktree;
	if (worktree) {
		const note = worktreeNote(worktree);
		pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${note}` }));
	}
	const link: AgentLink = { call: (op, args) => (reporter ? reporter.call(op, args) : Promise.reject(new Error("not connected"))) };
	if (opts.agentTools !== false) registerAgentTools(pi, link);

	pi.on("session_shutdown", async () => {
		current = undefined;
		stopKeys?.();
		stopKeys = undefined;
		clearTimeout(firstPromptTimer);
		clearTimeout(customTimer);
		const closing = reporter;
		reporter = undefined;
		await closing?.close();
	});
	return link;
}

function thinkingOf(pi: ExtensionAPI): string | null {
	try {
		return pi.getThinkingLevel() ?? null;
	} catch {
		return null;
	}
}


const MAX_MESSAGE_REPORTS = 3;

function lastAssistant(ctx: ExtensionContext): { content?: unknown; stopReason?: string; errorMessage?: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i]!;
		if (e.type === "message" && e.message.role === "assistant") return e.message as never;
	}
	return undefined;
}
