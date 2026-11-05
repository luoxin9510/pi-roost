import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deferDurability, durable, writeJsonAtomic } from "../lib/atomic.ts";

describe("M35 group commit", () => {
	afterEach(() => deferDurability(false));

	it("a deferred durable write is readable at once and synced by durable(); several writes, one sync", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-"));
		deferDurability(true);
		for (let i = 0; i < 5; i++) writeJsonAtomic(join(dir, "s.json"), { i });
		expect(JSON.parse(readFileSync(join(dir, "s.json"), "utf8"))).toEqual({ i: 4 });
		await durable();
		// a file removed before its sync is not an error
		writeJsonAtomic(join(dir, "gone.json"), {});
		rmSync(join(dir, "gone.json"));
		await expect(durable()).resolves.toBeUndefined();
		// non-durable writes never wait
		writeJsonAtomic(join(dir, "n.json"), { n: 1 }, false);
		await durable();
		rmSync(dir, { recursive: true, force: true });
	});

	it("off, writes sync as before and durable() resolves at once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-"));
		writeJsonAtomic(join(dir, "a.json"), { a: 1 });
		await expect(durable()).resolves.toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});
