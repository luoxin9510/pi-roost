/**
 * M61: pi's built-in slash commands (pi 1.5.0) and how a peek runs each. pi does not export
 * its list (BUILTIN_SLASH_COMMANDS is internal to dist/core/slash-commands.js), so it is
 * carried here; test/pi-commands.test.ts fails when a pi upgrade adds or removes a name.
 *
 * - hub: the hub has its own (model, thinking, name, compact): not listed in the pi group.
 * - screen: runs and shows something; the peek types it in and shows the screen.
 * - picker: opens a picker or dialog in pi; the peek types it in and attaches.
 * - confirm: ends the session (asked twice).
 */
export type PiCommandHow = "hub" | "screen" | "picker" | "confirm";

export interface PiCommand {
	name: string;
	description: string;
	argumentHint?: string;
	how: PiCommandHow;
	/** What pi does with words after the name: it matches the others exactly (`/tree foo` would go to the model as a prompt). */
	args?: "optional" | "required";
}

export const PI_COMMANDS: PiCommand[] = [
	{ name: "settings", description: "Open settings menu", how: "picker" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>", how: "hub", args: "optional" },
	{ name: "tree", description: "Navigate session tree (switch branches)", how: "picker" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>", how: "hub", args: "optional" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", how: "picker" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", how: "screen", args: "optional" },
	{ name: "import", description: "Import a JSONL session, preserving its ID and working directory", how: "picker", args: "required" },
	{ name: "share", description: "Share session via a Radius artifact or a GitHub gist", how: "picker" },
	{ name: "bug", description: "Report a bug to the Pi developers", argumentHint: "<description>", how: "picker", args: "optional" },
	{ name: "copy", description: "Copy last agent message to clipboard", how: "screen" },
	{ name: "name", description: "Set session display name", how: "hub", args: "optional" },
	{ name: "session", description: "Show session info and stats", how: "screen" },
	{ name: "changelog", description: "Show changelog entries", how: "screen" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts", how: "screen" },
	{ name: "fork", description: "Create a new fork from a previous user message", how: "picker" },
	{ name: "clone", description: "Duplicate the current session at the current position", how: "screen" },
	{ name: "trust", description: "Save project trust decision for future sessions", how: "picker" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>", how: "picker", args: "optional" },
	{ name: "logout", description: "Remove provider authentication", how: "picker" },
	{ name: "new", description: "Start a new session", how: "screen" },
	{ name: "compact", description: "Manually compact the session context", how: "hub", args: "optional" },
	{ name: "resume", description: "Resume another session", how: "picker" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files", how: "screen" },
	{ name: "quit", description: "Quit pi", how: "confirm" },
];

export const piCommand = (name: string): PiCommand | undefined => PI_COMMANDS.find((c) => c.name === name);

/** A command of a pi session as its worker lists it (commands.json). */
export interface SessionCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

const MAX_SESSION_COMMANDS = 300;
const MAX_DESCRIPTION = 200;

/** The worker's `pi.getCommands()` as commands.json keeps it: bounded, one-line descriptions. */
export function sessionCommandsFrom(list: unknown): SessionCommand[] {
	if (!Array.isArray(list)) return [];
	const out: SessionCommand[] = [];
	for (const c of list) {
		if (out.length >= MAX_SESSION_COMMANDS) break;
		if (!c || typeof c !== "object") continue;
		const { name, description, source } = c as Record<string, unknown>;
		if (typeof name !== "string" || !name || (source !== "extension" && source !== "prompt" && source !== "skill")) continue;
		const d = typeof description === "string" ? description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION) : "";
		out.push({ name, ...(d ? { description: d } : {}), source });
	}
	return out;
}
