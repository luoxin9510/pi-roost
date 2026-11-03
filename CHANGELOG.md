# Changelog

## [Unreleased]

- Subagent panel: a session's `roost_spawn` children are listed below its prompt; ↓ on an
  empty prompt selects one, Enter opens it, its detach keys come back; `x` stops (then
  hides), `m` messages the selected child, `K` twice (or `/subagents stop`) stops them all,
  `/subagents` selects the panel. Settings `subagentPanel`, `subagentPanelRows`.
- `/fork <prompt>` is now `/bg-fork <prompt>`: the old name collided with pi's built-in
  `/fork`, so pi left it out of autocomplete.
- pi-mobile: the phone's **New session** can start a background session (a starter on
  `pi-mobile:starters`; needs pi-mobile with starters). A session the phone uses
  (`pi-mobile:activity`) is not reaped while in use.

## [0.1.5] - 2026-11-03

- Agents talk to each other: `roost_spawn` starts a background child whose report comes back
  by itself, `roost_send` messages another session, `roost_agents` lists the reachable ones.
  Foreground sessions take part too; children show as `↳ name` in the agent view.
- Reach is limited to the spawn tree unless `agentExternalMessages` is set; spawn limits
  `agentMaxDepth`, `agentMaxChildren`, `agentMaxTree`, `agentMaxTotal`; `agentTools: false`
  turns the tools off.
- Worktrees: a new session can run in its own git worktree and branch (`roost_spawn`
  `worktree: true`, `/worktree` in the agent view, `pi --bg --worktree`, `worktreeIsolation`).
  A child's report names its branch and commits; `rm` removes a worktree only when it holds
  no uncommitted work, and a branch only when it has no commits.
- Background workers no longer keep their job token in the environment of the commands
  they run (a convenience, not a boundary: your own processes can still read the job's files).
- Rows show each session's model and context window use (`claude-opus-5-5 · 43%`;
  warning from 80%, error from 95%); the peek adds the thinking level and token counts.
  `rowDetails: false` hides the column.
- `/model` and `/thinking` in a peek switch that running session (bare: a picker).
- `pi-roost --json`, `pi-roost/api` and the daemon's rows gain `thinking` and `context`.
- Fix: a respawned session no longer goes back to the model and thinking level it was
  dispatched with; it keeps the ones recorded in its session. The same applies to `/bg`,
  `/fork` and `/resume`, which used to pass on the foreground pi's own `--model`.
- The peek confirms a switch only once the session reports it, and says when it did not
  happen (for example, no credentials in the background session).

## [0.1.1] - 2026-11-03

- README in English and Chinese, section by section.
- docs/summary-model.md: using a company LLM endpoint as the summary model (in Chinese).

## [0.1.0] - 2026-11-03

First release.

- Agent view (`pi --agents`, `/agents`): every background pi session on one full-screen
  list, grouped by state or directory, with live one-line summaries.
- Dispatch from the view: a task, `@dir task`, `! command` shell jobs, `/model`,
  `/thinking`, `/resume`, Ctrl+G for a task written in `$EDITOR`.
- Peek and reply without attaching (Space), attach (Enter / →), detach (← on an empty
  prompt, Ctrl+Z, `/exit`).
- Move a conversation to the background: ← on an empty prompt, `/bg`, `/fork <prompt>`,
  or the offer when you quit while a turn is running.
- `pi --bg "task"` starts a background session from the shell.
- Sessions outlive the terminal: a per-user daemon and one PTY host per session;
  crash restart, idle reaping, respawn of ended sessions.
- Summaries, auto-naming and away recaps (optional `summaryModel`), terminal
  notifications, `agents:job_needs_input` / `agents:job_completed` on `pi.events`.
- Organise: filters (`s:` `n:` `o:`), pin, rename, reorder, fold groups.
- `pi-roost` CLI and the `pi-roost/api` module (`spawn`, `list`, `attach`).
- `npm run install:local` installs a checkout as a local pi package.
