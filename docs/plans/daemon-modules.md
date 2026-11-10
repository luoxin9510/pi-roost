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
- The tick is a chain of one-shot timers (a `Clock` has no interval). The next is armed
  before the tick runs, so the period stays fixed, as `setInterval`'s; a tick that throws
  goes on to the next, as before, and is now logged (`schedule tick failed`) where it was
  an uncaught exception.
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

## M68, as done

- `lib/watches.ts`: `createWatches<P>(deps)` → `{ load(), add(peer, args), stateChanged(row), removed(id, name), watcherGone(key), sweep() }`. The daemon's call sites are one line each: `watches.add(requirePeer(conn), args)`, `void watches.stateChanged(job)` in `noteState` (which stays the daemon's, with the suggestion drop and the claim release), `await watches.removed(id, name)` before the record goes, `watches.watcherGone(file)` after it (when nothing holds the session), `watches.load()` at startup, `watches.sweep()` in the reaper.
- Ports: `sessions` (what the daemon knows of the asking peer `P`: `refusesItems`, `keyOf`, `name`, `jobId`, `find`; the order of the op's refusals is the module's), `jobs` (`exists`, `row`, `relation(watcherKey, jobId)`, `deliver` → `{ outcome, reached }`), `store`, `record`, `log`, `clock`, and the options `ttlMs` (the daemon reads `PI_ROOST_WATCH_TTL_MS`) and `maxPerWatcher`.
- The sweep stays on the daemon's shared reaper (`PI_ROOST_REAP_CHECK_MS`), not a timer of the module: nothing in the module arms a timer, so there is no `start()`/`stop()`. Expiry uses `clock.now()`.
- `load()` is called by the daemon once the jobs are loaded (the file is filtered by the jobs that exist), not by `createWatches`.
- The `working` guard in `noteState` moved into the module (`watchFires` is false for it anyway).
- `test/watches.test.ts`: 49 tests, in process. `daemon/main.ts`: 3886 → about 3806 lines.
- No socket test went: the three watch tests of M43 each stay as the end-to-end test of a piece of wiring (the op and `noteState` → watches; a removed watched job's notice; startup load and the reaper's sweep over a real restart).
- After review (M68): nothing tested the daemon's call that drops a removed watcher's watches (`watcherGone`, on main too); a socket test now does (a removed watcher's watches go, another session's of the same job stays), and fails with the call taken out.
- Each guard was removed in turn: 44 of 46 fail a test; the other two (the file's `id` and `at` being a string and a number) cannot change anything, a bad id or `at` never matching a job or a time.


## M69, as done

- `lib/concierge-module.ts`: `createConcierge<C>(deps)` (`C`: the daemon's connection type) → `{ load(), start(), stop(), op(name, conn, args), nudge(), status(), isConcierge(id), isPeer(peer), own(e), safeName(id, name), launch(args), mayAct(), suggestionField(id, st), dropSuggestion(id), removed(id) }`. The eight ops (`concierge`, `-ask`, `-say`, `-policy`, `-suggest`, `-reply`, `-act`, `-order`) go through `op`; the daemon's routing is one `case` group. The standing orders are inside it (`concierge.json` and `orders.json`, same formats, two Stores).
- Ports: `sessions` (`require(conn)`, `optional(conn)`, `asHub(conn, what, id)`: `concierge-act` stop/respawn runs as the hub's op), `jobs` (`exists`, `live`, `row`, `list`, `stateOf`, `launchOf`, `sessionFileUsed`, `pathExists`, `dispatch`, `respawn`, `terminate`, `reply`, `deliver` → `{ outcome, reached }`, `pushJob`), `events` (`since`, `cursor`), `store`, `ordersStore`, `record`, `push`, `log`, `config()`, `board()`, `shuttingDown()`, `clock`; options `coalesceMs`, `retryMs`, `tickMs`, `heartbeatMs` (the daemon reads the `PI_ROOST_CONCIERGE_*_MS` variables).
- Daemon call sites, one line each: `record()` (`if (!concierge.own(e)) concierge.nudge()`), `handle()` (`concierge.op(op, conn, args)`; `callerOf(conn, id => concierge.isConcierge(id))`), `concierge.load()` at startup (after the jobs), `concierge.start()` / `stop()` (where the ticker and first nudge were; shutdown), `noteState` and `reply` (`dropSuggestion`), `rowOf` (`...concierge.suggestionField(id, st)`), `removeRecord` (`concierge.removed(id)`), the Workspace deps (`mayAct`, `launch`), the name guards (`safeName`, `isConcierge`), the board's who (`isPeer`).
- Pure helpers `conciergeText`, `oneLineText` and `firstMessage` (also the spawn guard's) moved to `lib/concierge.ts`.
- Init order: the module is made right after `record` in `daemon/main.ts`, before anything can call it; its adapters read `recs`, `roster`, `tasks`, `shuttingDown` and the functions lazily (inside arrows), and it reads nothing when made (`load()` is the daemon's, once the jobs are known).
- Timers: the coalesce and retry waits share one one-shot slot, as `conciergeTimer` did; the 30 s heartbeat is a chain of one-shot timers, the next armed before the tick runs. A tick that throws is now logged (`concierge tick failed`) where it was an uncaught exception. Every timer is the clock's (unref'd in `systemClock`); `stop()` clears them all (it cleared the ticker and the wake slot before as well).
- `test/concierge-module.test.ts`: 8 smoke tests. No socket test went or changed.


## M70, as done

- `test/concierge-module.test.ts`: 98 tests (8 smoke tests of M69 kept), in process through `createConcierge`'s interface with fake ports, in-memory stores and the manual clock (no real wait, stable over repeated runs). Groups: on and off (first `on` dispatches, a later one respawns, two at once share one start, off terminates only a live job, status fields, restart over the same files, defensive loading of the state file); wakes (coalescing, a nudge during a wake, the digest and the cursor, own events, a failed delivery and the shared coalesce/retry slot, the hourly cap, the daily budget, off or replaced while a wake is under way); the heartbeat and the 30 s tick (heartbeat from the setting or the override, orders due, the chain keeps its period, a tick that throws, `stop()` leaves no timer); `say`/`ask`/policy/`suggest`/`reply`/`undo`/`act` (who may, refusal order, codes and messages, the events with their `why`, suggestions kept, expired and dropped); the builder of the launch of a session the concierge starts; standing orders (add/list/rm/applied, `by`, limits, load formats, ids never reused); `safeName`, `own`, `mayAct`. Assertions are on what the fakes received.
- Socket tests: `test/comms.test.ts` 62 → 60, the M44 block 12 → 10 (41 s → 36 s). Gone: *on after off* (backlog skipped, first wake is the fleet, `on` while running; all in process: respawn, cursor, fleet row in the digest, no second wake) and *an order on a clock wakes it when due* (it waited up to 8 s; the tick, the Due now digest, once, the next time, the bare-list file: all in process). Kept, each the last end-to-end test of some wiring: *on/off* (dispatch with a role, startup load, `rm` → `removed`), *woken with a digest* (record → nudge, `own`, the feed for the concierge only), *says/asks*, *heartbeat* (the `PI_ROOST_CONCIERGE_HEARTBEAT_MS` variable), *the hub's alone* (`callerOf`, the name guards), *cap and budget* (the `concierge` setting and a usage report reach the module), *suggest* (`noteState` → `dropSuggestion`, `rowOf`'s `suggested`), *answers and undo*, *act*, *orders* (the op through `handle()`, `orders.json` over a restart); M57's and M59's concierge tests are the workspace module's `mayAct`/`launch` and the spawn guard.
- Mutation check on `lib/concierge-module.ts` (each guard or condition taken out or inverted in turn, `lib/` restored byte for byte after): 400 mutations, 380 caught, 20 not and all explained: a state the callers cannot reach (`on` implies an id; a primitive file body has no fields; a clock order always has a `when`), two guards that cover each other (the `nudged` reset in `off` and the `on` check in `wake`), a `catch` that cannot run (a `when` is parsed on the way in), a no-op mutation, and a `Array.isArray` before a length that a string fails anyway. The first run caught 331; the 49 it missed got tests (load of a half-written state or order file, boundaries of the hour, the retry slot, an `on` in the same instant as a wake, the board in the digest, long texts clipped in the feed).
- Nothing in `lib/` or `daemon/` changed.
