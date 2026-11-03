# M5b — summaries, names, recap, notifications: acceptance (2026-11-03)

Scope (PRD §10, second half of M5): SM-2, SM-4, DI-9, AT-5, NT-1, NT-2.

## Design

- **Summary model (SM-2, SM-4)**: `summaryModel` ("provider/model-id", user
  or project settings). The worker calls it through its own
  `ctx.modelRegistry.complete()` (custom providers and auth apply; no
  hard-coded ids), 20 s timeout, failures ignored (heuristics stay, SM-3).
  - At turn end: one request with the transcript tail → JSON `{summary ≤ 80,
    kind: done|question, reply}`. The tracker takes the line, may turn a
    "done" into a question (or back), and puts the suggested reply first in
    the choices. A result for an older run is dropped.
  - During a turn: a progress line every 5 minutes.
- **Auto-name (DI-9)**: an unnamed session is named from its first prompt
  (2–5 words) with `pi.setSessionName`; without a summary model the
  first-six-words fallback stays.
- **Recap (AT-5)**: the host records `attached` in the job state and, for a
  worker that reported `attachSignal`, sends it SIGUSR2 on attach and on
  detach. While nobody is attached the worker counts finished turns,
  failures, tools and questions; on attach it appends a TUI-only
  `pi-roost-recap` entry ("↺ While you were away: …"), written by the
  summary model when one is configured (4 s), else a list. A no-op SIGUSR2
  listener stays installed for the whole process, so a signal between
  sessions cannot end the worker.
- **NT-1**: while the agent view is on screen (not attached), a job
  entering Needs input, Done or Failed makes the terminal notify. Setting
  `notify`: `auto` (OSC 9 in iTerm2, WezTerm, Ghostty and kitty, else the
  bell), `osc9`, `osc777`, `bell` or `off`. pi itself has no notification
  setting to reuse.
- **NT-2**: `agents:job_needs_input` and `agents:job_completed` on
  `pi.events` (payload id, name, cwd, state, summary, question, error),
  from the agent view and from the foreground footer's poll. A
  process-wide record makes each transition fire once, and a job's first
  sighting is not news.

## Run (stock pi 1.5.0, tmux 110×32, deepseek-flash as main and summary model)

| Check | Result |
|-------|--------|
| `--bg` "run ls, echo hello, then ask whether to list hidden files" | row `blocked/question` · "Ran ls and echo hello; asking whether to list hidden files too" · choices `["Yes, please run ls -a."]` |
| `--bg` "count the markdown files … tell me the number" | named "Count markdown files bash"; summary "Counted markdown files in folder: 0 found" |
| The first job, answered by `pi-roost reply`, then `pi-roost attach` | named "Run ls and echo hello"; transcript shows "↺ While you were away: I ran ls and echo hello, then you approved running ls -a, which revealed the hidden …" |
| Agent view (`notify: bell`), dispatch a job, wait | one standalone BEL in the pane output when it completed (title OSCs excluded) |

Automated: 13 files, 111 tests (adds `test/summaries.test.ts`: reply
parsing, model refs, transcript tail, tracker overrides per run, events
fire once, notification sequences, away list).

The host test "survives garbage from a client" failed twice under full
load (status request racing the teardown of the bad connection); it now
retries the status request and still requires the host to be alive.
