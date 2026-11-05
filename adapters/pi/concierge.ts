// M44: the concierge's role in pi: a worker (reports, replies, agent items) whose tools
// are the hub's (hub_sessions, hub_read, hub_send, hub_notify, hub_watch, hub_events)
// instead of the roost_* ones, with the concierge's system prompt, pi's own tools
// switched off, and its plain answer to a question from the hub handed back to it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AGENT_MESSAGE_TYPE, MESSAGE_MAX } from "../../lib/comms.ts";
import { CONCIERGE_DEFAULTS, CONCIERGE_ROLE_ENV, type ConciergePolicy, conciergeSystemPrompt, fleetLine } from "../../lib/concierge.ts";
import { envPolicy, loadConfig, loadUserConfig } from "../../lib/config.ts";
import { buildLaunch, fallbackName } from "../../lib/dispatch.ts";
import { eventAgo, eventLine } from "../../lib/events.ts";
import type { DispatchArgs } from "../../lib/protocol.ts";
import { screenPath } from "../../lib/store.ts";
import { readTail, transcriptItems } from "../../lib/transcript.ts";
import type { AgentLink } from "./agent-tools.ts";
import { envelopeBody, sendLine } from "./agent-tools.ts";

export const HUB_TOOLS = ["hub_sessions", "hub_events", "hub_read", "hub_send", "hub_notify", "hub_watch", "hub_suggest"] as const;
/** M45: the tools the policy switches on: an answer in the user's place; starting, stopping, restarting sessions. */
export const ANSWER_TOOLS = ["hub_reply"] as const;
export const ACT_TOOLS = ["hub_stop", "hub_respawn", "hub_dispatch"] as const;

export function isConciergeRole(env: NodeJS.ProcessEnv): boolean {
	return env[CONCIERGE_ROLE_ENV] === "concierge";
}

/** The tools the policy in force lets it use (the rest stay registered, inactive). */
export function activeTools(p: ConciergePolicy): string[] {
	return [...HUB_TOOLS, ...(p.answer === "never" ? [] : ANSWER_TOOLS), ...(p.act ? ACT_TOOLS : [])];
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

/**
 * The answer handed to the hub: the assistant's last text after the user's question. A
 * digest steered into the same turn (a custom message after the question) is answered
 * too, to nobody; the text before it is the answer.
 */
function answerText(ctx: ExtensionContext): string {
	// pi keeps a sent custom message (a digest) as a `custom_message` entry; older
	// sessions as a message with role "custom"
	const branch = ctx.sessionManager.getBranch() as { type: string; message?: { role?: string; content?: unknown } }[];
	const kind = (e: { type: string; message?: { role?: string } }) => (e.type === "custom_message" || (e.type === "message" && e.message?.role === "custom") ? "custom" : e.type === "message" ? e.message?.role : undefined);
	let user = -1;
	for (let i = branch.length - 1; i >= 0 && user < 0; i--) if (kind(branch[i]!) === "user") user = i;
	if (user < 0) return "";
	let answer = "";
	for (let i = user + 1; i < branch.length; i++) {
		const e = branch[i]!;
		const k = kind(e);
		if (k === "custom") {
			if (answer) break;
			continue;
		}
		if (k === "assistant") {
			const t = textOf(e.message?.content).trim();
			if (t) answer = t;
		}
	}
	return answer;
}

/** M45: a launch for `hub_dispatch`: a pi session like the hub's, in the concierge's directory unless told. */
function dispatchLaunch(ctx: ExtensionContext, params: { task: string; name?: string; cwd?: string; model?: string }): DispatchArgs {
	const task = params.task.trim();
	if (!task) throw new Error("task is empty");
	const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`not a directory: ${cwd}`);
	const sessionFile = SessionManager.create(cwd).getSessionFile();
	if (!sessionFile) throw new Error("could not allocate a session file");
	const config = loadConfig(cwd);
	// not a concierge itself
	const env = { ...process.env };
	delete env[CONCIERGE_ROLE_ENV];
	return buildLaunch({
		task,
		cwd,
		sessionFile,
		name: params.name?.trim() || fallbackName(task),
		origin: "dispatch",
		argv: process.argv,
		execPath: process.execPath,
		env,
		...envPolicy(config),
		piVersion: VERSION,
		model: params.model?.trim() || undefined,
	});
}

export function registerConcierge(pi: ExtensionAPI, link: AgentLink): void {
	const config = () => loadUserConfig().concierge ?? CONCIERGE_DEFAULTS;
	let answering = false;
	// M45: the policy in force (the daemon's; the setting until it answers), and the tools it allows
	let policy: ConciergePolicy = { answer: config().answer, act: config().act };
	let active = "";
	const syncPolicy = async (): Promise<ConciergePolicy> => {
		try {
			policy = await link.call("concierge-policy", {});
		} catch {}
		const tools = activeTools(policy);
		if (tools.join(",") !== active) {
			active = tools.join(",");
			try {
				pi.setActiveTools(tools);
			} catch {}
		}
		return policy;
	};

	pi.registerMessageRenderer<{ kind?: string; from?: string | null }>(AGENT_MESSAGE_TYPE, (message, opts, theme) => {
		const d = message.details ?? {};
		const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
		const digest = d.kind === "digest";
		const body = digest ? content.replace(/^<roost-digest[^>]*>\n?/, "").replace(/\n?<\/roost-digest>\s*$/, "") : envelopeBody(content);
		const head = digest ? "⟳ digest from roost" : `✉ ${d.kind ?? "message"} from ${d.from ?? "an agent"}`;
		const lines = body.split("\n");
		const shown = opts.expanded || lines.length <= 12 ? body : `${lines.slice(0, 12).join("\n")}\n… (${lines.length - 12} more lines)`;
		return new Text(`${theme.fg("accent", head)}\n${theme.fg("muted", shown)}`, 1, 0);
	});

	// the concierge's own prompt, whole, with the policy in force: it has no project to read
	pi.on("before_agent_start", async () => ({ systemPrompt: conciergeSystemPrompt(await syncPolicy()) }));

	// only the hub's tools (those the policy allows): no shell, no files
	pi.on("session_start", () => {
		active = "";
		void syncPolicy();
	});

	// a question from the hub (a plain user message; a digest is a custom one) is answered
	// in plain text: that text goes back to the hub once the turn settles
	pi.on("agent_start", () => {
		answering = false;
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "user") answering = true;
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!answering) return;
		answering = false;
		if (event.aborted) return;
		const answer = answerText(ctx);
		if (!answer) return;
		void link.call("concierge-say", { kind: "answer", text: answer }).catch(() => {});
	});

	pi.registerTool({
		name: "hub_sessions",
		label: "Sessions",
		description: "The fleet as it stands: every session with its id, name, state, how long it has been so, and what it is doing, asking, or ended with.",
		parameters: Type.Object({}),
		async execute() {
			const { jobs } = await link.call("list", {});
			const rows = jobs.filter((j) => j.role !== "concierge");
			if (rows.length === 0) return text("No sessions.");
			const now = Date.now();
			return text(rows.map((r) => fleetLine(r, now)).join("\n"));
		},
	});

	pi.registerTool({
		name: "hub_events",
		label: "Events",
		description: "What happened lately across the sessions, oldest first (the digests you get are made of these). Optional: only one session's (id), or only events after a seq.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "A session id" })),
			after: Type.Optional(Type.Number({ description: "Only events with a seq above this" })),
			limit: Type.Optional(Type.Number({ description: "At most this many (default 50)" })),
		}),
		async execute(_id, params) {
			const { events } = await link.call("events", { id: params.id, after: params.after, limit: params.limit ?? 50 });
			if (events.length === 0) return text("Nothing happened.");
			const now = Date.now();
			return text(events.map((e) => `${e.seq}  ${eventAgo(e.at, now)} ago  ${eventLine(e)}`).join("\n"));
		},
	});

	pi.registerTool({
		name: "hub_read",
		label: "Read session",
		description: "Look closer at one session: its question (and the answers it offers), the last part of its transcript, or its last screen (a terminal agent's). Use it when a row's one line is not enough to judge.",
		parameters: Type.Object({
			id: Type.String({ description: "Session id (from hub_sessions)" }),
			what: Type.Union([Type.Literal("question"), Type.Literal("transcript"), Type.Literal("screen")], { description: "question (default), transcript, or screen" }),
		}),
		async execute(_id, params) {
			const { jobs } = await link.call("list", { all: true });
			const row = jobs.find((j) => j.id === params.id || j.name === params.id);
			if (!row) throw new Error(`no session ${params.id}`);
			if (params.what === "screen") {
				try {
					const screen = readFileSync(screenPath(row.id), "utf8");
					return text(screen.trimEnd().split("\n").slice(-40).join("\n") || "(empty screen)");
				} catch {
					return text("(no screen kept for it)");
				}
			}
			if (params.what === "transcript") {
				if (!row.sessionFile) return text("It has no session file (a command, or a terminal agent): read its screen instead.");
				let items: ReturnType<typeof transcriptItems>;
				try {
					const tail = readTail(row.sessionFile);
					items = transcriptItems(tail.text, tail.truncated);
				} catch {
					return text("(its transcript cannot be read yet)");
				}
				const last = items.slice(-12).map((it) => {
					if (it.kind === "tool") return `[tool ${it.name}] ${it.args.slice(0, 200)}${it.error ? " (failed)" : ""}`;
					if (it.kind === "note") return `(${it.text})`;
					return `${it.kind === "user" ? "user" : "assistant"}: ${it.text.slice(0, 1500)}`;
				});
				return text(last.join("\n\n") || "(empty transcript)");
			}
			const head = fleetLine(row);
			if (row.state !== "blocked") return text(`${head}\n\nIt is not waiting for anything.`);
			const choices = row.choices.length > 0 ? `\nAnswers it offers: ${row.choices.join(" | ")}` : "";
			return text(`${head}\n\nIt waits for ${row.waitingFor ?? "input"}.${row.question ? ` Question: ${row.question}` : ""}${choices}`);
		},
	});

	pi.registerTool({
		name: "hub_send",
		label: "Send to session",
		description:
			"Message a session (id or exact name), for example to relay what another session found. It arrives at its next step, marked as from the concierge. Never use it to answer a session's question for the user, approve anything, or tell it to proceed.",
		parameters: Type.Object({
			to: Type.String({ description: "Session id or exact name" }),
			message: Type.String({ description: `What to tell it (at most ${MESSAGE_MAX} characters)` }),
		}),
		async execute(_id, params) {
			return text(sendLine(await link.call("send", { to: params.to, message: params.message })));
		},
	});

	pi.registerTool({
		name: "hub_notify",
		label: "Tell the user",
		description:
			'Tell the user something now: one short, specific line (which session, what, what to do). Level "need" when the user has to act (a session waits for an answer, one failed), "info" when it is good to know (something finished). Shown in the hub. Call it once per thing, not per digest.',
		parameters: Type.Object({
			text: Type.String({ description: "One line, at most 500 characters" }),
			level: Type.Union([Type.Literal("info"), Type.Literal("need")], { description: "info or need" }),
		}),
		async execute(_id, params) {
			await link.call("concierge-say", { kind: params.level === "need" ? "need" : "info", text: params.text });
			return text("Told the user.");
		},
	});

	pi.registerTool({
		name: "hub_watch",
		label: "Watch session",
		description: "Be told once, in a message here, when a session is next idle (finished, or waiting for an answer) or has ended. Use it instead of waiting; the digests cover the rest.",
		parameters: Type.Object({
			to: Type.String({ description: "Session id or exact name" }),
			when: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("ended")], { description: "idle (default) or ended" })),
		}),
		async execute(_id, params) {
			const r = await link.call("watch", { id: params.to, when: params.when ?? "idle" });
			return text(r.fired ? `${r.name} is already ${r.when === "ended" ? "ended" : "idle"}; the notice is on its way.` : `Watching ${r.name} (${r.id}) until it is ${r.when}.`);
		},
	});

	// M45: suggestions (always), answers in the user's place (answer: routine | always),
	// starting, stopping and restarting sessions (act: true); the daemon refuses what the
	// policy does not allow, whatever is active here
	pi.registerTool({
		name: "hub_suggest",
		label: "Suggest an answer",
		description:
			"For a session that waits for an answer: the answer you would give, and why, so the user can send it with one key. Call it for every question you report (hub_notify need). It does not answer the session.",
		parameters: Type.Object({
			id: Type.String({ description: "Session id or exact name" }),
			answer: Type.String({ description: "The answer, as the user would type it (at most 2000 characters)" }),
			why: Type.Optional(Type.String({ description: "One line: why that answer (at most 500 characters)" })),
		}),
		async execute(_id, params) {
			const r = await link.call("concierge-suggest", { id: params.id, text: params.answer, why: params.why });
			return text(`Suggested to the user for ${r.name}.`);
		},
	});

	pi.registerTool({
		name: "hub_reply",
		label: "Answer a session",
		description:
			"Answer a session's question in the user's place: only a routine one (proceed/confirm, the obvious default, information that is in the fleet), never anything irreversible or costly. The user sees it and can undo it. Refused when the policy does not allow it; then hub_suggest.",
		parameters: Type.Object({
			id: Type.String({ description: "Session id or exact name" }),
			answer: Type.String({ description: "The answer, plain text as the user would type it" }),
			why: Type.String({ description: "One line: why it is routine and why that answer" }),
		}),
		async execute(_id, params) {
			const r = await link.call("concierge-reply", { id: params.id, text: params.answer, why: params.why });
			return text(`Answered ${r.name}. Tell the user (hub_notify info) what you answered and why.`);
		},
	});

	pi.registerTool({
		name: "hub_stop",
		label: "Stop a session",
		description: "Stop a session (its work ends; it keeps its session and can be started again). Only when the user asked you to, or a standing order says so. Refused when the policy does not allow it.",
		parameters: Type.Object({
			id: Type.String({ description: "Session id or exact name" }),
			why: Type.String({ description: "One line: who asked, or which order" }),
		}),
		async execute(_id, params) {
			const r = await link.call("concierge-act", { what: "stop", id: params.id, why: params.why });
			return text(`Stopped ${r.name}.`);
		},
	});

	pi.registerTool({
		name: "hub_respawn",
		label: "Restart a session",
		description: "Start a session's process again with its session kept (after a crash, or to pick up a change). Only when the user asked you to, or a standing order says so. Refused when the policy does not allow it.",
		parameters: Type.Object({
			id: Type.String({ description: "Session id or exact name" }),
			why: Type.String({ description: "One line: who asked, or which order" }),
		}),
		async execute(_id, params) {
			const r = await link.call("concierge-act", { what: "respawn", id: params.id, why: params.why });
			return text(`Restarted ${r.name}.`);
		},
	});

	pi.registerTool({
		name: "hub_dispatch",
		label: "Start a session",
		description:
			"Start a new background pi session on a task, in a directory (the hub's by default). Only when the user asked you to, or a standing order says so. Refused when the policy does not allow it.",
		parameters: Type.Object({
			task: Type.String({ description: "What it should do" }),
			name: Type.Optional(Type.String({ description: "A short name for it" })),
			cwd: Type.Optional(Type.String({ description: "The directory to work in (absolute, or relative to the hub's)" })),
			model: Type.Optional(Type.String({ description: "provider/model, else the default" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const launch = dispatchLaunch(ctx, params);
			const r = await link.call("concierge-act", { what: "dispatch", launch, why: `dispatch ${params.name ?? ""}`.trim() });
			return text(`Started ${r.name} (${r.id}). What it does reaches you in the digests.`);
		},
	});
}
