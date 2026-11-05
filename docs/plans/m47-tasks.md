# M47: the shared task board (a team, not a hub that watches)

Status: done (2026-11-05). The fifth and last piece of [the hub as a control
plane](hub-control-plane.md), and the one the user asked for as a milestone of its own:
Claude Code's agent teams coordinate through a task list (pending / in progress /
completed, claimed with a lock, dependencies that unblock). Roost's version is a board
the daemon keeps (`tasks.json`), that sessions take work from (`roost_task_*` tools; the
`task` op for agents of their own), that the hub shows and edits (`/tasks`), and that
the concierge sees in every digest and works as the lead: it hands open tasks to idle
sessions and says what is blocked and on what.

## Use

```text
/tasks                                          the board: open, blocked (on what), claimed (by whom, since), done (with the result)
/tasks add <title> [after #2 #3] [-- detail]    a task; `after` names the ones it waits on, `--` starts the detail
/tasks assign <id> <session>                    hand it to a session (an id or a unique name): a message there with the task
/tasks done <id> [result]                       mark it done yourself
/tasks rm <id>                                  drop it (a claim on it goes with it)
/tasks release <id>                             take a claim back: the task is open again
```

A session: `roost_tasks` (the board: the summary line, then the blocked, open and
claimed tasks, then the last ten done), `roost_task_claim(id)` (refused as `conflict`
while another live session holds it, as `blocked` while a task it waits on is not done:
the answer says which), `roost_task_done(id, result)`, `roost_task_release(id)` (give it
back), `roost_task_add(title, detail?, after?)` (follow-up work, for any session). The
concierge: `hub_tasks`, `hub_task_add`, `hub_task_assign(id, to)`, `hub_task_done(id,
result?)`, `hub_task_drop(id)`, `hub_task_release(id)`; never a claim.

The team pattern: `/tasks add` a few tasks, start two or three sessions on "take open
tasks from the board one at a time (roost_task_claim), do each, mark it done with the
result (roost_task_done), until none is open", and watch `/tasks`. Or let the concierge
hand them out: a hand-over is a message, not a dispatch, so `/concierge act on` is not
needed for it.

## How

### The store

`tasks.json` in the roost home: `{next, tasks: BoardTask[]}` with `BoardTask {id,
title (≤200), detail (≤2000) | null, state: "open" | "claimed" | "done" | "dropped",
after: number[] (ids it waits on), by: {who: "user" | "concierge" | a session's name,
whoId: its job id | null}, at, owner: {id, name} | null (claimed: who holds it; done:
who held it), claimedAt, doneAt, result (≤2000) | null, assigned: {id, name, at} |
null}` (handed to a session; cleared by the claim). At most 200: done and dropped ones
go first, oldest first, when it is full (`full` otherwise). Ids never reused (`next`).
`writeJsonAtomic`, loaded at start; a claim whose job record is gone is released then.
`lib/board.ts` has the type, `blockedOn`, `boardSummary` and the lines.

### The op

`task {action}` on any connection; the actor is the hub (`user`), the concierge, a job
(after its report) or a foreground pi (after `peer_register`):

| action | who | what |
|---|---|---|
| `list` | all | `{tasks}`, oldest first, every state |
| `add {title, detail?, after?}` | all | one more, `open`; `after` ids must be on the board and not dropped (`bad_request`); `full` at 200 |
| `claim {id}` | a session (the hub and the concierge: `unsupported`) | `open` → `claimed` by it; `conflict` while another live session holds it (named); a holder that is gone (its job not in the roster, its foreground pi disconnected) is released and the task taken over; `blocked` while a task in `after` is neither done nor dropped; `bad_request` when done or dropped; its own claim again: fine |
| `release {id}` | its owner, the hub, the concierge | `claimed` → `open`; `unsupported` for another session, `bad_request` when not claimed |
| `done {id, result?}` | its owner, the hub, the concierge | → `done` with the result; tasks that waited on it are claimable now |
| `drop {id}` | the hub, the concierge | → `dropped`; a claim on it goes with it; a dropped task holds nothing that waited on it |
| `assign {id, to}` | the hub, the concierge | an open task only; `to` is a session id or a unique name (`not_found`; a command is `unsupported`); a `message` delivery to it with the task, its detail and how to claim it (or what it waits on); `assigned` set; `sent` is the delivery's outcome |

The result is `{tasks, task?, sent?}`. Events: `kind: "task"`, `why: add | claim |
release | done | drop | assign`, `text: "#id title"` (done: `: result`; assign: `: to
name`; release: `: why`), `who`/`whoId` the actor. The concierge sees them in its
digest, `/log` shows them (`api claimed task #1 the schema`). Every change pushes a
`board` event `{open, claimed, blocked, done}` to the subscribed hubs.

### A claim goes with its session

A job that fails or is stopped, or is removed: its claims are released (`why:
"release"`, `#1 one: a stopped`, `#2 two: b removed`), so the work is not stuck. A
foreground pi that disconnected is released when another session claims the task (`its
session is gone`), and at a restart of the service (its record is not a job's). A
session restarted by roost (M38) keeps its claims (the same job id). A job that finished
(`done`) keeps its claim until it is removed: its result may still be on the way.

### In every digest

After the fleet (and before the orders): `The board (3 open · 2 claimed · 1 blocked · 5
done):` and one line per live task, blocked first, then open, then claimed (`#5 blocked
on #2 · deploy`, `#4 open · write the tests · handed to api-fix 2m ago`, `#2 claimed by
api-fix (3m) · the migration`); `- empty` or `- every task is done`. The prompt: the
concierge is the lead, not a worker: when a task is open and not blocked and a session
is idle, hand it over and tell the user in one line; when a task is done, tell the user
its result in a few words; when every task is done, say so once; a task whose session
ended is released by roost: hand it over again; never claim or do one; add, finish or
drop one only when the user asks.

### The hub

- `/tasks`: an overlay, the live tasks first (open in the accent colour, blocked in the
  warning one with the ids they wait on, claimed muted; a detail under the open and
  blocked ones), then the done ones, newest first (thirty at most), dim: `#1 done 10m
  ago by api-fix · the schema → applied v2`.
- The header gets `tasks 3 open · 2 claimed · 1 blocked · /tasks` while something is on
  the board (from the `board` events; the counts are fetched at start).
- `/tasks add|assign|done|rm|release` as above; `#` before a number is fine; what the
  daemon refuses is said in its words.

### Agents of their own

The `task` op is on the agent's connection after its hello, like `send`; `tasks` is in
the daemon's capabilities. The TypeScript client (`pi-roost/agent`) has `call(op, args)`
for any op, and `tasks()`, `claimTask(id)`, `taskDone(id, result?)`, `releaseTask(id)`,
`addTask(title, {detail?, after?})`; the Python one `request(op, args, timeout)` (answers
routed by request id; a refusal is a `RoostError` with `code`) and `tasks()`,
`claim_task`, `task_done`, `release_task`, `add_task`.

### Evals (`evals/tasks.eval.ts`)

The harness takes `tasks` (put on the board before the sessions start; `after` by
position among them) and the outcome carries `board` and `taskEvents`.

- "a session works the board": two tasks (`alpha.txt`, then `beta.txt` after #1), one
  session told to take open tasks one at a time and mark each done; checks: both done,
  both claimed then finished, #2 claimed only after #1 was done (the events' order), the
  files written, the run finished.
- "the concierge leads": one task, one idle session told "wait; when a message hands you
  a task, claim it, do it, mark it done"; the concierge on; checks: an `assign` event by
  the concierge to that session, the session's claim and the task done, no claim by the
  concierge, the file written.

Daemon tests (`test/comms.test.ts`, M47): the store and its ids, add's rules, the
hub refused `claim`, the lock (conflict, idempotent), blocked and the unblocking, the
owner's release and done, the hub's release, drop and what waited on it, the feed's
lines, the counts pushed; a claim released at stop and at rm, a disconnected foreground
pi taken over, a restart, the concierge refused `claim`, a session refused `assign`,
the hand-over message, the digest's board. The hub (`test/agent-view.test.ts`, M47):
the overlay, add with `after` and `--`, assign, done, rm, the header line, the refusals.
The concierge's tool list (`test/concierge.test.ts`).

## Not in M47

- A notice to a session when a task it waits on is done (a watch on a task).
- Per-project boards (one board per roost home).
- The concierge dispatching sessions for tasks (that is `act`, M45; it may already).
- A row saying a session takes work from the board.
