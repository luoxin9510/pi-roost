import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildLaunch, workerEnv } from "../lib/dispatch.ts";
import { envPolicy, DEFAULTS } from "../lib/config.ts";
import { envKept, parseProbe, probeScript, workspaceEnv } from "../lib/workspace-env.ts";

const has = (cmd: string) => {
	try {
		execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

describe("M20: the shell's environment", () => {
	it("carries everything but a job's identity and the launching terminal's names; deny list; allowlist mode", () => {
		const env = { PATH: "/bin", MY_TOKEN: "t", NODE_OPTIONS: "--x", PI_JOB_ID: "j", TMUX: "/t", TERM_PROGRAM: "iTerm", PWD: "/hub", AWS_PROFILE: "p", AWS_REGION: "r", "BAD=NAME": "x" };
		expect(workerEnv(env)).toEqual({ PATH: "/bin", MY_TOKEN: "t", NODE_OPTIONS: "--x", AWS_PROFILE: "p", AWS_REGION: "r" });
		expect(workerEnv(env, { envDenyList: ["AWS_*", "MY_TOKEN"] })).toEqual({ PATH: "/bin", NODE_OPTIONS: "--x" });
		expect(workerEnv(env, { inheritEnv: false, extraEnv: ["MY_TOKEN"] })).toEqual({ PATH: "/bin", MY_TOKEN: "t" });
		expect(envKept("PI_DAEMON_SOCK")).toBe(false);
		expect(envKept("X", ["X*"])).toBe(false);
	});

	it("config: inheritEnv off turns the workspace's environment off too", () => {
		expect(envPolicy(DEFAULTS)).toMatchObject({ inheritEnv: true, workspaceEnv: "shell" });
		expect(envPolicy({ ...DEFAULTS, inheritEnv: false })).toMatchObject({ workspaceEnv: "off" });
		const l = buildLaunch({ task: "x", cwd: "/w", sessionFile: "/s", name: "x", origin: "dispatch", argv: ["n", "p"], execPath: "n", env: { A: "1" }, ...envPolicy({ ...DEFAULTS, inheritEnv: false }) });
		expect(l).not.toHaveProperty("workspaceEnv");
		expect(l.env).toEqual({});
	});

	it("reads the probe's output after its marker", () => {
		const out = Buffer.from("rc noise\nmore\n__PI_ROOST_ENV__\nA=1\0B=x=y\0\0junk\0");
		expect(parseProbe(out)).toEqual({ A: "1", B: "x=y" });
		expect(parseProbe(Buffer.from("no marker"))).toBeUndefined();
		expect(probeScript("/bin/zsh")?.args[0]).toBe("-i");
		expect(probeScript("/bin/tcsh")?.args[0]).toBe("-i");
		expect(probeScript("/usr/bin/nu")).toBeUndefined();
	});

	it.runIf(has("zsh"))("zsh: runs the cd hooks in the workspace (as direnv, fnm, mise use them); the hub's own goes", async () => {
		const zdot = mkdtempSync(join(tmpdir(), "roost-zdot-"));
		const ws = mkdtempSync(join(tmpdir(), "roost-ws-"));
		// a stand-in for `direnv hook zsh`: a precmd hook that loads the directory's env file
		writeFileSync(
			join(zdot, ".zshrc"),
			[
				"echo 'rc says hello'",
				"_ws_hook() { unset HUB_ONLY; if [[ -f .wsenv ]]; then source ./.wsenv; fi }",
				"precmd_functions+=(_ws_hook)",
				"",
			].join("\n"),
		);
		writeFileSync(join(ws, ".wsenv"), "export WS_VAR=from-workspace\nexport PATH=/ws/bin:$PATH\n");
		const base = { PATH: process.env.PATH!, HOME: zdot, ZDOTDIR: zdot, SHELL: execFileSync("sh", ["-c", "command -v zsh"]).toString().trim(), HUB_ONLY: "hub", MY_TOKEN: "t" };
		const r = await workspaceEnv(ws, base, "shell", (k) => envKept(k, ["MY_*"]));
		expect(r.via).toBe("shell");
		expect(r.env.WS_VAR).toBe("from-workspace");
		expect(r.env.PATH!.startsWith("/ws/bin:")).toBe(true);
		expect(r.env.HUB_ONLY).toBeUndefined();
		expect(r.env.MY_TOKEN).toBeUndefined();
		expect(r.env.PI_ROOST_PROBE_DIR).toBeUndefined();
		expect(r.env.ZDOTDIR).toBe(zdot);
	});

	it.runIf(has("tcsh"))(".cshrc: tcsh and csh run the cwdcmd and precmd aliases in the workspace", async () => {
		const home = mkdtempSync(join(tmpdir(), "roost-csh-"));
		const ws = mkdtempSync(join(tmpdir(), "roost-ws-"));
		writeFileSync(join(home, ".cshrc"), ["echo cshrc noise", "alias precmd 'if ( -f .wsenv ) source .wsenv; unsetenv HUB_ONLY'", "alias cwdcmd 'setenv CWD_RAN yes'", ""].join("\n"));
		writeFileSync(join(ws, ".wsenv"), "setenv WS_VAR from-ws\n");
		for (const shell of ["/bin/tcsh", "/bin/csh"]) {
			const r = await workspaceEnv(ws, { PATH: "/usr/bin:/bin", HOME: home, SHELL: shell, HUB_ONLY: "hub" }, "shell", (k) => envKept(k));
			expect(r.via, shell).toBe("shell");
			expect(r.env).toMatchObject({ WS_VAR: "from-ws", CWD_RAN: "yes" });
			expect(r.env.HUB_ONLY).toBeUndefined();
		}
	});

	it("falls back to direnv export json, then to the environment as carried", async () => {
		const bin = mkdtempSync(join(tmpdir(), "roost-bin-"));
		const ws = mkdtempSync(join(tmpdir(), "roost-ws-"));
		writeFileSync(join(bin, "direnv"), `#!/bin/sh\n[ "$1" = export ] && [ "$2" = json ] && printf '{"WS":"1","OLD":null}'\n`);
		chmodSync(join(bin, "direnv"), 0o755);
		const base = { PATH: `${bin}:/usr/bin:/bin`, SHELL: "/bin/nu-not-supported", OLD: "hub" };
		const r = await workspaceEnv(ws, base, "shell", (k) => envKept(k));
		expect(r).toEqual({ env: { PATH: base.PATH, SHELL: base.SHELL, WS: "1" }, via: "direnv" });
		expect(await workspaceEnv(ws, { PATH: "/nowhere" }, "direnv", () => true)).toEqual({ env: { PATH: "/nowhere" }, via: "none" });
		expect(await workspaceEnv(ws, base, "off", () => true)).toEqual({ env: base, via: "none" });
	});

	it("a shell rc that hangs is cut off", async () => {
		const zdot = mkdtempSync(join(tmpdir(), "roost-zdot-"));
		mkdirSync(join(zdot, "x"), { recursive: true });
		writeFileSync(join(zdot, ".zshrc"), "sleep 30\n");
		if (!has("zsh")) return;
		const t = Date.now();
		const r = await workspaceEnv(zdot, { PATH: "/usr/bin:/bin", ZDOTDIR: zdot, HOME: zdot, SHELL: "/bin/zsh" }, "shell", () => true, 300);
		expect(Date.now() - t).toBeLessThan(3000);
		expect(r.via).toBe("none");
	});
});
