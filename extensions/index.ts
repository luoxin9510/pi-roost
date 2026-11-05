// pi-roost's pi extension moved to adapters/pi/ (M32). Kept so a worker started before the
// move, whose saved command loads this path with -e, starts again after it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "../adapters/pi/index.ts";

export default function (pi: ExtensionAPI) {
	register(pi, "extensions");
}
