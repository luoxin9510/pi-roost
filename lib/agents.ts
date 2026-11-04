// M18 (Claude Code: "`<agent-name> <prompt>`: that subagent runs as the session's main
// agent with the configuration from its frontmatter"; `@name`; `--agent`; the `a:`
// filter). Agents are pi-subagents' markdown files: YAML frontmatter, a system prompt.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface AgentDef {
	name: string;
	description?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	/** pi-subagents' default is replace: the agent's prompt is the whole system prompt. */
	systemPromptMode: "replace" | "append";
	prompt: string;
	file: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A tiny frontmatter reader: `key: value` lines and `- item` lists, which agent files use. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } | undefined {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return undefined;
	const data: Record<string, string | string[]> = {};
	let listKey: string | undefined;
	for (const raw of m[1]!.split(/\r?\n/)) {
		if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
		const item = /^\s+-\s+(.*)$/.exec(raw);
		if (item && listKey) {
			const cur = data[listKey];
			data[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1]!)];
			continue;
		}
		const kv = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(raw);
		if (!kv) {
			listKey = undefined;
			continue;
		}
		listKey = kv[2] === "" ? kv[1]! : undefined;
		if (kv[2] !== "") data[kv[1]!] = unquote(kv[2]!);
	}
	return { data, body: m[2]!.trim() };
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

const list = (v: string | string[] | undefined): string[] | undefined => {
	if (v === undefined) return undefined;
	const items = (Array.isArray(v) ? v : v.replace(/^\[|\]$/g, "").split(",")).map((s) => unquote(s)).filter(Boolean);
	return items.length > 0 ? items : undefined;
};

/** One agent file, or undefined when it is not a pi agent (another runner, disabled, malformed). */
export function readAgent(file: string): AgentDef | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const fm = parseFrontmatter(text);
	if (!fm) return undefined;
	const d = fm.data;
	const name = typeof d.name === "string" ? d.name : undefined;
	if (!name || !NAME.test(name)) return undefined;
	// a command or another CLI (codex, claude) is not a pi session
	if (Object.keys(d).some((k) => k === "runner" || k.startsWith("runner."))) return undefined;
	if (d.disabled === "true") return undefined;
	const str = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : undefined);
	return {
		name,
		...(str("description") ? { description: str("description") } : {}),
		...(str("model") ? { model: str("model") } : {}),
		...(str("thinking") ? { thinking: str("thinking") } : {}),
		...(list(d.tools) ? { tools: list(d.tools) } : {}),
		systemPromptMode: d.systemPromptMode === "append" ? "append" : "replace",
		prompt: fm.body,
		file,
	};
}

function mdFiles(dir: string, depth = 0): string[] {
	if (depth > 6 || !existsSync(dir)) return [];
	const out: string[] = [];
	let entries: string[] = [];
	try {
		entries = readdirSync(dir).sort();
	} catch {
		return [];
	}
	for (const e of entries) {
		const p = join(dir, e);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) out.push(...mdFiles(p, depth + 1));
		else if (e.endsWith(".md") && !e.endsWith(".chain.md")) out.push(p);
	}
	return out;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Agent folders that installed packages declare (`pi-subagents.agents` / `pi.subagents.agents`). */
function packageAgentDirs(root: string): string[] {
	const nm = join(root, "npm", "node_modules");
	const out: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(nm).flatMap((n) => (n.startsWith("@") ? readdirSync(join(nm, n)).map((m) => `${n}/${m}`) : [n]));
	} catch {
		return [];
	}
	for (const n of names) {
		const pkgDir = join(nm, n);
		try {
			const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
			const decl = (pkg["pi-subagents"] as { agents?: unknown } | undefined)?.agents ?? (pkg.pi as { subagents?: { agents?: unknown } } | undefined)?.subagents?.agents;
			if (Array.isArray(decl)) for (const d of decl) if (typeof d === "string") out.push(resolve(pkgDir, d));
			// pi-subagents' own builtins
			if (n === "pi-subagents") out.unshift(join(pkgDir, "agents"));
		} catch {}
	}
	return out;
}

/** Project folders from `cwd` up to the repository (or filesystem) root, nearest last. */
function projectDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let d = resolve(cwd);
	for (let i = 0; i < 20; i++) {
		dirs.unshift(join(d, ".agents"), join(d, ".pi", "agents"));
		if (existsSync(join(d, ".git"))) break;
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return dirs;
}

/**
 * Agents by name, lowest priority first as pi-subagents loads them: builtins and
 * packages, then the user's (`~/.pi/agent/agents`), then the project's (`.pi/agents`,
 * legacy `.agents`); a later one with the same name wins.
 */
export function discoverAgents(cwd: string, env: NodeJS.ProcessEnv = process.env): Map<string, AgentDef> {
	const root = agentDir(env);
	const dirs = [...packageAgentDirs(root), join(root, "agents"), ...projectDirs(cwd)];
	const out = new Map<string, AgentDef>();
	for (const dir of dirs) for (const f of mdFiles(dir)) {
		const a = readAgent(f);
		if (a) out.set(a.name, a);
	}
	return out;
}

/**
 * pi flags that make the agent the session's main agent. pi-roost's own tools stay on
 * (`roost_*`): a child reports and talks through them.
 */
export function agentArgs(a: AgentDef, opts: { model?: boolean } = {}): string[] {
	const args: string[] = [];
	if (a.model && opts.model !== false) args.push("--model", a.model);
	if (a.thinking) args.push("--thinking", a.thinking);
	if (a.tools) args.push("--tools", [...a.tools, "roost_*"].join(","));
	if (a.prompt) args.push(a.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", a.prompt);
	return args;
}

/**
 * Claude Code: a first word, or `@name`, that names an agent selects it. The rest is
 * the task; a lone name is not a task.
 */
export function pickAgent(task: string, names: ReadonlySet<string>): { agent: string; task: string } | undefined {
	const m = /^@?([A-Za-z0-9][A-Za-z0-9_.-]*)\s+([\s\S]+)$/.exec(task.trim());
	if (!m || !names.has(m[1]!)) return undefined;
	return { agent: m[1]!, task: m[2]!.trim() };
}
