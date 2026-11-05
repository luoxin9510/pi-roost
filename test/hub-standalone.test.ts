import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseModelList } from "../adapters/pi/hub-main.ts";
import { ansiTheme } from "../hub/theme.ts";
import { findPiPackage, piCliOf, resolve } from "../lib/pi-resolve.ts";

describe("M33: the standalone hub", () => {
	it("finds pi's package from its CLI, or from ROOST_PI_PACKAGE", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "roost-pi-")));
		const pkg = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "something-else" }));
		const cli = join(pkg, "dist", "bundle", "cli.js");
		writeFileSync(cli, "");
		const none = () => undefined;
		expect(findPiPackage({}, cli, none)).toBe(pkg);
		expect(findPiPackage({}, join(root, "elsewhere.js"), none)).toBeUndefined();
		expect(findPiPackage({}, undefined, none)).toBeUndefined();
		expect(findPiPackage({ ROOST_PI_PACKAGE: "/x/pi" }, cli, none)).toBe("/x/pi");
		// a shim (pnpm, volta, asdf, mise) leads nowhere: npm's global packages
		expect(findPiPackage({}, join(root, "shims", "pi"), () => join(root, "node_modules"))).toBe(pkg);
		// the CLI comes from the package, whatever put pi on the PATH
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/bundle/cli.js" } }));
		expect(piCliOf(pkg)).toBe(cli);
		expect(piCliOf(root)).toBeUndefined();
	});

	it("resolves pi's packages as pi itself would, and the rest as usual", async () => {
		const { initialize } = await import("../lib/pi-resolve.ts");
		await initialize({ dir: "/opt/pi" });
		const calls: { spec: string; parent?: string }[] = [];
		const next = async (spec: string, ctx: { parentURL?: string }) => {
			calls.push({ spec, parent: ctx.parentURL });
			return { url: `x:${spec}` };
		};
		await resolve("@earendil-works/pi-tui", { parentURL: "file:///hub.js" }, next);
		await resolve("node-pty", { parentURL: "file:///hub.js" }, next);
		expect(calls).toEqual([
			{ spec: "@earendil-works/pi-tui", parent: pathToFileURL("/opt/pi/package.json").href },
			{ spec: "node-pty", parent: "file:///hub.js" },
		]);
		// not found where pi is: the usual way
		calls.length = 0;
		let first = true;
		await resolve("@earendil-works/pi-ai", { parentURL: "file:///hub.js" }, async (spec, ctx) => {
			calls.push({ spec, parent: ctx.parentURL });
			if (first) {
				first = false;
				throw new Error("not found");
			}
			return { url: "x" };
		});
		expect(calls.map((c) => c.parent)).toEqual([pathToFileURL("/opt/pi/package.json").href, "file:///hub.js"]);
	});

	it("reads pi's model list", () => {
		const out = "provider   model             context\nanthropic  claude-haiku-5-5  1M\ndeepseek   deepseek-flash    128K\n\n";
		expect(parseModelList(out)).toEqual(["anthropic/claude-haiku-5-5", "deepseek/deepseek-flash"]);
		expect(parseModelList("")).toEqual([]);
		expect(parseModelList("No models available. Log in:\n  anthropic  run /login\n")).toEqual([]);
	});

	it("draws in colour unless NO_COLOR", () => {
		expect(ansiTheme({}).fg("accent", "x")).toBe("\x1b[38;5;141mx\x1b[39m");
		expect(ansiTheme({}).fg("no-such-colour", "x")).toBe("x");
		expect(ansiTheme({ NO_COLOR: "1" }).fg("accent", "x")).toBe("x");
		expect(ansiTheme({ NO_COLOR: "1" }).bold("x")).toBe("x");
	});

	it("pi-roost hub: a missing directory, and no pi on the PATH, are said plainly", () => {
		const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["bin/pi-roost.ts", ...args], { encoding: "utf8", env });
		const missing = run(["hub", "/no/such/dir"], process.env);
		expect(missing.status).toBe(2);
		expect(missing.stderr).toContain("no such directory");
		// no pi anywhere (an empty PATH, a package directory that is not pi's)
		const nopi = run(["hub", tmpdir()], { PATH: "", HOME: process.env.HOME, ROOST_PI_PACKAGE: tmpdir() });
		expect(nopi.status).toBe(1);
		expect(nopi.stderr).toContain("the hub needs pi");
	});
});
