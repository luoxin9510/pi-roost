// DI-7 filters typed into the agent view's input: s:<state|group>, n:<name text>,
// o:<result text> (bare o: = rows with a result), combinable with spaces; or alone
// `#1234` / a pull request URL (M16).
import { prQuery, readyForReview, rowHasPr } from "./pr.ts";
import type { JobRow } from "./protocol.ts";

export interface Filter {
	/** M16: `#1234` or a pull request URL: the session working on it. */
	pr?: { number: number; url?: string };
	states: string[];
	names: string[];
	outputs: string[];
	/** bare o: */
	hasOutput: boolean;
}

const TOKEN = /^(s|n|o):(.*)$/i;

/** The filter in the input, or undefined when the text is a task to dispatch. */
export function parseFilter(text: string): Filter | undefined {
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const pr = tokens.length === 1 ? prQuery(tokens[0]!) : undefined;
	if (pr) return { pr, states: [], names: [], outputs: [], hasOutput: false };
	const f: Filter = { states: [], names: [], outputs: [], hasOutput: false };
	for (const tok of tokens) {
		const m = TOKEN.exec(tok);
		if (!m) return undefined;
		const value = m[2]!.toLowerCase();
		const kind = m[1]!.toLowerCase();
		if (kind === "s") {
			if (value) f.states.push(value);
		} else if (kind === "n") {
			if (value) f.names.push(value);
		} else if (value) f.outputs.push(value);
		else f.hasOutput = true;
	}
	return f;
}

const STATE_WORDS: Record<string, (r: JobRow) => boolean> = {
	working: (r) => r.state === "working",
	blocked: (r) => r.state === "blocked",
	needs: (r) => r.state === "blocked",
	"needs-input": (r) => r.state === "blocked",
	input: (r) => r.state === "blocked",
	done: (r) => r.state === "done",
	failed: (r) => r.state === "failed",
	stopped: (r) => r.state === "stopped",
	completed: (r) => r.state === "done" || r.state === "failed" || r.state === "stopped",
	ready: (r) => r.state !== "blocked" && r.state !== "working" && readyForReview(r.prs),
	pinned: (r) => r.pinned,
	running: (r) => r.pid !== null,
	reaped: (r) => r.reaped,
};

function stateMatches(row: JobRow, word: string): boolean {
	const exact = STATE_WORDS[word];
	if (exact) return exact(row);
	// prefixes: s:w, s:comp, s:fail
	return Object.entries(STATE_WORDS).some(([k, fn]) => k.startsWith(word) && fn(row));
}

const resultOf = (r: JobRow) => [r.summary, r.question, r.error].filter(Boolean).join("\n").toLowerCase();

/** Every token kind must match; several values of one kind match any of them. */
export function matches(row: JobRow, f: Filter): boolean {
	if (f.pr && !rowHasPr(row.prs, f.pr)) return false;
	if (f.states.length > 0 && !f.states.some((s) => stateMatches(row, s))) return false;
	const name = row.name.toLowerCase();
	if (f.names.length > 0 && !f.names.some((n) => name.includes(n))) return false;
	const result = resultOf(row);
	if (f.hasOutput && !result) return false;
	if (f.outputs.length > 0 && !f.outputs.some((o) => result.includes(o))) return false;
	return true;
}
