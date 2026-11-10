# One schema per op (M75–M77)

Candidate 05 of the architecture review (2026-11-07). The protocol's 38 ops are TypeScript
types only (`OpArgs`/`OpResults` in `lib/protocol.ts`); their arguments are checked by hand
in each handler (about 120 `bad_request` throws, each in its own style), described again in
`docs/protocol.md`, the TS and Python agent SDKs and the pi tools' typebox parameters, with
nothing checking one against another. Drift is already there: the doc does not name `ping`,
`list`, `resolve`, `peer_ack` or the four schedule ops, and its example capabilities (6) are
not the daemon's (10).

## Decisions (grilled 2026-11-10, every answer the recommended one)

1. **Scope**: one schema per op is the source of its runtime check, its TS type and its row
   in the doc's op reference. No SDK code generation.
2. **Our own schema module** (`lib/schema.ts`, no dependencies). (changed 2026-11-10: typebox was first chosen as a pinned dependency; pi's docs forbid host-provided packages in `dependencies` and the installed package has no typebox, so the daemon, a separate node process importing `lib/protocol.ts`, would crash. typebox stays a peer and dev dependency for `adapters/pi` only.)
3. **One source**: `lib/protocol-schema.ts`; `OpArgs`, `OpResults`, `ArgsOf`, `ResultOf`
   derived from it (`Static`), the hand-written types removed.
4. **Behaviour unchanged**: the schemas check shape (types, required, lengths) at `handle()`'s
   entry; checks that need state (a path that exists, who holds a task) stay in the
   handlers. Codes and messages as they are; unknown fields ignored; a bad value the daemon
   dropped silently is still dropped. A message style and rejecting what is dropped today
   are protocol changes: a later candidate.
5. **The doc**: the op reference of `docs/protocol.md` generated from the schemas (fields,
   types, limits, who may call, from `lib/callers.ts`), the prose by hand;
   `npm run docs:protocol`, and a test that fails when the doc is stale.
6. **SDKs and tools**: the Python SDK is not generated; a test checks its `PROTOCOL_VERSION`
   and the ops it calls against the schemas. A pi tool whose field is a protocol field
   (`roost_send`'s `to`, `message`) uses the protocol's field schema and limit.
7. **Capabilities**: `DAEMON_CAPABILITIES` moves into the protocol, typed, and into the doc.
8. **Milestones**: M75 the schemas, derived types, capabilities, doc generation and its
   test, the Python check (no check changes; behaviour unchanged); M76 the entry check for
   the simple ops (reads, jobs, peers/send/watch, schedule-*, events, concierge-*), their
   duplicated shape checks gone; M77 `dispatch`, `spawn`, `task`, and the pi tools on the
   protocol's field schemas.
9. **Messages**: each field schema carries the message its hand check said; a field with no
   check today is loose (optional; a bad value dropped as before). Each op moved: its
   `bad_request` tests pass unchanged, and removing a guard fails one.
10. **`task`**: a union on `action`; `TASK_ACTIONS` and `ORDER_ACTIONS` derived from it.
11. **Results**: schemas for types and the doc; not checked at run time.
12. **GLOSSARY**: Op, Capability (M75).
13. Started at once; each milestone branch → pull request → independent review → merge.

## M75, as done

- `lib/schema.ts` (166 lines, no dependencies): `obj`, `optional`, `str({min,max,pattern})`, `num({int,min,max})`, `bool`, `nul`, `nullable`, `literal`, `oneOf` (string enum), `union` (plain or discriminated), `arr({min,max})`, `rec`, `opaque<T>(title, description)`, `unknown`, `Infer<S>` and `check(schema, value)` (first failure's path and message; a schema's `message` is the hand check's exact text, for M76). A schema is a plain JSON-Schema-shaped object, so the doc generator reads it and pi's tools can pass it to typebox's `Type.Unsafe` in the adapters. `check` is tested (`test/schema.test.ts`, mutation-checked: 48 of 48 caught) but not used by the daemon yet.
- `lib/protocol-schema.ts` (about 420 lines): a schema per op's arguments (`ArgSchemas`) and result (`ResultSchemas`), 39 ops (the text above says 38). `task` (21 actions), `concierge` (6), `concierge-order` (4) are unions on `action`; `concierge-act` on `what`; `DispatchArgs` is one schema used by `dispatch`, `spawn`, `schedule-add`, `concierge on`, `concierge-act dispatch` and `task start`. Types come from `Infer<>`: `OpArgs`, `OpResults`, `JobRow`, `PeerRow`, `SendResult`, `HandbackArgs`, `WorkerReport`, `DispatchArgs`, `DaemonStatus`, `Hello*`, `ScheduleRow`, `ContextInfo` and the small enums; `lib/protocol.ts` re-exports them and no hand-written copy is left. `tsc` was clean with no change outside imports.
- Types owned by other modules (`BoardTask`, `RoostEvent`, `ConciergeStatus`, `StandingOrder`, `UsageInfo`, `PrInfo`) are `opaque<T>` schemas named in the doc, not field by field. Not exact: `concierge-policy`'s args are `{}` (were `Record<string, never>`). Limits (`MESSAGE_MAX`, `TASK_TITLE_MAX`, `TASK_TEXT_MAX`, `TASK_NOTE_MAX`, `ORDER_TEXT_MAX`, `requestId` 1-64) are imported constants, documentation only until M76; some are cut by the daemon, not refused.
- `TASK_ACTIONS`, `ORDER_ACTIONS` derive from the unions (the schema's order); `lib/callers.ts` re-exports them. `DAEMON_CAPABILITIES` is in `lib/protocol.ts` (`as const`, same values and order).
- `scripts/protocol-doc.ts` (`npm run docs:protocol`) writes the "Op reference" between markers in `docs/protocol.md`: capabilities, shared shapes, each op with its callers (from `POLICY`), args and result. `test/protocol-doc.test.ts` fails when stale, checks the Python SDK, and asserts no file under `lib/`, `daemon/`, `hub/`, `host/` imports typebox.

### After review (M75)

- `TASK_ACTIONS` and `ORDER_ACTIONS` came out in the schemas' order, which changed the words
  of the daemon's `action must be one of …`: the unions are in the old order again, and a
  test pins both lists.
- `concierge-policy` took `{}` (any fields, to the types) where it was `Record<string, never>`:
  `empty()` in `lib/schema.ts` keeps it exact. Every other derived type was compared with the
  old one for strict equality (all 39 ops' args and results, the shared shapes): equal.
- The doc now says the limits the daemon applies that the schemas lacked: a task id and
  hello's `protocol` at least 1, `requestId`'s form (`^[A-Za-z0-9_.:-]{1,64}$`; one not of
  this form is ignored, not refused).
- The import-graph test catches every form (static, dynamic, re-export, `require`), and no
  pi package in lib, daemon or host either.
- **For M76** (the schemas become the entry check), each to match the daemon as it is:
  - a union whose discriminant is unknown must answer the daemon's words
    (`action must be one of …`), and a member must be picked by its discriminant only (not
    by any literal field: `{action: "bogus", mode: "ff"}` matched `merge`);
  - text the daemon trims and refuses when empty (`reply.text`, `send.message`, `send.to`)
    needs a check of its own;
  - `requestId` not of its form is dropped, not refused (the pattern is for the doc);
  - looser in the daemon than in the schemas: `events.after`/`limit` (any finite number,
    the schema says integer), `hello.capabilities` (non-strings filtered out, the schema says
    strings): the schemas follow the daemon.

## M76, as done

- `lib/schema.ts`: `loose(s)` (same type and doc; `check` passes anything, a missing required
  field too; `looseOf` keeps the shape's name for the doc), `str({ trim })` (limits on the
  trimmed value), `str({ maxBy: "cut" | "op" })` (a maximum the daemon cuts, or refuses with its
  own code: not refused by `check`, said in the doc), `union(…, { discriminant })` (picked by
  that field alone; another value fails with the union's message, `discriminantValues`).
- `lib/protocol-schema.ts`: `ENTRY_CHECKED` (every op but `dispatch`, `spawn`, `task`) and
  `argsProblem(op, args)`; arguments that are not an object count as `{}`. Each field is loose
  or carries its hand check's words (`need`: a non-empty string; `filled`: something once
  trimmed). The daemon calls it after the callers table and before the op, so a refused caller
  is answered as before. `hello` and `report` mark the connection as an agent's before the
  check (they did before their own checks).
- Loose, and why: what the daemon drops or reads loosely (`list`, `pin.pinned`, `respawn`,
  `shutdown`, `peer_ack`, `hello.agent`/`capabilities`, `peer_register` but `pid`); what is
  checked against state first, in other codes or not at all (`report` and `ack`: `id` and
  `token` first, and a report for a job that ended is taken whatever it says, so the report's
  state and status stay in the op; `ack.seq` after them; `schedule-*` names: `not_found`;
  `concierge-order`, whose action other than add and list is looked up by its id first, and
  whose ids take `"3"`); what is parsed with its own words (a schedule's
  `when` and `launch`, an order's `when`); `handback` (a session that is not a child is answered
  `routed: false` before its state is read); `concierge-act` and `concierge-reply` (the policy
  is checked first: `policy`); `DispatchArgs` wherever it is used (M77).
- The daemon's own checks removed: `reorder.key`, `events` (`after`, `limit`, `id`), `hello`'s
  protocol, `rename`'s empty name, `send`'s `to` and empty
  message, `peer_register`'s pid type. Kept: what needs state (`reorder` ids it knows, a live
  pid, `too_long` on the trimmed message), helpers other paths call (`requireJob`, `reply()`
  for the concierge's answers), and the modules' checks (watches, schedules, the concierge:
  their in-process tests call them directly; the entry check says the same words first).
- Not quite as before: a request with two faults may be answered for the other one (`watch`
  with bad arguments from an agent that takes no notices: `bad_request`, was `unsupported`);
  `concierge answer`
  with `["never"]` (a one-item array) is refused (`String()` took it).
- The M75 notes: the discriminant rule is in `check`; trimmed text is `filled`; `requestId` is
  refused (`reply` and `dispatch` refuse a malformed one; the M75 note that it is dropped was
  wrong, the doc is corrected); `events.after`/`limit` and `hello.capabilities` follow the daemon.
- Tests: `test/entry-check.test.ts` (every checked field is worded or loose; 49 refusals in the
  daemon's words; 38 arguments the daemon took, still taken), `test/schema.test.ts` (the new
  builders), `test/daemon.test.ts` (each removed check's words over the socket). The callers
  matrix (M63) is unchanged. Mutation: the daemon's call removed fails the socket test; each
  schema's words changed fails a unit test (the loose ones' words are the doc's only).

### After review (M76)

- A report for a job that ended (or is being stopped) is taken whatever it says: the check of
  its state and status came after that, and refused it at the entry. `report.report` is loose
  and the check is back in the op (after the report binds the connection, as before); a socket
  test sends a bad report to a live job and to a stopped one.
- `concierge-order` with a missing or unknown action answered `not_found` (its id is looked up
  first), not the union's words: the op is loose at the entry; the module keeps its checks.
- The refusal table's words were the schemas', not checked against the old code in two cases
  (the two above); each row was compared again with the handler on main.

## M77, as done

- Every op is checked at the entry (`ENTRY_CHECKED` is `OPS`). An op given arguments that are
  not an object (or none) is answered in its schema's words when it has some and is not loose
  (`dispatch`: `missing args`); an array is read as no fields, as before.
- `dispatch`: `relax(DispatchArgsSchema, { requestId })` with the words `missing args`: only the
  id's form is checked, since a resend with the same id returns the first job before anything
  else is read (a field checked here would turn that answer into a refusal); `cwd`'s words name
  the value, and the rest is `dispatch()`'s, which schedules, the concierge, `task start` and
  `spawn` call without the socket. Its checks stay.
- `spawn`: `shallow(DispatchArgsSchema, { message: "launch required" })` (an object; an array
  passed `typeof`, so it passes); its other checks need the session (a pi launch, a new session
  file). The op's own check is gone.
- `task`: a discriminated union (`action must be one of …`, `TASK_ACTIONS` in the union's order);
  each member `relax`ed (its fields loose, its literal kept); `add` keeps its title (`a task
  needs a title`, trimmed, cut at the maximum) and `after` (`after must be a list of task ids`;
  its ids are looked up in the op). Loose and why: ids (`"3"` is taken; `not_found` first), a
  lead's `project` (a session's is ignored; checked in the op), what the workspace module reads
  (`start`'s launch, `merge`'s mode, comments: its tests call it directly). The op's own action,
  title and list checks are gone.
- pi tools (decision 6): `roost_send` `to`/`message`, `roost_watch` `to`, `roost_task_add`
  `title`/`detail` are `Type.Unsafe(jsonSchemaOf(field))` with the tool's description.
  `jsonSchemaOf` drops `message` and the `x-` marks, and a maximum the daemon cuts. So a message
  past `MESSAGE_MAX` (untrimmed) is refused by pi's validator before it is sent (it was the
  daemon's `too_long`), and an empty `to`, `message` or `title` too; a long title is still cut.
- Tests: `test/entry-check.test.ts` (M77's refusals and what is still taken, each compared with
  the handler on main), `test/schema.test.ts` (`shallow`, `relax`, `jsonSchemaOf`),
  `test/daemon.test.ts` (dispatch, spawn and task words over the socket; mutation: the
  daemon's call removed fails it), `test/tool-fields.test.ts` (the tools against pi's own
  validator). The callers matrix (M63) is unchanged.

