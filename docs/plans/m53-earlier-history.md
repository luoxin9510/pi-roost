# M53: a session's whole conversation, loaded as the transcript scrolls up

Entering a session from the hub showed only part of its conversation. The reason is pi's,
not the attach: pi's chat starts at the latest compaction. It renders what the model still
has in context (`buildContextEntries`: the compaction's summary, the kept messages, what
came after), both when a session is opened or resumed and when it compacts while running
(it clears the chat and draws it again). What came before is in the session file, but
nowhere on the screen, and the wheel stops at the summary.

(The attach itself carries pi's whole screen: fullscreen pi draws on the alternate screen
in its own scroll view, and the host's replay restores the mouse modes, so the wheel
already reached pi.)

## Behaviour

- In a session pi-roost runs (a worker), the messages from before the latest compaction
  go just above pi's chat, under its header, a dozen at a time: each time the transcript
  is scrolled to its top (the wheel, PgUp, Home, dragging the scroll bar), the next older
  dozen loads. The view stays on the lines it showed: the new ones are above them, and the
  next scroll up reads them.
- A line above them says how many are left (`↑ 28 earlier messages (before compaction):
  scroll up to load`), or `── the start of the session ──` when all are shown.
- A screen not full yet (a short chat after the compaction) loads on until it is.
- They are drawn by pi's own components, as pi draws a resumed session: prompts, assistant
  text (thinking hidden as the `hideThinkingBlock` setting says), tool calls with their
  results, `!` commands, displayed custom messages (pi-roost's messages among them),
  earlier compactions' and branches' summaries. Ctrl+O's expanded state is the one at the
  time a message loads.
- A compaction while the session runs, `/tree` to another branch, or another session
  (`/new`, `/resume`) starts over: nothing loaded, the count of the new boundary.

## How

`adapters/pi/earlier-history.ts`, registered by the worker extension.

- `earlierEntries(branch)`: the current branch's entries before the latest compaction's
  first kept entry (the rule of pi's `buildContextEntries`); none without a compaction.
  `historyUnits` turns them into messages with pi's `sessionEntryToContextMessages`, and
  pairs each tool call with its result.
- The TUI: an extension sees no chat container, so an empty widget's factory hands over
  the TUI (as M14's repaint does). On its first render, the history component is put into
  pi's document, before the chat container: the document is the child of the primary
  `ScrollView` under the TUI's layout root (`transcriptView`). It is taken out on
  shutdown.
- Loading: the component's render sees the view at its top, adds a chunk and moves the
  view down by the lines it added. pi lays the transcript out after rendering it (the
  content is measured, then the position clamped to it), so the position is moved inside
  that render (the ScrollView's `currentScrollTop`); a pi without that field gets a
  `scrollTo` after the frame instead. A render is requested after each load.

## Tests

`test/earlier-history.test.ts`: the boundary (one compaction, two, a lost first kept
entry), the messages kept and paired, drawing with pi's components, loading only at the
top and only once per frame, the start line, a reset; and on pi-tui's own `ScrollView` and
`VStack`: the transcript found, history put before the chat, the chat staying on the
same row as a chunk loads above it.

Checked in a real fullscreen pi (1.5.0) in a pseudo-terminal: a session of 40 exchanges
compacted down to its last; the first frame shows the newest earlier one (the screen was
not full), wheel events scroll through the rest, and the top says the session's start.

## Not done

- pi on the terminal's main screen (`tuiMode: "regular"`): there is no transcript view to
  put them in, and the host's replay carries no scrollback; such a session shows what pi
  shows.
- A foreground pi (not a pi-roost session) is left as it is.
- A tool's own renderer: extension tools' renderers are not reachable from an extension,
  so tool calls are drawn the generic way.
