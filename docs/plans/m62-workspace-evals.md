# M62: the ADE loop with a real model

The evals (M37, M41) measured messaging, the concierge and the task board with a real
model. M62 adds the loop M54–M60 built: a task started in its own worktree, the session's
commit and `roost_task_done`, the repository's verify, review, the user's local merge.

## Use

```sh
npm run eval -- --only "roost workspaces" --runs 3
```

## Cases (`evals/workspace.eval.ts`)

- **workspace loop**: the task asks for a file with a token; verify (`sh check.sh`, in
  `.roost/project.json`, approved) checks it. Checks: verifying then in review; verify
  passed; merged into main by the user; main has the session's commit; the worktree is
  gone after the merge; the session never merged; cost.
- **workspace verify loop**: the exact output wanted is said only by the check's failure
  (the check holds it hex-encoded, so reading the check does not give it away).
  Checks: a verify failure went back to the session (`working · verify failed`); then it
  passed; merged; main's script prints what the check wants; cost.

## The harness (`evals/harness.ts`)

A case with `git` and `workspace`: the repository gets a local identity and commits
`.roost/project.json` with its files; the task is added with the repository as its
project, its commands approved (the dry call, then the hash), its worktree made with
`createTaskWorktree`, and the pi launch built in it with `buildLaunch` and `taskPrompt`,
then `task start`, as the hub's `/tasks start` does. It settles while the task is
verifying or merging. With `merge`, a task in review is merged (`ff`) after its session
is stopped and gone, as a user who closes a finished session: a live holder keeps the
worktree (`worktree kept while … runs`). The outcome has the stage, verify's result, the
merge note, whether the worktree is left, and base's log; the observations carry it.

## First result (haiku 5.5, thinking low, 3 runs each)

| case | pass | p50 | cost |
| --- | --- | --- | --- |
| workspace loop | 3/3 | 9 s | $0.0019 |
| workspace verify loop | 3/3 | 21 s | $0.0052 |

## After review

- The wanted line is hex-encoded in the check: a session that reads `check.sh` first
  would pass without the failure the case is about.
- "Only the user merged": every merging/merged stage event is the user's, and the merge
  note is there (the old check let a `roost` event through).
- A workspace case is one pi session: `extra`, `fanout` or `agent` with it is an error,
  not silently dropped.
- Every `git: true` case's repository has a local identity (`eval@example.invalid`), so a
  session's commits there have one.
