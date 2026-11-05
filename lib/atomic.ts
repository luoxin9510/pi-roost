import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function fsyncDir(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EACCES") throw err;
	}
}

/**
 * M35: group commit. A process that turns it on (the daemon) makes its durable writes'
 * fsyncs wait for the next turn of the loop, done there off the main thread (the libuv
 * pool), each file and directory once however often it was written; `durable()` resolves
 * once every write made so far is on disk. The daemon answers a request only after it.
 */
let deferred: { files: Set<string>; dirs: Set<string> } | undefined;
/** The last batch; it never rejects (a batch's error goes to its own callers only). */
let syncing: Promise<void> = Promise.resolve();
let queued = false;
let onSyncError: (err: unknown) => void = () => {};

/** Where a failed background sync is reported (the daemon logs it). */
export function setSyncErrorHandler(fn: (err: unknown) => void): void {
	onSyncError = fn;
}

/** At most this many files open at once for syncing (descriptors are limited). */
const SYNC_PARALLEL = 32;
async function syncAll(paths: string[]): Promise<void> {
	for (let i = 0; i < paths.length; i += SYNC_PARALLEL) await Promise.all(paths.slice(i, i + SYNC_PARALLEL).map(syncPath));
}

export function deferDurability(on: boolean): void {
	deferred = on ? (deferred ?? { files: new Set(), dirs: new Set() }) : undefined;
}

async function syncPath(path: string): Promise<void> {
	let fh: Awaited<ReturnType<typeof open>> | undefined;
	try {
		fh = await open(path, "r");
		await fh.sync();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// gone since (a removed job), or a directory that cannot be synced here
		if (code !== "ENOENT" && code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EACCES") throw err;
	} finally {
		await fh?.close().catch(() => {});
	}
}

/** Resolves when every durable write made so far is synced. */
export function durable(): Promise<void> {
	return syncDeferred();
}

function syncDeferred(): Promise<void> {
	const d = deferred;
	if (!d || (d.files.size === 0 && d.dirs.size === 0)) return syncing;
	const files = [...d.files];
	const dirs = [...d.dirs];
	d.files.clear();
	d.dirs.clear();
	// files first, then the directories that name them (as the synchronous path does);
	// after the batches before it, whatever became of them
	const batch = syncing.then(async () => {
		await syncAll(files);
		await syncAll(dirs);
	});
	syncing = batch.catch(() => {});
	return batch;
}

/**
 * Write by a temporary file and a rename: a reader never sees half a file, even if this
 * process dies mid-write. `durable` (the default) also fsyncs the file and its directory,
 * so the write survives a machine crash; that costs milliseconds (about 8 on macOS) and
 * blocks the caller, so data that the next write replaces anyway can skip it (M35).
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600, durable = true): void {
	const dir = dirname(path);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const fd = openSync(tmp, "wx", mode);
	try {
		const buf = typeof data === "string" ? Buffer.from(data) : data;
		let off = 0;
		while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
		if (durable && !deferred) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	if (!durable) return;
	if (!deferred) return fsyncDir(dir);
	deferred.files.add(path);
	deferred.dirs.add(dir);
	if (!queued) {
		queued = true;
		setImmediate(() => {
			queued = false;
			void syncDeferred().catch((err) => onSyncError(err));
		});
	}
}

export function writeJsonAtomic(path: string, value: unknown, durable = true): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600, durable);
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}
