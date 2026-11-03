// Test fixture: `/ask` opens a confirm() dialog without any model call, for
// checking that a worker reports blocked/dialog (M2 acceptance).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("ask", {
		description: "Open a confirm dialog",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Deploy to staging?", "pi-roost M2 fixture");
			ctx.ui.notify(`answered ${ok ? "yes" : "no"}`, "info");
		},
	});
}
