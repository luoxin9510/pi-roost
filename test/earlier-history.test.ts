// M53: the conversation from before the latest compaction, loaded above pi's chat as the
// transcript is scrolled to its top.
import { initTheme, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Component, Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { drawUnit, EarlierHistory, earlierEntries, HISTORY_CHUNK, historyUnits, registerEarlierHistory, type ScrollLike, transcriptView } from "../adapters/pi/earlier-history.ts";

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

	// pi 1.5.0's fullscreen layout: a primary ScrollView over [header, resources, chat], a dock under it
	const piLayout = (chatLines: number) => {
		const chat = new Container();
		for (let i = 0; i < chatLines; i++) chat.addChild(new Text(`chat ${i}`, 0, 0));
		const doc = new Container();
		doc.addChild(new Text("header", 0, 0));
		doc.addChild(new Container());
		doc.addChild(chat);
		const sv = new ScrollView(doc, { follow: "end", primary: true });
		const root = new VStack([
			{ component: sv, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: new VStack([{ component: new Text("editor", 0, 0), shrink: 1, minSize: 1 }]), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		return { root, sv, doc, chat };
	};
	const frame = (root: Component) => renderLayoutFrame(root, 40, 11, () => {}).lines.map((l) => l.trimEnd());

	it("finds pi's transcript, and in real frames keeps the chat on its row as each chunk loads above it", async () => {
		const { root, sv, doc } = piLayout(30);
		expect(transcriptView(root)).toBe(sv);
		expect(transcriptView(new Container())).toBeUndefined();
		let asked = 0;
		const h = new EarlierHistory({ view: () => transcriptView(root), draw: lineDraw as never, note: (left) => `left ${left}`, requestRender: () => asked++ });
		h.set(fakeUnits(20));
		doc.children.splice(doc.children.length - 1, 0, h);
		// the first frame: not laid out yet, nothing loads (it looks again once)
		frame(root);
		expect(h.loaded).toBe(0);
		await new Promise((r) => setImmediate(r));
		expect(asked).toBe(1);
		// following the end: no load
		expect(frame(root).at(-2)).toBe("chat 29");
		expect(h.loaded).toBe(0);
		// at the top: header, the hint, the chat's first line on row 2; a chunk loads above it
		sv.scrollTo(0);
		const top = frame(root);
		expect(h.loaded).toBe(HISTORY_CHUNK);
		expect(sv.scrollTop).toBe(HISTORY_CHUNK);
		expect(top.slice(0, 3)).toEqual(["message 18", "message 19", "chat 0"]);
		// up again: the rest, the oldest on the row under the hint
		sv.scrollBy(-HISTORY_CHUNK);
		const next = frame(root);
		expect(h.loaded).toBe(20);
		expect(next[2]).toBe("message 8");
		sv.scrollTo(0);
		expect(frame(root).slice(0, 3)).toEqual(["header", "left 0", "message 0"]);
	});

	it("a short chat fills the screen with earlier messages, then follows its end", async () => {
		const { root, doc } = piLayout(2);
		const h = new EarlierHistory({ view: () => transcriptView(root), draw: lineDraw as never, note: (left) => `left ${left}`, requestRender: () => {} });
		h.set(fakeUnits(30));
		doc.children.splice(doc.children.length - 1, 0, h);
		frame(root);
		const second = frame(root);
		expect(h.loaded).toBe(HISTORY_CHUNK);
		expect(second.at(-2)).toBe("chat 1");
		frame(root);
		expect(h.loaded).toBe(HISTORY_CHUNK);
		// without a transcript (pi printing its document as it leaves fullscreen): nothing
		const gone = new EarlierHistory({ view: () => undefined, draw: lineDraw as never, note: () => "hint", requestRender: () => {} });
		gone.set(fakeUnits(3));
		expect(gone.render(40)).toEqual([]);
	});

	it("goes into pi's document before the chat, starts over on a compaction, and leaves on shutdown", () => {
		const { root, doc, chat } = piLayout(3);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, fn), getSettings: () => ({}) };
		let widget: Component | undefined;
		const tui = { layoutRoot: root as unknown, requestRender: () => {} };
		const kept = user("kept");
		let branch: SessionEntry[] = [user("a"), assistant("b"), kept, compaction(kept.id), user("now")];
		const ctx = (hasUI = true) => ({
			hasUI,
			cwd: "/tmp",
			sessionManager: { getBranch: () => branch },
			ui: {
				getToolsExpanded: () => false,
				setWidget: (_key: string, factory: (t: unknown, theme: unknown) => Component) => {
					widget = factory(tui, { fg: (_c: string, s: string) => s });
				},
			},
		});
		registerEarlierHistory(pi as never);
		handlers.get("session_start")!({}, ctx());
		expect(doc.children).toHaveLength(3);
		widget!.render(40);
		expect(doc.children).toHaveLength(4);
		expect(doc.children[3]).toBe(chat);
		const history = doc.children[2] as EarlierHistory;
		expect(history.total).toBe(2);
		// mounted once
		widget!.render(40);
		expect(doc.children).toHaveLength(4);
		const kept2 = user("kept2");
		branch = [...branch, kept2, compaction(kept2.id)];
		handlers.get("session_compact")!({}, ctx());
		expect(history.total).toBe(5);
		expect(history.loaded).toBe(0);
		handlers.get("session_shutdown")!({}, ctx());
		expect(doc.children).toHaveLength(3);
		// pi on the main screen (no layout root), or no UI: nothing
		tui.layoutRoot = undefined;
		handlers.get("session_start")!({}, ctx());
		widget!.render(40);
		expect(doc.children).toHaveLength(3);
		widget = undefined;
		handlers.get("session_start")!({}, ctx(false));
		expect(widget).toBeUndefined();
	});

	it("draws a skill's invocation folded, with the user's words after it", () => {
		const text = '<skill name="review" location="/s/review/SKILL.md">\nLONG SKILL BODY\n</skill>\n\nplease review';
		const o = { tui: { requestRender: () => {} } as never, cwd: "/tmp", hideThinking: true, outputPad: 1, toolsExpanded: false };
		const out = historyUnits([user(text)]).flatMap((u) => drawUnit(u, o).render(80)).join("\n");
		expect(out).toContain("review");
		expect(out).toContain("please review");
		expect(out).not.toContain("LONG SKILL BODY");
	});
});
