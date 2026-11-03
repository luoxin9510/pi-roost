import { setJobEventBus } from "../lib/job-events.ts";
import { resolve as resolvePath } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../lib/client.ts";
import { buildLaunch, fallbackName } from "../lib/dispatch.ts";
import { acquireWriterLock, releaseWriterLock } from "../lib/locks.ts";
import { isScratchSession } from "../lib/paths.ts";
import { registerForeground } from "./foreground.ts";
import { openAgentView, setCommandSource } from "./open-view.ts";
import { jobIdentity, registerWorker } from "./worker.ts";

// pi-roost entry: one extension, three roles (agent view, foreground, worker).
// So far: `--bg` dispatch, the session writer lock (DM-8), the worker role and
// the agent view (`pi --agents`, `/agents`).

export default function (pi: ExtensionAPI) {
	setJobEventBus(pi.events); // NT-2
	setCommandSource(() => pi.getCommands().map((c) => ({ name: c.name, source: c.source })));
	pi.registerFlag("bg", { description: "Start <task> as a background session and exit", type: "string" });
	pi.registerFlag("bg-name", { description: "Name for the --bg session", type: "string" });
	pi.registerFlag("agents", { description: "Open the agent view of background sessions", type: "boolean" });
	pi.registerFlag("agents-cwd", { description: "Limit the agent view to sessions under <dir>", type: "string" });

	pi.registerCommand("agents", {
		description: "Background sessions: dispatch, peek, reply, attach",
		handler: async (_args, ctx) => {
			await openAgentView(ctx, { cwdFilter: agentsCwd(pi, ctx) });
		},
	});

	let lockedFile: string | undefined;

	const lock = (ctx: ExtensionContext) => {
		const file = ctx.sessionManager.getSessionFile();
		if (!file || isScratchSession(file)) return;
		const result = acquireWriterLock(file);
		if (result.ok) {
			lockedFile = file;
		} else if (ctx.hasUI) {
			ctx.ui.notify(`pi-roost: this session is also open in process ${result.holder.pid}`, "warning");
		}
	};
	const unlock = () => {
		if (lockedFile) releaseWriterLock(lockedFile);
		lockedFile = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		const task = pi.getFlag("bg");
		if (typeof task === "string") return backgroundAndExit(pi, ctx, task);
		lock(ctx);
		if (pi.getFlag("agents") === true && ctx.hasUI) {
			// not awaited: session_start must return for pi to finish starting up
			void openAgentView(ctx, { cwdFilter: agentsCwd(pi, ctx) })
				.catch((err: unknown) => process.stderr.write(`pi-roost: agent view failed: ${String(err)}\n`))
				.finally(() => {
					try {
						ctx.shutdown();
					} catch {
						// the session is already gone
					}
				});
		}
	});

	pi.on("session_shutdown", () => unlock());

	const job = jobIdentity();
	if (job) registerWorker(pi, job);
	else registerForeground(pi);
}

function agentsCwd(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	const flag = pi.getFlag("agents-cwd");
	return typeof flag === "string" && flag ? resolvePath(ctx.cwd, flag) : undefined;
}

async function backgroundAndExit(pi: ExtensionAPI, ctx: ExtensionContext, task: string): Promise<void> {
	const fail = (message: string) => {
		// pi exits through process.exit(0); an exit listener can still change the code.
		process.once("exit", () => {
			process.stderr.write(`pi-roost: ${message}\n`);
			process.exitCode = 1;
		});
		ctx.shutdown();
	};
	if (!ctx.hasUI) return fail("--bg needs interactive mode; it cannot be combined with -p or --mode");
	if (task.trim().length === 0) return fail('--bg needs a task, e.g. pi --bg "run the tests"');

	// The current session file when there is one (pi --session <file> --bg), else a
	// fresh path; pi writes session files lazily, so neither needs to exist yet.
	const sessionFile = ctx.sessionManager.getSessionFile() ?? SessionManager.create(ctx.cwd).getSessionFile();
	if (!sessionFile) return fail("could not allocate a session file");
	const nameFlag = pi.getFlag("bg-name");
	const name = typeof nameFlag === "string" && nameFlag.trim() ? nameFlag.trim() : fallbackName(task);

	let client: DaemonClient | undefined;
	try {
		client = await DaemonClient.connectOrStart();
		const { id, name: finalName } = await client.request(
			"dispatch",
			buildLaunch({
				task,
				cwd: ctx.cwd,
				sessionFile,
				name,
				origin: "bg",
				argv: process.argv,
				execPath: process.execPath,
				env: process.env,
				piVersion: VERSION,
			}),
		);
		// Printed on exit: anything written while the TUI is up is repainted away (M0 R1).
		process.once("exit", () => {
			process.stdout.write(
				[
					`backgrounded · ${id} · ${finalName}`,
					`  pi-roost attach ${id}   open it`,
					`  pi-roost logs ${id}     last screen`,
					`  pi-roost stop ${id}     stop it`,
					"  pi-roost --json        list all",
					"",
				].join("\n"),
			);
		});
		ctx.shutdown();
	} catch (err) {
		fail((err as Error).message);
	} finally {
		client?.close();
	}
}

