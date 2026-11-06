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
Other agents keep the protocol (M31) and get the same workspace, without the deep hooks.

## Principles

1. **Local git first.** Merge into the base branch in the main checkout. Never push,
   never require GitHub. A pull request (M16's `gh` status) stays an optional second exit.
2. **A state machine, not a list.** Each task with a workspace moves through
   `open → working → verifying → review → merging → merged`, with `conflict` and
   `failed` as states of their own; every state has a way out and the TUI names it.
3. **Never lose work.** No step deletes uncommitted changes or commits that exist only on
   a task branch (the rule `cleanupWorktree` already follows). A failed create rolls
   back; a merge conflict leaves the main checkout as it was.
4. **A friendly TUI.** The keys that work are always shown at the bottom; one key jumps
   to the next task that needs you; dangerous keys are capitals with a confirmation.
5. **Repository scripts are trusted explicitly**, bound to their content hash.

## What other tools teach

A survey of open-source ADEs and agent TUIs (2026-11). Only MIT/Apache tools are read
for code; AGPL ones (Claude Squad, openkanban) only for ideas.

| Lesson | Where it comes from |
|---|---|
| Local `git merge --no-ff` into base from the main checkout, never push; check base is checked out before and after | [amux](https://github.com/andyrewlee/amux) |
| `sync` (rebase or merge base into the branch) with `--continue/--abort`; a conflict keeps the worktree and restores the main checkout | [agent-worktree](https://github.com/nekocode/agent-worktree) |
| setup / run / teardown scripts per workspace, files copied in, a port range per workspace (`PORT`, `PORT+1`, …) | [amux](https://github.com/andyrewlee/amux), [Emdash](https://github.com/generalaction/emdash) |
| Repository hooks approved by the user, the approval bound to the script's sha256 | [agent-deck](https://github.com/asheshgoplani/agent-deck) |
| Status icons (running ● / waiting ◐ / idle ○ / error ✕) and filter keys; "jump to the next that needs me" | agent-deck, amux |
| Diff review inside the tool: file list, hunk jumps (`n`/`p`), comments on lines sent back to the agent | amux, [Vibe Kanban](https://github.com/BloopAI/vibe-kanban), [Orca](https://github.com/stablyai/orca) |
| A checks page before merge: git state, test results, open todos; failing checks sent back to the agent | [Conductor docs](https://www.conductor.build/docs/reference/checks), Orca |
| Context key bar always visible, a command palette for everything else | [gitui](https://github.com/gitui-org/gitui), [lazygit](https://github.com/jesseduffield/lazygit), amux |
| Shelve: remove the worktree, keep the branch and the task; restore later | amux |
| Clean only what has no diff and nothing uncommitted; dry run first | agent-worktree |
| Users' most-asked feature: workspace setup (deps, `.env`, ports) | [Claude Squad #260](https://github.com/smtg-ai/claude-squad/issues/260) |
| A kanban with no verify/review/merge does not hold users | Vibe Kanban (sunsetting) |

## The workspace screen

A new screen of the hub (`/workspaces`, and a free shortcut chosen in M57; the hub's
input is an editor, so its letter keys stay text): the board's tasks of this repository as
a pipeline, the selected one's detail on the right, keys at the bottom.

```
 api · workspaces                                     3 working · 1 review · 1 conflict
┌─ tasks ─────────────────────────┐┌─ #4 add users migration ─────────────────────────┐
│ REVIEW                          ││ branch  roost/t4-users-migration  (base main)     │
│ ▶ ◆ #4 users migration  +82 −3  ││ agent   api-fix  ◐ waiting for you                │
│ CONFLICT                        ││ change  5 files +82 −3 · 1 new · 2 commits        │
│   ✕ #6 rate limiter     main ↑2 ││ verify  ✓ npm test  41s  (12:03)                  │
│ WORKING                         ││ setup   ✓ npm ci · PORT 4110–4119                 │
│   ● #5 login page       +20 −0  ││                                                   │
│   ● #7 docs             +4 −1   ││ files                                             │
│   ○ #8 cache layer      idle    ││   M db/schema.sql                       +12 −1    │
│ OPEN                            ││   A db/migrations/0004_users.sql        +40       │
│   · #9 audit log  after #4      ││   M src/users/repo.ts                   +30 −2    │
│ MERGED (today)                  ││                                                   │
│   ✓ #3 users table              ││ agent says: "migration and rollback done, tests…" │
└─────────────────────────────────┘└───────────────────────────────────────────────────┘
 enter diff · a approve+merge · r send back · v verify · s sync · t attach · S shelve · n next · ? keys
```

The diff screen (`enter` on a task) is a file list and one file's diff:

```
 #4 users migration · db/migrations/0004_users.sql            hunk 2/3 · 1 comment
───────────────────────────────────────────────────────────────────────────────────
  12  + CREATE INDEX users_email ON users(email);
  13  + -- rollback
▶ 14  + DROP TABLE users;
       └ 💬 drop the index first, or the down step fails on sqlite
  15  +
───────────────────────────────────────────────────────────────────────────────────
 j/k line · n/p hunk · ]/[ file · c comment · r send comments · a approve · esc back
```

Status icons: `●` working, `◐` waiting for you, `○` idle, `⧗` verifying, `◆` ready for
review, `✕` conflict or failed, `✓` merged, `·` open. Colors only add to the icon,
never replace it.

## Milestones

### M54 — a task gets a workspace

- Claiming a task in a repository (a session's `roost_task_claim`, `/tasks assign`, or a
  new `/tasks start <id>` that dispatches a session for it) makes its worktree: branch
  `roost/t<id>-<slug>` from the base branch, under `.pi/worktrees/` as today. The task
  card records `{ path, branch, base, baseRef }`; one task, one worktree, reused when the
  task is handed to another session.
- Tasks with a workspace get the states above; the board's `done` stays for tasks
  without one.
- A dependency counts as met when the task it waits on is **merged** (or done, for a
  task without a workspace), so the dependent task branches from code that has it.
- The session's prompt note (`worktreeNote`) names the task; the environment gets
  `ROOST_TASK_ID`, `ROOST_WORKTREE`, `ROOST_BRANCH`, `ROOST_BASE`.
- Creating rolls back on failure and never deletes a branch it did not make.

### M55 — project config and trust

- `.roost/project.json` in the repository (and a personal override outside it):
  `base` (default: the main checkout's current branch), `setup`, `verify`, `teardown`,
  `ports` (a block size, default 10), `merge` (`no-ff` | `squash`), the existing
  `.worktreeinclude` stays.
- Before running a command from the repository the first time, or after it changed, the
  hub asks; the approval is stored with the file's sha256.
- `setup` runs after the worktree is made; its log is one key away; `ROOST_PORT` and
  `ROOST_PORT_RANGE` give each workspace its own ports.

### M56 — verify before review

- `roost_task_done` on a task with a workspace moves it to `verifying` and runs `verify`
  in the worktree (with a timeout). Pass: `review`, the result on the card. Fail: back to
  `working`, and the failing output's tail is sent to the session as a message.
- Uncommitted changes at that point are a failure too ("commit your work first").
- `v` reruns verify by hand; without a `verify` command the task goes straight to review,
  marked "not verified".

### M57 — the workspace screen

- The screen sketched above: grouped by state, the detail pane (branch, agent status
  from pi's events, change, verify, setup, files), the context key bar, `?` for all keys,
  `n` jumps to the next task that needs you (review, conflict, failed, a waiting agent),
  `t` attaches to its session, `/` filters.
- Works at 80 columns (the detail pane goes below the list) and with the mouse.

### M58 — review in the TUI

- File list and diff (base to branch tip), syntax-free but with hunk and file jumps.
- `c` comments on a line; `r` sends all comments to the task's session in one message
  and moves the task back to `working`; `a` approves (on to M59).
- The same review from the CLI (`pi-roost review <task>`) for people who live in another
  terminal.

### M59 — local merge

- `a` (or `/tasks merge <id>`): refuse when the main checkout is dirty or not on base;
  `sync` the branch with base (rebase, or merge when the branch is shared); run verify
  again if base moved; merge into base (`--no-ff` by default, squash by config) in the
  main checkout; never push.
- A conflict is the `conflict` state: the main checkout is left as it was, the worktree
  keeps the half-done sync, and the screen offers "send to the agent", "I'll resolve it"
  (opens a shell there) and "abort".
- After the merge: teardown, worktree and branch removed by the existing safe cleanup,
  the task `merged`, dependents told they can start (M52's message).
- `P` sends it out as a pull request instead (push + `gh pr create`), only when asked.

### M60 — lifecycle and polish

- `S` shelve (worktree removed, branch and task kept; `enter` restores it), orphan
  cleanup with a dry run, importing worktrees made outside pi-roost.
- Notifications through pi-mobile when a task needs you.
- Optional: a warning when two working tasks change the same file.

## Out of scope

An editor or an IDE (the user's own tools open the worktree), containers or remote
machines, a web kanban, GitHub as a requirement.

## Order and releases

M54–M56 first (the loop without the new screen, usable from `/tasks`), release 0.1.17;
M57–M59 next (the screen, review, merge), release 0.1.18; M60 after. Each milestone:
its own branch, a design note, an independent review, merged by PR, `docs/porting.md`
updated at each release.
