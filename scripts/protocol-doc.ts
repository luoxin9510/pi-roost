#!/usr/bin/env node
// M75: npm run docs:protocol writes the op reference of docs/protocol.md (between the
// markers) from the schemas in lib/protocol-schema.ts, the callers table (lib/callers.ts)
// and the capability lists (lib/protocol.ts). test/protocol-doc.test.ts fails when it is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POLICY, type Policy, type PolicyKey } from "../lib/callers.ts";
import { AGENT_CAPABILITIES, type AgentCapability, DAEMON_CAPABILITIES, type DaemonCapability, PROTOCOL_VERSION } from "../lib/protocol.ts";
import {
	ArgSchemas,
	ContextInfoS,
	DaemonStatusSchema,
	DispatchArgsSchema,
	HandbackArgsSchema,
	HelloArgsSchema,
	HelloResultSchema,
	JobRowSchema,
	OPS,
	PeerRowSchema,
	ResultSchemas,
	ScheduleRowSchema,
	SendResultSchema,
	WorkerReportSchema,
} from "../lib/protocol-schema.ts";

export const DOC_PATH = fileURLToPath(new URL("../docs/protocol.md", import.meta.url));
export const START = "<!-- op-reference:start -->";
export const END = "<!-- op-reference:end -->";

const DAEMON_CAPABILITY_DOC: Record<DaemonCapability, string> = {
	replies: "takes the user's replies for the agent (`deliver`, `ack`)",
	steer: 'honours `mode: "steer"` on a reply',
	"agent-items": "delivers peer messages, reports, notices and digests",
	peers: "`peers`, `send`",
	spawn: "`spawn`",
	handback: "`handback`",
	events: "`events`",
	watch: "`watch`",
	tasks: "`task` (the shared board)",
	workspaces: "a task's own worktree and its stages (`task` prepare, start, merge, ...)",
};
const AGENT_CAPABILITY_DOC: Record<AgentCapability, string> = {
	report: "sends reports (every agent of this protocol)",
	replies: "takes replies and acks them",
	steer: 'honours `mode: "steer"` on a reply',
	usage: "fills `usage` in its reports",
	context: "fills `context` in its reports",
	"model-switch": "takes `/model` and `/thinking` replies",
	transcript: "has a transcript roost can show",
	peers: "uses the agent-to-agent ops",
	"agent-items": "takes peer messages, reports, notices and digests as deliveries",
};

/** The shapes several ops share: described once, named where they are used. */
const SHARED = new Map<object, string>([
	[DispatchArgsSchema, "DispatchArgs"],
	[HelloArgsSchema, "HelloArgs"],
	[HelloResultSchema, "HelloResult"],
	[HandbackArgsSchema, "HandbackArgs"],
	[WorkerReportSchema, "WorkerReport"],
	[JobRowSchema, "JobRow"],
	[PeerRowSchema, "PeerRow"],
	[SendResultSchema, "SendResult"],
	[ScheduleRowSchema, "ScheduleRow"],
	[DaemonStatusSchema, "DaemonStatus"],
	[ContextInfoS, "ContextInfo"],
]);

/** Ops that are a union on one field. */
const UNION_KEY: Record<string, string> = { task: "action", concierge: "action", "concierge-order": "action", "concierge-act": "what" };

type S = {
	type?: string;
	title?: string;
	description?: string;
	enum?: unknown[];
	const?: unknown;
	anyOf?: S[];
	items?: S;
	properties?: Record<string, S>;
	required?: string[];
	additionalProperties?: S;
	maxLength?: number;
	minLength?: number;
};

const cell = (t: string) => t.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

function ty(s: S): string {
	const name = SHARED.get(s);
	if (name) return name;
	if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
	if ("const" in s) return JSON.stringify(s.const);
	if (s.anyOf) {
		const parts = s.anyOf.map((m) => ty(m));
		return [...parts.filter((p) => p !== "null"), ...parts.filter((p) => p === "null")].join(" | ");
	}
	if (s.type === "array") {
		const inner = ty(s.items!);
		return `${inner.includes(" | ") ? `(${inner})` : inner}[]`;
	}
	if (s.additionalProperties) return `Record<string, ${ty(s.additionalProperties)}>`;
	if (s.type === "object" && s.title) return s.title;
	if (s.type === "object") {
		const entries = Object.entries(s.properties ?? {});
		if (entries.length === 0) return "{}";
		const req = new Set(s.required ?? []);
		return `{ ${entries.map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${ty(v)}`).join(", ")} }`;
	}
	return s.type ?? "any";
}

function limit(s: S): string {
	for (const m of s.anyOf ?? []) if (m.maxLength !== undefined || m.minLength !== undefined) return limit(m);
	if (s.minLength !== undefined && s.maxLength !== undefined) return `${s.minLength}-${s.maxLength} chars`;
	if (s.maxLength !== undefined) return `<= ${s.maxLength} chars`;
	if (s.minLength !== undefined) return `>= ${s.minLength} chars`;
	return "";
}

/** A value's meaning: its own description, or its non-null member's. */
const describe = (s: S): string => s.description ?? s.anyOf?.map((m) => m.description).find(Boolean) ?? "";

function fields(schema: S, withLimit: boolean): string[] {
	const props = Object.entries(schema.properties ?? {});
	if (props.length === 0) return ["No fields.", ""];
	const req = new Set(schema.required ?? []);
	const head = withLimit ? ["| Field | Type | Required | Limit | |", "|---|---|---|---|---|"] : ["| Field | Type | Required | |", "|---|---|---|---|"];
	const rows = props.map(([k, v]) => {
		const base = `\`${k}\` | \`${cell(ty(v))}\` | ${req.has(k) ? "yes" : "no"}`;
		return withLimit ? `| ${base} | ${limit(v)} | ${cell(describe(v))} |` : `| ${base} | ${cell(describe(v))} |`;
	});
	return [...head, ...rows, ""];
}

const KINDS: [keyof Policy, string][] = [
	["person", "Person"],
	["concierge", "Concierge"],
	["session", "Session"],
	["unregistered", "Unregistered agent"],
];

/** "Callers: ..." from a row of the callers table (GLOSSARY.md: Caller). */
function who(key: PolicyKey): string {
	const p = POLICY[key];
	const ok: string[] = [];
	const no: string[] = [];
	for (const [k, label] of KINDS) {
		const rule = p[k];
		if (typeof rule === "object" && "job" in rule) {
			const forms = [
				["background", rule.job],
				["foreground", rule.fg],
			] as const;
			const yes = forms.filter(([, r]) => r === "allow").map(([f]) => f);
			const refused = forms.flatMap(([, r]) => (r === "allow" ? [] : [r.code]));
			if (yes.length === 2) ok.push(label);
			else {
				if (yes.length === 1) ok.push(`${label} (${yes[0]} only)`);
				if (refused.length) no.push(`${label} (\`${[...new Set(refused)].join("`, `")}\`)`);
			}
		} else if (rule === "allow") ok.push(label);
		else no.push(`${label} (\`${rule.code}\`)`);
	}
	return `Callers: ${ok.join(", ") || "none"}. Refused: ${no.join(", ") || "none"}.`;
}

function opSection(op: string): string[] {
	const a = ArgSchemas[op as keyof typeof ArgSchemas] as unknown as S;
	const r = ResultSchemas[op as keyof typeof ResultSchemas] as unknown as S;
	const out: string[] = [`### \`${op}\``, ""];
	const key = UNION_KEY[op];
	if (!key) {
		if (a.description) out.push(a.description, "");
		out.push(who(op as PolicyKey), "", "Args:", "");
		out.push(...(SHARED.has(a) ? [`\`${SHARED.get(a)}\` (see shared shapes).`, ""] : fields(a, true)));
	} else {
		out.push(who(op as PolicyKey), "", `Args: one of these, by \`${key}\`.`, "");
		for (const m of a.anyOf!) {
			const disc = m.properties![key];
			out.push(`#### \`${op}\` ${key} ${ty(disc).replace(/ \| /g, " or ")}`, "");
			if (m.description) out.push(m.description, "");
			if (disc.const !== undefined && (op === "task" || op === "concierge-order")) out.push(who(`${op}.${String(disc.const)}` as PolicyKey), "");
			out.push(...fields(m, true));
		}
	}
	out.push("Result:", "");
	out.push(...(SHARED.has(r) ? [`\`${SHARED.get(r)}\` (see shared shapes).`, ""] : fields(r, false)));
	return out;
}

export function renderOpReference(): string {
	const out: string[] = [];
	out.push("Generated from `lib/protocol-schema.ts`, `lib/callers.ts` and `lib/protocol.ts` by `npm run docs:protocol`; do not edit between the markers.", "");
	out.push(
		`Protocol version ${PROTOCOL_VERSION}. Types: \`string\`, \`number\`, \`integer\`, \`boolean\`, \`null\`, \`T[]\`, \`Record<string, T>\`, \`{ field?: T }\` (\`?\`: optional), a quoted value. A type named after another module's interface (\`BoardTask\`, \`RoostEvent\`, \`ConciergeStatus\`, \`StandingOrder\`, \`UsageInfo\`, \`PrInfo\`) is described there. A limit is what the daemon does with the value today: some are refused (\`bad_request\`, \`too_long\`), some cut.`,
		"",
	);
	out.push("### Capabilities", "");
	out.push("Daemon (`hello` answers with these, in this order):", "", "| Capability | |", "|---|---|");
	for (const c of DAEMON_CAPABILITIES) out.push(`| \`${c}\` | ${cell(DAEMON_CAPABILITY_DOC[c])} |`);
	out.push("", "Agent (named in the agent's `hello`):", "", "| Capability | The agent ... |", "|---|---|");
	for (const c of AGENT_CAPABILITIES) out.push(`| \`${c}\` | ${cell(AGENT_CAPABILITY_DOC[c])} |`);
	out.push("");
	out.push("### Shared shapes", "");
	for (const [schema, name] of SHARED) {
		const s = schema as S;
		out.push(`#### \`${name}\``, "");
		if (s.description) out.push(s.description, "");
		out.push(...fields(s, true));
	}
	out.push("### Ops", "");
	for (const op of OPS) out.push(...opSection(op));
	return out.join("\n").replace(/\n+$/, "\n");
}

export function spliceDoc(doc: string, section: string): string {
	const a = doc.indexOf(START);
	const b = doc.indexOf(END);
	if (a < 0 || b < a) throw new Error(`docs/protocol.md has no ${START} ... ${END} markers`);
	return `${doc.slice(0, a + START.length)}\n\n${section}\n${doc.slice(b)}`;
}

if (import.meta.main) {
	const doc = readFileSync(DOC_PATH, "utf8");
	const next = spliceDoc(doc, renderOpReference());
	if (next !== doc) writeFileSync(DOC_PATH, next);
	console.log(next === doc ? "docs/protocol.md is up to date" : "docs/protocol.md updated");
}
