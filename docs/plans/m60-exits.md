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
  main`) and returns a hash of the branch tip and where it goes; the confirmation carries
  it, and the daemon refuses (`conflict`) if either changed in between.
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

## After review

- What goes is what was shown: the push is of the commit shown (`<tip>:refs/heads/<branch>`),
  not of whatever the branch is when the push runs (a session still alive could commit
  in between).
- Where it goes is shown: the remote's name and its push URL (`git remote get-url
  --push`, so `pushurl` and `insteadOf` count: an agent can edit `.git/config`), and the
  repository gh opens the pull request in (`--repo`, read from that URL; "gh picks" when
  it is not a forge URL). The confirmation's hash covers the tip, the remote and both
  URLs.
- A remote whose name could be read as an option (`-…`, or characters git names do not
  use) is refused; the push puts `--` before it.
- A pull request gh says exists already (or opened before gh was cut short) is found
  (`gh pr view <branch>`) and recorded, so a second try after a failure succeeds.
- Only an `https://` URL without control characters is recorded; text from git, gh and
  hooks is cut to one line without control characters (C1 too, in the hub's filter).
- After the push, the note is set only if the task is still in review.
- Stated, not changed: `git push` runs the repository's `pre-push` hook (an agent in the
  same account could write one, as it could any program); the push carries every commit
  of the branch the remote lacks, base's local ones included.
