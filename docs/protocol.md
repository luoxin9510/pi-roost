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
→ {"protocol": 1, "daemon": {"name": "roost", "version": "0.1.11"}, "capabilities": ["replies", "steer", "agent-items", "peers", "spawn", "handback", "events", "watch", "tasks", "workspaces"]}
```

On every new connection, before the first report. `protocol` is the highest version
the agent speaks; the daemon answers with its own (it may be lower: the agent decides
whether to go on; the [op reference](#op-reference) lists the daemon's capabilities). A daemon from before M31 answers `bad_request` (unknown op): go on
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

## Op reference

<!-- op-reference:start -->

Generated from `lib/protocol-schema.ts`, `lib/callers.ts` and `lib/protocol.ts` by `npm run docs:protocol`; do not edit between the markers.

Protocol version 1. Types: `string`, `number`, `integer`, `boolean`, `null`, `T[]`, `Record<string, T>`, `{ field?: T }` (`?`: optional), a quoted value. A type named after another module's interface (`BoardTask`, `RoostEvent`, `ConciergeStatus`, `StandingOrder`, `UsageInfo`, `PrInfo`) is described there. A limit is what the daemon does with the value today: some are refused (`bad_request`, `too_long`), some cut.

### Capabilities

Daemon (`hello` answers with these, in this order):

| Capability | |
|---|---|
| `replies` | takes the user's replies for the agent (`deliver`, `ack`) |
| `steer` | honours `mode: "steer"` on a reply |
| `agent-items` | delivers peer messages, reports, notices and digests |
| `peers` | `peers`, `send` |
| `spawn` | `spawn` |
| `handback` | `handback` |
| `events` | `events` |
| `watch` | `watch` |
| `tasks` | `task` (the shared board) |
| `workspaces` | a task's own worktree and its stages (`task` prepare, start, merge, ...) |

Agent (named in the agent's `hello`):

| Capability | The agent ... |
|---|---|
| `report` | sends reports (every agent of this protocol) |
| `replies` | takes replies and acks them |
| `steer` | honours `mode: "steer"` on a reply |
| `usage` | fills `usage` in its reports |
| `context` | fills `context` in its reports |
| `model-switch` | takes `/model` and `/thinking` replies |
| `transcript` | has a transcript roost can show |
| `peers` | uses the agent-to-agent ops |
| `agent-items` | takes peer messages, reports, notices and digests as deliveries |

### Shared shapes

#### `DispatchArgs`

A session to start (dispatch, spawn, a schedule's launch, a task's start).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `kind` | `"pi" \| "shell"` | no |  | DI-6: "shell" runs `command` without pi (no session file). |
| `cwd` | `string` | yes |  |  |
| `sessionFile` | `string` | yes |  |  |
| `command` | `string[]` | yes |  |  |
| `env` | `Record<string, string>` | yes |  |  |
| `name` | `string` | yes |  |  |
| `model` | `string` | no |  |  |
| `thinking` | `string` | no |  |  |
| `agent` | `string` | no |  | M18: the agent (pi-subagents definition) the session runs as. |
| `workspaceEnv` | `"shell" \| "direnv" \| "off"` | no |  | M20: how the worker's environment follows its workspace (absent: as carried). |
| `envDeny` | `string[]` | no |  | M20: names (or `PREFIX*`) a workspace's environment may not set. |
| `envForce` | `string[]` | no |  | M20: names that pass envDeny (envAllowList). |
| `origin` | `"bg" \| "dispatch" \| "adopt" \| "fork"` | yes |  |  |
| `piVersion` | `string` | no |  |  |
| `worktree` | `{ path: string, branch: string, repo: string, base: string }` | no |  | M10: the worktree the dispatching side made for this session (cwd is inside it). |
| `fanout` | `string` | no |  | M26: one task, several models: the id the sessions share. |
| `profile` | `string` | no |  | M30: a level 0 agent from this profile (kind "shell"). |
| `term` | `{ submit: string, settleMs: number, waiting?: string, working?: string, typeTask?: string }` | no |  |  |
| `resumeCommand` | `string[]` | no |  | M30: the argv that reopens it, when the profile has one. |
| `taskInArgv` | `boolean` | no |  | M30: the first task is in its argv (it has been given something to do). |
| `resumable` | `boolean` | no |  | M40: a profile with `resume`: a run of it cut short can carry on (autoResume). |
| `protocol` | `boolean` | no |  | M31: a profile's agent that speaks the roost agent protocol. |
| `requestId` | `string` | no |  | M36: a resend with the same id returns the job the first one made. |

#### `HelloArgs`

M31: an agent says which protocol and capabilities it has, before it reports.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `protocol` | `integer` | yes |  | The highest protocol version the agent speaks. |
| `agent` | `{ name: string, version?: string }` | no |  |  |
| `capabilities` | `string[]` | no |  | What the agent can do (AGENT_CAPABILITIES); unknown ones are ignored. |

#### `HelloResult`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `protocol` | `integer` | yes |  |  |
| `daemon` | `{ name: "roost", version: string }` | yes |  |  |
| `capabilities` | `string[]` | yes |  | What the daemon offers agents (the ops beyond report, ack and hello): DAEMON_CAPABILITIES. |

#### `HandbackArgs`

M9, on a worker connection: the run it was spawned for (or a user turn) ended.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `state` | `"done" \| "blocked" \| "failed"` | yes |  |  |
| `result` | `string \| null` | yes |  |  |
| `question` | `string \| null` | yes |  |  |
| `error` | `string \| null` | yes |  |  |

#### `WorkerReport`

What a worker reports about itself (full snapshot every time).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `state` | `"working" \| "blocked" \| "done" \| "failed"` | yes |  |  |
| `status` | `"busy" \| "waiting" \| "idle"` | yes |  |  |
| `waitingFor` | `"dialog" \| "question" \| "first-prompt" \| null` | yes |  |  |
| `summary` | `string \| null` | yes |  |  |
| `question` | `string \| null` | yes |  |  |
| `choices` | `string[]` | yes |  |  |
| `tool` | `string \| null` | yes |  |  |
| `error` | `string \| null` | yes |  |  |
| `name` | `string \| null` | yes |  |  |
| `model` | `string \| null` | yes |  |  |
| `thinking` | `string \| null` | no |  | M8; absent from workers before 0.1.5. |
| `context` | `ContextInfo \| null` | no |  | M8: how full the session's context window is (pi's ctx.getContextUsage()). |
| `usage` | `UsageInfo \| null` | no |  | M24: absent from workers before 0.1.11. |
| `attachSignal` | `boolean` | no |  | The worker reacts to the host's SIGUSR2 attach signal (AT-5). |
| `attachRepaint` | `boolean` | no |  | M14: on attach the worker sets the terminal up again and repaints itself (read by hosts before M21). |
| `agentItems` | `boolean` | no |  | M9: the worker takes agent messages and reports (custom messages, per-item acks). |
| `remoteAt` | `number` | no |  | M11: when a phone (pi-mobile) last acted on this session (ms epoch): it is in use. |
| `prLinks` | `string[]` | no |  | M16: pull request URLs the session linked (gh output, branch lookups). |

#### `JobRow`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `cwd` | `string` | yes |  |  |
| `kind` | `"pi" \| "shell"` | yes |  |  |
| `startedAt` | `number` | yes |  |  |
| `state` | `"working" \| "blocked" \| "done" \| "failed" \| "stopped"` | yes |  |  |
| `pid` | `number \| null` | yes |  |  |
| `status` | `"busy" \| "waiting" \| "idle" \| null` | yes |  |  |
| `waitingFor` | `"dialog" \| "question" \| "first-prompt" \| null` | yes |  |  |
| `sessionFile` | `string` | yes |  |  |
| `name` | `string` | yes |  |  |
| `endedAt` | `number \| null` | yes |  |  |
| `summary` | `string \| null` | yes |  | Row text: a status sentence while working, the result or question after. |
| `question` | `string \| null` | yes |  |  |
| `choices` | `string[]` | yes |  |  |
| `model` | `string \| null` | yes |  |  |
| `thinking` | `string \| null` | yes |  | M8: the worker's thinking level (or the one it was started with). |
| `context` | `ContextInfo \| null` | yes |  | M8: context window use as last reported; null for shell jobs and before the first report. |
| `usage` | `UsageInfo \| null` | no |  | M24: what the session spent, as last reported (absent before it reports, or from older workers). |
| `error` | `string \| null` | yes |  |  |
| `stateSince` | `number` | yes |  | When the job entered its current state (for "waiting 3m"). |
| `reaped` | `boolean` | yes |  | DM-4: stopped for idleness; attaching or replying starts it again. |
| `pinned` | `boolean` | yes |  | AV-K7: listed first and never reaped. |
| `order` | `number \| null` | yes |  | AV-K13: the user's position within its group, or null when never moved. |
| `orderKey` | `string \| null` | yes |  | The section the order belongs to (a state group or `dir:<cwd>`); stale elsewhere. |
| `parentSession` | `string \| null` | no |  | M9: the session that spawned this one (roost_spawn). |
| `rootSession` | `string \| null` | no |  | M9: its spawn tree's root. |
| `parentOpen` | `boolean` | no |  | M13: someone holds the parent session now (a foreground pi, or a job recorded for it). |
| `agent` | `string \| null` | no |  | M18: the agent it runs as. |
| `prs` | `PrInfo[]` | no |  | M16: the session's pull requests as gh last reported them. |
| `worktree` | `{ path: string, branch: string, base?: string } \| null` | no |  | M10: the session's own git worktree (M26: and the commit it started from). |
| `fanout` | `string \| null` | no |  | M26: the sessions started together for one task with several models share this id. |
| `profile` | `string` | no |  | M29: the agent that runs it: "pi", "shell", or (M30) the name of the user's agent profile. |
| `schedule` | `string \| null` | no |  | M39: the schedule that started it. |
| `capabilities` | `string[]` | no |  | M31: what its agent said it can do in its hello (absent: it never said). |
| `role` | `"concierge" \| null` | no |  | M44: the hub's own agent (not listed as a session; the hub shows its status line). |
| `suggested` | `{ text: string, why: string \| null, at: number } \| null` | no |  | M45: the concierge's suggested answer for a row that waits for one (the hub sends it with one key). |
| `task` | `string \| null` | no |  | M48: the task it was started on (one line, at most 200 characters). |
| `queued` | `number` | no |  | M48: user replies waiting for it. |

#### `PeerRow`

M9: a session an agent may message (roost_agents).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `name` | `string` | yes |  |  |
| `relation` | `"parent" \| "child" \| "sibling" \| "tree" \| "external"` | yes |  |  |
| `role` | `"job" \| "foreground"` | yes |  |  |
| `state` | `"working" \| "blocked" \| "done" \| "failed" \| "stopped" \| "live"` | yes |  |  |
| `status` | `"busy" \| "waiting" \| "idle" \| null` | yes |  |  |
| `waitingFor` | `"dialog" \| "question" \| "first-prompt" \| null` | yes |  |  |
| `summary` | `string \| null` | yes |  |  |
| `question` | `string \| null` | yes |  |  |
| `cwd` | `string` | yes |  |  |

#### `SendResult`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `outcome` | `"delivered" \| "queued" \| "started" \| "stopped" \| "not running" \| "duplicate"` | yes |  | delivered: handed to the running session; queued: it is busy starting; started: it was ended and starts again; duplicate (M43): the same text went to it a moment ago, not sent again |
| `id` | `string` | yes |  |  |
| `name` | `string` | yes |  |  |
| `relation` | `"parent" \| "child" \| "sibling" \| "tree" \| "external"` | yes |  |  |
| `dialog` | `boolean` | no |  | The target is waiting on a dialog; the message waits until it is answered. |

#### `ScheduleRow`

M39: a schedule as the hub and the CLI show it.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes |  |  |
| `when` | `string` | yes |  |  |
| `task` | `string \| null` | yes |  |  |
| `agent` | `string` | yes |  | M40: what each run is: "pi", "shell" (a command) or a profile's name. |
| `cwd` | `string` | yes |  |  |
| `model` | `string \| null` | yes |  |  |
| `paused` | `boolean` | yes |  |  |
| `catchUp` | `boolean` | yes |  |  |
| `nextAt` | `number \| null` | yes |  |  |
| `lastRunAt` | `number \| null` | yes |  |  |
| `lastJob` | `string \| null` | yes |  |  |
| `lastSkip` | `{ at: number, why: string } \| null` | yes |  |  |

#### `DaemonStatus`

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `pid` | `number` | yes |  |  |
| `version` | `string` | yes |  |  |
| `socketDir` | `string` | yes |  |  |
| `liveJobs` | `number` | yes |  |  |
| `totalJobs` | `number` | yes |  |  |
| `ptyError` | `string \| null` | yes |  |  |
| `startedAt` | `number` | yes |  |  |

#### `ContextInfo`

M8: how full the session's context window is (pi's ctx.getContextUsage()).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `tokens` | `number \| null` | yes |  | Estimated tokens in context; null right after a compaction, until the next reply. |
| `window` | `number` | yes |  |  |
| `percent` | `number \| null` | yes |  | 0-100; null when tokens is unknown. |

### Ops

### `ping`

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

No fields.

Result:

| Field | Type | Required | |
|---|---|---|---|
| `pid` | `number` | yes |  |
| `version` | `string` | yes |  |

### `schedules`

M39: scheduled tasks.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

No fields.

Result:

| Field | Type | Required | |
|---|---|---|---|
| `schedules` | `ScheduleRow[]` | yes |  |

### `schedule-add`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes |  |  |
| `when` | `string` | yes |  |  |
| `launch` | `DispatchArgs` | yes |  | A session to start (dispatch, spawn, a schedule's launch, a task's start). |
| `task` | `string` | no |  |  |
| `catchUp` | `boolean` | no |  |  |

Result:

`ScheduleRow` (see shared shapes).

### `schedule-rm`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `name` | `string` | yes |  |

### `schedule-pause`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes |  |  |
| `paused` | `boolean` | yes |  |  |

Result:

`ScheduleRow` (see shared shapes).

### `schedule-run`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `name` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `name` | `string` | yes |  |
| `id` | `string` | yes |  |

### `hello`

M31: an agent says which protocol and capabilities it has, before it reports.

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

`HelloArgs` (see shared shapes).

Result:

`HelloResult` (see shared shapes).

### `list`

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `all` | `boolean` | no |  |  |
| `cwd` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `jobs` | `JobRow[]` | yes |  |

### `dispatch`

A session to start (dispatch, spawn, a schedule's launch, a task's start).

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

`DispatchArgs` (see shared shapes).

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `stop`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `rm`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `worktree` | `{ path: string, branch: string, removed: boolean, branchKept: boolean, reason?: string }` | no | M10: what happened to the session's worktree. |

### `resolve`

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `query` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `status`

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

No fields.

Result:

`DaemonStatus` (see shared shapes).

### `shutdown`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `keepWorkers` | `boolean` | no |  |  |

Result:

No fields.

### `subscribe`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

No fields.

Result:

No fields.

### `report`

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `token` | `string` | yes |  |  |
| `report` | `WorkerReport` | yes |  | What a worker reports about itself (full snapshot every time). |

Result:

No fields.

### `reply`

M28: a reply to a working session steers into its current work (pi's Enter) or waits for it to finish (Alt+Enter); absent: waits.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `text` | `string` | yes |  |  |
| `mode` | `"steer" \| "followUp"` | no |  | "steer" joins the work under way, after its current tool calls; "followUp" waits until it is done |
| `requestId` | `string` | no | 1-64 chars | M36: makes a resend safe: the same id is taken once (the first answer is given again). |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `delivered` | `boolean` | yes | handed to the live worker |
| `saved` | `boolean` | yes | kept for its next start (PK-5) |
| `stopped` | `boolean` | no |  |
| `respawned` | `boolean` | no |  |
| `error` | `string` | no |  |
| `duplicate` | `boolean` | no |  |

### `ack`

Worker to daemon: the reply with this seq was handed to pi (exact: only that agent item).

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `token` | `string` | yes |  |  |
| `seq` | `integer` | yes |  |  |
| `exact` | `boolean` | no |  |  |

Result:

No fields.

### `respawn`

Start an ended job again from its session file; `restart` also restarts a live one.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | no |  |  |
| `all` | `boolean` | no |  |  |
| `restart` | `boolean` | no |  |  |
| `prompt` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `results` | `{ id: string, started: boolean, error?: string }[]` | yes |  |

### `pin`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `pinned` | `boolean` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `pinned` | `boolean` | yes |  |

### `rename`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `name` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `reorder`

AV-K13: these jobs, in this order (the rest of their group keeps its place).

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `ids` | `string[]` | yes |  |  |
| `key` | `string` | yes |  |  |

Result:

No fields.

### `peer_register`

M9: a foreground pi joins as a peer on this connection.

Callers: Person, Concierge, Session, Unregistered agent. Refused: none.

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `session` | `string` | no |  |  |
| `name` | `string` | yes |  |  |
| `cwd` | `string` | yes |  |  |
| `pid` | `integer` | yes |  | The pid that owns the session's writer lock. |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `peers`

M9, on a peer connection: the sessions this peer may message.

Callers: Concierge, Session. Refused: Person (`unauthorized`), Unregistered agent (`unauthorized`).

Args:

No fields.

Result:

| Field | Type | Required | |
|---|---|---|---|
| `peers` | `PeerRow[]` | yes |  |

### `send`

Callers: Concierge, Session. Refused: Person (`unauthorized`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `to` | `string` | yes |  | A session's id or name (`peers` lists them). |
| `message` | `string` | yes | <= 8000 chars |  |

Result:

`SendResult` (see shared shapes).

### `spawn`

Callers: Concierge, Session. Refused: Person (`unauthorized`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `launch` | `DispatchArgs` | yes |  | A session to start (dispatch, spawn, a schedule's launch, a task's start). |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `handback`

M9, on a worker connection: the run it was spawned for (or a user turn) ended.

Callers: Concierge, Session (background only). Refused: Person (`unauthorized`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args:

`HandbackArgs` (see shared shapes).

Result:

| Field | Type | Required | |
|---|---|---|---|
| `routed` | `boolean` | yes |  |

### `peer_ack`

M9, on a foreground peer connection: the report with this ref reached pi.

Callers: Session (foreground only). Refused: Person (`unauthorized`), Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `ref` | `string` | yes |  |  |

Result:

No fields.

### `events`

M43: the event feed (what happened), with a cursor: `after` the seq last seen.

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `after` | `integer` | no |  |  |
| `limit` | `integer` | no |  |  |
| `id` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `events` | `RoostEvent[]` | yes |  |
| `cursor` | `number` | yes |  |

### `watch`

M43, on a peer connection: tell me once when that session is next idle (done, or waiting for an answer) or has ended.

Callers: Concierge, Session. Refused: Person (`unauthorized`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `when` | `"idle" \| "ended"` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `when` | `"idle" \| "ended"` | yes |  |
| `fired` | `boolean` | yes | It was already so; the notice went out at once. |

### `concierge`

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args: one of these, by `action`.

#### `concierge` action "on"

Start it (a pi launch the hub built), or the job it had.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"on"` | yes |  |  |
| `launch` | `DispatchArgs` | no |  | A session to start (dispatch, spawn, a schedule's launch, a task's start). |

#### `concierge` action "off"

Stop it.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"off"` | yes |  |  |

#### `concierge` action "status"

How it stands.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"status"` | yes |  |  |

#### `concierge` action "answer"

M45: set the policy's answer.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"answer"` | yes |  |  |
| `answer` | `"never" \| "routine" \| "always"` | yes |  |  |

#### `concierge` action "act"

M45: set the policy's act.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"act"` | yes |  |  |
| `act` | `boolean` | yes |  |  |

#### `concierge` action "undo"

M45: withdraw the last answer it gave a session.

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"undo"` | yes |  |  |

Result:

No fields.

### `concierge-ask`

M44, from the hub: a question for the concierge (`? ...`); its answer comes as a `concierge` event.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unsupported`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `text` | `string` | yes |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |

### `concierge-say`

M44, on the concierge's own connection: what it tells the user (hub_notify), or its answer to a question.

Callers: Concierge. Refused: Person (`unauthorized`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `kind` | `"info" \| "need" \| "answer"` | yes |  |  |
| `text` | `string` | yes |  |  |

Result:

No fields.

### `concierge-policy`

M45, on the concierge's connection: the policy in force (which of its tools it may use).

Callers: Concierge. Refused: Person (`unauthorized`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args:

No fields.

Result:

| Field | Type | Required | |
|---|---|---|---|
| `answer` | `"never" \| "routine" \| "always"` | yes |  |
| `act` | `boolean` | yes |  |

### `concierge-suggest`

M45, on the concierge's connection: the answer it would give a session that waits for one, and why.

Callers: Concierge. Refused: Person (`unauthorized`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `text` | `string` | yes |  |  |
| `why` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `concierge-reply`

M45, on the concierge's connection: an answer in the user's place; refused (`policy`) unless the policy allows.

Callers: Concierge. Refused: Person (`unauthorized`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args:

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `id` | `string` | yes |  |  |
| `text` | `string` | yes |  |  |
| `why` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `concierge-act`

Callers: Concierge. Refused: Person (`unauthorized`), Session (`unsupported`), Unregistered agent (`unauthorized`).

Args: one of these, by `what`.

#### `concierge-act` what "stop" or "respawn"

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `what` | `"stop" \| "respawn"` | yes |  |  |
| `id` | `string` | yes |  |  |
| `why` | `string` | no |  |  |

#### `concierge-act` what "dispatch"

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `what` | `"dispatch"` | yes |  |  |
| `launch` | `DispatchArgs` | yes |  | A session to start (dispatch, spawn, a schedule's launch, a task's start). |
| `why` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |

### `concierge-order`

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

Args: one of these, by `action`.

#### `concierge-order` action "add"

Keep one (the hub's or the concierge's connection).

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"add"` | yes |  |  |
| `text` | `string` | yes | <= 500 chars |  |
| `when` | `string` | no |  | M39's vocabulary (`every 30m`, `daily 18:00`, `weekdays 09:00`, `cron "..."`). |

#### `concierge-order` action "rm"

Drop one (the hub's; the concierge's own only).

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"rm"` | yes |  |  |
| `id` | `integer` | yes |  |  |

#### `concierge-order` action "list"

List them.

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"list"` | yes |  |  |

#### `concierge-order` action "applied"

Mark one applied (the concierge's).

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unsupported`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"applied"` | yes |  |  |
| `id` | `integer` | yes |  |  |
| `text` | `string` | no |  |  |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `orders` | `StandingOrder[]` | yes |  |
| `order` | `StandingOrder` | no | The order acted on. |

### `task`

Callers: Person, Concierge, Session. Refused: Unregistered agent (`unauthorized`).

Args: one of these, by `action`.

#### `task` action "list"

The lot (done and dropped ones too).

Callers: Person, Concierge, Session. Refused: Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"list"` | yes |  |  |
| `project` | `string` | no |  | M52: a directory in the project's repository (absolute). |

#### `task` action "add"

A new task, open.

Callers: Person, Concierge, Session. Refused: Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"add"` | yes |  |  |
| `title` | `string` | yes | <= 200 chars |  |
| `detail` | `string` | no | <= 2000 chars |  |
| `after` | `integer[]` | no |  | Tasks on the board it waits on. |
| `project` | `string \| null` | no |  |  |

#### `task` action "claim"

A session takes it.

Callers: Session. Refused: Person (`unsupported`), Concierge (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"claim"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "release"

The owner gives it back.

Callers: Person, Concierge, Session. Refused: Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"release"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "done"

The owner marks it done.

Callers: Person, Concierge, Session. Refused: Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"done"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `result` | `string` | no | <= 2000 chars |  |

#### `task` action "drop"

Takes an open or claimed task off the board.

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"drop"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "assign"

Hands an open task to a session (a message there).

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"assign"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `to` | `string` | yes |  | A session's id or unique name. |

#### `task` action "prepare"

M65: the daemon makes the task's worktree and says where.

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"prepare"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "start"

M55: starts a session in the prepared worktree.

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"start"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `launch` | `DispatchArgs` | yes |  | A session to start (dispatch, spawn, a schedule's launch, a task's start). |

#### `task` action "merge"

M55: merges the task's branch into base, locally.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"merge"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `mode` | `"ff" \| "no-ff"` | no |  |  |

#### `task` action "back"

M55: returns it to working and tells its holder.

Callers: Person, Concierge. Refused: Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"back"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `note` | `string` | no | <= 500 chars |  |

#### `task` action "abort"

M55: gives up a conflicted sync.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"abort"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "commit"

M55: commits what its worktree holds.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"commit"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `message` | `string` | no |  |  |

#### `task` action "approve"

M56: approves the repository's commands.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"approve"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `dry` | `boolean` | no |  | Show the commands only. |
| `hash` | `string` | no |  |  |

#### `task` action "verify"

M56: runs the verify command again.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"verify"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "pass"

M56: accepts a failure.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"pass"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "comment"

M58: a review comment on a line of the task's diff.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"comment"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `comment` | `{ file: string, line: integer, text: string, lineText?: string, tip?: string }` | yes |  |  |

#### `task` action "uncomment"

M58: withdraws a review comment.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"uncomment"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `comment` | `{ file: string, line: integer, at: number }` | yes |  |  |

#### `task` action "shelve"

M59: removes a clean worktree, keeps the branch.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"shelve"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |

#### `task` action "cleanup"

M59: removes (dry: lists) worktrees and verify logs left behind. No id.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"cleanup"` | yes |  |  |
| `dry` | `boolean` | no |  | List only. |

#### `task` action "pr"

M60: pushes the branch and opens a pull request.

Callers: Person. Refused: Concierge (`unsupported`), Session (`unsupported`), Unregistered agent (`unauthorized`).

| Field | Type | Required | Limit | |
|---|---|---|---|---|
| `action` | `"pr"` | yes |  |  |
| `id` | `integer` | yes |  | a task's id (a positive integer) |
| `dry` | `boolean` | no |  | Say what it would do and the tip as `hash`. |
| `hash` | `string` | no |  | The tip shown by the dry run. |

Result:

| Field | Type | Required | |
|---|---|---|---|
| `tasks` | `BoardTask[]` | yes | M47: the board as it stands. |
| `task` | `BoardTask` | no | The task acted on. |
| `sent` | `"delivered" \| "queued" \| "started" \| "stopped" \| "not running" \| "duplicate"` | no | How the hand-over message went. |
| `job` | `{ id: string, name: string }` | no |  |
| `note` | `string` | no |  |
| `hash` | `string` | no |  |
| `workspace` | `{ path: string, branch: string, baseRef: string, baseSha: string, sourceDirty?: boolean }` | no |  |

<!-- op-reference:end -->

## Conformance

`test/daemon.test.ts` ("the agent protocol") runs a scripted agent on each client
against a real daemon: the first task as reply 1, reports setting the row, acks
clearing the pending replies, a daemon restart under the agent (it reconnects, says
hello, reports, and takes the next reply once), and its exit.
