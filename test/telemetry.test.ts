import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileTelemetry, memoryTelemetry, NOOP_TELEMETRY, parseTelemetry, percentiles, type TelemetryRecord } from "../lib/telemetry.ts";

const spans = (r: TelemetryRecord[]) => r.filter((x): x is Extract<TelemetryRecord, { t: "span" }> => x.t === "span");

describe("M34 telemetry", () => {
	it("a span settles with its callback: sync, async, thrown and rejected; children name their parent", async () => {
		const { telemetry: t, records } = memoryTelemetry("p");
		expect(t.startSpan({ name: "a", attributes: { k: 1 } }, (s) => (s.setAttributes({ x: true }), 5))).toBe(5);
		await t.startSpan({ name: "b" }, async (s) => {
			s.addEvent("half", { n: 2 });
			await s.startSpan({ name: "b.child" }, async () => new Promise((r) => setTimeout(r, 5)));
		});
		expect(() => t.startSpan({ name: "c" }, () => { throw new TypeError("bad"); })).toThrow("bad");
		await expect(t.startSpan({ name: "d" }, async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
		t.startSpan({ name: "e" }, (s) => s.setStatus({ status: "error", error: { name: "Soft", message: "returned not ok" } }));
		const by = Object.fromEntries(spans(records).map((s) => [s.name, s]));
		expect(by.a).toMatchObject({ attributes: { k: 1, x: true }, status: { status: "ok" }, parent: null, proc: "p" });
		expect(by.b!.events[0]).toMatchObject({ name: "half", attributes: { n: 2 } });
		expect(by["b.child"]!.parent).toBe(by.b!.id);
		expect(by["b.child"]!.ms).toBeGreaterThanOrEqual(4);
		expect(by.c!.status).toEqual({ status: "error", error: { name: "TypeError", message: "bad" } });
		expect(by.d!.status).toMatchObject({ status: "error", error: { message: "no" } });
		expect(by.e!.status).toMatchObject({ error: { name: "Soft" } });
	});

	it("counters and histograms; non-finite values are dropped; the no-op costs nothing", () => {
		const { telemetry: t, records } = memoryTelemetry();
		t.counter("n").add(2, { kind: "x" });
		t.histogram("h").record(12.5);
		t.histogram("h").record(Number.NaN);
		expect(records).toMatchObject([
			{ t: "metric", kind: "counter", name: "n", value: 2, attributes: { kind: "x" } },
			{ t: "metric", kind: "histogram", name: "h", value: 12.5 },
		]);
		expect(records).toHaveLength(2);
		expect(NOOP_TELEMETRY.startSpan({ name: "x" }, () => 3)).toBe(3);
		expect(NOOP_TELEMETRY.enabled).toBe(false);
	});

	it("the file sink writes JSON lines in batches; parsing skips what is not a record", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tel-"));
		const file = join(dir, "t.jsonl");
		const t = fileTelemetry(file, "f");
		for (let i = 0; i < 5; i++) t.counter("c").add(i);
		await new Promise((r) => setTimeout(r, 400));
		const recs = parseTelemetry(`${readFileSync(file, "utf8")}not json\n{"t":"other"}\n`);
		expect(recs.map((r) => (r.t === "metric" ? r.value : -1))).toEqual([0, 1, 2, 3, 4]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("percentiles", () => {
		expect(percentiles([])).toBeNull();
		const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1))!;
		expect(p).toMatchObject({ n: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 });
	});
});
