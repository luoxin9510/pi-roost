// M71: the hub's one port to the daemon: every call the hub makes, as a typed method grouped by
// area. `roostPort(client)` is the adapter over `DaemonClient`; each method is one request and
// returns its result as it came. Tests use `test/support/roost-port.ts`.
import { type DaemonClient, requestOnce } from "../lib/client.ts";
import type { ArgsOf, Event, OpArgs, ResultOf } from "../lib/protocol.ts";

type TaskArgs = OpArgs["task"];
/** The arguments of `task` action `A`, without the action. */
type Body<A extends TaskArgs["action"]> = Omit<Extract<TaskArgs, { action: A }>, "action">;
type Once = { timeoutMs?: number; tag?: string };

export interface RoostPort {
	/** Pushed events: subscribe on the daemon and hand each event to `onEvent`. */
	subscribe(onEvent: (e: Event) => void): Promise<void>;
	/** Pushed events, without subscribing; returns the way off. */
	listen(onEvent: (e: Event) => void): () => void;
	/** The place in the stream of the line being handled now. */
	position(): number;

	jobs: {
		list(args: ArgsOf<"list">): Promise<ResultOf<"list">>;
		/** The list and where its reply was in the stream (events with a higher `position()` came after). */
		listAt(args: ArgsOf<"list">): Promise<{ result: ResultOf<"list">; at: number }>;
		stop(id: string): Promise<ResultOf<"stop">>;
		rm(id: string): Promise<ResultOf<"rm">>;
		pin(id: string, pinned: boolean): Promise<ResultOf<"pin">>;
		rename(id: string, name: string): Promise<ResultOf<"rename">>;
		reorder(ids: string[], key: string): Promise<ResultOf<"reorder">>;
		respawn(id: string): Promise<ResultOf<"respawn">>;
		/** M51: sent with a request id, again on the new connection while the daemon restarts. */
		reply(args: ArgsOf<"reply">, opts?: Once): Promise<ResultOf<"reply">>;
		dispatch(args: ArgsOf<"dispatch">, opts?: Once): Promise<ResultOf<"dispatch">>;
	};

	tasks: {
		list(args?: { project?: string }): Promise<ResultOf<"task">>;
		add(a: Body<"add">): Promise<ResultOf<"task">>;
		assign(id: number, to: string): Promise<ResultOf<"task">>;
		done(id: number, result?: string): Promise<ResultOf<"task">>;
		drop(id: number): Promise<ResultOf<"task">>;
		release(id: number): Promise<ResultOf<"task">>;
		prepare(id: number): Promise<ResultOf<"task">>;
		start(id: number, launch: Body<"start">["launch"]): Promise<ResultOf<"task">>;
		merge(id: number, mode?: "ff" | "no-ff"): Promise<ResultOf<"task">>;
		back(id: number, note?: string): Promise<ResultOf<"task">>;
		abort(id: number): Promise<ResultOf<"task">>;
		commit(id: number, message?: string): Promise<ResultOf<"task">>;
		/** `dry`: the commands shown; then with the `hash` shown. */
		approve(a: Body<"approve">): Promise<ResultOf<"task">>;
		verify(id: number): Promise<ResultOf<"task">>;
		pass(id: number): Promise<ResultOf<"task">>;
		comment(id: number, comment: Body<"comment">["comment"]): Promise<ResultOf<"task">>;
		uncomment(id: number, comment: Body<"uncomment">["comment"]): Promise<ResultOf<"task">>;
		shelve(id: number): Promise<ResultOf<"task">>;
		cleanup(dry: boolean): Promise<ResultOf<"task">>;
		/** `dry`: what it would do; then with the tip shown as `hash`. */
		pr(a: Body<"pr">): Promise<ResultOf<"task">>;
	};

	concierge: {
		status(): Promise<ResultOf<"concierge">>;
		on(launch?: ArgsOf<"dispatch">): Promise<ResultOf<"concierge">>;
		off(): Promise<ResultOf<"concierge">>;
		answer(answer: Extract<ArgsOf<"concierge">, { action: "answer" }>["answer"]): Promise<ResultOf<"concierge">>;
		act(act: boolean): Promise<ResultOf<"concierge">>;
		undo(): Promise<ResultOf<"concierge">>;
		/** A question for the concierge; its answer comes as a `concierge` event. */
		ask(text: string): Promise<ResultOf<"concierge-ask">>;
		orders: {
			list(): Promise<ResultOf<"concierge-order">>;
			add(text: string, when?: string): Promise<ResultOf<"concierge-order">>;
			rm(id: number): Promise<ResultOf<"concierge-order">>;
		};
	};

	schedules: {
		list(): Promise<ResultOf<"schedules">>;
		add(a: ArgsOf<"schedule-add">): Promise<ResultOf<"schedule-add">>;
		rm(name: string): Promise<ResultOf<"schedule-rm">>;
		pause(name: string, paused: boolean): Promise<ResultOf<"schedule-pause">>;
		run(name: string): Promise<ResultOf<"schedule-run">>;
	};

	events: {
		/** The event feed (what happened). */
		list(args: ArgsOf<"events">): Promise<ResultOf<"events">>;
	};
}

/** The sends that wait through a reconnect: they hold no connection, `via` gives one at each try (M51). */
export type Sends = Pick<RoostPort["jobs"], "reply" | "dispatch">;
export function sends(via: (deadline: number) => Promise<DaemonClient>): Sends {
	return {
		reply: (args, opts) => requestOnce(via, "reply", args, opts),
		dispatch: (args, opts) => requestOnce(via, "dispatch", args, opts),
	};
}

/**
 * The adapter. `via(deadline)` gives the connection for `reply` and `dispatch` (M51: the hub's
 * hands the one made again after a restart); by default, this client.
 */
export function roostPort(client: DaemonClient, via: (deadline: number) => Promise<DaemonClient> = async () => client): RoostPort {
	const once = sends(via);
	const task = <A extends TaskArgs["action"]>(action: A, body?: Body<A>) => client.request("task", { action, ...body } as TaskArgs);
	const order = (a: ArgsOf<"concierge-order">) => client.request("concierge-order", a);
	const concierge = (a: ArgsOf<"concierge">) => client.request("concierge", a);
	return {
		subscribe: async (onEvent) => {
			client.onEvent(onEvent);
			await client.request("subscribe", {});
		},
		listen: (onEvent) => client.onEvent(onEvent),
		position: () => client.position(),

		jobs: {
			list: (args) => client.request("list", args),
			listAt: (args) => client.requestAt("list", args),
			stop: (id) => client.request("stop", { id }),
			rm: (id) => client.request("rm", { id }),
			pin: (id, pinned) => client.request("pin", { id, pinned }),
			rename: (id, name) => client.request("rename", { id, name }),
			reorder: (ids, key) => client.request("reorder", { ids, key }),
			respawn: (id) => client.request("respawn", { id }),
			reply: once.reply,
			dispatch: once.dispatch,
		},

		tasks: {
			list: (args = {}) => task("list", args),
			add: (a) => task("add", a),
			assign: (id, to) => task("assign", { id, to }),
			done: (id, result) => task("done", { id, result }),
			drop: (id) => task("drop", { id }),
			release: (id) => task("release", { id }),
			prepare: (id) => task("prepare", { id }),
			start: (id, launch) => task("start", { id, launch }),
			merge: (id, mode) => task("merge", { id, mode }),
			back: (id, note) => task("back", { id, note }),
			abort: (id) => task("abort", { id }),
			commit: (id, message) => task("commit", { id, message }),
			approve: (a) => task("approve", a),
			verify: (id) => task("verify", { id }),
			pass: (id) => task("pass", { id }),
			comment: (id, comment) => task("comment", { id, comment }),
			uncomment: (id, comment) => task("uncomment", { id, comment }),
			shelve: (id) => task("shelve", { id }),
			cleanup: (dry) => task("cleanup", { dry }),
			pr: (a) => task("pr", a),
		},

		concierge: {
			status: () => concierge({ action: "status" }),
			on: (launch) => concierge(launch ? { action: "on", launch } : { action: "on" }),
			off: () => concierge({ action: "off" }),
			answer: (answer) => concierge({ action: "answer", answer }),
			act: (act) => concierge({ action: "act", act }),
			undo: () => concierge({ action: "undo" }),
			ask: (text) => client.request("concierge-ask", { text }),
			orders: {
				list: () => order({ action: "list" }),
				add: (text, when) => order({ action: "add", text, ...(when ? { when } : {}) }),
				rm: (id) => order({ action: "rm", id }),
			},
		},

		schedules: {
			list: () => client.request("schedules", {}),
			add: (a) => client.request("schedule-add", a),
			rm: (name) => client.request("schedule-rm", { name }),
			pause: (name, paused) => client.request("schedule-pause", { name, paused }),
			run: (name) => client.request("schedule-run", { name }),
		},

		events: { list: (args) => client.request("events", args) },
	};
}
