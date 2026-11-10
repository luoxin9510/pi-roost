import type { Clock } from "../../lib/clock.ts";

/**
 * A clock a test moves. `advance(ms)` fires the timers that come due, in their order, each
 * at its own time (a timer set while one fires, and due within the advance, fires too: a
 * 15-second ticker advanced a minute fires four times).
 */
export function manualClock(start = 0) {
	let t = start;
	const timers: { at: number; seq: number; fn: () => void; done: boolean }[] = [];
	let seq = 0;
	const clock: Clock = {
		now: () => t,
		timer: (fn, ms) => {
			const x = { at: t + Math.max(0, ms), seq: seq++, fn, done: false };
			timers.push(x);
			return { clear: () => void (x.done = true) };
		},
	};
	const advance = (ms: number) => {
		const end = t + ms;
		for (;;) {
			const due = timers.filter((x) => !x.done && x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
			if (!due) break;
			due.done = true;
			t = Math.max(t, due.at);
			due.fn();
		}
		t = end;
	};
	/** The timers waiting (not fired, not cleared). */
	const pending = () => timers.filter((x) => !x.done).length;
	return { clock, advance, pending };
}
