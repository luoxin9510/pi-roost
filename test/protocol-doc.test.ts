// M75: the op reference of docs/protocol.md is generated from the schemas; the Python SDK
// speaks the protocol the schemas describe.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import { POLICY } from "../lib/callers.ts";
import { AGENT_CAPABILITIES, DAEMON_CAPABILITIES, type OpArgs, PROTOCOL_VERSION } from "../lib/protocol.ts";
import { ArgSchemas, OPS, ORDER_ACTIONS, ResultSchemas, TASK_ACTIONS } from "../lib/protocol-schema.ts";
import { DOC_PATH, END, renderOpReference, spliceDoc, START } from "../scripts/protocol-doc.ts";

describe("docs/protocol.md", () => {
	it("has the generated op reference up to date", () => {
		const doc = readFileSync(DOC_PATH, "utf8");
		expect(doc, "stale: run npm run docs:protocol").toBe(spliceDoc(doc, renderOpReference()));
		expect(doc.indexOf(START)).toBeGreaterThan(0);
		expect(doc.indexOf(END)).toBeGreaterThan(doc.indexOf(START));
	});

	it("names every op, and the capabilities hello answers with", () => {
		const ref = renderOpReference();
		for (const op of OPS) expect(ref).toContain(`### \`${op}\``);
		for (const c of [...DAEMON_CAPABILITIES, ...AGENT_CAPABILITIES]) expect(ref).toContain(`| \`${c}\` |`);
	});
});

describe("the schemas", () => {
	it("have a result for each op, and a callers row for each op", () => {
		expect(Object.keys(ResultSchemas).sort()).toEqual([...OPS].sort());
		for (const op of OPS) expect(Object.hasOwn(POLICY, op)).toBe(true);
		expect(OPS.length).toBe(39);
	});

	it("give the actions of task and concierge-order", () => {
		expect(TASK_ACTIONS).toHaveLength(21);
		expect(ORDER_ACTIONS).toEqual(["list", "add", "rm", "applied"]);
		for (const a of TASK_ACTIONS) expect(Object.hasOwn(POLICY, `task.${a}`)).toBe(true);
	});
});

describe("the Python SDK", () => {
	const py = readFileSync(new URL("../sdk/python/roost_agent.py", import.meta.url), "utf8");

	it("speaks this protocol version", () => {
		expect(py).toMatch(new RegExp(`^PROTOCOL_VERSION = ${PROTOCOL_VERSION}$`, "m"));
	});

	it("sends only ops the schemas have", () => {
		const sent = new Set([...py.matchAll(/\b(?:request|_send)\(\s*"([a-z_-]+)"/g)].map((m) => m[1]));
		expect([...sent]).toEqual(expect.arrayContaining(["hello", "report", "ack", "peers", "send", "watch", "task"]));
		for (const op of sent) expect(Object.keys(ArgSchemas), `op ${op}`).toContain(op);
	});
});

describe("the import graph", () => {
	const root = new URL("../", import.meta.url);
	const files = (dir: string): string[] => readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []));
	/** Files that load `pkg` (a static or dynamic import, a re-export, a require); comments and strings that only name it do not count. */
	const loading = (dirs: string[], pkg: string) => {
		const spec = `["']${pkg}(?:/[^"']*)?["']`;
		const re = new RegExp(`(?:^|[;\\s])(?:import|export)[^;"']*?from\\s*${spec}|import\\s*\\(\\s*${spec}|require\\s*\\(\\s*${spec}|^\\s*import\\s+${spec}`, "m");
		return dirs.flatMap(files).filter((f) => re.test(readFileSync(new URL(f, root), "utf8")));
	};

	it("has no typebox in lib, daemon, hub or host (the daemon runs without pi), in any form of import", () => {
		expect(["lib", "daemon", "hub", "host"].flatMap(files).length).toBeGreaterThan(20);
		for (const pkg of ["typebox", "@sinclair/typebox"]) expect(loading(["lib", "daemon", "hub", "host"], pkg), pkg).toEqual([]);
	});

	it("has no pi package in lib, daemon or host (pi provides them to its extensions only)", () => {
		expect(loading(["lib", "daemon", "host"], "@earendil-works/[^\"'/]+")).toEqual([]);
	});

	it("the checks catch each form", () => {
		const re = (pkg: string) => new RegExp(`(?:^|[;\\s])(?:import|export)[^;"']*?from\\s*["']${pkg}["']|import\\s*\\(\\s*["']${pkg}["']|require\\s*\\(\\s*["']${pkg}["']`, "m");
		for (const line of ['import { Type } from "typebox";', 'export { Type } from "typebox";', 'const t = await import("typebox");', 'const t = require("typebox");']) expect(re("typebox").test(line), line).toBe(true);
		expect(re("typebox").test("// typebox is pi's, not ours")).toBe(false);
	});
});

describe("the derived lists and types", () => {
	it("keep the order the daemon says them in (`action must be one of …`)", () => {
		expect(TASK_ACTIONS).toEqual(["list", "add", "cleanup", "claim", "release", "done", "drop", "assign", "prepare", "start", "merge", "back", "abort", "commit", "approve", "verify", "pass", "comment", "uncomment", "shelve", "pr"]);
		expect(ORDER_ACTIONS).toEqual(["list", "add", "rm", "applied"]);
	});

	it("concierge-policy takes no fields", () => {
		expectTypeOf<OpArgs["concierge-policy"]>().toEqualTypeOf<Record<string, never>>();
	});
});
