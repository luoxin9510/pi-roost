# M4 — backgrounding: acceptance (2026-11-03)

Scope (PRD §10): BG-1…BG-7, BG-10, BG-11, AT-7. Acceptance: flow 5.4
passes; no session file ever has two writers.

## Design

- Foreground role (`extensions/foreground.ts`) in every plain interactive pi.
- ← on an empty prompt (not in a dialog, not in the agent view) rewrites
  the key into submitting `/bg`, because only command handlers get a
  context that can switch sessions (`onTerminalInput` may return `{ data }`).
  `/bg [prompt]` and `/background [prompt]` work directly.
- Move: refuse with an open dialog or an unsaved session; while a tool runs,
  wait for it (status "Moving to background after the current tool… (←
  again to skip)", 10 s cap), allow 250 ms for a user's own Esc to settle
  the run (then cancel: "you stopped the turn"), otherwise abort the turn
  and give the worker "Continue where you left off." (+ the /bg prompt).
- C4: `switchSession` to a scratch file under `~/.pi/agent/roost/scratch/`
  (never written: pi writes lazily); the old runtime's `session_shutdown`
  releases the writer lock; inside `withSession` the daemon adopts the
  original file (`origin: adopt`), then the agent view opens with the
  banner and the row selected. Esc/Enter attaches to it (BG-5); after
  detaching, Esc leaves the view. If the daemon refuses, pi switches back.
- Settings (`lib/config.ts`): `~/.pi/agent/roost.json`, project
  `.pi/roost.json`; `leftArrowOpensAgents: false` disables ← (BG-10).
- Footer (BG-11): "← for agents" for 10 s, then every 10 s — only when the
  daemon socket exists — "← N agents" while jobs wait for input or "← N
  done" after completions.

## Run (stock pi 1.5.0, tmux 110×32, deepseek-flash)

| Check | Result |
|-------|--------|
| Start pi | footer `← for agents` |
| Prompt runs `sleep 8`, then ← | `Moving to background after the current tool…`; after the tool, agent view with `Your conversation moved to the background`, row selected |
| Esc | Attached to the conversation: it had continued ("Continue where you left off."), wrote `finished.txt` = FINISHED and answered DONE |
| Writer locks | each `<session>.jsonl.lock` held by its worker pid; scratch dir empty |
| Same first message twice | second row named `… (2)` (BG-7) |
| `/bg` inside the scratch session | refused: "this is an empty hand-off session" |
| ← during a tool, then Esc (user stops the turn) | "you stopped the turn; the conversation stays here" (BG-3) |
| Idle `/bg Now reply with just the word MOVED.` | moved; worker answered MOVED (BG-4 prompt) |
| `.pi/roost.json` `{"leftArrowOpensAgents": false}` | footer `/agents for agents`; ← does not open the view |
| AT-7 | the daemon refuses sessions whose writer lock is held by a live pi ("session is in use by pid …", M1) |

Automated: 12 files, 95 tests (adds `test/config.test.ts`, `test/foreground.test.ts`).

## Found on the way

The first run crashed the foreground pi from another installed extension,
`pi-fun-working`: a `setTimeout` used its captured `ctx` after the session
switch (PRD R5). The same crash follows `/new` or `/resume`. Fixed in
luoxin9510/pi-packages (separate PR); re-running with the fixed copy passed.
Other extensions with the same pattern will crash on any session switch,
not only pi-roost's.

## Review fixes (PR #4)

- ← drove pi's own selectors: with `/model` or `/tree` open the editor is
  hidden but still empty, so the rewritten Enter picked an item. ← now acts
  only when the focused component is the prompt editor (an empty widget
  hands the extension the TUI). Checked live: ← with `/model` open does
  nothing.
- The command handler cleared its status on the replaced context after a
  successful move (stale-ctx error); footer polls could do the same.
- After leaving the post-move view the user stayed in the scratch session,
  where ← and /bg are off. pi now switches to a fresh session next to the
  moved one (`newSession` would have stayed in the scratch directory).
  Checked live: footer `← for agents`, ← opens the view.
- Esc right after the move, before the worker's first report: the view
  attaches as soon as the job has a pid instead of leaving.
- A brand-new session (no file yet) opens the agent view on ← instead of
  adopting an empty file.
- Refuse during compaction; wait for pi to finish delivering
  `agent_settled` before switching; a second ← while the first `/bg` is
  queued is swallowed; waiters are always removed.
- Footer: "N done" counts completions since the session started or the
  view was last opened, and never overwrites the "Moving…" status.
- A project `.pi/roost.json` can no longer set `envAllowList` (a cloned
  repository must not choose which environment reaches its workers).
- `isScratchSession` resolves paths; the open-view counter is process-wide.
