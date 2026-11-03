import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../lib/client.ts";
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

/** Sends the latest report, reconnecting after daemon restarts; never throws. */
class Reporter {
	private client: DaemonClient | undefined;
	private connecting: Promise<void> | undefined;
	private latest: WorkerReport | undefined;
	private sent: WorkerReport | undefined;
	private sentAt = 0;
	private timer: NodeJS.Timeout | undefined;
	private retryMs = 500;
	private closed = false;
	private job: JobIdentity;

	constructor(job: JobIdentity) {
		this.job = job;
	}

	update(report: WorkerReport): void {
		this.latest = report;
		const urgent = stateChanged(this.sent, report);
		if (!urgent && report.summary === this.sent?.summary) return;
		const wait = urgent ? 0 : Math.max(0, this.sentAt + SUMMARY_INTERVAL_MS - Date.now());
		if (this.timer && !urgent) return; // a send is already scheduled
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.flush(), wait);
		this.timer.unref?.();
	}

	close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		this.client?.close();
		this.client = undefined;
	}

	private async flush(): Promise<void> {
		this.timer = undefined;
		const report = this.latest;
		if (!report || this.closed) return;
		try {
			await this.connect();
			await this.client!.request("report", { id: this.job.id, token: this.job.token, report });
			this.sent = report;
			this.sentAt = Date.now();
			this.retryMs = 500;
			if (this.latest !== report) this.update(this.latest!);
		} catch {
			this.client?.close();
			this.client = undefined;
			if (this.closed) return;
			// The daemon may be restarting; resend the newest report later.
			this.timer = setTimeout(() => void this.flush(), this.retryMs);
			this.timer.unref?.();
			this.retryMs = Math.min(this.retryMs * 2, 5000);
		}
	}

	private connect(): Promise<void> {
		if (this.client) return Promise.resolve();
		this.connecting ??= DaemonClient.connect(this.job.socket)
			.then((c) => {
				this.client = c;
			})
			.finally(() => {
				this.connecting = undefined;
			});
		return this.connecting;
	}
}

/** Worker role (PRD C6): report this session's state to the daemon. */
export function registerWorker(pi: ExtensionAPI, job: JobIdentity): void {
	const tracker = new WorkerTracker();
	let reporter: Reporter | undefined;
	let firstPromptTimer: NodeJS.Timeout | undefined;
	let customTimer: NodeJS.Timeout | undefined;
	const send = () => reporter?.update(tracker.report());

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		reporter?.close();
		reporter = new Reporter(job);
		tracker.start({
			name: ctx.sessionManager.getSessionName() ?? null,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
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
		clearTimeout(customTimer);
		if (event.kind !== "custom") {
			tracker.dialogStart(event.kind, event.title);
			send();
			return;
		}
		// custom() is also used for non-blocking widgets: count it only once it lingers (R6)
		customTimer = setTimeout(() => {
			tracker.dialogStart(event.kind, event.title);
			send();
		}, CUSTOM_DIALOG_MS);
		customTimer.unref?.();
	});
	pi.on("ui_prompt_end", () => {
		clearTimeout(customTimer);
		tracker.dialogEnd();
		send();
	});
	pi.on("session_info_changed", (event) => {
		tracker.rename(event.name);
		send();
	});
	pi.on("model_select", (event) => {
		tracker.setModel(`${event.model.provider}/${event.model.id}`);
		send();
	});
	pi.on("session_shutdown", () => {
		clearTimeout(firstPromptTimer);
		clearTimeout(customTimer);
		reporter?.close();
		reporter = undefined;
	});
}
