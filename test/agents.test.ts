import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDef, agentArgs, discoverAgents, parseFrontmatter, pickAgent, readAgent } from "../lib/agents.ts";
import { buildLaunch } from "../lib/dispatch.ts";
import { matches, parseFilter } from "../lib/filter.ts";

const md = (dir: string, file: string, text: string) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), text);
	return join(dir, file);
};

describe("M18: agent definitions (pi-subagents files)", () => {
	it("reads frontmatter: scalars, quoted values, lists in both forms", () => {
		const fm = parseFrontmatter("---\nname: scout\ndescription: \"Finds things\"\n# a comment\ntools:\n  - read\n  - grep\nmodel: 'a/b'\n---\nYou scout.\n")!;
		expect(fm.data).toEqual({ name: "scout", description: "Finds things", tools: ["read", "grep"], model: "a/b" });
		expect(fm.body).toBe("You scout.");
		expect(parseFrontmatter("no frontmatter")).toBeUndefined();
	});

	it("keeps pi agents only; replace is the default prompt mode", () => {
		const d = mkdtempSync(join(tmpdir(), "roost-agents-"));
		const a = readAgent(md(d, "a.md", "---\ndescription: d\nname: scout\ntools: [read, bash]\nthinking: low\n---\nScout.\n"))!;
		expect(a).toMatchObject({ name: "scout", tools: ["read", "bash"], thinking: "low", systemPromptMode: "replace", prompt: "Scout." });
		expect(readAgent(md(d, "b.md", "---\ndescription: d\nname: codex\nrunner: codex\n---\nx"))).toBeUndefined();
		expect(readAgent(md(d, "c.md", "---\ndescription: d\nname: off\ndisabled: true\n---\nx"))).toBeUndefined();
		expect(readAgent(md(d, "d.md", "---\ndescription: d\nname: bad name!\n---\nx"))).toBeUndefined();
		expect(readAgent(join(d, "missing.md"))).toBeUndefined();
	});

	it("finds builtins, packages, the user's and the project's; the nearest wins", () => {
		const home = mkdtempSync(join(tmpdir(), "roost-home-"));
		const nm = join(home, "npm", "node_modules");
		md(join(nm, "pi-subagents", "agents"), "scout.md", "---\nname: scout\ndescription: builtin\n---\nB");
		writeFileSync(join(nm, "pi-subagents", "package.json"), "{}");
		mkdirSync(join(nm, "@me", "pack", "defs"), { recursive: true });
		writeFileSync(join(nm, "@me", "pack", "package.json"), JSON.stringify({ "pi-subagents": { agents: ["defs"] } }));
		md(join(nm, "@me", "pack", "defs"), "planner.md", "---\ndescription: d\nname: planner\n---\nP");
		md(join(home, "agents", "nested"), "scout.md", "---\nname: scout\ndescription: user\n---\nU");
		md(join(home, "agents"), "flow.chain.md", "---\ndescription: d\nname: flow\n---\nC");
		const repo = mkdtempSync(join(tmpdir(), "roost-repo-"));
		mkdirSync(join(repo, ".git"));
		md(join(repo, ".pi", "agents"), "scout.md", "---\nname: scout\ndescription: project\n---\nR");
		md(join(repo, ".agents"), "legacy.md", "---\ndescription: d\nname: legacy\n---\nL");
		mkdirSync(join(repo, "sub"));
		const found = discoverAgents(join(repo, "sub"), { PI_CODING_AGENT_DIR: home, HOME: home });
		expect([...found.keys()].sort()).toEqual(["legacy", "planner", "scout"]);
		expect(found.get("scout")!.description).toBe("project");
		expect(discoverAgents(tmpdir(), { PI_CODING_AGENT_DIR: home, HOME: home }).get("scout")!.description).toBe("user");
	});

	it("picks an agent by first word, alias or @name followed by a task; a project's needs @", () => {
		const reviewer = { name: "reviewer", aliases: ["rv"], systemPromptMode: "replace" as const, prompt: "", file: "/r.md", source: "user" as const };
		const fix = { name: "fix", systemPromptMode: "replace" as const, prompt: "", file: "/f.md", source: "project" as const };
		const agents = new Map<string, AgentDef>([["reviewer", reviewer], ["fix", fix]]);
		const pick = (t: string) => {
			const p = pickAgent(t, agents);
			return p && { agent: p.agent.name, task: p.task };
		};
		expect(pick("reviewer check it")).toEqual({ agent: "reviewer", task: "check it" });
		expect(pick("@reviewer check it")).toEqual({ agent: "reviewer", task: "check it" });
		expect(pick("rv check it")).toEqual({ agent: "reviewer", task: "check it" });
		expect(pick("reviewer")).toBeUndefined();
		expect(pick("review check it")).toBeUndefined();
		// it came with the repository: a first word that happens to be its name is just a word
		expect(pick("fix the bug")).toBeUndefined();
		expect(pick("@fix the bug")).toEqual({ agent: "fix", task: "the bug" });
	});

	it("outside a repository only the cwd's own folders are a project's; home never is", () => {
		const home = mkdtempSync(join(tmpdir(), "roost-home-"));
		md(join(home, ".agents"), "mine.md", "---\nname: mine\ndescription: d\n---\nM");
		md(join(home, ".pi", "agents"), "homeproj.md", "---\nname: homeproj\ndescription: d\n---\nH");
		const outer = mkdtempSync(join(tmpdir(), "roost-outer-"));
		md(join(outer, ".pi", "agents"), "above.md", "---\nname: above\ndescription: d\n---\nA");
		mkdirSync(join(outer, "inner"));
		md(join(outer, "inner", ".pi", "agents"), "here.md", "---\nname: here\ndescription: d\n---\nH");
		const env = { PI_CODING_AGENT_DIR: join(home, "pi"), HOME: home };
		const found = discoverAgents(join(outer, "inner"), env);
		expect([...found.keys()].sort()).toEqual(["here", "mine"]);
		expect(found.get("mine")!.source).toBe("user");
		expect(found.get("here")!.source).toBe("project");
		expect(discoverAgents(home, env).has("homeproj")).toBe(false);
	});

	it("turns the frontmatter into pi flags; roost tools stay on", () => {
		const base = { name: "x", systemPromptMode: "replace" as const, prompt: "P", file: "/x.md" };
		expect(agentArgs({ ...base, model: "a/b", thinking: "high", tools: ["read"] })).toEqual(["--model", "a/b", "--thinking", "high", "--tools", "read,roost_*", "--system-prompt", "P"]);
		expect(agentArgs({ ...base, systemPromptMode: "append" })).toEqual(["--append-system-prompt", "P"]);
		expect(agentArgs({ ...base, prompt: "" })).toEqual([]);
		// modifiers keep the defaults (roost tools among them); excludes never drop roost tools
		expect(agentArgs({ ...base, prompt: "", tools: ["+codemode", "-write"], excludeTools: ["bash", "roost_send"] })).toEqual(["--tools", "+codemode,-write", "--exclude-tools", "bash"]);
	});

	it("buildLaunch: the agent's model over the pi's own; an explicit choice still wins", () => {
		const agent = { name: "scout", model: "s/m", thinking: "low", systemPromptMode: "replace" as const, prompt: "Scout.", file: "/s.md" };
		const input = { task: "go", cwd: "/w", sessionFile: "/s.jsonl", name: "x", origin: "dispatch" as const, argv: ["node", "/pi.js", "--model", "a/x", "--thinking=high"], execPath: "node", env: {}, agent };
		const l = buildLaunch(input);
		expect(l.command.slice(2)).toEqual(["--session", "/s.jsonl", "--model", "s/m", "--thinking", "low", "--system-prompt", "Scout.", "--", "go"]);
		expect(l).toMatchObject({ agent: "scout", model: "s/m", thinking: "low" });
		const chosen = buildLaunch({ ...input, model: "c/d" });
		expect(chosen.command.filter((a) => a.includes("/m") || a === "c/d")).toEqual(["c/d"]);
		expect(chosen).toMatchObject({ model: "c/d", thinking: "low" });
		// --bg: what the user typed on the command line wins over the agent
		const bg = buildLaunch({ ...input, origin: "bg" });
		expect(bg.command.slice(2)).toEqual(["--session", "/s.jsonl", "--model", "a/x", "--thinking=high", "--system-prompt", "Scout.", "--", "go"]);
		expect(bg).not.toHaveProperty("model");
	});

	it("a: filters by agent", () => {
		const f = parseFilter("a:Scout")!;
		expect(matches({ agent: "scout", name: "n", state: "working", summary: null, question: null, error: null } as never, f)).toBe(true);
		expect(matches({ name: "n", state: "working", summary: null, question: null, error: null } as never, f)).toBe(false);
	});
});
