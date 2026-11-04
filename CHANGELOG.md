# Changelog

## [Unreleased]

## [0.1.9] - 2026-11-04

- Entering a session shows its screen at once and correctly: the host sends its own copy of the screen (with the alternate screen, cursor and terminal modes), then the live output. No more stale or misplaced leftovers, flashes, or waiting for the session to redraw; shell jobs and idle sessions included. The race between the size change and the repaint (seen on Linux) is gone.

## [0.1.8] - 2026-11-04

- The `pi-roost` CLI starts again: 0.1.7's `pi-roost list` table imported pi-tui, which the CLI cannot load outside pi (a peer dependency), so every CLI command failed. A test now keeps pi's packages out of the CLI, the daemon and the host.

## [0.1.7] - 2026-11-04

- Background sessions see what your shell sees: they inherit the launching shell's whole environment (less a job's identity, the launching terminal's own variables and `envDenyList`), then take on their workspace's environment each time they start: your shell's cd hooks run in the session's folder (direnv, mise, fnm, nvm), so a hub opened in one folder starts sessions in others with the right `.envrc` and tool versions (`workspaceEnv`: `"shell"`, `"direnv"`, `"off"`). `inheritEnv: false` brings back the allowlist (`envAllowList`).
- Subagent transcripts (as in Claude Code): Enter on a panel row shows the subagent's conversation over yours, live, with the path back to main, its siblings and direct children; typing there sends it a message; Ctrl+O goes into it; → still attaches.
- Agent presets (as in Claude Code): a task that starts with an agent's name or `@name` runs as that pi-subagents definition (model, thinking, tools, system prompt); `--agent` with `--bg`, `roost_spawn`'s `agent`, `dispatchAgent`, the `a:` filter.
- Subagents behave as in Claude Code (docs/plans/m13-subagent-lifecycle.md):
  - the agent view no longer lists a session's subagents as rows (`agentViewSubagents: "inline"` brings them back); a child whose parent pi is closed is listed while it works or waits;
  - a child that finished is closed once its report is out (`subagentAutoClose`); a message starts it again;
  - the panel drops a finished child at once and the footer says `/subagents to see subagents` for 30 s; failed and stopped rows stay 30 s;
  - `/subagents` also lists the ones finished in the last 30 s, and `/subagents all` lists every one;
  - nested subagents show as a tree with `(+N)` counts.
- The agent view's task input is pi's editor: several lines (Shift+Enter), long pastes folded into a marker and sent in full, ↑↓ move within a task of several lines.
- Pull requests (as in Claude Code): a session's pull request shows as `#N` at the row's right edge, coloured by checks and review and linked; sessions whose pull request needs review or has failing checks are grouped as **Ready for review**; `#N` or a pull request URL selects the session working on it; `s:ready`. Needs `gh`.
- `.worktreeinclude` (as in Claude Code): ignored files it names are copied into new worktrees; `rm` does not count them as work unless changed.
- `pi-roost list` (`ls`): a table of sessions as the agent view lists them (`--subagents` adds those).
- `cleanupDays` (30): records of sessions ended that long ago are removed; session files stay.
- The PTY host answers terminal queries while nobody is attached.
- Entering a session feels like `pi --resume` (docs/plans/m14-attach-like-resume.md): the
  worker sets the real terminal up again (fullscreen pi's alternate screen, mouse wheel,
  kitty keyboard) and draws once; no resize flicker, and no transcript printed into the
  scrollback on the way in.

## [0.1.6] - 2026-11-03

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
