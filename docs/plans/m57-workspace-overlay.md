# M57: the workspace overlay

The fourth step of the [roadmap](ade-roadmap.md): the tasks in their worktrees as a
pipeline in the hub, what needs you first, with the keys that act on them; `Ctrl+N` for
the next task that needs you; and the concierge's `hub_task_start`, moved here from M55.

## Use

```text
/workspaces (/ws)     the overlay: this repository's tasks (every project's outside one)
Ctrl+N                the overlay at the next task that needs you (the hub's list; in the
                      overlay: n)
```

```
 api · workspaces                                  1 working · 1 in review · 1 to fix · 1 open

 REVIEW                                     │ #4 users migration
 ▶ ◆ #4 users migration              +52 −1 │ stage   in review · verified: npm test (3s)
 CONFLICT · FAILED                          │ branch  roost/t4-users-migration-a1b2 (base main)
   ✕ #6 rate limiter                  +9 −2 │ agent   api-fix · idle
 WORKING                                    │ change  2 files +52 −1 · 2 commits
   ● #5 login page                   +20 −0 │ verify  ✓ passed · 3m ago
 OPEN                                       │ files
   · #9 audit log · after #4                │         M  db/schema.sql  +12 −1
 MERGED                                     │         A  db/migrations/0004_users.sql  +40
   ✓ #3 users table                         │ said    "migration and rollback done, tests pass"

 m merge · b back · v verify · t attach · a approve · n next · r reload · ↑↓ select · Esc close
```

Keys (each a different letter; only those the selected task's stage has are shown and
work): `s` start (an open task; or start again, one with a workspace and no live session),
`m` merge, `b` back (a one-line note, then Enter), `v` verify again, `p` pass (failed),
`x` abort a conflicted sync, `a` approve the repository's commands (twice, as `/tasks
approve`), `t` `→` `Enter` attach to its session, `n` the next that needs you, `r` reload,
`Esc` close. Each is `/tasks <verb> <id>`: the same checks, the same messages.

## Behaviour

- Groups, in order: REVIEW; CONFLICT · FAILED; VERIFYING; WORKING (merging too); OPEN (a
  repository's open tasks without a workspace, with what holds them: `· after #4`);
  SHELVED; MERGED (the last day's, newest first, at most 10). Within a group by id.
- Icons: `◆` review, `✕` conflict or failed, `⧗` verifying, `●` its session works, `◐`
  its session asks (waits for you), `○` idle or no session, `·` open, `–` shelved, `✓`
  merged. The colour only adds to the icon.
- "Needs you": review, conflict, failed, and a working task whose session asks. `n` and
  `Ctrl+N` go to the next one after the selection, wrapping.
- The detail: the task's detail, stage and note, branch and base, its session (name and
  state, or gone), the change against base, verify's result (a failure's last three
  lines), the merge commit, the files (as many as fit), the session's last sentence,
  the result.
- The change is read with git (`taskChanges`, `lib/task-git.ts`) against the commit the
  branch shares with base (`git merge-base HEAD refs/heads/<base>`): `diff --numstat
  --name-status -M -z` (committed and uncommitted, renames as `a → b`), untracked files
  as new, the commits base does not have, whether anything is uncommitted. Read for each
  task in the list when its stage, note or verify changed, or after 5 s; `r` reads again.
  Without optional locks, never taking the index lock from an agent.
- Under 100 columns the detail goes below the list (half the room each); the selection
  stays in view; the keys' line and the notice stay at the bottom.
- The overlay follows the board: a `board` event reloads it (one load at a time).
- The hub's header line for the board says `Ctrl+N workspaces` while tasks are in
  workspaces, in the warning colour when one needs you.

### The concierge's `hub_task_start`

An act tool (with `/concierge act on`, as `hub_dispatch`): the concierge's own process
makes the task's worktree (`createTaskWorktree`) and builds the pi launch in it, as the
hub's `/tasks start` does; the daemon's `task start` takes it from the concierge when its
policy lets it act (`policy` otherwise), strips the concierge's role and any job's
identity from the launch's environment, and dispatches it as any start (the task owns
the worktree; no `job.worktree`). A refused start discards the worktree it made. Its
prompt: the task may be started when the user asked or a standing order says so;
merging stays the user's.

This differs from the roadmap, which had the connected hub carry it out: that needs a
request from the daemon to the hub, which does not exist; the concierge has what the
hub uses (the git step and the launch builder are in `lib/`), and the daemon still
checks everything a start checks.

## Not in M57

The diff and comments (M58: Enter on a task in review will open them), shelving (`h`,
M59), mouse input.

## Tests

- `test/workspace-view.test.ts`: groups, order, the merged window and cap, icons, next
  needs you (wrapping, a session that asks), the keys per stage, the detail lines, a row.
- `test/task-git.test.ts`: `taskChanges` on a real repository: committed and not, a new
  file, a task's own file renamed, a base file renamed, base's own commits left out; no
  base.
- `test/agent-view.test.ts`: `/workspaces` (wide: side by side; narrow: below), Ctrl+N at
  the next that needs you, `n` wraps; `m`, `b` with a note, `s` on an open task; a key the
  stage has not does nothing; the header's hint.
- `test/comms.test.ts`: the concierge's start refused without act, allowed with it; the
  job's environment without the concierge's role; a session refused.
