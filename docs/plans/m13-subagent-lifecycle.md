# M13: subagent lifecycle, as in Claude Code

Status: implemented (2026-11-04). Users found the M9/M12 model noisy: a child spawned
with `roost_spawn` kept its process after it finished, the agent view listed every
child as a row of its own (with a flat `↳` prefix), and nothing ever went away. Claude
Code does none of that. This milestone ports its documented behaviour
(code.claude.com/docs: sub-agents, agent-view).

## What Claude Code does, and what pi-roost now does

| Claude Code (docs) | pi-roost M13 |
|---|---|
| "Subagents and teammates a session spawns aren't listed as separate rows" in agent view. | The agent view leaves out rows with a parent (`listed()`); the parent's peek says `N subagents (k running)`. Config `agentViewSubagents: "inline"` lists them again. |
| A subagent belongs to its session; it ends with it. | A pi-roost child outlives its parent pi. A child whose parent **nobody holds** (no foreground pi on that session, no job recorded for it) and that still works or waits **is** listed, so live work never goes unseen. The daemon sends `JobRow.parentOpen` and pushes the children's rows again when a foreground pi registers or leaves, a job is dispatched or removed. |
| A subagent that finishes is done; its results reach the parent as a completion notification. | The report (M9) is routed or held as before. Then the daemon **closes the worker** (`subagentAutoClose`, default on, after ~3 s): same checks as the idle reaper (not pinned, not attached, idle, no queued replies, not starting/stopping) plus: none of its own children still runs. The record stays `done`, `reaped`. |
| "When Claude sends a completed subagent a message with SendMessage, the subagent resumes." | Unchanged: `roost_send`, `m` in the panel, or Enter starts it again from its session file (flow 5.7). |
| A subagent you stopped does not auto-resume; a message to it is refused. | Unchanged (`outcome: "stopped"`). |
| Panel: "When a subagent finishes successfully, Claude Code removes its row immediately and … shows `/tasks to see subagents` in the footer for 30 seconds." | The panel drops a `done` row at once; the footer shows `/subagents to see subagents` for 30 s. |
| "When a subagent fails or you stop it, Claude Code keeps its row for 30 seconds. To clear the row sooner, select it and press `x`." | Failed and stopped rows stay 30 s (from `stateSince`), `x` hides one sooner. |
| `/tasks`: "A background subagent that completes stays listed …, marked done and sorted below running work, for the same 30 seconds." | `/subagents` selects the panel and also lists the ones finished in the last 30 s, below running work. `/subagents all` (pi-roost: children persist) lists every subagent the session ever had. Leaving the panel (Esc, ↑ at the top, typing) goes back to the normal rows. |
| "Shows nested subagents as a tree in the subagent panel … marks each row that still has descendants in the panel with a `(+N)` count." | The panel is a tree: grandchildren under their parent (`└`, two spaces a level), `(+N)` on rows with rows below them. A row that would have gone stays while something below it is still shown, so there is a path to it. |

## Not ported

- Claude's in-session transcript view ("open a row to see siblings and direct children
  with a path back to main"): Enter attaches to the child, whose own panel shows its
  children.
- Deleting subagent transcripts after `cleanupPeriodDays`: records stay until `rm`.
- `/tasks` hiding failed and stopped rows while the panel keeps them: pi-roost has one
  panel, so `/subagents` keeps them for their 30 s too.

## Config

| Key | Default | |
|---|---|---|
| `subagentAutoClose` | `true` | stop a child's worker once it finished and reported |
| `agentViewSubagents` | `"hide"` | `"inline"`: children are agent view rows again (the M9 look) |

## Tests

- Panel: lifetimes per state and mode, tree order and depth, `(+N)`, the footer hint.
- Agent view: held children hidden, orphans that run listed, finished orphans hidden.
- Daemon: a `done` report closes the worker (record kept, `reaped`, no "ended" report);
  a `blocked` report does not; `subagentAutoClose: false`; `parentOpen` follows the
  parent foreground pi leaving and coming back, and is true below a job.
