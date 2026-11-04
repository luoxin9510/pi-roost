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
	excludeTools?: string[];
	aliases?: string[];
	/** Where it was found: a project's agents are picked by `@name` only (they come with the repository). */
	source?: "builtin" | "package" | "user" | "project";
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
	// pi-subagents needs a description too
	if (typeof d.description !== "string" || !d.description.trim()) return undefined;
	const str = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : undefined);
	return {
		name,
		...(str("description") ? { description: str("description") } : {}),
		...(str("model") ? { model: str("model") } : {}),
		...(str("thinking") ? { thinking: str("thinking") } : {}),
		...(list(d.tools) ? { tools: list(d.tools) } : {}),
		...(list(d.excludeTools) ? { excludeTools: list(d.excludeTools) } : {}),
		...(list(d.aliases)?.filter((a) => NAME.test(a)).length ? { aliases: list(d.aliases)!.filter((a) => NAME.test(a)) } : {}),
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

/** pi-subagents' builtins and the agent folders installed packages declare (`pi-subagents.agents` / `pi.subagents.agents`). */
function packageAgentDirs(root: string): { builtin: string[]; packages: string[] } {
	const nm = join(root, "npm", "node_modules");
	const out = { builtin: [] as string[], packages: [] as string[] };
	const names: string[] = [];
	const ls = (d: string) => {
		try {
			return readdirSync(d).sort();
		} catch {
			return [];
		}
	};
	for (const n of ls(nm)) {
		if (n.startsWith("@")) for (const m of ls(join(nm, n))) names.push(`${n}/${m}`);
		else names.push(n);
	}
	for (const n of names) {
		const pkgDir = join(nm, n);
		if (n === "pi-subagents") out.builtin.push(join(pkgDir, "agents"));
		try {
			const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
			const decl = (pkg["pi-subagents"] as { agents?: unknown } | undefined)?.agents ?? (pkg.pi as { subagents?: { agents?: unknown } } | undefined)?.subagents?.agents;
			if (Array.isArray(decl)) for (const d of decl) if (typeof d === "string") out.packages.push(resolve(pkgDir, d));
		} catch {}
	}
	return out;
}

/**
 * Project folders from the repository root down to `cwd`, nearest last; outside a
 * repository only `cwd`'s own. The home folder is never a project (`~/.pi`, `~/.agents`
 * are the user's).
 */
function projectDirs(cwd: string, home: string): string[] {
	const chain: string[] = [];
	let d = resolve(cwd);
	let root: string | undefined;
	for (let i = 0; i < 40; i++) {
		chain.unshift(d);
		if (existsSync(join(d, ".git"))) {
			root = d;
			break;
		}
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	const dirs = root ? chain : [resolve(cwd)];
	return dirs.filter((x) => x !== resolve(home)).flatMap((x) => [join(x, ".agents"), join(x, ".pi", "agents")]);
}

/**
 * Agents by name, as pi-subagents loads them, lowest priority first: builtins, then
 * packages (the first one with a name keeps it), then the user's
 * (`~/.pi/agent/agents`, then `~/.agents`), then the project's (`.agents`, `.pi/agents`);
 * a later one with the same name wins.
 */
export function discoverAgents(cwd: string, env: NodeJS.ProcessEnv = process.env): Map<string, AgentDef> {
	const root = agentDir(env);
	const home = env.HOME || homedir();
	const { builtin, packages } = packageAgentDirs(root);
	const out = new Map<string, AgentDef>();
	const load = (dirs: string[], source: NonNullable<AgentDef["source"]>, firstWins = false) => {
		for (const dir of dirs)
			for (const f of mdFiles(dir)) {
				const a = readAgent(f);
				if (!a || (firstWins && out.has(a.name) && out.get(a.name)!.source === source)) continue;
				out.set(a.name, { ...a, source });
			}
	};
	load(builtin, "builtin");
	load(packages, "package", true);
	load([join(root, "agents"), join(home, ".agents")], "user");
	load(projectDirs(cwd, home), "project");
	return out;
}

/** An agent by its name or one of its aliases. */
export function findAgent(agents: ReadonlyMap<string, AgentDef>, name: string): AgentDef | undefined {
	const direct = agents.get(name);
	if (direct) return direct;
	const byAlias = [...agents.values()].filter((a) => a.aliases?.includes(name));
	return byAlias.length === 1 ? byAlias[0] : undefined;
}

/**
 * pi flags that make the agent the session's main agent. pi-roost's own tools stay on
 * (`roost_*`): a child reports and talks through them.
 */
export function agentArgs(a: AgentDef, opts: { model?: boolean; thinking?: boolean } = {}): string[] {
	const args: string[] = [];
	if (a.model && opts.model !== false) args.push("--model", a.model);
	if (a.thinking && opts.thinking !== false) args.push("--thinking", a.thinking);
	if (a.tools) {
		// `+x`/`-x` change the defaults (pi-roost's tools stay on); names are an allowlist
		const modifiers = a.tools.some((t) => /^[+-]/.test(t));
		args.push("--tools", (modifiers ? a.tools : [...a.tools, "roost_*"]).join(","));
	}
	if (a.excludeTools) args.push("--exclude-tools", a.excludeTools.filter((t) => !/^roost_/.test(t)).join(","));
	if (a.prompt) args.push(a.systemPromptMode === "append" ? "--append-system-prompt" : "--system-prompt", a.prompt);
	return args;
}

/**
 * Claude Code: a first word, or `@name`, that names an agent selects it. The rest is
 * the task; a lone name is not a task. A project's agent (it came with the repository)
 * needs `@name`: a first word that happens to be its name is just a word.
 */
export function pickAgent(task: string, agents: ReadonlyMap<string, AgentDef>): { agent: AgentDef; task: string } | undefined {
	const m = /^(@?)([A-Za-z0-9][A-Za-z0-9_.-]*)\s+([\s\S]+)$/.exec(task.trim());
	if (!m) return undefined;
	const agent = findAgent(agents, m[2]!);
	if (!agent || (agent.source === "project" && !m[1])) return undefined;
	return { agent, task: m[3]!.trim() };
}
