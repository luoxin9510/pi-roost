// M0 spike R1: `pi --bg "task"` is intercepted in session_start and pi exits
// before any model turn runs.
// Run: pi -ne --offline --no-session -e spikes/r1-bg-early-exit.ts --bg "list files"
// Go if: stdout shows the backgrounded line, exit code 0, no turn started.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = process.env.ROOST_SPIKE_LOG ?? "/tmp/roost-spike-r1.log";
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

export default function (pi: ExtensionAPI) {
	pi.registerFlag("bg", { description: "Start <task> as a background session", type: "string" });

	pi.on("session_start", (_event, ctx) => {
		const task = pi.getFlag("bg");
		log(`session_start bg=${JSON.stringify(task)}`);
		if (typeof task !== "string" || task.length === 0) return;
		// The real implementation dispatches to the daemon here.
		const id = Math.random().toString(16).slice(2, 10);
		// Printed on exit: anything written while the TUI is up is repainted away.
		process.once("exit", () => process.stdout.write(`backgrounded · ${id} · ${task}\n`));
		ctx.shutdown();
	});

	pi.on("agent_start", () => log("agent_start (BAD: a turn started)"));
	pi.on("input", (event) => {
		log(`input ${JSON.stringify(event.text)}`);
		return undefined;
	});
	pi.on("session_shutdown", (event) => log(`session_shutdown reason=${event.reason}`));
}
