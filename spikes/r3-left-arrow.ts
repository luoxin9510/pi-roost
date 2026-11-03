// M0 spike R3: ← on an empty editor is seen by onTerminalInput before the
// editor and can be consumed; with text in the editor it passes through.
// Run: pi -ne --offline --no-session -e spikes/r3-left-arrow.ts
// Go if: ← on empty prompt notifies "R3 hit", ← with text moves the cursor,
// in both legacy and kitty keyboard modes.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

const LOG = process.env.ROOST_SPIKE_LOG ?? "/tmp/roost-spike-r3.log";
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		let hits = 0;
		ctx.ui.onTerminalInput((data) => {
			// pi asks for kitty flags 7 (event types), and terminal-input listeners run
			// before the TUI drops releases: without this a single ← fires twice.
			if (isKeyRelease(data) || !matchesKey(data, Key.left)) return undefined;
			const text = ctx.ui.getEditorText();
			log(`left data=${JSON.stringify(data)} editor=${JSON.stringify(text)}`);
			if (text.length > 0) return undefined;
			hits++;
			ctx.ui.notify(`R3 hit #${hits}`, "info");
			return { consume: true };
		});
	});
}
