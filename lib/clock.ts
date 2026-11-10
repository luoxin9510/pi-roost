// The time a module runs by: the system's in the daemon, a manual one in tests
// (test/support/clock.ts), so a test of "every 30 seconds" moves the clock instead of waiting.

export interface Timer {
	clear(): void;
}

export interface Clock {
	now(): number;
	/** A timer that does not keep the process alive. */
	timer(fn: () => void, ms: number): Timer;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	timer: (fn, ms) => {
		const h = setTimeout(fn, ms);
		h.unref?.();
		return { clear: () => clearTimeout(h) };
	},
};
