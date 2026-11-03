// tsc rewrites "./x.ts" imports to "./x.js" in emitted JavaScript but not in .d.ts
// files, whose ".ts" targets are not in the package: point them at the .js/.d.ts pair.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
for (const file of walk("dist").filter((f) => f.endsWith(".d.ts"))) {
	const src = readFileSync(file, "utf8");
	const out = src.replace(/(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, "$1$2$3.js$2");
	if (out !== src) writeFileSync(file, out);
}
