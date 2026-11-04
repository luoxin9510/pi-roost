// M19 (Claude Code: "Open a row to see that subagent's siblings and direct children with
// a path back to main"; "type into its transcript to resume it yourself"). A child's
// conversation, read from its pi session file, as lines for the transcript view.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { JobRow } from "./protocol.ts";

export type TranscriptItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string }
	| { kind: "tool"; name: string; args: string; result?: string; error?: boolean }
	| { kind: "note"; text: string };

/** The tail of a session file read at most (a long session shows its latest part). */
export const READ_MAX = 4 * 1024 * 1024;

// escapes and control characters from a model or a tool never reach the terminal
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export function clean(s: string): string {
	return s.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, "");
}

type Entry = { type?: string; id?: string; parentId?: string | null; message?: Record<string, unknown>; content?: unknown; customType?: string; display?: boolean; summary?: string };

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
};

function brief(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	// the argument a person would look for first
	for (const k of ["command", "path", "file_path", "pattern", "query", "url", "task", "text"]) {
		if (typeof a[k] === "string") return a[k] as string;
	}
	try {
		return JSON.stringify(a);
	} catch {
		return "";
	}
}

/** The current branch of a session file's entries (the last entry and its parents). */
export function branchOf(text: string, truncated = false): Entry[] {
	const entries: Entry[] = [];
	const lines = text.split("\n");
	if (truncated) lines.shift(); // the first line is cut
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as Entry;
			if (e && typeof e === "object") entries.push(e);
		} catch {
			// a line being written, or junk
		}
	}
	const byId = new Map<string, Entry>();
	for (const e of entries) if (typeof e.id === "string") byId.set(e.id, e);
	const leaf = [...entries].reverse().find((e) => typeof e.id === "string" && e.type !== "session");
	if (!leaf) return [];
	const out: Entry[] = [];
	const seen = new Set<string>();
	for (let e: Entry | undefined = leaf; e && typeof e.id === "string" && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
		seen.add(e.id);
		out.push(e);
	}
	return out.reverse().filter((e) => e.type !== "session");
}

/** What a transcript shows, oldest first: prompts, replies, tool calls with their results, notes. */
export function transcriptItems(text: string, truncated = false): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const calls = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
	if (truncated) items.push({ kind: "note", text: "earlier messages are not shown" });
	for (const e of branchOf(text, truncated)) {
		if (e.type === "compaction") {
			items.push({ kind: "note", text: "compacted" });
			continue;
		}
		if (e.type === "custom_message") {
			if (e.display === false) continue;
			const t = clean(textOf(e.content)).trim();
			if (t) items.push({ kind: "note", text: t });
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "user") {
			const t = clean(textOf(m.content)).trim();
			if (t) items.push({ kind: "user", text: t });
		} else if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const c of m.content as Record<string, unknown>[]) {
				if (c?.type === "text") {
					const t = clean(String(c.text ?? "")).trim();
					if (t) items.push({ kind: "assistant", text: t });
				} else if (c?.type === "toolCall") {
					const call = { kind: "tool" as const, name: clean(String(c.name ?? "tool")), args: clean(brief(c.arguments)) };
					items.push(call);
					if (typeof c.id === "string") calls.set(c.id, call);
				}
			}
			if (m.stopReason === "error" && typeof m.errorMessage === "string") items.push({ kind: "note", text: clean(m.errorMessage) });
		} else if (m.role === "toolResult") {
			const call = typeof m.toolCallId === "string" ? calls.get(m.toolCallId) : undefined;
			const result = clean(textOf(m.content)).trim();
			if (call) {
				call.result = result;
				call.error = m.isError === true;
			} else items.push({ kind: "tool", name: clean(String(m.toolName ?? "tool")), args: "", result, error: m.isError === true });
		} else if (m.role === "bashExecution") {
			items.push({ kind: "tool", name: "!", args: clean(String(m.command ?? "")), result: clean(String(m.output ?? "")).trim() });
		}
	}
	return items;
}

/** A session file's last READ_MAX bytes; truncated when the file is longer. */
export function readTail(file: string): { text: string; truncated: boolean; size: number; mtimeMs: number } {
	const fd = openSync(file, "r");
	try {
		const st = fstatSync(fd);
		const len = Math.min(st.size, READ_MAX);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, st.size - len);
		return { text: buf.toString("utf8"), truncated: st.size > len, size: st.size, mtimeMs: st.mtimeMs };
	} finally {
		closeSync(fd);
	}
}

/** Ancestors of a subagent up to (not including) the main session, nearest last. */
export function pathOf(row: JobRow, rows: Iterable<JobRow>, main: string): JobRow[] {
	const byFile = new Map<string, JobRow>();
	for (const r of rows) if (r.sessionFile) byFile.set(r.sessionFile, r);
	const out: JobRow[] = [];
	const seen = new Set<string>([row.sessionFile]);
	for (let p = row.parentSession; p && p !== main && !seen.has(p); ) {
		seen.add(p);
		const r = byFile.get(p);
		if (!r) break;
		out.unshift(r);
		p = r.parentSession;
	}
	return out;
}

/** A subagent's siblings (itself among them) and direct children, oldest first. */
export function neighboursOf(row: JobRow, rows: Iterable<JobRow>): { siblings: JobRow[]; children: JobRow[] } {
	const all = [...rows];
	const byAge = (a: JobRow, b: JobRow) => a.startedAt - b.startedAt;
	return {
		siblings: all.filter((r) => r.id === row.id || (!!row.parentSession && r.parentSession === row.parentSession)).sort(byAge),
		children: all.filter((r) => !!r.parentSession && r.parentSession === row.sessionFile).sort(byAge),
	};
}
