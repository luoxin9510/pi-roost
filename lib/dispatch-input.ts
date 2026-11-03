// What the agent view's input asks for (PRD §6.3): a task, a shell job, or an
// in-view command; plus @<dir> targets (DI-3).
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export type Parsed =
	| { kind: "task"; task: string; cwd?: string }
	| { kind: "shell"; command: string; cwd?: string }
	| { kind: "command"; name: string; arg: string };

const isDir = (p: string) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

/** An @token's directory: absolute, ~/…, or relative to the view's directory. */
export function resolveAt(token: string, base: string, home = homedir()): string | undefined {
	const raw = token.replace(/^@/, "").replace(/\/+$/, "");
	if (!raw) return undefined;
	const path = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : resolve(base, raw);
	return isDir(path) ? path : undefined;
}

/** DI-3: the first @<dir> naming an existing directory targets it and leaves the text. */
function takeAt(text: string, base: string): { text: string; cwd?: string } {
	const words = text.split(/(\s+)/);
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (!w.startsWith("@") || w.length < 2) continue;
		const dir = resolveAt(w, base);
		if (!dir) continue;
		words.splice(i, 1);
		return { text: words.join("").replace(/\s+/g, " ").trim(), cwd: dir };
	}
	return { text };
}

export function parseInput(input: string, base: string): Parsed {
	const text = input.trim();
	if (text.startsWith("!")) {
		const { text: command, cwd } = takeAt(text.slice(1).trim(), base);
		return { kind: "shell", command, ...(cwd ? { cwd } : {}) };
	}
	const cmd = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (cmd) return { kind: "command", name: cmd[1]!, arg: (cmd[2] ?? "").trim() };
	const { text: task, cwd } = takeAt(text, base);
	return { kind: "task", task, ...(cwd ? { cwd } : {}) };
}

/** The @word being typed at the end of the input, if any. */
export function atPrefix(input: string): string | undefined {
	const m = /(?:^|\s)@([^\s]*)$/.exec(input);
	return m ? m[1] : undefined;
}

/**
 * DI-3 completion: child git repositories (one level), the repo's worktrees under
 * .pi/worktrees/, and directories that already have jobs. Shown relative to base.
 */
export function atCandidates(base: string, jobDirs: string[], prefix = ""): string[] {
	const out = new Set<string>();
	const p = prefix.toLowerCase();
	const add = (abs: string) => {
		const inside = abs.startsWith(`${base}/`);
		const rel = abs === base ? "." : inside ? abs.slice(base.length + 1) : abs;
		// what is typed is matched against the shown name (or a directory's last segment),
		// never against the base path every child shares
		if (rel.toLowerCase().startsWith(p) || (!inside && basename(abs).toLowerCase().startsWith(p))) out.add(rel);
	};
	const list = (dir: string) => {
		try {
			return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
		} catch {
			return [];
		}
	};
	for (const d of list(base)) if (existsSync(join(base, d.name, ".git"))) add(join(base, d.name));
	for (const d of list(join(base, ".pi", "worktrees"))) add(join(base, ".pi", "worktrees", d.name));
	for (const dir of jobDirs) if (isDir(dir)) add(dir);
	// then any other child directory, so a plain folder completes too
	const preferred = out.size;
	for (const d of list(base)) add(join(base, d.name));
	const all = [...out];
	const first = all.slice(0, preferred).sort((a, b) => a.length - b.length || a.localeCompare(b));
	const rest = all.slice(preferred).sort((a, b) => a.length - b.length || a.localeCompare(b));
	return [...first, ...rest].slice(0, 20);
}

/** pi's thinking levels for the /thinking picker. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
