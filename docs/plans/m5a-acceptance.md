# M5a — lifecycle: acceptance (2026-11-03)

Scope (PRD §10, first half of M5): DM-4, DM-5, DM-7, DM-9, AT-1 respawn.
Acceptance: a reaped job reattaches with its snapshot, then the live TUI;
flow 5.7 passes. Summaries, auto-names, recap and notifications (SM-2,
SM-4, DI-9, AT-5, NT-1, NT-2) follow in M5b.

## Design

- **Respawn** (daemon op `respawn`, `pi-roost respawn <id>|--all`): starts
  the same job id again from its session file. The host now runs
  `state.command` when set; the respawn command is the dispatch command
  without its first prompt (it is already in the session) plus an
  optional new one. A session pi never wrote keeps the first prompt. The
  exit record is cleared first so the next finalize is not confused.
- A respawned worker without a prompt restores its row from the session's
  last reply (`WorkerTracker.restore`): done, or a question → Needs input.
- **DM-4 reaping**: every 30 s, live jobs that are not working, not in a
  dialog, not pinned, idle for `reapIdleMinutes` (user settings, default
  60) and not attached (host `status`) are terminated; the row keeps its
  state and age and gets `reaped: true` (∙ icon).
- **AT-1**: attaching (view or CLI) to a job without a worker respawns it,
  draws the last `screen.txt` dimmed with a `Session is starting…` bar and
  attaches as soon as the host socket answers. Reaped rows wake on the
  first Enter; failed or stopped rows ask for a second Enter (DM-7).
  Restarting a failed row adds "Continue where you left off.".
- **Replies** to an ended job are saved and respawn it; the worker picks
  the saved reply up on its first report (flow 5.7).
- **DM-5**: a worker that exits non-zero while working is restarted once
  with "Continue where you left off."; a second crash leaves it failed. A
  turn that ends normally resets the budget.
- **DM-7**: at daemon start, a job whose worker vanished without an exit
  record is *failed* ("ended while it was working (machine restart?)")
  when its last progress is under 48 h old, else *stopped* ("ended while
  the background service was off"); open questions stay Needs input.
- **DM-9**: every CLI command pings the daemon and warns on another
  pi-roost version, suggesting `daemon stop --keep-workers && respawn --all`.

## Run (stock pi 1.5.0, tmux 110×32, deepseek-flash)

| Check | Result |
|-------|--------|
| `pi --bg "Reply with just the word OK."`, daemon with `PI_ROOST_REAP_MINUTES=0.25` | row `done … OK`, then `done pid=None reaped=True` |
| `pi-roost attach <id>` | last screen dimmed with `Session is starting…` (~0.3 s), then the live TUI; `--json` shows a new pid, still `done` (no flicker to working) |
| `--bg` job inside `sleep 40`; SIGKILL daemon, host and worker; any CLI call | `failed · the session ended while it was working (machine restart?)` |
| `pi-roost reply <id> continue` | `sent · restarting the session`; the worker resumed, wrote `slept.txt` = SLEPT and finished `done` (flow 5.7) |
| Agent view, Enter on a stopped row | `… is stopped · Enter again to start it`; second Enter attached to the restarted worker |

Automated: 12 files, 103 tests — daemon lifecycle (respawn without the
first prompt, crash restart once, reap and wake on reply, never reap
pinned/working, `respawn --all`, DM-7 failed vs stopped), tracker restore,
`respawnCommand`.

Test knobs: `PI_ROOST_REAP_MINUTES`, `PI_ROOST_REAP_CHECK_MS` (daemon env).
