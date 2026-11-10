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
