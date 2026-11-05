import { execFile, execFileSync } from "node:child_process";

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function processStartToken(pid: number): string | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, LC_ALL: "C" },
		}).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

/** M35: the same, without blocking the event loop (a ps per call). */
export function processStartTokenAsync(pid: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }, (err, out) => {
			resolve(err ? undefined : out.trim() || undefined);
		});
	});
}

export function sameProcess(pid: number, token: string): boolean {
	return processStartToken(pid) === token;
}

let ownToken: string | undefined;
export function ownStartToken(): string | undefined {
	ownToken ??= processStartToken(process.pid);
	return ownToken;
}
