import { describe, expect, it } from "vitest";
import { formatCost, localMidnight, sessionUsage, todayOf, totalUsage, usageFrom, USAGE_MODELS } from "../lib/usage.ts";

const msg = (cost: number, at: number, model = "anthropic/claude-opus-5-5", tokens = 100) => {
	const [provider, id] = model.split("/");
	return {
		type: "message",
		timestamp: new Date(at).toISOString(),
		message: { role: "assistant", provider, model: id, timestamp: at, usage: { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } },
	};
};

describe("M24 usage", () => {
	const now = new Date(2026, 10, 4, 15, 0, 0).getTime();
	const yesterday = now - 24 * 3600_000;

	it("sums what pi's footer sums, splits today and models", () => {
		const entries = [
			msg(1.5, yesterday),
			msg(0.25, now - 1000),
			msg(0.1, now - 500, "openai/gpt-5"),
			{ type: "message", message: { role: "user", usage: { input: 999, cost: { total: 9 } } } },
			{ type: "usage", provider: "openai", model: "gpt-5", timestamp: new Date(now - 100).toISOString(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.05 } } },
			{ type: "usage", timestamp: new Date(now - 100).toISOString(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } },
			// as pi's footer: tool results, compactions and branch summaries count too
			{ type: "message", message: { role: "toolResult", timestamp: now - 90, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } },
			{ type: "compaction", timestamp: new Date(now - 80).toISOString(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } } },
			{ type: "branch_summary", timestamp: new Date(now - 70).toISOString(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.04 } } },
			{ type: "compaction", timestamp: new Date(now - 60).toISOString() },
			// the model that answered, when the provider says so
			{ ...msg(0.2, now - 50, "openrouter/auto"), message: { ...msg(0.2, now - 50, "openrouter/auto").message, responseModel: "x/y" } },
		];
		const u = sessionUsage(entries, now, false);
		expect(u.cost).toBeCloseTo(2.2);
		expect(u.today).toBeCloseTo(0.7);
		expect(u.input).toBe(410);
		expect(u.models["anthropic/claude-opus-5-5"]).toEqual({ cost: 1.75, tokens: 400 });
		expect(u.models["openai/gpt-5"]!.cost).toBeCloseTo(0.15);
		expect(u.models["Tools/summaries"]!.cost).toBeCloseTo(0.09);
		expect(u.models["openrouter/x/y"]!.cost).toBeCloseTo(0.2);
		expect(u.models.other!.cost).toBeCloseTo(0.01);
		expect(u.day).toBe(localMidnight(now));
		// a day later, today's share is gone
		expect(todayOf(u, now + 24 * 3600_000)).toBe(0);
		expect(todayOf(u, now)).toBeCloseTo(0.7);
	});

	it("keeps the largest models and sums the rest; takes nothing malformed", () => {
		const entries = Array.from({ length: USAGE_MODELS + 3 }, (_, i) => msg(i + 1, now, `p/m${i}`));
		const u = sessionUsage(entries, now, true);
		expect(Object.keys(u.models)).toHaveLength(USAGE_MODELS + 1);
		expect(u.models.other!.cost).toBe(1 + 2 + 3);
		expect(u.sub).toBe(true);
		expect(sessionUsage([null, 3, { type: "message", message: { role: "assistant", usage: { input: "x", cost: { total: -4 } } } }], now, false).cost).toBe(0);
		expect(usageFrom({ cost: "lots", input: -1, models: { "": { cost: 1 }, "a/b": { cost: 2, tokens: "x" } } })).toMatchObject({
			cost: 0,
			input: 0,
			models: { "a/b": { cost: 2, tokens: 0 } },
		});
		const hostile = usageFrom(JSON.parse('{"models":{"__proto__":{"cost":5},"constructor":{"cost":1}}}'));
		expect(Object.keys(hostile!.models)).toEqual(["constructor"]);
		expect(usageFrom(null)).toBeNull();
	});

	it("formats costs short and totals rows", () => {
		expect([formatCost(0), formatCost(0.001), formatCost(0.42), formatCost(12.3), formatCost(1234)]).toEqual(["$0", "<$0.01", "$0.42", "$12.30", "$1.2k"]);
		const a = sessionUsage([msg(2, now)], now, false);
		const b = sessionUsage([msg(1, yesterday, "openai/gpt-5")], now, true);
		const t = totalUsage([{ usage: a }, { usage: b }, { usage: null }, {}], now);
		expect(t).toMatchObject({ cost: 3, today: 2, subCost: 1 });
		expect(t.models["anthropic/claude-opus-5-5"]).toMatchObject({ cost: 2, sessions: 1 });
	});
});
