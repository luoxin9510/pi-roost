export const FrameType = { HELLO: 1, DATA: 2, RESIZE: 3, DETACHED: 4, CONTROL: 5, REPLY: 6 } as const;
export type FrameTypeId = (typeof FrameType)[keyof typeof FrameType];

export const MAX_FRAME = 16 * 1024 * 1024;
const HEADER = 5;
const KNOWN = new Set<number>(Object.values(FrameType));

export interface Frame {
	type: FrameTypeId;
	payload: Buffer;
}

export function encodeFrame(type: FrameTypeId, payload: Uint8Array | string): Buffer {
	const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	if (body.length > MAX_FRAME) throw new Error(`frame too large: ${body.length}`);
	const out = Buffer.allocUnsafe(HEADER + body.length);
	out.writeUInt8(type, 0);
	out.writeUInt32BE(body.length, 1);
	out.set(body, HEADER);
	return out;
}

export function encodeJsonFrame(type: FrameTypeId, value: unknown): Buffer {
	return encodeFrame(type, JSON.stringify(value));
}

export function parseJsonPayload<T>(frame: Frame): T {
	return JSON.parse(frame.payload.toString("utf8")) as T;
}

export class FrameDecoder {
	private chunks: Buffer[] = [];
	private size = 0;

	push(chunk: Buffer): Frame[] {
		if (chunk.length > 0) {
			this.chunks.push(chunk);
			this.size += chunk.length;
		}
		const frames: Frame[] = [];
		while (this.size >= HEADER) {
			const header = this.peek(HEADER);
			const type = header.readUInt8(0);
			const length = header.readUInt32BE(1);
			if (!KNOWN.has(type)) throw new Error(`unknown frame type: ${type}`);
			if (length > MAX_FRAME) throw new Error(`frame too large: ${length}`);
			if (this.size < HEADER + length) break;
			this.take(HEADER);
			frames.push({ type: type as FrameTypeId, payload: this.take(length) });
		}
		return frames;
	}

	// First n bytes without consuming; only merges chunks when the first is too short.
	private peek(n: number): Buffer {
		const first = this.chunks[0]!;
		if (first.length >= n) return first;
		const merged = Buffer.concat(this.chunks);
		this.chunks = [merged];
		return merged;
	}

	private take(n: number): Buffer {
		if (n === 0) return Buffer.alloc(0);
		const first = this.chunks[0]!;
		this.size -= n;
		if (first.length >= n) {
			if (first.length === n) this.chunks.shift();
			else this.chunks[0] = first.subarray(n);
			return first.subarray(0, n);
		}
		const parts: Buffer[] = [];
		let need = n;
		while (need > 0) {
			const c = this.chunks[0]!;
			if (c.length <= need) {
				parts.push(c);
				need -= c.length;
				this.chunks.shift();
			} else {
				parts.push(c.subarray(0, need));
				this.chunks[0] = c.subarray(need);
				need = 0;
			}
		}
		return Buffer.concat(parts, n);
	}
}
