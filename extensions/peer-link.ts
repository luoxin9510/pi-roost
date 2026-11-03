// M9: a foreground pi session as a peer: it registers with the daemon the first time it
// uses an agent tool (or when it has spawned children), keeps that connection open to
// receive messages and reports, and hands them to pi as agent messages.
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../lib/client.ts";
import { AGENT_MESSAGE_TYPE } from "../lib/comms.ts";
import type { ArgsOf, Event, Op, ResultOf } from "../lib/protocol.ts";
import { isScratchSession } from "../lib/paths.ts";
import { listJobIds, readJob } from "../lib/store.ts";
import { registerAgentTools } from "./agent-tools.ts";

type Deliver = Extract<Event, { event: "deliver" }>;

const CALL_TIMEOUT_MS = 15_000;
const START_WAIT_MS = 10_000;
const RETRY_MS = 500;

/** Whether some job was spawned by this session (its reports should reach us at once). */
export function hasChildren(session: string | undefined): boolean {
	if (!session) return false;
	try {
		return listJobIds().some((id) => readJob(id)?.parentSession === session);
	} catch {
		return false;
	}
}

export function registerForegroundPeer(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let client: DaemonClient | undefined;
	let connecting: Promise<DaemonClient> | undefined;
	let peerId: string | undefined;
	let registeredAs: string | undefined;
	/** Once a peer, stay one (reconnect after daemon restarts, re-register on new sessions). */
	let active = false;
	let compacting = false;
	let running = false;
	let startedAt = 0;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let pumpTimer: NodeJS.Timeout | undefined;
	let backoff = 500;
	const inbox: Deliver[] = [];

	const eligible = (c: ExtensionContext | undefined): c is ExtensionContext =>
		!!c && c.hasUI && pi.getFlag("agents") !== true && typeof pi.getFlag("bg") !== "string" && !isScratchSession(c.sessionManager.getSessionFile());

	const nameOf = (c: ExtensionContext) => c.sessionManager.getSessionName() ?? `pi · ${basename(c.cwd)}`;

	const identity = (c: ExtensionContext) => `${c.sessionManager.getSessionFile() ?? ""}\0${nameOf(c)}`;

	async function connect(): Promise<DaemonClient> {
		if (client) return client;
		connecting ??= (async () => {
			const fresh = await DaemonClient.connectOrStart();
			fresh.onEvent((e) => {
				if (e.event === "deliver" && e.id === peerId && (e.kind === "message" || e.kind === "report")) receive(e);
			});
			fresh.onClose(() => {
				if (client !== fresh) return;
				client = undefined;
				registeredAs = undefined;
				if (active) scheduleReconnect();
			});
			client = fresh;
			return fresh;
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	}

	async function ensure(): Promise<DaemonClient> {
		const c = ctx;
		if (!eligible(c)) throw new Error("agent messaging needs an interactive pi session with pi-roost");
		active = true;
		const cl = await connect();
		const want = identity(c);
		if (registeredAs !== want) {
			const r = await cl.request("peer_register", {
				session: c.sessionManager.getSessionFile(),
				name: nameOf(c),
				cwd: c.cwd,
				pid: process.pid,
			});
			peerId = r.id;
			registeredAs = want;
			backoff = 500;
		}
		return cl;
	}

	function scheduleReconnect(): void {
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			void ensure().catch(() => {
				backoff = Math.min(backoff * 2, 10_000);
				if (active) scheduleReconnect();
			});
		}, backoff);
		reconnectTimer.unref?.();
	}

	function receive(e: Deliver): void {
		inbox.push(e);
		pump();
	}

	function pump(): void {
		clearTimeout(pumpTimer);
		pumpTimer = undefined;
		const c = ctx;
		while (c && inbox.length > 0) {
			if (startedAt && !running && Date.now() - startedAt < START_WAIT_MS) return retry();
			if (compacting) return retry();
			const e = inbox.shift()!;
			const message = {
				customType: AGENT_MESSAGE_TYPE,
				content: e.text,
				display: true,
				details: { kind: e.kind, from: e.from ?? null, relation: e.relation ?? null },
			};
			if (running) void pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
			else {
				// a second message before that run starts would start another: wait for it
				void pi.sendMessage(message, { triggerTurn: true });
				startedAt = Date.now();
			}
		}
	}

	function retry(): void {
		pumpTimer = setTimeout(pump, RETRY_MS);
		pumpTimer.unref?.();
	}

	pi.on("agent_start", () => {
		running = true;
		startedAt = 0;
		pump();
	});
	pi.on("agent_settled", () => {
		running = false;
		pump();
	});
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact", () => {
		compacting = false;
		pump();
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
		pump();
	});
	pi.on("session_info_changed", () => {
		// the new name shows to other agents from the next call or reconnect
		if (active && client) void ensure().catch(() => {});
	});
	pi.on("session_start", (_event, c) => {
		ctx = c;
		running = false;
		compacting = false;
		startedAt = 0;
		if (!eligible(c)) return;
		if (active || hasChildren(c.sessionManager.getSessionFile())) void ensure().catch(() => scheduleReconnect());
	});
	pi.on("session_shutdown", (event) => {
		ctx = undefined;
		// what arrived for this session cannot go to the next one
		inbox.length = 0;
		clearTimeout(pumpTimer);
		clearTimeout(reconnectTimer);
		// Let go of this session at once: after ← its job holds it, after /new nobody does,
		// and its messages and reports must go there, not to whatever this pi shows next.
		registeredAs = undefined;
		peerId = undefined;
		const old = client;
		client = undefined;
		old?.close();
		if (event.reason === "quit") active = false;
	});

	registerAgentTools(pi, {
		call: async <O extends Op>(op: O, args: ArgsOf<O>): Promise<ResultOf<O>> => {
			const cl = await ensure();
			return Promise.race([
				cl.request(op, args),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${op} timed out`)), CALL_TIMEOUT_MS).unref?.()),
			]);
		},
	});
}
