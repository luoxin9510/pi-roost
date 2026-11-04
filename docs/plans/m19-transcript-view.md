# M19: subagent transcripts in the session, as in Claude Code

Status: implemented (2026-11-04). Claude Code: "Open a row to see that subagent's
siblings and direct children with a path back to `main`", and "type into its transcript
to resume it yourself". Until now Enter on a panel row attached to the child's PTY.

## Behaviour

| Key (panel) | |
|---|---|
| Enter | the selected subagent's transcript, full screen over the conversation |
| → | attach to its pi (as before; an ended one asks for → again) |

| Key (transcript) | |
|---|---|
| typing, Enter | a message to the shown subagent (the daemon's `reply`: delivered, or it starts again); a message that did not go comes back to the box |
| ↑/↓, Enter (empty box) | select and open a row of the tree: `← parent`, the siblings (the shown one marked), its direct children |
| Esc | clear the box; else up one level (the parent's transcript, not the row seen before), and from a top child back to the conversation |
| PgUp/PgDn | scroll; it follows the end otherwise |
| Ctrl+O | leave and attach to the shown subagent (an ended one asks for Ctrl+O again, then starts; not with a message in the box) |

The header is the path: `main › parent › child`, with the state and age.

## Reading

`lib/transcript.ts` reads the child's pi session file (the last 4 MB of it; a note says
when earlier messages are cut), walks the current branch from the last entry through
`parentId`, and lists user prompts, assistant text, tool calls with their first three
result lines (errors marked), custom messages that are shown (pi-roost's messages to the
child), compactions and assistant errors. Thinking is left out. Escapes and control
characters are removed before anything reaches the terminal. The view polls the file
(stat, every 500 ms) while open, so a working child's transcript grows as it works.

Nothing is attached: the child keeps running, its PTY is untouched.

## Review decisions

- Names, summaries, questions and errors are cleaned like the transcript (no escapes).
- A row without a session file (a shell job) says so instead of keeping the last one's text.
- A message that did not go comes back only while the same subagent is shown.
- The tree's selection follows the row, not its index, when rows come and go.
- On a terminal under 10 rows the tree is left out; the message box and keys stay.
- A transcript open when the session changes or pi shuts down is closed.
- A cut tail drops its first line only when that line is really cut.

## Not ported

- Claude's in-place transcript (pi-roost draws it as a full-screen overlay).
- Expanding a tool call's whole output: three lines and a count; Ctrl+O attaches for more.
- `context_edit` entries are not applied, and messages before a compaction still show
  (the view shows what happened, not the model's context).
