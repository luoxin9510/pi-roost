import { discoverAgents, findAgent } from "../../lib/agents.ts";
import { setJobEventBus } from "../../lib/job-events.ts";
import { resolve as resolvePath } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../../lib/client.ts";
import { existsSync } from "node:fs";
import { buildLaunch, fallbackName, type Isolation, isolationDefault, prepareIsolation, refusedByDaemon } from "../../lib/dispatch.ts";
import { envPolicy, loadConfig } from "../../lib/config.ts";
import { acquireWriterLock, releaseWriterLock } from "../../lib/locks.ts";
import { isScratchSession } from "../../lib/paths.ts";
import { registerForeground } from "./foreground.ts";
import { registerForegroundPeer } from "./peer-link.ts";
import { registerSubagentPanel } from "./subagent-panel.ts";
import { openAgentView, setCommandSource } from "./open-view.ts";
import { jobIdentity, registerWorker } from "./worker.ts";
import { registerMobileStarter } from "./mobile.ts";
import { JOB_ENV } from "../../lib/identity.ts";

// pi-roost entry: one extension, three roles (agent view, foreground, worker).
// So far: `--bg` dispatch, the session writer lock (DM-8), the worker role and
// the agent view (`pi --agents`, `/agents`).

export default function (pi: ExtensionAPI) {
	setJobEventBus(pi.events); // NT-2
	setCommandSource(() => pi.getCommands().map((c) => ({ name: c.name, source: c.source })));
	pi.registerFlag("bg", { description: "Start <task> as a background session and exit", type: "string" });
	pi.registerFlag("bg-name", { description: "Name for the --bg session", type: "string" });
	pi.registerFlag("agent", { description: "With --bg: run as this agent (pi-subagents definition)", type: "string" });
	pi.registerFlag("worktree", { description: "With --bg: run the session in its own git worktree and branch", type: "boolean" });
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

	// M11: pi-mobile's "New session" can start background sessions, from any pi
	registerMobileStarter(pi);

	// M12: before the role's own keys, so a focused panel gets ← and Esc first
	registerSubagentPanel(pi);

	const job = jobIdentity();
	if (job) {
		// M9: commands the agent runs do not inherit the token (same-user processes can still
		// read it from the job's files: a guard against accidents, not a boundary)
		for (const n of JOB_ENV.token) delete process.env[n];
		registerWorker(pi, job);
	} else {
		registerForeground(pi);
		registerForegroundPeer(pi);
	}
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

	const nameFlag = pi.getFlag("bg-name");
	const name = typeof nameFlag === "string" && nameFlag.trim() ? nameFlag.trim() : fallbackName(task);
	// The current session file when there is one (pi --session <file> --bg), else a
	// fresh path; pi writes session files lazily, so neither needs to exist yet.
	const existing = ctx.sessionManager.getSessionFile();
	// M10: a worktree only for a new session (a session already written has its cwd)
	const fresh = !existing || !existsSync(existing);
	// pi --session <file> --bg names its session: a config default does not replace it
	const namedSession = process.argv.some((a) => a === "--session" || a.startsWith("--session="));
	const flag = pi.getFlag("worktree") === true;
	if (flag && (namedSession || !fresh)) return fail("--worktree starts a new session; it cannot be combined with --session");
	let iso: Isolation;
	try {
		iso = prepareIsolation(ctx.cwd, name, flag || (fresh && !namedSession && isolationDefault(loadConfig(ctx.cwd).worktreeIsolation, false)), flag);
	} catch (err) {
		return fail((err as Error).message);
	}
	const sessionFile = iso.worktree ? SessionManager.create(iso.cwd).getSessionFile() : (existing ?? SessionManager.create(ctx.cwd).getSessionFile());
	if (!sessionFile) {
		iso.discard();
		return fail("could not allocate a session file");
	}

	// M18: --agent, else the user's dispatchAgent
	const agentName = (typeof pi.getFlag("agent") === "string" && (pi.getFlag("agent") as string).trim()) || loadConfig(ctx.cwd).dispatchAgent;
	const agent = agentName ? findAgent(discoverAgents(ctx.cwd), agentName) : undefined;
	if (agentName && !agent) {
		iso.discard();
		return fail(`no agent named ${agentName} (pi-subagents definitions in ~/.pi/agent/agents, .pi/agents)`);
	}
	let client: DaemonClient | undefined;
	try {
		client = await DaemonClient.connectOrStart();
		const { id, name: finalName } = await client.request(
			"dispatch",
			buildLaunch({
				task,
				cwd: iso.cwd,
				sessionFile,
				name,
				origin: "bg",
				worktree: iso.worktree,
				...(agent ? { agent } : {}),
				argv: process.argv,
				execPath: process.execPath,
				env: process.env,
				...envPolicy(loadConfig(ctx.cwd)),
				piVersion: VERSION,
			}),
		);
		// Printed on exit: anything written while the TUI is up is repainted away (M0 R1).
		process.once("exit", () => {
			process.stdout.write(
				[
					`backgrounded · ${id} · ${finalName}`,
					...(iso.worktree ? [`  worktree ${iso.worktree.path} · branch ${iso.worktree.branch}`] : []),
					...(iso.note ? [`  note: ${iso.note}`] : []),
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
		if (refusedByDaemon(err)) iso.discard();
		fail((err as Error).message);
	} finally {
		client?.close();
	}
}

