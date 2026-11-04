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

const SEQ = /\x1b\[(\?[\d;]+[hl]|[<>=][\d;]*u|>4(?:;\d+)?m|[\d;]*r|\d* q|!p)|\x1bc|\x1b\([0AB]/g;
/** The longest tail that may be the start of a sequence cut by a chunk boundary. */
const TAIL = /\x1b(?:\[[?<>=]?[\d;]*)?$/;

export class ModeTracker {
	private decset = new Map<number, boolean>();
	/**
	 * Kitty keyboard flags in force and the ones pushed before, per screen (the protocol
	 * keeps a stack for the main screen and one for the alternate screen).
	 */
	private kitty = { main: { cur: 0, prev: [] as number[] }, alt: { cur: 0, prev: [] as number[] } };
	private alt = false;
	private otherKeys = 0;
	/** DECSTBM: the scroll region, 1-based and inclusive, or none. */
	private region: [number, number] | undefined;
	/** DECSCUSR: the cursor's shape (0: the terminal's default). */
	private cursorShape = 0;
	/** The G0 character set (B: ASCII, 0: line drawing). */
	private g0 = "B";
	private carry = "";

	/** Follow a chunk of the program's output. */
	feed(chunk: string): void {
		const text = this.carry + chunk;
		const tail = TAIL.exec(text);
		this.carry = tail && tail[0].length < 32 ? tail[0] : "";
		const body = this.carry ? text.slice(0, text.length - this.carry.length) : text;
		for (const m of body.matchAll(SEQ)) this.apply(m[1] ?? m[0]);
	}

	/** A resize resets the scroll region, as terminals do. */
	resized(): void {
		this.region = undefined;
	}

	private stack() {
		return this.alt ? this.kitty.alt : this.kitty.main;
	}

	private reset(): void {
		this.decset.clear();
		this.kitty = { main: { cur: 0, prev: [] }, alt: { cur: 0, prev: [] } };
		this.alt = false;
		this.otherKeys = 0;
		this.region = undefined;
		this.cursorShape = 0;
		this.g0 = "B";
	}

	private apply(s: string): void {
		if (s === "\x1bc" || s === "!p") return this.reset(); // RIS, DECSTR
		if (s.startsWith("\x1b(")) {
			this.g0 = s[2]!;
			return;
		}
		const end = s.at(-1)!;
		if (s.startsWith("?")) {
			for (const n of s.slice(1, -1).split(";").map(Number)) {
				if (n === 1049 || n === 1047 || n === 47) this.alt = end === "h";
				else if (n in DECSET) this.decset.set(n, end === "h");
			}
		} else if (end === "u") {
			const [a, b] = s.slice(1, -1).split(";").map((x) => (x === "" ? undefined : Number(x)));
			const k = this.stack();
			if (s[0] === ">") {
				if (k.prev.length < 32) k.prev.push(k.cur);
				k.cur = a ?? 0;
			} else if (s[0] === "<") {
				for (let i = Math.max(1, a ?? 1); i > 0; i--) k.cur = k.prev.pop() ?? 0;
			} else if (s[0] === "=") {
				// set (1), or (2), and-not (3) the flags in force
				const f = a ?? 0;
				k.cur = b === 2 ? k.cur | f : b === 3 ? k.cur & ~f : f;
			}
		} else if (s.startsWith(">4")) {
			this.otherKeys = Number(s.slice(3, -1)) || 0;
		} else if (end === "r") {
			const [t, b] = s.slice(0, -1).split(";").map((x) => (x === "" ? undefined : Number(x)));
			this.region = t || b ? [t || 1, b || 0] : undefined;
		} else if (end === "q") {
			this.cursorShape = Number(s.slice(0, -2)) || 0;
		}
	}

	/** The scroll region in force, if any (the snapshot sets it after its content). */
	scrollRegion(): [number, number] | undefined {
		return this.region;
	}

	/** Sequences that put a fresh terminal in these modes (the scroll region aside). */
	restore(): string {
		let out = "";
		for (const [n, on] of this.decset) if (on !== DECSET[n]) out += `\x1b[?${n}${on ? "h" : "l"}`;
		const flags = this.stack().cur;
		if (flags) out += `\x1b[>${flags}u`;
		if (this.otherKeys) out += `\x1b[>4;${this.otherKeys}m`;
		if (this.cursorShape) out += `\x1b[${this.cursorShape} q`;
		if (this.g0 !== "B") out += `\x1b(${this.g0}`;
		return out;
	}
}

/**
 * The escape sequence the program's output has started and not finished (a chunk may end
 * inside one). An attach's snapshot is taken between two chunks: the part already written
 * is in the mirror's parser but not in the snapshot, so it goes to the client first.
 */
export class StreamTail {
	private state: "ground" | "esc" | "csi" | "str" | "strEsc" | "charset" = "ground";
	private buf = "";

	feed(chunk: string): void {
		let start = this.state === "ground" ? -1 : 0;
		for (let i = 0; i < chunk.length; i++) {
			const c = chunk.charCodeAt(i);
			switch (this.state) {
				case "ground":
					if (c === 0x1b) {
						this.state = "esc";
						this.buf = "";
						start = i;
					}
					break;
				case "esc":
					if (c === 0x5b) this.state = "csi"; // [
					else if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) this.state = "str"; // ] P _ ^ X
					else if (c >= 0x20 && c <= 0x2f) this.state = "charset"; // ( ) * + # %: one more byte
					else if (c === 0x1b) {
						this.buf = "";
						start = i;
					} else this.state = "ground";
					break;
				case "charset":
					this.state = "ground";
					break;
				case "csi":
					if (c >= 0x40 && c <= 0x7e) this.state = "ground";
					else if (c === 0x1b) {
						this.state = "esc";
						this.buf = "";
						start = i;
					}
					break;
				case "str":
					if (c === 0x07) this.state = "ground";
					else if (c === 0x1b) this.state = "strEsc";
					break;
				case "strEsc":
					this.state = c === 0x5c ? "ground" : "str"; // ST is ESC \
					break;
			}
			if (this.state === "ground") start = -1;
		}
		if (this.state === "ground") this.buf = "";
		else {
			this.buf += chunk.slice(Math.max(0, start));
			// a string that never ends (a huge OSC 52) is not worth keeping whole
			if (this.buf.length > 65536) this.buf = this.buf.slice(-65536);
		}
	}

	/** The unfinished sequence so far ("" between sequences). */
	text(): string {
		return this.state === "ground" ? "" : this.buf;
	}
}
