// M71: an in-memory RoostPort for overlay tests: every method is recorded by its dotted path
// ("tasks.merge") and answers what `answers` gives for that path, else `{}`.
import type { RoostPort } from "../../hub/roost-port.ts";

export interface FakePort {
	port: RoostPort;
	calls: { path: string; args: unknown[] }[];
}

export function fakePort(answers: Record<string, (...args: any[]) => unknown> = {}): FakePort {
	const calls: FakePort["calls"] = [];
	const node = (path: string[]): unknown =>
		new Proxy(() => {}, {
			get: (_t, key) => (typeof key === "string" ? node([...path, key]) : undefined),
			apply: (_t, _this, args: unknown[]) => {
				const name = path.join(".");
				calls.push({ path: name, args });
				return Promise.resolve(answers[name] ? answers[name]!(...args) : {});
			},
		});
	return { port: node([]) as RoostPort, calls };
}
