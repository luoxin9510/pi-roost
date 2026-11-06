# M55: start and merge, from `/tasks`

The second step of the [roadmap](ade-roadmap.md): a task gets its own worktree and a
session in it (`/tasks start`), goes to review when the session says it is done, and is
merged into its base branch locally (`/tasks merge`). Verify comes in M56; the screens
in M57–M58.

## Use

```text
/tasks start 4            a worktree roost/t4-users-migration-a1b2 from the current branch,
                          a session in it with the task as its prompt, the task assigned to it
/tasks merge 4            sync the branch with base, then into base (ff, or no-ff by config)
/tasks back 4 [note]      back to the session: "review: …" (a new session if none is alive)
/tasks abort 4            give up a conflicted sync (git merge --abort in its worktree)
/tasks commit 4 [message] commit what the worktree holds (for a session that is gone)
/tasks drop 4             as before; a clean worktree is removed, the branch kept
```

A session in a task's worktree finishes with `roost_task_done`: with uncommitted
changes it is told to commit first; otherwise the task goes to `review`, marked "not
verified" (until M56), and the hub's status line counts it as needing you.

## Behaviour

### start

- The hub (or the CLI) takes the task's project (its repository root, `project`), finds
  the base: the branch checked out in the main checkout (`git symbolic-ref --short
  HEAD`); a detached HEAD, a bare repository or a task with no project is refused.
- It makes the worktree with `createTaskWorktree` (`lib/task-git.ts`): tag
  `t<id>-<slug>-<4 hex>` with the slug's budget so the part before the hex is at most 32
  characters, under `.pi/worktrees/` of the main checkout, branch `roost/<tag>`, from the
  base's tip; `.worktreeinclude` copied as for any worktree.
- It builds the pi launch as `/new` does (its model, thinking, agent), with the task as
  the first prompt (title, detail, and what to do when finished), and sends
  `task {action: "start", id, workspace, launch}`. The daemon checks the task (open, no
  live holder, not blocked, not dropped or done, in a repository), the workspace
  (`validWorktree`, the launch's cwd inside it, the branch `roost/t<id>-…`), dispatches
  the job with `task: <id>` on its record and no `job.worktree` (so removing the job
  never removes the worktree), claims the task for it and sets `workspace.stage:
  working`. A refused start makes the hub discard the worktree it made.
- A task that has a workspace already and no live holder: `start` dispatches a new
  session into the same worktree (the prompt says work is there already: read `git log`
  and the diff against base first).
- The worker tells a session in a task's worktree so (the prompt note): the task, the
  branch, "commit finished work on this branch, then roost_task_done".

### done → review

`task {action: "done"}` by the session that holds a task with a workspace: the
worktree must be clean (`git status --porcelain` empty, ignored files aside), else
`bad_request` "commit your work first (git add -A && git commit)". Then `stage:
review`, `note: "not verified"`, the result kept, a `task` event (`why: "stage"`),
`needsYou` counts it. The hub and the concierge still cannot mark it done.

### merge

`task {action: "merge", id}`: the hub's and the CLI's only (the concierge and sessions:
`unsupported`). From `review` (or `conflict` once resolved, or `failed` for a retry).
Steps, under a per-repository lock (the daemon's, and `roost-merge.lock` created
exclusively in the git common dir, removed after; a stale one older than 10 minutes is
taken over):

1. Preflight: the worktree exists and is clean; `user.name` and `user.email` are set
   (for a merge commit).
2. Sync: `git merge --no-edit <baseRef>` in the worktree. A conflict: `stage: conflict`,
   the conflicted files in the note, base untouched. A conflict already resolved (no
   `MERGE_HEAD`, base an ancestor of `HEAD`) continues.
3. Intent: `workspace.merge = {tip, oldBase, at}` written before anything touches base.
4. Into base, wherever `baseRef` is checked out (`git worktree list --porcelain`): that
   checkout clean (else refused, back to `review` with where), then `git merge
   --ff-only <branch>` or `git merge --no-ff --no-edit <branch>` (config `taskMerge`:
   `"ff"` default, `"no-ff"`); checked out nowhere: `git update-ref refs/heads/<baseRef>
   <tip> <oldBase>`. Base moved since the sync (ff refused, update-ref failed): back to
   step 2, at most twice, then `review` with "base keeps moving". A hook or anything else
   failing: base still `oldBase` → `review` with git's message; base contains the tip →
   on as merged.
5. `into` recorded, `stage: merged`, `state: done`, events, dependents told (M52's
   message says "merged"); then cleanup: the worktree removed if clean, the branch
   deleted with `-D` only after pi-roost checked its tip is in base.
6. On start the daemon finds `merging` tasks and settles them: the recorded tip in base →
   merged (and cleanup); otherwise `review` with "merge interrupted". A `MERGE_HEAD` left
   in the task's worktree by an interrupted sync is aborted.

### back, abort, commit, drop

- `back` (hub, concierge): `stage: working`; the holder (a live session) gets a message
  with the note; without one, the hub starts a session as `start` does.
- `abort` (hub): in `conflict`, `git merge --abort` in the worktree, `stage: review`.
- `commit` (hub): `git add -A && git commit -m <message or "work on #id">` in the
  worktree; refused while syncing (`MERGE_HEAD`).
- `drop` of a task with a workspace: the worktree is removed when clean (the branch
  kept); otherwise it stays and the reply says where.

## Not in M55

- The concierge's `hub_task_start` (the roadmap has it carried out by the connected hub):
  it needs a request from the daemon to the hub, which does not exist yet; the concierge
  can `back` and hand over messages. Moved to M57 with the workspace overlay.
- Bare repositories: `start` is refused there (no main checkout to branch from).
- The CLI's `pi-roost tasks …` stays as it is; the hub's `/tasks` is the way in.

## Tests

- `test/task-git.test.ts` on real repositories: the tag budget; create from the current
  branch, refused on detached HEAD; sync clean / conflict / resolved; merge ff, no-ff,
  base moved during the merge, a dirty checkout, base checked out in another worktree,
  base checked out nowhere (update-ref), a failing `pre-merge-commit` hook, a branch
  merged by hand; cleanup after merge deletes the branch; the lock.
- `test/comms.test.ts` (a real daemon): start dispatches into the worktree and claims;
  start refused for a blocked task, a bad workspace; done with changes refused, then
  review; merge by the hub, refused for a session and the concierge; dependents told
  "merged"; a daemon restarted with a `merging` task settles it.

## As built

- `lib/task-git.ts` holds the git steps (`createTaskWorktree`, `syncWithBase`,
  `mergeIntoBase`, `cleanupMergedTask`, `withMergeLock`, …); `lib/worktree.ts` shares
  `addWorktree` between a session's worktree and a task's.
- Two merges at once: the daemon refuses a second merge in the same repository while one
  runs (`conflict`), and the lock file keeps another daemon out; the lock is tested in
  `test/task-git.test.ts`. The stress run was not extended; a daemon killed mid-merge is
  covered by the restart test (an intent with its tip in base settles as merged, one
  without as review).
- The hub's `/tasks start | merge | back | abort | commit`; config `taskMerge`
  (`"ff"` default, `"no-ff"`), user or project.

## After review

- One action at a time per task's workspace (two starts, a drop or a `back` during a
  merge get `conflict`); a merging task cannot be dropped.
- A damaged record (no path, the path gone) never reaches git: `commit`, `merge`, `abort`
  are refused (`git -C ""` would run in the daemon's own directory).
- What merges is the branch (`refs/heads/<branch>`), and only while the worktree is on it:
  a worktree moved to a detached HEAD or another branch goes back to review with a note.
- A merge that throws is settled at once as at a restart (tip in base: merged; else
  review), never left at `merging`.
- `start` checks `baseRef` (a branch name) and `baseSha` (a commit id), checks the
  worktree again when a task is started again, and refuses while it is verifying or
  merging.
- After a merge, a session still running in the worktree keeps it (its directory would
  vanish under it) and is told the task was merged; that worktree and its branch stay
  until removed by hand (`git worktree remove`, `git branch -d`); M59's `/tasks cleanup`
  will list and remove such leftovers.
- `git status` and friends run with optional locks off, so they never take the index lock
  from an agent committing at the same time.
- Differences from the text above, as built: the preflight is the sync, then the clean
  check (a conflicted sync is dirty by nature); `no-ff` needs a checkout of base (with
  base checked out nowhere the update is a fast-forward); a settled restart does not
  abort a `MERGE_HEAD` (the `merging` stage is only reached after a clean sync); `back`
  with no live session says to `/tasks start` it rather than starting one.
