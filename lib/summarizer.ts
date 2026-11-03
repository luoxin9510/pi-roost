import { clip } from "./heuristics.ts";

/** What the summary model says about a finished turn (SM-2). */
export interface TurnSummary {
	summary: string;
	kind: "done" | "question";
	reply: string | null;
}

export const SUMMARY_MAX = 80;
const TAIL_CHARS = 6000;

export const TURN_SYSTEM = `You summarise one turn of a coding agent's session for a dashboard row.
Reply with JSON only: {"summary": string, "kind": "done" | "question", "reply": string | null}
- summary: at most ${SUMMARY_MAX} characters, plain text, what was done or what is being asked; no "The agent".
- kind: "question" only when the agent ends by asking the user something it needs to continue.
- reply: for a question, a short likely answer the user might send; otherwise null.`;

export const PROGRESS_SYSTEM = `You summarise what a coding agent is doing right now for a dashboard row.
Reply with JSON only: {"summary": string}. At most ${SUMMARY_MAX} characters, present tense, plain text.`;

export const NAME_SYSTEM = `Name a coding task for a list of background sessions.
Reply with JSON only: {"name": string}. Two to five words, no quotes or trailing punctuation, in the language of the task.`;

export const RECAP_SYSTEM = `Tell a developer returning to a coding agent's session what happened while they were away.
Reply with JSON only: {"recap": string}. One or two short sentences, plain text.`;

/** The last part of a transcript, oldest first, as plain text for the model. */
export function transcriptTail(lines: string[], max = TAIL_CHARS): string {
	const out: string[] = [];
	let size = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (size + line.length > max) {
			if (out.length === 0) out.push(line.slice(-max));
			break;
		}
		out.push(line);
		size += line.length + 1;
	}
	return out.reverse().join("\n");
}

/** The first JSON object in a model's reply (models wrap JSON in prose or fences). */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		const v = JSON.parse(text.slice(start, end + 1));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseTurnSummary(text: string): TurnSummary | undefined {
	const o = parseJsonObject(text);
	if (!o || typeof o.summary !== "string" || !oneLine(o.summary)) return undefined;
	const kind = o.kind === "question" ? "question" : "done";
	const reply = typeof o.reply === "string" && oneLine(o.reply) ? clip(oneLine(o.reply), 200) : null;
	return { summary: clip(oneLine(o.summary), SUMMARY_MAX), kind, reply: kind === "question" ? reply : null };
}

export function parseField(text: string, field: string, max: number): string | undefined {
	const o = parseJsonObject(text);
	const v = o?.[field];
	if (typeof v !== "string") return undefined;
	const s = oneLine(v).replace(/^["'“”]+|["'“”.。]+$/g, "");
	return s ? clip(s, max) : undefined;
}

/** "provider/model-id" → its parts; the id may itself contain slashes. */
export function splitModelRef(ref: string | undefined): { provider: string; id: string } | undefined {
	if (!ref) return undefined;
	const at = ref.indexOf("/");
	if (at <= 0 || at === ref.length - 1) return undefined;
	return { provider: ref.slice(0, at), id: ref.slice(at + 1) };
}

/** AT-5 without a model: what happened since the user last looked. */
export interface AwayLog {
	turns: number;
	tools: Record<string, number>;
	questions: string[];
	failures: number;
}

export const emptyAway = (): AwayLog => ({ turns: 0, tools: {}, questions: [], failures: 0 });

export const awayIsEmpty = (a: AwayLog) => a.turns === 0 && Object.keys(a.tools).length === 0 && a.questions.length === 0;

export function recapList(a: AwayLog): string {
	const parts: string[] = [];
	if (a.turns > 0) parts.push(`${a.turns} turn${a.turns === 1 ? "" : "s"} finished${a.failures ? ` (${a.failures} failed)` : ""}`);
	const tools = Object.entries(a.tools)
		.sort((x, y) => y[1] - x[1])
		.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
	if (tools.length > 0) parts.push(`tools: ${tools.slice(0, 6).join(", ")}${tools.length > 6 ? ", …" : ""}`);
	if (a.questions.length > 0) parts.push(`asked: ${clip(a.questions[a.questions.length - 1]!, 120)}`);
	return parts.join(" · ");
}
