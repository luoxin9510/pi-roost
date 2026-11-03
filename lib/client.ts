import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonSocketPath, ensureDirs } from "./paths.ts";
import { type ArgsOf, encodeLine, type Event, LineReader, type Op, type Response, type ResultOf } from "./protocol.ts";

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
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private listeners = new Set<(event: Event) => void>();
	private closed = false;

	private constructor(sock: Socket) {
		this.sock = sock;
		sock.on("data", (chunk) => {
			for (const line of this.reader.push(chunk)) this.onLine(line);
		});
		const fail = (err: Error) => {
			this.closed = true;
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
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
		for (const key of ["PI_JOB_ID", "PI_JOB_TOKEN", "PI_JOB_DIR", "PI_DAEMON_SOCK"]) delete env[key];
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
		if (this.closed) return Promise.reject(new DaemonError("daemon connection closed", "closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.sock.write(encodeLine({ id, op, args }));
		});
	}

	/** Receive pushed job events; call after request("subscribe", {}). */
	onEvent(listener: (event: Event) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		this.closed = true;
		this.sock.end();
		this.sock.destroy();
	}

	private onLine(line: string): void {
		if (!line.trim()) return;
		let msg: Response | Event;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if ("event" in msg) {
			for (const l of this.listeners) l(msg);
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (msg.ok) p.resolve(msg.result);
		else p.reject(new DaemonError(msg.error, msg.code));
	}
}
