# M46: standing orders (what the concierge keeps in mind, and on a clock)

Status: done 2026-11-05 (after M45; the phone side stays out of scope).

The fourth piece of [the hub as a control plane](hub-control-plane.md). A standing order
is a rule in plain words the concierge keeps: "when `migration` ends, tell `api-fix`
its result", "every evening at 18:00 say what finished and what is blocked", "if a
session asks about credentials, never answer, escalate". Orders live in the daemon
(`orders.json`), are shown and edited in the hub, go into every digest, and the ones on
a clock wake the concierge when due. The concierge decides when one applies: that is
what the model is for. Orders that would start work need `act` (M45).

## Use

```text
/concierge orders                      the list: id, when (if on a clock), the order, who gave it, last applied
/concierge orders add [when] <text>    a new order of yours (a clock first, in roost's words: every 30m, daily 18:00, …)
/concierge orders rm <id>              drop one
? remember: when build ends, tell deploy its result     also an order: the concierge keeps it with hub_note
```

`/concierge orders add` keeps the order through the op directly, as the user's (`by:
"user"`; only the hub drops it), with a clock when the rule starts with one in roost's
words. A rule in plain words to the concierge (`? remember: every evening, say what is
blocked`) it keeps itself with `hub_note(text, when?)`, as its own (`by: "concierge"`),
turning "every evening" into `daily 18:00`; those it may drop (`hub_note_drop`) when
told. `when` is M39's vocabulary
(`every 30m`, `daily 18:00`, `weekdays 09:00`, `cron "…"`): the concierge turns "every
evening" into `daily 18:00`.

## How

### The store

`orders.json` in the roost home: `{ next, orders: [{ id, text, when: string | null, by:
"user" | "concierge", at, lastAt: number | null, nextAt: number | null, count }] }`
(a bare list is read too), at most 50, `text` at most 500 characters; `next` is the
next id, so an id is never reused (the concierge's `#5` stays `#5`). `concierge-order {action: "add", text, when?}` (the
concierge's connection, and the hub's), `{action: "rm", id}` (the hub's, and the
concierge's for its own), `{action: "list"}` (both). `when` is validated with
`parseWhen`; `nextAt` from M39's `nextRun`. The status carries `orders: number`.

### In every digest

`digestText` takes `orders`: after the fleet, "Standing orders:" one line each (`#3
daily 18:00 · say what finished and what is blocked`). The prompt says: apply an order
when its condition is met by what the digest shows (a session ended, a question of a
kind), once per occurrence; say which order (`#n`) in the notice; never beyond the
policy (an order cannot approve an answer the policy forbids, or start work without
`act`: then tell the user the order needs `act`).

### On a clock

`conciergeTick` also looks at orders with a `nextAt` due: a wake with `why: "order"`
and the due orders first ("Due now: #3 daily 18:00 · say what finished …"); their next
`nextAt` is set when the digest reached it (the cap and the budget hold it like any
wake; a missed one is carried by the next wake, once; a retry whose orders an earlier
wake took meanwhile is an events wake). `lastAt` and `count` change only when the
concierge says it applied one (`hub_note_done`). The heartbeat stays as it is.

### Applied

The concierge marks an order applied with `hub_note_done(id, what)` → `concierge-order
{action: "applied", id, text}`: `lastAt`, `count`, a `concierge` event `why: "order"`
(the hub's `/concierge log` shows it). A clock order's `nextAt` moves when the wake that
carried it reached the concierge (held wakes carry it later, once), so a missed one is
not lost and not repeated. `hub_note(text, when?)` keeps one (`why: "order-kept"`),
`hub_note_drop(id)` drops one of its own (`why: "order-dropped"`); the user's orders
only the hub drops.

### The hub

- `/concierge orders`: an overlay (newest first, the user's marked `yours`, the ones on
  a clock in the accent colour with their `when`, `applied ×n` and when last); `add
  [when] <rule>` and `rm <id>` the op. Bare `/concierge orders` with none says how to
  add one.
- The line: nothing new; a `need` notice an order produced reads as any.

### Evals (`evals/orders.eval.ts`)

- "when A ends, tell B": the user's order (the case's `orders`), a session `build-<t>`
  that finishes with a value, a session `deploy-<t>` told to wait for a message with it;
  checks: the order kept as the user's, one message to `deploy` with the value, once;
  `deploy` took it up; `#1` said (`applied`, or in a notice); the order still kept.
- "on a clock": a rule told in a question ("every minute, say which sessions are
  blocked"), a `waitMs` step for it to come due (the daemon's tick is 30 s); checks: the
  order kept with `every 1m`, by the concierge; `count` ≥ 1 (or an `applied` event); a
  notice naming the blocked session; nothing sent to it.
- "needs act": an order "when build ends, start deploy" with `act: false`; checks: no
  act, a `need` notice saying the order needs act.

Daemon tests (`test/comms.test.ts`): the store (add/rm/list, empty text and a bad
`when` refused, a session's connection refused, the concierge may not drop the user's,
a restart keeps them), the digest with the orders, `applied` (count, the event), the
clock wake (`why: "order"`, "Due now", `nextAt` a minute on, no second wake); the hub
(`test/agent-view.test.ts`): the overlay, `add` as the message, `rm`, the usage lines.

## Not in M46

- A deterministic subset (when X ends → reply Y) in the daemon without a model.
- Orders scoped to a project or a session tree.
