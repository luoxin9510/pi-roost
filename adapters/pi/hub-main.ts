/**
 * M33: the standalone hub, `pi-roost hub [dir]`: the agent view in a terminal of its own,
 * without a pi session around it. It is drawn with pi-tui and launches pi jobs as the hub
 * inside pi does (adapters/pi/hub-options.ts); pi's packages come from the pi on the PATH
 * (lib/pi-resolve.ts). New sessions run that pi, which loads pi-roost from the user's
 * installed packages.
 */
import { execFile } from "node:child_process";
import { initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { AgentView } from "../../hub/agent-view.ts";
import { ansiTheme } from "../../hub/theme.ts";
import { piHubOptions } from "./hub-options.ts";

export interface HubMainOptions {
	cwd: string;
	/** The pi CLI new sessions run (a file node runs). */
	piCli: string;
}

/** `pi --list-models`: the models with credentials, as pi lists them. */
function listModels(piCli: string): Promise<string[]> {
	return new Promise((done) => {
		execFile(process.execPath, [piCli, "--list-models"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
			if (err) return done([]);
			done(parseModelList(out));
		});
	});
}

export function parseModelList(out: string): string[] {
	const models: string[] = [];
	for (const line of out.split("\n").slice(1)) {
		const [provider, id] = line.trim().split(/\s+/);
		if (provider && id) models.push(`${provider}/${id}`);
	}
	return models;
}

/** Run the hub until the user leaves it. */
export async function runHub(o: HubMainOptions): Promise<void> {
	// pi's components the hub shows (its /resume list) draw with pi's theme
	try {
		initTheme(SettingsManager.create(o.cwd).getTheme());
	} catch {
		initTheme();
	}
	let models: string[] = [];
	void listModels(o.piCli).then((m) => {
		models = m;
	});
	const terminal = new ProcessTerminal();
	// as pi draws by default (its fullscreen mode): the alternate screen, the shell kept below
	const tui = new TuiAltScreen(terminal);
	await new Promise<void>((done) => {
		const view = new AgentView({
			tui,
			theme: ansiTheme(),
			...piHubOptions({
				cwd: o.cwd,
				// what new sessions run: this pi, loading pi-roost from the user's packages
				argv: [process.execPath, o.piCli],
				commands: () => [],
				models: () => models,
				scopedModels: () => [],
				currentSession: () => undefined,
				sessionDir: () => undefined,
			}),
			// a terminal of its own: always the whole screen
			fullscreen: true,
			setTitle: (title) => terminal.setTitle(title),
			done: () => done(),
		});
		tui.addChild(view);
		tui.setFocus(view);
		tui.start();
		void view.start();
	});
	tui.stop();
}
