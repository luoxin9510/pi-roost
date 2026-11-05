// M44: the concierge's role in pi: a worker (reports, replies, agent items) whose tools
// are the hub's (hub_sessions, hub_read, hub_send, hub_notify, hub_watch, hub_events)
// instead of the roost_* ones, with the concierge's system prompt, pi's own tools
// switched off, and its plain answer to a question from the hub handed back to it.
import { readFileSync } from "node:fs";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AGENT_MESSAGE_TYPE, MESSAGE_MAX } from "../../lib/comms.ts";
import { CONCIERGE_DEFAULTS, CONCIERGE_ROLE_ENV, conciergeSystemPrompt, fleetLine } from "../../lib/concierge.ts";
import { loadUserConfig } from "../../lib/config.ts";
import { eventAgo, eventLine } from "../../lib/events.ts";
import { screenPath } from "../../lib/store.ts";
import { readTail, transcriptItems } from "../../lib/transcript.ts";
import type { AgentLink } from "./agent-tools.ts";
import { envelopeBody, sendLine } from "./agent-tools.ts";

export const HUB_TOOLS = ["hub_sessions", "hub_events", "hub_read", "hub_send", "hub_notify", "hub_watch"] as const;

export function isConciergeRole(env: NodeJS.ProcessEnv): boolean {
	return env[CONCIERGE_ROLE_ENV] === "concierge";
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** The last assistant message's text, for the answer handed to the hub. */
function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i]!;
		if (e.type !== "message" || e.message.role !== "assistant") continue;
		const c = e.message.content;
		if (typeof c === "string") return c;
		if (!Array.isArray(c)) return "";
		return c
			.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function registerConcierge(pi: ExtensionAPI, link: AgentLink): void {
	const config = () => loadUserConfig().concierge ?? CONCIERGE_DEFAULTS;
	let answering = false;

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

	// the concierge's own prompt, whole: it has no project to read
	pi.on("before_agent_start", () => ({ systemPrompt: conciergeSystemPrompt(config()) }));

	// only the hub's tools: no shell, no files
	pi.on("session_start", () => {
		try {
			pi.setActiveTools([...HUB_TOOLS]);
		} catch {}
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
		const answer = lastAssistantText(ctx).trim();
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
}
