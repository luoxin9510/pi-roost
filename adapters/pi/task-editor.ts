// M17: the agent view's task input is pi's editor (pi-tui Editor): several lines
// (Shift+Enter), a long paste folded into a marker, undo, a kill ring, word moves, as
// in pi's own prompt. The view keeps Enter, ↑↓ between rows and its other keys.
import { Editor, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface TaskEditorTheme {
	border: (s: string) => string;
	dim: (s: string) => string;
	accent: (s: string) => string;
}

export class TaskEditor {
	private ed: Editor;
	private theme: TaskEditorTheme;
	private placeholder: string;
	constructor(tui: TUI, theme: TaskEditorTheme, placeholder: string) {
		this.theme = theme;
		this.placeholder = placeholder;
		const edTheme: EditorTheme = {
			borderColor: theme.border,
			selectList: { selectedPrefix: theme.accent, selectedText: theme.accent, description: theme.dim, scrollInfo: theme.dim, noMatch: theme.dim },
		};
		this.ed = new Editor(tui, edTheme, { paddingX: 1 });
		// the view decides what Enter does; the editor only keeps the text
		this.ed.disableSubmit = true;
	}

	get focused(): boolean {
		return this.ed.focused;
	}
	set focused(v: boolean) {
		this.ed.focused = v;
	}

	/** The task as typed, a folded paste expanded. */
	getValue(): string {
		return this.ed.getExpandedText();
	}

	setValue(text: string): void {
		this.ed.setText(text);
	}

	handleInput(data: string): void {
		this.ed.handleInput(data);
	}

	/** Replace the last `count` characters of the text (an `@dir` being completed); the cursor goes to the end. */
	replaceTail(count: number, text: string): void {
		const lines = this.ed.getLines();
		const { line, col } = this.ed.getCursor();
		if (line !== lines.length - 1 || col !== (lines.at(-1) ?? "").length) {
			// not typing at the end: the word is the text's last, so retype from there
			this.ed.setText(this.ed.getText());
		}
		for (let i = 0; i < count; i++) this.ed.handleInput("\x7f");
		this.ed.insertTextAtCursor(text);
	}

	/** Between a bracketed paste's start and end. */
	inPaste(): boolean {
		return (this.ed as unknown as { isInPaste?: boolean }).isInPaste === true;
	}

	/** More than one line: ↑↓ move within the text, not between rows. */
	multiline(): boolean {
		return this.ed.getLines().length > 1;
	}

	/** ↑ on the first line or ↓ on the last leaves the text (to the rows). */
	atEdge(dir: "up" | "down"): boolean {
		const { line } = this.ed.getCursor();
		return dir === "up" ? line === 0 : line >= this.ed.getLines().length - 1;
	}

	render(width: number): string[] {
		const lines = this.ed.render(width);
		if (this.ed.getText() !== "" || lines.length < 3) return lines;
		// the empty editor's line carries the hint, after the cursor
		const i = 1;
		const line = lines[i]!.replace(/\s+$/, "");
		const room = width - visibleWidth(line) - 1;
		if (room > 4) lines[i] = `${line} ${this.theme.dim(truncateToWidth(this.placeholder, room))}`;
		return lines;
	}
}
