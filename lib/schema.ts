// M75: a minimal schema builder, no dependencies (the daemon, the hub and the hosts import the
// protocol and run without pi, so without pi's libraries). A schema is a plain JSON-Schema-shaped
// object (type, properties, required, anyOf, const, enum, items, additionalProperties,
// minLength, maxLength, pattern, minimum, maximum, description, title) that the doc generator
// reads and pi's tools can hand to pi's schema type; a phantom type gives `Infer<S>`.
// `message` (not JSON Schema) is the exact error text a hand check says today, for `check`.

export interface Meta {
	description?: string;
	title?: string;
	/** What `check` says when this value is wrong. */
	message?: string;
}

/** A JSON-Schema-shaped object; `T` is the TypeScript type of the values it accepts (never present at run time). */
export interface Schema<T = unknown> extends Meta {
	readonly "~type": T;
	type?: "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";
	const?: string | number | boolean;
	enum?: string[];
	anyOf?: Schema[];
	items?: Schema;
	properties?: Record<string, Schema>;
	required?: string[];
	additionalProperties?: Schema;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const OPTIONAL = Symbol("optional");
/** A field that may be left out (see `optional`). */
export interface OptionalField<S extends Schema = Schema> {
	readonly [OPTIONAL]: true;
	readonly schema: S;
}
type Field = Schema | OptionalField;
type Fields = Record<string, Field>;
type Plain<F> = F extends OptionalField<infer S> ? S : F;
type Flat<T> = { [K in keyof T]: T[K] } & {};
type ObjectOf<P extends Fields> = Flat<
	{ [K in keyof P as P[K] extends OptionalField ? never : K]: Infer<Plain<P[K]>> } & { [K in keyof P as P[K] extends OptionalField ? K : never]?: Infer<Plain<P[K]>> }
>;

const make = <T>(json: Omit<Schema<T>, "~type">, meta: Meta = {}): Schema<T> => {
	const out: Record<string, unknown> = { ...json };
	for (const k of ["title", "description", "message"] as const) if (meta[k] !== undefined) out[k] = meta[k];
	return out as unknown as Schema<T>;
};

export const str = (o: Meta & { min?: number; max?: number; pattern?: string } = {}): Schema<string> =>
	make({ type: "string", ...(o.min !== undefined ? { minLength: o.min } : {}), ...(o.max !== undefined ? { maxLength: o.max } : {}), ...(o.pattern !== undefined ? { pattern: o.pattern } : {}) }, o);
export const num = (o: Meta & { int?: boolean; min?: number; max?: number } = {}): Schema<number> =>
	make({ type: o.int ? "integer" : "number", ...(o.min !== undefined ? { minimum: o.min } : {}), ...(o.max !== undefined ? { maximum: o.max } : {}) }, o);
export const bool = (o: Meta = {}): Schema<boolean> => make({ type: "boolean" }, o);
export const nul = (o: Meta = {}): Schema<null> => make({ type: "null" }, o);
export const literal = <const V extends string | number | boolean>(v: V, o: Meta = {}): Schema<V> => make({ const: v }, o);
/** A string that is one of these. */
export const oneOf = <const V extends string>(values: readonly V[], o: Meta = {}): Schema<V> => make({ type: "string", enum: [...values] }, o);
/** Plain, or discriminated by a literal field (`check` then reports the matching member's error). */
export const union = <const M extends readonly Schema[]>(members: M, o: Meta = {}): Schema<Infer<M[number]>> => make({ anyOf: [...members] }, o);
export const nullable = <S extends Schema>(s: S, o: Meta = {}): Schema<Infer<S> | null> => union([s, nul()], o);
export const arr = <S extends Schema>(item: S, o: Meta & { min?: number; max?: number } = {}): Schema<Infer<S>[]> =>
	make({ type: "array", items: item, ...(o.min !== undefined ? { minItems: o.min } : {}), ...(o.max !== undefined ? { maxItems: o.max } : {}) }, o);
/** A string-keyed record. */
export const rec = <S extends Schema>(value: S, o: Meta = {}): Schema<Record<string, Infer<S>>> => make({ type: "object", additionalProperties: value }, o);
export const optional = <S extends Schema>(schema: S): OptionalField<S> => ({ [OPTIONAL]: true, schema });
export const obj = <P extends Fields>(fields: P, o: Meta = {}): Schema<ObjectOf<P>> => {
	const properties: Record<string, Schema> = {};
	const required: string[] = [];
	for (const [k, f] of Object.entries(fields)) {
		const isOpt = OPTIONAL in f;
		properties[k] = isOpt ? (f as OptionalField).schema : (f as Schema);
		if (!isOpt) required.push(k);
	}
	return make({ type: "object", properties, ...(required.length ? { required } : {}) }, o);
};
/** An object with no fields (`Record<string, never>`); like `obj({})` to `check`: other keys are ignored. */
export const empty = (o: Meta = {}): Schema<Record<string, never>> => make({ type: "object", properties: {} }, o);
/** A type another module owns (its interface stays there): checked only as an object. */
export const opaque = <T>(title: string, description: string): Schema<T> => make({ type: "object", title }, { description });
/** Anything. */
export const unknown = (o: Meta = {}): Schema<unknown> => make({}, o);

export type CheckResult = { ok: true } | { ok: false; path: string; message: string };
const fail = (s: Schema, path: string, fallback: string): CheckResult => ({ ok: false, path, message: s.message ?? fallback });
const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** Whether `value` is what `schema` says; the first failure's path ("launch.env", "ids[2]") and message. Unknown fields are ignored. */
export function check(schema: Schema, value: unknown, path = ""): CheckResult {
	const s = schema;
	if (s.anyOf) return checkAnyOf(s, value, path);
	if (s.const !== undefined) return value === s.const ? { ok: true } : fail(s, path, `must be ${JSON.stringify(s.const)}`);
	if (s.enum) return typeof value === "string" && s.enum.includes(value) ? { ok: true } : fail(s, path, `must be one of ${s.enum.join(", ")}`);
	switch (s.type) {
		case "string": {
			if (typeof value !== "string") return fail(s, path, "must be a string");
			if (s.minLength !== undefined && value.length < s.minLength) return fail(s, path, `must be at least ${s.minLength} characters`);
			if (s.maxLength !== undefined && value.length > s.maxLength) return fail(s, path, `must be at most ${s.maxLength} characters`);
			if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) return fail(s, path, `must match ${s.pattern}`);
			return { ok: true };
		}
		case "number":
		case "integer": {
			if (typeof value !== "number" || !Number.isFinite(value)) return fail(s, path, "must be a number");
			if (s.type === "integer" && !Number.isInteger(value)) return fail(s, path, "must be an integer");
			if (s.minimum !== undefined && value < s.minimum) return fail(s, path, `must be at least ${s.minimum}`);
			if (s.maximum !== undefined && value > s.maximum) return fail(s, path, `must be at most ${s.maximum}`);
			return { ok: true };
		}
		case "boolean":
			return typeof value === "boolean" ? { ok: true } : fail(s, path, "must be a boolean");
		case "null":
			return value === null ? { ok: true } : fail(s, path, "must be null");
		case "array": {
			if (!Array.isArray(value)) return fail(s, path, "must be an array");
			if (s.minItems !== undefined && value.length < s.minItems) return fail(s, path, `must have at least ${s.minItems} items`);
			if (s.maxItems !== undefined && value.length > s.maxItems) return fail(s, path, `must have at most ${s.maxItems} items`);
			for (let i = 0; i < value.length; i++) {
				const r = check(s.items!, value[i], `${path}[${i}]`);
				if (!r.ok) return r;
			}
			return { ok: true };
		}
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(s, path, "must be an object");
			const o = value as Record<string, unknown>;
			for (const [k, p] of Object.entries(s.properties ?? {})) {
				if (o[k] === undefined) {
					if (s.required?.includes(k)) return fail(p, join(path, k), "is required");
					continue;
				}
				const r = check(p, o[k], join(path, k));
				if (!r.ok) return r;
			}
			if (s.additionalProperties) {
				for (const [k, v] of Object.entries(o)) {
					const r = check(s.additionalProperties, v, join(path, k));
					if (!r.ok) return r;
				}
			}
			return { ok: true };
		}
		default:
			return { ok: true };
	}
}

function checkAnyOf(s: Schema, value: unknown, path: string): CheckResult {
	const members = s.anyOf!;
	const results = members.map((m) => check(m, value, path));
	if (results.some((r) => r.ok)) return { ok: true };
	// a discriminated member (its literal fields match the value) says what is wrong with it
	if (typeof value === "object" && value !== null) {
		const o = value as Record<string, unknown>;
		const i = members.findIndex((m) => m.properties && Object.entries(m.properties).some(([k, p]) => (p.const !== undefined || p.enum) && check(p, o[k]).ok && o[k] !== undefined));
		if (i >= 0) return results[i];
	}
	const real = members.filter((m) => m.type !== "null");
	if (real.length === 1) return results[members.indexOf(real[0])];
	return fail(s, path, "does not match any of the allowed forms");
}
