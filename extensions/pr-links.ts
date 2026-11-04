// M16: the pull requests a background session works on, found as Claude Code finds them:
// from what `gh pr …` prints, and by looking the branch up after a push or a checkout.
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LOOKUP_RETRIES, linkStep, prUrlsIn } from "../lib/pr.ts";

const MAX_LINKS = 20;

function outputText(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return typeof result === "string" ? result : "";
	return content
		.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
		.join("\n");
}

/** The branch's open pull request in `cwd`, if gh knows one. */
function lookupBranch(cwd: string): Promise<string | undefined> {
	return new Promise((done) => {
		execFile(process.env.PI_ROOST_GH || "gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd, timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, out) =>
			done(err ? undefined : prUrlsIn(String(out))[0]),
		);
	});
}

export interface PrLinks {
	links: () => string[];
}

/** Watch shell commands; `changed` is called when a pull request is linked. */
export function registerPrLinks(pi: ExtensionAPI, changed: () => void, lookup: (cwd: string) => Promise<string | undefined> = lookupBranch): PrLinks {
	const links = new Set<string>();
	const commands = new Map<string, string>();
	let retries = 0;
	let cwd = process.cwd();
	let looking = false;
	const add = (urls: string[]) => {
		let grew = false;
		for (const u of urls) {
			if (links.has(u) || links.size >= MAX_LINKS) continue;
			links.add(u);
			grew = true;
		}
		if (grew) changed();
		return grew;
	};
	/** False when a lookup is already running (a retry then does not count). */
	const look = async (): Promise<boolean> => {
		if (looking) return false;
		looking = true;
		try {
			const url = await lookup(cwd);
			if (url) {
				retries = 0;
				add([url]);
			}
		} finally {
			looking = false;
		}
		return true;
	};
	pi.on("session_start", (_e, ctx) => {
		cwd = ctx.cwd;
	});
	pi.on("tool_execution_start", (e) => {
		if (e.toolName !== "bash") return;
		const command = (e.args as { command?: unknown } | undefined)?.command;
		if (typeof command === "string") commands.set(e.toolCallId, command);
	});
	pi.on("tool_execution_end", (e) => {
		const command = commands.get(e.toolCallId);
		commands.delete(e.toolCallId);
		if (command === undefined) return;
		const step = linkStep(command, outputText(e.result));
		if (step.urls.length > 0) add(step.urls);
		if (step.lookup) {
			// the pull request may not exist yet: try again after later commands
			retries = LOOKUP_RETRIES;
			void look();
		} else if (step.retry && retries > 0 && !looking) {
			retries--;
			void look();
		}
	});
	return { links: () => [...links] };
}
