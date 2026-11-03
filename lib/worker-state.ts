// The worker role's view of its own session (PRD §6.8), as a reducer over
// pi events. Pure apart from the injected clock, so it is unit-tested directly.
import { clip, extractChoices, lastLine, looksLikeQuestion, messageText, questionLine } from "./heuristics.ts";
import type { JobStatus, WaitingFor, WorkerReport } from "./protocol.ts";

/** Time without a turn starting before an empty session counts as waiting for its first prompt. */
export const FIRST_PROMPT_MS = 5000;
/** A custom() component only counts as a blocking dialog after this long (PRD R6). */
export const CUSTOM_DIALOG_MS = 2000;
/** Row text alone is re-sent at most this often while working (SM-1). */
export const SUMMARY_INTERVAL_MS = 15_000;

type Settled = "done" | "blocked" | "failed";

export class WorkerTracker {
	private running = false;
	private settled: Settled | undefined;
	// Open prompts, outermost first; nested or overlapping ones stack (pi coalesces most).
	private dialogs: { kind: string; title: string | null }[] = [];
	private tool: string | null = null;
	private text = "";
	private error: string | null = null;
	private question: string | null = null;
	private choices: string[] = [];
	private sawTurn = false;
	private name: string | null = null;
	private model: string | null = null;

	/** A session (re)starts in this worker: /new, /resume and /fork begin from scratch. */
	start(info: { name?: string | null; model?: string | null; fresh: boolean }): void {
		this.name = info.name ?? null;
		this.model = info.model ?? null;
		if (!info.fresh) return;
		this.running = false;
		this.settled = undefined;
		this.dialogs = [];
		this.sawTurn = false;
		this.resetRun();
	}

	agentStart(): void {
		this.running = true;
		this.sawTurn = true;
		this.settled = undefined;
		this.resetRun();
	}

	private resetRun(): void {
		this.tool = null;
		this.text = "";
		this.error = null;
		this.question = null;
		this.choices = [];
	}

	toolStart(name: string): void {
		this.tool = name;
	}

	toolEnd(): void {
		this.tool = null;
	}

	assistantMessage(message: { content?: unknown; stopReason?: string; errorMessage?: string }): void {
		// Only the run's latest message counts: an earlier question or a retried error does not.
		this.text = messageText(message);
		this.error = message.stopReason === "error" ? (message.errorMessage ?? "the model request failed") : null;
	}

	/** The run is over and pi will not continue on its own. */
	agentSettled(aborted: boolean): void {
		this.running = false;
		this.tool = null;
		if (this.error && !aborted) this.settled = "failed";
		else if (!aborted && looksLikeQuestion(this.text)) {
			this.settled = "blocked";
			this.question = questionLine(this.text);
			this.choices = extractChoices(this.text);
		} else this.settled = "done";
	}

	dialogStart(kind: string, title: string | undefined): void {
		this.dialogs.push({ kind, title: title ?? null });
	}

	dialogEnd(): void {
		this.dialogs.pop();
		if (this.dialogs.length > 0) return;
		// A dialog from a command (no model run) still ends a piece of work.
		if (!this.running && this.settled === undefined) {
			this.sawTurn = true;
			this.settled = "done";
		}
	}

	rename(name: string | undefined): void {
		this.name = name ?? null;
	}

	setModel(model: string): void {
		this.model = model;
	}

	/** No turn started yet; called once FIRST_PROMPT_MS after session start. */
	firstPromptTimeout(messageCount: number): void {
		if (this.sawTurn || this.running || this.dialogs.length > 0) return;
		this.settled = messageCount === 0 ? "blocked" : "done";
		this.sawTurn = messageCount > 0;
	}

	waitingForFirstPrompt(): boolean {
		return !this.sawTurn && this.settled === "blocked";
	}

	report(): WorkerReport {
		let state: WorkerReport["state"];
		let status: JobStatus;
		let waitingFor: WaitingFor = null;
		const dialog = this.dialogs[0];
		if (dialog) {
			state = "blocked";
			status = "waiting";
			waitingFor = "dialog";
		} else if (this.running) {
			state = "working";
			status = "busy";
		} else if (this.settled === "blocked") {
			state = "blocked";
			status = "waiting";
			waitingFor = this.waitingForFirstPrompt() ? "first-prompt" : "question";
		} else if (this.settled) {
			state = this.settled;
			status = "idle";
		} else {
			state = "working";
			status = "idle";
		}
		return {
			state,
			status,
			waitingFor,
			summary: this.summary(waitingFor, dialog),
			question: waitingFor === "dialog" ? dialog!.title : waitingFor === "question" ? this.question : null,
			choices: waitingFor === "question" ? this.choices : [],
			tool: this.running ? this.tool : null,
			error: this.settled === "failed" ? this.error : null,
			name: this.name,
			model: this.model,
		};
	}

	private summary(waitingFor: WaitingFor, dialog: { kind: string; title: string | null } | undefined): string | null {
		if (waitingFor === "dialog") return dialog?.title ? clip(dialog.title) : `waiting in a ${dialog?.kind} dialog`;
		if (waitingFor === "first-prompt") return "waiting for a first prompt";
		if (this.settled === "failed" && this.error) return clip(this.error);
		if (this.running && this.tool) return `running ${this.tool}`;
		if (this.settled === "blocked" && this.question) return clip(this.question);
		const line = lastLine(this.text);
		return line ? clip(line) : null;
	}
}

/** Whether two reports differ in more than row text (those are sent at once). */
export function stateChanged(a: WorkerReport | undefined, b: WorkerReport): boolean {
	if (!a) return true;
	return (
		a.state !== b.state ||
		a.status !== b.status ||
		a.waitingFor !== b.waitingFor ||
		a.question !== b.question ||
		a.name !== b.name ||
		a.model !== b.model ||
		a.error !== b.error ||
		a.tool !== b.tool ||
		a.choices.join("\n") !== b.choices.join("\n")
	);
}
