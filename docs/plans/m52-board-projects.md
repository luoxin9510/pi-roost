# M52: the board by project, and told when a task can be claimed

Two gaps of the M47 board: one board for every session on the machine, whatever it worked
on; and a session that could not take a task yet (it waited on another) had to look again
by itself, or be told by the concierge.

## Projects

- A task has a `project`: the root of a git repository (`projectOf` in `lib/board.ts`:
  up from the directory to a `.git`; a worktree's `.git` file points into its
  repository's `.git/worktrees/`, so roost's isolated sessions share their repository's
  board), or `null`, for any session. Tasks from before have none.
- A session's project is where it works: its job's directory, a foreground pi's (kept per
  directory in the daemon). It lists, claims, finishes and gives back its project's tasks
  and the ones for anyone; another project's is `not_found` to it (one it holds stays its
  own). What it adds is its project's; a session outside any repository adds for anyone.
- The hub and the concierge see every task (`list` names a project by a directory in it:
  that project's and anyone's). The hub's `/tasks` shows the board of the repository it
  runs in (`/tasks all`: every task; outside a repository it shows every task), `/tasks
  add` puts a task on that repository's board; lines name their project (`[api]`) when
  the tasks shown are of several, in the overlay, the digest and the tools. The
  concierge's `hub_task_add` takes `project` (a directory); without it, a task for
  anyone. `assign` to a session working outside the task's project is `unsupported`: it
  could not claim it.

## Told when it can be claimed

- A claim refused as `blocked` keeps the session in the task's `waiting` (at most 20).
- When a task is done or dropped, every open task that waited on it and waits on nothing
  else now is opened: the sessions in `waiting`, the session it was handed to and the job
  that put it on are told by a `message` from `roost` ("Task #n (title) can be claimed
  now: #m, which it waited on, is done"), `waiting` is cleared, and the feed has a `task`
  event `why: "open"` ("roost can claim task #n …"). A task with another dependency still
  open is not.
- `roost_task_claim` says so when it refuses; the board's helpers in the clients are
  unchanged (the message comes to `onMessage`, M50).

## Tests

`test/board.test.ts` (`projectOf`: a repository, a subdirectory, a worktree, outside one;
what a session of a project sees; lines named when several projects); `test/comms.test.ts`
"M52" (against the daemon: two repositories and a worktree; a pi in the worktree sees and
takes the api tasks and anyone's, not the web one; what it adds is the api's; the hub's
list by project; a hand-over across projects refused; a blocked session told when the
dependency is done, the feed's `open` event, a task with two dependencies opened only by
the second, by a drop); the hub's `/tasks` tests; `npm run stress` board.
