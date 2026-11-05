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
  ops).
- **Python**: `sdk/python/roost_agent.py`, one file, standard library only (3.8+).

  ```python
  from roost_agent import RoostAgent
  agent = RoostAgent.from_env("my-agent", version="1.0", on_reply=lambda r: work(r.text))
  if agent:
      agent.report("working", summary="reading the code")
  ```

Both find the job in the environment, connect on the first report, say hello on every
connection, resend the latest report after a reconnect, and hand replies over once each,
in order, one at a time, acking each after its handler returns. Report first: a
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
| `ROOST_JOB_DIR` | `PI_JOB_DIR` | the job's directory (roost's; read-only for the agent) |

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
| `agent-items` | takes peer messages and reports as deliveries (`kind` set) |

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
- `kind` `message` or `report` (with `from`, `relation`) are peer items, sent only to an
  agent that said `agentItems: true` in a report; it acks each with `exact: true`.
- A reply of `/stop` is never delivered: the daemon stops the job. A reply starting with
  `/` is refused while the agent is not connected (it is a command, meaningful live only).
- A rename in the hub changes the row only; `/name` replies are pi's.

### Others

`handback`, `peers`, `send`, `spawn` (the agent-to-agent ops pi's tools use) are on the
same connection, after a report; see `lib/protocol.ts`. They are part of the `peers`
capability and not yet described here.

## Conformance

`test/daemon.test.ts` ("the agent protocol") runs a scripted agent on each client
against a real daemon: the first task as reply 1, reports setting the row, acks
clearing the pending replies, a daemon restart under the agent (it reconnects, says
hello, reports, and takes the next reply once), and its exit.
