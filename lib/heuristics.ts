// Deterministic row text and question detection (PRD SM-1, SM-3), used when no
// summary model is configured and between model summaries.

const QUESTION_PHRASES = [
	/\bwould you like\b/i,
	/\bdo you want\b/i,
	/\bshould i\b/i,
	/\bshall i\b/i,
	/\blet me know\b/i,
	/\bwhich (?:one|option|approach|of these)\b/i,
	/\bplease (?:confirm|choose|pick|select|clarify)\b/i,
	/\bcan you (?:confirm|clarify)\b/i,
	/\bwhat would you prefer\b/i,
	/是否/,
	/要不要/,
	/请(?:确认|选择|告诉我)/,
	/你(?:希望|想要|觉得)/,
	/需要我/,
	/吗[？?]?$/,
];

/** Non-empty lines of a text, trimmed. */
function lines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Last non-empty line, without markdown emphasis, for the row text. */
export function lastLine(text: string): string | null {
	const all = lines(text).filter((l) => !/^```/.test(l));
	const last = all[all.length - 1];
	return last ? last.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "") : null;
}

const CHOICE = /^(\d{1,2})[.)、]\s+(.+)$/;
const ASKS = /[?？]\s*["'”’)）]*$/;

/**
 * Split a trailing numbered list off the text: "Which one?\n1. a\n2. b" and
 * "1. a\n2. b\nWhich one?" both give the question line and the choices.
 */
function trailingChoices(all: string[]): { choices: string[]; question: string | undefined } {
	let end = all.length;
	let after: string | undefined;
	if (end > 0 && ASKS.test(all[end - 1]!) && !CHOICE.test(all[end - 1]!)) after = all[--end];
	const choices: string[] = [];
	let i = end - 1;
	for (; i >= 0; i--) {
		const m = CHOICE.exec(all[i]!);
		if (!m) break;
		choices.unshift(m[2]!);
	}
	if (choices.length < 2) return { choices: [], question: undefined };
	return { choices, question: after ?? all[i] };
}

/** Whether a finished turn's final text asks the user something. */
export function looksLikeQuestion(text: string): boolean {
	const all = lines(text);
	if (all.length === 0) return false;
	const listed = trailingChoices(all);
	const last = listed.choices.length > 0 ? listed.question : all[all.length - 1];
	if (last === undefined) return false;
	if (ASKS.test(last)) return true;
	// Phrases only count near the end, so a question quoted mid-answer does not.
	const tail = listed.choices.length > 0 ? last : all.slice(-2).join(" ");
	return QUESTION_PHRASES.some((re) => re.test(tail));
}

/** The line that asks, for the peek panel: the one before a trailing list, else the last. */
export function questionLine(text: string): string | null {
	const all = lines(text);
	const listed = trailingChoices(all);
	const line = listed.choices.length > 0 ? listed.question : all[all.length - 1];
	return line ? line.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "") : null;
}

/** Numbered choices ("1. foo", "2) bar") ending a question (PK-3). */
export function extractChoices(text: string): string[] {
	return trailingChoices(lines(text)).choices;
}

/** Text content of an assistant message. */
export function messageText(message: { content?: unknown }): string {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content
		.filter((c): c is { type: "text"; text: string } => !!c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function clip(text: string, max = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
