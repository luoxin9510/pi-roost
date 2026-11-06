# M60: optional exits

The last step of the [roadmap](ade-roadmap.md): the loop ends in a local merge; a pull
request is an exit a person may take instead, and the overlay says when two tasks at
work change the same files.

## Use

```text
/tasks pr <id>     (overlay: o, then y) push the task's branch and open a pull request
                   into its base: shown first, done by the same command again within 30 s
```

## Behaviour

- `task pr` (a person's: the hub, the CLI, a pi session's `/tasks`; never a session's, the
  concierge's or a protocol agent's), from review only, with a clean worktree. The dry
  call says what it will do (`push roost/t4-… (abc12345) and open a pull request into
  main`) and returns the branch tip; the confirmation carries it, and the daemon refuses
  (`conflict`) if the branch moved in between.
- The remote is `origin`, else the only one (several and none named origin: refused).
  `git push --set-upstream <remote> refs/heads/<branch>:refs/heads/<branch>` (never
  forced), then `gh pr create --head <branch> --base <base> --title <the task's title>
  --body <its detail, its result, whether verify passed, "Task #N, opened by pi-roost">`
  in the worktree. A failure says which step (the push or gh) and git's or gh's words.
- The task stays in review (`workspace.pr = {url, tip, at}`, note `pull request: <url>`):
  the pull request is a way out, not a stage. Merged on the forge and pulled into base,
  the branch is found merged by hand (M59) when the board is next listed.
- Overlap (`overlaps`, `lib/workspace-view.ts`): tasks of one repository at work at once
  (working, verifying, in review, to fix) that change the same files, from what the
  overlay read of each worktree (renames by their new name). A row gets `⚠`; the detail
  says `overlap #6 changes src/rate.ts too`.

## Not in M60

A port range per workspace (`ROOST_PORT`): the roadmap left it "if setups need it by
then"; none has. The pull request's status after it is opened (M16 shows a session's
pull requests, not a task's).

## Tests

- `test/comms.test.ts`: refused before review and for a session; the dry note; a wrong
  hash refused; a real push to a bare remote and a fake `gh` on the PATH (its arguments,
  the body); the task keeps its stage and records the pull request.
- `test/workspace-view.test.ts`: overlaps (same repository only, renames, merged tasks
  left out); the detail's overlap and PR lines; `o` on a task in review.
- `test/agent-view.test.ts`, `test/tasks-command.test.ts`: `/tasks pr` twice; `o` then `y`.
