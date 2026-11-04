import { connect, type Socket } from "node:net";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType, parseJsonPayload } from "./framing.ts";

export type DetachReason = "local" | "takeover" | "exit" | "request" | "closed" | "error";

export interface AttachIO {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
}

// Ctrl+Z: legacy, a kitty CSI-u press or repeat (any alternate keys, lock bits, text),
// xterm's modifyOtherKeys; and the bracketed paste markers (a pasted ^Z is text).
const DETACH_SCAN = /\x1a|\x1b\[122(?::\d*)*;(\d+)(?::(\d+))?(?:;[\d:]*)?u|\x1b\[27;(\d+);122~|\x1b\[20([01])~/g;
/** The start of an escape sequence a chunk may end in (sent on: only the scan waits for the rest). */
const PARTIAL_ESC = /\x1b(?:\[[\d;:]*)?$/;
/** No input for this long while in a paste: its end marker was lost. */
const PASTE_IDLE_MS = 1000;
/** Caps Lock and Num Lock (kitty's modifier bits 64 and 128) do not make it another key. */
const ctrlOnly = (mods: string) => ((Number(mods) - 1) & ~(64 | 128)) === 4;

// Modes a worker may have left on (AT-4): kitty keyboard, bracketed paste,
// mouse tracking, focus events, modifyOtherKeys, synchronized output; then autowrap and
// the cursor back. Leaving the alternate screen (M14) is added only when the session
// entered it: in a terminal on its main screen ?1049l may restore a stale cursor.
export const TERMINAL_RESET =
	"\x1b[<u\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[>4;0m\x1b[?2026l\x1b[?7h\x1b[?25h";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";

/** M14: a worker writes this before it repaints on attach (for hosts before M21); a host strips it. */
export const REPAINT_MARKER = "\x1b]7700;pi-roost-repaint\x07";

/** Whether `chunk` leaves the alternate screen on (true), off (false) or as it was. */
export function altScreenAfter(chunk: string, was: boolean): boolean {
	const on = chunk.lastIndexOf(ALT_ON);
	const off = chunk.lastIndexOf(ALT_OFF);
	return on === off ? was : on > off;
}

export function isLocalDetach(chunk: Buffer): boolean {
	const s = chunk.toString("latin1");
	const r = localDetachAt(s);
	return r.at === 0 && r.end === s.length;
}

/**
 * M22: where the local detach key is in a chunk of input, if anywhere. Keys typed fast,
 * a terminal or multiplexer that batches input, or a lock key held on can put Ctrl+Z
 * among other bytes or in another encoding; sent on, it would reach the session's pi,
 * which suspends itself, and nothing in the background would ever continue it.
 * `pasting` carries a bracketed paste across chunks. Offsets are bytes (latin1).
 */
export function localDetachAt(s: string, pasting = false): { at: number; end: number; pasting: boolean } {
	DETACH_SCAN.lastIndex = 0;
	for (let m = DETACH_SCAN.exec(s); m; m = DETACH_SCAN.exec(s)) {
		if (m[4] !== undefined) {
			pasting = m[4] === "0";
			continue;
		}
		if (pasting) continue;
		const mods = m[1] ?? m[3];
		// a release (event 3) is not a press
		if (mods !== undefined && (!ctrlOnly(mods) || m[2] === "3")) continue;
		return { at: m.index, end: m.index + m[0].length, pasting };
	}
	return { at: -1, end: -1, pasting };
}

/**
 * Pass the terminal through to a job's PTY host until detach. The caller owns
 * the terminal before and after: this only toggles raw mode while attached.
 */
export function attachToHost(socketPath: string, io: AttachIO): Promise<DetachReason> {
	return new Promise((resolve) => {
		const { stdin, stdout } = io;
		const wasRaw = stdin.isTTY ? stdin.isRaw : false;
		const decoder = new FrameDecoder();
		let settled = false;
		let sock: Socket | undefined;
		let alt = false;
		/** A host since M14 greets first; an older one only redraws, so clear for it. */
		let greeted: boolean | undefined;

		const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
		let pasting = false;
		let lastInput = 0;
		// the unfinished escape sequence a chunk ended in: the next chunk may finish it
		let tail = "";
		const onInput = (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			const now = Date.now();
			// a paste whose end marker was lost does not swallow the detach key for ever
			if (pasting && now - lastInput > PASTE_IDLE_MS) pasting = false;
			lastInput = now;
			const text = buf.toString("latin1");
			const scan = tail + text;
			const r = localDetachAt(scan, pasting);
			pasting = r.pasting;
			const at = r.at - tail.length;
			tail = (PARTIAL_ESC.exec(scan)?.[0] ?? "").slice(-32);
			if (r.at === -1) {
				sock?.write(encodeFrame(FrameType.DATA, buf));
				return;
			}
			// what was typed before it still goes; what follows it is the view's
			if (at > 0) sock?.write(encodeFrame(FrameType.DATA, buf.subarray(0, at)));
			finish("local");
		};
		const onResize = () => sock?.write(encodeJsonFrame(FrameType.RESIZE, size()));

		const finish = (reason: DetachReason) => {
			if (settled) return;
			settled = true;
			stdin.off("data", onInput);
			stdout.off("resize", onResize);
			stdin.pause();
			if (stdin.isTTY) stdin.setRawMode(wasRaw);
			stdout.write(TERMINAL_RESET + (alt ? ALT_OFF : ""));
			sock?.destroy();
			resolve(reason);
		};

		sock = connect(socketPath);
		sock.on("connect", () => {
			// the host greets, then sends its own copy of the screen (M21); a host from before
			// M14 sends neither, so the first data clears the screen (below)
			sock?.write(encodeJsonFrame(FrameType.HELLO, { role: "attach", ...size() }));
			if (stdin.isTTY) stdin.setRawMode(true);
			stdin.on("data", onInput);
			stdin.resume();
			stdout.on("resize", onResize);
		});
		sock.on("data", (chunk) => {
			let frames;
			try {
				frames = decoder.push(chunk);
			} catch {
				return finish("error");
			}
			for (const frame of frames) {
				if (frame.type === FrameType.HELLO) greeted = true;
				else if (frame.type === FrameType.DATA) {
					if (greeted === undefined) {
						greeted = false;
						stdout.write("\x1b[2J\x1b[H");
					}
					alt = altScreenAfter(frame.payload.toString("latin1"), alt);
					stdout.write(frame.payload);
				}
				else if (frame.type === FrameType.DETACHED) {
					const { reason } = parseJsonPayload<{ reason: DetachReason }>(frame);
					return finish(reason);
				}
			}
		});
		sock.on("error", () => finish("error"));
		sock.on("close", () => finish("closed"));
	});
}
