# M59: shelving, leftovers, the phone, hardening

The sixth step of the [roadmap](ade-roadmap.md): a task can be put away and brought back;
what the loop leaves behind can be removed; a branch merged by hand is noticed; the task
board is a command of every pi session (so of the phone, through pi-mobile); the
concierge's sessions run what the concierge runs.

## Use

```text
/tasks shelve <id>      (overlay: h) the worktree removed (clean only), the branch kept;
                        the task is open, "shelved"; /tasks start brings it back
/tasks cleanup          what was left behind, listed; /tasks cleanup yes removes it
/tasks …                in any pi session too (and from the phone): the board, start,
                        merge, back, verify, pass, shelve, approve, cleanup
```

## Behaviour

### Shelve

- From review, failed, or working without a live session (a person's, the hub or the
  CLI or a pi session's `/tasks`): refused while its session runs or a verify or setup
  runs in it, and while the worktree has uncommitted changes (`/tasks commit` first).
- The worktree is removed (`git worktree remove`), the branch and the record kept; the
  claim is given back (`state: open`); stage `shelved`.
- Every action but `start` (and comments) is refused on a shelved task, saying so.
  `start` makes the worktree again at its old path from its branch (`restoreTaskWorktree`:
  `git worktree add <path> <branch>`, `.worktreeinclude` copied) in the hub, the pi
  command or the concierge, then starts it as any start again.

### Merged by hand

When the board is listed (at most every 10 s), a task in review, failed, conflict or
shelved whose branch tip is in its base (and is not base's own commit) is merged:
`merge.tip`, the merge finished as a merge by `/tasks merge` (dependents told, the
worktree and branch cleaned up when no session runs), note "merged by hand".

### Cleanup

`/tasks cleanup` (a person's) lists, `/tasks cleanup yes` removes:
- the worktrees of dropped tasks (clean only; the branch kept: it may hold work);
- the worktrees of merged tasks kept while a session ran (with the branch, once its tip
  is checked to be in base);
- worktrees of task branches (`roost/t<id>-…`) that no task holds (a task swept from the
  board, a start that never recorded its workspace): clean only, the branch kept;
- verify logs of tasks done, dropped, or gone.
Never a worktree with changes (listed as kept), never an unmerged branch, never anything
a session or a command is using.

### `/tasks` in a pi session

A pi command (`adapters/pi/tasks-command.ts`) on a connection of its own, as a person:
the board of the session's repository with icons and stages; `start` (the worktree and
launch made in that pi, as the concierge's tool does: `adapters/pi/task-start.ts`),
`merge`, `back <id> [note]`, `verify`, `pass`, `shelve`, `approve` (shown, then the same
command again within 30 s), `cleanup [yes]`. A slash command is a person's: pi runs none
a model writes; the concierge's answers to a session are refused when they start with
`/` or `!`; replies to sessions are the hub's only.

### The concierge's sessions (hardening)

The daemon builds the launch of a session the concierge starts (`hub_dispatch`,
`hub_task_start`) from the concierge's own job: its program and flags, its environment
(without its role and identity) and environment policy; it takes from the concierge's
launch only the task (the argument after `--`, refused when it starts with `/` or `!`),
the directory, a new session file (absolute, `.jsonl`, not existing, no job's), the name,
and a model and thinking level of the right shape. Its argv, other flags, environment,
`envForce`/`envDeny`, agent and profile are not used.

## Not in M59

Needs-you notifications on the phone: pi-mobile's notifications follow its own sessions'
state (a session that asks); a task in review is not a session that asks. It needs a
channel in pi-mobile's contract (`pi-mobile:starters` and `pi-mobile:activity` today),
which is pi-mobile's to add. Teardown commands (`.roost/project.json`), the PR exit (M60).

## Tests

- `test/task-git.test.ts`: remove only a clean worktree, keep the branch; restore from the
  branch; list task worktrees.
- `test/comms.test.ts`: shelve refused while the session runs and with changes, then the
  worktree gone and the branch kept, merge refused, start brings it back; a branch merged
  by hand is merged on the next list and frees its dependent; cleanup dry and for real
  (dropped, orphan, dirty kept, logs), refused for a session; the concierge's launch built
  from its own (program, flags, task after `--`), an existing session file refused.
- `test/tasks-command.test.ts`: the pi command: the board, merge's error, back with a
  note, shelve, approve twice, cleanup, usage.
- `test/agent-view.test.ts`: `/tasks shelve`, `/tasks cleanup [yes]`, start of a shelved
  task restores its worktree first.

## After review

The review attacked the loop as a whole (M54–M59), as M49 did the board.

- **A child's first message is a task.** A session could `roost_spawn` a child whose first
  message was `/tasks merge 5`: pi runs a first message that starts with `/` as a
  command, and the pi `/tasks` command speaks as a person. The daemon now refuses a
  spawned child's (and the concierge's) first message that starts with `/`, `!` or `@`
  (`firstMessage`). Every other way to a session's input is a person's: replies are the
  hub's, schedules are the user's, the concierge's answers refuse commands.
- **Merged by hand means the reviewed tip.** The session's done records the tip it sent
  to review (`workspace.reviewTip`); a task is marked merged by hand only when its branch
  is still at that tip, the tip has commits of its own on base's old commit, it is in
  base, and the worktree is clean. A branch reset onto base (by an agent or a person) is
  not a merge.
- Comments on a shelved task are kept (the next start's prompt carries them); a shelve
  cut short after the worktree went is shelved again; a start finds a missing worktree
  and makes it again from its branch whatever the stage, and removes it again when the
  start is refused.
- Cleanup leaves alone worktrees outside `.pi/worktrees`, a task's under way, and
  worktrees made in the last 10 minutes (a start whose workspace is not recorded yet).
- A setup holds its place until its session is dispatched (no shelve or start in
  between).

Known, stated rather than changed:
- The socket's trust boundary: a connection that has not registered as a session is a
  person's (the hub, the CLI, the pi `/tasks` command). An agent with a shell can open
  one, or run `git merge` itself; pi-roost's rules hold for what goes through its tools.
- Ignored files (`.env`, build output) in a worktree go when it is shelved or cleaned up;
  restoring copies `.worktreeinclude` only.
- Hand merges are noticed when the board is listed (the hub lists it on each change), not
  on a timer of their own; cleanup removes the verify logs of done tasks.
- The concierge's new session file is checked (absolute, `.jsonl`, new, no job's), not
  confined to pi's session directory.
