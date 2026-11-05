import { connect } from "node:net";
import type { Socket } from "node:net";
import { FrameDecoder, FrameType, encodeJsonFrame, parseJsonPayload } from "./framing.ts";
import { hostSocketPath } from "./paths.ts";

export interface HostHello {
	role: "attach" | "control";
	cols?: number;
	rows?: number;
}

export type HostControlOp = "snapshot" | "status" | "detach" | "terminate" | "terminate-idle" | "input";

// Connects and sends HELLO; the caller owns the socket. `id` may be a socket path.
export function connectHost(id: string, hello: HostHello): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const sock = connect(id.includes("/") ? id : hostSocketPath(id));
		const onError = (err: Error) => reject(err);
		sock.once("error", onError);
		sock.once("connect", () => {
			sock.off("error", onError);
			sock.on("error", () => {});
			sock.write(encodeJsonFrame(FrameType.HELLO, hello));
			resolve(sock);
		});
	});
}

/** `id` is a job id, or a host socket path (workers know the path, not the runtime dir). */
/** `extra` goes with the op (M30: `{ data }` for input). */
export async function hostControl(id: string, op: HostControlOp, timeoutMs = 3000, extra: Record<string, unknown> = {}): Promise<unknown> {
	const sock = await connectHost(id, { role: "control" });
	return new Promise((resolve, reject) => {
		const decoder = new FrameDecoder();
		const timer = setTimeout(() => finish(new Error(`host control ${op} timed out`)), timeoutMs);
		const finish = (err?: Error, value?: unknown) => {
			clearTimeout(timer);
			sock.destroy();
			if (err) reject(err);
			else resolve(value);
		};
		sock.on("data", (chunk) => {
			try {
				for (const frame of decoder.push(chunk)) {
					if (frame.type === FrameType.REPLY) return finish(undefined, parseJsonPayload(frame));
				}
			} catch (err) {
				finish(err as Error);
			}
		});
		sock.on("error", (err) => finish(err));
		sock.on("close", () => finish(new Error("host closed before reply")));
		sock.write(encodeJsonFrame(FrameType.CONTROL, { ...extra, op }));
	});
}
