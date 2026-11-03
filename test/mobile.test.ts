import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onMobileActivity, registerMobileStarter, startForMobile } from "../extensions/mobile.ts";

function bus() {
	const handlers = new Map<string, ((d: unknown) => void)[]>();
	return {
		emit: (ch: string, d: unknown) => {
			for (const f of handlers.get(ch) ?? []) f(d);
		},
		on: (ch: string, f: (d: unknown) => void) => {
			handlers.set(ch, [...(handlers.get(ch) ?? []), f]);
			return () => handlers.set(ch, (handlers.get(ch) ?? []).filter((x) => x !== f));
		},
	};
}

let dir: string;
const saved = { agent: process.env.PI_CODING_AGENT_DIR, cfg: process.env.PI_ROOST_CONFIG_DIR };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "roost-mobile-"));
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent"); // session files never in the real one
	process.env.PI_ROOST_CONFIG_DIR = dir;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const [k, v] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_ROOST_CONFIG_DIR", saved.cfg]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("pi-mobile starter (M11)", () => {
	it("registers a background-session starter when pi-mobile asks, and starts through it", async () => {
		const events = bus();
		const calls: unknown[] = [];
		registerMobileStarter({ events } as never, async (req) => (calls.push(req), { id: "j1", name: "fix it" }));
		const got: any[] = [];
		events.emit("pi-mobile:starters", { register: (s: unknown) => got.push(s) });
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ id: "pi-roost", label: "Background session" });
		await expect(got[0].start({ cwd: dir, prompt: "fix it", env: { PI_MOBILE_SPAWN: "s1" } })).resolves.toEqual({ name: "fix it" });
		expect(calls).toEqual([{ cwd: dir, prompt: "fix it", env: { PI_MOBILE_SPAWN: "s1" } }]);
		// a malformed ask is ignored
		expect(() => events.emit("pi-mobile:starters", {})).not.toThrow();
	});

	it("dispatches like the agent view, with the phone's spawn id in the worker's environment only", async () => {
		const sent: any[] = [];
		const client = {
			request: async (op: string, args: unknown) => (sent.push({ op, args }), { id: "j1", name: "fix the flaky test" }),
			close() {},
		};
		const r = await startForMobile(
			{ cwd: dir, prompt: "  fix the flaky test ", env: { PI_MOBILE_SPAWN: "s1", PATH: "/evil", NOT_OURS: "x" } },
			async () => client as never,
		);
		expect(r).toEqual({ id: "j1", name: "fix the flaky test" });
		const d = sent[0].args;
		expect(sent[0].op).toBe("dispatch");
		expect(d).toMatchObject({ cwd: dir, name: "fix the flaky test", origin: "dispatch" });
		expect(d.command.at(-1)).toBe("fix the flaky test");
		expect(d.env.PI_MOBILE_SPAWN).toBe("s1");
		expect(d.env.NOT_OURS).toBeUndefined();
		expect(d.env.PATH).not.toBe("/evil"); // only PI_MOBILE_* come from the phone side
		expect(d.sessionFile.startsWith(join(dir, "agent"))).toBe(true);
		// no prompt: an idle session named after its folder
		await startForMobile({ cwd: dir }, async () => client as never);
		expect(sent[1].args.command).not.toContain("--");
	});

	it("reports phone activity at most once a minute", () => {
		const events = bus();
		let t = 1_000_000;
		let n = 0;
		onMobileActivity({ events } as never, () => n++, 60_000, () => t);
		events.emit("pi-mobile:activity", { action: "snapshot" });
		events.emit("pi-mobile:activity", { action: "send" });
		expect(n).toBe(1);
		t += 61_000;
		events.emit("pi-mobile:activity", { action: "send" });
		expect(n).toBe(2);
	});
});
