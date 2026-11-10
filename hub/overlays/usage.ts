// M24/M74: the usage overlay (/usage): what the sessions spent, by model and by session. Moved
// out of the view in M74 (docs/plans/hub-overlays.md): it reads the view's rows through its
// host and asks the daemon nothing.
import { parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, todayOf, totalUsage } from "../../lib/usage.ts";
import { formatTokens, shortModel } from "../../lib/view-model.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import { oneLine } from "../text.ts";

/** What the overlay needs of the view (no daemon). */
export type UsageHost = Pick<OverlayHost<never>, "theme" | "close" | "termRows" | "rows">;

/** The lines of the screen at `width`: the rows are read now, so it follows what the sessions spend. */
function usageLines(host: UsageHost, width: number): string[] {
	const t = host.theme;
	const now = Date.now();
	const rows = [...host.rows().values()].filter((r) => r.usage && (r.usage.cost > 0 || r.usage.input + r.usage.output > 0));
	const tot = totalUsage(rows, now);
	const fit = (s: string) => truncateToWidth(s, width);
	const out = [t.bold(fit("Usage · sessions in this view")), ""];
	if (rows.length === 0) return [...out, t.fg("dim", fit("  nothing spent yet (sessions report what they spend as they work)"))];
	const sub = tot.subCost > 0 ? ` · ${formatCost(tot.subCost)} of it on a subscription (as if billed per token)` : "";
	out.push(fit(`  today ${formatCost(tot.today)} · all ${formatCost(tot.cost)} · ${formatTokens(tot.tokens)} tokens${sub}`), "");
	const col = (s: string, n: number) => (visibleWidth(s) >= n ? truncateToWidth(s, n) : s + " ".repeat(n - visibleWidth(s)));
	const nameW = Math.max(12, Math.min(40, Math.floor(width / 2.5)));
	out.push(t.bold(fit("  By model")));
	const models = Object.entries(tot.models).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
	for (const [m, v] of models) {
		out.push(fit(`  ${col(shortModel(m), nameW)}  ${formatCost(v.cost).padStart(8)}  ${formatTokens(v.tokens).padStart(6)} tok  ${v.sessions} session${v.sessions === 1 ? "" : "s"}`));
	}
	out.push("", t.bold(fit("  By session")));
	const sorted = rows.sort((a, b) => b.usage!.cost - a.usage!.cost);
	for (const r of sorted) {
		const u = r.usage!;
		const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
		const today = todayOf(u, now);
		out.push(
			fit(
				`  ${col(oneLine(r.name), nameW)}  ${formatCost(u.cost).padStart(8)}  ${formatTokens(tokens).padStart(6)} tok${today > 0 ? `  ${formatCost(today)} today` : ""}${u.sub ? t.fg("dim", "  (sub)") : ""}  ${t.fg("dim", r.model ? shortModel(r.model) : "")}`,
			),
		);
	}
	return out;
}

/** M24: /usage: what the sessions spent, by model and by session; ↑↓ and PgUp/PgDn scroll, Esc closes. */
export function createUsageOverlay(host: UsageHost): Overlay {
	let top = 0;
	return {
		render(width: number) {
			const lines = usageLines(host, width);
			const room = Math.max(3, (host.termRows() || 30) - 6);
			top = Math.max(0, Math.min(top, lines.length - room));
			const keys = host.theme.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width));
			return [...lines.slice(top, top + room), "", keys];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
			else if (key === "pageUp") top = Math.max(0, top - 10);
			else if (key === "pageDown") top += 10;
		},
	};
}
