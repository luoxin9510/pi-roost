# M17: the task input is pi's editor

Status: implemented (2026-11-04). Deferred in M7 ("the view's single-line Input has
neither"): Shift+Enter / Ctrl+J newlines (AV-K5) and paste collapse over long text.

- `extensions/task-editor.ts` wraps pi-tui's `Editor` (the base of pi's own prompt
  editor) with the small API the view used from `Input`: `getValue` (paste markers
  expanded), `setValue`, `focused`, `handleInput`, `render`, plus `multiline()` and
  `atEdge()`.
- The view keeps its keys (Enter dispatches, Ctrl+Enter starts and attaches, Esc, Tab
  for `@dir`, Space/? on an empty input). Shift+Enter, Alt+Enter and Ctrl+J reach the
  editor and add a line. ↑/↓ move the row selection, except inside a task of several
  lines, where they move the cursor until the first or last line.
- A long bracketed paste becomes `[paste #1 +30 lines]` on screen and is sent in full.
- Ctrl+G's result goes into the editor as it is (no more `first line [+N lines]`
  placeholder); the TUI stops with `preserveScreen` (M14).
- Empty, the editor's line shows the hint.

Not ported: image paste. pi's `CustomEditor` reads images from the clipboard through
pi's keybinding manager, which extensions do not get; and a dispatched session's first
prompt is text.
