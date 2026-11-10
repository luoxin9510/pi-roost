# The Workspace module (M64–M66)

The second deepening from the architecture review of 2026-11-07 (the first: M63, who may
do what). Settled in a grilling session; the terms are in `GLOSSARY.md` (Task, Workspace,
Stage, Base, Verify, Review; Caller and its kinds).

## Why

A Workspace's life (start → setup → working → verify → review → merge, shelve, pr,
restart) is about 800 lines of `daemon/main.ts`: some 13 functions calling each other and
7 maps and sets of module state (`verifyRuns`, `setupRuns`, `setupNote`, `verifyQueue`,
`verifyReserved`, `workspaceBusy`, `mergingRepos`). The bugs reviews found in M55, M56,
M58, M59 and M60 lived in how those functions interleave, and the only way to test the
rules was a real daemon over its socket. Four clients (the hub, pi's `/tasks start`, the
concierge's `hub_task_start`, the eval harness) make the worktree themselves, so the
daemon re-checks what they made (M57).

## Decisions

1. **What it owns**: the Stage machine; every workspace action (start, setup, verify,
   pass, back, comment, uncomment, approve, shelve, pr, commit, abort, merge); the Verify
   queue and its slots; one merge per repository; settling at start; hand merges found;
   leftovers cleaned. The board's own actions (add, claim, done, drop, assign) stay out.
2. **Its interface**: `createWorkspaces(deps)` returns `act(who, task, action, args)`,
   `done(who, task, result)` (a Session said the Task is done: Verify starts),
   `commandEnded(jobId, of, code)` (a Verify or setup command ended) and `settle()` (at
   start). The seven maps and sets are its own. Moving the code showed three more
   entries the board's own actions needed (the grilling had four): `drop(task, mark)`
   (not while the Workspace is busy or merging; `mark` drops it on the board; then a
   running command stops and a clean worktree goes), `handMerges()` (the board's list
   looks for branches merged by hand) and `cleanup(dry)` (`/tasks cleanup`).
3. **Seams**: **Jobs** (dispatch a session or a command, stop one, whether a session
   lives) and **Board** (read and save tasks, record an event, push the board, tell a
   Task's holder) are ports with two adapters each: the daemon's, and in-memory ones for
   tests. **Git** is not a port: tests run real git in temporary repositories. The
   **clock** is passed in (Verify's timeout without waiting).
4. **What it writes**: a Task's `workspace`, and the Task done when its Workspace is
   merged; then Board's save. Nothing else of a Task (holder, title, dependencies).
5. **Promises** (each a scenario test in M66): one action on a Task's Workspace at a time
   (another is a `conflict`); at most so many Verifies run at once, the rest queue; one
   merge per repository at a time (and a lock file against a second daemon); a restart
   settles a merge, Verify or setup it cut short.
6. **Who makes the worktree (M65)**: the daemon. Two steps, because the agent's launch
   needs the worktree's path (pi's session file is per directory, and the daemon knows no
   agent): `task prepare` makes the Workspace's worktree and returns where; the client
   builds its launch there; `task start` starts it. A prepared worktree not started in 5
   minutes, or whose start is refused, is removed (in memory; a restart in between is the
   leftovers cleanup's, which already removes unheld task worktrees older than 10
   minutes). No new Stage. The old `task start` with a client's own workspace goes (its
   four callers ship in this package); the protocol doc and the porting guide follow.
7. **The hub reads git, never writes it**: the change counts and the diff stay read in
   the hub (no side effects, local, quick); every write is the daemon's.

## Steps

- **M64**: move the code into `lib/workspace.ts` behind the interface above, the daemon
  its adapters; behaviour unchanged (pinned by a snapshot of the workspace scenarios
  before the move, as M63 did).
- **M65**: the daemon makes the worktree (decision 6).
- **M66**: the rules tested in process through the interface (the promises, the review
  bugs of M55–M60); of the socket tests of M55–M60, one end-to-end test per action stays,
  the rest go. The callers' matrix (M63) stays.

## M64, as done

`lib/workspace.ts` (about 830 lines) holds what was `daemon/main.ts`'s, moved as it was:
the same functions inside `createWorkspaces`, their module state per instance, the
daemon's calls replaced by the ports (`saveTasks()` → `board.save()`, `dispatch(` →
`jobs.dispatch(`, `ownerLive(` → `jobs.live(`, `Date.now()` → `clock.now()`, Verify's
timeout timer → `clock.timer`). The daemon builds the module once, its adapters being
its own functions, and calls it from `task` (the workspace actions, the workspace half of
`done` and `drop`, `list`, `cleanup`), from a job's end, and at start. `OpError`, `str`,
`realPath` and `taskText` moved to `lib/op.ts` (both use them); the board's record of who
acted is `BoardWho`. `daemon/main.ts`: 4783 → 4054 lines.

Pinned by what was there: the socket tests of M55–M60 in `test/comms.test.ts` (66, the
workspace scenarios among them), `test/daemon.test.ts`, the callers' matrix of M63, and
`test/task-git.test.ts`, `test/workspace-env.test.ts`, all unchanged and passing. New:
`test/workspace.test.ts`, the module through its own interface with the board and jobs in
memory and git real (a Task from start to merge; one action at a time); M66 moves the
lifecycle's rules there.

### After review (M64)

- `drop` refuses as it did: a Workspace busy or merging first (`conflict`), then a Task
  already done or dropped (`bad_request`, now the first thing `mark` does), then the board
  is touched. The move had swapped the two.
- `test/workspace.test.ts` also pins that order, and `settle()`: an interrupted Verify to
  review, an interrupted setup to failed, command jobs no run reports to stopped (running
  ones) and removed.

## M65, as done

- `task prepare` (a Person's; the Concierge's with `act` on, refused with `policy`
  otherwise; a row in the callers' table) checks what `start` checks of the Task, then
  makes its worktree with `makeTaskWorktree` (or `remakeTaskWorktree` for a shelved one),
  and answers where (`path`, `branch`, `baseRef`, `baseSha`, and `sourceDirty` when the
  main checkout had changes it does not carry). A second `prepare` before the start gives
  the same worktree and holds it 5 minutes more (`PREPARED_MS`, `PI_ROOST_PREPARED_MS` for
  tests).
- `task start {id, launch}`: into the worktree prepared (or the Workspace's own, when it
  is there); not prepared, refused. A refused start removes what was prepared for it (a
  new worktree with its branch, a shelved one made again without its branch); a drop
  removes it too; `/tasks cleanup` leaves a prepared one alone.
- Making a worktree is git's checkout and the copy of included files: in the daemon it
  runs on a worker thread (`lib/task-worktree-worker.ts`), so the daemon's own thread is
  never held by a large repository.
- The four callers no longer write git: the hub's `startTask`, pi's `startTaskInPi` (the
  `/tasks` command and the concierge's `hub_task_start`), the eval harness. The checks
  the daemon made of a worktree a client said it made (`validWorktree`, `baseSha` on
  `baseRef` and under its `HEAD`, M57) are gone with it.
- The task actions the daemon accepts are the callers' table's list (one list).
- Real model (haiku 5.5, `npm run eval -- --only "roost workspaces"`): 2/2 through prepare → start, $0.0028.
