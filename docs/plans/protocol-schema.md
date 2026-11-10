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
2. **typebox**, made a pinned dependency (the daemon and the standalone hub run without pi).
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
