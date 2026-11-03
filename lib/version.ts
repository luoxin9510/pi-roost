import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
		}
		const parent = dirname(dir);
		if (parent === dir) return "0.0.0";
		dir = parent;
	}
}

export const ROOST_VERSION = readVersion();
