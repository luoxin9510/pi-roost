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
- `Overlay.onEvent?(e)`: called from `AgentView.onEvent` for every pushed event after the view took it in (a throw is swallowed). `wsReload` stays; M72 moves it onto `onEvent`.
- Tests: `test/agent-view.test.ts` (83) and the other hub tests pass unchanged: `FakeClient` fakes `DaemonClient`, which the adapter wraps. New: `test/roost-port.test.ts` (54: every method's op, args and result, subscribe order, request ids, a lost reply resent with the same id on `via`'s client, a refusal not resent) and `test/support/roost-port.ts` (`fakePort(answers)`: an in-memory `RoostPort` recording calls by path), for the overlay tests of M72–M74.
