import { connect, type Socket } from "node:net";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType, parseJsonPayload } from "./framing.ts";

export type DetachReason = "local" | "takeover" | "exit" | "request" | "closed" | "error";

export interface AttachIO {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
}

// Ctrl+Z in legacy encoding and as a kitty CSI-u press or repeat.
const LOCAL_DETACH = /^(?:\x1a|\x1b\[122;5(?::[12])?u)$/;

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
	return LOCAL_DETACH.test(chunk.toString("latin1"));
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
		const onInput = (chunk: Buffer | string) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			if (isLocalDetach(buf)) return finish("local");
			sock?.write(encodeFrame(FrameType.DATA, buf));
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
