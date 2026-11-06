// M53: the conversation from before the latest compaction, loaded above pi's chat as the
// transcript is scrolled to its top.
import { initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Component, Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { drawUnit, EarlierHistory, earlierEntries, HISTORY_CHUNK, historyUnits, type ScrollLike, transcriptView } from "../adapters/pi/earlier-history.ts";

beforeAll(() => initTheme("dark"));

let n = 0;
const at = "2026-11-06T00:00:00.000Z";
const msg = (role: string, extra: Record<string, unknown>): SessionEntry =>
	({ type: "message", id: `e${++n}`, parentId: null, timestamp: at, message: { role, timestamp: 1, ...extra } }) as never;
const user = (text: string) => msg("user", { content: text });
const assistant = (text: string, calls: { id: string; name: string }[] = []) =>
	msg("assistant", {
		content: [{ type: "text", text }, ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: { path: "a.ts" } }))],
		api: "x",
		provider: "x",
		model: "x",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
	});
const result = (id: string, text: string) => msg("toolResult", { toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false });
const compaction = (firstKept: string): SessionEntry =>
	({ type: "compaction", id: `c${++n}`, parentId: null, timestamp: at, summary: "what happened", firstKeptEntryId: firstKept, tokensBefore: 1000 }) as never;

describe("M53: earlier history", () => {
	it("the entries pi leaves out are those before the latest compaction's first kept one", () => {
		const a = [user("one"), assistant("1"), user("two"), assistant("2")];
		expect(earlierEntries(a)).toEqual([]);
		const kept = user("three");
		const branch = [...a, kept, assistant("3"), compaction(kept.id), user("four")];
		expect(earlierEntries(branch)).toEqual(a);
		// a second compaction: everything before its first kept entry, the first compaction too
		const kept2 = user("five");
		const more = [...branch, kept2, compaction(kept2.id), user("six")];
		expect(earlierEntries(more).map((e) => e.id)).toEqual(branch.map((e) => e.id));
		// no kept entry found: up to the compaction
		expect(earlierEntries([user("x"), compaction("gone")])).toHaveLength(1);
	});

	it("shows prompts, assistant turns with their tool results, and earlier compactions; not results on their own", () => {
		const units = historyUnits([user("one"), assistant("reading", [{ id: "t1", name: "read" }]), result("t1", "file text"), msg("user", { content: [{ type: "image", data: "", mimeType: "image/png" }] }), compaction("x")]);
		expect(units.map((u) => u.message.role)).toEqual(["user", "assistant", "compactionSummary"]);
		expect(units[1]!.results.get("t1")?.toolCallId).toBe("t1");
	});

	it("draws them with pi's own components", () => {
		const units = historyUnits([user("hello from before"), assistant("an answer", [{ id: "t1", name: "read" }]), result("t1", "file text")]);
		const o = { tui: { requestRender: () => {} } as never, cwd: "/tmp", hideThinking: true, outputPad: 1, toolsExpanded: false };
		const text = units.flatMap((u) => drawUnit(u, o).render(80)).join("\n");
		expect(text).toContain("hello from before");
		expect(text).toContain("an answer");
		expect(text).toContain("read");
	});

	const fakeUnits = (count: number) => historyUnits(Array.from({ length: count }, (_, i) => user(`message ${i}`)));
	const lineDraw = (u: { message: { content?: unknown } }): Component => ({ render: () => [String(u.message.content)], invalidate: () => {} });

	it("loads the next older chunk only when the view is at its top, and keeps the view on the same lines", async () => {
		const view = { scrollTop: 5, currentScrollTop: 5, scrollTo() {} };
		Object.defineProperty(view, "scrollTop", { get: () => view.currentScrollTop });
		let renders = 0;
		const h = new EarlierHistory({ view: () => view as ScrollLike, draw: lineDraw as never, note: (left) => `left ${left}`, requestRender: () => renders++ });
		h.set(fakeUnits(30));
		expect(h.render(80)).toEqual(["left 30"]);
		view.currentScrollTop = 0;
		const first = h.render(80);
		expect(h.loaded).toBe(HISTORY_CHUNK);
		expect(first[0]).toBe(`left ${30 - HISTORY_CHUNK}`);
		expect(first.at(-1)).toBe("message 29");
		expect(view.currentScrollTop).toBe(HISTORY_CHUNK);
		// rendered again in the same frame: not loaded twice
		h.render(80);
		expect(h.loaded).toBe(HISTORY_CHUNK);
		await new Promise((r) => setImmediate(r));
		expect(renders).toBe(1);
		view.currentScrollTop = 0;
		h.render(80);
		view.currentScrollTop = 0;
		const all = h.render(80);
		expect(h.loaded).toBe(30);
		expect(all[0]).toBe("left 0");
		expect(all[1]).toBe("message 0");
		// all shown: at the top nothing more happens
		view.currentScrollTop = 0;
		expect(h.render(80)).toEqual(all);
		expect(view.currentScrollTop).toBe(0);
		// another compaction or session: nothing loaded
		h.set(fakeUnits(3));
		expect(h.render(80)[0]).toBe("left 0");
		h.set([]);
		expect(h.render(80)).toEqual([]);
	});

	it("finds pi's transcript in a fullscreen layout, and keeps a real ScrollView in place as history loads", () => {
		const chat = new Container();
		for (let i = 0; i < 5; i++) chat.addChild(new Text(`chat ${i}`, 0, 0));
		const doc = new Container();
		doc.addChild(new Text("header", 0, 0));
		doc.addChild(chat);
		const sv = new ScrollView(doc, { follow: "end", primary: true });
		const root = new VStack([
			{ component: sv, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new VStack([{ component: new Text("editor", 0, 0), shrink: 1, minSize: 1 }]), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		const found = transcriptView(root);
		expect(found).toBe(sv);
		expect(transcriptView(new Container())).toBeUndefined();
		const h = new EarlierHistory({ view: () => found, draw: lineDraw as never, note: (left) => `left ${left}`, requestRender: () => {} });
		h.set(fakeUnits(20));
		doc.children.splice(doc.children.length - 1, 0, h);
		// a viewport of 4 rows over 7 lines, scrolled to the top
		sv.updateLayout(7, 4, () => {});
		sv.scrollTo(0);
		const lines = doc.render(80).map((l) => l.trimEnd());
		// laid out again as pi does: the content grew above, the view moved with it
		sv.updateLayout(lines.length, 4, () => {});
		expect(sv.scrollTop).toBe(HISTORY_CHUNK);
		// before: [header, note, chat 0, chat 1] on screen; the chat stays on the same row
		expect(lines[sv.scrollTop + 2]).toBe("chat 0");
		expect(lines.slice(0, 2)).toEqual(["header", `left ${20 - HISTORY_CHUNK}`]);
		expect(lines.slice(2, 2 + HISTORY_CHUNK)).toEqual(Array.from({ length: HISTORY_CHUNK }, (_, i) => `message ${20 - HISTORY_CHUNK + i}`));
	});
});
