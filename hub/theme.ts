/**
 * M33: the colours the hub draws with. pi's own theme fits it (the hub inside pi passes
 * it); the standalone hub passes pi's too, loaded from the user's settings.
 */
export interface HubTheme {
	/** Colour `text` with a theme colour: "accent", "dim", "border", "warning", "error", "success", ... */
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// pi's dark theme, in the 256 colours every terminal has
const PALETTE: Record<string, number> = {
	accent: 141,
	border: 111,
	dim: 244,
	muted: 248,
	text: 252,
	success: 115,
	error: 210,
	warning: 186,
	syntaxKeyword: 141,
	syntaxFunction: 111,
	syntaxString: 115,
	syntaxType: 80,
	syntaxNumber: 186,
	mdLink: 117,
};

/** The standalone hub's colours (NO_COLOR: none). */
export function ansiTheme(env: NodeJS.ProcessEnv = process.env): HubTheme {
	const plain = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
	return {
		fg: (color, text) => {
			const c = PALETTE[color];
			return plain || c === undefined ? text : `\x1b[38;5;${c}m${text}\x1b[39m`;
		},
		bold: (text) => (plain ? text : `\x1b[1m${text}\x1b[22m`),
	};
}
