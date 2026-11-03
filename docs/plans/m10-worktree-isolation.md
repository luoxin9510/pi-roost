# M10: worktree isolation (PRD C7)

Status: shipped (2026-11-03), after an independent design review; see "Review decisions". Several background sessions, and above all the children a
session spawns with `roost_spawn` (M9), work in one checkout and overwrite each other's
edits. Claude Code puts a background session in its own git worktree; pi-roost does the
same.

## Decision: isolate at dispatch, not mid-run

The PRD sketched an `enter_worktree` tool that moves a running session into a worktree
by restarting its worker in the new cwd (R4: pi's extension API cannot switch cwd).
That restart resumes the session file from a cwd other than the one it was written in,
and pi then opens its blocking "continue in current cwd" dialog (porting.md, C7). So
pi-roost creates the worktree **before** the session starts and starts the session in
it. The session is never moved; respawns, attach and `/resume` all see one cwd.

Cost: a session is isolated from its first prompt, even when it only reads. Choosing
isolation is per dispatch, so read-only tasks simply do not ask for it.

## What the user and agents get

| Where | How | Notes |
|---|---|---|
| `roost_spawn` | `worktree: true` | the tool description says to use it when children edit files in parallel |
| agent view | `/worktree` toggles it for new sessions (like `/model`); `/worktree off` | shown in the input's hint line |
| `pi --bg` | `--worktree` | |
| `pi-roost/api` | `spawn({ worktree: true })` | |
| config | `worktreeIsolation`: `"off"` (default), `"children"` (roost_spawn), `"all"` (every new pi dispatch) | an explicit choice wins |

Shell jobs (`!cmd`), adopt (←, `/resume`) and `/fork` never create a worktree: they run
an existing session in its own cwd.

## Layout

- Repository: `git rev-parse --show-toplevel` of the dispatch cwd. Not in a repository:
  an explicit request fails ("not in a git repository"); a config default falls back to
  no isolation and says so.
- Worktree: `<toplevel>/.pi/worktrees/<slug>-<4 hex>`, branch `roost/<slug>-<4 hex>`,
  from the dispatch checkout's `HEAD` (`git worktree add -b <branch> <path> HEAD`). The
  slug comes from the session name (lowercase ASCII words, ≤ 32 chars, `task` if empty).
- A dispatch cwd below the toplevel maps to the same subdirectory in the worktree.
- `.pi/worktrees/` is added once to the repository's `info/exclude` (in the common git
  dir), so the main checkout does not show the worktrees as untracked. Tracked files are
  never changed.
- Uncommitted changes in the dispatch checkout are not in the worktree. The spawn result,
  the view's message and the session's note say so when the checkout is dirty.
- Files the repository ignores (`node_modules`, `.env`) are not copied. Later:
  `.worktreeinclude` as in Claude Code.

## Records

- The dispatching side creates the worktree, allocates the session file there
  (`SessionManager.create(worktreeCwd)`), builds the launch with `cwd` in the worktree
  and `worktree: { path, branch, repo, base }` (repo = the dispatch checkout's
  toplevel, base = the commit). If the dispatch fails, it removes the fresh worktree and
  branch again.
- The daemon validates `worktree` before it stores it on `JobRecord`, and again before
  `rm` deletes anything (`validWorktree`): base is a commit id; the directory's name is
  `<slug>-<4 hex>` and the branch is `roost/` plus that name; the directory sits in
  `.pi/worktrees/` of the main checkout; path and repo share one git common dir; path is
  its own toplevel with that branch checked out; `cwd` is inside it. A record that names
  `main`, or any other checkout, is refused, so a crafted launch cannot make `rm` delete a
  branch or a directory pi-roost did not make. git runs with `execFile`, never a shell,
  with `--` before paths and branch names.
- `JobRow.worktree: { path, branch } | null` for the view, `--json` and the API.

## The session knows

The worker of a job with a worktree adds a short system-prompt note
(`before_agent_start`): this session works in its own git worktree `<path>` on branch
`<branch>`, made from `<base:8>` of `<repo>`; other sessions work elsewhere; commit
finished work on this branch; do not switch branches or edit files in `<repo>`.

## Reports (M9)

A report from a child with a worktree ends with
`Worktree: <path> · branch <branch> · <n> commits on it · uncommitted changes` (the last
part only when dirty), so the parent knows what to review or merge. Computed by the
daemon when it routes the report (`git status --porcelain`, `git rev-list --count
base..branch`); a git failure leaves the line out rather than failing the report.

## Review decisions

- **Created by the dispatching side, not the daemon.** The reviewer preferred the daemon
  (one place for checks and rollback). But the session file has to be allocated for the
  worktree's cwd (`SessionManager.create(cwd)`: pi keys session directories by cwd, and
  `/resume` lists by it), and only the pi process has `SessionManager`. So the client
  creates it and removes it again on any failure (`Isolation.discard`); the daemon does
  not trust it (above). A client that dies between the two leaves an unused, clean
  worktree and an empty branch behind (removed by hand), nothing else.
- Worktrees live under the **main** checkout (`--git-common-dir`), never nested in another
  worktree; `info/exclude` is found with `git rev-parse --git-path` (right for linked
  worktrees and submodules).
- The daemon's git calls are asynchronous with timeouts (5 s, 20 s for remove); a git
  failure in `rm` never fails `rm`, it keeps the worktree and says why.
- "In use" counts every job record (also ended ones, which can be resumed) and connected
  foreground peers whose cwd is inside the worktree.
- A respawn whose worktree is gone fails with the `git worktree add <path> <branch>` that
  brings it back.

## Removal (`rm`)

After the job is stopped and its records removed, the daemon cleans up its worktree:

1. Another job's cwd is inside the worktree (a `/fork` of it, an `@dir` dispatch): keep.
2. The worktree directory is gone: `git worktree prune`; the branch is kept if it has
   commits beyond base, else deleted.
3. Uncommitted or untracked changes, or ignored files (`.env`, build output: a plain
   `git worktree remove` would delete them): keep the worktree and the branch.
4. Clean, branch moved (commits beyond base, or reset elsewhere): `git worktree remove`,
   keep the branch.
5. Clean, branch still at base: `git worktree remove`, `git branch -D`.

rm that could not stop the worker (still there after SIGKILL) skips cleanup. A dispatch
error undoes the fresh worktree only when the daemon refused it (an error code other than
`closed`): a timeout or a dropped connection may come after the session started. The undo
itself removes only a clean worktree and a branch at base.

`rm` returns `worktree: { path, branch, removed, branchKept, reason? }`; the CLI prints
it, the view shows it as its message. Nothing with work in it is ever deleted; a kept
worktree is removed by hand (`git worktree remove --force <path>`). There is no
`--force` in pi-roost.

## View

- The peek's facts gain `⎇ <branch>`.
- Directory grouping shows worktree sessions under their worktree path (as today).

## Tests

- `lib/worktree.ts` against real temporary repositories: create (subdir mapping,
  exclude written once, dirty flag), status (ahead, dirty), cleanup in all five cases.
- Daemon: dispatch validates and stores `worktree`; `rm` cleanup result; report line.
- Worker: system note only with a worktree.
- View: `/worktree` toggle, peek fact.
- Live: a parent spawns two children with `worktree: true` that edit the same file; both
  commit on their branches, the parent's reports name the branches, `rm` keeps the
  branches and removes the worktrees.
