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
2. **Its interface**: `createWorkspaces(deps)` returns `act(caller, task, action, args)`,
   `done(task, caller)` (a Session said the Task is done: Verify starts),
   `commandEnded(jobId, code)` (a Verify or setup command ended) and `settle()` (at
   start). The seven maps and sets are its own.
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
