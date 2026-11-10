# The hub's overlays as modules, and one daemon port (M71–M74)

Candidate 04 of the architecture review (2026-11-07): `hub/agent-view.ts` (about 4450
lines; `AgentView` about 4000) holds every screen of the hub. Each overlay (workspaces,
review, the task board, the concierge and its orders, schedules, the log and usage,
compare) is built inside the class, reaches into its fields, and talks to the daemon by
op names written inline (60 `request(...)` calls). Its tests build the whole view around a
fake client that answers each op by its name.

## Decisions (grilled 2026-11-10, every answer the recommended one)

1. **An overlay is a module.** Each goes to `hub/overlays/<name>.ts`, built by
   `createXOverlay(host)` returning the existing `Overlay { render, handleInput?, dispose? }`.
   `AgentView` keeps the core: the list, selection, the input, dispatch and peek (peek is
   tied to the input and the main keys; not moved now).
2. **One daemon port.** `hub/roost-port.ts`: `RoostPort`, typed methods grouped by area
   (`tasks.list()`, `tasks.merge(id)`, `concierge.on()`, `schedules.add(...)`,
   `events.since(...)`, …) over `DaemonClient`; tests use an in-memory one. An overlay gets
   its own slice only.
3. **An overlay's host.** `OverlayHost`: its port slice, the theme, `say`, `close`,
   `requestRender`, `attachTo(id)`, `rows()` read only. An overlay no longer holds the view.
4. **Tests per overlay**, with a fake port and a fake host (render text and keys);
   `test/agent-view.test.ts` keeps one end-to-end test per overlay (opened by its key or
   command, wired right). A test there goes only when each of its rules is asserted in the
   overlay's own tests (M66's rule).
5. **Behaviour unchanged.** Before an overlay moves, its renders are pinned (snapshots of
   `render()` in its states); after, they match to the character.
6. **Not now**: `handleInput`'s switch and the mode flags as a state machine; the 45
   options of `AgentViewOptions`. Later candidates if they hurt.
7. **Milestones**: M71 the port and the host (every inline request through `RoostPort`, the
   fake client replaced by an in-memory port; no overlay moved); M72 workspaces and review;
   M73 the task board, the concierge and its orders, schedules; M74 the log and usage,
   compare. Each overlay: pinned, moved, tested on its own, the duplicated tests gone, in
   one pull request.
8. **The port whole first** (M71): later moves are moving code only.
9. **Pushed events**: `AgentView` keeps the one subscription and passes each event to the
   open overlay (`Overlay.onEvent?(e)`, optional); hooks such as `wsReload` go.
10. **Local reads stay out of the port**: `taskDiff`, `taskChanges`, `worktreeChange`,
    `hostControl` read git or this machine, not the daemon; the host hands them to the
    overlay that needs them. The options stay as they are.
11. **GLOSSARY**: Hub, Overlay (M71).
12. Started at once; each milestone branch → pull request → independent review → merge.

## Steps

- **M71**: `hub/roost-port.ts` (`RoostPort`, its `DaemonClient` adapter, an in-memory one
  for tests); every `request(` in `hub/agent-view.ts` through it; `OverlayHost` defined;
  GLOSSARY.
- **M72**: `hub/overlays/workspaces.ts`, `hub/overlays/review.ts`.
- **M73**: `hub/overlays/tasks.ts`, `hub/overlays/concierge.ts` (with the orders),
  `hub/overlays/schedules.ts`.
- **M74**: `hub/overlays/log.ts` (log and usage), `hub/overlays/compare.ts`.

## M71, as done

- `hub/roost-port.ts`: `RoostPort` and `roostPort(client, via?)`, the adapter over `DaemonClient`; 49 methods, each one request returning the result as it came (nothing reshaped). `subscribe(onEvent)` (listens, then asks, as `connect()` did), `listen(onEvent)` → off, `position()`; `jobs` (list, listAt, stop, rm, pin, rename, reorder, respawn, reply, dispatch); `tasks` (list, add, assign, done, drop, release, prepare, start, merge, back, abort, commit, approve, verify, pass, comment, uncomment, shelve, cleanup, pr: 20, the ones with several optional fields take their body); `concierge` (status, on, off, answer, act, undo, ask, and `orders`: list, add, rm); `schedules` (list, add, rm, pause, run); `events.list`.
- Request ids: `jobs.reply` and `jobs.dispatch` are `requestOnce(via, op, args, opts)`; the view builds its port with `via = (d) => this.live(d)`, so a resend after a restart goes on the connection the view has by then, with the same id, as before. Other ports (tests, a bare `roostPort(client)`) use `via` = that client.
- `hub/agent-view.ts`: all 69 inline `request(`/`requestOnce(`/`requestAt(` calls go through the port (`grep "\.request(\|requestOnce(" hub/agent-view.ts` finds none). `private get port()` is the port of `this.client` (one per client, kept in a WeakMap so a closure that holds it keeps its connection, as the captured `client` did); `openWorkspaces` and `reviewOverlay` take the port. Not moved, because they are the connection and not calls: `DaemonClient.connectOrStart`, `onClose`, `close`, `isClosed`, and `ensureLive(this.client, …)` (`lib/resume.ts`, takes a client). Ops, arguments, order and error handling are unchanged.
- `hub/overlay-host.ts`: `OverlayHost { port, theme, say, close, requestRender, attachTo, rows, taskDiff?, taskChanges?, worktreeChange?, hostControl? }`, in its own file: the port is the daemon's, the host is the view's. `AgentView.overlayHost(port)` builds one; no overlay uses it yet. `port` is the whole `RoostPort` (a slice per overlay comes with its move); `rows()` is the view's `ReadonlyMap<string, JobRow>`; `port` is the connection the overlay is opened on (passed in; no overlay opens without one), as the closures held theirs.
- `Overlay.onEvent?(e)`: called from `AgentView.onEvent` for each pushed event the view takes in, after it did (a job event the view's `cwdFilter` drops is not passed on; a throw is swallowed). `wsReload` stays; M72 moves it onto `onEvent`.
- Tests: `test/agent-view.test.ts` (83) and the other hub tests pass unchanged: `FakeClient` fakes `DaemonClient`, which the adapter wraps. New: `test/roost-port.test.ts` (54: every method's op, args and result, subscribe order, request ids, a lost reply resent with the same id on `via`'s client, a refusal not resent) and `test/support/roost-port.ts` (`fakePort(answers)`: an in-memory `RoostPort` recording calls by path), for the overlay tests of M72–M74.

### After review (M71)

- `reply` and `dispatch` were sent through `this.port`, which is `undefined` while the view
  makes its connection again: a send after an await (the marked rows' replies, a fan-out's
  dispatches) threw instead of waiting (M51). They now go through `sends(via)` (in
  `hub/roost-port.ts`), which holds no connection: each try takes the live one, as
  `requestOnce` did before. A test loses the connection between two marked replies; the
  second waits and goes (it fails with the port's call).

## M72, as done

- `hub/overlays/workspaces.ts` (`createWorkspacesOverlay(host, opts)`) and `hub/overlays/review.ts` (`createReviewOverlay(host, opts)`), moved out of `AgentView` (`openWorkspaces` ~300 lines, `reviewOverlay` ~240); `hub/agent-view.ts` 4494 → 3949 lines. Each returns `Promise<Overlay | undefined>`: the first load (the board; the task and its diff) happens inside, and `undefined` means it failed and the host has been told (for review `opts.onClose` is also called, as before). The view's opening is a few lines: build `this.overlayHost(port)`, create, set `this.overlay`, request a render. The re-entry guards (`wsOpening`, `reviewOpening`) stay in the view.
- Interfaces. Workspaces: port slice `WorkspacesPort = { tasks: Pick<…, "list" | "pr" | "approve"> }`; host `Pick<OverlayHost<WorkspacesPort>, port | theme | say | close | requestRender | attachTo | rows | current | notice | termRows | taskChanges>`; opts `{ here, next, focus?, tasksCommand(line), openReview(id) }`. Review: `ReviewPort = { tasks: Pick<…, "list" | "comment" | "uncomment"> }`; host `port | theme | say | close | requestRender | current | notice | termRows | taskDiff`; opts `{ id, tasksCommand(line), onClose? }`. Neither imports the view.
- `OverlayHost<P = RoostPort>` is generic in the port slice, and gained `current()` (the overlay the view shows: an overlay replaced without closing is not it, which `view.overlay !== self` checked), `notice()` (the notice row, which both draw above their keys) and `termRows()`. `Overlay` moved to `hub/overlay-host.ts` (re-exported by the view). Shared text helpers (`oneLine`, `wrap`, `CONTROL`) went to `hub/text.ts`, `rowName` to `lib/view-model.ts`.
- `tasksCommand(line)` is the view's `/tasks` command (`merge 4`, `back 4 note`, `start 9`, `shelve 3`, …): both overlays act through it, as they did, so it says what came of it and `/tasks start` (prepare → launch → start) stays one code path. M73 (the task board) is where it can move behind a port.
- `wsReload` is gone: the workspaces overlay's `onEvent(e)` reloads on a `board` event; the view's `onEvent` already hands each event to the open overlay. Following stops when the overlay is disposed or `host.current()` is not it. (Before: the hook was cleared by `dispose`/`reload`; now the view only calls the overlay it shows.)
- Pinned first, on the old code: 5 tests, 19 `toMatchSnapshot` renders of the whole view with the overlay open (`test/__snapshots__/agent-view.test.ts.snap`): the pipeline at 120 columns (with a task selected by `n`), 80/100 columns and the last task selected, the approve and pull-request confirms, the back note, empty, nothing needs you; the review's diff, next hunk, next file, a narrow render, the comment input, a comment under its line, outdated ones, the send-back input, the page of files no longer in the diff. They pass unchanged after the move.
- Own tests: `test/workspaces-overlay.test.ts` (60) and `test/review-overlay.test.ts` (61), on `fakePort`, a fake host (`test/support/overlay-host.ts`) and a fake diff; mutation-checked (below).
- `test/agent-view.test.ts` 84 → 84: five tests gone (the approve-on-y one, the width one, the under-100 one, and the two "after review" ones), whose rules are asserted in the overlay tests; the rest trimmed to the wiring (`/workspaces`, `Ctrl+N`, Enter to review and Esc back, `/tasks review`, a comment and a merge reaching the daemon) or kept (`/tasks shelve|cleanup|pr`, which are the view's).
- Mutation check of the two files (each guard taken out or inverted in turn, the overlay's test file run): `workspaces.ts` 126 of 130 caught, `review.ts` 133 of 143. Not caught, all equivalent: the `|| busy` in the workspaces confirm key (the busy flag is always clear when a confirm exists), `x.owner` beside `s?.running` (a session implies an owner), the `sel` fallback after `nextNeedsYou` (undefined at that point), `sel === undefined` in the next-note condition; in review: the file-index clamp in `load` and the one in `render` (each makes the other redundant), the file check in `placed` (`commentOn` checks it), the `[\x80-\x9f]` replace (`CONTROL` has it), `!f?.path` and the line-row check on sending a comment (unreachable with a box open), `n`/`p`'s default hunk and last-row cases (`moveLine` clamps), and the `ri`/`top` resets on a file change (the next render sets both).

### After review (M72)

- No drift found (each key and each lifecycle check compared with the old closures).
- Nothing tested the view passing a pushed `board` event to the open overlay (the wiring
  that replaced `wsReload`); an agent-view test now does (a board event reloads the open
  workspaces overlay, a job event does not), and fails with the call taken out.
- Left as it was: the confirm's `|| busy` guard cannot be reached (a confirm is only set
  once the action is done), as before the move; the opening guards (`wsOpening`,
  `reviewOpening`) are not tested, on main either.

## M73, as done

- `hub/overlays/tasks.ts` (`createTasksOverlay(host, { tasks, scope })`, `createLinesOverlay(host, { title, lines })`: the board of `/tasks` and the lines of `/tasks cleanup`), `hub/overlays/concierge.ts` (`createOrdersOverlay(host)`, `createAnswerOverlay(host, { answer })`) and `hub/overlays/schedules.ts` (`createSchedulesOverlay(host)`), moved out of `AgentView`; `hub/agent-view.ts` 3949 → 3829 lines. The view's opening is two or three lines each (host, create, set `overlay`, request a render). `tasksCommand`, `startTask`, `scheduleCommand`, `conciergeCommand`, `ask` and the `pendingAnswer` deferral (set in `onEvent`, opened by `closeOverlay`) stay the view's.
- Interfaces. The board, lines and answer overlays are read only and ask the daemon nothing (`/tasks` hands the tasks in): host `Pick<OverlayHost<never>, theme | close | requestRender | termRows>`, no port. Orders: port slice `{ concierge: { orders: Pick<…, "list"> } }`, host adds `port | say`; schedules: `{ schedules: Pick<…, "list"> }`, host adds `port | say`. Both fetch their list inside, `say` the empty-state line and return `undefined` when there is nothing, and throw when the load fails (the view's command, already in a `try`, says it). Same shape as M72's: `Promise<Overlay | undefined>`.
- No new host member. `AgentView.overlayHost(port)` is now `{ port, ...hostBase() }`; `hostBase()` (the host without a port) serves the overlays that need none, so the answer, which arrives in `onEvent` where a connection may be mid-restart, needs no port to open.
- Pinned first, on the old code: `test/agent-view.test.ts` "M73: overlay renders, pinned", 6 tests, 19 `toMatchSnapshot` renders (Date frozen): the board (open, blocked, claimed, a workspace, done, 33 done with the "more done" line scrolled to, the project names of several projects, only done, empty), the cleanup lines (dry, done), the orders (3 orders at 100 and 50 columns, none), the answer (short, 40 lines wrapped at 60 columns, scrolled, tabs/escapes/bell cleaned), the schedules (several, paused, never, a skip, a task of two lines, at 100 and 50 columns, none). They pass unchanged after the move (the snapshot file is byte-identical).
- Own tests: `test/tasks-overlay.test.ts` (19, board and lines), `test/concierge-overlay.test.ts` (21, orders and answer), `test/schedules-overlay.test.ts` (14), on `fakePort`, `fakeHost` and `test/support/overlay-keys.ts` (the raw keys, a theme that writes colours into the text, the "which keys close it" check).
- `test/agent-view.test.ts`: no test removed, 85 → 93 (6 pinned, 2 wiring: `/schedule list` opening and closing, and the answer arriving behind the board and opening on Esc; nothing tested the deferral before). Trimmed to the wiring: the M46 orders test (order, marks and keys now in the overlay test) and the M47 board test (groups, detail, footer). `/tasks cleanup` keeps its wiring test.
- Mutation check (each guard taken out or inverted in turn, the overlay's own test file run): `tasks.ts` 112 of 114, `concierge.ts` 71 of 73, `schedules.ts` 64 of 66. Not caught, all equivalent: `return undefined;` as `return;` (concierge, schedules); `orderLine(o, now)` without `now` and `untilText(s.nextAt, now)` without `now` (the default is `Date.now()`, the same value); the lines overlay's inner `Math.max(0, body.length - room)` and the outer `Math.max(0, …)` (each makes the other redundant).

- A flaky test of M26 (k keeps one of a fan-out) made in this work's runs: its three rows took
  `Date.now()` one by one, and the list and the compare columns order by `startedAt`; rows
  made either side of a millisecond put another row under the cursor (reproduced every time
  with the second and third a millisecond later). The rows now share one start time. A test
  fix only; on main too.

## M74, as done

- `hub/overlays/log.ts` (`createLogOverlay(host, { only?, title? })`: `/log`, `/concierge log`, a peek's `/log`), `hub/overlays/usage.ts` (`createUsageOverlay(host)`: `/usage`) and `hub/overlays/compare.ts` (`createCompareOverlay(host, { ids, fanoutId?, selectedId?, keepOne, select })`: `/compare`), moved out of `AgentView`; `hub/agent-view.ts` 3829 → 3605 lines (`showUsage` and `usageLines`, `showLog`, `compare` and `compareLines` are a few lines each now). Usage got its own file: it needs no port, log does.
- Interfaces. Log: port slice `{ events: Pick<…, "list"> }`, host `port | theme | say | close | requestRender | termRows`; fetches inside, `say`s the error or the empty line and returns `undefined` (same shape as M72/M73: `Promise<Overlay | undefined>`); `showLog` keeps the "background service unavailable" check, since it owns the connection. Usage: no port; host `theme | close | termRows | rows` (it reads the view's rows at each render). Compare: no port; host `theme | say | close | requestRender | attachTo | rows | termRows | worktreeChange`. `compareRows` stays in the view (it reads the selection and the marks) and hands the overlay `ids`, `fanoutId` and the starting column; `keepOne(keep, others)` stays the view's too (it stops and removes through the port, clears marks, moves the cursor and says the notice), called back from the overlay after it closed itself; `select(id)` moves the view's cursor on Enter before the overlay attaches (`attachTo` does not touch it).
- One new shared constant: `DOUBLE_PRESS_MS` (2000) moved to `hub/overlay-host.ts`; the view and compare's k k both use it. The timing is `Date.now()` and `setTimeout` as before, no clock added.
- Pinned first, on the old code: `test/agent-view.test.ts` "M74: overlay renders, pinned", 5 tests, 25 `toMatchSnapshot` renders (Date frozen, rows with explicit `startedAt`): usage (4 sessions, 2 models, a subscription, a multi-line name, at 100 and 50 columns; nothing spent), log (all kinds of events and tones, at 100 and 40 columns, scrolled by lines and pages, the end of 230 events cut at 200; a session's filtered log with its title; the concierge's; both empty), compare (3 sessions at 140, 100 and 40 columns, another column chosen, the k prompt wide and narrow, back after the two seconds; the five worktree texts: no worktree, a change, no diff, gone, an error; two marked rows without k). They pass unchanged after the move (the snapshot file only gained these).
- Own tests: `test/log-overlay.test.ts` (11), `test/usage-overlay.test.ts` (11), `test/compare-overlay.test.ts` (36), on `fakePort`, `fakeHost` and `test/support/overlay-keys.ts` (which gained `KEY.right`).
- `test/agent-view.test.ts`: no test removed, 93 → 98 (the 5 pinned). Trimmed to the wiring: `/log` (feed order and tones), `/usage` (totals, order, tags), the two compare tests (columns, narrow layout, change texts, escape cleaning); they keep: the command opens it and Esc closes, `r` asks the daemon again, k k reaches the daemon's stop and rm through `keepOne` (a pinned one stays; marked rows reach no rm), `/compare` needs a fan-out or marks, the peek's filtered log.
- Mutation check (each guard taken out or inverted in turn, the overlay's own test file run): `log.ts` 55 of 55, `usage.ts` 47 of 49, `compare.ts` 123 of 123 (the first runs missed 9, 11 and 14; tests added until each was caught). Not caught in usage, both equivalent: `visibleWidth(s) >= n` as `> n` (a string of exactly the width is not cut either way) and the lower `Math.max(0, …)` of the scroll clamp (with less to show than the room, the slice from a negative top is the same lines).

### Candidate 04, closed (M71–M74)

`hub/agent-view.ts` went from 4455 lines (before M71) to 3605: the screens (workspaces, review, task board and lines, orders, answer, schedules, log, usage, compare) are modules in `hub/overlays/` (8 files, 1,136 lines), built on `OverlayHost` and a slice of `RoostPort`; every daemon call of the hub goes through the port (69 inline requests gone). The view keeps the core (list, selection, input, dispatch, peek), the slash commands and what changes its own state. Tests: 8 overlay test files on a fake port and a fake host (the overlays' rules), mutation-checked (731 of 753 guards caught over M72–M74, the rest equivalent), plus snapshot tests of every moved screen in `test/agent-view.test.ts`, which keeps one wiring test per overlay.

### After review (M74)

- No drift found (compare, log and usage compared with the old code key by key).
- Nothing pinned the order of Enter in compare (closed, then the view's cursor moved, then
  attached); a test now records it and fails with the two calls swapped.
