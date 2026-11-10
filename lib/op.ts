// The daemon's small shared pieces: an op's refusal, and how an op reads its arguments.
import { realpathSync } from "node:fs";

/** An op refused: a code the client can test (bad_request, not_found, conflict, …) and words for a person. */
export class OpError extends Error {
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function str(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/** The path with links resolved; the path itself when it cannot be. */
export function realPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Text from an op's argument: control characters as spaces, trimmed, at most `max`. */
export const taskText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trim().slice(0, max) : "");
