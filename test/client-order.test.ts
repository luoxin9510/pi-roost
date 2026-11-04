import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../lib/client.ts";
import { encodeLine, LineReader } from "../lib/protocol.ts";

let server: Server | undefined;
let dir: string | undefined;
afterEach(() => {
	server?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

// M22: an event sent right after a reply, in the same chunk, is handled before the code
// after the await; requestAt says which events came after the reply.
describe("daemon client order", () => {
	it("tells events after a reply from the ones before it", async () => {
		dir = mkdtempSync("/tmp/co-");
		const sock = join(dir, "d.sock");
		server = createServer((s) => {
			const reader = new LineReader();
			s.on("data", (chunk) => {
				for (const line of reader.push(chunk)) {
					const msg = JSON.parse(line);
					s.write(
						encodeLine({ event: "removed", id: "before" }) +
							encodeLine({ id: msg.id, ok: true, result: { jobs: [] } }) +
							encodeLine({ event: "removed", id: "after" }),
					);
				}
			});
		});
		await new Promise<void>((r) => server!.listen(sock, () => r()));
		const c = await DaemonClient.connect(sock);
		const seen: { id: string; at: number }[] = [];
		c.onEvent((e) => {
			if (e.event === "removed") seen.push({ id: e.id, at: c.position() });
		});
		const { at } = await c.requestAt("list", {});
		expect(seen.map((s) => s.id)).toEqual(["before", "after"]);
		expect(seen.filter((s) => s.at > at).map((s) => s.id)).toEqual(["after"]);
		// a listener that throws costs nothing after it
		c.onEvent(() => {
			throw new Error("boom");
		});
		c.close();
	});
});
