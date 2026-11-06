import { describe, expect, it } from "vitest";
import type { BoardTask } from "../lib/board.ts";
import { registerTasksCommand, tasksText } from "../adapters/pi/tasks-command.ts";

const sha = "a".repeat(40);
const task = (id: number, extra: Partial<BoardTask> = {}): BoardTask => ({ id, title: `task ${id}`, detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: 1, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: "/r", waiting: [], ...extra });

function harness(answer: (args: Record<string, unknown>) => unknown) {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = { registerCommand: (name: string, o: { handler: typeof handler }) => name === "tasks" && (handler = o.handler) } as never;
	const sent: Record<string, unknown>[] = [];
	let closed = 0;
	const client = {
		request: async (op: string, args: Record<string, unknown>) => {
			expect(op).toBe("task");
			sent.push(args);
			const r = answer(args);
			if (r instanceof Error) throw r;
			return r;
		},
		close: () => closed++,
	};
	registerTasksCommand(pi, async () => client as never);
	const notes: [string, string][] = [];
	const ctx = { cwd: "/nowhere", ui: { notify: (t: string, l: string) => notes.push([t, l]) } };
	return { run: (a: string) => handler!(a, ctx), sent, notes, closed: () => closed };
}

describe("M59: /tasks in a pi session", () => {
	it("bare: the board with icons and stages", async () => {
		const h = harness(() => ({ tasks: [task(4, { workspace: { path: "/r/w", branch: "roost/t4-x-ab12", baseRef: "main", baseSha: sha, stage: "review", note: "verified" } }), task(5)] }));
		await h.run("");
		expect(h.sent).toEqual([{ action: "list" }]);
		expect(h.notes[0]![0]).toBe("all projects · 1 in review · 1 open\n◆ #4 task 4 · in review (verified)\n· #5 task 5 · open");
		expect(h.closed()).toBe(1);
		expect(tasksText([], "api")).toBe("api · nothing in workspaces");
	});

	it("merge, back with a note, shelve; approve is shown first, then approved with what was shown; errors are said", async () => {
		const h = harness((a) => (a.action === "approve" || a.action === "pr" ? (a.dry ? { tasks: [], note: "verify: npm test", hash: "h1" } : { tasks: [], note: "approved" }) : a.action === "merge" ? new Error("#4 is working") : { tasks: [], note: "ok" }));
		await h.run("merge 4");
		expect(h.notes.at(-1)).toEqual(["#4 is working", "error"]);
		await h.run("back #4 use a transaction");
		expect(h.sent.at(-1)).toEqual({ action: "back", id: 4, note: "use a transaction" });
		await h.run("shelve 4");
		expect(h.sent.at(-1)).toEqual({ action: "shelve", id: 4 });
		await h.run("approve 4");
		expect(h.notes.at(-1)![0]).toContain("verify: npm test · they run in your account");
		await h.run("approve 4");
		expect(h.sent.at(-1)).toEqual({ action: "approve", id: 4, hash: "h1" });
		await h.run("pr 4");
		expect(h.sent.at(-1)).toEqual({ action: "pr", id: 4, dry: true });
		await h.run("pr 4");
		expect(h.sent.at(-1)).toEqual({ action: "pr", id: 4, hash: "h1" });
		await h.run("cleanup");
		expect(h.sent.at(-1)).toEqual({ action: "cleanup", dry: true });
		await h.run("frobnicate 4");
		expect(h.notes.at(-1)![1]).toBe("warning");
		await h.run("merge");
		expect(h.notes.at(-1)![0]).toMatch(/^\/tasks \[/);
	});
});
