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
  with `exact: true`. A `notice` (M43) is a watch that fired: the session it watched is
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
each resend of it.

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
name, and read `events`. See `docs/plans/m44-concierge.md`.

## Conformance

`test/daemon.test.ts` ("the agent protocol") runs a scripted agent on each client
against a real daemon: the first task as reply 1, reports setting the row, acks
clearing the pending replies, a daemon restart under the agent (it reconnects, says
hello, reports, and takes the next reply once), and its exit.
