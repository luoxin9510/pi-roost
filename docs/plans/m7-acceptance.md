# M7 — parity extras (P2): acceptance (2026-11-03)

Acceptance (PRD §10): every P2 row of §2 is shipped or moved to Deferred
with a reason.

## Shipped

| P2 row | Where | Check |
|--------|-------|-------|
| `defaultToAgentsView` opens the view on a plain launch | `extensions/foreground.ts` | live: plain `pi` opens the view (Esc returns to the session); `pi "Reply with just HELLO"` does not, and answers |
| Exit with background work offers "Move to background and exit" (BG-9) | `foreground.ts` | live: Ctrl+D during `sleep 12` → dialog; choosing Move printed `backgrounded · 55bc5d61 · …`; the worker finished (`quit.txt` = QUIT) |
| Ctrl+G external editor | `agent-view.ts` | test: `$VISUAL` writes two lines → input `first line [+1 lines]` → the job gets both lines |
| NT-3 programmatic API `spawn` / `list` / `attach` | `lib/api.ts`, `pi-roost/api` export | live: `spawn({task, cwd, model, loadExtension: true})` → `list()` showed it done with "API" |
| Alt+1…9 attach to row N of the focused directory | M6a | — |
| Version-skew warning and `respawn --all` (no auto-update) | M5a | — |

BG-9 details: pi stops its TUI before `session_shutdown`, so the offer is
made earlier. Ctrl+D on an empty prompt, or Enter on `/quit` or `/exit`,
while a turn runs opens a select: Move to background and exit, Exit
(stops the turn), Cancel. When idle, quitting is pi's own. On "Move" the
turn is aborted and pi shuts down. The extension's first shutdown handler
releases the writer lock; after it, the foreground handler has the daemon
adopt the file with "Continue where you left off.", and the confirmation
is printed after pi exits.

`spawn` takes `loadExtension: true` when pi-roost is not an installed pi
package (a checkout): workers need the extension to report their state.

## Deferred

| P2 row | Reason |
|--------|--------|
| C7 worktree isolation for `--bg` (`worktree.bgIsolation`) | Needs git worktree lifecycle (create, branch naming, cleanup on rm, conflicts with uncommitted work) and moving a running worker's cwd (R4: restart from the session file). Its own design pass; risky to default on. |
| PR status, "Ready for review" group, `#PR` filter and URL match | Needs a forge integration (gh/GitLab auth, polling, rate limits) that pi does not provide; nothing in pi-roost knows a session's branch yet (C7). |
| `a:` filter, first word / `@name` selecting a preset as main agent | pi has no built-in agent presets; it depends on a preset extension's API, which differs between extensions. |
| Paste collapse over 800 chars, image paste | The view's single-line `Input` has neither. pi's editor component can be embedded in a later pass; Ctrl+G covers long and multi-line tasks now. |
| Shift+Enter / Ctrl+J newline in the dispatch input (AV-K5) | Same: single-line `Input`; Ctrl+G is the multi-line path. |
| BG-8: Enter on the /fork confirmation switches into the copy | pi's `notify` lines are not interactive. The copy is one ← away in the agent view. |

## Tests

Automated: 15 files, 131 tests (BG-9 offer and adopt-on-quit, Exit,
first-turn refusal, idle and Cancel paths, Ctrl+G).

## Review fixes (PR #9)

- "Exit (stops the turn)" aborts the turn first: pi only quits when idle,
  so it used to wait for the turn to finish.
- Move before the session's first reply (no file yet) is refused with a
  notice instead of silently becoming a plain exit; a turn that ended
  while the dialog was open is handed over without "Continue…".
- The defaultToAgentsView timer is guarded and cleared on shutdown.
- Ctrl+G quotes the file path for the shell and cleans up on errors.
- `spawn()` refuses to guess the pi cli from a plain script's argv (it
  would run the script again); pass `piCli`.
- Package exports point the API types at emitted `.d.ts` files.
- Limits: pi's double Ctrl+C still quits without the offer (it is pi's own
  shortcut), and Enter on `/quit` while the autocomplete menu shows
  another entry counts as quitting.

Re-checked live: Move during `sleep 12` → `backgrounded · f58feef9 · …`,
the worker wrote `quit.txt` = QUIT2.
