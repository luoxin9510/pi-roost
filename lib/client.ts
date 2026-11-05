import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonSocketPath, ensureDirs } from "./paths.ts";
import { type ArgsOf, encodeLine, type Event, LineReader, type Op, type Response, type ResultOf } from "./protocol.ts";
import { JOB_ENV_NAMES } from "./identity.ts";

export class DaemonError extends Error {
	code: string | undefined;
	constructor(message: string, code?: string) {
		super(message);
		this.code = code;
	}
}

/** Package root: the nearest ancestor of this module holding package.json. */
export function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (!existsSync(join(dir, "package.json"))) {
		const parent = dirname(dir);
		if (parent === dir) throw new Error("pi-roost package root not found");
		dir = parent;
	}
	return dir;
}

export const daemonEntry = () => join(packageRoot(), "dist", "daemon", "main.js");
export const hostEntry = () => join(packageRoot(), "dist", "host", "main.js");

export class DaemonClient {
	private sock: Socket;
	private reader = new LineReader();
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; at?: number }>();
	/** M22: lines received so far: an event's or a reply's place in the stream. */
	private lines = 0;
	private listeners = new Set<(event: Event) => void>();
	private closeListeners = new Set<() => void>();
	private closed = false;

	private constructor(sock: Socket) {
		this.sock = sock;
		sock.on("data", (chunk) => {
			for (const line of this.reader.push(chunk)) this.onLine(line);
		});
		const fail = (err: Error) => {
			const first = !this.closed;
			this.closed = true;
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
			if (first) for (const l of this.closeListeners) l();
		};
		sock.on("error", fail);
		sock.on("close", () => fail(new DaemonError("daemon connection closed", "closed")));
	}

	/** Connect to a running daemon; rejects when none is listening. */
	static connect(socketPath = daemonSocketPath()): Promise<DaemonClient> {
		return new Promise((resolve, reject) => {
			const sock = connect(socketPath);
			sock.once("connect", () => {
				sock.removeListener("error", reject);
				resolve(new DaemonClient(sock));
			});
			sock.once("error", reject);
		});
	}

	/** Connect, starting the daemon first when it is not running. */
	static async connectOrStart(timeoutMs = 3000): Promise<DaemonClient> {
		try {
			return await DaemonClient.connect();
		} catch {
			// not running (or a stale socket): start one below
		}
		ensureDirs();
		const entry = daemonEntry();
		if (!existsSync(entry)) throw new DaemonError(`daemon not built: ${entry} (run npm run build)`, "not_built");
		// The first client may be a worker: its job identity must not leak into the daemon.
		const env = { ...process.env };
		for (const key of JOB_ENV_NAMES) delete env[key];
		const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", env, cwd: "/" });
		child.unref();
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				const client = await DaemonClient.connect();
				await client.request("ping", {});
				return client;
			} catch (err) {
				if (Date.now() > deadline) {
					throw new DaemonError(`daemon did not start: ${(err as Error).message}`, "start_timeout");
				}
				await new Promise((r) => setTimeout(r, 50));
			}
		}
	}

	request<O extends Op>(op: O, args: ArgsOf<O>): Promise<ResultOf<O>> {
		return this.requestAt(op, args).then((r) => r.result);
	}

	/**
	 * M22: a request and where its reply was in the stream: events with a higher `position()`
	 * came after it (an event handled before the reply's continuation runs may be newer).
	 */
	requestAt<O extends Op>(op: O, args: ArgsOf<O>): Promise<{ result: ResultOf<O>; at: number }> {
		if (this.closed) return Promise.reject(new DaemonError("daemon connection closed", "closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; at?: number } = {
				resolve: (v) => resolve({ result: v as ResultOf<O>, at: entry.at ?? this.lines }),
				reject,
			};
			this.pending.set(id, entry);
			this.sock.write(encodeLine({ id, op, args }));
		});
	}

	/** M22: the place in the stream of the line being handled now. */
	position(): number {
		return this.lines;
	}

	/** Receive pushed job events; call after request("subscribe", {}). */
	onEvent(listener: (event: Event) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Called once when the connection drops (not after close()). */
	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.closeListeners.clear();
		this.closed = true;
		this.sock.end();
		this.sock.destroy();
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		this.lines++;
		let msg: Response | Event;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if ("event" in msg) {
			// a listener that throws must not cost the lines after it in this chunk
			for (const l of this.listeners) {
				try {
					l(msg);
				} catch (err) {
					queueMicrotask(() => {
						throw err;
					});
				}
			}
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		p.at = this.lines;
		if (msg.ok) p.resolve(msg.result);
		else p.reject(new DaemonError(msg.error, msg.code));
	}
}
