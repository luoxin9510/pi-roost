import { describe, expect, it } from "vitest";
import { fitScreen } from "../extensions/agent-view.ts";

const L = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe("fitScreen", () => {
	it("pads a short list so the input sits on the last lines", () => {
		const out = fitScreen([...L(3, "t"), ...L(2, "b")], 8, 2, 3);
		expect(out).toEqual(["t0", "t1", "t2", "", "", "", "b0", "b1"]);
	});

	it("fills from the top without a bottom block (picker, help)", () => {
		expect(fitScreen(L(2, "x"), 4, -1, -1)).toEqual(["x0", "x1", "", ""]);
	});

	it("keeps the title and the selection visible in a long list", () => {
		const top = L(40, "t");
		for (const sel of [2, 10, 25, 39]) {
			const out = fitScreen([...top, ...L(3, "b")], 12, sel, 40);
			expect(out).toHaveLength(12);
			expect(out.slice(0, 2)).toEqual(["t0", "t1"]);
			expect(out).toContain(`t${sel}`);
			expect(out.slice(-3)).toEqual(["b0", "b1", "b2"]);
		}
	});

	it("never returns more lines than the terminal has", () => {
		expect(fitScreen(L(5, "t"), 3, 0, 1)).toHaveLength(3);
		expect(fitScreen(L(50, "t"), 3, -1, -1)).toHaveLength(3);
	});
});
