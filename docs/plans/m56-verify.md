# M56: verify before review, project config and trust

The third step of the [roadmap](ade-roadmap.md): when a task's session says it is done,
the repository's `verify` command runs in the task's worktree; review sees only work that
passed, failures go back to the session, and a person approves every command a
repository asks pi-roost to run.

## Use

```jsonc
// .roost/project.json, committed in the repository (read from the base branch)
{
  "verify": "npm test",          // run in the task's worktree when its session is done
  "setup": "npm ci",              // run in a new task's worktree before its session starts
  "verifyTimeout": 600,           // seconds (default 600, at most 3600)
  "maxRounds": 3                  // failed verifies sent back before it stops for you (1-10)
}
```

```text
/tasks approve 4          approve the repository's commands of task #4 (shown in full first)
/tasks verify 4           run verify again (from review or failed)
/tasks pass 4             a failure you accept (a flaky test): to review, marked
```

## Behaviour

### Config

- Read from the **base branch of the repository** (`git show <baseRef>:.roost/project.json`),
  never from the task's worktree, which the agent can edit. A missing or invalid file is
  no config (invalid: a note says why).
- A personal override `<roostHome>/projects/<sha256 of the repository path, 16 hex>.json`
  with the same fields wins field by field. Its commands need approval as the
  repository's do.

### Trust

- `<roostHome>/approvals.json`: per repository, the sha256 of each approved command text.
- A command not approved does not run. `verify`: the task goes to `review` with the note
  "not verified: /tasks approve N to run `npm test`"; `setup`: the session starts
  without it, with the note "setup not run: not approved".
- `/tasks approve N` (the hub only) shows the commands and approves them: the user typed
  it, having seen them. The wording is honest: approving lets the command run in your
  account; what it calls (a `package.json` script, a test file) is not covered by the
  hash.

### Verify

- The session's `roost_task_done` (clean worktree, M55) moves the task to `verifying`
  when a verify command is configured and approved; the result is kept.
- It runs as a **shell job** in the worktree: `/bin/sh -c '<verify> >"$ROOST_VERIFY_LOG"
  2>&1'`, named `verify #N`, with the user's environment policy and `workspaceEnv` as a
  hub's `!` command has (`envPolicy(loadUserConfig())`), plus `ROOST_TASK_ID`,
  `ROOST_WORKTREE`, `ROOST_BRANCH`, `ROOST_BASE`. The log is
  `<roostHome>/verify/<task id>-<round>.log`.
- At most two run per repository; more wait at `verifying` with the note "queued", and
  start as one ends.
- A timeout stops the job: a failure "timed out after Ns".
- Exit 0: `review`, note "verified: <command> (Ns)", `workspace.verify = {ok, at, log,
  tail, rounds}`. Otherwise `rounds + 1`: below `maxRounds` back to `working`, and the
  session gets the log's last 40 lines (at most 4000 characters) and "fix it, commit,
  then roost_task_done again"; at `maxRounds` (or with no live session) `failed`,
  counted in `needsYou`.
- The `verify #N` row goes when the result is recorded.
- A daemon restart that finds `verifying` with no verify job running (or queued) sets
  `review` with "not verified (interrupted)".
- `/tasks verify N` (the hub) runs it again from `review` or `failed`, rounds reset to 0.
  `/tasks pass N` (the hub) moves `failed` to `review` with "passed by hand".
- `/tasks merge` does not run verify again in M56 (the roadmap's "verify again if base
  moved" comes with M58's review screen).

### Setup

- `/tasks start` (a first start, not a start again): when `setup` is configured and
  approved, the daemon runs it as a shell job `setup #N` in the new worktree (same
  environment) before dispatching the session. Exit 0: the session is dispatched.
  Otherwise: `failed`, note "setup failed: <last line>", the log kept; the worktree
  stays. The pending launch lives in memory: a daemon restart during setup sets
  `failed` with "setup interrupted: /tasks start again".
- `teardown` is not in M56 (it goes with M59's cleanup).

## Not in M56

Teardown; verify again on merge when base moved; the concierge approving (never: trust is
a person's).

## Tests

- `test/project-config.test.ts`: reading from a branch (not the worktree), invalid
  files, the override, approvals round trip, the tail helper.
- `test/comms.test.ts` (a real daemon, real repositories): done → verifying → review on
  exit 0; a failure goes back with the tail, then `failed` at `maxRounds`; not approved
  → review with the note; approve then verify runs; queue of two; timeout; restart with
  `verifying` → review; setup runs before the session, a failing setup → failed; pass.

## As built

- `lib/project-config.ts`: the config read from base (`git cat-file -e`, then `git
  show`), the override, approvals, the log path and tail, the command line.
- The command runs as `/bin/sh -c 'exec >"$ROOST_VERIFY_LOG" 2>&1` + newline + the
  command: the whole script's output goes to the log. (A redirect after the command, as
  first written, takes only the last part of a list: `a; b >log` logs `b` only; a test
  caught it.)
- A failed verify's message to the session quotes the log's end; the task's
  `workspace.verify.tail` keeps it for the hub.
- A lesson from building it: a unit test ran its example command (`... && npm test`)
  for real, and `npm test` ran that test again: a fork bomb. Tests here never run a real
  test command.
