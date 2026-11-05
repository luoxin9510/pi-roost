import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../lib/protocol.ts";
import { branchOf, clean, neighboursOf, pathOf, READ_MAX, readTail, transcriptItems } from "../lib/transcript.ts";
import { TranscriptView } from "../adapters/pi/transcript-view.ts";

const line = (o: object) => `${JSON.stringify(o)}\n`;
function session(): string {
	return [
		line({ type: "session", id: "s0", cwd: "/w" }),
		line({ type: "message", id: "m1", parentId: "s0", message: { role: "system", content: "sys" } }),
		line({ type: "message", id: "m2", parentId: "m1", message: { role: "user", content: [{ type: "text", text: "fix the test" }] } }),
		line({ type: "message", id: "m3", parentId: "m2", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking.\u001b[31m" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } }] } }),
		line({ type: "message", id: "m4", parentId: "m3", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "1\n2\n3\n4\n5" }], isError: true } }),
		// an abandoned branch
		line({ type: "message", id: "x1", parentId: "m2", message: { role: "assistant", content: [{ type: "text", text: "old branch" }] } }),
		line({ type: "custom_message", id: "c1", parentId: "m4", customType: "roost", content: "message from main", display: true }),
		line({ type: "message", id: "m5", parentId: "c1", message: { role: "assistant", content: [{ type: "text", text: "Done: all green" }] } }),
	].join("");
}

let n = 0;
function row(over: Partial<JobRow> = {}): JobRow {
	n++;
	return {
		id: `id${n}`, cwd: "/w", kind: "pi", startedAt: n, state: "working", pid: 1, status: "busy", waitingFor: null,
		sessionFile: `/s/${n}.jsonl`, name: `child ${n}`, endedAt: null, summary: "running bash", question: null, choices: [],
		model: null, thinking: null, context: null, error: null, stateSince: 0, reaped: false, pinned: false, order: null,
		orderKey: null, parentSession: "/s/main.jsonl", rootSession: "/s/main.jsonl", ...over,
	} as JobRow;
}

describe("M19: transcripts", () => {
	it("reads the current branch: prompts, replies, tool calls with results, notes; no escapes", () => {
		expect(branchOf(session()).map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4", "c1", "m5"]);
		const items = transcriptItems(session());
		expect(items).toEqual([
			{ kind: "user", text: "fix the test" },
			{ kind: "assistant", text: "Looking." },
			{ kind: "tool", name: "bash", args: "npm test", result: "1\n2\n3\n4\n5", error: true },
			{ kind: "note", text: "message from main" },
			{ kind: "assistant", text: "Done: all green" },
		]);
		expect(clean("a\u001b]8;;x\u0007b\u0007c\r\nd\te")).toBe("abc\nd  e");
		// a cut first line and a half-written last one are skipped
		const cut = transcriptItems(`garbage"}\n${session()}{"type":"mess`, true);
		expect(cut[0]).toEqual({ kind: "note", text: "earlier messages are not shown" });
		expect(cut.at(-1)).toEqual({ kind: "assistant", text: "Done: all green" });
	});

	it("finds the path back to main, the siblings and the direct children", () => {
		const a = row({ name: "a" });
		const a1 = row({ name: "a1", parentSession: a.sessionFile });
		const a2 = row({ name: "a2", parentSession: a.sessionFile });
		const a1x = row({ name: "a1x", parentSession: a1.sessionFile });
		const all = [a, a1, a2, a1x];
		expect(pathOf(a1x, all, "/s/main.jsonl").map((r) => r.name)).toEqual(["a", "a1"]);
		expect(pathOf(a, all, "/s/main.jsonl")).toEqual([]);
		const nb = neighboursOf(a1, all);
		expect(nb.siblings.map((r) => r.name)).toEqual(["a1", "a2"]);
		expect(nb.children.map((r) => r.name)).toEqual(["a1x"]);
	});

	it("the view: breadcrumb, transcript, tree; moves through it, sends, attaches, goes back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-tr-"));
		const a = row({ name: "a", sessionFile: join(dir, "a.jsonl") });
		const a1 = row({ name: "a1", parentSession: a.sessionFile, sessionFile: join(dir, "a1.jsonl") });
		const a2 = row({ name: "a2", parentSession: a.sessionFile, sessionFile: join(dir, "a2.jsonl"), state: "done", pid: null });
		writeFileSync(a1.sessionFile, session());
		writeFileSync(a.sessionFile, line({ type: "message", id: "q", parentId: null, message: { role: "user", content: "parent task" } }));
		let renders = 0;
		const tui = { terminal: { rows: 24, columns: 80 }, requestRender: () => renders++ };
		const sent: [string, string][] = [];
		const results: unknown[] = [];
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		const v = new TranscriptView({
			tui: tui as never, theme, main: "/s/main.jsonl", rows: () => [a, a1, a2], start: a1.id,
			send: async (id, text) => (sent.push([id, text]), { ok: true, message: "sent · a1" }),
			done: (r) => results.push(r), pollMs: 20,
		});
		try {
			let screen = v.render(80);
			expect(screen).toHaveLength(24);
			for (const l of screen) expect(visibleWidth(l)).toBeLessThanOrEqual(80);
			expect(screen[0]).toContain("main › a › a1");
			const text = screen.join("\n");
			expect(text).toContain("› fix the test");
			expect(text).toContain("● bash npm test");
			expect(text).toContain("… +2 lines");
			expect(text).toContain("Done: all green");
			expect(text).toMatch(/← a[\s\S]*a1 \(shown\)[\s\S]*a2/);
			// the file grows: the view follows it
			appendFileSync(a1.sessionFile, line({ type: "message", id: "m6", parentId: "m5", message: { role: "assistant", content: [{ type: "text", text: "one more thing" }] } }));
			await new Promise((r) => setTimeout(r, 80));
			expect(v.render(80).join("\n")).toContain("one more thing");
			// typing is a message
			for (const ch of "go on") v.handleInput(ch);
			expect(v.render(80).join("\n")).toContain("message a1 › go on");
			v.handleInput("\r");
			await new Promise((r) => setTimeout(r, 10));
			expect(sent).toEqual([[a1.id, "go on"]]);
			expect(v.render(80).join("\n")).toContain("sent · a1");
			// ↓ to a sibling, Enter shows it
			v.handleInput("\x1b[B");
			v.handleInput("\r");
			expect(v.row()?.id).toBe(a2.id);
			// Esc: up to the parent, then out to main
			v.handleInput("\x1b");
			expect(v.row()?.id).toBe(a.id);
			expect(v.render(80).join("\n")).toContain("parent task");
			v.handleInput("\x0f"); // Ctrl+O
			expect(results).toEqual([{ attach: a }]);
			v.handleInput("\x1b");
			expect(results.at(-1)).toBeUndefined();
			expect(results).toHaveLength(2);
			screen = v.render(20);
			for (const l of screen) expect(visibleWidth(l)).toBeLessThanOrEqual(20);
		} finally {
			v.dispose();
		}
	});

	it("reads a long file's tail from a whole line", () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-tail-"));
		const f = join(dir, "s.jsonl");
		const pad = line({ type: "message", id: "p", parentId: null, message: { role: "user", content: "x".repeat(1000) } });
		const body = session();
		// the tail starts exactly at a line's start: that line is kept
		writeFileSync(f, "y".repeat(10) + "\n" + pad.repeat(Math.ceil(READ_MAX / pad.length)) + body);
		const t = readTail(f);
		expect(t.truncated).toBe(true);
		expect(t.text.endsWith(body)).toBe(true);
		expect(t.text.startsWith("{")).toBe(true);
	});

	it("the view: escapes in names never reach the screen; a row without a file; Ctrl+O twice on an ended one; a short terminal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "roost-tr2-"));
		const a = row({ name: "evil\u001b]0;pwn\u0007name", summary: "x\u001b[2Jy", sessionFile: join(dir, "a.jsonl"), state: "done", pid: null, reaped: false });
		const sh = row({ name: "shell", kind: "shell", sessionFile: "" });
		writeFileSync(a.sessionFile, session());
		const tui = { terminal: { rows: 24, columns: 80 }, requestRender: () => {} };
		const results: unknown[] = [];
		let release: (r: { ok: boolean; message: string }) => void = () => {};
		const v = new TranscriptView({
			tui: tui as never, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t }, main: "/s/main.jsonl", rows: () => [a, sh], start: a.id,
			send: () => new Promise((r) => (release = r)), done: (r) => results.push(r), pollMs: 1000,
		});
		try {
			// (pi-tui's own cursor marker aside)
			const text = v.render(80).join("\n").replace(/\u001b_pi:[^\u0007]*\u0007/g, "");
			expect(text).not.toContain("\u001b");
			expect(text).toContain("main › evilname"); // the OSC removed whole
			// a failed send comes back only to the subagent it was for
			for (const ch of "hello") v.handleInput(ch);
			v.handleInput("\r");
			v.handleInput("\x1b[B");
			v.handleInput("\x1b[B");
			v.handleInput("\r");
			expect(v.row()?.id).toBe(sh.id);
			expect(v.render(80).join("\n")).toContain("no transcript (not a pi session)");
			expect(v.render(80).join("\n")).not.toContain("fix the test");
			release({ ok: false, message: "not delivered" });
			await new Promise((r) => setTimeout(r, 10));
			expect(v.render(80).join("\n")).not.toContain("› hello");
			// back on the ended one: Ctrl+O asks again
			v.go(a);
			v.handleInput("\x0f");
			expect(results).toEqual([]);
			expect(v.render(80).join("\n")).toContain("Ctrl+O again starts it");
			v.handleInput("\x0f");
			expect(results).toEqual([{ attach: a }]);
			for (const rows of [3, 5, 8]) {
				tui.terminal.rows = rows;
				const out = v.render(80);
				expect(out.length).toBeLessThanOrEqual(rows);
				expect(out.at(-2) ?? out[0]).toMatch(/message|type to/);
			}
		} finally {
			v.dispose();
		}
	});
});
