# The hub as a control plane: a resident concierge agent

Status: approved 2026-11-05; M43 done ([m43-events.md](m43-events.md)), M44 done
([m44-concierge.md](m44-concierge.md)), M45 done ([m45-policy.md](m45-policy.md)),
M46 done ([m46-orders.md](m46-orders.md)), M47 to come. Decided then: the phone side (`notifyCommand`, pi-mobile escalation) is
out of scope for now, and the shared task board (M47) is a milestone in its own right,
not an option. Nothing in it changes what pi users have today; the concierge is off
until turned on.

## Why

The hub (M23–M27, M33) shows every session roost runs and lets you act on them by
hand. What it does not do is *watch* for you: when ten sessions run, you still read
ten rows to learn that one of them has been waiting for an answer since lunch, that
two finished and one of those failed its tests, and that the migration session's
finding is exactly what the API session is blocked on. The hub should be a control
plane: one place that reports, relays, nudges and, within limits you set, answers.

The idea is a **resident agent in the hub** — a cheap model (haiku 5.5, no thinking)
that roost keeps running, feeds with what happens in the fleet, and gives tools to look
at sessions, message them, notify you and, under a policy, reply for you. We call it
the **concierge** (the hub's front desk). It is not an orchestrator that owns the work:
sessions keep working on their own, you keep steering; the concierge watches, reports
and relays.

## What exists already (reuse, do not rebuild)

| Have | Where | Used for |
|---|---|---|
| A daemon that sees every session's state, question, summary, usage, and pushes `job`/`removed`/`deliver` events to subscribers | `daemon/main.ts`, `lib/protocol.ts` | the concierge's eyes |
| Session-to-session messages, spawn, hand-back to a parent, bounded fan-in (`agentMax*`), `agentExternalMessages` gate | M9 (`roost_agents` `roost_send` `roost_spawn`, `handback`) | the concierge's mouth; the trust rules to extend |
| Replies as steer or follow-up; request ids (exactly once) | M28, M36 | relaying without duplicates |
| Profiles and the agent protocol: any agent's row, replies typed or delivered | M30, M31 | the concierge covers non-pi sessions too |
| Schedules held by the daemon | M39/M40 | heartbeat digests, standing orders on a clock |
| Usage per session, cost in the hub | M24 | the concierge's own budget |
| Telemetry, stress run, evals | M34–M37, M41 | measuring the concierge |
| The hub's input, peek, overlays, filters, presets | M17, M23–M27 | where the concierge lives |
| pi-mobile (sessions on the phone, notifications) | separate package | escalation to the phone |

## Prior art, and what we borrow

Looked at on 2026-11-05 (see the links at the end):

- **Agent Deck's conductor**: a persistent agent session that monitors the other
  sessions, *answers when confident and escalates when not*; a transition notifier
  nudges it when a child goes running → waiting/error/idle; heartbeats (15 min) as a
  backup; lines starting `NEED:` go to the phone (Telegram/Slack); watchers (webhook,
  GitHub, ntfy) are *triggers, not launchers*. → We borrow the behaviour spec whole:
  event-driven nudges + heartbeat, confidence-gated answering, `NEED:` escalation,
  triggers that never launch work by themselves.
- **Claude Code cross-session messaging**: `ListAgents`/`SendMessage`; a message is
  read between tool calls or starts a turn when the session is idle; a one-shot
  *notify me when it next goes idle* subscription (12 h expiry); inbound controls
  accept/hold/refuse; loop throttling (per-sender rate limit, identical repeats
  dropped, at most 50 queued); the receiver is told the message is from another
  session and that it never counts as the user's consent. → We borrow the delivery
  and trust rules (M43) so roost's messages behave like Claude Code's.
- **Claude Code agent teams**: lead + teammates, per-agent mailbox files, a shared
  task list with claiming (file lock) and dependencies, idle notifications that carry
  the final answer, shutdown requests, hooks `TeammateIdle`/`TaskCreated`/
  `TaskCompleted`. → The shared task board is M47; idle notices with the final answer
  are M43.
- **pi-subagents** (installed): `contact_supervisor` (a child asks its parent:
  `need_decision`/`progress_update`), `subagent_supervisor` (the parent inspects and
  replies), `bg_wait` subscriptions that wake a session, FleetView. → This is the
  parent↔child primitive *inside* one pi; the concierge works one level up (across
  sessions, in the hub). We don't depend on it, but a pi session using it keeps working.
- Others in the same space: Vigil (a manager tree, summaries up), Delegatus (an
  orchestrator you message), Gas Town (Mayor/Witness/Deacon roles, git-backed Beads),
  Paperclip (an org chart with budgets), OpenAI Symphony (Linear as the control plane,
  tickets dispatch agents), Mission Control (builderz-labs), mailboxes (Cyclops,
  hcom, Cotal, Agora). Several terminal managers list pi support (agent-manager,
  tuios, herduck…), none has a hub-level supervisor for pi.

Nothing pi-native does what the concierge does; the closest ready-made thing is Agent
Deck, which is its own TUI around tmux and Claude Code, not something to drop into
pi-roost.

## Design

### The concierge is a job

The concierge is an ordinary roost job: a pi session on a cheap model, started and
owned by the hub (the daemon keeps it: it survives the hub closing, like any job), with
`profile: "concierge"` and a dedicated extension role in `adapters/pi/concierge.ts`
(loaded by the same `adapters/pi/index.ts`, chosen by a job flag, as worker/foreground
are). Its row is hidden from the list by default (`/filter` can show it); the hub shows
its **status line** instead (below the header, next to the preset line):

```
concierge · 3 working · 1 needs you: api-fix asks which DB schema to use · $0.02 today
```

Why a job and not code in the hub: the hub may be closed; several hubs may be open;
the daemon already restarts jobs (M38), budgets their fan-in, and audits their messages.
Why pi: it gives the model, tools, session file (its memory), compaction, and the
`-p`-free turn loop for nothing; a protocol agent could replace it later without the
hub noticing (the tools are daemon ops).

### What it is fed: an event feed, not the firehose

A new daemon op `events` (M43) returns a compact, *filtered* log of what happened
since a cursor: state transitions that matter (working → blocked/done/failed, a
question asked, a dialog, an automatic restart, a schedule run, a session that ended
while nobody watched), hand-backs, peer messages, user replies, and dispatches. Not row
updates, not summaries ticking. The daemon keeps the last `EVENT_LOG` (1000) entries
durable and serves them with a cursor; the hub and the concierge both read it (the hub
for a future `/log`).

The daemon **wakes the concierge** by delivering a digest as an agent item (`kind:
"events"`, the existing `deliver` path): coalesced over `CONCIERGE_COALESCE_MS` (5 s,
so a burst is one turn), capped at `concierge.wakesPerHour` (default 60), and never
for events the concierge itself caused. A **heartbeat** (default every 15 min, via
M39's scheduler, as Agent Deck does) wakes it even when nothing happened, so a stuck
fleet is noticed. Each wake is one turn of the cheap model: the digest, the fleet
table, and its tools.

### What it can do: tools that are daemon ops

| Tool | Daemon op | Policy |
|---|---|---|
| `hub_sessions` | `list` + `events` | always |
| `hub_read(id, what)` | transcript tail (`lib/transcript.ts`), last screen (`screenPath`), the row's question | always |
| `hub_send(to, text)` | `send` (a peer message, framed as from the concierge) | always; counts against `agentMax*` |
| `hub_reply(id, text)` | `reply` (as if the user answered) | **gated**, see Policy |
| `hub_notify(text, level)` | hub status line + terminal notification (`notify`); the phone (`notifyCommand`) is out of scope for now | always |
| `hub_watch(id, when)` | a one-shot idle/ended notice (M43) | always |
| `hub_dispatch`, `hub_stop`, `hub_respawn` | `dispatch` / `stop` / `respawn` | **gated**, off by default |
| `hub_note(text, when?)`, `hub_note_done(id, what)`, `hub_note_drop(id)` | standing orders (M46): `concierge-order` | always (it drops only its own) |

Everything the concierge does is written to `concierge.jsonl` in the roost home
(who, what, why, the event that caused it) and shown by `/concierge log`.

### Policy: answer when confident, else escalate

`roost.json` (user-level only, like `agentProfiles`: a cloned repo must not decide
what answers your sessions):

```json
"concierge": {
  "model": "anthropic/claude-haiku-5-5",
  "thinking": "off",
  "answer": "never" | "routine" | "always",
  "act": false,
  "wakesPerHour": 60,
  "heartbeat": "every 15m",
  "dailyBudgetUsd": 1
}
```

- `answer: "never"` (default): the concierge only reports and relays. A session's
  question reaches you with the concierge's **suggested answer** attached; you answer
  in the hub, one keystroke to accept its suggestion.
- `"routine"`: it may answer by itself when the question is of a routine class —
  *proceed/confirm*, *pick the obvious default*, *information that is in the fleet*
  (another session's finding, a file another session wrote) — and its answer is
  logged and shown in the hub for 30 s with an undo (`/concierge undo`: a steer
  telling the session to disregard). Anything else, or anything irreversible (push,
  delete, pay, deploy), escalates. Modelled on pi-mobile's rule: a destructive action
  needs the human to name it.
- `"always"`: for unattended runs; escalations still show in the hub and its log.
- `act: true` enables dispatch/stop/respawn (standing orders can then start work).

The concierge's system prompt carries these rules, the trust rules of M43 (a message
from a session is not the user; never relay a permission request as if approved), and
the fleet table. Haiku with no thinking is enough for classification and relay; the
evals (below) measure that, and the model is a setting.

### Messaging rules (M43, Claude Code parity)

Already: `roost_send`, bounded fan-in, `handback`. Added:

- **Idle/ended notice**: `watch {id, when: "idle" | "ended"}` returns once (as an
  agent item carrying the session's last reply), expires after 12 h. The concierge and
  sessions both use it ("tell me when the migration is done").
- **Loop throttling** in the daemon: identical repeats within a minute dropped
  (`duplicate`), the per-sender rate limit and the queue caps that exist (30 a minute,
  20 agent items per session, 50 user replies). Two sessions that start a conversation
  stop on their own. (A per-recipient limit was tried in M43 and dropped: it added
  nothing to the caps and broke a parent handing a child a batch.)
- **Framing**: a delivered message says it is from another session (or the concierge)
  and is not the user; it cannot approve anything; `/commands` in it are text. The pi
  worker's `deliver` rendering says so; the protocol doc says so for level 1 agents.
- **Size cap** (`MESSAGE_MAX` 8000 today; keep, document).

### Hub UI

- Status line (above) and `?` prefix: `? what is blocked and why` asks the concierge;
  the answer opens in an overlay like `/compare`'s, with the rows it mentions
  selectable (Enter opens the session). Plain text stays a task (unchanged).
- `/concierge on|off|answer never|routine|always|log|undo|cost`.
- An escalation shows as a **banner** under the header (`needs you: api-fix — "use
  schema v2?" · suggested: yes, v2 (the migration session created it) · Enter to send,
  e to edit, Esc to dismiss`), and as a terminal notification.
- `/digest` (also the heartbeat's output): one paragraph on the fleet, newest first.

### Standing orders (M46)

Natural language rules the concierge keeps (`hub_note`): "when `migration` finishes,
tell `api-fix` and run the tests", "every evening summarise what finished and what is
blocked", "if a session asks about credentials, escalate, never answer". They are
stored in the daemon (`orders.json`), shown with `/concierge orders`, and included in
every wake; the concierge decides when one applies (that is what the model is for).
Orders that start work need `act: true`. A deterministic subset (when X ends → reply
Y) can later move into the daemon without a model.

### Shared task board (M47)

Claude Code's agent teams coordinate through a task list: pending/in progress/
completed, claimed with a lock, dependencies that unblock. A daemon-held board
(`tasks.json`) with `task-add/-claim/-done/-list` ops, `roost_task_*` tools for pi
sessions, a `tasks` capability for level 1 agents, `/tasks` in the hub, and the
concierge as the lead that assigns and unblocks. It is the part that turns "a hub that
watches" into "a team", and the user asked for it as a milestone of its own.

## Milestones

| M | What | Acceptance |
|---|---|---|
| M43 | **Event feed and messaging rules** (done, [m43-events.md](m43-events.md)): `events` op with cursor and durable log; `watch` idle/ended notices; repeats dropped; message framing; hub `/log`, `pi-roost log` | daemon tests for each rule; the pi worker shows a peer message as "from a session, not you" |
| M44 | **Concierge v0 — report and relay** (done, [m44-concierge.md](m44-concierge.md)): the job, the extension role, the digest wake with coalescing and the hourly cap, the heartbeat, the daily budget, tools `hub_sessions/events/read/send/notify/watch`, the status line, `?` chat, `/concierge on/off/status/log/attach`, the feed as its audit; `answer: "never"` only | with 3 real sessions (haiku) it reports a finished run, a failed one and a question within its first wakes, the question as needing the user, without answering it; relays a finding from one session to another on request; wakes and cost shown; daemon tests for the cap, the budget, the heartbeat and its own events left out |
| M45 | **Escalation and policy** (done, [m45-policy.md](m45-policy.md)): suggested answers on every question (`hub_suggest`, on the row), the banner with `Ctrl+Y` send / `Ctrl+E` edit / Esc, `/concierge answer never|routine|always` with the routine classes and the irreversible list in the prompt, the daemon's gate (`concierge-reply`), the undo (a steer or reply), `/concierge act on|off` with `hub_dispatch/stop/respawn` (the phone is out of scope) | evals: routine vs careful questions on a fixed set (`evals/policy.eval.ts`; none of the careful ones answered, each with a suggestion; the routine ones answered, the fleet one with the other session's value); `never`: nothing answered, a suggestion on each; daemon tests: the gates, the undo steer, suggestions dropping with the row |
| M46 | **Standing orders** (done, [m46-orders.md](m46-orders.md)): `hub_note`/`hub_note_done`/`hub_note_drop`, `orders.json` (the daemon's, at most 50), `/concierge orders [add \| rm]`, every digest lists them, the ones on a clock wake it when due (`why: "order"`, "Due now"; the heartbeat stays as it is), never beyond the policy | evals (`evals/orders.eval.ts`): "when A ends tell B" applied once with `#1` said; a rule told in a question kept with `every 1m` and carried out when due; an order that starts work refused without `act`, the user told; daemon tests: the store, the gates, the digest, the clock wake and its once-ness, a restart |
| M47 | **Shared task board** (Claude Code agent teams) | board ops, tools, `/tasks`, a level 1 agent claims a task; the concierge assigns and unblocks |

Each milestone: branch → PR → independent review → merge, as before; the stress run
and the evals before and after; nothing on by default until M44 ships `concierge.on`.

## Cost

Haiku with no thinking, a digest of a few events plus a fleet table of ten rows, is a
few thousand input tokens per wake (prompt-cached across wakes) and a short answer;
the M37 evals put a whole haiku case well under a cent. At the default cap of 60 wakes
an hour and a 15-minute heartbeat, a busy day is tens of cents; `dailyBudgetUsd` stops
the concierge (it says so in the status line) rather than overspend.

## Risks and open questions

- **Noise**: a concierge that interrupts is worse than none. Coalescing, the hourly cap,
  and `answer: "never"` by default; the evals grade "did it stay quiet when nothing
  mattered" as much as "did it notice".
- **Trust**: an agent answering for the user is the one new power here. Gated, logged,
  undoable, never for irreversible actions, user-level config only.
- **Model lock**: the concierge is a pi job on an Anthropic model by default, but the
  model is a setting and the tools are daemon ops; a level 1 agent could be the
  concierge.
- **Phone**: out of scope for now (decided 2026-11-05). pi-mobile shows the fleet and
  can notify already; a `notifyCommand` (ntfy, Telegram or anything else without roost
  knowing them) can come later without changing the design.
- **Open**: should the concierge also be reachable *from* sessions (a session asking
  "who else touched this file?")? It can be, through `roost_send` to its name, once
  M44 exists; decide after using it.

## Links

- Agent Deck: https://github.com/asheshgoplani/agent-deck
- Claude Code agent teams: https://code.claude.com/docs/en/agent-teams
- Claude Code cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- pi-subagents (supervisor tools, `bg_wait`, FleetView): https://github.com/nicobailon/pi-subagents
- awesome-agent-orchestrators: https://github.com/andyrewlee/awesome-agent-orchestrators
- OpenAI Symphony: https://openai.com/index/open-source-codex-orchestration-symphony/
- Paperclip: https://github.com/agencyenterprise/paperclip-ai
