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
		expect(envKept("GPG_TTY")).toBe(false);
		expect(envKept("VSCODE_GIT_IPC_HANDLE")).toBe(false);
		// envAllowList names pass the deny list
		expect(workerEnv({ AWS_PROFILE: "p", AWS_X: "x" }, { envDenyList: ["AWS_*"], extraEnv: ["AWS_PROFILE"] })).toEqual({ AWS_PROFILE: "p" });
	});

	it("config: inheritEnv off turns the workspace's environment off too", () => {
		expect(envPolicy(DEFAULTS)).toMatchObject({ inheritEnv: true, workspaceEnv: "shell" });
		expect(envPolicy({ ...DEFAULTS, inheritEnv: false })).toMatchObject({ workspaceEnv: "off" });
		const l = buildLaunch({ task: "x", cwd: "/w", sessionFile: "/s", name: "x", origin: "dispatch", argv: ["n", "p"], execPath: "n", env: { A: "1" }, ...envPolicy({ ...DEFAULTS, inheritEnv: false }) });
		expect(l).not.toHaveProperty("workspaceEnv");
		expect(l.env).toEqual({});
		// envAllowList names pass the deny list at the host too
		const f = buildLaunch({ task: "x", cwd: "/w", sessionFile: "/s", name: "x", origin: "dispatch", argv: ["n", "p"], execPath: "n", env: { PI_MOBILE_X: "1" }, ...envPolicy({ ...DEFAULTS, envDenyList: ["PI_MOBILE_*"], envAllowList: ["PI_MOBILE_X"] }) });
		expect(f).toMatchObject({ env: { PI_MOBILE_X: "1" }, envDeny: ["PI_MOBILE_*"], envForce: ["PI_MOBILE_X"] });
	});

	it("reads the probe's output after its marker", () => {
		const out = Buffer.from("rc noise\nmore\n__PI_ROOST_ENV__\nA=1\0B=x=y\0\0junk\0__PI_ROOST_END__\n");
		expect(parseProbe(out)).toEqual({ A: "1", B: "x=y" });
		// cut short: not taken
		expect(parseProbe(Buffer.from("__PI_ROOST_ENV__\nA=1\0B=half"))).toBeUndefined();
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

	it.runIf(has("zsh"))("rc files that stop for dumb terminals, exit hooks that fail, background children, names a shell cannot hold", async () => {
		const zdot = mkdtempSync(join(tmpdir(), "roost-zdot-"));
		const ws = mkdtempSync(join(tmpdir(), "roost-ws-"));
		writeFileSync(
			join(zdot, ".zshrc"),
			['[[ $TERM == dumb ]] && return', "_h() { export HOOKED=yes }", "precmd_functions+=(_h)", "(sleep 30 &)", "zshexit() { return 3 }", ""].join("\n"),
		);
		const zsh = execFileSync("sh", ["-c", "command -v zsh"]).toString().trim();
		const t = Date.now();
		const r = await workspaceEnv(ws, { PATH: process.env.PATH!, HOME: zdot, ZDOTDIR: zdot, SHELL: zsh, "FOO-BAR": "1" }, "shell", (k) => envKept(k), 6000);
		expect(Date.now() - t).toBeLessThan(3000);
		expect(r.via).toBe("shell");
		expect(r.env.HOOKED).toBe("yes");
		expect(r.env["FOO-BAR"]).toBe("1");
	});

	it.runIf(has("bash"))("bash: every PROMPT_COMMAND entry, as a string or an array", async () => {
		const home = mkdtempSync(join(tmpdir(), "roost-bash-"));
		const ws = mkdtempSync(join(tmpdir(), "roost-ws-"));
		const bash = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();
		const major = Number(execFileSync(bash, ["-c", "echo ${BASH_VERSINFO[0]}"]).toString());
		writeFileSync(join(home, ".bashrc"), major >= 5 ? "a_h() { export A=1; }\nb_h() { export B=1; }\nPROMPT_COMMAND=(a_h b_h)\n" : "a_h() { export A=1; }\nb_h() { export B=1; }\nPROMPT_COMMAND='a_h; b_h'\n");
		const r = await workspaceEnv(ws, { PATH: "/usr/bin:/bin", HOME: home, SHELL: bash }, "shell", (k) => envKept(k));
		expect(r.via).toBe("shell");
		expect(r.env).toMatchObject({ A: "1", B: "1" });
	});

	it.runIf(has("zsh"))("direnv on top when the shell has no direnv hook and the hub's .envrc is loaded", async () => {
		const zdot = mkdtempSync(join(tmpdir(), "roost-zdot-"));
		writeFileSync(join(zdot, ".zshrc"), "\n");
		const bin = mkdtempSync(join(tmpdir(), "roost-bin-"));
		writeFileSync(join(bin, "direnv"), `#!/bin/sh\nprintf '{"WS":"1","HUB_VAR":null,"DIRENV_DIR":"-/ws"}'\n`);
		chmodSync(join(bin, "direnv"), 0o755);
		const ws = mkdtempSync(join(tmpdir(), "roost-ws-"));
		const zsh = execFileSync("sh", ["-c", "command -v zsh"]).toString().trim();
		const r = await workspaceEnv(ws, { PATH: `${bin}:/usr/bin:/bin`, HOME: zdot, ZDOTDIR: zdot, SHELL: zsh, DIRENV_DIR: "-/hub", HUB_VAR: "h" }, "shell", (k) => envKept(k));
		expect(r.env).toMatchObject({ WS: "1", DIRENV_DIR: "-/ws" });
		expect(r.env.HUB_VAR).toBeUndefined();
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
