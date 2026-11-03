// Deterministic row text and question detection (PRD SM-1, SM-3), used when no
// summary model is configured and between model summaries.

// Asking without a question mark. Only the final sentence is tested, and only
// phrases that are requests rather than sign-offs ("let me know if…" is not).
const QUESTION_PHRASES = [
	/^(?:would you like|do you want|should i|shall i)\b/i,
	/\bplease (?:confirm|choose|pick|select|clarify)\b/i,
	/\b(?:which (?:one|option|approach) (?:do|would|should) you)\b/i,
	/^(?:是否|要不要|需要我)/,
	/请(?:确认|选择|告诉我)/,
	/你(?:希望|想要)(?:我|哪)/,
	/吗[。.]?$/,
];

const finalSentence = (line: string) => {
	const parts = line.split(/(?<=[.!。！])\s*/).filter((p) => p.trim());
	return (parts[parts.length - 1] ?? line).trim();
};

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
	// One closing line after the list: the question itself, or a sign-off.
	if (end > 1 && !CHOICE.test(all[end - 1]!) && CHOICE.test(all[end - 2]!)) {
		const closing = all[--end]!;
		if (ASKS.test(closing)) after = closing;
	}
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
	const sentence = finalSentence(last);
	return QUESTION_PHRASES.some((re) => re.test(sentence));
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
