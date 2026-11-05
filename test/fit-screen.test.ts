import { describe, expect, it } from "vitest";
import { fitScreen } from "../hub/agent-view.ts";

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

	it("shows a peeked row's reply input, and the row when it fits", () => {
		// row 20, its peek 21..26 (the reply input last), bottom from 27
		const out = fitScreen([...L(27, "L"), ...L(2, "b")], 12, 20, 27, { selectedEnd: 26 });
		expect(out).toContain("L26");
		expect(out).toContain("L20");
		expect(out.slice(-2)).toEqual(["b0", "b1"]);
	});

	it("a peek taller than the screen keeps its end", () => {
		const out = fitScreen([...L(40, "L"), "b"], 8, 5, 40, { selectedEnd: 30 });
		expect(out).toContain("L30");
		expect(out).toHaveLength(8);
	});

	it("a tiny screen gives up the title before the selection", () => {
		expect(fitScreen([...L(10, "L"), "A", "B"], 3, 7, 10)).toEqual(["L7", "A", "B"]);
		expect(fitScreen([...L(10, "L"), "A", "B"], 4, 7, 10)).toEqual(["L0", "L7", "A", "B"]);
		expect(fitScreen([...L(10, "L"), "A"], 5, 7, 10, { keep: 1 })).toEqual(["L0", "L6", "L7", "L8", "A"]);
	});
});
