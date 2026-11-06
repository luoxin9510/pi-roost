import { describe, expect, it } from "vitest";
import type { BoardTask, TaskWorkspace } from "../lib/board.ts";
import { changeShort, nextNeedsYou, WS_MERGED_MAX, workspaceEntries, wsCounts, wsDetail, wsGroup, wsIcon, wsKeys, wsNeedsYou, wsRowText } from "../lib/workspace-view.ts";

const now = 10_000_000_000;
const ws = (stage: TaskWorkspace["stage"], extra: Partial<TaskWorkspace> = {}): TaskWorkspace => ({ path: "/r/.pi/worktrees/x", branch: "roost/t1-x-ab12", baseRef: "main", baseSha: "a".repeat(40), stage, note: null, ...extra });
const task = (id: number, extra: Partial<BoardTask> = {}): BoardTask => ({ id, title: `task ${id}`, detail: null, state: "open", after: [], by: { who: "user", whoId: null }, at: now - 1000, owner: null, claimedAt: null, doneAt: null, result: null, assigned: null, project: "/r", waiting: [], ...extra });

describe("M57: the workspace pipeline", () => {
	it("groups by stage: review, conflict and failed, verifying, working (merging too), open of a repository, shelved, merged of the last day", () => {
		expect(wsGroup(task(1, { workspace: ws("review") }))).toBe("review");
		expect(wsGroup(task(1, { workspace: ws("conflict") }))).toBe("fix");
		expect(wsGroup(task(1, { workspace: ws("failed") }))).toBe("fix");
		expect(wsGroup(task(1, { workspace: ws("merging") }))).toBe("working");
		expect(wsGroup(task(1))).toBe("open");
		// for any session: no repository, nothing to start
		expect(wsGroup(task(1, { project: null }))).toBeUndefined();
		expect(wsGroup(task(1, { state: "claimed" }))).toBeUndefined();
		expect(wsGroup(task(1, { state: "dropped", workspace: ws("review") }))).toBeUndefined();
		expect(wsGroup(task(1, { state: "done", workspace: ws("merged", { merge: { tip: "b".repeat(40), oldBase: "a".repeat(40), at: now - 3_600_000 } }) }), now)).toBe("merged");
		expect(wsGroup(task(1, { state: "done", workspace: ws("merged", { merge: { tip: "b".repeat(40), oldBase: "a".repeat(40), at: now - 2 * 86_400_000 } }) }), now)).toBeUndefined();
	});

	it("orders the groups, by id within one, merged newest first and capped", () => {
		const merged = Array.from({ length: WS_MERGED_MAX + 3 }, (_, i) => task(100 + i, { state: "done", workspace: ws("merged", { merge: { tip: "b".repeat(40), oldBase: "a".repeat(40), at: now - 1000 * (i + 1) } }) }));
		const list = [task(7), task(3, { workspace: ws("working") }), task(5, { workspace: ws("review") }), task(2, { workspace: ws("review") }), task(4, { workspace: ws("conflict") }), ...merged];
		const e = workspaceEntries(list, now);
		expect(e.slice(0, 5).map((x) => x.task.id)).toEqual([2, 5, 4, 3, 7]);
		const m = e.filter((x) => x.group === "merged").map((x) => x.task.id);
		expect(m).toHaveLength(WS_MERGED_MAX);
		expect(m[0]).toBe(100);
		expect(wsCounts(e)).toBe("1 working · 2 in review · 1 to fix · 1 open");
		expect(wsCounts([])).toBe("nothing in workspaces");
	});

	it("icons: the stage, and for one at work its session (asks: ◐, works: ●, else ○)", () => {
		const w = task(1, { workspace: ws("working") });
		expect(wsIcon(w, { name: "a", state: "blocked", running: true }).glyph).toBe("◐");
		expect(wsIcon(w, { name: "a", state: "working", running: true }).glyph).toBe("●");
		expect(wsIcon(w, { name: "a", state: "working", running: false }).glyph).toBe("○");
		expect(wsIcon(w).glyph).toBe("○");
		expect(wsIcon(task(1, { workspace: ws("review") })).glyph).toBe("◆");
		expect(wsIcon(task(1, { workspace: ws("verifying") })).glyph).toBe("⧗");
		expect(wsIcon(task(1, { workspace: ws("failed") })).glyph).toBe("✕");
		expect(wsIcon(task(1)).glyph).toBe("·");
	});

	it("next needs you: after the selection, wrapping; a session that asks counts", () => {
		const list = [task(1, { workspace: ws("review") }), task(2, { workspace: ws("working"), owner: { id: "j2", name: "b" } }), task(3, { workspace: ws("failed") }), task(4)];
		const e = workspaceEntries(list, now);
		expect(nextNeedsYou(e, undefined)).toBe(1);
		expect(nextNeedsYou(e, 1)).toBe(3);
		expect(nextNeedsYou(e, 3)).toBe(1);
		const asks = (t: BoardTask) => (t.owner ? { name: "b", state: "blocked", running: true } : undefined);
		expect(wsNeedsYou(list[1]!, asks(list[1]!))).toBe(true);
		// the order is the entries': review (1), fix (3), working (2)
		expect(nextNeedsYou(e, 3, asks)).toBe(2);
		expect(nextNeedsYou(workspaceEntries([task(4)], now), undefined)).toBeUndefined();
	});

	it("the keys a stage has", () => {
		const k = (t: BoardTask, running = false) => wsKeys(t, running ? { name: "a", state: "idle", running } : undefined).map(([x]) => x);
		expect(k(task(1))).toEqual(["s", "n", "r"]);
		expect(k(task(1, { workspace: ws("review") }))).toEqual(["m", "b", "v", "s", "a", "n", "r"]);
		expect(k(task(1, { workspace: ws("review") }), true)).toEqual(["m", "b", "v", "t", "a", "n", "r"]);
		expect(k(task(1, { workspace: ws("failed") }))).toContain("p");
		expect(k(task(1, { workspace: ws("conflict") }))).toContain("x");
		expect(k(task(1, { workspace: ws("verifying") }))).not.toContain("m");
		expect(k(task(1, { workspace: ws("merging") }))).not.toContain("s");
	});

	it("the detail and the row", () => {
		const t = task(4, {
			title: "users\nmigration",
			detail: "add the users table",
			owner: { id: "j", name: "api-fix" },
			workspace: ws("failed", { note: "verify failed (round 3)", verify: { ok: false, at: now - 41_000, log: "/l", tail: "a\nb\nFAIL users.test\n", rounds: 3 } }),
		});
		const c = { files: [{ status: "M", path: "db/schema.sql", add: 12, del: 1 }], insertions: 12, deletions: 1, commits: 2, dirty: true };
		const d = wsDetail(t, { session: { name: "api-fix", state: "blocked", running: true }, changes: c, sentence: "done, tests\nfail", now });
		const text = d.map((x) => `${x.label}|${x.text}`);
		expect(text).toContain("stage|failed · verify failed (round 3)");
		expect(text).toContain("branch|roost/t1-x-ab12 (base main)");
		expect(text).toContain("agent|api-fix · waiting for you");
		expect(text).toContain("change|1 file +12 −1 · 2 commits · uncommitted changes");
		expect(text).toContain("verify|✕ failed · round 3 · 41s ago");
		expect(text).toContain("|FAIL users.test");
		expect(text).toContain("|M  db/schema.sql  +12 −1");
		expect(text).toContain('said|"done, tests fail"');
		expect(wsDetail(task(9), {}).map((x) => x.text)).toEqual(["open: s starts it in its own worktree"]);
		expect(wsRowText(t, [t])).toBe("#4 users migration");
		const blocked = task(9, { after: [4] });
		expect(wsRowText(blocked, [t, blocked])).toBe("#9 task 9 · after #4");
		expect(changeShort(c)).toBe("+12 −1");
		expect(changeShort(undefined)).toBe("");
	});
});
