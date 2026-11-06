# Changelog

## [Unreleased]

## [0.1.18] - 2026-11-06

The screens of the agent development environment: the tasks in their worktrees as a pipeline (M57) and a task's review in the hub, with comments sent back to its session (M58). The porting guide ([docs/porting.md](docs/porting.md)) describes this release.

- The workspace overlay (M57, [docs/plans/m57-workspace-overlay.md](docs/plans/m57-workspace-overlay.md)): `/workspaces` (`/ws`), or `Ctrl+N` at the next task that needs you, shows a repository's tasks as a pipeline (in review; conflict or failed; verifying; working; open; shelved; merged lately), the selected one's detail beside it (below under 100 columns) with what its worktree holds against base; keys act through `/tasks`: `s` start, `m` merge, `b` back with a note, `v` verify, `p` pass, `x` abort a sync, `a` approve (the commands shown, then `y`), `t` attach, `n` next. The concierge's `hub_task_start` (with `/concierge act on`) starts a task in its own worktree; the daemon checks the base it names.
- Review in the TUI (M58, [docs/plans/m58-review.md](docs/plans/m58-review.md)): Enter on a task in the overlay (or `/tasks review <id>`) shows its diff against the commit its branch shares with base, committed and not, a file at a time: `j`/`k`, `n`/`p` hunks, `]`/`[` files, `c` a comment on a line, `d` delete one, `b` send back with the comments, `m` merge. The daemon keeps the comments on the task and sends them with the send-back (or in the next start's prompt); a comment whose line changed is kept, marked outdated. `pi-roost review <id>` prints the same; `review <id> comment <file>:<line> <text>`, `review <id> back [note]`.

## [0.1.17] - 2026-11-06

The first steps toward an agent development environment ([docs/plans/ade-roadmap.md](docs/plans/ade-roadmap.md)): a task gets its own worktree and session, is verified, reviewed, and merged into its base branch locally (M54–M56); and a session's own slash commands in its peek (M61). The porting guide ([docs/porting.md](docs/porting.md)) describes this release.

- A task's workspace, as data (M54, [docs/plans/m54-workspace-model.md](docs/plans/m54-workspace-model.md)): a task may carry `workspace` (its worktree, branch, base and `stage`: working, verifying, review, merging, conflict, failed, shelved, merged); one with a workspace holds the tasks after it until it is merged; the board counts tasks in workspaces and those that need you (`2 in workspaces (1 needs you)`). `tasks.json` is version 2 and keeps fields it does not know (going back to an older version once tasks have workspaces is not supported); `hello` says `workspaces`.
- Start and merge from `/tasks` (M55, [docs/plans/m55-start-merge.md](docs/plans/m55-start-merge.md)): `/tasks start <id>` makes the task's worktree (`roost/t<id>-…`) from the branch checked out in the repository and starts a session in it; the session commits and calls `roost_task_done`, which sends the task to review; `/tasks merge <id>` merges base into the branch in its worktree (a conflict stays there; base is untouched), then moves base locally by a fast-forward (config `taskMerge: "no-ff"` for a merge commit) or `update-ref`, under a lock, never pushing; merged tasks free their dependents, and their worktree and branch go once no session runs in them. `/tasks back <id> [note]`, `abort <id>` (a conflicted sync), `commit <id> [message]`. A merge cut short by a crash is settled at the next start.
- Verify before review (M56, [docs/plans/m56-verify.md](docs/plans/m56-verify.md)): `.roost/project.json` on the base branch names `verify` (and `setup`, `verifyTimeout`, `maxRounds`); a person approves the commands (`/tasks approve <id>`, shown first, the approval tied to their hash); a session's done runs `verify` in the worktree as a shell job (two per repository); a pass goes to review, a failure back to the session with the end of its output, and after `maxRounds` it stops for you (`/tasks pass` accepts a flaky one, `/tasks verify` runs it again). An approved `setup` runs in a new task's worktree before its session starts.
- A session's own slash commands in its peek (M61, [docs/plans/m61-session-commands.md](docs/plans/m61-session-commands.md)): `/` in the reply box lists the hub's commands, pi's built-ins and the session's extension commands, skills and prompt templates, tagged and marked when the session is not running or busy; pi's built-ins are typed into the session's pi (the ones that print show its screen in an overlay, pickers attach, `/quit` asks twice); an agent profile may declare `commands`.

## [0.1.16] - 2026-11-06

Agents of the protocol in the conversation (M50), request ids everywhere (M51), the board by project (M52), and a session's whole conversation when you enter it (M53). The porting guide ([docs/porting.md](docs/porting.md)) describes this release.

- A session's whole conversation when you enter it (M53, [docs/plans/m53-earlier-history.md](docs/plans/m53-earlier-history.md)): pi's chat starts at the latest compaction, so what came before was in the session file but not on the screen; scrolled to the top (the wheel, PgUp, Home), the transcript now loads the earlier messages above it, a dozen at a time, drawn by pi's own components, and the view stays where it was.
- The board by project, and told when a task opens (M52, [docs/plans/m52-board-projects.md](docs/plans/m52-board-projects.md)): each git repository has its board (a worktree counts as its repository; outside one, the tasks for anyone); a session sees and takes its repository's tasks and the ones for anyone, the hub's `/tasks` shows its repository's and `/tasks all` every one (named), `/tasks add` puts one on the hub's repository's, the concierge's `hub_task_add` takes a `project`; a hand-over to a session of another repository is refused. A session refused a task as blocked is told by a message when it can be claimed (its dependencies done or dropped), and so are the session it was handed to and the job that put it on; the feed says so (`task` events `why: open`).
- A reply or a new session whose answer was lost when the background service restarted is sent again and taken once (M51, [docs/plans/m51-request-ids.md](docs/plans/m51-request-ids.md)): the agent view, `pi-roost reply`, pi's subagent panel, `/bg` and the phone's start send request ids now (as the stress run and the evals did), and resend on a new connection for up to 15 s; before, the hub showed an error and a second try could queue the reply twice.
- Agents of the protocol take messages (M50, [docs/plans/m50-protocol-messages.md](docs/plans/m50-protocol-messages.md)): an agent you write on the TypeScript or Python client gives `onMessage` (`on_message`) and other sessions reach it as they reach pi: `send` and `peers` list it, the board's `assign` hands it a task (the hub's `/tasks assign`, the concierge's `hub_task_assign`), its watches tell it, a task it holds that is taken back is told. It has `peers()`, `send()` and `watch()` of its own. One that takes no messages is not listed and is refused at once (`unsupported`), not queued for. The stress run's board scenario hands tasks to its agents again: each reached once.

## [0.1.15] - 2026-11-06

Hardening after the board (M49, [docs/plans/m49-hardening.md](docs/plans/m49-hardening.md)): a stress scenario for the task board, and an adversarial pass. The porting guide ([docs/porting.md](docs/porting.md)) describes this version (Step 47).

- The hub's ops are the hub's: `dispatch`, `stop`, `rm`, `respawn`, `reply`, `pin`, `rename`, `reorder`, `subscribe`, `schedule-*` and `shutdown` refuse (`unsupported`) a connection that identified as a session (a worker's `hello` or `report`, a foreground pi's `peer_register`); `events`, `concierge` and `concierge-ask` also refuse an agent that said `hello`. A session could stop other sessions, answer their questions as the user or shut the service down; an agent could set the concierge's policy. Clients that use these ops open a connection of their own (the hub, the CLI, pi's panel already did).
- The socket has bounds: a request line of at most 4 MiB (a longer one ends that connection; the reader no longer re-reads a long line on every chunk, which let one connection take gigabytes and a core), at most 1024 connections, 256 requests in flight per connection (it is not read meanwhile), and a client that leaves 16 MiB unread is dropped.
- Titles, standing orders and names are one line: newlines and tabs in a task's title, an order, a job's or a peer's name fold to spaces (a title could open a line of its own in the concierge's digest); a task's detail and result keep their lines; a hand-edited store is folded at load; the digest folds what it shows.
- `npm run stress` has a `board` scenario (in the default set; `--tasks 120`): every agent works the board at once while the daemon is killed and restarted; every task done once, after what it waits on, none released, hand-overs to commands refused, `task` op p95 under 1 s. The hubs connect again after a kill, and the event lag leaves out the agents' start and reports made while the daemon was down (counted apart).

## [0.1.14] - 2026-11-06

The hub as a control plane ([docs/plans/hub-control-plane.md](docs/plans/hub-control-plane.md), M43–M47) and the peek, deeper (M48). The porting guide ([docs/porting.md](docs/porting.md)) describes this version: Steps 41–46 for M43–M48, the `concierge` config key, the constants, the ops and events, the commits.

- The concierge (`/concierge on` in the agent view): the hub's own agent, a pi session on a cheap model (haiku, no thinking, by default) that the background service wakes with what happened across the sessions and the fleet as it stands (coalesced; at most `wakesPerHour`; a `heartbeat` when nothing happened; not once it has spent `dailyBudgetUsd` for the day). It tells you what needs you in a line under the header, relays between sessions on request, and answers `? …` questions about the fleet; it never answers a session in your place and has no shell or file tools. `/concierge off|status|log|attach`, `/ask`; `roost.json` `concierge` (yours only). Ops `concierge`, `concierge-ask`, `concierge-say`; the `digest` delivery kind. Evals: `evals/concierge.eval.ts` (two cases with a real model; the harness takes `concierge`, `extra` sessions and `ask` steps).
- Escalation and policy (M45): the concierge suggests an answer for every question a session asks (`hub_suggest`; on the row as `suggested`): a banner under the header, `Ctrl+Y` sends it, `Ctrl+E` edits it in the row's peek, Esc dismisses; the peek shows it. `/concierge answer never|routine|always` (kept by the service; `roost.json` `concierge.answer` is the start): under `routine` it answers routine questions itself (`hub_reply`: proceed/confirm, the obvious default, what is in the fleet) and escalates the rest, anything irreversible or costly always; an answer is a `reply` event said to be the concierge's, on its line for a minute, `/concierge undo` withdraws it (the session is told to disregard it and ask the user). `/concierge act on|off` lets it start, stop and restart sessions (`hub_dispatch`, `hub_stop`, `hub_respawn`) when asked. Ops `concierge-policy`, `concierge-suggest`, `concierge-reply`, `concierge-act` (its own connection; `policy` when refused), `concierge {action: answer | act | undo}` (the hub's). Evals: `evals/policy.eval.ts` (routine vs careful questions; `never`).
- Standing orders (M46): rules in your words the concierge keeps (`/concierge orders add [every 30m | daily 18:00 | …] <rule>` keeps one as yours; told in plain words, `? remember: …`, it keeps one itself with `hub_note`, with a `when` in roost's words when it is on a clock); every digest lists them, one on a clock wakes it when due (a `digest` with `why: "order"` and "Due now"; held wakes carry it later, once); it applies one when a digest meets it, once per occurrence, says which (`#n`) and marks it (`hub_note_done`), never beyond the policy (an order that needs `act`, or an answer the policy forbids, is a `need` line instead); `/concierge orders` lists them, `rm <id>` drops one, `hub_note_drop` its own. Kept by the service in `orders.json` (at most 50); op `concierge-order {action: add | rm | list | applied}`; `concierge` events `why: order | order-kept | order-dropped`; the status carries `orders`. Evals: `evals/orders.eval.ts` (when A ends tell B; on a clock; needs act), the harness takes `orders` and `waitMs` steps.
- The peek, deeper (M48): it shows the task the session was started on, where and since when (ended: how long it took), what it cost (`$0.12 · 34k tokens`), replies queued for it, and the tail of its transcript (what it said and did, live while the peek is open; a terminal agent's screen lines; a failed session's error whole). The reply box is an editor like the task box (several lines, pastes folded, Ctrl+G external editor) and says what Enter does for a session in that state. `/` in it is a command for that session: `/stop /respawn /rm /pin /rename /attach /model /thinking /name /compact /continue /log /transcript /ask`; any other `/…` goes to the session as a reply (pi's prompt templates and skills), `!` is refused. Both boxes have pi's completion menu (`/` commands with descriptions and argument completion, `@` paths, fuzzy with `fd`); Enter on a command in the menu runs it at once. Rows carry `task` and `queued`; the worker runs `/compact` from a reply.
- The shared task board (M47, Claude Code's agent teams): tasks any session can take, each claimed with a lock, some waiting on others (`after`). `/tasks` in the agent view shows it (open, blocked and on what, claimed by whom, done with the result) and the header counts what is on it; `/tasks add <title> [after #n] [-- detail]`, `assign <id> <session>` (a message with the task), `done <id> [result]`, `rm <id>`, `release <id>`. Sessions: `roost_tasks`, `roost_task_claim` (`conflict` while another live session holds it, `blocked` while a task it waits on is not done), `roost_task_done`, `roost_task_release`, `roost_task_add`; a session that fails, is stopped or removed holds nothing (a foreground pi's claims go five seconds after it disconnected, `PI_ROOST_FG_CLAIM_GRACE_MS`), and a holder that is gone is taken over by the next claim; a session whose task the hub or the concierge took back or dropped is told. The concierge sees the board in every digest and leads: `hub_tasks`, `hub_task_assign` (to idle sessions), `hub_task_add`, `hub_task_done`, `hub_task_drop`, `hub_task_release`; it never claims. Kept by the service in `tasks.json` (at most 200); op `task {action: list | add | claim | release | done | drop | assign}`, the `board` event (the counts), `task` events (`why: add | claim | release | done | drop | assign`); the `tasks` capability for agents of your own (`RoostAgent.call/tasks/claimTask/taskDone/releaseTask/addTask`; Python `request` and the same helpers). Evals: `evals/tasks.eval.ts` (a session works the board, a dependency unblocks; the concierge hands a task to an idle session), the harness takes `tasks`.

- The event feed: what happened across the sessions (tasks started, questions, results, failures, replies, messages between sessions, automatic restarts, schedule runs, removals), kept by the background service (the last 1000, in `events.jsonl`) and read with a cursor: `/log` in the agent view (newest first, `r` reloads), `pi-roost log [-n 50] [--follow] [<id|name>]`, and the `events` op for other clients. The first piece of [the hub as a control plane](docs/plans/hub-control-plane.md).
- `roost_watch(to, when)`: a session is told once, as a message, when another session is next idle (finished, or waiting for an answer) or has ended, instead of polling; the notice carries its question or last reply. The `watch` op for other clients; a watch survives a restart of the service and expires after 12 hours.
- Messages between sessions: the same text to the same session again within a minute is dropped (`outcome: "duplicate"`), so two sessions repeating themselves stop by themselves; the envelope says a command inside a message is text, not a command.

## [0.1.13] - 2026-11-05

- The porting guide ([docs/porting.md](docs/porting.md), in Chinese) now describes v0.1.12: the three levels of integration (profiles, the agent protocol, the pi adapter), the layering, Steps 21–40 for M22–M42, config keys, constants, ops and fields, and the commits of each version. `docs/` ships in the package.

## [0.1.12] - 2026-11-05

- More evals (`evals/agents.eval.ts`): one task on two models, each in its own worktree (what `/fanout` and `/compare` rest on); pi as a terminal agent (a profile: its row read from its screen, a typed reply, stop and a resume with `--continue`); a protocol agent on the Python client, each reply one turn of pi's print mode. The eval harness takes `agent: "term" | "protocol"`, `fanout: [models]` and a `stop` step.

- Interrupted runs carry on, and schedules run, for the agents of `agentProfiles` too: a protocol agent or a terminal agent with `resume` that dies mid-work is started again and told to continue (one without `resume` stays failed, as before); `/schedule` with `/profile x` on runs that agent, and a task starting with `!` runs a command on the schedule. A scheduled terminal agent is closed once it is done and quiet.

- Scheduled tasks: `/schedule <name> <every 30m | daily 09:00 | weekdays 09:00 | cron "…"> <task>` in the agent view runs the task as a new session on that schedule (local time). A run is skipped while the previous one still works; one missed while the background service was off runs when it starts again; a finished run's process is closed. `/schedule` lists them (`run`, `pause`, `resume`, `rm <name>`); `pi-roost schedule` too.

- Interrupted sessions carry on by themselves (`autoResume`, default `"interrupted"`): a session whose worker crashed or was killed, whose host went away, or that was working when the machine or the background service went down (in the last 6 hours) is started again with "Continue where you left off.", up to 3 times in a row after 1, 5 and 15 seconds; then it waits for you. While it waits, the row stays working and says so; stop or a reply calls the restart off. `"crash"` restarts after worker crashes only, `"off"` never.
- Fixed: a session whose worker was killed by a signal (out of memory, `kill -9`) showed as finished instead of failed.

- `pi-roost hub [dir]`: the agent view in a terminal of its own, without a pi session around it. The same view, keys and commands (/model from pi's model list, /resume with pi's session picker, attach and back); new sessions run the pi on your PATH.

- The pi extension moved to `adapters/pi/` (the old `extensions/index.ts` still loads it, for sessions started before). New package exports: `pi-roost/client` (talk to the background service) and `pi-roost/protocol` (its types).

- Evals with real models (`npm run eval`, for development): each case runs a real pi in an isolated roost (a task to done, a reply continuing the session, a steer joining the work, a subagent reporting back) and is graded on what roost saw; repeated runs give pass rates and flaky cases, with cost and time. See [docs/plans/m37-evals.md](docs/plans/m37-evals.md).

- Request ids: `reply` and `dispatch` take an optional `requestId`; a request sent again with the same id (its answer lost when the background service restarted) is taken once. With them the stress run's chaos scenario handles every reply exactly once.

- Much faster under load, found by a new stress run (`npm run stress`: 50 agents, 1000 replies, a hard-killed daemon and hosts): replies are taken in about 8 ms instead of 240, acknowledged in 25 ms instead of a second, and the hub hears of changes in about 25 ms instead of over a second. The background service no longer runs `ps` for every session on each check, writes reports without waiting on the disk, and syncs what must survive a crash in groups, off its main loop. An agent restarted after a crash no longer redoes a reply it had finished.

- Telemetry: `ROOST_TELEMETRY=file.jsonl` makes the background service and its hosts record spans and metrics (requests, reply latency, reports, state changes, events, host start, attach replay) in the shape of pi's `pi-telemetry` contract, without depending on it. Off by default.

- The roost agent protocol, written down ([docs/protocol.md](docs/protocol.md), draft v1): `hello` with protocol version and capabilities, reports, replies and acks. Clients: TypeScript (`pi-roost/agent`, which pi's worker now uses) and Python (`sdk/python/roost_agent.py`, standard library only). A profile with `"protocol": true` runs an agent that speaks it: its reports set the row, replies reach it as protocol replies.

- Run terminal agents besides pi: `agentProfiles` in your `roost.json` (an argv, how it takes a task, its model and resume arguments, patterns for working and waiting); `/profile name` in the agent view (or a preset's `profile`) starts new sessions with it. Its row is read from its terminal (its title, notifications, bell, whether the screen still moves, your patterns); replies are typed into it; a reply to an ended one starts it again. See [docs/profiles.md](docs/profiles.md).

- Neutral names, the first step towards agents other than pi: `ROOST_HOME`, `ROOST_RUNTIME_DIR`, `ROOST_CONFIG_DIR` (the `PI_ROOST_*` names still work), settings in `~/.config/roost/roost.json` when that file exists (else `~/.pi/agent/roost.json`, as before) and a project's `.roost/roost.json` (else `.pi/roost.json`); a job's worker also gets `ROOST_JOB_ID`, `ROOST_JOB_TOKEN`, `ROOST_SOCKET`; rows say which agent runs them (`profile`).

- Replies steer or wait, as in pi: in a peek Enter joins the work the session is doing (after its current tool calls), Alt+Enter waits until it is done; the same for marked rows.

## [0.1.11] - 2026-11-05

- Launch presets: `presets` in `roost.json` (yours and a project's) name combinations of model, thinking, worktree, agent, directory and fan-out; `/preset name` uses one for new sessions (bare: pick), `/preset save name` keeps the current choices, `/preset rm name`, `/preset off`. The line under the header names the preset in use.
- One task, several models: `/fanout a/x b/y` (bare: pick them) starts the next task once per model, each in its own git worktree; `/compare` on one of them shows them side by side (state, cost, what each changed in its worktree, its last reply), opens one, or keeps one and deletes the others.
- Act on many sessions at once: Ctrl+O marks rows (on a group header, the whole group); with rows marked, the typed text goes to all of them, `/model` and `/thinking` switch all of them, Ctrl+X stops and then deletes them, Ctrl+T pins them. Esc clears the marks.
- What sessions spend: each row shows its session's cost, the header today's and all of it, and `/usage` lists it by model and by session. Counted as pi's footer counts it (replies, tool results, compactions and summaries); subscription use is priced per token and marked `(sub)`.
- `/resume` in the agent view is pi's own session list: search, this directory or all of them (Tab), sort; the session you pick opens at once, started in the background (its row is reused when it has one). Sessions a running job or another pi is writing cannot be deleted from it.
- Choose the model for new sessions as in pi: Ctrl+L (a list you can search; Tab switches between the enabled models and all of them), Ctrl+P / Shift+Ctrl+P cycle the enabled models, Shift+Tab cycles the thinking level; the line under the header always says what a new session runs. In a peek, Ctrl+L switches that session's model.

## [0.1.10] - 2026-11-04

- Sessions no longer freeze after switching: a Ctrl+Z that reached a background pi (typed with other keys, batched by a multiplexer such as herdr, or encoded with Caps/Num Lock on) made pi stop its screen and wait for a resume that never came, while the session kept running. Ctrl+Z is now found anywhere in the input and in every encoding, a background pi detaches on it instead of suspending, and entering a session resumes one that is stuck this way.
- Rows stay true with many pi windows (herdr, tmux): a session moved to the background again takes over its old row (name and pin included), a session opened in another pi window no longer shows as needing input, a session shows as running as soon as its worker is up, and the agent view checks its rows against the background service every 15 s.
- A session started from a herdr pane no longer inherits that pane's identity (`HERDR_*`), so it does not report its state into the pane it came from.
- The model column shows the part that tells models apart: gateway and Bedrock prefixes (`anthropic::`, `us.anthropic.`) and version suffixes are dropped, and a name too long keeps its end.
- Robustness found by stress tests and a destructive review: a worker reconnecting to a daemon that is down backs off (it retried hundreds of times a second); an attach taken over no longer types into or resizes the session; idle reaping never stops a session someone attached to meanwhile; one attach at a time from the agent view; a respawn that hangs no longer leaves the view's terminal stopped; a list reply no longer hides newer pushes.

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
