# M58: review in the TUI

The fifth step of the [roadmap](ade-roadmap.md): a task's diff against its base in the
hub, a person's comments on its lines, sent back to the session in one message; the same
review from the terminal (`pi-roost review`).

## Use

```text
/workspaces, Enter     the selected task's review (Esc: back to the overlay)
/tasks review <id>     the same, directly
pi-roost review <id>   the diff with the comments, printed
pi-roost review <id> comment <file>:<line> <text>
pi-roost review <id> back [note]
```

```
 #4 users migration · M db/users.sql
 file 1/2 · hunk 1/1 · 1 comment
 ─────────────────────────────────────────────────
   @@ -1,2 +1,2 @@
       1   create table users;
       2 - drop index x;
 ▶     2 + drop table users;
         └ ✎ drop the index first
 j/k line · n/p hunk · ]/[ file · c comment · d delete comment · b send back · m merge · r reload · Esc back
```

## Behaviour

- The diff (`lib/task-diff.ts` `taskDiff`): `git diff -M` from the commit the branch
  shares with base (`merge-base HEAD refs/heads/<base>`) to the working tree, so
  committed and uncommitted work, never base's own later commits; untracked files as new
  files. A file is shown a file at a time, by hunks, with the line numbers of the new
  version (of the old for a removed line). A rename is `old → new`; a binary file is one
  line; a file of more than 2000 changed lines or 256 KB is a line saying so (open it in
  your editor); the whole diff read is at most 4 MB (then "cut short"). Lines are cut to
  the width with `…`, never wrapped; tabs as four spaces, control characters as spaces.
  `diff.noprefix` and external diff drivers are ignored.
- A comment is `{file, line, text, lineText, tip}` (`lineText`: the line's kind and text,
  `+drop table users;`). It is under its line while a line of that file has that number
  and that text; otherwise it is outdated: listed above the file, kept. `c` writes one on
  the line under the cursor (a line of the diff, not a hunk's header); `d` deletes the
  last on that line.
- The daemon keeps them on the task (`task comment` / `task uncomment`, a person's: the
  hub or the CLI; at most 200). `back` sends them to the live session in its message
  (bounded to 4000 characters, the rest counted) and clears them; with no live session
  they stay, and the next `/tasks start` puts them in the session's first prompt (then
  clears them). The note says how many went: `sent back (2 comments): …`.
- `m` merges as `/tasks merge`, `b` sends back (a note, then Enter); both close the
  review (back to the workspace overlay when it came from there).
- `pi-roost review <id>` prints the same: files, hunks, comments under their lines,
  outdated ones, comments on files no longer in the diff.

## Not in M58

Verify again on merge when base moved (the roadmap's merge step stays as built in M55:
the sync takes base in; verify is run by hand, `v`); side-by-side diffs; comments on a
range of lines; syntax colours.

## Tests

- `test/task-diff.test.ts`: the parser (renames, binary, quoted paths, no newline at end,
  omitted counts, mode only, limits) and `taskDiff` on real repositories (base's later
  commits left out, untracked, binary, summary, names with spaces and non-ASCII).
- `test/review.test.ts`: where a comment sits, outdated ones, the printed review.
- `test/agent-view.test.ts`: Enter from the overlay, moving, `c` (what is sent), the
  comment under its line, `d`, `]` to a binary file, Esc back to the overlay; `b` with a
  note; `/tasks review`; widths from 10 to 120 columns.
- `test/comms.test.ts`: comments by the hub, refused for a session and for bad input,
  `uncomment`, `back` delivers them to the session and clears them.

## After review

- A send-back clears only the comments that reached the session: the message is awaited
  (`tellOwner` says whether it was delivered or queued); a session that takes no messages
  keeps them, and the note says so.
- The message holds what fits in 4000 characters; the comments it had no room for stay
  for the next send-back (the note counts them), never dropped. A start clears only the
  ones its prompt carried (the same list, the same cut).
- `uncomment` names the comment (its file, line and time, unique per task), not an
  index from a list the hub saw earlier.
- Outdated comments are rows at the top of their file, and the comments on files no
  longer in the diff have a page of their own after the last file; `d` deletes them
  there.
- `p` goes to the previous hunk (it stayed in the current one); the review opens on the
  first line of the diff; `]` lands on a file's first line.
- A merge or send-back that did not happen (a conflict, a refusal) keeps the review open;
  a busy Enter keeps the typed text; a review that cannot load returns to the overlay;
  a second Enter while it loads opens nothing more.
- `pi-roost review N comment f:n` takes the line of the new version with that number (a
  removed line only when none has it) and refuses a line not in the diff; the printed
  review drops control characters (C0, DEL, C1, newlines) from names and comments.
- A file without hunks says what it is: renamed with its text unchanged, an empty file,
  a mode change.
