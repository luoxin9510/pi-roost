// M43/M74: the log overlay (/log, /concierge log, a peek's /log): what happened lately across
// the sessions, newest first. Moved out of the view in M74 (docs/plans/hub-overlays.md): it
// holds nothing of the view, only its host and the slice of the port it uses.
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { eventAgo, eventLine, type RoostEvent } from "../../lib/events.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import type { RoostPort } from "../roost-port.ts";
import { oneLine } from "../text.ts";

/** What the overlay asks of the daemon. */
export interface LogPort {
	events: Pick<RoostPort["events"], "list">;
}

/** What the overlay needs of the view. */
export type LogHost = Pick<OverlayHost<LogPort>, "port" | "theme" | "say" | "close" | "requestRender" | "termRows">;

export interface LogOpts {
	/** Keep only the events it accepts (a session's, the concierge's). */
	only?: (e: RoostEvent) => boolean;
	title?: string;
}

/**
 * `undefined` when the feed cannot be read or has nothing to show (the host has been told).
 * `r` reads it again (a failed reload keeps what is shown).
 */
export async function createLogOverlay(host: LogHost, opts: LogOpts = {}): Promise<Overlay | undefined> {
	const { only, title = "Log · what happened lately (newest first)" } = opts;
	const { port } = host;
	let events: RoostEvent[];
	const fetch = async () => (await port.events.list({ limit: 500 })).events.filter((e) => !only || only(e)).slice(-200);
	try {
		events = await fetch();
	} catch (err) {
		host.say((err as Error).message, "error");
		return undefined;
	}
	if (events.length === 0) {
		host.say(only ? "nothing from the concierge yet" : "nothing happened yet (the log starts with the next task, reply or message)");
		return undefined;
	}
	let top = 0;
	const lines = (width: number): string[] => {
		const t = host.theme;
		const now = Date.now();
		const out = [t.bold(truncateToWidth(title, width)), ""];
		for (const e of [...events].reverse()) {
			const tone =
				e.kind === "state" && e.state === "failed"
					? "error"
					: e.kind === "state" && e.state === "blocked"
						? "warning"
						: e.kind === "state" && e.state === "done"
							? "success"
							: e.kind === "message" || e.kind === "report" || e.kind === "notice"
								? "accent"
								: "muted";
			out.push(truncateToWidth(`  ${t.fg("dim", eventAgo(e.at, now).padStart(4))}  ${t.fg(tone, oneLine(eventLine(e)))}`, width));
		}
		return out;
	};
	return {
		render(width: number) {
			const all = lines(width);
			const room = Math.max(3, (host.termRows() || 30) - 6);
			top = Math.max(0, Math.min(top, all.length - room));
			const keys = host.theme.fg("dim", truncateToWidth("r reload · ↑↓ scroll · Esc close", width));
			return [...all.slice(top, top + room), "", keys];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (data === "r") {
				void fetch()
					.then((r) => {
						events = r;
						host.requestRender();
					})
					.catch(() => {});
			} else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
			else if (key === "pageUp") top = Math.max(0, top - 10);
			else if (key === "pageDown") top += 10;
		},
	};
}
