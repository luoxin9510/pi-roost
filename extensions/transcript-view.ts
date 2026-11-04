// M19: a subagent's transcript inside the session, as in Claude Code: opening a panel
// row shows that subagent's conversation, its siblings and direct children, and the path
// back to main; typing into it sends the subagent a message (and resumes it). Nothing is
// attached: the view reads the child's session file and follows it while it is open.
import { statSync } from "node:fs";
import { type Component, Input, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { JobRow } from "../lib/protocol.ts";
import { clean, neighboursOf, pathOf, readTail, type TranscriptItem, transcriptItems } from "../lib/transcript.ts";
import { ageOf, iconOf, sentenceOf } from "../lib/view-model.ts";

export interface TranscriptTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

export interface SendResult {
	ok: boolean;
	message: string;
}

export interface TranscriptViewOptions {
	tui: TUI;
	theme: TranscriptTheme;
	/** The main session's file: the path ends there. */
	main: string;
	/** Every job the panel knows (they stay current while the view is open). */
	rows: () => JobRow[];
	/** The subagent to show first. */
	start: string;
	/** A message from the user (Claude Code: typing into a transcript resumes the subagent). */
	send: (id: string, text: string) => Promise<SendResult>;
	/** Leaving: back to the conversation, or into the subagent's own session. */
	done: (result: { attach?: JobRow } | undefined) => void;
	pollMs?: number;
	read?: typeof readTail;
}

type NavItem = { kind: "back"; row?: JobRow } | { kind: "row"; row: JobRow; depth: 0 | 1 };

const NAV_MAX = 8;
const NOTICE_MS = 4000;
const RESULT_LINES = 3;

// names, summaries and errors come from models and processes: no escapes reach the terminal
const oneLine = (s: string) => clean(s).replace(/\s+/g, " ").trim();
const ARM_MS = 2500;

export class TranscriptView implements Component {
	private o: TranscriptViewOptions;
	private id: string;
	private scroll = 0;
	private sel = 0;
	/** The selected tree row (by id, so a new row does not move the selection). */
	private selKey: string | undefined;
	/** Ctrl+O on an ended subagent: a second press starts it. */
	private armedAt = 0;
	private input = new Input({ prompt: "" });
	private items: TranscriptItem[] = [];
	private seen: { file: string; size: number; mtimeMs: number } | undefined;
	private failure: string | undefined;
	private lines: { width: number; items: TranscriptItem[]; out: string[] } | undefined;
	private notice: { text: string; tone: string; until: number } | undefined;
	private sending = false;
	private timer: NodeJS.Timeout | undefined;
	/** The last row seen of the shown subagent: it stays shown if the daemon drops it. */
	private last: JobRow | undefined;

	constructor(o: TranscriptViewOptions) {
		this.o = o;
		this.id = o.start;
		this.input.focused = true;
		this.load();
		this.select(this.navIndexOfCurrent());
		this.timer = setInterval(() => {
			if (this.load()) o.tui.requestRender();
		}, o.pollMs ?? 500);
		this.timer.unref?.();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** The shown subagent's row. */
	row(): JobRow | undefined {
		const r = this.o.rows().find((x) => x.id === this.id);
		if (r) this.last = r;
		return r ?? this.last;
	}

	/** Reads the session file again when it changed; true when there is something new. */
	private load(): boolean {
		const row = this.row();
		const file = row?.sessionFile;
		if (!file) {
			const was = this.failure;
			this.items = [];
			this.seen = undefined;
			this.failure = "no transcript (not a pi session)";
			return was !== this.failure;
		}
		try {
			const st = statSync(file);
			if (this.seen && this.seen.file === file && this.seen.size === st.size && this.seen.mtimeMs === st.mtimeMs) return false;
			const t = (this.o.read ?? readTail)(file);
			this.items = transcriptItems(t.text, t.truncated);
			this.seen = { file, size: t.size, mtimeMs: t.mtimeMs };
			this.failure = undefined;
			return true;
		} catch (err) {
			const was = this.failure;
			this.failure = (err as NodeJS.ErrnoException).code === "ENOENT" ? "no transcript yet" : `cannot read the transcript: ${(err as Error).message}`;
			this.items = [];
			this.seen = undefined;
			return was !== this.failure;
		}
	}

	private nav(): NavItem[] {
		const row = this.row();
		if (!row) return [{ kind: "back" }];
		const rows = this.o.rows();
		const path = pathOf(row, rows, this.o.main);
		const { siblings, children } = neighboursOf(row, rows);
		return [
			{ kind: "back", ...(path.length > 0 ? { row: path.at(-1)! } : {}) },
			...siblings.map((r) => ({ kind: "row" as const, row: r, depth: 0 as const })),
			...children.map((r) => ({ kind: "row" as const, row: r, depth: 1 as const })),
		];
	}

	private keyOfNav(n: NavItem | undefined): string | undefined {
		return n ? (n.kind === "back" ? "back" : n.row.id) : undefined;
	}

	private select(i: number): void {
		const nav = this.nav();
		this.sel = Math.max(0, Math.min(i, nav.length - 1));
		this.selKey = this.keyOfNav(nav[this.sel]);
	}

	/** The selection after the tree changed: the same row where it is now. */
	private resolveSel(nav: NavItem[]): void {
		const at = this.selKey ? nav.findIndex((n) => this.keyOfNav(n) === this.selKey) : -1;
		this.sel = at >= 0 ? at : Math.max(0, Math.min(this.sel, nav.length - 1));
		this.selKey = this.keyOfNav(nav[this.sel]);
	}

	private navIndexOfCurrent(): number {
		const i = this.nav().findIndex((n) => n.kind === "row" && n.depth === 0 && n.row.id === this.id);
		return i >= 0 ? i : 0;
	}

	/** Show another subagent of the tree. */
	go(row: JobRow): void {
		this.id = row.id;
		this.last = row;
		this.scroll = 0;
		this.seen = undefined;
		this.lines = undefined;
		this.armedAt = 0;
		this.load();
		this.select(this.navIndexOfCurrent());
	}

	/** One level up: the parent's transcript, or the conversation when the parent is main. */
	back(): void {
		const row = this.row();
		const parent = row ? pathOf(row, this.o.rows(), this.o.main).at(-1) : undefined;
		if (parent) this.go(parent);
		else this.o.done(undefined);
	}

	private say(text: string, tone: string): void {
		this.notice = { text, tone, until: Date.now() + NOTICE_MS };
		const t = setTimeout(() => this.o.tui.requestRender(), NOTICE_MS + 50);
		t.unref?.();
	}

	private submit(): void {
		const text = this.input.getValue().trim();
		const row = this.row();
		if (!text || !row) return;
		if (this.sending) return this.say("still sending the last message…", "dim");
		this.sending = true;
		this.input.setValue("");
		const to = row.id;
		// not sent: the text comes back to be sent again or copied, if that subagent is still shown
		const giveBack = () => {
			if (this.id === to && this.input.getValue() === "") this.input.setValue(text);
		};
		void this.o
			.send(to, text)
			.then((r) => {
				this.say(r.message, r.ok ? "dim" : "warning");
				if (!r.ok) giveBack();
			})
			.catch((err: unknown) => {
				this.say(`could not send: ${(err as Error).message}`, "error");
				giveBack();
			})
			.finally(() => {
				this.sending = false;
				this.o.tui.requestRender();
			});
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const page = Math.max(1, Math.floor(this.bodyHeight() / 2));
		if (matchesKey(data, Key.escape)) {
			if (this.input.getValue() !== "") this.input.setValue("");
			else this.back();
		} else if (matchesKey(data, Key.ctrl("o"))) {
			const row = this.row();
			if (!row) {
				// nothing
			} else if (this.input.getValue().trim() !== "") this.say("send the message or clear it (Esc) first", "warning");
			else if (row.pid !== null || row.reaped || Date.now() - this.armedAt <= ARM_MS) this.o.done({ attach: row });
			else {
				// an ended subagent starts again: press twice, as → in the panel
				this.armedAt = Date.now();
				this.say(`${oneLine(row.name)} is ${row.state} · Ctrl+O again starts it`, "warning");
			}
		} else if (matchesKey(data, Key.enter)) {
			if (this.input.getValue().trim() !== "") this.submit();
			else {
				const nav = this.nav();
				this.resolveSel(nav);
				const n = nav[this.sel];
				if (n?.kind === "back") this.back();
				else if (n && n.row.id !== this.id) this.go(n.row);
			}
		} else if (matchesKey(data, Key.up)) {
			this.resolveSel(this.nav());
			this.select(this.sel - 1);
		} else if (matchesKey(data, Key.down)) {
			this.resolveSel(this.nav());
			this.select(this.sel + 1);
		}
		else if (matchesKey(data, Key.pageUp)) this.scroll += page;
		else if (matchesKey(data, Key.pageDown)) this.scroll = Math.max(0, this.scroll - page);
		else this.input.handleInput(data);
		this.o.tui.requestRender();
	}

	private height(): number {
		return Math.max(1, this.o.tui.terminal.rows || 30);
	}

	private navHeight(n: number): number {
		// a short terminal keeps the transcript and the message box; the tree goes first
		if (this.height() < 10) return 0;
		return Math.min(n, NAV_MAX, Math.max(1, Math.floor(this.height() / 3)));
	}

	private bodyHeight(): number {
		// header 2, separator 1, nav, input 1, hint 1
		return Math.max(1, this.height() - 5 - this.navHeight(this.nav().length));
	}

	private transcriptLines(width: number): string[] {
		if (this.lines && this.lines.width === width && this.lines.items === this.items) return this.lines.out;
		const { fg } = this.o.theme;
		const w = Math.max(1, width - 2);
		const out: string[] = [];
		const wrap = (text: string, lead: string, rest: string, color?: string) => {
			const wrapped = wrapTextWithAnsi(text, Math.max(1, w - visibleWidth(lead)));
			wrapped.forEach((l, i) => out.push(truncateToWidth(`${i === 0 ? lead : rest}${color ? fg(color, l) : l}`, width)));
		};
		for (const it of this.items) {
			if (it.kind === "user") {
				out.push("");
				wrap(it.text, ` ${fg("accent", "›")} `, "   ", "accent");
			} else if (it.kind === "assistant") {
				out.push("");
				wrap(it.text, "   ", "   ");
			} else if (it.kind === "tool") {
				out.push(truncateToWidth(` ${fg(it.error ? "error" : "muted", "●")} ${fg("muted", it.name)}${it.args ? fg("dim", ` ${oneLine(it.args)}`) : ""}`, width, "…"));
				if (it.result) {
					const rl = it.result.split("\n");
					rl.slice(0, RESULT_LINES).forEach((l, i) => out.push(truncateToWidth(`   ${fg("dim", i === 0 ? "⎿ " : "  ")}${fg(it.error ? "error" : "dim", l)}`, width, "…")));
					if (rl.length > RESULT_LINES) out.push(fg("dim", truncateToWidth(`     … +${rl.length - RESULT_LINES} lines`, width)));
				}
			} else {
				out.push(fg("dim", truncateToWidth(` · ${oneLine(it.text)}`, width, "…")));
			}
		}
		this.lines = { width, items: this.items, out };
		return out;
	}

	render(width: number): string[] {
		const { fg, bold } = this.o.theme;
		const fit = (s: string) => truncateToWidth(s, width, "…");
		const row = this.row();
		const H = this.height();
		const out: string[] = [];
		// header: the path back to main, and the subagent's state
		const path = row ? pathOf(row, this.o.rows(), this.o.main) : [];
		const crumbs = [fg("dim", "main"), ...path.map((r) => fg("dim", oneLine(r.name))), bold(oneLine(row?.name ?? "subagent"))].join(fg("dim", " › "));
		const icon = row ? iconOf(row, 0) : undefined;
		const right = row ? fg("dim", `${row.state} · ${ageOf(row, Date.now())}`) : "";
		const left = `${icon ? `${fg(icon.tone, icon.glyph)} ` : ""}${crumbs}`;
		const gap = width - visibleWidth(left) - visibleWidth(right) - 2;
		out.push(fit(gap >= 1 ? ` ${left}${" ".repeat(gap)}${right} ` : ` ${left}`));
		out.push(fg("dim", "─".repeat(Math.max(0, width))));
		// the conversation, its end at the bottom
		const body = this.bodyHeight();
		let lines = this.transcriptLines(width);
		if (this.failure) lines = [fg("dim", fit(`   ${this.failure}`))];
		if (row && row.pid !== null && (row.state === "working" || row.state === "blocked")) {
			lines = [...lines, "", fg(row.state === "blocked" ? "warning" : "dim", fit(`   ${oneLine(sentenceOf(row))}`))];
		}
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - body));
		const end = lines.length - this.scroll;
		const shown = lines.slice(Math.max(0, end - body), end);
		for (let i = shown.length; i < body; i++) out.push("");
		out.push(...shown);
		// the tree around it: back, siblings, children
		const nav = this.nav();
		this.resolveSel(nav);
		const nh = this.navHeight(nav.length);
		const from = Math.max(0, Math.min(this.sel - Math.floor(nh / 2), nav.length - nh));
		out.push(fg("dim", fit(this.scroll > 0 ? `─── ↑ ${this.scroll} lines up · PgDn ${"─".repeat(Math.max(0, width))}` : "─".repeat(Math.max(0, width)))));
		nav.slice(from, from + nh).forEach((n, k) => {
			const selected = from + k === this.sel;
			const lead = selected ? fg("accent", "› ") : "  ";
			if (n.kind === "back") {
				out.push(fit(`${lead}${fg("dim", `← ${n.row ? oneLine(n.row.name) : "main"}`)}`));
				return;
			}
			const r = n.row;
			const ic = iconOf(r, 0);
			const name = oneLine(r.name);
			const current = r.id === this.id;
			const label = current ? bold(name) : selected ? bold(name) : name;
			out.push(fit(`${lead}${n.depth ? "  └ " : ""}${fg(ic.tone, ic.glyph)} ${label}${current ? fg("dim", " (shown)") : ""}  ${fg("dim", oneLine(sentenceOf(r)))}`));
		});
		// the message box and the keys
		const prompt = `message ${truncateToWidth(oneLine(row?.name ?? ""), 16, "…")} › `;
		const inputLine = this.input.render(Math.max(1, width - visibleWidth(prompt)))[0] ?? "";
		out.push(fit(`${fg("accent", prompt)}${inputLine}`));
		const notice = this.notice && Date.now() < this.notice.until ? this.notice : undefined;
		const keys = notice
			? fg(notice.tone, oneLine(notice.text))
			: fg(
					"dim",
					this.input.getValue()
						? "↵ send · Esc clear"
						: width >= 100
							? "type to message · ↑↓ select · ↵ open · Esc back · PgUp/PgDn scroll · Ctrl+O attach"
							: "type to message · ↑↓ ↵ · Esc back · Ctrl+O attach · PgUp/PgDn",
				);
		out.push(fit(` ${keys}`));
		// a tiny terminal: the message box and the keys stay, the transcript gives way
		return out.length > H ? [...out.slice(0, Math.max(0, H - 2)), ...out.slice(-2)].slice(-H) : out;
	}

	invalidate(): void {
		this.lines = undefined;
	}
}
