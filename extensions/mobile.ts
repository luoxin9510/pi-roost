import { basename } from "node:path";
import { type ExtensionAPI, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../lib/client.ts";
import { loadConfig } from "../lib/config.ts";
import { buildLaunch, fallbackName, isolationDefault, prepareIsolation, refusedByDaemon } from "../lib/dispatch.ts";

// M11: pi-mobile (phone remote) integration, over pi's event bus only: neither package
// imports the other. The contract is pi-mobile's src/starters.ts:
//
//   "pi-mobile:starters"  { register(starter) }  pi-mobile asks who can start sessions;
//                                                 pi-roost offers background sessions.
//   "pi-mobile:activity"  { action }             a phone acted on this session; a worker
//                                                 reports it so the daemon does not reap it.

export const STARTERS_CHANNEL = "pi-mobile:starters";
export const ACTIVITY_CHANNEL = "pi-mobile:activity";
export const STARTER_ID = "pi-roost";

export interface MobileStartRequest {
	cwd: string;
	prompt?: string;
	env?: Record<string, string>;
}

/** Starts a background session for the phone, like a task typed into the agent view. */
export async function startForMobile(req: MobileStartRequest, connect = () => DaemonClient.connectOrStart()): Promise<{ name: string; id: string }> {
	const task = req.prompt?.trim() ?? "";
	// pi-mobile checks the folder; the env is what it needs back (PI_MOBILE_SPAWN)
	const env = Object.fromEntries(Object.entries(req.env ?? {}).filter(([k, v]) => /^PI_MOBILE_[A-Z_]+$/.test(k) && typeof v === "string"));
	const config = loadConfig(req.cwd);
	const name = task ? fallbackName(task) : basename(req.cwd) || req.cwd;
	const iso = prepareIsolation(req.cwd, name, isolationDefault(config.worktreeIsolation, false), false);
	const sessionFile = SessionManager.create(iso.cwd).getSessionFile();
	if (!sessionFile) {
		iso.discard();
		throw new Error("could not allocate a session file");
	}
	const launch = buildLaunch({
		task,
		cwd: iso.cwd,
		sessionFile,
		name,
		origin: "dispatch",
		argv: process.argv,
		execPath: process.execPath,
		env: { ...process.env, ...env },
		extraEnv: [...config.envAllowList, ...Object.keys(env)],
		piVersion: VERSION,
		model: config.dispatchModel,
		thinking: config.dispatchThinking,
	});
	let client: DaemonClient | undefined;
	try {
		client = await connect();
		const r = await client.request("dispatch", { ...launch, ...(iso.worktree ? { worktree: iso.worktree } : {}) });
		return { id: r.id, name: r.name };
	} catch (err) {
		if (refusedByDaemon(err)) iso.discard();
		throw err;
	} finally {
		client?.close();
	}
}

/** Offers background sessions to pi-mobile's "New session", in every role. */
export function registerMobileStarter(pi: ExtensionAPI, start = startForMobile): void {
	// pi always has a bus; hosts in tests may not
	if (!pi.events) return;
	pi.events.on(STARTERS_CHANNEL, (data) => {
		const register = (data as { register?: unknown } | undefined)?.register;
		if (typeof register !== "function") return;
		register({
			id: STARTER_ID,
			label: "Background session",
			start: async (req: MobileStartRequest) => ({ name: (await start(req)).name }),
		});
	});
}

/** Calls `onActivity` for a phone's actions on this session, at most once per `everyMs`. */
export function onMobileActivity(pi: ExtensionAPI, onActivity: () => void, everyMs = 60_000, now = Date.now): () => void {
	let last = 0;
	if (!pi.events) return () => {};
	return pi.events.on(ACTIVITY_CHANNEL, () => {
		const t = now();
		if (t - last < everyMs) return;
		last = t;
		onActivity();
	});
}
