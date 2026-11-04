import { describe, expect, it } from "vitest";
import { isLocalDetach, localDetachAt } from "../lib/attach.ts";

// M22: Ctrl+Z that reaches a background pi suspends its UI for good: the client must find
// it wherever it is in the input and however the terminal encodes it.
describe("local detach key", () => {
	it("is found alone and among other keys, in every encoding", () => {
		expect(isLocalDetach(Buffer.from("\x1a"))).toBe(true);
		expect(isLocalDetach(Buffer.from("\x1b[122;5u"))).toBe(true);
		expect(localDetachAt("xyz\x1a")).toMatchObject({ at: 3, end: 4 });
		expect(localDetachAt("ab\x1b[122;5:2ucd")).toMatchObject({ at: 2 });
		// Caps Lock (64) and Num Lock (128) on
		expect(localDetachAt("\x1b[122;69u").at).toBe(0);
		expect(localDetachAt("\x1b[122;133u").at).toBe(0);
		// alternate keys and associated text (kitty flags 4 and 16)
		expect(localDetachAt("\x1b[122:90;5u").at).toBe(0);
		expect(localDetachAt("\x1b[122::122;5;26u").at).toBe(0);
		// xterm modifyOtherKeys
		expect(localDetachAt("\x1b[27;5;122~").at).toBe(0);
	});

	it("is not a release, another modifier, plain z, or text inside a paste", () => {
		expect(localDetachAt("\x1b[122;5:3u").at).toBe(-1);
		expect(localDetachAt("\x1b[122;6u").at).toBe(-1); // Ctrl+Shift+Z
		expect(localDetachAt("\x1b[122;7u").at).toBe(-1); // Ctrl+Alt+Z
		expect(localDetachAt("z\x1b[122u").at).toBe(-1);
		expect(localDetachAt("\x1b[200~a\x1ab\x1b[201~").at).toBe(-1);
		// a paste across chunks
		const first = localDetachAt("\x1b[200~abc");
		expect(first).toMatchObject({ at: -1, pasting: true });
		expect(localDetachAt("d\x1ae", first.pasting).at).toBe(-1);
		expect(localDetachAt("\x1b[201~\x1a", true).at).toBe(6);
	});
});
