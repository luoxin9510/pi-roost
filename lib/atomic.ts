import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
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

export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
	const dir = dirname(path);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const fd = openSync(tmp, "wx", mode);
	try {
		const buf = typeof data === "string" ? Buffer.from(data) : data;
		let off = 0;
		while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
	fsyncDir(dir);
}

export function writeJsonAtomic(path: string, value: unknown): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}
