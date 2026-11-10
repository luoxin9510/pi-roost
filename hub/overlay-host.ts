// M71: what an overlay gets from the hub (docs/plans/hub-overlays.md, decision 3): the daemon
// port, the theme, and a few verbs; it no longer holds the view. Its own file, not the port's:
// the port is the daemon's, the host is the view's. Nothing uses it yet but the view's
// `overlayHost(port)`; the overlays move onto it in M72–M74 (each with its slice of the port).
import type { JobRow } from "../lib/protocol.ts";
import type { Tone } from "../lib/view-model.ts";
import type { hostControl } from "../lib/hostclient.ts";
import type { taskChanges } from "../lib/task-git.ts";
import type { taskDiff } from "../lib/task-diff.ts";
import type { worktreeChange } from "../lib/worktree.ts";
import type { RoostPort } from "./roost-port.ts";
import type { HubTheme } from "./theme.ts";

export interface OverlayHost {
	/** The port of the connection the overlay was opened on (no overlay opens without one). The
	 * whole port for now; each overlay's move narrows it to its slice. */
	port: RoostPort;
	theme: HubTheme;
	/** A line in the notice row. */
	say(text: string, tone?: Tone): void;
	/** Close this overlay (the view's, so what waited for it opens: decision 9 of M44's answer). */
	close(): void;
	requestRender(): void;
	/** Leave the overlay and attach to session `id`. */
	attachTo(id: string): Promise<void>;
	/** The view's rows as they are now, read only. */
	rows(): ReadonlyMap<string, JobRow>;
	// Local reads (decision 10): git and this machine, not the daemon; tests pass fakes.
	taskDiff?: typeof taskDiff;
	taskChanges?: typeof taskChanges;
	worktreeChange?: typeof worktreeChange;
	hostControl?: typeof hostControl;
}
