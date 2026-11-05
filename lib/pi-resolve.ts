/**
 * M33: the standalone hub (`pi-roost hub`) draws with pi-tui and launches pi jobs the way
 * pi does, so it needs pi's packages. They are pi's own, not roost's (peer dependencies,
 * absent from roost's folder when pi installed it): this module finds the pi on the PATH
 * and resolves `@earendil-works/*` from its installation, so the hub runs the same code as
 * the user's pi. The file is also the resolve hook itself (node:module register). Node only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The pi CLI on the PATH (its real file), or undefined. */
export function findPiCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
	try {
		const bin = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8", env }).trim();
		return bin ? realpathSync(bin) : undefined;
	} catch {
		return undefined;
	}
}

const isPiPackage = (dir: string): boolean => {
	try {
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === PI_PACKAGE;
	} catch {
		return false;
	}
};

/**
 * The directory of pi's package: ROOST_PI_PACKAGE; else the one the pi on the PATH runs
 * from (an npm-style link to its CLI); else npm's global packages (where a shim of pnpm,
 * volta, asdf or mise does not lead).
 */
export function findPiPackage(env: NodeJS.ProcessEnv = process.env, cli: string | undefined = findPiCli(env), npmRoot: () => string | undefined = () => globalNpmRoot(env)): string | undefined {
	if (env.ROOST_PI_PACKAGE) return env.ROOST_PI_PACKAGE;
	if (cli) {
		for (let d = dirname(cli), i = 0; i < 10; i++) {
			if (existsSync(join(d, "package.json")) && isPiPackage(d)) return d;
			const up = dirname(d);
			if (up === d) break;
			d = up;
		}
	}
	const root = npmRoot();
	const global = root ? join(root, PI_PACKAGE) : undefined;
	return global && isPiPackage(global) ? global : undefined;
}

function globalNpmRoot(env: NodeJS.ProcessEnv): string | undefined {
	try {
		return execFileSync("npm", ["root", "-g"], { encoding: "utf8", env, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** pi's CLI in its package (its `bin.pi`): a file node runs, whatever shim put pi on the PATH. */
export function piCliOf(pkg: string): string | undefined {
	try {
		const bin = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { bin?: string | Record<string, string> }).bin;
		const rel = typeof bin === "string" ? bin : bin?.pi;
		return rel && existsSync(join(pkg, rel)) ? join(pkg, rel) : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve pi's packages from `dir` (pi's package directory) in this process from now on. */
export function usePiPackage(dir: string): void {
	register(import.meta.url, { data: { dir } });
}

// ---- the hook (runs on node's loader thread) -----------------------------------------

let piDir: string | undefined;

export async function initialize(data: { dir: string }): Promise<void> {
	piDir = data.dir;
}

type Next = (specifier: string, context: { parentURL?: string; conditions?: string[] }) => Promise<unknown>;

export async function resolve(specifier: string, context: { parentURL?: string; conditions?: string[] }, next: Next): Promise<unknown> {
	if (piDir && specifier.startsWith("@earendil-works/")) {
		try {
			// as pi itself imports them: its own package (self-reference) and its dependencies
			return await next(specifier, { ...context, parentURL: pathToFileURL(join(piDir, "package.json")).href });
		} catch {}
	}
	return next(specifier, context);
}
