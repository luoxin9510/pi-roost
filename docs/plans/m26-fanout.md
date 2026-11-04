# M26: one task, several models, compared

Run the same task with several models side by side, compare what each did, keep one.

- `/fanout a/x b/y …` (two to six models; bare: a picker that adds or removes one model at
  a time, Esc when done; `/fanout off` cancels): the next task starts one session per
  model. It applies once; the line under the header says so while it is set.
- Each session is named `task · model` and runs in its own git worktree when the
  directory is a git repository (forced: their edits must not collide); outside one, they
  share the directory and a warning says so. Thinking and agent choices apply to all.
- The sessions of one fan-out carry a common `fanout` id (dispatch → record → row), kept
  across daemon restarts.
- `/compare` on a row of a fan-out (or Ctrl+O-marked rows): a panel with one column per
  session: model, state, time, cost and tokens, the change in its worktree (files,
  insertions, deletions against its base, uncommitted work included), and its last
  reply. ← → choose, Enter opens the session, `k` twice keeps it: the others are
  deleted (their worktrees removed when clean, else kept and said so).
- Checked: unit (parsing, one-shot, names, ids through the daemon, panel layout, keep
  flow), and a real pi: two models on a small task in a scratch repo.
