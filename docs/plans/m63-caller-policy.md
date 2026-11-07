# M63: who may do what, in one table

The first deepening from an architecture review (2026-11-07): the
daemon decided who may use an op in some 44 places (`requireHub` at 12 ops, checks inline
in `handle`, in each handler, in the task actions), with three shapes of identity
(`conn.peer`, `conn.agentSide`, `boardActor`). The worst bug of M59 (a child's first
message `/tasks merge 5` run as a person) was of this kind. Now one module answers it.

## The caller

`GLOSSARY.md`: a **Caller** is a **Person** (a connection that never said it is an agent:
the hub, the CLI), a **Session** (a job the daemon runs, or a foreground pi registered as a
peer), the **Concierge**, or an **Unregistered agent** (it said hello or reported, its
report not accepted). `callerOf(conn, isConcierge)` (`lib/callers.ts`) judges a
connection.

## The table

`POLICY: Record<PolicyKey, Policy>`: a row for every op of the protocol (`Op`), and for
`task` and `concierge-order` a row per action (`task.merge`, `concierge-order.rm`), plus the
op's own row for an action not named. A row says, for each kind of caller, `allow` or the
refusal (its code and words, as the daemon said them before); a Session's rule may differ
by form (`job`, `fg`: only a background session hands back, only a foreground one
acknowledges). An op added to the protocol without a row does not type-check.

`allow(caller, op, action)` is asked once, first, in `handle()`. The ops keep the rules
that need the daemon's state: a job that was removed (`not_found`), who holds a task
(release, done), the Concierge's policy (`task.start`: the table lets the Concierge start a
task, the op checks `act`). `conciergeAct` calls `handle` as the Person, as before.

Not changed here: the Person is trusted by the socket (a connection that never identifies;
hardening the socket is its own step); the codes and words of every refusal; the filter
on a spawned session's first message (`firstMessage`), a guard of another kind.

## What changed for a caller

Who may comes first: a caller refused by its kind is refused before the op reads its
arguments, the task or the job. Before, many looked first: the Concierge asking to merge a
task with no workspace heard "no workspace" (and would have been refused after), now that
merging is a person's; the hub claiming, or a session dropping, assigning or starting, a
task that does not exist or is not on its board heard "no such task", now that it may not;
a job that was removed, asking a concierge op or acknowledging, heard `not_found`, now
that the op is not its. The codes and words of each refusal are the old ones; only which
one comes first changed. Nothing that was allowed is refused, nothing refused is allowed.

## Tests

- `test/callers-matrix.test.ts`: a real daemon, and its answer to every op and task action
  for a Person, a foreground and a background Session, the Concierge and an Unregistered
  agent, as a snapshot. Taken before the change; after it, the only differences were the
  Concierge's nine workspace actions above.
- `test/callers.test.ts`: `callerOf`, the rows (every action, an unknown one, a name from
  the object prototype), the Person's ops, a peer's, the forms of a session, the workspace
  and the board, every refusal well formed.
- `test/comms.test.ts`: the hub claiming a task that does not exist (above).
