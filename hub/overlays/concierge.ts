// M44/M46/M73: the concierge's overlays: the standing orders (/concierge orders) and its answer
// (`? …`). Moved out of the view in M73 (docs/plans/hub-overlays.md): they hold nothing of the
// view. Deferring an answer until the open overlay closes (`pendingAnswer`) stays the view's.
import { parseKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { orderLine } from "../../lib/concierge.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import type { RoostPort } from "../roost-port.ts";
import { CONTROL, oneLine } from "../text.ts";

/** What the orders overlay asks of the daemon. */
export interface OrdersPort {
	concierge: { orders: Pick<RoostPort["concierge"]["orders"], "list"> };
}

/** What the overlays need of the view. */
export type ConciergeHost = Pick<OverlayHost<OrdersPort>, "port" | "theme" | "say" | "close" | "requestRender" | "termRows">;
/** What the answer overlay needs: no daemon. */
export type AnswerHost = Pick<OverlayHost<never>, "theme" | "close" | "requestRender" | "termRows">;

/**
 * M46: the standing orders, newest first; ↑↓ scroll, Esc closes. `undefined` when there are
 * none (the host has been told). A failed load throws (the view's command says it).
 */
export async function createOrdersOverlay(host: ConciergeHost): Promise<Overlay | undefined> {
	const { orders } = await host.port.concierge.orders.list();
	if (orders.length === 0) {
		host.say("no standing orders · /concierge orders add <rule> (or tell the concierge: ? remember …)", "muted");
		return undefined;
	}
	let top = 0;
	const lines = (width: number): string[] => {
		const t = host.theme;
		const now = Date.now();
		const out = [t.bold(truncateToWidth("Standing orders · what the concierge keeps in mind", width)), ""];
		for (const o of [...orders].reverse()) {
			const by = o.by === "concierge" ? "" : t.fg("dim", " · yours");
			out.push(truncateToWidth(`  ${t.fg(o.when ? "accent" : "muted", oneLine(orderLine(o, now)))}${by}`, width));
		}
		out.push("", t.fg("dim", truncateToWidth("/concierge orders add <rule> · /concierge orders rm <id>", width)));
		return out;
	};
	return {
		render(width: number) {
			const all = lines(width);
			const room = Math.max(3, (host.termRows() || 30) - 6);
			top = Math.max(0, Math.min(top, all.length - room));
			return [...all.slice(top, top + room), "", host.theme.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
		},
	};
}

/** M44: the concierge's answer to `? …`, wrapped; ↑↓ scroll, Esc closes. */
export function createAnswerOverlay(host: AnswerHost, opts: { answer: string }): Overlay {
	const { answer } = opts;
	let top = 0;
	return {
		render(width: number) {
			const t = host.theme;
			const clean = stripTerminalSequences(answer).replace(/\t/g, "  ").replace(CONTROL, "");
			const body = wrapTextWithAnsi(clean, Math.max(4, width - 2)).map((l) => `  ${l}`);
			const all = [t.bold(truncateToWidth("Concierge", width)), "", ...body];
			const room = Math.max(3, (host.termRows() || 30) - 6);
			top = Math.max(0, Math.min(top, all.length - room));
			return [...all.slice(top, top + room), "", t.fg("dim", truncateToWidth("↑↓ scroll · Esc close", width))];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
		},
	};
}
