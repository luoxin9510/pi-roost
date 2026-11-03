// M0 spike R5: the foreground session hands its file over and switches to a
// throwaway scratch session, then opens a view inside withSession.
// Run: pi -ne --offline -e spikes/r5-handoff-scratch.ts (with a session), /r5
// Go if: after /r5 the active session file is the scratch file, the original
// file is no longer appended to, and the custom view opens in the new runtime.
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const LOG = process.env.ROOST_SPIKE_LOG ?? "/tmp/roost-spike-r5.log";
const log = (line: string) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
const size = (file: string | undefined) => {
	try {
		return file ? statSync(file).size : -1;
	} catch {
		return -1;
	}
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		log(`session_start reason=${event.reason} file=${ctx.sessionManager.getSessionFile()}`);
	});
	pi.on("session_shutdown", (event, ctx) => {
		log(`session_shutdown reason=${event.reason} file=${ctx.sessionManager.getSessionFile()}`);
	});

	pi.registerCommand("r5", {
		description: "R5 spike: hand off to a scratch session",
		handler: async (_args, ctx) => {
			const original = ctx.sessionManager.getSessionFile();
			await ctx.waitForIdle();
			const dir = join(tmpdir(), "roost-spike-r5");
			mkdirSync(dir, { recursive: true });
			// A fresh scratch session; the real version lives in the job dir.
			const scratch = SessionManager.create(ctx.cwd, dir);
			scratch.appendSessionInfo("roost-handoff");
			const scratchFile = scratch.getSessionFile();
			log(`handoff original=${original} size=${size(original)} scratch=${scratchFile}`);
			if (!scratchFile) return ctx.ui.notify("R5: scratch session has no file", "error");
			const result = await ctx.switchSession(scratchFile, {
				withSession: async (next) => {
					const active = next.sessionManager.getSessionFile();
					log(`withSession active=${active} originalSize=${size(original)}`);
					const closed = await next.ui.custom<string>((_tui, theme, _kb, done) => ({
						render: () => [
							theme.bold("R5 spike view (inside withSession)"),
							`active: ${active}`,
							`original: ${original} (${size(original)} bytes)`,
							theme.fg("dim", "Esc: close"),
						],
						invalidate: () => {},
						handleInput: (data: string) => {
							if (matchesKey(data, Key.escape)) done("esc");
						},
					}));
					log(`view closed via ${closed}; originalSize=${size(original)}`);
				},
			});
			log(`switchSession cancelled=${result.cancelled}`);
		},
	});
}
