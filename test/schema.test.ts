// M75: lib/schema.ts, the protocol's own schema builder (no dependencies).
import { describe, expect, expectTypeOf, it } from "vitest";
import { arr, bool, check, discriminantValues, type Infer, literal, loose, looseOf, nul, nullable, num, obj, oneOf, opaque, optional, rec, str, union, unknown } from "../lib/schema.ts";

const fails = (r: ReturnType<typeof check>) => (r.ok ? "ok" : `${r.path}: ${r.message}`);

describe("Infer", () => {
	it("gives the exact TypeScript type", () => {
		const S = obj({
			a: str(),
			b: optional(num({ int: true })),
			c: nullable(bool()),
			d: optional(nullable(arr(str()))),
			e: rec(num()),
			f: oneOf(["x", "y"]),
			g: literal("k"),
			h: opaque<{ q: 1 }>("Q", "a q"),
		});
		expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{ a: string; b?: number; c: boolean | null; d?: string[] | null; e: Record<string, number>; f: "x" | "y"; g: "k"; h: { q: 1 } }>();
		const U = union([obj({ k: literal("one"), n: num() }), obj({ k: literal("two") })]);
		expectTypeOf<Infer<typeof U>>().toEqualTypeOf<{ k: "one"; n: number } | { k: "two" }>();
		expectTypeOf<Infer<ReturnType<typeof unknown>>>().toEqualTypeOf<unknown>();
		expectTypeOf<Infer<ReturnType<typeof nul>>>().toEqualTypeOf<null>();
	});
});

describe("the JSON shape", () => {
	it("is a plain JSON-Schema-shaped object", () => {
		const S = obj({ a: str({ min: 1, max: 5, pattern: "^x", description: "an a" }), b: optional(num({ int: true, min: 0, max: 9 })), c: arr(str(), { max: 3 }), d: rec(bool()), e: nullable(str()) }, { title: "T", message: "bad T" });
		expect(JSON.parse(JSON.stringify(S))).toEqual({
			type: "object",
			title: "T",
			message: "bad T",
			required: ["a", "c", "d", "e"],
			properties: {
				a: { type: "string", minLength: 1, maxLength: 5, pattern: "^x", description: "an a" },
				b: { type: "integer", minimum: 0, maximum: 9 },
				c: { type: "array", items: { type: "string" }, maxItems: 3 },
				d: { type: "object", additionalProperties: { type: "boolean" } },
				e: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
		});
		expect(JSON.parse(JSON.stringify(obj({})))).toEqual({ type: "object", properties: {} });
		expect(JSON.parse(JSON.stringify(literal(3)))).toEqual({ const: 3 });
		expect(JSON.parse(JSON.stringify(oneOf(["a", "b"])))).toEqual({ type: "string", enum: ["a", "b"] });
		expect(JSON.parse(JSON.stringify(opaque("X", "an x")))).toEqual({ type: "object", title: "X", description: "an x" });
	});
});

describe("check", () => {
	it("accepts what fits, ignoring unknown fields", () => {
		const S = obj({ a: str(), b: optional(num()) });
		expect(check(S, { a: "x" })).toEqual({ ok: true });
		expect(check(S, { a: "x", b: 2, extra: 1 })).toEqual({ ok: true });
		expect(check(unknown(), 5)).toEqual({ ok: true });
	});

	it("names a missing required field, and an undefined one", () => {
		const S = obj({ a: str() });
		expect(fails(check(S, {}))).toBe("a: is required");
		expect(fails(check(S, { a: undefined }))).toBe("a: is required");
	});

	it("checks each kind's type", () => {
		expect(fails(check(str(), 1))).toBe(": must be a string");
		expect(fails(check(num(), "1"))).toBe(": must be a number");
		expect(fails(check(num(), Number.NaN))).toBe(": must be a number");
		expect(fails(check(num({ int: true }), 1.5))).toBe(": must be an integer");
		expect(fails(check(bool(), 0))).toBe(": must be a boolean");
		expect(fails(check(nul(), 0))).toBe(": must be null");
		expect(fails(check(arr(str()), "x"))).toBe(": must be an array");
		expect(fails(check(obj({}), []))).toBe(": must be an object");
		expect(fails(check(obj({}), null))).toBe(": must be an object");
		expect(fails(check(literal("a"), "b"))).toBe(': must be "a"');
		expect(fails(check(oneOf(["a", "b"]), "c"))).toBe(": must be one of a, b");
		expect(fails(check(oneOf(["a", "b"]), 1))).toBe(": must be one of a, b");
	});

	it("checks limits and patterns", () => {
		expect(fails(check(str({ max: 3 }), "abcd"))).toBe(": must be at most 3 characters");
		expect(fails(check(str({ min: 2 }), "a"))).toBe(": must be at least 2 characters");
		expect(fails(check(str({ pattern: "^[a-z]+$" }), "A1"))).toBe(": must match ^[a-z]+$");
		expect(check(str({ min: 2, max: 3, pattern: "^[a-z]+$" }), "abc")).toEqual({ ok: true });
		expect(fails(check(num({ min: 1 }), 0))).toBe(": must be at least 1");
		expect(fails(check(num({ max: 1 }), 2))).toBe(": must be at most 1");
		expect(fails(check(arr(str(), { max: 1 }), ["a", "b"]))).toBe(": must have at most 1 items");
		expect(fails(check(arr(str(), { min: 1 }), []))).toBe(": must have at least 1 items");
	});

	it("reports the path of a nested failure", () => {
		const S = obj({ launch: obj({ env: rec(str()), ids: arr(num()) }) });
		expect(fails(check(S, { launch: { env: { A: 1 }, ids: [] } }))).toBe("launch.env.A: must be a string");
		expect(fails(check(S, { launch: { env: {}, ids: [1, "x"] } }))).toBe("launch.ids[1]: must be a number");
		expect(fails(check(S, { launch: { ids: [] } }))).toBe("launch.env: is required");
	});

	it("uses a schema's own message", () => {
		const S = obj({ protocol: num({ int: true, min: 1, message: "protocol must be a version number" }), t: str({ message: "t is text" }) });
		expect(fails(check(S, { protocol: 0, t: "x" }))).toBe("protocol: protocol must be a version number");
		expect(fails(check(S, { t: "x" }))).toBe("protocol: protocol must be a version number");
		expect(fails(check(S, { protocol: 1, t: 4 }))).toBe("t: t is text");
	});

	it("checks unions: a member, the discriminated member's error, nullable", () => {
		const U = union([obj({ action: literal("add"), title: str() }), obj({ action: literal("rm"), id: num() })]);
		expect(check(U, { action: "rm", id: 1 })).toEqual({ ok: true });
		expect(fails(check(U, { action: "add" }))).toBe("title: is required");
		expect(fails(check(U, { action: "rm", id: "x" }))).toBe("id: must be a number");
		expect(fails(check(U, { action: "nope" }))).toBe(": does not match any of the allowed forms");
		expect(fails(check(U, 3))).toBe(": does not match any of the allowed forms");
		const N = nullable(str({ max: 2 }));
		expect(check(N, null)).toEqual({ ok: true });
		expect(check(N, "ab")).toEqual({ ok: true });
		expect(fails(check(N, "abc"))).toBe(": must be at most 2 characters");
		expect(fails(check(N, 3))).toBe(": must be a string");
		expect(fails(check(union([str(), num()], { message: "a string or a number" }), true))).toBe(": a string or a number");
	});
});

// M76: what the daemon's entry check needs to say what the hand checks said
describe("check, for the entry check", () => {
	it("passes anything for a loose field, a missing required one too; the type and the shape stay", () => {
		const inner = str({ min: 3 });
		const S = obj({ a: loose(inner), b: num() });
		expect(fails(check(S, { b: 1 }))).toBe("ok");
		expect(fails(check(S, { a: 5, b: 1 }))).toBe("ok");
		expect(fails(check(S, {}))).toBe("b: is required");
		expectTypeOf<Infer<typeof S>>().toEqualTypeOf<{ a: string; b: number }>();
		expect(S.required).toEqual(["a", "b"]);
		expect(looseOf.get(S.properties!.a!)).toBe(inner);
	});

	it("trims before the limits when told, and a cut or op-refused maximum is not refused", () => {
		const T = str({ min: 1, trim: true, message: "empty" });
		expect(fails(check(T, "  \n\t "))).toBe(": empty");
		expect(fails(check(T, " x "))).toBe("ok");
		expect(fails(check(T, 3))).toBe(": empty");
		const P = str({ pattern: "^ab$", trim: true });
		expect(fails(check(P, " ab "))).toBe("ok");
		expect(fails(check(str({ max: 3, trim: true }), "  abc  "))).toBe("ok");
		expect(fails(check(str({ max: 3 }), "  abc  "))).toBe(": must be at most 3 characters");
		expect(fails(check(str({ max: 3, maxBy: "cut" }), "abcdef"))).toBe("ok");
		expect(fails(check(str({ max: 3, maxBy: "op" }), "abcdef"))).toBe("ok");
		expect(fails(check(str({ min: 2, max: 3, maxBy: "cut" }), "a"))).toBe(": must be at least 2 characters");
	});

	it("picks a discriminated member by its discriminant only; another value gets the union's words", () => {
		const U = union(
			[
				obj({ action: literal("merge"), mode: optional(oneOf(["ff", "no-ff"])) }),
				obj({ action: oneOf(["a", "b"]), n: num({ message: "n please" }) }),
				obj({ action: literal("other"), mode: literal("ff") }),
			],
			{ discriminant: "action", message: "action must be merge, a, b or other" },
		);
		expect(discriminantValues(U, "action")).toEqual(["merge", "a", "b", "other"]);
		expect(fails(check(U, { action: "bogus", mode: "ff" }))).toBe("action: action must be merge, a, b or other");
		expect(fails(check(U, {}))).toBe("action: action must be merge, a, b or other");
		expect(fails(check(U, "x"))).toBe("action: action must be merge, a, b or other");
		expect(fails(check(U, { action: "b" }))).toBe("n: n please");
		expect(fails(check(U, { action: "a", n: 2 }))).toBe("ok");
		expect(fails(check(U, { action: "merge", mode: "x" }))).toBe("mode: must be one of ff, no-ff");
		expect(fails(check(union([obj({ k: literal("x") })], { discriminant: "k" }), { k: "y" }))).toBe("k: must be one of x");
	});
});
