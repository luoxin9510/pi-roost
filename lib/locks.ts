import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { readJson } from "./atomic.ts";
import { daemonLockPath } from "./paths.ts";
import { ownStartToken, sameProcess } from "./proc.ts";

export interface LockOwner {
	pid: number;
	token: string;
	at: number;
}

type Holder = LockOwner & Record<string, unknown>;

function isOwner(v: unknown): v is Holder {
	const o = v as Partial<LockOwner> | undefined;
	return !!o && typeof o.pid === "number" && typeof o.token === "string";
}

function readOwner(path: string): Holder | undefined {
	const v = readJson<unknown>(path);
	return isOwner(v) ? v : undefined;
}

function tryCreate(path: string, body: Record<string, unknown>): boolean {
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(body)}\n`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

function unlinkQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}

function ours(h: Holder | undefined): boolean {
	return !!h && h.pid === process.pid && h.token === ownStartToken();
}

// A lock file is created empty and filled right after; a reader in that gap
// must not mistake it for a stale lock and delete it.
const FRESH_MS = 2000;
function isFresh(path: string): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs < FRESH_MS;
	} catch {
		return false;
	}
}

function acquire(
	path: string,
	extra: Record<string, unknown>,
	allowReentry: boolean,
): { ok: true } | { ok: false; holder: Holder } {
	const body = {
		pid: process.pid,
		token: ownStartToken() ?? "",
		at: Date.now(),
		...extra,
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		if (tryCreate(path, body)) return { ok: true };
		const holder = readOwner(path);
		if (holder) {
			if (allowReentry && ours(holder)) return { ok: true };
			if (sameProcess(holder.pid, holder.token)) return { ok: false, holder };
		} else if (isFresh(path)) {
			return { ok: false, holder: { pid: 0, token: "", at: 0 } };
		}
		// stale or unreadable: remove and retry once
		unlinkQuiet(path);
	}
	const holder = readOwner(path);
	if (holder) return { ok: false, holder };
	return { ok: false, holder: { pid: 0, token: "", at: 0 } };
}

function release(path: string): void {
	if (ours(readOwner(path))) unlinkQuiet(path);
}

export function acquireDaemonLock(
	extra: Record<string, unknown>,
): { ok: true } | { ok: false; holder: LockOwner & Record<string, unknown> } {
	return acquire(daemonLockPath(), extra, false);
}

export function releaseDaemonLock(): void {
	release(daemonLockPath());
}

export function readDaemonLock(): (LockOwner & Record<string, unknown>) | undefined {
	return readOwner(daemonLockPath());
}

const writerLockPath = (file: string) => `${file}.lock`;

export function acquireWriterLock(file: string): { ok: true } | { ok: false; holder: LockOwner } {
	mkdirSync(dirname(file), { recursive: true });
	return acquire(writerLockPath(file), {}, true);
}

export function releaseWriterLock(file: string): void {
	release(writerLockPath(file));
}

export function readWriterLock(file: string): LockOwner | undefined {
	const h = readOwner(writerLockPath(file));
	return h && sameProcess(h.pid, h.token) ? h : undefined;
}
