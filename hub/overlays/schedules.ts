// M39/M73: the schedules overlay (/schedule list): each schedule, when it runs next, its last
// run. Moved out of the view in M73 (docs/plans/hub-overlays.md): it holds nothing of the view,
// only its host and the slice of the port it uses. Adding and the verbs stay the view's command.
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { agoText, untilText } from "../../lib/schedule.ts";
import { type Overlay, type OverlayHost } from "../overlay-host.ts";
import type { RoostPort } from "../roost-port.ts";
import { oneLine } from "../text.ts";

/** What the overlay asks of the daemon. */
export interface SchedulesPort {
	schedules: Pick<RoostPort["schedules"], "list">;
}

/** What the overlay needs of the view. */
export type SchedulesHost = Pick<OverlayHost<SchedulesPort>, "port" | "theme" | "say" | "close" | "requestRender" | "termRows">;

/**
 * `undefined` when there are none (the host has been told). A failed load throws (the view's
 * command says it).
 */
export async function createSchedulesOverlay(host: SchedulesHost): Promise<Overlay | undefined> {
	const list = (await host.port.schedules.list()).schedules;
	if (list.length === 0) {
		host.say('no schedules: /schedule <name> <every 1h | daily 09:00 | weekdays 09:00 | cron "…"> <task>');
		return undefined;
	}
	let top = 0;
	const lines = (width: number): string[] => {
		const t = host.theme;
		const now = Date.now();
		const out = [t.bold("Schedules"), ""];
		for (const s of list) {
			const next = s.paused ? t.fg("warning", "paused") : s.nextAt === null ? "never" : `next ${untilText(s.nextAt, now)}`;
			const last = s.lastRunAt ? `last ${agoText(now - s.lastRunAt)} ago` : "not run yet";
			out.push(truncateToWidth(`${t.fg("accent", s.name)}  ${s.when}  · ${next} · ${last}`, width));
			out.push(t.fg("dim", truncateToWidth(`  ${oneLine(s.task ?? "")}  · ${s.agent} · ${s.cwd}${s.model ? ` · ${s.model}` : ""}`, width)));
			if (s.lastSkip) out.push(t.fg("warning", truncateToWidth(`  skipped ${agoText(now - s.lastSkip.at)} ago: ${oneLine(s.lastSkip.why)}`, width)));
		}
		return out;
	};
	return {
		render(width: number) {
			const all = lines(width);
			const room = Math.max(3, (host.termRows() || 30) - 6);
			top = Math.max(0, Math.min(top, all.length - room));
			const keys = host.theme.fg("dim", truncateToWidth("/schedule run|pause|resume|rm <name> · ↑↓ scroll · Esc close", width));
			return [...all.slice(top, top + room), "", keys];
		},
		handleInput(data: string) {
			const key = parseKey(data);
			if (key === "escape" || key === "enter" || key === "ctrl+c" || data === "q") host.close();
			else if (key === "up") top = Math.max(0, top - 1);
			else if (key === "down") top++;
		},
	};
}
