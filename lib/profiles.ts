/**
 * M30: agent profiles, level 0 of any-agent (docs/plans/any-agent.md). A profile runs a
 * terminal agent roost knows nothing else about: its argv, how it takes a task, and what
 * on its screen says it is working or waiting. Profiles come from the user's roost.json
 * only: a cloned project cannot make roost run a command of its choosing.
 */

export interface AgentProfile {
	/** argv, never a shell line; `{model}`, `{thinking}`, `{task}` replace whole elements. */
	command: string[];
	/** How the first task reaches it: appended to argv, typed once it first goes quiet, or not at all. */
	task: "argv" | "type" | "none";
	/** argv added when a model is chosen (`{model}` in it); absent: the agent takes no model. */
	model?: string[];
	/** argv added when a thinking level is chosen (`{thinking}` in it). */
	thinking?: string[];
	/** argv that reopens its last session; null or absent: its command again, without the first task. */
	resume?: string[] | null;
	/** Regex over the whole screen: it is waiting for you. */
	waiting?: string;
	/** Regex over the whole screen: it is working (wins over quiet). */
	working?: string;
	/** Typed after a reply; default "\r". */
	submit?: string;
	/** Quiet this long (ms) with no other signal means it is idle; default 3000. */
	settleMs?: number;
	/** Extra environment; names on the deny list are dropped like any job's. */
	env?: Record<string, string>;
	/**
	 * M31: it speaks the roost agent protocol (docs/protocol.md): it gets the job's identity,
	 * its reports set the row, and replies reach it as protocol replies, not typed in.
	 */
	protocol?: boolean;
}

/** Names the profiles may not take: roost's own job kinds. */
const RESERVED = new Set(["pi", "shell", "off", "none"]);
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
export const profileName = (name: string): boolean => PROFILE_NAME.test(name) && !RESERVED.has(name);

const MAX_ARGV = 64;
const MAX_ARG = 4096;
const MAX_REGEX = 500;

function argv(v: unknown, min: number): string[] | undefined {
	if (!Array.isArray(v) || v.length < min || v.length > MAX_ARGV) return undefined;
	if (!v.every((a) => typeof a === "string" && a.length <= MAX_ARG && !a.includes("\0"))) return undefined;
	return v as string[];
}

/** A regex source that compiles (case-insensitive, multiline), or undefined. */
export function profileRegex(src: string | undefined): RegExp | undefined {
	if (!src) return undefined;
	try {
		return new RegExp(src, "im");
	} catch {
		return undefined;
	}
}

/** A profile from JSON, or undefined when it is not one (a bad regex makes it not one). */
export function profileFrom(v: unknown): AgentProfile | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const o = v as Record<string, unknown>;
	const command = argv(o.command, 1);
	if (!command || command[0] === "") return undefined;
	const task = o.task === "type" || o.task === "none" ? o.task : o.task === undefined || o.task === "argv" ? "argv" : undefined;
	if (!task) return undefined;
	const p: AgentProfile = { command, task };
	for (const k of ["model", "thinking"] as const) {
		if (o[k] === undefined) continue;
		const a = argv(o[k], 1);
		if (!a) return undefined;
		p[k] = a;
	}
	if (o.resume === null) p.resume = null;
	else if (o.resume !== undefined) {
		const a = argv(o.resume, 1);
		if (!a) return undefined;
		p.resume = a;
	}
	for (const k of ["waiting", "working"] as const) {
		if (o[k] === undefined) continue;
		if (typeof o[k] !== "string" || (o[k] as string).length > MAX_REGEX || !profileRegex(o[k] as string)) return undefined;
		p[k] = o[k] as string;
	}
	if (o.submit !== undefined) {
		if (typeof o.submit !== "string" || o.submit.length > 16) return undefined;
		p.submit = o.submit;
	}
	if (o.settleMs !== undefined) {
		if (typeof o.settleMs !== "number" || !Number.isInteger(o.settleMs) || o.settleMs < 500 || o.settleMs > 60_000) return undefined;
		p.settleMs = o.settleMs;
	}
	if (o.protocol !== undefined) {
		if (typeof o.protocol !== "boolean") return undefined;
		if (o.protocol) p.protocol = true;
	}
	if (o.env !== undefined) {
		if (!o.env || typeof o.env !== "object" || Array.isArray(o.env)) return undefined;
		const env: Record<string, string> = {};
		for (const [k, val] of Object.entries(o.env as Record<string, unknown>).slice(0, 100)) {
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof val === "string" && !val.includes("\0")) env[k] = val;
		}
		p.env = env;
	}
	return p;
}

export function profilesFrom(v: unknown): Record<string, AgentProfile> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, AgentProfile> = Object.create(null);
	for (const [name, raw] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
		const p = profileName(name) ? profileFrom(raw) : undefined;
		if (p) out[name] = p;
	}
	return out;
}

export interface ProfileValues {
	task?: string;
	model?: string;
	thinking?: string;
}

/**
 * One template: each element that is exactly a placeholder becomes its value, or goes
 * when there is none; other elements stay as written (no partial substitution, no shell,
 * no environment expansion).
 */
function fill(template: string[], v: ProfileValues): string[] {
	const out: string[] = [];
	for (const a of template) {
		const m = /^\{(task|model|thinking)\}$/.exec(a);
		if (!m) out.push(a);
		else {
			const val = v[m[1] as keyof ProfileValues];
			if (val) out.push(val);
		}
	}
	return out;
}

/** True when the template names this placeholder. */
const names = (template: string[] | undefined | null, key: string) => !!template?.includes(`{${key}}`);

/**
 * The argv a profile starts with: its command, then its model and thinking arguments
 * when chosen, then the task when it takes one in argv. A command that places `{model}`
 * (or `{task}`) itself gets it there instead.
 */
export function profileCommand(p: AgentProfile, v: ProfileValues): string[] {
	const out = fill(p.command, v);
	if (v.model && p.model && !names(p.command, "model")) out.push(...fill(p.model, v));
	if (v.thinking && p.thinking && !names(p.command, "thinking")) out.push(...fill(p.thinking, v));
	if (p.task === "argv" && v.task && !names(p.command, "task")) out.push(v.task);
	return out;
}

/** The argv that reopens it, or undefined when it cannot be reopened. */
export function profileResume(p: AgentProfile, v: ProfileValues): string[] | undefined {
	if (!p.resume) return undefined;
	const out = fill(p.resume, v);
	return out.length > 0 ? out : undefined;
}

/** What the daemon keeps with the job: how to read its screen and how to type into it. */
export interface ProfileTerm {
	submit: string;
	settleMs: number;
	waiting?: string;
	working?: string;
	/** Typed once it first goes quiet (task "type", or a reply to an ended one). */
	typeTask?: string;
}

export function profileTerm(p: AgentProfile, task?: string): ProfileTerm {
	return {
		submit: p.submit ?? "\r",
		settleMs: p.settleMs ?? 3000,
		...(p.waiting ? { waiting: p.waiting } : {}),
		...(p.working ? { working: p.working } : {}),
		...(p.task === "type" && task ? { typeTask: task } : {}),
	};
}

/** The term settings from a stored job record, checked again (the file is the daemon's, but old or edited). */
export function termFrom(v: unknown): ProfileTerm | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	const t: ProfileTerm = {
		submit: typeof o.submit === "string" && o.submit.length <= 16 ? o.submit : "\r",
		settleMs: typeof o.settleMs === "number" && o.settleMs >= 500 && o.settleMs <= 60_000 ? o.settleMs : 3000,
	};
	for (const k of ["waiting", "working"] as const) {
		const s = o[k];
		if (typeof s === "string" && s.length <= MAX_REGEX && profileRegex(s)) t[k] = s;
	}
	if (typeof o.typeTask === "string" && o.typeTask) t.typeTask = o.typeTask;
	return t;
}
