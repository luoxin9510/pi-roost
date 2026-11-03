import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, parseKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { attachToHost, type DetachReason } from "../lib/attach.ts";
import { DaemonClient } from "../lib/client.ts";
import { hostSocketPath } from "../lib/paths.ts";
import type { DispatchArgs, Event, JobRow } from "../lib/protocol.ts";
import {
	ageOf,
	counts,
	formatDuration,
	headerText,
	iconOf,
	type Item,
	items,
	layout,
	nameToneOf,
	type Section,
	sentenceOf,
	titleText,
	type Tone,
} from "../lib/view-model.ts";

const MIN_TASK = 4; // DI-1
const DOUBLE_PRESS_MS = 2000; // Ctrl+X delete, Ctrl+C exit
const NOTICE_MS = 4000;
const SPIN_MS = 150;

export interface AgentViewOptions {
	tui: TUI;
	theme: Theme;
	/** Directory new jobs start in. */
	cwd: string;
	/** AV-7: show only jobs started under this directory. */
	cwdFilter?: string;
	/** Builds the dispatch request for a task typed into the view. */
	launch: (task: string) => DispatchArgs;
	setTitle: (title: string) => void;
	/** AV-9: a row to keep bold (the conversation just moved to the background). */
	highlightId?: string;
	/** Screen-reader mode: no animation (PRD accessibility). */
	reducedMotion?: boolean;
	done: () => void;
}

interface Notice {
	text: string;
	tone: Tone;
	until: number;
}

/** The agent view (PRD §6.1–6.5) as one focused pi-tui component. */
export class AgentView implements Component {
	private o: AgentViewOptions;
	private client: DaemonClient | undefined;
	private rows = new Map<string, JobRow>();
	private collapsed = new Set<Section["key"]>();
	private cursor: { kind: "row"; id: string } | { kind: "header"; key: Section["key"] } | undefined;
	private peek = false;
	private help = false;
	private input = new Input({ prompt: "› ", placeholder: "describe a task and press Enter to start it in the background" });
	private reply = new Input({ prompt: "reply › " });
	private notice: Notice | undefined;
	private armedStop: { id: string; at: number } | undefined;
	private ctrlCAt = 0;
	private frame = 0;
	private spinner: NodeJS.Timeout | undefined;
	private attached = false;
	private closed = false;
	private connectError: string | undefined;
	private nameWidth = 16;

	constructor(o: AgentViewOptions) {
		this.o = o;
		this.input.focused = true;
	}

	// ---- lifecycle -------------------------------------------------------

	async start(): Promise<void> {
		await this.connect();
		this.spinner = setInterval(() => {
			if (this.attached || this.o.reducedMotion) return;
			const busy = [...this.rows.values()].some((r) => r.pid !== null && r.status === "busy");
			if (busy || this.notice) {
				this.frame++;
				this.o.tui.requestRender();
			}
		}, SPIN_MS);
	}

	dispose(): void {
		this.closed = true;
		clearInterval(this.spinner);
		this.client?.close();
		this.client = undefined;
	}

	private async connect(): Promise<void> {
		try {
			const client = await DaemonClient.connectOrStart();
			if (this.closed) return client.close();
			client.onEvent((e) => this.onEvent(e));
			await client.request("subscribe", {});
			const { jobs } = await client.request("list", this.o.cwdFilter ? { cwd: this.o.cwdFilter } : {});
			this.rows = new Map(jobs.map((j) => [j.id, j]));
			this.client = client;
			this.connectError = undefined;
			// AV-8: pushed events only; reconnect if the daemon goes away.
			this.watchConnection(client);
		} catch (err) {
			this.connectError = (err as Error).message;
			setTimeout(() => !this.closed && void this.connect(), 2000).unref?.();
		}
		this.render0();
	}

	private watchConnection(client: DaemonClient): void {
		const timer = setInterval(() => {
			if (this.closed) return clearInterval(timer);
			client.request("ping", {}).catch(() => {
				clearInterval(timer);
				if (this.client === client) this.client = undefined;
				if (!this.closed) void this.connect();
			});
		}, 5000);
		timer.unref?.();
	}

	private onEvent(e: Event): void {
		if (e.event === "job") {
			if (this.o.cwdFilter && !within(e.job.cwd, this.o.cwdFilter)) return;
			this.rows.set(e.job.id, e.job);
		} else if (e.event === "removed") this.rows.delete(e.id);
		this.render0();
	}

	private render0(): void {
		this.o.setTitle(titleText(counts([...this.rows.values()])));
		this.o.tui.requestRender();
	}

	// ---- model -----------------------------------------------------------

	private sections(): Section[] {
		const height = this.o.tui.terminal.rows || 30;
		return layout([...this.rows.values()], {
			collapsed: this.collapsed,
			// AV-5: keep live groups visible on short terminals
			maxCompleted: Math.max(3, height - 14),
		});
	}

	private itemList(): Item[] {
		return items(this.sections());
	}

	private selectedIndex(list: Item[]): number {
		const c = this.cursor;
		if (c) {
			const i = list.findIndex((it) =>
				c.kind === "row" ? it.kind === "row" && it.row.id === c.id : it.kind === "header" && it.section.key === c.key,
			);
			if (i >= 0) return i;
		}
		const firstRow = list.findIndex((it) => it.kind === "row");
		return firstRow >= 0 ? firstRow : 0;
	}

	private selected(): Item | undefined {
		const list = this.itemList();
		return list[this.selectedIndex(list)];
	}

	private selectedRow(): JobRow | undefined {
		const it = this.selected();
		return it?.kind === "row" ? it.row : undefined;
	}

	private move(delta: number | "home" | "end"): void {
		const list = this.itemList();
		if (list.length === 0) return;
		const cur = this.selectedIndex(list);
		const next = delta === "home" ? 0 : delta === "end" ? list.length - 1 : Math.max(0, Math.min(list.length - 1, cur + delta));
		const it = list[next]!;
		this.cursor = it.kind === "row" ? { kind: "row", id: it.row.id } : { kind: "header", key: it.section.key };
		this.reply.setValue("");
	}

	private say(text: string, tone: Tone = "muted"): void {
		this.notice = { text, tone, until: Date.now() + NOTICE_MS };
		this.o.tui.requestRender();
	}

	// ---- input -----------------------------------------------------------

	handleInput(data: string): void {
		if (this.attached) return;
		const key = parseKey(data);
		if (this.help) {
			this.help = false;
			this.o.tui.requestRender();
			return;
		}
		const typing = this.peek ? this.reply : this.input;
		const text = typing.getValue();

		switch (key) {
			case "up":
				return this.moveAndRender(-1);
			case "down":
				return this.moveAndRender(1);
			case "pageUp":
				return this.moveAndRender(-10);
			case "pageDown":
				return this.moveAndRender(10);
			case "home":
				if (text) break;
				return this.moveAndRender("home");
			case "end":
				if (text) break;
				return this.moveAndRender("end");
			case "right":
				if (text) break;
				return void this.attachSelected();
			case "escape":
				return this.escape();
			case "ctrl+c":
				return this.ctrlC();
			case "ctrl+x":
				return void this.stopSelected();
			case "ctrl+enter":
				if (!this.peek) return void this.dispatch(true);
				break;
			case "enter":
				return void this.enter();
			case "space":
				if (!text) return this.togglePeek();
				break;
			case "?":
				if (!text) {
					this.help = true;
					this.o.tui.requestRender();
					return;
				}
				break;
		}
		// PK-3: a digit on an empty reply fills the numbered choice
		if (this.peek && !text && key && /^[1-9]$/.test(key)) {
			const choice = this.selectedRow()?.choices[Number(key) - 1];
			if (choice) {
				this.reply.setValue(choice);
				this.o.tui.requestRender();
				return;
			}
		}
		typing.handleInput(data);
		this.o.tui.requestRender();
	}

	private moveAndRender(delta: number | "home" | "end"): void {
		this.move(delta);
		this.o.tui.requestRender();
	}

	private togglePeek(): void {
		const row = this.selectedRow();
		this.peek = !this.peek && row !== undefined;
		// pin the selection to this row so it follows it into another group
		if (row) this.cursor = { kind: "row", id: row.id };
		this.reply.focused = this.peek;
		this.input.focused = !this.peek;
		this.reply.setValue("");
		this.o.tui.requestRender();
	}

	/** AV-K15: close peek → clear input → exit. */
	private escape(): void {
		if (this.peek) return this.togglePeek();
		if (this.input.getValue()) {
			this.input.setValue("");
			this.o.tui.requestRender();
			return;
		}
		this.o.done();
	}

	/** AV-K16: clear input; twice to exit. */
	private ctrlC(): void {
		const typing = this.peek ? this.reply : this.input;
		if (typing.getValue()) {
			typing.setValue("");
			this.ctrlCAt = 0;
			this.o.tui.requestRender();
			return;
		}
		const now = Date.now();
		if (now - this.ctrlCAt < DOUBLE_PRESS_MS) return this.o.done();
		this.ctrlCAt = now;
		this.say("Ctrl+C again to exit (background sessions keep running)");
	}

	private async enter(): Promise<void> {
		if (this.peek) return this.sendReply();
		if (this.input.getValue().trim()) return this.dispatch(false);
		const it = this.selected();
		if (it?.kind === "header") {
			if (this.collapsed.has(it.section.key)) this.collapsed.delete(it.section.key);
			else this.collapsed.add(it.section.key);
			this.o.tui.requestRender();
			return;
		}
		return this.attachSelected();
	}

	// ---- actions ---------------------------------------------------------

	private async dispatch(attach: boolean): Promise<void> {
		const task = this.input.getValue().trim();
		if (task.length < MIN_TASK) return this.say("Too short", "warning");
		if (!this.client) return this.say("background service unavailable", "error");
		try {
			const { id, name } = await this.client.request("dispatch", this.o.launch(task));
			this.input.setValue("");
			this.cursor = { kind: "row", id };
			this.say(`started · ${name}`, "success");
			if (attach) {
				const deadline = Date.now() + 3000;
				while (!this.rows.get(id)?.pid && Date.now() < deadline) await sleep(50);
				await this.attachTo(id);
			}
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private async sendReply(): Promise<void> {
		const row = this.selectedRow();
		const text = this.reply.getValue().trim();
		if (!row || !text || !this.client) return;
		try {
			const r = await this.client.request("reply", { id: row.id, text });
			this.reply.setValue("");
			if (r.stopped) this.say(`stopped · ${row.name}`);
			else if (r.delivered) {
				this.say(row.waitingFor === "dialog" ? "queued; attach (→) to answer the dialog" : `sent · ${row.name}`, "success");
			} else if (r.saved) this.say("saved; it is sent when the session starts again", "warning");
			else this.say("not delivered: the session is not running", "error");
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	/** AV-K12: stop; again within 2 s delete; on a header, the whole group. */
	private async stopSelected(): Promise<void> {
		if (!this.client) return;
		const it = this.selected();
		if (!it) return;
		const targets = it.kind === "row" ? [it.row] : it.section.rows;
		if (targets.length === 0) return;
		const key = it.kind === "row" ? it.row.id : `group:${it.section.key}`;
		const now = Date.now();
		const armed = this.armedStop?.id === key && now - this.armedStop.at < DOUBLE_PRESS_MS;
		this.armedStop = { id: key, at: now };
		try {
			if (armed || targets.every((r) => r.pid === null)) {
				if (!armed) return this.say("Ctrl+X again to delete", "warning");
				for (const r of targets) await this.client.request("rm", { id: r.id });
				this.armedStop = undefined;
				this.say(targets.length === 1 ? `deleted · ${targets[0]!.name}` : `deleted ${targets.length} sessions`);
			} else {
				for (const r of targets) if (r.pid !== null) await this.client.request("stop", { id: r.id });
				this.say(`stopping${targets.length > 1 ? ` ${targets.length} sessions` : ""} · Ctrl+X again to delete`, "warning");
			}
		} catch (err) {
			this.say((err as Error).message, "error");
		}
	}

	private async attachSelected(): Promise<void> {
		const row = this.selectedRow();
		if (row) await this.attachTo(row.id);
	}

	/** AT-1/AT-2: hand the terminal to the job's PTY host, then repaint. */
	private async attachTo(id: string): Promise<void> {
		const row = this.rows.get(id);
		if (!row) return;
		if (row.pid === null) return this.say(`${row.name} is not running (restarting ended sessions comes later)`, "warning");
		const { tui } = this.o;
		this.attached = true;
		let reason: DetachReason;
		tui.stop();
		try {
			reason = await attachToHost(hostSocketPath(id), { stdin: process.stdin, stdout: process.stdout });
		} finally {
			this.attached = false;
			tui.start();
			tui.requestRender(true);
		}
		this.cursor = { kind: "row", id };
		if (reason === "takeover") this.say("Attached elsewhere", "warning");
		else if (reason === "exit") this.say(`${row.name} ended`);
		else if (reason === "error" || reason === "closed") this.say(`lost the connection to ${row.name}`, "error");
	}

	// ---- render ----------------------------------------------------------

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.o.theme;
		const w = Math.max(20, width);
		const now = Date.now();
		if (this.notice && now > this.notice.until) this.notice = undefined;
		const all = [...this.rows.values()];
		const c = counts(all);
		const out: string[] = [];
		const short = (this.o.tui.terminal.rows || 30) < 18;

		out.push(t.bold("pi agents") + t.fg("dim", `  ${headerText(c)}`));
		if (!short) out.push(t.fg("border", "─".repeat(w)));
		if (this.connectError) out.push(t.fg("error", truncateToWidth(`background service: ${this.connectError}`, w)));

		if (this.help) return [...out, ...this.helpLines(w)];

		const sections = this.sections();
		const list = items(sections);
		this.nameWidth = Math.min(28, Math.floor(w / 3), Math.max(8, ...all.map((r) => visibleWidth(r.name))));
		const sel = this.selectedIndex(list);
		const empty = all.length === 0;
		list.forEach((it, i) => {
			const isSel = i === sel;
			if (it.kind === "header") {
				const s = it.section;
				const label = `${s.collapsed ? "▸" : "▾"} ${s.title}${s.rows.length || s.hidden ? ` (${s.rows.length + s.hidden})` : ""}`;
				const hint = empty ? t.fg("dim", `  ${s.hint}`) : "";
				out.push(this.mark(isSel, truncateToWidth(t.bold(label) + hint, w - 2)));
				return;
			}
			out.push(this.mark(isSel, this.rowLine(it.row, w - 2, now)));
			const lastOfSection = list[i + 1]?.kind !== "row" || list[i + 1]?.section !== it.section;
			if (lastOfSection && it.section.hidden > 0) out.push(`  ${t.fg("dim", `… ${it.section.hidden} more`)}`);
			if (isSel && this.peek) out.push(...this.peekLines(it.row, w, now));
		});

		out.push("");
		if (!this.peek) out.push(...this.input.render(w));
		if (this.notice) out.push(t.fg(this.notice.tone, truncateToWidth(this.notice.text, w)));
		out.push(t.fg("dim", truncateToWidth(this.footer(), w)));
		return out;
	}

	private mark(selected: boolean, line: string): string {
		return selected ? `${this.o.theme.fg("accent", "›")} ${line}` : `  ${line}`;
	}

	private rowLine(row: JobRow, width: number, now: number): string {
		const t = this.o.theme;
		const icon = iconOf(row, this.frame, !this.o.reducedMotion);
		const age = ageOf(row, now);
		const name = truncateToWidth(row.name, this.nameWidth);
		const pad = " ".repeat(Math.max(0, this.nameWidth - visibleWidth(name)));
		const styled = row.id === this.o.highlightId ? t.bold(t.fg(nameToneOf(row.id), name)) : t.fg(nameToneOf(row.id), name);
		const head = `${t.fg(icon.tone, icon.glyph)} ${styled}${pad}  `;
		const room = width - visibleWidth(head) - age.length - 2;
		const summary = room > 4 ? t.fg(row.pid === null ? "dim" : "muted", truncateToWidth(sentenceOf(row), room)) : "";
		const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(summary) - age.length);
		return `${head}${summary}${" ".repeat(gap)}${t.fg("dim", age)}`;
	}

	/** PK-1: the full sentence, choices, waiting time, and the reply input. */
	private peekLines(row: JobRow, width: number, now: number): string[] {
		const t = this.o.theme;
		const inner = width - 4;
		const lines: string[] = [];
		const sentence = sentenceOf(row);
		for (const chunk of wrap(sentence, inner)) lines.push(`    ${chunk}`);
		row.choices.forEach((c, i) => lines.push(`    ${t.fg("accent", `${i + 1}.`)} ${truncateToWidth(c, inner - 4)}`));
		const facts: string[] = [row.state + (row.status ? ` · ${row.status}` : "")];
		if (row.state === "blocked") facts.push(`waiting ${formatDuration(now - row.stateSince)}`);
		if (row.model) facts.push(row.model);
		facts.push(row.id);
		lines.push(`    ${t.fg("dim", truncateToWidth(facts.join(" · "), inner))}`);
		if (row.waitingFor === "dialog") lines.push(`    ${t.fg("warning", "a dialog is open: attach (→) to answer it; replies wait for it")}`);
		for (const l of this.reply.render(inner)) lines.push(`    ${l}`);
		return lines;
	}

	private footer(): string {
		if (this.peek) return "Enter send · 1-9 pick · ↑↓ next · → attach · /stop stops · Esc close";
		return "↑↓ select · Enter/→ attach · Space peek · Ctrl+Enter start+attach · Ctrl+X stop · ? keys · Esc exit";
	}

	private helpLines(width: number): string[] {
		const t = this.o.theme;
		const keys: [string, string][] = [
			["↑ ↓ PgUp PgDn Home End", "move"],
			["Enter", "attach · start the typed task · fold a group"],
			["→", "attach"],
			["Space", "peek and reply"],
			["Ctrl+Enter", "start the typed task and attach"],
			["Ctrl+X", "stop; again within 2 s to delete (on a header: the group)"],
			["Esc", "close peek · clear input · exit"],
			["Ctrl+C", "clear input; twice to exit"],
			["in a session", "← on an empty prompt, /exit or Ctrl+Z detaches"],
		];
		return [
			"",
			...keys.map(([k, v]) => truncateToWidth(`  ${t.fg("accent", k.padEnd(24))}${v}`, width)),
			"",
			t.fg("dim", "any key to close"),
		];
	}
}

function within(dir: string, root: string): boolean {
	return dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let line = "";
		for (const word of para.split(/\s+/)) {
			if (!word) continue;
			if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) {
				out.push(line);
				line = "";
			}
			line = line ? `${line} ${word}` : word;
		}
		if (line) out.push(truncateToWidth(line, width));
	}
	return out.slice(0, 6);
}
