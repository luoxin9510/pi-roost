# The roost agent protocol

Status: **draft, version 1** (M31). It is frozen as v1 once both clients have been used
by an agent outside this repository; until then a change is possible, and is listed in
the CHANGELOG.

This is how an agent that roost runs talks to roost: it says hello, reports its state,
and takes the user's replies. pi's worker speaks it (through the TypeScript client);
any agent can, at the level it can afford (see [any agent](plans/any-agent.md)). An
agent that speaks none of it can still be run as a terminal agent: see
[profiles](profiles.md).

## Running one

A profile in the user's `roost.json` with `"protocol": true`:

```json
{ "agentProfiles": { "mine": { "command": ["python3", "/path/to/my_agent.py"], "task": "type", "protocol": true } } }
```

`task: "type"` gives the first task to the agent as its first reply (`argv` puts it in
the command line, as for any profile). Until its first report the row is read from its
terminal, as a terminal agent's; after that its reports set the row.

## Clients

- **TypeScript**: `pi-roost/agent` (`lib/agent-client.ts`).

  ```ts
  import { RoostAgent } from "pi-roost/agent";
  const agent = RoostAgent.fromEnv({ name: "my-agent", version: "1.0", onReply: async (r) => work(r.text) });
  agent?.report({ state: "working", summary: "reading the code" });
  ```

  `Reporter` underneath is what pi's worker uses (coalescing, backoff, `call` for other
  ops). It needs node alone (a test keeps it so). A controller (a hub, a script) uses
  `pi-roost/client` (`DaemonClient`) and the types in `pi-roost/protocol`.
- **Python**: `sdk/python/roost_agent.py`, one file, standard library only (3.8+).

  ```python
  from roost_agent import RoostAgent
  agent = RoostAgent.from_env("my-agent", version="1.0", on_reply=lambda r: work(r.text))
  if agent:
      agent.report("working", summary="reading the code")
  ```

Messages from other sessions (M50): give `onMessage` (`on_message`) and the agent takes
them: a peer's message, a task the hub or the concierge hands over, a child's report, a
watch's notice (`{seq, kind, text, from, relation}`; `text` is the daemon's envelope). The
client then says `agent-items` and `peers` in its hello and `agentItems: true` in its
reports; the items come in seq order with the replies, one at a time, each acked by
itself. `peers()`, `send(to, message)` and `watch(id, when)` reach other sessions; the
board's helpers are there without it (`tasks`, `claimTask`/`claim_task`, …).

```ts
const agent = RoostAgent.fromEnv({
  name: "my-agent",
  onReply: async (r) => work(r.text),
  onMessage: async (m) => { if (/Task #(\d+) on the board/.test(m.text)) await takeIt(m) },
});
```

Both find the job in the environment, connect on the first report, say hello on every
connection, resend the latest report after a reconnect, and hand replies over once each,
in order, one at a time, acking each after its handler returns. The last finished seq is
kept in the job's `agent.json` before its ack, so an agent started again after a crash
skips what it had finished (and only acks it). Report first: a
connection, and so a reply, starts with a report. `close()` sends the latest report; a
reply whose handler is still running when it is called is acked only if it finishes
first (otherwise it comes again on the next start).

## The job's identity

Set by roost in the agent's environment at start, for the job's whole life:

| Variable | Older name | |
|---|---|---|
| `ROOST_JOB_ID` | `PI_JOB_ID` | the job |
| `ROOST_JOB_TOKEN` | `PI_JOB_TOKEN` | its secret: every request about the job carries it |
| `ROOST_SOCKET` | `PI_DAEMON_SOCK` | the daemon's unix socket |
| `ROOST_JOB_DIR` | `PI_JOB_DIR` | the job's directory: roost's, except `agent.json`, where the clients keep the last finished reply |

Read the new name first. The agent's children inherit them, so its subprocesses can
speak for the job; the token is good for that one job only (its reports and its replies).

## The wire

A unix stream socket (owner-only). Each message is one line of JSON (UTF-8, `\n`).

- Request, client → daemon: `{"id": 1, "op": "report", "args": {...}}`. `id` is the
  client's number for matching the response.
- Response: `{"id": 1, "ok": true, "result": {...}}` or
  `{"id": 1, "ok": false, "error": "text", "code": "unauthorized"}`.
- Event, daemon → client, unasked: `{"event": "deliver", ...}` (no `id`).

Unknown fields are ignored on both sides. An enum (a state, a code) grows only with a
protocol version. Requests on one connection are answered in order.

### Error codes

`bad_request` (malformed), `unauthorized` (wrong token: stop speaking for this job),
`not_found` (no such job), `full` (too many replies waiting, 50), `busy` (try again
shortly), `unsupported` (not for this kind of job). Others the daemon may give to its
other clients (`locked`, `limit`, `rate_limited`, ...) are not for agents.

## Ops

### `hello`

```json
{"op": "hello", "args": {"protocol": 1, "agent": {"name": "my-agent", "version": "1.0"}, "capabilities": ["report", "replies"]}}
→ {"protocol": 1, "daemon": {"name": "roost", "version": "0.1.11"}, "capabilities": ["replies", "steer", "agent-items", "peers", "spawn", "handback"]}
```

On every new connection, before the first report. `protocol` is the highest version
the agent speaks; the daemon answers with its own (it may be lower: the agent decides
whether to go on). A daemon from before M31 answers `bad_request` (unknown op): go on
with version 1 behaviour. The capabilities the agent names are kept with the job (rows
show them) and say what roost may expect:

| Capability | The agent ... |
|---|---|
| `report` | sends reports (every agent of this protocol) |
| `replies` | takes replies and acks them |
| `steer` | honours `mode: "steer"` on a reply (joins the work under way) |
| `usage`, `context` | fills `usage` / `context` in its reports |
| `model-switch` | takes `/model` and `/thinking` replies |
| `transcript` | has a transcript roost can show |
| `peers` | uses the agent-to-agent ops (pi's `roost_*` tools) |
| `agent-items` | takes peer messages, reports, notices and digests as deliveries (`kind` set) |

### `report`

```json
{"op": "report", "args": {"id": "<job>", "token": "<token>", "report": {
  "state": "working", "status": "busy", "waitingFor": null,
  "summary": "reading the code", "question": null, "choices": [],
  "tool": null, "error": null, "name": null, "model": null}}}
→ {}
```

A full snapshot every time: what is left out is null (the clients fill the defaults).
The core fields:

| Field | |
|---|---|
| `state` | `working`, `blocked` (waits for the user), `done`, `failed` |
| `status` | `busy`, `waiting`, `idle` |
| `waitingFor` | null, `question`, `dialog`, `first-prompt` (with `blocked`) |
| `summary` | the row's text (≤ 500) |
| `question`, `choices` | what it asks (≤ 2000), and the answers it offers (≤ 20, each ≤ 200) |
| `tool`, `error` | the tool running (≤ 100); what went wrong, with `failed` (≤ 1000) |
| `name` | the session's name (≤ 200; null: roost names it) |
| `model`, `thinking` | what it runs |

Capability fields: `context` (`{tokens, window, percent}`), `usage` (see
`lib/usage.ts`), `prLinks`, `remoteAt`; pi's own: `attachSignal`, `attachRepaint`,
`agentItems`. Send a report whenever the state changes; the row text at most every few
seconds. The connection a report goes through becomes the job's: replies come on it.

### Replies: the `deliver` event and `ack`

```json
← {"event": "deliver", "id": "<job>", "seq": 3, "text": "also fix the docs", "mode": "steer"}
→ {"op": "ack", "args": {"id": "<job>", "token": "<token>", "seq": 3}}
```

- Replies are numbered per job (`seq`, from 1, never reused, continued across restarts).
- Each stays pending until acked; on every new reporting connection all pending ones
  are sent again. Drop a `seq` you have handled already (ack it again).
- An ack covers every user reply up to that `seq` (peer items below are acked one by one).
  So ack a reply only once it and every one before it are handled: the clients ack after
  the handler returns, and, when replies are sent again, only those already finished.
- `mode`: `steer` (join the work under way) or `followUp` / absent (after it); an agent
  without `steer` treats both as after.
- `kind` `message`, `report`, `notice` or `digest` (with `from`, `relation`) are peer
  items, sent only to an agent that said `agentItems: true` in a report; it acks each
  with `exact: true`. An agent of this protocol is reached by its job (M50; it has no
  session file): other sessions see it in `peers` and `send` to it, the board's `assign`
  hands it a task, its watches tell it, as for a pi session. One whose hello leaves out
  `agent-items` is not listed, and a message, a hand-over or a watch of its own is
  refused (`unsupported`) rather than kept for it; one not connected yet gets them when
  it is. It does not `spawn` (`unsupported`): its children would have no panel to show
  in. A `notice` (M43) is a watch that fired: the session it watched is
  idle or ended. A `digest` (M44) wakes the concierge: what happened and the fleet, in
  `<roost-digest>`; only the concierge's job gets them.
- A reply of `/stop` is never delivered: the daemon stops the job. A reply starting with
  `/` is refused while the agent is not connected (it is a command, meaningful live only).
- A rename in the hub changes the row only; `/name` replies are pi's.

### Request ids (for the clients that send replies and start jobs)

`reply` and `dispatch` (the hub's, the CLI's and any controller's ops, not an agent's) take
an optional `requestId` (1–64 of `A-Z a-z 0-9 _ . : -`). Sent again with the same id,
because the answer was lost (the daemon restarted, the connection dropped), the request
is taken once: a reply answers `{"duplicate": true, "saved": true}` and is not queued
again (if the job had ended and was to be started for it, it is started now); a dispatch
answers with the job the first one made, whatever the resend's other arguments, as long
as that job exists. A job remembers its last 100 reply ids, kept in the same write as the
reply itself (for a terminal agent the id is kept just after the text is typed: a crash
between the two types it again). Use a new id for each new request and the same id for
each resend of it. (M51: the hub, the CLI, pi's panel and `/bg` do, through `requestOnce` in
`lib/client.ts`: a resend on a new connection when the answer was lost, never after a
refusal.)

### Others

`handback`, `peers`, `send`, `spawn` (the agent-to-agent ops pi's tools use) are on the
same connection, after a report; see `lib/protocol.ts`. They are part of the `peers`
capability and not yet described here, except:

- `watch {id, when: "idle" | "ended"}` (M43) → `{id, name, when, fired}`: tell me once,
  as a `notice` delivery, when that session (an id or a name `peers` lists) is next idle
  (its next stop: done, a question, failed, stopped, removed) or has ended (failed,
  stopped, removed). Already so: `fired: true`, the notice comes at once. The watch is
  kept across a restart of the daemon and expires after 12 hours; at most 20 per
  session.
- Message rules (M43): `send` answers `outcome: "duplicate"` for the same text to the
  same session again within a minute, and it is not delivered; 30 messages a minute
  per sender (`rate_limited`); 20 agent items waiting per session (`full`). The
  envelope of every peer item says it is from another session, not the user, carries
  no authority, and that a command in it is text.

The hub's ops (M49): `dispatch`, `stop`, `rm`, `respawn`, `reply`, `pin`, `rename`,
`reorder`, `subscribe`, `schedules`, `schedule-*` and `shutdown` are refused
(`unsupported`) on a connection that identified as a session: after `hello` or `report`
(an agent, a worker) or `peer_register` (a foreground pi). An agent that needs them opens
a connection of its own for the user (the hub, the CLI); its job's own connection uses
the ops above. The socket: a request line is at most 4 MiB (a longer one ends the
connection), at most 1024 connections, at most 256 requests in flight on one connection
(it is not read meanwhile), and a client that leaves 16 MiB of answers and events unread
is dropped. Names (a peer's, an agent's `hello`) are folded to one line.

`events {after?, limit?, id?}` → `{events, cursor}` (M43) is for the hub and the CLI,
not for agents (a peer connection is refused, the concierge's excepted: the feed
carries every tree's messages):
what happened across the jobs (starts, state changes that matter, replies, messages,
reports, notices, restarts, schedule runs, removals), the last 1000, oldest first after
a cursor (`after`), the newest `limit` without one. See `docs/plans/m43-events.md`.

### The concierge (M44)

The hub's own agent is a job with `role: "concierge"` (rows carry it): `concierge
{action: "on", launch?}` starts it (a pi launch the hub builds, or the job it had),
`{action: "off"}` stops it, `{action: "status"}` says how it stands (`ConciergeStatus`
in `lib/concierge.ts`); `concierge-ask {text}` from the hub is a reply to it;
`concierge-say {kind: info | need | answer, text}` on its own connection is what it
tells the user (a `concierge` event in the feed) or its answer. Hubs get `{"event":
"concierge", "status": …}` pushes. The concierge may `send` to any session, by id or
name, and read `events`. `concierge` and `concierge-ask` are the hub's: a session's
connection is refused. An event a job caused (a message, a notice, what the concierge
said) carries `whoId`, that job's id, besides `who`, its name: names can be shared
(`concierge` itself cannot be taken by a session: not by `dispatch`, `rename` or the
name it reports for itself). See
`docs/plans/m44-concierge.md`.

M45: rows carry `suggested {text, why, at}` while they wait and the concierge has
suggested an answer (`concierge-suggest {id, text, why?}` on its connection). Its
policy: `concierge {action: "answer", answer: never | routine | always}` and `{action:
"act", act}` from the hub (kept by the daemon; `roost.json`'s values are the start),
`concierge-policy {}` on its connection says what is in force. `concierge-reply {id,
text, why?}` answers a session in the user's place: refused with code `policy` unless
the policy allows, `bad_request` unless the row waits for a question; it is a `reply`
event with `who: "concierge"`. `concierge {action: "undo"}` withdraws the last one (the
session is steered, or replied to, to disregard it). `concierge-act {what: stop |
respawn, id} | {what: dispatch, launch}` needs `act`. The status carries `policy` and
`answered`. See `docs/plans/m45-policy.md`.

M46: `concierge-order {action: "add", text, when?}` keeps a standing order (the hub's
connection: `by: "user"`; the concierge's: `by: "concierge"`; `when` is a schedule's
vocabulary, `every 30m | daily 18:00 | weekdays 09:00 | cron "…"`, else `bad_request`;
at most 50, `full`), `{action: "rm", id}` drops one (the concierge only its own:
`unsupported`), `{action: "list"}` the lot, `{action: "applied", id, text?}` (the
concierge's) marks one applied (`lastAt`, `count`). A session's connection is refused.
The result is `{orders: StandingOrder[], order?}` with `{id, text, when, by, at,
lastAt, nextAt, count}`. Every digest lists them; one on a clock whose `nextAt` has
come is a `digest` delivery with `why: "order"` and a "Due now" section (its `nextAt`
moves on when that digest reached the concierge). `concierge` events: `why: "order"`
(applied: `#id what`), `"order-kept"`, `"order-dropped"`. The status carries `orders`
(their number). See `docs/plans/m46-orders.md`.

### The task board (M47): the `tasks` capability

`task {action}` is the shared task board, on any connection: the hub's (the actor is
`user`), the concierge's, a job's (after its report; the actor is the job) or a
foreground pi's. The result is `{tasks: BoardTask[], task?, sent?}`, the tasks oldest
first, with `{id, title, detail, state: open | claimed | done | dropped, after: ids,
by: {who, whoId}, at, owner: {id, name} | null, claimedAt, doneAt, result, assigned:
{id, name, at} | null, project: string | null, waiting: {id, name}[], workspace?}`.

Workspaces (M54, the `workspaces` capability): a task may carry `workspace: {path,
branch, baseRef, baseSha, stage, note, verify?, merge?, comments?}`, its own git
worktree and where it is in the loop task → worktree → verify → review → local merge
(`docs/plans/ade-roadmap.md`). `stage` is `working | verifying | review | merging |
conflict | failed | shelved | merged`; for such a task the stage is the truth, `state`
follows the claim as for any task, and `merged` is `state: done`. A client that does not
know the field ignores it. Dependencies: a task waited on holds until it is done, except
that one with a workspace holds until it is merged, one of another project until it is
done (its stage does not count), and a dropped one never holds. The store
(`tasks.json`) is version 2 and keeps fields it does not know; an older daemon would
drop `workspace` on its first save, so going back to one is not supported once tasks
have workspaces.

M55 adds the workspace's actions; M65 has the daemon make the worktree. `{action:
"prepare", id}` (the hub's and the CLI's; the concierge's with `act` on) makes the task's
worktree (branch `roost/t<id>-…` from the branch checked out in the repository's main
checkout; a shelved task's made again from its branch; one there, as it is) and answers
`workspace: {path, branch, baseRef, baseSha, sourceDirty?}`; it is held for that task 5
minutes, then removed unless started. `{action: "start", id, launch}`: the caller built
an agent launch whose cwd is inside that worktree; a start not prepared for is refused,
and a refused start removes the worktree prepared for it. The daemon dispatches it with the job's `task` set (no `worktree`: the task owns it),
claims the task for the new job and sets `stage: working`; the result has `job`. A
task with a workspace and no live holder may be started again into the same worktree.
The holding session's `done` needs a clean worktree (`bad_request` otherwise) and moves
the task to `review`. `{action: "merge", id, mode?: "ff" | "no-ff"}` (the hub's and the
CLI's only) syncs the branch with base in its worktree (`git merge`), then moves base
(`--ff-only`, `--no-ff`, or `update-ref` when base is checked out nowhere) under a lock;
the result's `note` says how it went (merged, a conflict, refused). `{action: "back",
id, note?}` (the hub's, the concierge's) returns it to `working` and tells its holder;
`{action: "abort", id}` gives up a conflicted sync; `{action: "commit", id, message?}`
commits what its worktree holds. Each change of stage is a `task` event with `why:
"stage"`. See `docs/plans/m55-start-merge.md`.

M56: with `.roost/project.json` on the base branch, the holder's `done` runs the
repository's `verify` command (once a person approved it: `{action: "approve", id,
dry?}`, the hub's only; `dry` shows the commands) as a shell job `verify #N` in the
worktree, at most two per repository; the task is `verifying`, then `review` (exit 0),
`working` again with the end of the output sent to the holder, or `failed` after
`maxRounds`. `{action: "verify", id}` runs it again from review or failed; `{action:
"pass", id}` accepts a failure. A first `start` runs an approved `setup` before the
session (the result has no `job` then; the session follows). See
`docs/plans/m56-verify.md`.

M57: the concierge may `start` a task too (its `hub_task_start`), when its policy lets it
act (`policy` otherwise): it makes the worktree and the launch as the hub does; the
daemon drops the concierge's role and any job's identity from the launch's environment.
See `docs/plans/m57-workspace-overlay.md`.

M58: `{action: "comment", id, comment: {file, line, text, lineText?, tip?}}` and
`{action: "uncomment", id, index}` (a person's: the hub, the CLI) keep review comments on
the task (`workspace.comments`, at most 200); `back` sends them to the live holder in its
message and clears them, or leaves them for the next `start`'s prompt. See
`docs/plans/m58-review.md`.

M59: `{action: "shelve", id}` (a person's) removes a clean worktree and keeps the branch
(stage `shelved`, the claim given back; `start` brings it back); `{action: "cleanup",
dry?}` (a person's, no `id`) removes, or with `dry` lists, worktrees and verify logs left
behind (the result's `note`, a line each). Listing the board marks a branch merged by
hand as merged. The daemon builds the launch of a session the concierge starts from the
concierge's own job. See `docs/plans/m59-shelve-cleanup.md`.

M60: `{action: "pr", id, dry?, hash?}` (a person's, from review): `dry` returns what it
will do and the branch tip as `hash`; with that hash it pushes the branch and runs `gh pr
create`, recording `workspace.pr` (the task stays in review). See
`docs/plans/m60-exits.md`.

Projects (M52): a task is for a project, the root of a git repository (a worktree counts
as its repository), or for any session (`project: null`). A session's project is where it
works (its job's directory, a foreground pi's); outside a repository it has none. A
session lists, claims and finishes its project's tasks and the ones for any session (one
of another project is `not_found` to it), and what it adds is its project's. The hub and
the concierge see every task, or name a project by a directory in it (`project`, an
absolute path; `bad_request` otherwise).

- `{action: "list", project?}`: the lot (done and dropped ones too; at most 200 are kept,
  the done and dropped ones going first when it is full).
- `{action: "add", title, detail?, after?: ids, project?}`: a new task, `open`; `after`
  names tasks on the board (`bad_request` otherwise); `full` at 200.
- `{action: "claim", id}`: a session takes it (the hub and the concierge may not:
  `unsupported`). `blocked` while a task in `after` is neither done nor dropped;
  `conflict` while another live session holds it (one whose session is gone, failed,
  stopped or removed holds nothing: the task is released, with a `task` event, and taken
  over); `bad_request` when done or dropped; one's own claim again is fine. Refused as
  `blocked`, the session is kept in `waiting` (at most 20): when the tasks it waits on
  are done or dropped, those sessions, the one it was handed to and the job that put it
  on are told in a `message` (from `roost`) that it can be claimed, and the feed has a
  `task` event with `why: "open"`.
- `{action: "done", id, result?}` and `{action: "release", id}`: the owner's (the hub
  and the concierge may too, and the holder is then told in a `message`);
  `unsupported` for another session; `bad_request` when the state does not fit (done
  or dropped already; not claimed).
- `{action: "drop", id}` and `{action: "assign", id, to}`: the hub's and the
  concierge's only. `drop` takes an open or claimed task off the board (a done one is
  `bad_request`); its holder is told in a `message`. `assign` sends the session (an
  id or a unique name; `not_found`; a command is `unsupported`, and so is a session
  working outside the task's project) a `message` delivery
  with the task and how to claim it, and when the message reached it (`sent` is
  `delivered`, `queued` or `started`) marks the task `assigned` (cleared by the claim);
  a session that was not reached (`sent` says so) is not handed the task. An open task
  only; `bad_request` while a hand-over of it is on its way.

An `id` is a positive integer, or a string of digits. On an agent's connection the op
is accepted after its report is (before that, or for a job that ended: `unauthorized`).
A job that fails, is stopped or is removed holds nothing: its claims are released (a
`task` event with `why: "release"`); a foreground pi's go five seconds after it
disconnected (`PI_ROOST_FG_CLAIM_GRACE_MS`), unless a pi re-opened on the session is
back. The counts go to subscribed hubs as a `board` event `{open, claimed, blocked,
done, workspaces, needsYou}` on every change (M54: tasks in workspaces, not merged or
dropped, are counted in `workspaces` only; `needsYou` counts those in review, conflict
or failed); each change is a `task` event in the feed (`why: add | claim |
release | done | drop | assign`, `text: "#id title"`, with `: result`, `: to name` or
`: why released`). The TypeScript client has `call(op, args)` and `tasks() /
claimTask(id) / taskDone(id, result?) / releaseTask(id) / addTask(title, {detail?,
after?})`; the Python one `request(op, args, timeout)` (after the first `report()`,
which makes the connection; a refusal is a `RoostError` with `code`, `disconnected`
when the connection was lost meanwhile; `TimeoutError` after `timeout`) and `tasks()
/ claim_task / task_done / release_task / add_task`. See `docs/plans/m47-tasks.md`.

## Conformance

`test/daemon.test.ts` ("the agent protocol") runs a scripted agent on each client
against a real daemon: the first task as reply 1, reports setting the row, acks
clearing the pending replies, a daemon restart under the agent (it reconnects, says
hello, reports, and takes the next reply once), and its exit.
