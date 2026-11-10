// M68: the daemon's watches as a module: who asked to be told once when a job is next idle or
// has ended, their file, their expiry, and the notice. Ports are narrow; time is the Clock's.
import { type Clock, systemClock } from "./clock.ts";
import { envelope, MAX_WATCHES, noticeBody, type Relation, WATCH_TTL_MS } from "./comms.ts";
import { OpError, str } from "./op.ts";
import type { RoostEvent } from "./events.ts";
import type { JobStateName } from "./protocol.ts";

/** A watch: tell `watcher` (a session key) once when job `id` is next idle, or has ended. */
export interface Watch {
	watcher: string;
	watcherName: string;
	/** The watching job, when a job watches (null: a foreground session). */
	watcherId?: string | null;
	id: string;
	when: "idle" | "ended";
	at: number;
}

/** The parts of a job's row a notice is made of. */
export interface WatchedRow {
	id: string;
	name: string;
	state: JobStateName;
	waitingFor: string | null;
	question: string | null;
	summary: string | null;
	error: string | null;
}

/** The sessions: the peer that asks (`P`: whatever the daemon calls a connected session) and its tree. */
export interface WatchesSessionsPort<P> {
	/** The peer takes no agent items (a watch is told as one). */
	refusesItems(peer: P): boolean;
	/** The peer's session key (throws what the daemon throws for a session-less peer). */
	keyOf(peer: P): string;
	name(peer: P): string;
	/** The peer's job, when a job asks (null: a foreground session). */
	jobId(peer: P): string | null;
	/** The session `to` (an id or a name) names, among those the peer reaches (throws when none, or many). */
	find(peer: P, to: string): { key: string; id: string; role: string };
}

export interface WatchesJobsPort {
	/** The job still has a record. */
	exists(id: string): boolean;
	row(id: string): WatchedRow | undefined;
	/** What the watched job's session is to the watcher's. */
	relation(watcherKey: string, jobId: string): Relation;
	/** Hand a notice to the session `key`; `reached`: it got it (a gone watcher is not told). */
	deliver(key: string, text: string, meta: { from: string; relation: Relation }): Promise<{ outcome: string; reached: boolean }>;
}

/** The file the watches live in (the daemon's writes atomically under the roost's home). */
export interface WatchesStore {
	read(): unknown;
	write(v: unknown): void;
}

export interface WatchesDeps<P> {
	sessions: WatchesSessionsPort<P>;
	jobs: WatchesJobsPort;
	store: WatchesStore;
	record(e: Omit<RoostEvent, "seq" | "at">): void;
	log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
	clock?: Clock;
	/** A watch that never fires expires after this (default WATCH_TTL_MS). */
	ttlMs?: number;
	/** Watches one session keeps at a time (default MAX_WATCHES). */
	maxPerWatcher?: number;
}

export interface WatchResult {
	id: string;
	name: string;
	when: Watch["when"];
	fired: boolean;
}

export interface Watches<P> {
	/** Loads the file: expired watches and ones on jobs that are gone are dropped. Call once the jobs are known. */
	load(): void;
	/** The `watch` op of `peer`. */
	add(peer: P, args: { id?: unknown; when?: unknown } | undefined): Promise<WatchResult>;
	/** A job's row went out: if it is in a state watches fire on, tell each watcher once. */
	stateChanged(row: WatchedRow): Promise<void>;
	/** A job is being removed (call before its record goes): its watchers are told it ended. */
	removed(id: string, name: string): Promise<void>;
	/** The session `key` is held by nothing any more: its own watches go. */
	watcherGone(key: string): void;
	/** Expires watches that never fired and drops ones on jobs that are gone (the daemon's reaper calls it). */
	sweep(): void;
}

/** idle: it stopped working (done, waiting, failed, stopped); ended: it failed, was stopped, or is gone. */
export function watchFires(when: Watch["when"], state: JobStateName | "removed"): boolean {
	if (state === "removed") return true;
	if (when === "ended") return state === "failed" || state === "stopped";
	return state !== "working";
}

type Subject = WatchedRow | { id: string; name: string; state: "removed" };

export function createWatches<P>(deps: WatchesDeps<P>): Watches<P> {
	const { sessions, jobs, store, record, log } = deps;
	const clock = deps.clock ?? systemClock;
	const ttl = deps.ttlMs ?? WATCH_TTL_MS;
	const maxPer = deps.maxPerWatcher ?? MAX_WATCHES;
	let watches: Watch[] = [];

	function load(): void {
		const saved = store.read();
		if (!Array.isArray(saved)) return;
		const now = clock.now();
		watches = (saved as Watch[]).filter((w) => w && str(w.watcher) && str(w.id) && (w.when === "idle" || w.when === "ended") && typeof w.at === "number" && now - w.at < ttl && jobs.exists(w.id));
	}

	function save(): void {
		try {
			store.write(watches);
		} catch (err) {
			log("error", "watches not saved", { error: String(err) });
		}
	}

	function sweep(): void {
		const now = clock.now();
		const before = watches.length;
		watches = watches.filter((w) => now - w.at < ttl && jobs.exists(w.id));
		if (watches.length !== before) save();
	}

	/** Tells the watcher; the watch itself is already forgotten (or never kept). */
	async function fire(w: Watch, job: Subject): Promise<void> {
		const removed = job.state === "removed";
		const row = removed ? undefined : (job as WatchedRow);
		const when: Watch["when"] = removed || row?.state === "failed" || row?.state === "stopped" ? "ended" : "idle";
		const body = noticeBody({
			when,
			state: job.state,
			waitingFor: row?.waitingFor ?? null,
			question: row?.question ?? null,
			summary: row?.summary ?? null,
			error: row?.error ?? null,
		});
		const relation = jobs.relation(w.watcher, job.id);
		const text = envelope({ from: job.name, id: job.id, relation, kind: "notice", body });
		try {
			const r = await jobs.deliver(w.watcher, text, { from: job.name, relation });
			log("info", "watch fired", { id: job.id, watcher: w.watcher, when: w.when, outcome: r.outcome });
			// a watcher that is gone (a closed pi, a stopped job) is not told: the notice is lost, as a message would be
			if (r.reached) record({ kind: "notice", id: job.id, name: job.name, who: w.watcherName, whoId: w.watcherId ?? null, text: when === "ended" ? "ended" : "is idle" });
		} catch (err) {
			log("warn", "watch notice failed", { id: job.id, watcher: w.watcher, error: String(err) });
		}
	}

	/** The job is in a state watches fire on: tell each watcher once, and forget the watch. */
	async function fireAll(job: Subject): Promise<void> {
		const due = watches.filter((w) => w.id === job.id && watchFires(w.when, job.state));
		if (due.length === 0) return;
		watches = watches.filter((w) => !due.includes(w));
		save();
		for (const w of due) await fire(w, job);
	}

	async function add(peer: P, args: { id?: unknown; when?: unknown } | undefined): Promise<WatchResult> {
		// M50: the notice is an agent item: an agent that takes none would never hear it
		if (sessions.refusesItems(peer)) throw new OpError("unsupported", "a watch is told as a notice: say agent-items in your hello to take one");
		const to = typeof args?.id === "string" ? args.id.trim() : "";
		const when = args?.when;
		if (!to) throw new OpError("bad_request", "id required");
		if (when !== "idle" && when !== "ended") throw new OpError("bad_request", "when must be idle or ended");
		const me = sessions.keyOf(peer);
		const target = sessions.find(peer, to);
		if (target.key === me) throw new OpError("bad_request", "a session cannot watch itself");
		if (target.role !== "job") throw new OpError("unsupported", "a foreground session is not watched (it has no job state)");
		const row = jobs.row(target.id);
		if (!row) throw new OpError("not_found", `no such job: ${target.id}`);
		const w: Watch = { watcher: me, watcherName: sessions.name(peer), watcherId: sessions.jobId(peer), id: row.id, when, at: clock.now() };
		// already so: said at once, nothing kept
		if (watchFires(when, row.state)) {
			await fire(w, row);
			return { id: row.id, name: row.name, when, fired: true };
		}
		const mine = watches.filter((x) => x.watcher === me);
		const same = mine.find((x) => x.id === row.id && x.when === when);
		if (same) watches = watches.filter((x) => x !== same);
		else if (mine.length >= maxPer) throw new OpError("full", `at most ${maxPer} watches at a time`);
		watches.push(w);
		save();
		log("info", "watch", { id: row.id, watcher: me, when });
		return { id: row.id, name: row.name, when, fired: false };
	}

	return {
		load,
		add,
		stateChanged: (row) => fireAll(row),
		removed: (id, name) => fireAll({ id, name, state: "removed" }),
		watcherGone(key) {
			if (!watches.some((w) => w.watcher === key)) return;
			watches = watches.filter((w) => w.watcher !== key);
			save();
		},
		sweep,
	};
}
