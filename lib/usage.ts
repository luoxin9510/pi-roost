// M24: what a session spent, as pi's own footer counts it (every assistant message's usage
// and usage entry, tool results, compactions and branch summaries), with today's share and a split by model.
// Computed in the worker from its session, reported with the row, summed by the view.

export interface UsageInfo {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollars, as pi prices it (notional for a subscription). */
	cost: number;
	/** The part of `cost` since local midnight (when the worker last counted). */
	today: number;
	/** Local midnight (ms epoch) of the day `today` is for. */
	day: number;
	/** Billed to a subscription (pi's "(sub)"): the cost is what it would be per token. */
	sub: boolean;
	/** Cost and tokens per model ("provider/id"), the largest few. */
	models: Record<string, { cost: number; tokens: number }>;
}

/** Models kept per session in a report (the rest are summed under "other"). */
export const USAGE_MODELS = 8;

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown } | unknown;
}

interface EntryLike {
	type?: unknown;
	timestamp?: unknown;
	usage?: UsageLike;
	provider?: unknown;
	model?: unknown;
	message?: { role?: unknown; usage?: UsageLike; provider?: unknown; model?: unknown; responseModel?: unknown; timestamp?: unknown };
}

/** pi's bucket for usage no model is named for (tool results, summaries). */
export const SUMMARIES = "Tools/summaries";

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function localMidnight(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function timeOf(e: EntryLike): number | undefined {
	const t = e.message?.timestamp ?? e.timestamp;
	if (typeof t === "number" && Number.isFinite(t)) return t;
	if (typeof t === "string") {
		const ms = Date.parse(t);
		return Number.isFinite(ms) ? ms : undefined;
	}
	return undefined;
}

/** A session's usage from its entries (pi's sessionManager.getEntries()). */
export function sessionUsage(entries: readonly unknown[], now: number, sub: boolean): UsageInfo {
	const day = localMidnight(now);
	const u: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, today: 0, day, sub, models: {} };
	const models: Record<string, { cost: number; tokens: number }> = {};
	for (const raw of entries) {
		const e = raw as EntryLike;
		let usage: UsageLike | undefined;
		let model = "other";
		// the same entries and keys as pi's getUsageCostBreakdown
		if (e?.type === "usage") {
			usage = e.usage;
			if (typeof e.provider === "string" && typeof e.model === "string") model = `${e.provider}/${e.model}`;
		} else if (e?.type === "message" && e.message?.role === "assistant") {
			usage = e.message.usage;
			const id = typeof e.message.responseModel === "string" ? e.message.responseModel : e.message.model;
			if (typeof e.message.provider === "string" && typeof id === "string") model = `${e.message.provider}/${id}`;
		} else if (e?.type === "message" && e.message?.role === "toolResult" && e.message.usage) {
			usage = e.message.usage;
			model = SUMMARIES;
		} else if ((e?.type === "compaction" || e?.type === "branch_summary") && e.usage) {
			usage = e.usage;
			model = SUMMARIES;
		}
		if (!usage) continue;
		const cost = n((usage.cost as { total?: unknown } | undefined)?.total);
		const tokens = n(usage.input) + n(usage.output) + n(usage.cacheRead) + n(usage.cacheWrite);
		u.input += n(usage.input);
		u.output += n(usage.output);
		u.cacheRead += n(usage.cacheRead);
		u.cacheWrite += n(usage.cacheWrite);
		u.cost += cost;
		const t = timeOf(e);
		if (t !== undefined && t >= day) u.today += cost;
		const m = (models[model] ??= { cost: 0, tokens: 0 });
		m.cost += cost;
		m.tokens += tokens;
	}
	u.models = topModels(models);
	return u;
}

function topModels(models: Record<string, { cost: number; tokens: number }>): Record<string, { cost: number; tokens: number }> {
	const list = Object.entries(models).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
	const out: Record<string, { cost: number; tokens: number }> = {};
	for (const [k, v] of list.slice(0, USAGE_MODELS)) out[k] = { ...v };
	for (const [, v] of list.slice(USAGE_MODELS)) {
		const o = (out.other ??= { cost: 0, tokens: 0 });
		o.cost += v.cost;
		o.tokens += v.tokens;
	}
	return out;
}

/** A UsageInfo from untrusted JSON (a report, state.json), or null. */
export function usageFrom(v: unknown): UsageInfo | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const models: Record<string, { cost: number; tokens: number }> = Object.create(null);
	if (o.models && typeof o.models === "object") {
		for (const [k, m] of Object.entries(o.models as Record<string, unknown>).slice(0, USAGE_MODELS + 1)) {
			if (!k || k.length > 200 || k === "__proto__" || !m || typeof m !== "object") continue;
			const mm = m as Record<string, unknown>;
			models[k] = { cost: n(mm.cost), tokens: n(mm.tokens) };
		}
	}
	return {
		input: n(o.input),
		output: n(o.output),
		cacheRead: n(o.cacheRead),
		cacheWrite: n(o.cacheWrite),
		cost: n(o.cost),
		today: n(o.today),
		day: n(o.day),
		sub: o.sub === true,
		models,
	};
}

export function sameUsage(a: UsageInfo | null | undefined, b: UsageInfo | null | undefined): boolean {
	if (!a || !b) return !a && !b;
	return a.cost === b.cost && a.today === b.today && a.day === b.day && a.input + a.output === b.input + b.output && a.sub === b.sub;
}

/** Today's share as of `now`: none once the day it was counted for is over. */
export function todayOf(u: UsageInfo, now: number): number {
	return u.day === localMidnight(now) ? u.today : 0;
}

/** $0.42, $12.30, $1.2k: short enough for a row. */
export function formatCost(dollars: number): string {
	if (dollars < 0.005) return dollars > 0 ? "<$0.01" : "$0";
	if (dollars < 1000) return `$${dollars.toFixed(2)}`;
	return `$${(dollars / 1000).toFixed(1)}k`;
}

export interface UsageTotals {
	cost: number;
	today: number;
	tokens: number;
	/** The part of cost billed to subscriptions (notional). */
	subCost: number;
	models: Record<string, { cost: number; tokens: number; sessions: number }>;
}

/** M24: totals over rows (the agent view's header and /usage). */
export function totalUsage(rows: readonly { usage?: UsageInfo | null }[], now: number): UsageTotals {
	const t: UsageTotals = { cost: 0, today: 0, tokens: 0, subCost: 0, models: {} };
	for (const r of rows) {
		const u = r.usage;
		if (!u) continue;
		t.cost += u.cost;
		t.today += todayOf(u, now);
		t.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
		if (u.sub) t.subCost += u.cost;
		for (const [m, v] of Object.entries(u.models)) {
			const o = (t.models[m] ??= { cost: 0, tokens: 0, sessions: 0 });
			o.cost += v.cost;
			o.tokens += v.tokens;
			o.sessions++;
		}
	}
	return t;
}
