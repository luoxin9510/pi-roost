import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, presetFrom } from "../lib/config.ts";
import { buildProfileLaunch } from "../lib/dispatch.ts";
import { profileCommand, profileFrom, profileResume, profilesFrom, profileTerm, termFrom } from "../lib/profiles.ts";
import { inferTermState, TermSignalCollector, type TermSignals } from "../lib/term-signals.ts";

describe("M30 agent profiles", () => {
	it("takes argv templates only, with sane defaults; anything malformed is not a profile", () => {
		expect(profileFrom({ command: ["codex"] })).toEqual({ command: ["codex"], task: "argv" });
		expect(profileFrom({ command: "codex --yolo" })).toBeUndefined(); // a shell line is not an argv
		expect(profileFrom({ command: [] })).toBeUndefined();
		expect(profileFrom({ command: [""] })).toBeUndefined();
		expect(profileFrom({ command: ["a"], task: "later" })).toBeUndefined();
		expect(profileFrom({ command: ["a"], waiting: "(unclosed" })).toBeUndefined();
		expect(profileFrom({ command: ["a"], settleMs: 10 })).toBeUndefined();
		expect(profileFrom({ command: ["a"], resume: null })).toEqual({ command: ["a"], task: "argv", resume: null });
		expect(profileFrom({ command: ["a"], env: { GOOD: "1", "bad name": "2", N: 3 } })?.env).toEqual({ GOOD: "1" });
	});

	it("keeps roost's own names for itself", () => {
		const p = { command: ["x"] };
		expect(Object.keys(profilesFrom({ pi: p, shell: p, off: p, codex: p, "../x": p }) ?? {})).toEqual(["codex"]);
	});

	it("placeholders replace whole elements: no shell, no partial substitution", () => {
		const p = profileFrom({ command: ["agent", "--quiet"], model: ["--model", "{model}"], thinking: ["-r", "{thinking}"], resume: ["agent", "resume", "--last"] })!;
		expect(profileCommand(p, { task: "fix it; rm -rf /", model: "o3", thinking: "high" })).toEqual(["agent", "--quiet", "--model", "o3", "-r", "high", "fix it; rm -rf /"]);
		expect(profileCommand(p, { task: "t" })).toEqual(["agent", "--quiet", "t"]);
		// a command that places a value itself gets it there, once
		const q = profileFrom({ command: ["agent", "{task}", "--m={model}", "{model}"], model: ["-m", "{model}"] })!;
		expect(profileCommand(q, { task: "t", model: "m1" })).toEqual(["agent", "t", "--m={model}", "m1"]);
		expect(profileCommand(q, {})).toEqual(["agent", "--m={model}"]);
		expect(profileCommand(profileFrom({ command: ["a"], task: "type" })!, { task: "t" })).toEqual(["a"]);
		expect(profileResume(p, {})).toEqual(["agent", "resume", "--last"]);
		expect(profileResume(profileFrom({ command: ["a"], resume: null })!, {})).toBeUndefined();
	});

	it("a typed task waits in the term settings; stored ones are checked again", () => {
		expect(profileTerm(profileFrom({ command: ["a"], task: "type", submit: "\n" })!, "hi")).toEqual({ submit: "\n", settleMs: 3000, typeTask: "hi" });
		expect(profileTerm(profileFrom({ command: ["a"] })!, "hi")).toEqual({ submit: "\r", settleMs: 3000 });
		expect(termFrom({ submit: "x".repeat(40), settleMs: 5, waiting: "(" })).toEqual({ submit: "\r", settleMs: 3000 });
	});

	it("builds a shell-kind launch whose environment goes through the deny list, profile env included", () => {
		const def = profileFrom({ command: ["agent"], model: ["--model", "{model}"], env: { AGENT_MODE: "fast", SECRET_TOKEN: "x" } })!;
		const l = buildProfileLaunch({ name: "n", profile: "codex", def, task: "do it", cwd: "/w", env: { PATH: "/bin", SECRET_KEY: "k" }, envDenyList: ["SECRET_*"], model: "o3" });
		expect(l).toMatchObject({ kind: "shell", profile: "codex", sessionFile: "", command: ["agent", "--model", "o3", "do it"], model: "o3", taskInArgv: true, term: { submit: "\r" } });
		expect(l.env).toEqual({ PATH: "/bin", AGENT_MODE: "fast" });
		expect(l.thinking).toBeUndefined(); // the profile takes no thinking level
		// starting again: its command without the first task (no resume argv)
		expect(l.resumeCommand).toEqual(["agent", "--model", "o3"]);
		expect(presetFrom({ profile: "codex", model: "--danger" })).toEqual({ profile: "codex" });
		// M31: an agent that speaks the protocol
		const proto = profileFrom({ command: ["my-agent"], protocol: true, task: "type" })!;
		expect(proto.protocol).toBe(true);
		expect(profileFrom({ command: ["a"], protocol: "yes" })).toBeUndefined();
		// M61: declared slash commands
		expect(profileFrom({ command: ["a"], commands: [{ name: "init", description: "set up" }, { name: "help" }] })!.commands).toEqual([{ name: "init", description: "set up" }, { name: "help" }]);
		for (const commands of ["x", [{ name: "/x" }], [{ name: "a b" }], [{ description: "d" }], [{ name: "a", description: 5 }], Array.from({ length: 101 }, (_, i) => ({ name: `c${i}` }))]) {
			expect(profileFrom({ command: ["a"], commands })).toBeUndefined();
		}
		expect(buildProfileLaunch({ name: "n", profile: "mine", def: proto, task: "go", cwd: "/w", env: {} })).toMatchObject({ protocol: true, command: ["my-agent"], term: { typeTask: "go" } });
	});
});

describe("M30 profiles in roost.json", () => {
	let home: string;
	let project: string;
	const saved = process.env.PI_ROOST_CONFIG_DIR;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "prof-h-"));
		project = mkdtempSync(join(tmpdir(), "prof-p-"));
		process.env.PI_ROOST_CONFIG_DIR = home;
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
		if (saved === undefined) delete process.env.PI_ROOST_CONFIG_DIR;
		else process.env.PI_ROOST_CONFIG_DIR = saved;
	});

	it("are the user's only: a project's file cannot define one", () => {
		writeFileSync(join(home, "roost.json"), JSON.stringify({ agentProfiles: { mine: { command: ["mine"] } } }));
		mkdirSync(join(project, ".pi"));
		writeFileSync(join(project, ".pi", "roost.json"), JSON.stringify({ agentProfiles: { evil: { command: ["curl", "evil"] } } }));
		expect(Object.keys(loadConfig(project).agentProfiles ?? {})).toEqual(["mine"]);
	});

	it("a preset may name a profile, and then a model in the agent's own form", () => {
		expect(presetFrom({ profile: "codex", model: "o3" })).toEqual({ profile: "codex", model: "o3" });
		expect(presetFrom({ model: "o3" })).toEqual({});
		expect(presetFrom({ profile: "pi", model: "o3" })).toEqual({ profile: "pi" });
		expect(presetFrom({ profile: "shell" })).toEqual({});
	});
});

describe("M30 terminal signals", () => {
	const write = (t: InstanceType<typeof xterm.Terminal>, s: string) => new Promise<void>((r) => t.write(s, r));

	it("collects titles, notifications, bells, prompt marks and the alternate screen", async () => {
		const term = new xterm.Terminal({ cols: 80, rows: 10, allowProposedApi: true });
		let changes = 0;
		const c = new TermSignalCollector(term, () => changes++, 0);
		await write(term, "\x1b]2;  my   agent \x07");
		expect(c.signals().title).toBe("my agent");
		await write(term, "\x1b]9;4;1;50\x07"); // a progress report, not a notification
		expect(c.signals().notify).toBeUndefined();
		await write(term, "\x1b]9;needs you\x07");
		expect(c.signals().notify?.text).toBe("needs you");
		await write(term, "\x1b]777;notify;Agent;done here\x07");
		expect(c.signals().notify?.text).toBe("Agent: done here");
		await write(term, "\x07");
		expect(c.signals().bellAt).toBeGreaterThan(0);
		await write(term, "\x1b]133;C\x07");
		expect(c.signals().prompt).toBe("busy");
		await write(term, "\x1b]133;A\x07");
		expect(c.signals().prompt).toBe("idle");
		expect(changes).toBeGreaterThanOrEqual(6);
		expect(c.screen("a", 5)).toBe(true);
		expect(c.screen("a", 9)).toBe(false);
		expect(c.signals().changedAt).toBe(5);
		await write(term, "\x1b[?1049h");
		expect(c.screen("a", 12)).toBe(true);
		expect(c.signals().alt).toBe(true);
		term.dispose();
	});

	const sig = (o: Partial<TermSignals> = {}): TermSignals => ({ alt: false, changedAt: 0, at: 0, ...o });
	const term = profileTerm(profileFrom({ command: ["a"], waiting: "proceed\\? \\(y/n\\)", working: "esc to interrupt", settleMs: 1000 })!);

	it("decides the row from the strongest signal down", () => {
		const at = { inputAt: 0, typed: true };
		// moving: working; quiet: idle
		expect(inferTermState(sig({ changedAt: 9_500 }), "out\nlast line\n", term, { now: 10_000, ...at })).toMatchObject({ state: "working", status: "busy", summary: "last line" });
		expect(inferTermState(sig(), "out\nlast line\n", term, { now: 10_000, ...at })).toMatchObject({ state: "done", status: "idle", quiet: true });
		// the profile's regexes win over quiet; working over waiting
		expect(inferTermState(sig(), "Do you want to proceed? (y/n)\n", term, { now: 10_000, ...at })).toMatchObject({ state: "blocked", waitingFor: "dialog", question: "Do you want to proceed? (y/n)" });
		expect(inferTermState(sig(), "proceed? (y/n)\n(esc to interrupt)\n", term, { now: 10_000, ...at })).toMatchObject({ state: "working" });
		// a notification after the last input, once quiet, asks; one from before does not
		expect(inferTermState(sig({ notify: { text: "pick one", at: 5 } }), "x", term, { now: 10_000, inputAt: 1, typed: true })).toMatchObject({ state: "blocked", waitingFor: "question", question: "pick one" });
		expect(inferTermState(sig({ notify: { text: "old", at: 5 } }), "x", term, { now: 10_000, inputAt: 9, typed: true })).toMatchObject({ state: "done" });
		expect(inferTermState(sig({ bellAt: 5 }), "x", term, { now: 10_000, inputAt: 1, typed: true })).toMatchObject({ state: "blocked", question: null });
		// OSC 133: a command running is work even on a still screen
		expect(inferTermState(sig({ prompt: "busy", promptAt: 5 }), "x", term, { now: 10_000, inputAt: 1, typed: true })).toMatchObject({ state: "working" });
		// nothing given yet: it waits for a first prompt
		expect(inferTermState(sig(), "x", term, { now: 10_000, inputAt: 0, typed: false })).toMatchObject({ state: "blocked", waitingFor: "first-prompt" });
		// the title is the row text; a full-screen agent without one shows none
		expect(inferTermState(sig({ title: "T" }), "x", term, { now: 10_000, ...at }).summary).toBe("T");
		expect(inferTermState(sig({ alt: true }), "x", term, { now: 10_000, ...at }).summary).toBeNull();
		// just typed into: not quiet yet
		expect(inferTermState(sig(), "x", term, { now: 10_000, inputAt: 9_600, typed: true })).toMatchObject({ state: "working" });
	});
});
