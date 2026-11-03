# M6b — dispatch extras and /fork: acceptance (2026-11-03)

Scope (PRD §10 M6, second half): DI-3, DI-4, DI-5, DI-6, BG-8; P1 rows
of §2 "@repo …", "/model, /effort … set defaults" (pi: /model,
/thinking), "/resume picker", "! <cmd> shell job", "/fork [prompt]".
Flow 5.6 passes. Deferred to M7 with the P2 rows: BG-9 (quit while busy),
Shift+Enter/Ctrl+G via pi's editor, and BG-8's "Enter on the
confirmation switches into the copy" (the copy is one ← away in /agents).

## Design

- `lib/dispatch-input.ts`: the input is a task, `! <command>` (shell job)
  or `/<command> [arg]`. The first `@<dir>` naming an existing directory
  (relative, absolute or `~/…`) targets it and is removed from the task.
  Typing `@…` shows candidates: child git repos, `.pi/worktrees/*`,
  directories with jobs, then other child directories; Tab completes.
  When grouping by directory, dispatch goes to the selected section.
- In-view commands (DI-4): `/model [provider/id|default]` and
  `/thinking [level|default]` set defaults for new sessions (shown under
  the header). Bare forms open an inline picker; the models come from the
  model registry. `/resume` picks a past session of the directory that has
  no row and runs it as a job (`origin: adopt`). `/exit` and `/quit` leave.
  Prompt templates and skills (pi's command list, source `prompt` or
  `skill`) are dispatched as the first prompt (DI-5). Any other command
  says "isn't available in agent view" and keeps the text.
- Shell jobs (DI-6): daemon `dispatch` with `kind: "shell"` runs
  `$SHELL -lc <command>` in a PTY host, with no session file, model or
  worker. The row shows the latest output line (polled from the host's
  screen every 2 s, and once more at exit). Exit status 0 is done,
  anything else failed with the code. There are no crash restarts and no
  replies (attach to type into it). The row is removed 5 minutes after
  exit.
- `/fork <prompt>` (BG-8) in a foreground session: `SessionManager.forkFrom`
  copies the session next to it, and the daemon runs the copy
  (`origin: fork`, named "<name> (fork)", optional first prompt). The
  current session continues. Confirmation: `session running · <name> · <id>`.
- Found on the way: pi reads a message argument starting with `@` as a
  file to attach, even after `--`, so `@x …` tasks failed in the worker
  ("File not found"). `buildLaunch` now prefixes such a task with a space.

## Run (stock pi 1.5.0, tmux 110×32, deepseek-flash)

| Check | Result |
|-------|--------|
| `! ls -1 /usr` | shell row `! ls -1 /usr · X11R6` (last line), done |
| `/model` | picker "Model for new sessions" with `default` and the registry's models |
| `@su` | `Tab: @sub`; Tab + task → job in `e2e/sub`, answered SUBDIR |
| `/resume`, Enter | picker of past sessions without a row; the picked one became a live row |
| `/roostecho` (project prompt template) | dispatched; the worker expanded it and answered TEMPLATED |
| Flow 5.6: foreground conversation, then `/fork What number…` | `session running · … (fork) · c30aa845`; the copy answered 42 from the shared history; the foreground session kept answering |

Automated: 15 files, 126 tests (input parsing and @ completion, view
commands with pickers and refusals, shell jobs in the daemon, the @ task
argument).

## Review fixes (PR #8)

- `respawn --all` (and `respawn <id>`) never kill and re-run a running
  shell job; Enter twice on an ended shell row says it runs the command
  again.
- Every shell ending (stopped, failed, vanished at daemon start) sets the
  removal time; shell jobs skip the writer-lock and DM-7 paths, and get no
  job identity in their environment (a `pi` started inside cannot report as
  the job).
- `@` completion matches names, not the base path every child shares.
- `/resume` lists only sessions no other pi is writing, says it is loading,
  and keeps the resumed session's own model unless `/model` chose one.
- `/model <id>` is checked against the registry's models; suggestions are
  cached for 2 s; the `@`-file guard also covers respawn prompts.
- pi's own bare `/fork` (branch from an earlier message) takes precedence;
  this extension's `/fork` needs a prompt (`/fork <prompt>`).
- `/model` and `/thinking` defaults last while the view is open; settings
  `dispatchModel`/`dispatchThinking` are the persistent defaults.

Automated: 15 files, 127 tests.
