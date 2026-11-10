// M71: what an overlay gets from the hub (docs/plans/hub-overlays.md, decision 3): the daemon
// port, the theme, and a few verbs; it no longer holds the view. Its own file, not the port's:
// the port is the daemon's, the host is the view's. The overlays in hub/overlays/ are built on
// it, each with its slice of the port (M72–M74).
import type { Event, JobRow } from "../lib/protocol.ts";
import type { Tone } from "../lib/view-model.ts";
import type { hostControl } from "../lib/hostclient.ts";
import type { taskChanges } from "../lib/task-git.ts";
import type { taskDiff } from "../lib/task-diff.ts";
import type { worktreeChange } from "../lib/worktree.ts";
import type { RoostPort } from "./roost-port.ts";
import type { HubTheme } from "./theme.ts";

/** A second press within this long confirms (Ctrl+X delete, Ctrl+C exit, compare's k). */
export const DOUBLE_PRESS_MS = 2000;

/** M23: a component shown in place of the list (pi's session selector), with its keys. */
export interface Overlay {
	render(width: number): string[];
	handleInput?(data: string): void;
	focused?: boolean;
	dispose?(): void;
	/** M71: a pushed event, after the view took it in (the view keeps the one subscription). */
	onEvent?(e: Event): void;
}

/** The line in the notice row, while it shows. */
export interface HostNotice {
	text: string;
	tone: Tone;
	until: number;
}

/** `P`: the slice of the port the overlay uses (the whole port by default). */
export interface OverlayHost<P = RoostPort> {
	/** The port of the connection the overlay was opened on (no overlay opens without one). */
	port: P;
	theme: HubTheme;
	/** A line in the notice row. */
	say(text: string, tone?: Tone): void;
	/** Close this overlay (the view's, so what waited for it opens: decision 9 of M44's answer). */
	close(): void;
	requestRender(): void;
	/** Leave the overlay and attach to session `id`. */
	attachTo(id: string): Promise<void>;
	/** M79: the view's selection goes to row `id` (where it is when the overlay closes). */
	selectRow(id: string): void;
	/** The view's rows as they are now, read only. */
	rows(): ReadonlyMap<string, JobRow>;
	/** M72: the overlay the view shows now (an overlay replaced without closing is not it). */
	current(): Overlay | undefined;
	/** M72: the notice row as it is now (an overlay draws it above its keys). */
	notice(): HostNotice | undefined;
	/** M72: the terminal's height (0 when unknown). */
	termRows(): number;
	// Local reads (decision 10): git and this machine, not the daemon; tests pass fakes.
	taskDiff?: typeof taskDiff;
	taskChanges?: typeof taskChanges;
	worktreeChange?: typeof worktreeChange;
	hostControl?: typeof hostControl;
}
