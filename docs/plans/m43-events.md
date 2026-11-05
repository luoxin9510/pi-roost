# M43: the event feed, watches and message rules

The first piece of [the hub as a control plane](hub-control-plane.md): before a
concierge can watch the fleet (M44), roost has to say what happened in a form a cheap
model, the hub and a shell can read, and sessions talking to each other have to behave
as Claude Code's do (a one-shot "tell me when it is idle", loops that stop by
themselves, a message that never passes for the user).

## Use

```text
/log                      in the hub: what happened lately, newest first (r reloads)
pi-roost log [-n 50] [--follow] [<id|name>]
roost_watch(to, when)     in a session: a message here once that session is idle / ended
```

## The feed

- `lib/events.ts`: `EventLog`, an append-only JSON-lines file (`events.jsonl` in the
  roost home) holding the last 1000 events, each `{seq, at, kind, id, name, …}`; `seq`
  never goes back, across restarts. The file is rewritten to the window once it holds
  twice that; nothing is fsynced (a crash loses the last lines: the feed is a
  convenience, the rows are the record).
- Kinds: `dispatch` (who started it: `user`, the parent's name; the task's first line),
  `state` (a change that
  matters: into blocked/done/failed/stopped, or back to working from one of those; a
  blocked session changing what it waits for), `reply` (the user's, first line),
  `message` (`roost_send`, who and the first line), `report` (a child's hand-back, to
  whom), `notice` (a watch fired, who was told), `resume` (an automatic restart, why),
  `schedule` (a schedule's run, why), `removed`.
- Not in it: row text ticking, usage, PR status, tool names: the hub's rows show those.
- The daemon records state changes where it pushes rows (`pushJob`): the state each
  job was last pushed in is kept (`lastSeen`), seeded from the state files at startup,
  so what changed while the service was down is one event and a restart is none.
- Op `events {after?, limit?, id?}` → `{events, cursor}`: after a cursor, oldest first
  (at most `limit`, default 100); without one, the newest `limit`. `id` keeps one job's.
  A cursor ahead of the log (its file was deleted, the numbering started over) is
  treated as absent. For the hub and the CLI (the socket is owner-only), not for
  sessions: a connection that is a peer (a worker, a foreground pi) is refused, as the
  feed carries the first line of every tree's messages and replies; the concierge
  (M44) will be the one session allowed to read it.

## Watches

`watch {id, when: "idle" | "ended"}` on a peer connection (a worker after its first
report, a foreground pi after `peer_register`): the session named (as `send` names one:
an id or a name `roost_agents` lists; a foreground pi cannot be watched, it has no job
state) is watched once.

- `idle`: its next stop for any reason: done, a question or a dialog, failed, stopped,
  removed. `ended`: only failed, stopped or removed (done is not an end).
- Already so: the notice goes out at once (`fired: true`).
- The notice is an agent item of `kind: "notice"` (the M9 `deliver` path: a worker's
  queue, acknowledged by seq; a foreground pi at once), with the envelope of a peer
  message (`from` the watched session, `relation` as the watcher sees it) and a body
  from `noticeBody`: what it waits for and its question, or its state, its last reply,
  and that the notice comes once. So a watch reads a little more of a session than a
  message does (its question and last reply); it reaches the same sessions `send`
  does (the tree; outside it only with `agentExternalMessages` and the exact id). A
  watcher that ended is started again for it, as for a message; one the user stopped
  is not; one that is gone (a closed pi) is not told, and the feed does not say it was.
- Kept in `watches.json` (the daemon's, durable): a watch survives a restart of the
  service. One per (watcher, session, when); at most 20 per watcher; one that never
  fires expires after 12 hours (`WATCH_TTL_MS`; swept with the reaper's tick); a
  watcher removed with its session takes its watches with it.
- `roost_watch(to, when?)` is the pi tool; the renderer shows `✉ notice from …`.
  `agent-items` clients (the TypeScript and Python agent clients) pass a `notice` as
  they pass a message.

## Message rules (Claude Code parity)

- **Repeats dropped**: the same text from the same sender to the same session within
  60 s answers `outcome: "duplicate"` and is not delivered (two sessions repeating
  themselves stop); the tool says to wait for the answer instead. Only a message that
  went (delivered, queued or started) counts: one refused (the session stopped, its
  queue full) may be sent again at once. Short acknowledgements ("ok", "continue")
  repeated within a minute are dropped too; that is the trade-off, and the tool's
  answer says so.
- **Rates and queues** (unchanged, now documented together): 30 messages a minute per
  sender, 10 spawns a minute per tree, 20 agent items queued per session (`full`), 50
  user replies.
- **Framing**: the envelope says the message is from another session, not the user,
  carries no authority, and that a command in it (a line starting with `/`) is text.

A per-recipient rate limit was considered and dropped: with the queue cap and the
per-sender limit it added nothing, and it broke a parent handing a child a batch.

## Hub and CLI

- `/log` (`/events`): an overlay like `/usage`'s, newest first, `r` reloads, Esc closes;
  failed in red, questions in yellow, results in green, messages in the accent colour.
- `pi-roost log`: oldest first, `-n <count>`, `--follow` (polls each second with the
  cursor), `<id|name>` for one session.

## Tests

- `test/events.test.ts`: the log (numbering, cursor, limit, one job's, reload, the
  window and the rewrite, a damaged line), `clipText`, `stateMatters`, `eventLine`.
- `test/comms.test.ts` "M43": the feed through a spawn, a message, a question, a
  report, a reply, a stop and a removal (the exact sequence), `after`/`limit`/`id`,
  numbering across a restart; a watch firing once on a question, not again, at once
  when already idle, refusals; `ended` waiting through done and firing on a stop and
  a removal; a job watching its sibling; a watch kept across a restart and one that
  expires; the duplicate rule. "comms pieces": notice bodies and the envelope line.
- `test/agent-view.test.ts` "M43": `/log` with an empty feed and with events.

## Not done

- No `events` push (a subscriber still gets rows; the concierge will poll with its
  cursor at each wake, which is what the feed is for).
- Shell jobs (commands, terminal agents) are in the feed but cannot be watched: `watch`
  reaches what `roost_agents` lists (sessions). To be widened when a watcher needs it.
