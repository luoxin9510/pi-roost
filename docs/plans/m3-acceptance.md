# M3 — agent view core: acceptance (2026-11-03)

Scope (PRD §10): AV-1…AV-9, AV-K1…K4, K12, K15–17, DI-1, DI-2, PK-1…PK-5,
AT-1…AT-4, AT-6. Acceptance: flows 5.1, 5.2, 5.3 pass manually.

Delivered in two PRs:

- **M3a (#2)** — daemon `reply`/`ack` with seq-numbered, acknowledged
  delivery (saved replies for workers that are not connected, PK-5); the
  worker's serial reply queue (settings at once, prompt when idle,
  follow-up once a run has started, held behind dialogs and during
  compaction, PK-2/PK-4); worker detach keys (←, `/exit`, double Ctrl+C,
  double Ctrl+D; AT-3); `pi-roost reply`.
- **M3b** — the view: `lib/view-model.ts` (groups, fold, icons, ages,
  counts, sentences) and `extensions/agent-view.ts` (one pi-tui component
  opened by `pi --agents`, `--agents-cwd <dir>` or `/agents`).

## Manual run (stock pi 1.5.0, tmux 110×32, deepseek-flash)

Four jobs prepared with `pi --bg`: a `confirm()` fixture, a question, a
long `sleep`, a one-word answer.

| Flow / key | Result |
|------------|--------|
| `pi --agents --no-session` | Header `2 needs input · 0 working · 2 completed`, groups Needs input / Completed, ✻ icons, tinted names in one column, right-aligned ages |
| 5.2 Space on the question row | Panel: full question, `blocked · waiting · waiting 43s · deepseek/deepseek-flash · <id>`, reply input |
| Type a reply, Enter | `sent · style-question`; the row moved to Completed with "Tabs" |
| 5.1 `abc` + Enter | `Too short` (DI-1) |
| Task + Enter | `started · …`; new row appeared and finished with "VIEW DISPATCH OK" |
| 5.3 → | Worker's own pi TUI, full screen |
| ← on its empty prompt | Back in the view, same row selected |
| Ctrl+X | `stopping · Ctrl+X again to delete`, icon ∙ |
| Ctrl+X again | `deleted · …`, row gone |
| `?` | Shortcut overlay; any key closes it |
| Esc | Leaves the view; `pi --agents` exits |
| `/agents` in a normal session, Esc | View opens in place of the editor; Esc returns to the session |
| AT-6: attach from the view, then `pi-roost attach` in another terminal | View shows `Attached elsewhere` |

Automated: 9 files, 79 tests (adds `test/view-model.test.ts`,
`test/reply-queue.test.ts`).

## Review fixes (PR #3)

Independent review found a crash: the header line was not truncated, and
pi-tui stops the whole session on a line wider than the terminal (any pane
under ~52 columns). Also fixed: a reply could go to another row after the
peeked one vanished; a double Enter dispatched twice; the spinner and
daemon connections could outlive the view; `--agents` errors were
unhandled; multi-line errors and control characters reached row lines;
the title was not restored; daemon events repainted during attach; tasks
starting with `-` became flags in the worker (`--` before the task).
`test/agent-view.test.ts` drives the component with a fake TUI and daemon,
including every width from 1 to 120 columns with CJK and stack traces.
Checked live at 40 columns. Automated total: 10 files, 85 tests.

A `pi --bg` value that starts with `-` is read by pi itself as another
flag; write `--bg="-x …"` for such tasks.

## Not in M3

- Ctrl+Enter needs a terminal that reports modified Enter (kitty
  protocol or tmux `extended-keys on`); Enter then → works everywhere.
- ← backgrounding of a foreground session and the AV-9 banner: M4 (the
  view already supports a highlighted row).
- Attaching to an ended job (respawn): M5. The view says it is not running.
- Model-written summaries, `!cmd` replies, filters, Alt+N, rename,
  reorder, pin: M5–M6.
