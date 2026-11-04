// The terminal modes a program set that xterm's serialize addon does not carry: the
// cursor's visibility, mouse encodings, focus events, the kitty keyboard flags and
// modifyOtherKeys. The host follows them in the program's output, so an attach can set
// the user's terminal up as the program left its own (the snapshot carries the rest).

/** DECSET modes followed here, with what a fresh terminal has. */
const DECSET: Record<number, boolean> = {
	25: true, // cursor visible
	1004: false, // focus events
	1005: false, // UTF-8 mouse
	1006: false, // SGR mouse
	1015: false, // urxvt mouse
};

const SEQ = /\x1b\[(\?[\d;]+[hl]|[<>=][\d;]*u|>4(?:;\d+)?m)/g;
/** The longest tail that may be the start of a sequence cut by a chunk boundary. */
const TAIL = /\x1b(?:\[[?<>=]?[\d;]*)?$/;

export class ModeTracker {
	private decset = new Map<number, boolean>();
	/** Kitty keyboard flags, a stack as the protocol keeps it; the top is in force. */
	private kitty: number[] = [];
	private otherKeys = 0;
	private carry = "";

	/** Follow a chunk of the program's output. */
	feed(chunk: string): void {
		const text = this.carry + chunk;
		const tail = TAIL.exec(text);
		this.carry = tail && tail[0].length < 32 ? tail[0] : "";
		const body = this.carry ? text.slice(0, text.length - this.carry.length) : text;
		for (const m of body.matchAll(SEQ)) this.apply(m[1]!);
	}

	private apply(s: string): void {
		const end = s.at(-1)!;
		if (s.startsWith("?")) {
			for (const n of s.slice(1, -1).split(";").map(Number)) if (n in DECSET) this.decset.set(n, end === "h");
		} else if (end === "u") {
			const [a, b] = s.slice(1, -1).split(";").map((x) => (x === "" ? undefined : Number(x)));
			if (s[0] === ">") this.kitty.push(a ?? 0);
			else if (s[0] === "<") this.kitty.splice(Math.max(0, this.kitty.length - Math.max(1, a ?? 1)));
			else if (s[0] === "=") {
				// set (1), or (2), and-not (3) the flags in force
				const cur = this.kitty.at(-1) ?? 0;
				const f = a ?? 0;
				const next = b === 2 ? cur | f : b === 3 ? cur & ~f : f;
				if (this.kitty.length === 0) this.kitty.push(next);
				else this.kitty[this.kitty.length - 1] = next;
			}
		} else if (s.startsWith(">4")) {
			this.otherKeys = Number(s.slice(3, -1)) || 0;
		}
	}

	/** Sequences that put a fresh terminal in these modes. */
	restore(): string {
		let out = "";
		for (const [n, on] of this.decset) if (on !== DECSET[n]) out += `\x1b[?${n}${on ? "h" : "l"}`;
		const flags = this.kitty.at(-1);
		if (flags) out += `\x1b[>${flags}u`;
		if (this.otherKeys) out += `\x1b[>4;${this.otherKeys}m`;
		return out;
	}
}
