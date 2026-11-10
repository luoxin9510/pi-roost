# The daemon's timed parts as modules (M67–M70)

Candidate 03 of the architecture review (2026-11-07): the daemon's schedules, watches,
concierge and standing orders become modules of their own, built by a function with their
ports, run by an injected clock, tested in process. The pattern is the Workspace module's
([workspace-module.md](workspace-module.md)).

## Why

`daemon/main.ts` (about 4050 lines) holds the four with the rest. Each keeps its state in a
file under the roost's home, runs on `Date.now()` and its own `setTimeout`/`setInterval`,
and calls the daemon's functions directly. Their tests start a real daemon, shorten the
timers by environment variables and wait real time (one concierge test up to 8 seconds);
no rule of theirs is tested in process.

## Decisions (grilled 2026-11-10)

1. **Three modules.** `lib/schedules.ts` (`createSchedules`), `lib/watches.ts`
   (`createWatches`), `lib/concierge-module.ts` (`createConcierge`, with the standing
   orders: they belong to the concierge and wake it on its own tick). `lib/schedule.ts`
   and `lib/concierge.ts` keep their pure helpers.
2. **One clock.** `Clock` moves from `lib/workspace.ts` to `lib/clock.ts`; the daemon
   passes `systemClock`; tests use `test/support/clock.ts` (`manualClock`: `advance(ms)`
   fires each timer at its own time, a repeating one as many times as it comes due).
3. **Narrow ports.** Each module declares the few things it needs of the daemon (dispatch
   a job, record an event, deliver a message, …); the daemon's one adapter object
   satisfies them.
4. **A module owns its timers.** `start()` arms them, `stop()` clears them (the daemon at
   startup and shutdown). The environment variables that shorten them in the socket tests
   stay, read by the daemon and passed as options; a module reads no environment.
5. **A Store port for the file.** `{ read(): unknown; write(v: unknown): void }`: the
   daemon's writes the file atomically under the roost's home; a test's is in memory. A
   restart in a test is a new module over the same store. Dropping a bad entry with a
   warning stays the module's.
6. **Behaviour unchanged.** Ops, events, files, refusals, words: as they are. A bug found
   on the way is noted and fixed in a pull request of its own.
7. **Order and milestones** (Q7, the recommended answer: no reply before the start): M67
   schedules, M68 watches, each one pull request (the move, its in-process tests, the
   socket tests whose rules moved); M69 the concierge and standing orders moved, M70 their
   rules in process.
8. **`noteState` stays the daemon's** (Q8, recommended): a job's state changed is the
   daemon's wiring; it calls each module (`watches.stateChanged`, the concierge's), and
   releasing a board claim stays with the daemon (the board is not in this work).
9. **Socket tests** (Q9, recommended): M66's rule. One goes only when each rule it
   asserts is asserted in process; one end-to-end test per op and per piece of the
   daemon's wiring stays; the new tests are checked by removing each guard they name and
   seeing one fail.
10. **GLOSSARY** (Q10, recommended): Schedule, Watch, Standing order, added with their
    milestone.

## Steps

- **M67**: `lib/clock.ts`; `lib/schedules.ts` behind `createSchedules`; `test/schedules.test.ts`.
- **M68**: `lib/watches.ts` behind `createWatches`; `test/watches.test.ts`.
- **M69**: `lib/concierge-module.ts` behind `createConcierge` (the standing orders in it);
  behaviour pinned by the socket tests as they are.
- **M70**: the concierge's rules in process (wake, coalesce, retry, heartbeat, budget,
  orders due); the socket tests whose rules moved go.

## M67, as done

- `lib/clock.ts`: `Clock`, `Timer`, `systemClock` (moved out of `lib/workspace.ts`).
  `test/support/clock.ts`: `manualClock` fires each timer due within an advance at its own
  time, in order (the one in `test/workspace.test.ts` fired each once, at the end).
- `lib/schedules.ts`: `createSchedules(deps)` → `{ op(name, args), start(), stop() }`.
  The five schedule ops go through `op` (the daemon's routing is one line); `start()`
  catches up and arms the tick, `stop()` clears it. Ports: `jobs` (`dispatch`,
  `stillRunning`, `shuttingDown`), `store`, `record`, `log`, `span` (telemetry), `isDir`
  (`schedule-add`'s cwd), `clock`, `tickMs`. The daemon's `stillRunning` is the old check
  over its records, roster and state files.
- The schedules are loaded when the module is made (the socket takes ops before `start()`;
  loading only reads).
- The tick is a chain of one-shot timers (a `Clock` has no interval), the next armed
  whatever the tick did (a tick that throws is logged, as `setInterval` went on).
- `test/schedules.test.ts`: 25 tests, in process. `daemon/main.ts`: 4054 → about 3890 lines.
- Of the socket tests of M39/M40, one went ("two runs asked at once start one", its rules
  in process); the rest stay as the end-to-end tests of the ops, of a run on the daemon's
  tick, of `start()` at startup, of the file over a real restart, of the daemon's
  `stillRunning` and of a scheduled run's auto-close.
- Each guard was removed in turn: 15 of 17 fail a test; the other two (a paused schedule
  skipped by the tick and by the catch-up) cannot change anything, a paused schedule's
  `nextAt` being null.
- Noted, not changed: a slot skipped because the previous run still goes is not tried
  again (the next slot is set first, on purpose); an entry loaded from the file is not
  checked for its cwd (only `schedule-add` checks).
