import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	encodeFrame,
	encodeJsonFrame,
	type Frame,
	FrameDecoder,
	FrameType,
	type FrameTypeId,
	MAX_FRAME,
	parseJsonPayload,
} from "../lib/framing.ts";
import { encodeLine, LineReader } from "../lib/protocol.ts";

function splitRandom(buf: Buffer, parts: number): Buffer[] {
	const cuts = new Set<number>();
	while (cuts.size < parts - 1) cuts.add(1 + Math.floor(Math.random() * (buf.length - 1)));
	const points = [0, ...[...cuts].sort((a, b) => a - b), buf.length];
	return points.slice(1).map((end, i) => buf.subarray(points[i], end));
}

describe("framing", () => {
	it("roundtrips each frame type", () => {
		for (const type of Object.values(FrameType) as FrameTypeId[]) {
			const payload = randomBytes(40);
			const frames = new FrameDecoder().push(encodeFrame(type, payload));
			expect(frames).toHaveLength(1);
			expect(frames[0]!.type).toBe(type);
			expect(frames[0]!.payload.equals(payload)).toBe(true);
		}
		const f = new FrameDecoder().push(encodeJsonFrame(FrameType.HELLO, { role: "attach", cols: 80 }));
		expect(parseJsonPayload(f[0]!)).toEqual({ role: "attach", cols: 80 });
		expect(new FrameDecoder().push(encodeFrame(FrameType.DATA, "héllo"))[0]!.payload.toString()).toBe("héllo");
		expect(new FrameDecoder().push(encodeFrame(FrameType.DATA, ""))[0]!.payload).toHaveLength(0);
	});

	it("decodes 3 frames in one chunk", () => {
		const chunk = Buffer.concat([
			encodeFrame(FrameType.DATA, "a"),
			encodeJsonFrame(FrameType.RESIZE, { cols: 1, rows: 2 }),
			encodeFrame(FrameType.DATA, "ccc"),
		]);
		const frames = new FrameDecoder().push(chunk);
		expect(frames.map((f) => f.type)).toEqual([FrameType.DATA, FrameType.RESIZE, FrameType.DATA]);
		expect(frames[2]!.payload.toString()).toBe("ccc");
	});

	it("handles a frame split byte by byte", () => {
		const dec = new FrameDecoder();
		const buf = Buffer.concat([encodeFrame(FrameType.DATA, "hello"), encodeFrame(FrameType.REPLY, "{}")]);
		const out: Frame[] = [];
		for (let i = 0; i < buf.length; i++) out.push(...dec.push(buf.subarray(i, i + 1)));
		expect(out.map((f) => f.payload.toString())).toEqual(["hello", "{}"]);
	});

	it("reassembles a 1 MiB DATA frame from 7 random chunks", () => {
		const payload = randomBytes(1024 * 1024);
		const dec = new FrameDecoder();
		const out: Frame[] = [];
		for (const c of splitRandom(encodeFrame(FrameType.DATA, payload), 7)) out.push(...dec.push(c));
		expect(out).toHaveLength(1);
		expect(out[0]!.payload.equals(payload)).toBe(true);
	});

	it("throws on oversize length", () => {
		const header = Buffer.alloc(5);
		header.writeUInt8(FrameType.DATA, 0);
		header.writeUInt32BE(MAX_FRAME + 1, 1);
		expect(() => new FrameDecoder().push(header)).toThrow(/too large/);
	});

	it("throws on unknown type", () => {
		const header = Buffer.alloc(5);
		header.writeUInt8(99, 0);
		expect(() => new FrameDecoder().push(header)).toThrow(/unknown frame type/);
	});
});

describe("LineReader", () => {
	it("splits lines and keeps the partial one", () => {
		const r = new LineReader();
		expect(r.push("a\nb")).toEqual(["a"]);
		expect(r.push("c\n\nd")).toEqual(["bc", ""]);
		expect(r.push("\n")).toEqual(["d"]);
	});

	it("M49: a line past the limit throws once, then the reader takes nothing; a long line in parts is fine", () => {
		const r = new LineReader(10);
		expect(r.push("12345")).toEqual([]);
		expect(r.push("67890\nab")).toEqual(["1234567890"]);
		expect(() => r.push("cdefghijk")).toThrow(/longer than 10/);
		expect(r.push("\nmore\n")).toEqual([]);
		// a complete line over the limit in one chunk
		expect(() => new LineReader(3).push("abcd\n")).toThrow(/longer than 3/);
		// many chunks of one big line: scanned once each (not re-split), joined whole
		const big = new LineReader();
		for (let i = 0; i < 1000; i++) expect(big.push("x".repeat(1000))).toEqual([]);
		expect(big.push("\n")[0]).toHaveLength(1_000_000);
	});

	it("is utf8-safe across chunk boundaries", () => {
		const bytes = Buffer.from(encodeLine({ s: "你好" }));
		const cut = bytes.indexOf(0xe4) + 1;
		const r = new LineReader();
		expect(r.push(bytes.subarray(0, cut))).toEqual([]);
		const lines = r.push(bytes.subarray(cut));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!)).toEqual({ s: "你好" });
	});
});
