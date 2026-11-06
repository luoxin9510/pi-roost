# Toward an agent development environment (M54–M60)

pi-roost runs many pi sessions, isolates them in git worktrees (M10, M15, M20), shows
what each changed (M26) and coordinates them through a task board (M47–M52). What it
lacks is the loop an agent development environment (ADE) is built around:

```
task ──▶ workspace ──▶ agent works ──▶ verify ──▶ human review ──▶ local merge
 (board)   (worktree)    (pi session)   (checks)    (diff in TUI)    (git, no push)
```

This note plans that loop. pi stays the core: a pi session is the agent, pi's events are
the status (never a screen scrape), pi's tools are how the agent touches the board.
Agents of the protocol (M31) get the same workspaces with what their protocol carries.

Revised after two adversarial reviews (PR #82): the first draft
extended the task `state`, made a workspace at claim time, released without a merge and
left the merge's git mechanics open; the second pass found the ownership path, storage
downgrades, the state/stage split, merge retries and crash data underspecified. The
decisions below answer both.

## Principles

1. **Local git first.** Merges go into the base branch locally and never push. GitHub is
   never required; a pull request is an optional exit a human asks for.
2. **Every operation is a `/tasks` command first**, usable from the hub's input, the CLI
   and pi-mobile; the TUI screens add keys on top, never an operation of their own.
3. **Never lose work.** No step deletes uncommitted changes or commits that are not in
   base. Conflicts are resolved in the task's worktree, never in the main checkout.
4. **A friendly TUI.** The keys that work are always shown; `?` lists all; one key jumps
   to the next task that needs you; the push exit asks every time.
5. **Merging is a human's act.** Sessions, the concierge and protocol agents can start,
   verify and send back; only a person in the hub or the CLI merges or pushes.

## Data model (no new `state`)

`state` stays `open | claimed | done | dropped`, so `blockedOn`, the sweep, the M52
notifications, the protocol and older SDKs keep working. A task with a workspace gets an
optional field; older daemons and clients ignore it:

```ts
workspace?: {
  path: string; branch: string;           // the worktree and its branch
  baseRef: string;                        // the base branch's name, e.g. "main"
  baseSha: string;                        // the commit it was made from (40 hex)
  stage: "working" | "verifying" | "review" | "merging" | "conflict" | "failed" | "shelved" | "merged";
  verify?: { ok: boolean; at: number; log: string; tail: string; rounds: number };
  merge?: { tip: string; oldBase: string; at: number; into?: string };  // written before the merge, `into` after
  comments?: ReviewComment[];
}
```

**`stage` is the truth for a task with a workspace.** `state` follows the claim as it
does today (a session that ends releases it to `open`; `releaseTask` never changes the
stage), except that `merged` sets `state: done` and `dropped` stays `dropped`.
Summaries, the digest and `needsYou` count workspace tasks by stage.

| stage | from | trigger (guard) | side effect |
|---|---|---|---|
| working | (new), review, failed, conflict, shelved | `/tasks start` (open, not blocked), `/tasks back`, a failed verify (< `maxRounds`) | a session dispatched or told |
| verifying | working | `roost_task_done` (committed), `/tasks verify` | a verify job queued |
| review | verifying, merging | verify passed, no `verify` configured, verify not approved, interrupted, a merge that could not finish | `needsYou` |
| merging | review | `/tasks merge` (a human) | intent `{tip, oldBase}` written first |
| conflict | merging | the sync conflicted | `needsYou` |
| failed | verifying | verify failed `maxRounds` times | `needsYou`; `/tasks back` or `/tasks pass` |
| shelved | review, failed, working (no live session) | `/tasks shelve` | worktree removed, branch kept |
| merged | merging, any | merged, or the tip found in base | `state: done`, dependents told |

Each change of stage is a `task` event (new why `stage`). The task card is the source of
truth; the branch name is only a label.

Storage: tasks.json gets `version: 2`. The new `loadTasks` keeps fields it does not know
(an older daemon rebuilds each task field by field and would drop `workspace` on its
first save, so downgrading after workspaces exist is documented as unsupported). A
malformed `workspace` (no path or branch) or an unknown stage loads as `failed`, never
as a reset. Protocol: a `workspaces` capability in `hello`; the board event gains a
`needsYou` count, the old keys stay.

## Workspace ownership

- The only way a task gets a workspace is **`/tasks start <id>`**. A session already
  running elsewhere cannot move into a worktree (its cwd is fixed at launch), so
  `roost_task_claim` and `/tasks assign` on a task with a workspace are refused with
  "start it with /tasks start".
- Who does it: the client that asks (the hub, the CLI, pi-mobile) makes the worktree and
  builds the pi launch with `lib/dispatch.ts`'s `buildLaunch`, as `/new`, pi-mobile and
  the session tools already do; then the daemon's new `task start` op records the
  workspace and dispatches. The concierge's `hub_task_start` (M57, as built) makes the
  worktree and the launch in the concierge's own process, as the hub does; the daemon's rule that the concierge never
  dispatches worktrees itself (`daemon/main.ts`, the concierge dispatch check) stays.
- Preconditions: the task is `open`, not blocked, not dropped, in a repository
  (`project` not null), with a free claim; a second `start` with the same request id
  (M51) is the same start. A task with a workspace but no live session: `start` again
  dispatches into the same worktree (resuming the last session when it can).
- Branch `roost/t<id>-<slug>-<4 hex>`: today's tag shape, with `slugOf` given a budget of
  `32 − length("t<id>-")` so the part before the hex never exceeds `validWorktree`'s 32
  characters (tests: id 9999, a title with no ASCII letters, which falls back to `task`).
  `createWorktree` gains the base ref and the tag prefix as parameters.
- The worktree belongs to the task, not the job: the dispatch carries `task: <id>` and
  no `job.worktree`, so removing the job never cleans up a task's worktree; the
  `task start` op runs `validWorktree` and the cwd-inside check itself.
- `/tasks drop` on a task with a workspace removes a clean worktree and keeps the branch;
  a worktree with uncommitted changes is kept and named in the reply, and `/tasks
  cleanup` (M58) lists such leftovers of dropped tasks for a human to remove.

## Dependencies

One function, `blockedOn`, decides; the rules:

| the task waited on | met when |
|---|---|
| has no workspace | `done` or `dropped` (as today) |
| has a workspace | `stage: merged` (its `state` is then `done`), or `dropped` |
| is in another project | `done` or `dropped` only (its code is not in this repository) |

A dependent's line says what holds it: `after #4 (in review)`, `after #6 (conflict)`, so a
chain stopped on a human shows where. A branch found to be in base already (merged by
hand: `git merge-base --is-ancestor <tip> <base>`) is marked merged; checked for tasks
in review, failed, conflict or shelved when the board is listed, at `start` and `merge`,
and with M26's change polling, never in a loop of its own.

## Verify

- Config `.roost/project.json` is read from the **base branch of the main checkout**
  (`git show <baseRef>:.roost/project.json`), never from the task's worktree, which the
  agent can edit. Fields: `verify`, `setup`, `teardown`, `merge` (`ff` | `no-ff`),
  `verifyTimeout`, `maxRounds` (default 3). A personal override lives in
  `<roostHome>/projects/<repo hash>.json` (`lib/paths.ts`, by default
  `~/.pi/agent/roost`); its commands need the same approval.
- A command is approved once per sha256 of the command text, in the hub. The wording is
  honest: approving lets this command run in your account; what it calls (a
  `package.json` script, a test file) is not covered by the hash. A command not approved
  yet does not run: the task goes to `review` marked "not verified: approve the verify
  command", counted in `needsYou`.
- Verify runs as a **shell job** (M6b) in the worktree. The daemon builds this launch
  itself (a shell launch is a command, a cwd and the user's `workspaceEnv` setting from
  the config, which the host evaluates for every kind of job, M20), as
  `sh -c '<command> >"$ROOST_VERIFY_LOG" 2>&1'` so the exit code is the command's and
  the log is a file under roostHome. It is a row named `verify #<id>` in the hub, removed
  when it ends; a timeout kills its process group. At most two run per repository; more
  wait at `verifying`, shown as queued. A daemon restart that finds `verifying` without
  its job sets `review`, marked "not verified (interrupted)", so nothing hangs.
- `roost_task_done` with uncommitted changes is not a verify failure: it answers "commit
  your work first". `/tasks commit <id>` lets a human commit for an agent that is gone.
  No commits at all goes to review marked "no changes".
- A failed verify sends the log's last 40 lines (bounded as M49 bounds messages) to the
  session and returns the task to `working`; after `maxRounds` failures it stops at
  `failed` for a human. `/tasks pass <id>` overrides a flaky failure, marked on the card.

## Merge

All conflict work happens in the task's worktree; the main checkout only ever
fast-forwards or makes a merge commit that cannot conflict.

0. Preflight: `user.name` and `user.email` set (for a merge commit), the task's worktree
   has no uncommitted changes.
1. Take the repository's merge lock (in the daemon, and a lock file in the git dir). It
   orders pi-roost's own merges only; the user can still commit, which step 4 handles.
2. **Sync** in the worktree: `git merge <baseRef>` into the task branch (never rebase:
   commits and review comments keep their identity). The cost is a "Merge branch main"
   commit in the branch's history whenever base moved; accepted for now. A conflict stops
   here: `stage: conflict`, the worktree holds the half-done merge, base untouched.
   Options: `/tasks back` (to the agent; a session is started if none is alive), "I'll
   resolve it" (a shell in the worktree), `/tasks abort` (`git merge --abort`). It counts
   as resolved when `MERGE_HEAD` is gone and base is an ancestor of the branch, checked
   at the next `/tasks merge`.
3. If base moved, verify again.
4. Write the intent `merge: { tip, oldBase }`, then into base, wherever `baseRef` is
   checked out (`git worktree list --porcelain`):
   - checked out in a checkout (the main one or another worktree): that checkout must be
     clean (deliberately stricter than git, which allows unrelated changes: a merge never
     lands among a person's half-done edits); then `git merge --ff-only <branch>`, or
     `--no-ff --no-edit` by config, which cannot conflict because the branch contains
     base. Not clean: refuse and say where.
   - checked out nowhere, a detached HEAD, a bare repository: `git update-ref
     refs/heads/<baseRef> <new> <oldBase>`, which fails if base moved.
   - base moved since the sync (`--ff-only` or the update-ref fails): back to step 2, at
     most twice, then `review` with "base keeps moving".
   - a hook or a signing step fails: if base is still `oldBase`, back to `review` with
     git's message; if base moved to include the tip, on as merged.
5. Record `into`, set `merged`, then teardown and cleanup. Cleanup gets a new rule: a
   branch whose recorded tip is an ancestor of base is deleted with `git branch -D`
   (after pi-roost checked the ancestry itself; `-d` would compare with the main
   checkout's HEAD), a clean worktree removed; anything else is kept and said.
6. A crash: on start the daemon finds `stage: merging` and reads the intent. The tip is
   in base: finish as merged. Otherwise: back to `review`. A `MERGE_HEAD` left in the
   task's worktree by an interrupted sync is aborted (only there, never in a checkout
   pi-roost did not merge in).

LFS and submodules: git does the work in both steps; a fast-forward does not smudge
anything new into the main checkout beyond what `git merge` would. Detached HEAD in the
main checkout counts as "base checked out nowhere".

`/tasks pr <id>` is the optional exit: push the branch and `gh pr create` (M16 shows its
status). It asks every time and is never available to the concierge or protocol agents.

## The workspace screen

An overlay of the hub (`/workspaces`; a shortcut picked in M56 from the free keys), like
the hub's other overlays: letter keys are safe there because the input editor is not
focused. The board's tasks with workspaces in this repository as a pipeline, the selected
one's detail on the right, keys at the bottom. Under 100 columns the detail goes below
the list.

```
 api · workspaces                                     3 working · 1 review · 1 conflict
┌─ tasks ─────────────────────────┐┌─ #4 add users migration ─────────────────────────┐
│ REVIEW                          ││ branch  roost/t4-users-migration-a1b2 (base main) │
│ ▶ ◆ #4 users migration  +82 −3  ││ agent   api-fix  ◐ waiting for you                │
│ CONFLICT                        ││ change  5 files +82 −3 · 1 new · 2 commits        │
│   ✕ #6 rate limiter             ││ verify  ✓ npm test  41s  (12:03)                  │
│ WORKING                         ││                                                   │
│   ● #5 login page       +20 −0  ││ files                                             │
│   ○ #8 cache layer      idle    ││   M db/schema.sql                       +12 −1    │
│ OPEN                            ││   A db/migrations/0004_users.sql        +40       │
│   · #9 audit log  after #4      ││   M src/users/repo.ts                   +30 −2    │
│ MERGED (today)                  ││                                                   │
│   ✓ #3 users table              ││ agent: "migration and rollback done, tests…"      │
└─────────────────────────────────┘└───────────────────────────────────────────────────┘
 enter review · m merge · b back · v verify · t attach · h shelve · n next · ? keys
```

Status icons: `●` working, `◐` waiting for you, `○` idle, `⧗` verifying, `◆` review,
`✕` conflict or failed, `✓` merged, `·` open. Colors only add to the icon. Each key is a
different letter (no meaning carried by case alone). Mouse input is not in this plan: the
hub has none today, and it would be a milestone of its own.

## Review

```
 #4 users migration · db/migrations/0004_users.sql            hunk 2/3 · 1 comment
───────────────────────────────────────────────────────────────────────────────────
  12  + CREATE INDEX users_email ON users(email);
  13  + -- rollback
▶ 14  + DROP TABLE users;
       └ 💬 drop the index first, or the down step fails on sqlite
  15  +
───────────────────────────────────────────────────────────────────────────────────
 j/k line · n/p hunk · ]/[ file · c comment · b send back · m merge · esc back
```

- The diff is `baseSha..tip` plus uncommitted changes, by file; renames shown as renames,
  binary files as one line, a file over 2000 lines or 256 KB as a summary with "open in
  your editor". Long lines are cut with `…`, never wrapped.
- A comment is `{ file, line, text, lineText, tip }`. When the agent commits again, a
  comment whose `lineText` is no longer at that place is shown as outdated, kept.
- `c` opens a one-line editor in the overlay (focus returns on Enter or Esc). `b` sends
  all comments in one message (bounded) and moves the task to `working`.

## Milestones

Each milestone: its own branch, a design note, tests, an independent review, merged by
PR. The stress run and the evals grow with the loop.

### M54 — the data model, no new behaviour

- The `workspace` field and stages, tasks.json `version: 2` keeping unknown fields, the
  malformed-record rule; `blockedOn` by the dependency table; `after #4 (in review)` in
  the board's lines; `needsYou` and the `stage` event; the `workspaces` capability,
  SDK types, `docs/protocol.md`.
- Tests: load and save round trips (v1 file, v2 file, unknown fields, malformed
  workspace), every dependency rule.

### M55 — start and merge, from `/tasks`

- `/tasks start | merge | back | abort | drop | commit`, the `task start` op, ownership
  (no `job.worktree`), branch naming with the slug budget, `roost_task_done` moving a
  workspace task to `review` ("not verified" until M56), refusals of claim and assign.
- The merge as above, with tests on real repositories: ff, no-ff, conflict, base moved
  during the merge, a dirty checkout, base checked out in another worktree, nowhere, a
  bare repository, a failing hook, a branch merged by hand.
- Concierge `hub_task_start` through the hub (no merge); its prompt updated.
- Stress: two merges at once in one repository; a daemon killed at each merge step.

### M56 — verify, config and trust

- `.roost/project.json` from base, the personal override, approvals by sha256, the
  not-approved path.
- Verify as a shell job, the log, timeout, queue, restart recovery, send-back of
  failures, `maxRounds`, `/tasks verify | pass`; setup and teardown.
- Evals: a real model takes a task, commits, gets a failing verify, fixes it, passes.

Release 0.1.17: the whole loop from `/tasks`, without the new screens.

### M57 — the workspace overlay

The overlay, its keys, `n` for the next task that needs you (also on the hub's main
view), the narrow layout.

### M58 — review in the TUI

The diff overlay, comments and their outdated state, send-back, merge from there; the
same review from the CLI (`pi-roost review <task>`).

Release 0.1.18.

### M59 — shelving, leftovers, pi-mobile, hardening

`/tasks shelve` and restore, `/tasks cleanup` for the worktrees of dropped tasks, the
dependents' "held by" line in the concierge's digest, the `/tasks` commands and
needs-you notifications on pi-mobile, an adversarial pass over the loop as M49 did for
the board.

### M60 — optional exits

`/tasks pr <id>`; a port range per workspace (`ROOST_PORT`), if setups need it by then;
a warning when two working tasks change the same file.

## Out of scope

An editor or an IDE (the user's own tools open the worktree), mouse input, containers or
remote machines, a web kanban, GitHub as a requirement, rebase, importing worktrees
pi-roost did not make (`validWorktree` trusts only its own).

## Lessons from other tools

A survey of open-source ADEs and agent TUIs, read on 2026-11-06. Code may only be
borrowed from MIT or Apache projects; ideas come from all of them, including AGPL
projects (Claude Squad, openkanban) and Conductor's public docs (closed source).

| Lesson | Where it comes from |
|---|---|
| Local `git merge --no-ff` into base, never push; check base before and after | [amux](https://github.com/andyrewlee/amux) |
| Sync base into the branch with continue/abort; a conflict keeps the worktree | [agent-worktree](https://github.com/nekocode/agent-worktree) |
| setup / teardown scripts per workspace, files copied in, a port range | amux, [Emdash](https://github.com/generalaction/emdash) |
| Repository hooks approved by the user, bound to a sha256 | [agent-deck](https://github.com/asheshgoplani/agent-deck) |
| Status icons and "jump to the next that needs me" | agent-deck, amux |
| Review in the tool, comments sent back to the agent | amux, [Vibe Kanban](https://github.com/BloopAI/vibe-kanban), [Orca](https://github.com/stablyai/orca) |
| A checks page before merge; failing checks sent back | [Conductor docs](https://www.conductor.build/docs/reference/checks), Orca |
| A key bar always visible | [gitui](https://github.com/gitui-org/gitui), [lazygit](https://github.com/jesseduffield/lazygit) |
| Clean only what has no diff and nothing uncommitted | agent-worktree |
| The most-asked feature is workspace setup | [Claude Squad #260](https://github.com/smtg-ai/claude-squad/issues/260) |
| A board without verify, review and merge does not hold users | Vibe Kanban's README announces it is sunsetting (read 2026-11-06) |
