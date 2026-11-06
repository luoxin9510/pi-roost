# M54: a task's workspace, as data (no new behaviour)

The first step of the agent development environment
([roadmap](ade-roadmap.md)): the board learns what a task's workspace is and how it
holds the tasks that wait on it. Nothing makes a workspace yet (M55's `/tasks start`
does); a board without workspaces behaves exactly as before.

## Behaviour

- A task may carry `workspace: {path, branch, baseRef, baseSha, stage, note, verify?,
  merge?, comments?}` (`lib/board.ts` `TaskWorkspace`). The stage is `working |
  verifying | review | merging | conflict | failed | shelved | merged`; `state` keeps
  its four values and follows the claim, `merged` being `done`.
- Dependencies (`dependencyMet`, used by `blockedOn` and so by the claim, the hub, the
  digest and M52's notifications): a dropped task never holds; one of another project
  holds until done; one with a workspace holds until merged (marked done by hand without
  its merge, it still holds); any other until done. The message to the sessions that
  waited says `merged` for a merged one.
- Lines: a task in its workspace reads `#4 in review · api-fix · title (note)`; one
  blocked by it `#9 blocked on #4 (in review) · title`. They come after the claimed
  tasks in the digest and the hub's list.
- Counts: `boardSummary` adds `workspaces` (in a workspace, not merged, not dropped;
  not counted as open or claimed any more) and `needsYou` (review, conflict, failed);
  the summary line reads `2 in workspaces (1 needs you)`; the hub's status line shows
  the board when only workspaces are live too.
- Store: `tasks.json` is written with `version: 2`. Loading keeps fields it does not
  know (a newer daemon's), normalises a workspace (`parseWorkspace`: bounded strings,
  shas checked, at most 200 comments), keeps a damaged one (no absolute path, no
  branch, an unknown stage) as `failed` with a note, never drops it (its worktree may
  hold work), turns a `merged` task's state to `done`, and a task `done` without its
  merge to `open` + `failed` with a note.
- Protocol: `hello` answers the `workspaces` capability; `docs/protocol.md` describes
  the field, the dependency rules, the board event's new counts and that going back to
  an older daemon is not supported once tasks have workspaces (it would drop the field
  on its first save).

## Tests

`test/board.test.ts` ("M54: workspaces on the board"): normalising and damaged
records, every dependency rule, the counts, the summary line and the lines.
`test/comms.test.ts` ("M54: workspaces load normalised…"): a real daemon loads a file
with merged, damaged, done-by-hand and in-review workspaces, refuses a claim blocked by
a task in review, saves version 2 with an unknown field kept, and says `workspaces` in
`hello`.
