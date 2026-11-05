/**
 * roost's telemetry (docs/plans/evals.md): spans, events, counters and histograms, in the
 * shape of pi's vendor-neutral contract (@earendil-works/pi-telemetry) without depending
 * on it. A span is started around a callback and settles with it (no public end()); a
 * callback that throws or rejects sets an error status. Sinks: nothing (the default), a
 * JSON-lines file (ROOST_TELEMETRY=path), or memory (tests). An adapter to pi-telemetry
 * or OpenTelemetry reads the same records.
 */
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export type Attributes = Record<string, string | number | boolean | null>;
export type SpanStatus = { status: "ok" } | { status: "error"; error: { name: string; message: string } };

export interface SpanOptions {
	name: string;
	attributes?: Attributes;
}

export interface TelemetrySpan {
	readonly id: string;
	setAttributes(a: Attributes): void;
	addEvent(name: string, a?: Attributes): void;
	setStatus(s: SpanStatus): void;
	/** A child span. */
	startSpan<T>(o: SpanOptions, fn: (span: TelemetrySpan) => T): T;
}

export interface Counter {
	add(value: number, a?: Attributes): void;
}
export interface Histogram {
	record(value: number, a?: Attributes): void;
}

export interface Telemetry {
	readonly enabled: boolean;
	startSpan<T>(o: SpanOptions, fn: (span: TelemetrySpan) => T): T;
	counter(name: string): Counter;
	histogram(name: string): Histogram;
}

export type TelemetryRecord =
	| {
			t: "span";
			id: string;
			parent: string | null;
			name: string;
			start: number;
			end: number;
			ms: number;
			attributes: Attributes;
			events: { name: string; at: number; attributes?: Attributes }[];
			status: SpanStatus;
			proc: string;
	  }
	| { t: "metric"; kind: "counter" | "histogram"; name: string; value: number; at: number; attributes?: Attributes; proc: string };

export type Sink = (r: TelemetryRecord) => void;

const NOOP_SPAN: TelemetrySpan = {
	id: "",
	setAttributes() {},
	addEvent() {},
	setStatus() {},
	startSpan: (_o, fn) => fn(NOOP_SPAN),
};

/** Does nothing, at no cost: what every component gets unless telemetry is on. */
export const NOOP_TELEMETRY: Telemetry = {
	enabled: false,
	startSpan: (_o, fn) => fn(NOOP_SPAN),
	counter: () => ({ add() {} }),
	histogram: () => ({ record() {} }),
};

const isPromise = (v: unknown): v is Promise<unknown> => !!v && typeof (v as Promise<unknown>).then === "function";

function errorStatus(err: unknown): SpanStatus {
	const e = err instanceof Error ? err : new Error(String(err));
	return { status: "error", error: { name: e.name, message: e.message.slice(0, 500) } };
}

/** Telemetry that hands every finished span and metric point to `sink`. `proc` names the process (daemon, host-<id>). */
export function createTelemetry(sink: Sink, proc: string, now: () => number = Date.now): Telemetry {
	const start = <T>(parent: string | null, o: SpanOptions, fn: (span: TelemetrySpan) => T): T => {
		const id = randomBytes(6).toString("hex");
		const begun = now();
		const attributes: Attributes = { ...o.attributes };
		const events: { name: string; at: number; attributes?: Attributes }[] = [];
		let status: SpanStatus = { status: "ok" };
		let explicit = false;
		const span: TelemetrySpan = {
			id,
			setAttributes: (a) => Object.assign(attributes, a),
			addEvent: (name, a) => void events.push({ name, at: now(), ...(a ? { attributes: a } : {}) }),
			setStatus: (s) => {
				status = s;
				explicit = true;
			},
			startSpan: (co, cfn) => start(id, co, cfn),
		};
		const finish = (err?: unknown) => {
			if (err !== undefined && !explicit) status = errorStatus(err);
			const end = now();
			try {
				sink({ t: "span", id, parent, name: o.name, start: begun, end, ms: end - begun, attributes, events, status, proc });
			} catch {}
		};
		let out: T;
		try {
			out = fn(span);
		} catch (err) {
			finish(err);
			throw err;
		}
		if (isPromise(out)) {
			return out.then(
				(v) => {
					finish();
					return v;
				},
				(err) => {
					finish(err);
					throw err;
				},
			) as T;
		}
		finish();
		return out;
	};
	const point = (kind: "counter" | "histogram", name: string, value: number, a?: Attributes) => {
		if (!Number.isFinite(value)) return;
		try {
			sink({ t: "metric", kind, name, value, at: now(), ...(a ? { attributes: a } : {}), proc });
		} catch {}
	};
	return {
		enabled: true,
		startSpan: (o, fn) => start(null, o, fn),
		counter: (name) => ({ add: (v, a) => point("counter", name, v, a) }),
		histogram: (name) => ({ record: (v, a) => point("histogram", name, v, a) }),
	};
}

/** In memory, for tests. */
export function memoryTelemetry(proc = "test"): { telemetry: Telemetry; records: TelemetryRecord[] } {
	const records: TelemetryRecord[] = [];
	return { telemetry: createTelemetry((r) => records.push(r), proc), records };
}

/**
 * A JSON-lines file, written in batches (every 250 ms and at exit): a stress run makes
 * thousands of records, and the daemon's loop must not wait on each one.
 */
export function fileTelemetry(path: string, proc: string): Telemetry {
	let buf: string[] = [];
	const flush = () => {
		if (buf.length === 0) return;
		const out = buf.join("");
		buf = [];
		try {
			appendFileSync(path, out, { mode: 0o600 });
		} catch {}
	};
	const timer = setInterval(flush, 250);
	timer.unref?.();
	process.once("exit", flush);
	return createTelemetry((r) => {
		buf.push(`${JSON.stringify(r)}\n`);
		if (buf.length >= 1000) flush();
	}, proc);
}

/** ROOST_TELEMETRY=path turns it on (for this process and the hosts it starts). */
export function telemetryFromEnv(proc: string, env: NodeJS.ProcessEnv = process.env): Telemetry {
	const path = env.ROOST_TELEMETRY;
	return path ? fileTelemetry(path, proc) : NOOP_TELEMETRY;
}

/** Records from a telemetry file (lines that do not parse are skipped). */
export function parseTelemetry(text: string): TelemetryRecord[] {
	const out: TelemetryRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const r = JSON.parse(line) as TelemetryRecord;
			if (r && (r.t === "span" || r.t === "metric")) out.push(r);
		} catch {}
	}
	return out;
}

/** p50/p95/p99, min, max and count of some values (a stress report's latency line). */
export function percentiles(values: number[]): { n: number; min: number; p50: number; p95: number; p99: number; max: number } | null {
	if (values.length === 0) return null;
	const v = [...values].sort((a, b) => a - b);
	const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))]!;
	return { n: v.length, min: v[0]!, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: v[v.length - 1]! };
}
