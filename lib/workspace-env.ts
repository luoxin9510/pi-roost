// M20: a session started from the hub in another workspace gets that workspace's
// environment, as a shell that cd'd there would have it: direnv (.envrc), mise, fnm/nvm
// use-on-cd, ... run from the shell's own hooks, and their trust rules (direnv allow,
// mise trust) still apply. Evaluated by the PTY host each time the worker starts.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export type WorkspaceEnvMode = "shell" | "direnv" | "off";

/**
 * M20: never carried, even when the whole environment is: a job's identity (the worker
 * gets its own), and what names the terminal the launch came from (the session runs in
 * its own PTY and is opened from any terminal, or a phone).
 */
export const ENV_NEVER = new Set([
	"PI_JOB_ID", "PI_JOB_TOKEN", "PI_JOB_DIR", "PI_DAEMON_SOCK", "PI_ROOST_RESTORE",
	"TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "LC_TERMINAL", "LC_TERMINAL_VERSION",
	"TMUX", "TMUX_PANE", "STY", "WINDOW", "WINDOWID", "ITERM_SESSION_ID", "ITERM_PROFILE",
	"KITTY_WINDOW_ID", "KITTY_PID", "KITTY_LISTEN_ON", "KITTY_PUBLIC_KEY", "WEZTERM_PANE", "WEZTERM_UNIX_SOCKET",
	"ALACRITTY_WINDOW_ID", "ALACRITTY_SOCKET", "GHOSTTY_RESOURCES_DIR", "ZELLIJ", "ZELLIJ_PANE_ID", "ZELLIJ_SESSION_NAME",
	"COLUMNS", "LINES", "PWD", "OLDPWD", "SHLVL", "_",
	// the launching tty (pinentry and ssh would talk to a terminal the session is not on)
	"GPG_TTY", "SSH_TTY", "VTE_VERSION", "WT_SESSION", "WT_PROFILE_ID", "TERMINAL_EMULATOR",
]);
/** Prefixes of the same kind: an editor's or a terminal's own (VS Code's git askpass socket dies with it). */
const ENV_NEVER_PREFIX = ["VSCODE_", "KONSOLE_", "ITERM_", "KITTY_", "WEZTERM_", "ZELLIJ_"];

/** A name a worker's environment may hold: not on the never list, not denied. */
export function envKept(name: string, deny: readonly string[] = []): boolean {
	// (a name with "=" or NUL cannot be set)
	if (!name || /[=\0]/.test(name) || ENV_NEVER.has(name) || ENV_NEVER_PREFIX.some((p) => name.startsWith(p))) return false;
	return !deny.some((d) => (d.endsWith("*") ? name.startsWith(d.slice(0, -1)) : name === d));
}

const MARK = "__PI_ROOST_ENV__";
/** After the dump: a probe cut short (a busy machine, a held stdout) is not taken as whole. */
const END = "__PI_ROOST_END__";
export const PROBE_TIMEOUT_MS = 8000;

/** Names the probe itself sets or that describe the probe's shell, not the session. */
const PROBE_NOISE = new Set(["PI_ROOST_PROBE_DIR", "PWD", "OLDPWD", "SHLVL", "_", "TERM", "PS1", "PS2", "PROMPT", "RPROMPT", "ZSH_EXECUTION_STRING"]);

/** The script that cds like a person would and prints the environment after a marker. */
export function probeScript(shell: string): { args: string[] } | undefined {
	const name = basename(shell);
	const dump = `printf '\\n${MARK}\\n'; command env -0; printf '${END}\\n'`;
	if (name === "zsh") {
		return {
			args: [
				"-i",
				"-c",
				`cd -- "$PI_ROOST_PROBE_DIR" || exit 97; for __pr_f in $chpwd_functions $precmd_functions; do "$__pr_f" >/dev/null 2>&1 </dev/null; done; ${dump}`,
			],
		};
	}
	if (name === "bash") {
		return {
			args: [
				"-i",
				"-c",
				`cd -- "$PI_ROOST_PROBE_DIR" || exit 97; for __pr_c in "\${PROMPT_COMMAND[@]}"; do eval "$__pr_c" >/dev/null 2>&1 </dev/null; done; ${dump}`,
			],
		};
	}
	if (name === "tcsh" || name === "csh") {
		// .cshrc / .tcshrc: tcsh runs the cwdcmd alias on cd and precmd before a prompt
		// (direnv's tcsh hook is a precmd alias); csh on macOS is tcsh
		return {
			args: [
				"-i",
				"-c",
				`if ( ! -d "$PI_ROOST_PROBE_DIR" ) exit 97; cd "$PI_ROOST_PROBE_DIR"; eval "\`alias cwdcmd\`" >& /dev/null; eval "\`alias precmd\`" >& /dev/null; printf "\\n${MARK}\\n"; env -0; printf "${END}\\n"`,
			],
		};
	}
	if (name === "fish") {
		return { args: ["-i", "-c", `cd -- $PI_ROOST_PROBE_DIR; or exit 97; emit fish_prompt >/dev/null 2>&1 </dev/null; printf '\\n${MARK}\\n'; command env -0; printf '${END}\\n'`] };
	}
	return undefined;
}

/** The environment printed after the marker (NUL-separated `K=V`). */
export function parseProbe(out: Buffer): Record<string, string> | undefined {
	const marker = Buffer.from(`\n${MARK}\n`);
	const at = out.lastIndexOf(marker);
	if (at === -1) return undefined;
	const rest = out.subarray(at + marker.length);
	const end = rest.lastIndexOf(Buffer.from(`${END}\n`));
	if (end === -1) return undefined;
	const env: Record<string, string> = {};
	for (const pair of rest.subarray(0, end).toString("utf8").split("\0")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		env[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

/** Probes running now: a host that is told to stop kills them (their whole group). */
const live = new Set<number>();
export function killProbes(): void {
	for (const pid of live) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
	live.clear();
}

function run(file: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; out: Buffer } | undefined> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: true });
		} catch {
			return resolve(undefined);
		}
		const pid = child.pid;
		if (pid !== undefined) live.add(pid);
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		let grace: NodeJS.Timeout | undefined;
		const end = (r: { code: number | null; out: Buffer } | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearTimeout(grace);
			child.stdout?.destroy();
			// what the rc left running in the background goes with it
			if (pid !== undefined) {
				live.delete(pid);
				try {
					process.kill(-pid, "SIGKILL");
				} catch {}
			}
			resolve(r);
		};
		const timer = setTimeout(() => end(undefined), timeoutMs);
		child.stdout!.on("data", (b: Buffer) => {
			size += b.length;
			if (size <= 16 * 1024 * 1024) chunks.push(b);
		});
		child.on("error", () => end(undefined));
		// a background child of the rc may hold stdout open: the shell's exit is enough
		child.on("exit", (code) => {
			grace = setTimeout(() => end({ code, out: Buffer.concat(chunks) }), 100);
		});
		child.on("close", (code) => end({ code, out: Buffer.concat(chunks) }));
	});
}

/** Which program on the session's PATH. */
function onPath(name: string, env: Record<string, string>): string | undefined {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const p = `${dir}/${name}`;
		try {
			if (existsSync(p)) return p;
		} catch {}
	}
	return undefined;
}

/** direnv alone: `direnv export json` from the workspace (it unloads the launch directory's .envrc too). */
async function viaDirenv(cwd: string, base: Record<string, string>, timeoutMs: number): Promise<Record<string, string> | undefined> {
	const direnv = onPath("direnv", base);
	if (!direnv) return undefined;
	const r = await run(direnv, ["export", "json"], cwd, base, timeoutMs);
	if (!r || r.code !== 0) return undefined;
	const text = r.out.toString("utf8").trim();
	if (!text) return { ...base }; // nothing to change
	try {
		const diff = JSON.parse(text) as Record<string, string | null>;
		const env = { ...base };
		for (const [k, v] of Object.entries(diff)) {
			if (v === null) delete env[k];
			else if (typeof v === "string") env[k] = v;
		}
		return env;
	} catch {
		return undefined;
	}
}

const inside = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);

export interface WorkspaceEnvResult {
	env: Record<string, string>;
	/** What gave it: the shell's hooks, direnv, or nothing (the base as it came). */
	via: "shell" | "direnv" | "none";
}

/**
 * The environment for a session in `cwd`, from `base` (what the launch carried). `keep`
 * decides which names may come out of the probe (the deny list and the never list).
 */
export async function workspaceEnv(
	cwd: string,
	base: Record<string, string>,
	mode: WorkspaceEnvMode,
	keep: (name: string) => boolean,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<WorkspaceEnvResult> {
	if (mode === "off") return { env: base, via: "none" };
	// the shell gets most of the time; direnv after it, both within timeoutMs
	const started = Date.now();
	const left = () => Math.max(1, timeoutMs - (Date.now() - started));
	const finish = (probed: Record<string, string>, via: WorkspaceEnvResult["via"]): WorkspaceEnvResult => {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(probed)) {
			if (PROBE_NOISE.has(k) || !keep(k)) continue;
			env[k] = v;
		}
		// a name the base had and the probe has not is gone on purpose (an .envrc unloaded),
		// except one a shell cannot hold (FOO-BAR): it never had the chance to keep it
		for (const [k, v] of Object.entries(base)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && env[k] === undefined && keep(k)) env[k] = v;
		}
		return { env, via };
	};
	let shellEnv: Record<string, string> | undefined;
	if (mode === "shell") {
		const shell = base.SHELL || "/bin/sh";
		const script = probeScript(shell);
		if (script) {
			// not "dumb": many rc files stop early for dumb terminals (emacs, TRAMP)
			const r = await run(shell, script.args, cwd, { ...base, PI_ROOST_PROBE_DIR: cwd, TERM: base.TERM || "xterm-256color" }, Math.ceil(timeoutMs * 0.7));
			// an exit hook may fail after the dump: the dump counts; 97 is a cd that failed
			shellEnv = r && r.code !== 97 ? parseProbe(r.out) : undefined;
		}
	}
	if (shellEnv) {
		// direnv loaded where the hub was and the shell did not move it (no hook in its rc):
		// direnv itself, on top
		const stale = base.DIRENV_DIR !== undefined && shellEnv.DIRENV_DIR === base.DIRENV_DIR && !inside(cwd, base.DIRENV_DIR.replace(/^-/, ""));
		if (stale) {
			const viaD = await viaDirenv(cwd, shellEnv, left());
			if (viaD) return finish(viaD, "shell");
		}
		return finish(shellEnv, "shell");
	}
	const viaD = await viaDirenv(cwd, base, left());
	if (viaD) return finish(viaD, "direnv");
	return { env: base, via: "none" };
}
