import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import { DaemonClient } from "../lib/client.ts";
import { hostControl } from "../lib/hostclient.ts";
import type { WorkerReport } from "../lib/protocol.ts";
import {
	CUSTOM_DIALOG_MS,
	FIRST_PROMPT_MS,
	SUMMARY_INTERVAL_MS,
	stateChanged,
	WorkerTracker,
} from "../lib/worker-state.ts";

export interface JobIdentity {
	id: string;
	token: string;
	socket: string;
}

/** Set in a worker's environment by the PTY host. */
export function jobIdentity(env: NodeJS.ProcessEnv = process.env): JobIdentity | undefined {
	const { PI_JOB_ID: id, PI_JOB_TOKEN: token, PI_DAEMON_SOCK: socket } = env;
	return id && token && socket ? { id, token, socket } : undefined;
}

const REQUEST_TIMEOUT_MS = 4000;
const FINAL_FLUSH_MS = 500;

/**
 * Sends the latest report, one request at a time, reconnecting after daemon
 * restarts; never throws. State changes go out at once, row text at most
 * every SUMMARY_INTERVAL_MS.
 */
export class Reporter {
	private client: DaemonClient | undefined;
	private latest: WorkerReport | undefined;
	private sent: WorkerReport | undefined;
	private sentAt = 0;
	private timer: NodeJS.Timeout | undefined;
	private dueAt = Number.POSITIVE_INFINITY;
	private inflight: Promise<void> | undefined;
	private retryMs = 500;
	private closed = false;
	private job: JobIdentity;
	private onDeliver: (text: string) => void;

	constructor(job: JobIdentity, onDeliver: (text: string) => void = () => {}) {
		this.job = job;
		this.onDeliver = onDeliver;
	}

	update(report: WorkerReport): void {
		this.latest = report;
		this.schedule();
	}

	/** Send what is pending (bounded wait), then disconnect. */
	async close(): Promise<void> {
		if (this.closed) return;
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.latest && this.latest !== this.sent) {
			await Promise.race([this.drain(), new Promise((r) => setTimeout(r, FINAL_FLUSH_MS))]);
		}
		this.closed = true;
		clearTimeout(this.timer);
		this.client?.close();
		this.client = undefined;
	}

	private async drain(): Promise<void> {
		while (!this.closed && this.latest && this.latest !== this.sent) {
			await (this.inflight ?? this.send());
			if (this.latest !== this.sent) await new Promise((r) => setTimeout(r, 50));
		}
	}

	private schedule(): void {
		if (this.closed || this.inflight || !this.latest || this.latest === this.sent) return;
		const urgent = stateChanged(this.sent, this.latest);
		if (!urgent && this.latest.summary === this.sent?.summary) return;
		const due = urgent ? Date.now() : Math.max(Date.now(), this.sentAt + SUMMARY_INTERVAL_MS);
		if (this.timer && due >= this.dueAt) return;
		clearTimeout(this.timer);
		this.dueAt = due;
		this.timer = setTimeout(() => void this.send(), due - Date.now());
		this.timer.unref?.();
	}

	private send(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.dueAt = Number.POSITIVE_INFINITY;
		const report = this.latest;
		if (!report || this.closed) return Promise.resolve();
		this.inflight = this.request(report).finally(() => {
			this.inflight = undefined;
		});
		return this.inflight.then(() => this.schedule());
	}

	private async request(report: WorkerReport): Promise<void> {
		try {
			if (!this.client) {
				const fresh = await DaemonClient.connect(this.job.socket);
				// Replies come back on the connection this worker reports on.
				fresh.onEvent((e) => {
					if (e.event === "deliver" && e.id === this.job.id) this.onDeliver(e.text);
				});
				this.client = fresh;
			}
			const client = this.client;
			await Promise.race([
				client.request("report", { id: this.job.id, token: this.job.token, report }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("report timed out")), REQUEST_TIMEOUT_MS).unref?.()),
			]);
			this.sent = report;
			this.sentAt = Date.now();
			this.retryMs = 500;
		} catch {
			this.client?.close();
			this.client = undefined;
			if (this.closed) return;
			// The daemon may be restarting: try again with the newest report later.
			clearTimeout(this.timer);
			this.dueAt = Date.now() + this.retryMs;
			this.timer = setTimeout(() => void this.send(), this.retryMs);
			this.timer.unref?.();
			this.retryMs = Math.min(this.retryMs * 2, 5000);
		}
	}
}

const DOUBLE_PRESS_MS = 1000;

/** The host socket of this worker's own job; it sits next to the daemon socket. */
const hostSocketOf = (job: JobIdentity) => join(dirname(job.socket), `host-${job.id}.sock`);

/**
 * AT-3: keys that would leave or kill a worker detach the attached terminal
 * instead (← on an empty prompt, /exit, a double Ctrl+C or Ctrl+D).
 */
function registerDetachKeys(ctx: ExtensionContext, job: JobIdentity): () => void {
	let lastCtrlC = 0;
	let lastCtrlD = 0;
	const detach = () => void hostControl(hostSocketOf(job), "detach").catch(() => {});
	return ctx.ui.onTerminalInput((data) => {
		if (isKeyRelease(data)) return undefined;
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
		if (matchesKey(data, Key.ctrl("c")) && empty) {
			const now = Date.now();
			const second = now - lastCtrlC < DOUBLE_PRESS_MS;
			lastCtrlC = now;
			if (second) {
				detach();
				return { consume: true };
			}
		}
		return undefined;
	});
}

/** Worker role (PRD C6): report this session's state, take replies, detach keys. */
export function registerWorker(pi: ExtensionAPI, job: JobIdentity): void {
	const tracker = new WorkerTracker();
	let reporter: Reporter | undefined;
	let firstPromptTimer: NodeJS.Timeout | undefined;
	let customTimer: NodeJS.Timeout | undefined;
	let customPending = false;
	let stopKeys: (() => void) | undefined;
	let current: ExtensionContext | undefined;
	let dialogOpen = 0;
	const queued: string[] = [];
	const send = () => reporter?.update(tracker.report());

	// PK-2: settings commands run at once, other text joins the conversation.
	const deliver = (text: string) => {
		const ctx = current;
		if (!ctx) return;
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		if (cmd === "/name" && arg) return pi.setSessionName(arg);
		if (cmd === "/thinking" && arg) return pi.setThinkingLevel(arg as Parameters<typeof pi.setThinkingLevel>[0]);
		if (cmd === "/model" && arg) {
			const slash = arg.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(arg.slice(0, slash), arg.slice(slash + 1)) : undefined;
			if (model) void pi.setModel(model);
			else ctx.ui.notify(`pi-roost: unknown model ${arg}`, "warning");
			return;
		}
		// PK-4: an open dialog must be answered first; the reply waits for it.
		if (dialogOpen > 0) {
			queued.push(text);
			return;
		}
		void pi.sendUserMessage(text, ctx.isIdle() ? { expandPromptTemplates: true } : { deliverAs: "followUp", expandPromptTemplates: true });
	};

	pi.on("session_start", (event, ctx: ExtensionContext) => {
		current = ctx;
		stopKeys?.();
		stopKeys = ctx.hasUI ? registerDetachKeys(ctx, job) : undefined;
		reporter = new Reporter(job, deliver);
		tracker.start({
			name: ctx.sessionManager.getSessionName() ?? null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			// a reload keeps the run going; any other start is a different conversation
			fresh: event.reason !== "reload",
		});
		send();
		clearTimeout(firstPromptTimer);
		firstPromptTimer = setTimeout(() => {
			tracker.firstPromptTimeout(ctx.sessionManager.getBranch().filter((e) => e.type === "message").length);
			send();
		}, FIRST_PROMPT_MS);
		firstPromptTimer.unref?.();
	});

	pi.on("agent_start", () => {
		tracker.agentStart();
		send();
	});
	pi.on("tool_execution_start", (event) => {
		if (event.parentToolCallId) return;
		tracker.toolStart(event.toolName);
		send();
	});
	pi.on("tool_execution_end", (event) => {
		if (event.parentToolCallId) return;
		tracker.toolEnd();
		send();
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		tracker.assistantMessage(event.message);
		send();
	});
	pi.on("agent_settled", (event) => {
		tracker.agentSettled(event.aborted);
		send();
	});
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
		if (dialogOpen === 0) for (const text of queued.splice(0)) deliver(text);
	});
	pi.on("session_info_changed", (event) => {
		tracker.rename(event.name);
		send();
	});
	pi.on("model_select", (event) => {
		tracker.setModel(`${event.model.provider}/${event.model.id}`);
		send();
	});
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
}
