# The hub's input: one view, one layer; its options in groups (M79–M80)

A candidate left by candidate 04 (`docs/plans/hub-overlays.md`, decision 6: "not now"): in
`hub/agent-view.ts` (3605 lines after M74) what is on screen was seven flags (`peek`,
`peekId`, `help`, `picker`, `renaming`, `overlay`, `attached`) checked in an order of their
own by `handleInput` (help, overlay, picker, rename) and by the render (overlay, then picker or
help, rename); and `AgentViewOptions` is 45 flat fields that the two adapters
(`adapters/pi/open-view.ts`, `adapters/pi/hub-main.ts`) and the tests each assemble.

## Decisions (grilled 2026-11-10, every answer the recommended one)

1. **Both, in two milestones**: M79 the screen's state, M80 the options in groups; each its own
   pull request.
2. **One state instead of the flags**, each case with its own key handler; `handleInput` only
   dispatches. `marked` (the marked rows) is data, not a state. (As done: two fields, not one;
   see below.)
3. **No key table, no generated help**: the help screen's text stays as it is; a key table is a
   later candidate.
4. **Behaviour unchanged**, pinned first: snapshots of key sequences screen by screen in each
   state, taken on the old code; mutation checks after.
5. **Options in groups by purpose** (`ui`, `launch`, `models`, `sessions`, `tasks`, `local`,
   `hooks`), each function's signature unchanged; the adapters and the tests follow (M80).
6. **`OverlayHost.selectRow(id)`** (left over from candidate 04), in M79.

## M79, as done

- **Two fields, not one** (found while doing it): a peek stays under a picker, a rename or an
  overlay (Ctrl+L in a peek opens the model picker; Esc goes back to the peek). So
  `view: { kind: "list" } | { kind: "peek"; id }` and `layer: undefined | { kind: "help" } |
  { kind: "picker"; picker } | { kind: "renaming"; id } | { kind: "overlay"; overlay }`.
  `peek`, `peekId`, `help`, `picker`, `renaming` and `overlay` are getters over them (the
  reading code is unchanged); every write goes through `openLayer`, `closeLayer(kind)` (closes
  only a layer of that kind) or `view =`.
- **`attached` stays a flag**: the terminal handed to a session's worker, not a layer (nothing
  is drawn and no key is read while it is set, whatever the view or the layer).
- **Keys**: `handleInput` gives the key to the open layer (help: any key closes it; an overlay;
  the picker; the rename), else to `viewKey`; there the list's own keys (`Ctrl+P`,
  `Shift+Ctrl+P`, `Shift+Tab`, `Ctrl+O`, `Ctrl+F`) are `listKey` (in a peek they went on to the
  reply, as before), then the switch both share.
- **One layer at a time** (the one change): what opens last is open, in place of the one open
  (two at once could only happen when something opened while another was open, an overlay
  loaded after a key, the concierge's answer: input and render then disagreed on which was in
  front). The concierge's answer waits for whatever is open to close (it waited for an overlay
  only; over a picker, the help or a rename it opened and took the keys); `closeLayer` opens it.
- **`OverlayHost.selectRow(id)`**: the view's selection goes to that row; compare's own
  `select` option is gone (the fake host records it).
- Tests: 5 snapshot tests of key sequences in `test/agent-view.test.ts` (peek under a picker;
  help over the list and a peek; a rename over a peek; an overlay over a peek, then a choice by
  its digit; the list's keys in a peek and in the list), taken before the change and unchanged
  after; one test of the answer waiting behind a picker. Mutation: `listKey` called in a peek,
  or never; the help not closed; the answer waiting for an overlay only: each fails a test.

### After review (M79)

- The concierge's answer was lost when a picker's pick opened the picker again (bare
  `/fanout`): closing the picker opened the waiting answer, and the pick's new picker replaced
  it at once. An answer replaced by a layer opened after it now waits again (`answerShown`), and
  opens when that one closes (a test, mutation-checked).
- A rename replaced by a layer opened after it (an overlay loaded after a key) left the task
  box without focus: `openLayer` gives it back, as Esc would.
- `selectRow` is wired in the view; compare's Enter then attaches, which selects the row too,
  so the view's test pins where the list ends, not which of the two moved it (the overlay's
  test pins the order: close, select, attach).
- GLOSSARY: the Layer entry had taken Overlay's `_Avoid_` line.

## M80, as done

- **Groups as types, not nested objects** (found while doing it): nested groups would turn each
  adapter's one spread of `piHubOptions(…)` (with a field or two of its own over it) into a
  spread per group, and about 60 test call sites passing a field or two would each name its
  group, for no change in behaviour or in what can be tested. So `AgentViewOptions` is
  `HubCore & HubDisplay & HubLaunching & HubModels & HubResume & HubCommands & HubTasks`, each a
  documented interface; the fields, their names and signatures, and every caller are as they
  were. 44 fields (not 45: the count had a field of a parameter's type).
- Groups: `HubCore` (tui, theme, cwd, connect, setTitle, done); `HubDisplay` (the list's
  display: cwdFilter, groupBy, onGroupBy, notify, highlightId, origin, banner, reducedMotion,
  fullscreen, rowDetails, subagents, switchCheckMs); `HubLaunching` (what a new session runs:
  launch, launchShell, scheduleLaunch, launchProfile, profiles, agents, defaultAgent,
  conciergeLaunch, worktreeDefault, presets, savePreset, userPreset); `HubModels` (models,
  defaultModel, scopedModels); `HubResume` (resumable, sessionSelector, currentSession);
  `HubCommands` (commands, sessionCommands, profileCommands); `HubTasks` (taskMerge and the
  local reads: taskChanges, taskDiff, worktreeChange, hostControl). Three comments stacked on a field with another (one repeating it, two out of date) are gone.
- `PiHubOptions` (`adapters/pi/hub-options.ts`) is now the groups pi provides (all but the
  terminal, the colours and the exits) instead of an `Omit` of the whole.
- Tests: `tsc` is the test (types only); the hub's tests pass unchanged.

