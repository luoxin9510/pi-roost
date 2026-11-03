# Changelog

## [0.2.0] - 2026-11-03

- Agents talk to each other: `roost_spawn` starts a background child whose report comes back
  by itself, `roost_send` messages another session, `roost_agents` lists the reachable ones.
  Foreground sessions take part too; children show as `↳ name` in the agent view.
- Reach is limited to the spawn tree unless `agentExternalMessages` is set; spawn limits
  `agentMaxDepth`, `agentMaxChildren`, `agentMaxTree`, `agentMaxTotal`; `agentTools: false`
  turns the tools off.
- Background workers no longer keep their job token in the environment of the commands
  they run (a convenience, not a boundary: your own processes can still read the job's files).

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
