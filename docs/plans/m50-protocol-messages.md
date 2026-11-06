# M50: agents of the protocol take messages

The board's lead (the hub's `/tasks assign`, the concierge's `hub_task_assign`) could hand
a task only to a pi session: an agent written on the protocol (M31) never got the message.
The protocol had the capability (`agent-items`) from the start; the daemon's messaging
reached sessions by their session file, and such an agent has none, so it was left out,
and the clients dropped agent items anyway. The M49 stress run found it.

## What changed

- **The daemon** reaches an agent of the protocol by its job, `job:<id>` (`recKey`): it
  is a holder of messages (`holderOf`), a sender and watcher (`sessionKeyOf`), a row in
  `peers`, a target of `send`, `watch` notices and the board's `assign`, and is told when a
  task it holds is dropped or taken back. Whether it takes them is its hello's
  `agent-items`: one that leaves it out is not listed in `peers`, and a message, a
  hand-over, a watch it asks for are refused (`unsupported`) at once instead of waiting
  in its queue (20 at most) for ever (`refusesItems`); one not connected yet gets them
  when it connects (its hello is not known). A plain command stays no session. It does
  not `spawn`: its children would show in no panel (`parentOpen` is a pi's).
- **The clients**: `onMessage` (TypeScript) / `on_message` (Python). Given, the client
  says `agent-items` and `peers` in its hello and `agentItems: true` in every report;
  the daemon then sends the items on its connection; they go to the handler in seq order
  with the replies, one at a time, each acked by itself (`exact`), the last finished seq
  kept as for replies (a restarted agent does not take one twice). `AgentMessage` /
  `Message`: `seq`, `kind` (`message`, `report`, `notice`), `text` (the envelope: who
  from, no user authority), `from` (`sender`), `relation`. And `peers()`, `send(to,
  message)`, `watch(id, when)`.

## Tests

- Conformance (`test/daemon.test.ts`, both clients): the hub adds a task and assigns it
  to the scripted agent; it comes as a message, the agent claims it and finishes it; the
  feed has the hand-over, nothing waits.
- `test/comms.test.ts` "M50": a foreground pi and an agent of the protocol message each
  other by id (each sees the other in `peers`), the agent watches a job and is told, a
  task it holds dropped by the hub is told; one whose hello leaves out `agent-items` is
  not listed and is refused a message, a hand-over and a watch, with nothing queued; a
  plain command is still refused a hand-over; the agent cannot spawn.
- `npm run stress` board: the hub hands up to 20 tasks to the agents before the race;
  every one that reached an agent was taken once (`handed` = `handedSeen`), the rest were
  claimed meanwhile by agents already on the board.
