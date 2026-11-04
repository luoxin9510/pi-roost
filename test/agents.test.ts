import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentArgs, discoverAgents, parseFrontmatter, pickAgent, readAgent } from "../lib/agents.ts";
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
		const a = readAgent(md(d, "a.md", "---\nname: scout\ntools: [read, bash]\nthinking: low\n---\nScout.\n"))!;
		expect(a).toMatchObject({ name: "scout", tools: ["read", "bash"], thinking: "low", systemPromptMode: "replace", prompt: "Scout." });
		expect(readAgent(md(d, "b.md", "---\nname: codex\nrunner: codex\n---\nx"))).toBeUndefined();
		expect(readAgent(md(d, "c.md", "---\nname: off\ndisabled: true\n---\nx"))).toBeUndefined();
		expect(readAgent(md(d, "d.md", "---\nname: bad name!\n---\nx"))).toBeUndefined();
		expect(readAgent(join(d, "missing.md"))).toBeUndefined();
	});

	it("finds builtins, packages, the user's and the project's; the nearest wins", () => {
		const home = mkdtempSync(join(tmpdir(), "roost-home-"));
		const nm = join(home, "npm", "node_modules");
		md(join(nm, "pi-subagents", "agents"), "scout.md", "---\nname: scout\ndescription: builtin\n---\nB");
		writeFileSync(join(nm, "pi-subagents", "package.json"), "{}");
		mkdirSync(join(nm, "@me", "pack", "defs"), { recursive: true });
		writeFileSync(join(nm, "@me", "pack", "package.json"), JSON.stringify({ "pi-subagents": { agents: ["defs"] } }));
		md(join(nm, "@me", "pack", "defs"), "planner.md", "---\nname: planner\n---\nP");
		md(join(home, "agents", "nested"), "scout.md", "---\nname: scout\ndescription: user\n---\nU");
		md(join(home, "agents"), "flow.chain.md", "---\nname: flow\n---\nC");
		const repo = mkdtempSync(join(tmpdir(), "roost-repo-"));
		mkdirSync(join(repo, ".git"));
		md(join(repo, ".pi", "agents"), "scout.md", "---\nname: scout\ndescription: project\n---\nR");
		md(join(repo, ".agents"), "legacy.md", "---\nname: legacy\n---\nL");
		mkdirSync(join(repo, "sub"));
		const found = discoverAgents(join(repo, "sub"), { PI_CODING_AGENT_DIR: home });
		expect([...found.keys()].sort()).toEqual(["legacy", "planner", "scout"]);
		expect(found.get("scout")!.description).toBe("project");
		expect(discoverAgents(tmpdir(), { PI_CODING_AGENT_DIR: home }).get("scout")!.description).toBe("user");
	});

	it("picks an agent by first word or @name followed by a task", () => {
		const names = new Set(["reviewer"]);
		expect(pickAgent("reviewer check it", names)).toEqual({ agent: "reviewer", task: "check it" });
		expect(pickAgent("@reviewer check it", names)).toEqual({ agent: "reviewer", task: "check it" });
		expect(pickAgent("reviewer", names)).toBeUndefined();
		expect(pickAgent("review check it", names)).toBeUndefined();
	});

	it("turns the frontmatter into pi flags; roost tools stay on", () => {
		const base = { name: "x", systemPromptMode: "replace" as const, prompt: "P", file: "/x.md" };
		expect(agentArgs({ ...base, model: "a/b", thinking: "high", tools: ["read"] })).toEqual(["--model", "a/b", "--thinking", "high", "--tools", "read,roost_*", "--system-prompt", "P"]);
		expect(agentArgs({ ...base, systemPromptMode: "append" })).toEqual(["--append-system-prompt", "P"]);
		expect(agentArgs({ ...base, prompt: "" })).toEqual([]);
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
	});

	it("a: filters by agent", () => {
		const f = parseFilter("a:Scout")!;
		expect(matches({ agent: "scout", name: "n", state: "working", summary: null, question: null, error: null } as never, f)).toBe(true);
		expect(matches({ name: "n", state: "working", summary: null, question: null, error: null } as never, f)).toBe(false);
	});
});
