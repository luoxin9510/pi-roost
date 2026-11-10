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

### After review (M65)

- A prepared worktree's time running out while an action on its Task is under way (a
  start still dispatching into it) does not remove it: it is looked at again
  `PREPARED_MS` later (by then taken by the start, or still waiting).
- Asking `prepare` again before the start gives the same worktree, `sourceDirty` with it,
  and does not extend its time.
- An existing Workspace is prepared and started again only while its worktree is on its
  own branch (M57's check of a re-start, kept where it still means something).
- Known: prepared worktrees are in memory; a daemon stopped while one waits leaves it to
  `/tasks cleanup` (task worktrees no task holds, older than 10 minutes). Removing a
  prepared worktree (`discardWorktree`) is git on the daemon's thread, as it was in the
  clients'; only making one moved to a worker.

## M66, as done

- `test/workspace.test.ts` holds the Workspace's rules, run in process through its
  interface: a fake Board and Jobs, a manual Clock, real git in temporary repositories,
  no daemon and no socket. 27 tests, about 8 seconds.
- The four promises, each a test of its own: one action per Task at a time (a second is a
  conflict); at most 2 Verifies per repository, the rest queued and started as one ends
  (another repository not counted; a Task dropped while queued is not started); one merge
  per repository (a second started together is a conflict; another process holding the
  merge lock is too); a restart settles what it cut short (a Verify with no run goes back
  to review, not verified, a queued one too; an interrupted setup fails; the jobs left
  behind are removed, the running ones stopped first).
- The rules the review bugs of M55–M60 were about: a conflict leaves Base untouched and
  stops in the Task's worktree; a worktree off its branch (a detached HEAD) is not merged;
  a damaged record is refused before any git runs; a Verify failure goes back with the end
  of its output, and at `maxRounds` stops for a person; an approved setup runs before the
  session; the commands changed between showing and approving are refused; a drop while
  verifying stops the Verify and nothing rewrites the Stage after; a timeout fails it; a
  branch merged into Base by hand is marked merged (not one reset onto Base, one committed
  to after its review, one with changes in its worktree, one with no commits of its own),
  looked for at most every 10 seconds; cleanup never removes a worktree with changes.
- Of the socket tests of M55–M60, 5 went (their rules are above); the rest stay end to
  end, three of them slimmed to the daemon's wiring (the rules are in process): a real
  setup job, a real Verify failing with its exit code and output, listing the board
  looking for hand merges. Kept as they were: the loop from start to merge, a restart
  settling a merge, a Verify through a real command job, the commands changed / a drop
  while verifying / a timeout with real processes, the concierge's start, comments sent
  back, shelve and restore, a child's first message, the pull request.
  `test/comms.test.ts`: 66 → 61 tests.
- A wait for what the module does after a command ends polls (`vi.waitFor`) instead of
  sleeping 30 ms; a fixed wait stays only where a test checks that nothing happened.

### After review (M66)

- Each guard the review named was removed in turn to see a test fail: the reviewed tip, a
  branch with no commits of its own, a worktree with changes (hand merges), a task marked
  dropped while queued, what a restart does with the jobs left behind and with an
  interrupted setup. Each now fails a test (7 of 7).
- The restart test no longer checks the old module's jobs (a stopped daemon has none);
  it checks what the new one does with them.
- A real setup job and a real Verify failure stay end to end: the daemon's own wiring
  (a command job's exit code and log) is not in the module.
