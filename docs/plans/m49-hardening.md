# M49: hardening after the board (a stress scenario, an adversarial pass)

M47 shipped with the generic stress run, the evals and an ordinary review. This milestone
measures the board under load and attacks the daemon on purpose, then fixes what that
found.

## The board under load (`stress/run.ts board`)

A new scenario, in the default set: T tasks (`--tasks 120`, every fifth waiting on the one
before), every agent told to work the board at once (claim one of the first three open
tasks, finish it, again), the hub handing tasks out, and the daemon SIGKILLed 1.5 s in and
started again.

- Invariants: every task done, and done once (in the feed and in the agents' own logs:
  one agent each); none claimed before what it waits on was done; no claim released
  (every session lived); a hand-over to a command refused as `unsupported`, the task left
  unmarked; `tasks.json` with unique ids and `next` past the last.
- Measured: the `task` op (`roost.op.task`, budget p95 1 s), conflicts, refusals, requests
  lost to the restart and retried.
- The stress agents are commands that speak the agent protocol (M31). Like `send`, the
  board's `assign` is a message to a session: a command has none, so it is refused. A pi
  job (or a foreground pi) takes it; the evals cover that path with a real model. (M50:
  agents of the protocol take messages now; the hand-overs reach them, and the invariant
  is that each is taken once.)

What the first runs showed, and what changed in the runner:

1. **Event lag over budget (p95 1.0–1.4 s), not from the daemon.** The late events were
   the agents' first `ready` reports, stamped before the agent had connected: their start
   (measured as `allReadyMs`), not a push. And the hubs never connected again after the
   daemon was killed, so the lag after the chaos was not measured at all.
   Now `ready` is left out of the lag, the hubs connect again and subscribe (as the agent
   view does), and a report made while the daemon was down (from the kill to five seconds
   after it is back: agents reconnect with a backoff) is counted apart, not against the
   budget.
2. **Every hand-over failed.** The hub's assign rounds ran after the kill, against tasks
   already taken; and the targets are commands. The hand-overs now come before the race,
   and their refusal is the invariant.

## The adversarial pass

An independent reviewer with an attacker's brief (forge an identity, inject text into the
digest, flood, race, tamper with the files) against an isolated daemon. Its findings:

1. **A session's connection could use the hub's ops.** `dispatch`, `stop`, `rm`,
   `respawn`, `reply`, `pin`, `rename`, `reorder`, `subscribe`, `schedule-*` and
   `shutdown` did not look at who asked. A foreground pi's connection (`peer_register`)
   could stop other sessions, answer their questions as the user, or shut the service
   down; an agent that said `hello` could set the concierge's policy or add a standing
   order as the user's.
   Now these are the hub's (`requireHub`): a connection that identified as a session (a
   worker's `hello` or `report`, a `peer_register`) is refused `unsupported`, as `events`
   and `concierge` already were; `events`, `concierge` and `concierge-ask` also refuse a
   connection that said `hello` before its report was accepted. The concierge's `act`
   (stop, restart) runs as the hub once the policy lets it.
   The boundary: the socket is the user's (mode 0600 in a 0700 directory). A process of
   theirs that opens a fresh connection and never identifies is the hub, as the user's own
   tools are; roost tells sessions and the hub apart, it does not sandbox the user's
   processes from each other. A session with a shell can do what the user can.
2. **No limit on a request line.** The reader split the whole partial line again on every
   chunk: a few hundred megabytes without a newline took gigabytes and a core for minutes.
   Now `LineReader` scans only what arrived, and a line past its limit throws once and
   takes nothing more; the daemon's limit is 4 MiB (`LINE_MAX_REQUEST`): the connection
   ends, the service goes on. At most 1024 connections (`CONNS_MAX`); a connection with
   256 requests unanswered is not read until some are (`INFLIGHT_MAX`); a client that
   leaves 16 MiB unread, a subscriber that stopped reading, is dropped
   (`SEND_BACKLOG_MAX`).
3. **Newlines in titles, rules and names.** Task titles, standing orders and a
   foreground pi's name kept newlines and tabs, so a title could open a line of its own
   in the concierge's digest ("Due now: …", "Standing orders: …"). Now a title, an order
   and a job's, a peer's and an agent's name are one line when they come in (a
   task's detail and result keep their lines), a store edited
   by hand is folded at load, and the digest's renderers (`taskLine`, `orderLine`,
   `eventLine`) fold whatever they are given.
4. **Odd requests.** Bad JSON, non-object args, fractional or string ids, deep nesting,
   unknown ops: every request with a numeric id is answered, a refusal with a code; the
   rest is dropped. Now a test.

## Tests

`test/comms.test.ts` "M49: hardening the socket and the text" (the hub's ops refused to a
session's connection and to an agent's after `hello`; a 5 MB line ends that connection
while the service answers; odd requests answered with a code; titles, orders and names one
line, a hand-edited store folded, no forged digest line); `test/framing.test.ts` (the
reader's limit, and a long line in many chunks). The tests that used one connection as
both a session and the hub now use a connection each, as the real clients do.
