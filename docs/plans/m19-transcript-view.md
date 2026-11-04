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
| Esc | clear the box; else up one level (the parent's transcript), and from a top child back to the conversation |
| PgUp/PgDn | scroll; it follows the end otherwise |
| Ctrl+O | leave and attach to the shown subagent |

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

## Not ported

- Claude's in-place transcript (pi-roost draws it as a full-screen overlay).
- Expanding a tool call's whole output: three lines and a count; → attaches for more.
