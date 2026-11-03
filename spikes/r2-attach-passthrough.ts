// M0 spike R2: a ctx.ui.custom() component suspends the TUI it was given,
// hands the raw terminal to a child process, then restores the TUI.
// Run: pi -ne --offline --no-session -e spikes/r2-attach-passthrough.ts, then /r2
// In the view: Enter attaches (child: `sh -c ROOST_SPIKE_CHILD`, default a
// read-keys loop; type q to leave), Esc closes. Go if after the child exits the
// view repaints, still takes keys, and Esc returns focus to pi's editor.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const LOG = process.env.ROOST_SPIKE_LOG ?? "/tmp/roost-spike-r2.log";
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const CHILD =
	process.env.ROOST_SPIKE_CHILD ??
	`echo "child owns the terminal; type q + Enter"; while read l; do [ "$l" = q ] && exit 0; echo "child got: $l"; done`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("r2", {
		description: "R2 spike: attach passthrough from a custom() component",
		handler: async (_args, ctx) => {
			const result = await ctx.ui.custom<string>((tui, theme, _kb, done) => {
				let attaches = 0;
				let keys = 0;
				return {
					render: (width: number) => [
						theme.bold("R2 spike view"),
						`attaches=${attaches} keys since last attach=${keys}`,
						theme.fg("dim", "Enter: attach child · Esc: close").slice(0, width),
					],
					invalidate: () => {},
					handleInput: (data: string) => {
						keys++;
						if (matchesKey(data, Key.escape)) return done(`closed after ${attaches} attaches`);
						if (data === "a") {
							// Async variant (the real attach): own stdin while the TUI is stopped,
							// keep the event loop running, detach on the third key.
							log("async attach: tui.stop()");
							tui.stop();
							process.stdout.write("async attach: press 3 keys\r\n");
							process.stdin.setRawMode?.(true);
							let seen = 0;
							// pi left stdin in utf8 mode, so chunks arrive as strings.
							const onData = (chunk: Buffer | string) => {
								seen++;
								const hex = Buffer.from(chunk).toString("hex");
								process.stdout.write(`raw ${hex}\r\n`);
								log(`async raw ${typeof chunk} ${hex}`);
								if (seen < 3) return;
								process.stdin.off("data", onData);
								process.stdin.pause();
								tui.start();
								tui.requestRender(true);
								attaches++;
								keys = 0;
								log("async detach: tui.start() + requestRender(true)");
							};
							process.stdin.on("data", onData);
							process.stdin.resume();
							return;
						}
						if (!matchesKey(data, Key.enter)) return tui.requestRender();
						log("attach: tui.stop()");
						tui.stop();
						const r = spawnSync("sh", ["-c", CHILD], { stdio: "inherit" });
						log(`child exited status=${r.status}`);
						tui.start();
						tui.requestRender(true);
						attaches++;
						keys = 0;
						log("detach: tui.start() + requestRender(true)");
					},
				};
			});
			log(`custom() resolved: ${result}`);
			ctx.ui.notify(`R2: ${result}`, "info");
		},
	});
}
