# M15: polish from Claude Code's docs

Status: implemented (2026-11-04, PR #26). Four small items that Claude Code has and
pi-roost did not.

## `.worktreeinclude`

Claude Code copies the ignored files that `.worktreeinclude` names (`.env`, local
config) into a new worktree. pi-roost now does the same (`lib/worktree.ts`):

- Format: gitignore patterns. Only files git ignores *and* the file matches are copied:
  `git ls-files --others --ignored --exclude-from=.worktreeinclude --directory`. A
  folder comes whole.
- Copying uses `cpSync` with `COPYFILE_FICLONE`, so APFS and btrfs clone instead of
  copying bytes. Symlinks stay symlinks. `CreatedWorktree.included` lists what came over.
- Cleanup on `rm`: a copied entry that is still the same as in the source checkout is
  not work. Checks:
  - `sameEntry`: a file's bytes, a link's target;
  - `sameTree`: a folder, up to 5000 entries;
  - folders that are rebuilt rather than edited (`node_modules`, `.venv`, `target`,
    `.next` … `REBUILT`) count as the same.
- The source checkout's `.worktreeinclude` decides at cleanup, not the worktree's copy:
  a session cannot make its own edits look like copies.
- `git status --porcelain=v1 -z --ignored` is parsed NUL-separated, so file names with
  spaces, quotes or newlines are safe.
- The daemon runs all of this asynchronously; nothing blocks its event loop.

## `pi-roost list` (`ls`)

A table of the sessions as the agent view groups and orders them (`lib/list-format.ts`):
Ready for review, Needs input, Working, Completed, with pinned rows first. Options:
`--all` (ended more than 48 h ago too), `--subagents` (children the view hides),
`--cwd <dir>`. `--json` stays for scripts.

## `cleanupDays` (default 30)

Claude Code removes old transcripts after `cleanupPeriodDays`. The daemon removes the
*records* of sessions that ended at least this many days ago, at most once an hour
(`cleanupOld`). The session files stay, so `/resume` still finds them. A record is kept
when it is:

- a shell job;
- running, starting, respawning, stopping or being removed;
- pinned;
- waiting for an answer;
- holding a reply or report not yet delivered;
- the parent of a running child.

`cleanable()` is checked again after every await, and one sweep runs at a time.
Removal goes through the same `removeRecord` as `rm`, worktree rules included: a
worktree with work in it is kept. `0` turns this off.

## The host answers terminal queries

A program in the PTY may ask its terminal questions (device attributes `ESC[c`, cursor
position `ESC[6n`). While someone is attached, the user's terminal answers. While nobody
is, nothing did, and programs that wait for an answer hung. The host's headless xterm
now answers (`term.onData` → `proc.write`) while nobody is attached, and while an attach
waits for its repaint (M14 `hold`).

## Tests

- worktree:
  - includes copied;
  - clean copies not counted as work, edited ones counted;
  - rebuilt folders;
  - odd file names;
  - the source's `.worktreeinclude` used at cleanup.
- list-format: order and columns.
- daemon: cleanup removes old ended records and keeps pinned, blocked and parent ones.
- host: a query answered with nobody attached.
