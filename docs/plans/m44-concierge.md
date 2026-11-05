# M44: the concierge, v0 (report and relay)

The second piece of [the hub as a control plane](hub-control-plane.md): a cheap model
roost keeps as the hub's own agent. It is woken with what happened (M43's feed), looks
at sessions, tells the user what needs them, relays between sessions on request, and
answers questions about the fleet. In v0 it never answers a session in the user's place
(`answer: "never"`; M45 adds the policy).

## Use

```text
/concierge on          start it (a pi session on roost.json's concierge.model, haiku by default)
/concierge off         stop it (its session stays; on starts the same one again)
/concierge status      its line; /concierge log: what it did and said; /concierge attach: into it
? what is blocked      ask it (with it on, ? on an empty input starts a question; /ask … too)
```

Its line sits under the hub's header while it is on:

```
concierge · needs you: api-fix asks which schema to use (2m ago) · $0.02 today
```

`roost.json` (the user's; a project cannot set it):

```json
"concierge": { "model": "anthropic/claude-haiku-5-5", "thinking": "off", "wakesPerHour": 60, "heartbeat": "every 15m", "dailyBudgetUsd": 1 }
```

## How

### A job with a role

`lib/concierge.ts` holds the pure pieces (settings, the digest, the system prompt,
the status). The concierge is an ordinary pi job the hub starts through the
`concierge {action: "on", launch}` op: the pi adapter builds the launch
(`conciergeLaunch` in `adapters/pi/hub-options.ts`: this directory, the configured
model and thinking level, no task) with `ROOST_ROLE=concierge` in its environment,
and the daemon records it with `role: "concierge"` (`JobRow.role`; the hub's
`listed()` leaves it out of the rows). The daemon keeps `concierge.json`: the job's
id, on/off, the feed cursor, when it was woken, what it last said. One at a time;
`off` stops the job and `on` starts the same one again (its session is its memory);
removing the job is off.

In pi, `adapters/pi/concierge.ts` is the role: the worker role (reports, replies,
agent items) without the `roost_*` tools, plus the hub's tools, the concierge's system
prompt replacing pi's (it has no project to read), pi's own tools switched off
(`setActiveTools`), and a renderer for digests. Its plain-text reply to a turn a user
message started (the hub's `? …`) is handed back with `concierge-say {kind: "answer"}`
by the extension itself, so the hub shows whatever it answered.

| Tool | Daemon op |
|---|---|
| `hub_sessions` | `list` (the fleet, one line each) |
| `hub_events` | `events` (the concierge is the one session allowed to read the feed) |
| `hub_read(id, what)` | the row's question and choices; the transcript's tail (`lib/transcript.ts`); the last screen |
| `hub_send(to, text)` | `send`; the concierge reaches every session, by id or name (`peerRows` treats it as the hub's) |
| `hub_notify(text, level)` | `concierge-say {kind: info \| need}`: the status line, a `concierge` event in the feed |
| `hub_watch(id, when)` | `watch` (M43) |

### Wakes

- `on` wakes it at once with the fleet as it stands (a heartbeat digest), so a session
  that already waits is reported then; what happened while it was off is not its
  concern (its cursor moves to the end). A daemon restart keeps the cursor: what
  happened while the service was off is its first digest after.
- Every event the daemon records nudges the concierge, except its own (events on its
  job, or caused by it: `whoId`, the job's id, since a name can be shared); a burst is
  one wake (`CONCIERGE_COALESCE_MS`, 5 s); one wake at a time, what happens during one
  is the next.
- A wake reads the feed after the cursor, leaves its own events out, and delivers
  `digestText(...)` as an agent item of `kind: "digest"` (the M9 path: its queue,
  acknowledged by seq; an ended concierge is started again for it; one the user
  stopped is not, and that counts as off). The digest: the events one line each, then
  the fleet one line each, in `<roost-digest why="events|heartbeat">`.
- The cursor moves only when the digest reached it. `wakesPerHour` (60): past the cap a
  wake waits (`CONCIERGE_RETRY_MS`, 60 s) and the events with it; so does one its queue
  refused. `dailyBudgetUsd` (1): once its row's cost today reaches it, it is not woken
  (`overBudget` in its status, looked at on every tick; the hub's line says so); 0
  means no limit. A `? …` question is the user's and goes through regardless.
- A heartbeat (`heartbeat`, `every 15m`; `off` for none) wakes it when nothing did for
  that long, with "nothing happened since" and the fleet, so a stuck fleet is noticed.
  The daemon checks every 30 s (`CONCIERGE_TICK_MS`).
- A daemon restart keeps it (the state file); what happened while the service was off
  is its first digest after.

### The hub

- `concierge` op (status) at connect; `{event: "concierge", status}` pushes keep the
  line current. A `need` notice is also said in the notice line. An answer that comes
  after a `? …` opens in an overlay (Esc closes). The status carries `behind`: events
  it has not been woken with yet (a wake due, or held by the cap); the line says
  `3 new`, and the evals wait on it before grading.
- `?` on an empty input starts a question when the concierge is on (help moved to
  `/help` then); `/ask …` and `/concierge ask …` always work.
- `/concierge log` is `/log` kept to the concierge's events (what it said, sent, did).

### Trust

The concierge sees every session's question, summary and transcript, messages any
session and reads the feed: that is its job, and why its settings are the user's only.
Enforced by the daemon: it cannot start, stop or remove sessions, run commands or touch
files (no such tools); only the hub can start, stop or question it (`concierge`,
`concierge-ask` refuse a session's connection); only it says things to the hub
(`concierge-say`); its name is its own (a session cannot take or be renamed to
`concierge`); what it causes is told apart by its job id, not its name; a session's
text cannot close the `<roost-digest>` early. Prompt rules, not enforced: in v0 it is
told never to answer a session's question or tell one to proceed; a message it sends
is framed as from the concierge, not the user, and told it cannot approve anything, but
the receiving model decides what to make of that. Its sends and notices are in the
feed (`/concierge log`).

## Tests

- `test/concierge.test.ts`: settings and defaults; the digest; the system prompt; the
  `concierge` key is the user's; the role in pi (tools, prompt, active tools, the answer
  handed back for a user-started turn only).
- `test/comms.test.ts` "M44": on (a role, not a row; pushed status), off, on again, a
  restart of the service, removal; a digest after a burst with its own doings left out
  and the cursor moving; reaching sessions by name; the feed open to it and closed to a
  foreground pi; notices and answers reaching the hub, a question reaching it as the
  user's words; the heartbeat; the hourly cap; the daily budget.
- `test/agent-view.test.ts` "M44": `/concierge on` with the launch, the line, a notice,
  `?` and `/ask`, the answer overlay, its row not listed, off.
- `evals/concierge.eval.ts` (real model): a question, a failure and a finished run are
  reported in its first wakes, the question as needing the user, without answering it;
  a finding relayed from one session to another on request (`ask` step, `extra`
  sessions in the harness).

## Not in v0

- `answer: "routine" | "always"`, suggested answers, the escalation banner, undo (M45).
- Standing orders (M46), the task board (M47).
- The phone (out of scope); a terminal notification for a `need` notice (the hub's
  line and the notice are it, for now).
- `pi-roost concierge` in the CLI: the hub is the control plane; the standalone hub
  (`pi-roost hub`) has `/concierge`.
