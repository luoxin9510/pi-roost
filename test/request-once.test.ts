// M51: a reply or a dispatch whose answer is lost is sent again with the same request id.
import { describe, expect, it } from "vitest";
import { type DaemonClient, DaemonError, GiveUp, newRequestId, requestOnce } from "../lib/client.ts";
import { refusedByDaemon } from "../lib/dispatch.ts";

/** What the daemon answers when it refuses. */
const refusal = (message: string, code: string) => Object.assign(new DaemonError(message, code), { fromDaemon: true });

/** A connection whose requests answer as `answers` say, in turn; it records what was asked. */
function fake(answers: (unknown | Error)[], asked: unknown[]): DaemonClient {
	return {
		request: async (_op: string, args: unknown) => {
			asked.push(args);
			const a = answers.shift();
			if (a instanceof Error) throw a;
			return a;
		},
	} as unknown as DaemonClient;
}

describe("M51: requestOnce", () => {
	it("sends again with the same id when the answer is lost; a refusal is not sent again", async () => {
		const asked: { requestId?: string }[] = [];
		const c = fake([new DaemonError("daemon connection closed", "closed"), Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), { delivered: true }], asked);
		const r = await requestOnce(async () => c, "reply", { id: "j1", text: "hi" });
		expect(r).toEqual({ delivered: true });
		expect(asked).toHaveLength(3);
		expect(new Set(asked.map((a) => a.requestId)).size).toBe(1);
		expect(asked[0]!.requestId).toMatch(/^reply\./);
		// the daemon said no: once
		const refusedAsked: unknown[] = [];
		await expect(requestOnce(async () => fake([refusal("no such job", "not_found")], refusedAsked), "reply", { id: "x", text: "hi" })).rejects.toMatchObject({ code: "not_found" });
		expect(refusedAsked).toHaveLength(1);
		// an id given is kept
		const kept: { requestId?: string }[] = [];
		await requestOnce(async () => fake([{ delivered: true }], kept), "reply", { id: "j", text: "t", requestId: "mine" });
		expect(kept[0]!.requestId).toBe("mine");
	});

	it("gives up after its time; a connection that cannot be had is tried again meanwhile", async () => {
		let tries = 0;
		const t0 = Date.now();
		await expect(
			requestOnce(
				async () => {
					tries++;
					throw new Error("background service unavailable");
				},
				"dispatch",
				{ cwd: "/", sessionFile: "/s.jsonl", command: ["x"], env: {}, name: "n", origin: "dispatch" },
				{ timeoutMs: 700 },
			),
		).rejects.toThrow(/unavailable/);
		expect(tries).toBeGreaterThan(1);
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	it("ids are new each time and fit the daemon's rule", () => {
		const a = newRequestId("hub");
		expect(a).not.toBe(newRequestId("hub"));
		expect(a).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
		expect(newRequestId("a tag/with odd chars".repeat(10))).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
	});

	it("a local error on a resend is not a refusal: it is tried again, and given up as lost (which undoes nothing)", async () => {
		const asked: unknown[] = [];
		let n = 0;
		const err = (await requestOnce(
			async () => {
				n++;
				if (n === 1) return fake([new DaemonError("daemon connection closed", "closed")], asked);
				// connectOrStart failing locally: a code, but not the daemon's answer
				throw new DaemonError("daemon did not start", "start_timeout");
			},
			"dispatch",
			{ cwd: "/", sessionFile: "/s.jsonl", command: ["x"], env: {}, name: "n", origin: "dispatch" },
			{ timeoutMs: 900 },
		).catch((e: unknown) => e)) as DaemonError;
		expect(n).toBeGreaterThan(2);
		expect(err.code).toBe("lost");
		expect(refusedByDaemon(err)).toBe(false);
		// never sent: the error as it was (a new session's worktree may go)
		const unsent = (await requestOnce(
			async () => {
				throw new DaemonError("daemon did not start", "start_timeout");
			},
			"reply",
			{ id: "j", text: "t" },
			{ timeoutMs: 300 },
		).catch((e: unknown) => e)) as DaemonError;
		expect(unsent.code).toBe("start_timeout");
		// a caller that is closing gives up at once
		const t0 = Date.now();
		await expect(
			requestOnce(
				async () => {
					throw new GiveUp("closed");
				},
				"reply",
				{ id: "j", text: "t" },
			),
		).rejects.toThrow(/closed/);
		expect(Date.now() - t0).toBeLessThan(200);
	});
});
