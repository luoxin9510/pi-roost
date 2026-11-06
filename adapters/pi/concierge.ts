// M44: the concierge's role in pi: a worker (reports, replies, agent items) whose tools
// are the hub's (hub_sessions, hub_read, hub_send, hub_notify, hub_watch, hub_events)
// instead of the roost_* ones, with the concierge's system prompt, pi's own tools
// switched off, and its plain answer to a question from the hub handed back to it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { boardListing, taskPrompt } from "../../lib/board.ts";
import { AGENT_MESSAGE_TYPE, MESSAGE_MAX } from "../../lib/comms.ts";
import { CONCIERGE_DEFAULTS, CONCIERGE_ROLE_ENV, type ConciergePolicy, conciergeSystemPrompt, fleetLine } from "../../lib/concierge.ts";
import { envPolicy, loadConfig, loadUserConfig } from "../../lib/config.ts";
import { buildLaunch, fallbackName, refusedByDaemon } from "../../lib/dispatch.ts";
import { createTaskWorktree, type TaskWorktree } from "../../lib/task-git.ts";
import { discardWorktree } from "../../lib/worktree.ts";
import { eventAgo, eventLine } from "../../lib/events.ts";
import type { DispatchArgs } from "../../lib/protocol.ts";
import { screenPath } from "../../lib/store.ts";
import { readTail, transcriptItems } from "../../lib/transcript.ts";
import type { AgentLink } from "./agent-tools.ts";
import { envelopeBody, sendLine } from "./agent-tools.ts";

export const HUB_TOOLS = ["hub_sessions", "hub_events", "hub_read", "hub_send", "hub_notify", "hub_watch", "hub_suggest"] as const;
/** M45: the tools the policy switches on: an answer in the user's place; starting, stopping, restarting sessions. */
export const ANSWER_TOOLS = ["hub_reply"] as const;
export const ACT_TOOLS = ["hub_stop", "hub_respawn", "hub_dispatch", "hub_task_start"] as const;
/** M46: standing orders: always. */
export const ORDER_TOOLS = ["hub_note", "hub_note_done", "hub_note_drop"] as const;
/** M47: the task board, as the lead: always. */
export const BOARD_TOOLS = ["hub_tasks", "hub_task_add", "hub_task_assign", "hub_task_done", "hub_task_drop", "hub_task_release"] as const;

export function isConciergeRole(env: NodeJS.ProcessEnv): boolean {
	return env[CONCIERGE_ROLE_ENV] === "concierge";
}

/** The tools the policy in force lets it use (the rest stay registered, inactive). */
export function activeTools(p: ConciergePolicy): string[] {
	return [...HUB_TOOLS, ...ORDER_TOOLS, ...BOARD_TOOLS, ...(p.answer === "never" ? [] : ANSWER_TOOLS), ...(p.act ? ACT_TOOLS : [])];
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

	// the concierge's own prompt, whole, with the policy in force: it has no project to read;
	// a slow service does not hold the turn (the last policy known, then)
	pi.on("before_agent_start", async () => {
		const p = await Promise.race([syncPolicy(), new Promise<ConciergePolicy>((r) => setTimeout(() => r(policy), 1500).unref?.())]);
		return { systemPrompt: conciergeSystemPrompt(p) };
	});

	// only the hub's tools (those the policy allows): no shell, no files; at once, from the
	// setting, then as the service says
	pi.on("session_start", () => {
		active = activeTools(policy).join(",");
		try {
			pi.setActiveTools(activeTools(policy));
		} catch {}
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

	// M57: a task in its own worktree, as the hub's /tasks start (the worktree made here, the
	// session started by the daemon; a refused start leaves no worktree behind)
	pi.registerTool({
		name: "hub_task_start",
		label: "Start a task in its workspace",
		description:
			"Start a task of a repository in its own worktree and branch (roost/t<id>-…) with a session on it, as the user's /tasks start: it works there, commits, and the task goes to review (the user merges it). Only when the user asked you to, or a standing order says so. Refused when the policy does not allow it, or the task is blocked, claimed, or for any session.",
		parameters: Type.Object({
			id: Type.Number({ description: "The task's number" }),
			model: Type.Optional(Type.String({ description: "provider/model, else the default" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { tasks } = await link.call("task", { action: "list" });
			const t = tasks.find((x) => x.id === params.id);
			if (!t) throw new Error(`no task #${params.id}`);
			if (!t.project) throw new Error(`#${t.id} is for any session: a workspace is a repository's`);
			let made: TaskWorktree | undefined;
			const w = t.workspace?.path
				? { path: t.workspace.path, branch: t.workspace.branch, baseRef: t.workspace.baseRef, baseSha: t.workspace.baseSha }
				: ((made = createTaskWorktree(t.project, t.id, t.title)), { path: made.path, branch: made.branch, baseRef: made.baseRef, baseSha: made.base });
			const discard = () => {
				if (made) discardWorktree({ path: made.path, branch: made.branch, repo: made.repo, base: made.base });
			};
			let launch: DispatchArgs;
			try {
				launch = dispatchLaunch(ctx, { task: taskPrompt(t), cwd: w.path, name: fallbackName(t.title), model: params.model });
			} catch (err) {
				discard();
				throw err;
			}
			try {
				const r = await link.call("task", { action: "start", id: t.id, workspace: w, launch });
				return text(r.job ? `Started #${t.id} in ${w.branch}: ${r.job.name} works on it; it goes to review when done (the user merges).` : `#${t.id}: ${r.note ?? "starting"}`);
			} catch (err) {
				if (refusedByDaemon(err)) discard();
				throw err;
			}
		},
	});

	// M46: standing orders: keep one the user gives, mark one applied, drop one of yours
	pi.registerTool({
		name: "hub_note",
		label: "Keep a standing order",
		description:
			'Keep a rule the user gave you, in their words, so it is in every digest: "when build ends, tell deploy its result", "every evening say what finished and what is blocked". For one on a clock, give when (every 30m, daily 18:00, weekdays 09:00, cron "…"): roost wakes you with it when due.',
		parameters: Type.Object({
			text: Type.String({ description: "The order, one or two lines (at most 500 characters)" }),
			when: Type.Optional(Type.String({ description: "every 30m | daily 18:00 | weekdays 09:00 | cron \"m h dom mon dow\"" })),
		}),
		async execute(_id, params) {
			const r = await link.call("concierge-order", { action: "add", text: params.text, when: params.when });
			return text(`Kept as #${r.order?.id}${params.when ? ` (${params.when})` : ""}. It is in every digest from now on.`);
		},
	});

	pi.registerTool({
		name: "hub_note_done",
		label: "Order applied",
		description: "Say that you applied a standing order (#id) just now, and what you did; the user's log shows it.",
		parameters: Type.Object({
			id: Type.Number({ description: "The order's number" }),
			what: Type.String({ description: "One line: what you did for it" }),
		}),
		async execute(_id, params) {
			await link.call("concierge-order", { action: "applied", id: params.id, text: params.what });
			return text(`Noted for #${params.id}.`);
		},
	});

	pi.registerTool({
		name: "hub_note_drop",
		label: "Drop a standing order",
		description: "Drop a standing order you kept (#id), when the user tells you to. An order the user gave in the hub is the user's to drop (/concierge orders rm).",
		parameters: Type.Object({ id: Type.Number({ description: "The order's number" }) }),
		async execute(_id, params) {
			await link.call("concierge-order", { action: "rm", id: params.id });
			return text(`Dropped #${params.id}.`);
		},
	});

	// M47: the shared task board. The concierge is the lead: it reads the board, puts the
	// user's tasks on it, hands them to idle sessions, and marks them when the user says
	// so; it never claims one (the daemon refuses).
	pi.registerTool({
		name: "hub_tasks",
		label: "The task board",
		description: "The shared task board: what is open (a session may take it), blocked (waits on another task), claimed (a session works on it), done. Every digest carries it; read it here for the details.",
		parameters: Type.Object({}),
		async execute() {
			const { tasks } = await link.call("task", { action: "list" });
			return text(boardListing(tasks).join("\n"));
		},
	});

	pi.registerTool({
		name: "hub_task_add",
		label: "Add a task",
		description: "Put a task on the board, when the user asks for one. A task may wait on others (after: their numbers): it is claimable once those are done. project: a directory in the repository it is for (a session's cwd there): only sessions working in that repository see and take it; left out, any session may.",
		parameters: Type.Object({
			title: Type.String({ description: "One line (at most 200 characters)" }),
			detail: Type.Optional(Type.String({ description: "What doing it means, for the session that takes it (at most 2000 characters)" })),
			after: Type.Optional(Type.Array(Type.Number(), { description: "Task numbers it waits on" })),
			project: Type.Optional(Type.String({ description: "An absolute directory in the repository the task is for" })),
		}),
		async execute(_id, params) {
			const r = await link.call("task", { action: "add", title: params.title, detail: params.detail, after: params.after, ...(params.project ? { project: params.project } : {}) });
			return text(`Added #${r.task?.id}: ${r.task?.title}${params.after?.length ? ` (after ${params.after.map((i) => `#${i}`).join(", ")})` : ""}.`);
		},
	});

	pi.registerTool({
		name: "hub_task_assign",
		label: "Hand a task over",
		description: "Hand an open task to a session: it gets a message with the task and claims it with roost_task_claim. Pick an idle session (hub_sessions), or one that works on something related; a task of a project ([name] on the board) goes to a session working in that repository; a blocked task is handed over with its waits named.",
		parameters: Type.Object({
			id: Type.Number({ description: "The task's number" }),
			to: Type.String({ description: "Session id or exact name" }),
		}),
		async execute(_id, params) {
			const r = await link.call("task", { action: "assign", id: params.id, to: params.to });
			const who = r.task?.assigned?.name ?? params.to;
			return text(r.sent === "delivered" || r.sent === "queued" || r.sent === "started" ? `Handed #${params.id} to ${who}; it claims it when it reads the message.` : `#${params.id} was not handed over: ${who} is not running (${r.sent ?? "no answer"}).`);
		},
	});

	pi.registerTool({
		name: "hub_task_done",
		label: "Mark a task done",
		description: "Mark a task done, with its result, when the user says it is (a session marks its own with roost_task_done).",
		parameters: Type.Object({
			id: Type.Number({ description: "The task's number" }),
			result: Type.Optional(Type.String({ description: "One or two lines: what came of it" })),
		}),
		async execute(_id, params) {
			await link.call("task", { action: "done", id: params.id, result: params.result });
			return text(`#${params.id} is done.`);
		},
	});

	pi.registerTool({
		name: "hub_task_drop",
		label: "Drop a task",
		description: "Take a task off the board, when the user says so (a claimed one is taken from its session).",
		parameters: Type.Object({ id: Type.Number({ description: "The task's number" }) }),
		async execute(_id, params) {
			await link.call("task", { action: "drop", id: params.id });
			return text(`Dropped #${params.id}.`);
		},
	});

	pi.registerTool({
		name: "hub_task_release",
		label: "Release a task",
		description: "Give a claimed task back to the board (open again), when its session is stuck on it or the user says so.",
		parameters: Type.Object({ id: Type.Number({ description: "The task's number" }) }),
		async execute(_id, params) {
			await link.call("task", { action: "release", id: params.id });
			return text(`#${params.id} is open again.`);
		},
	});
}
