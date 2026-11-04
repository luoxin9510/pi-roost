# M16: pull request status and "Ready for review"

Status: implemented (2026-11-04). Ported from Claude Code's agent view (PRD P2 row
deferred in M7: "needs a forge integration"; M10 gave sessions their own branches).

| Claude Code (docs) | pi-roost |
|---|---|
| `#1234` at the row's right edge, linked to the pull request (OSC 8; `FORCE_HYPERLINK=0` for plain text) | same (`lib/pr.ts` `prLabel`, `hyperlink`) |
| Colour: yellow waiting on checks or review, or checks failed; green checks passed and no review blocking; purple merged; grey draft or closed | `warning` / `success` / `accent` / `dim` theme tones |
| Several pull requests: `3 PRs`, coloured by the one that most needs attention; the peek lists them | same; the peek shows `#N status · needs review · title` |
| Linked when `gh pr edit/comment/close/ready` output names one; after `gh pr checkout` or a push, the branch is looked up with `gh pr view`, retried after up to five later git/gh/glab/curl commands | the worker watches `bash` tool calls (`extensions/pr-links.ts`, also inside codemode); `gh pr create/reopen/review` count as naming too |
| — | a worktree session's own branch is also looked up by the daemon (`gh pr list --head <branch>`) |
| "Ready for review": an open pull request that needs review or has failing checks | the group between Pinned and Needs input: a session not working or waiting whose open, non-draft pull request has failing checks or is not approved |
| `#1234` or a URL in the input selects the session working on it, else is a task | the same: a filter when a row has it, a dispatch otherwise; `s:ready` filters the group |
| `!N` GitLab merge requests (glab) | not ported |

## How status is kept

- The worker sends `prLinks` (URLs) in its reports; the daemon keeps their union in
  `state.json` (at most 20).
- Every 60 s (`PI_ROOST_PR_POLL_MS`) the daemon runs `gh pr view <url> --json
  number,url,state,isDraft,reviewDecision,statusCheckRollup,title` for sessions active in
  the last 7 days or live, one call at a time; merged and closed ones once an hour. A
  changed result is stored as `state.prs` and pushed as the row's `prs`.
- No `gh`, or not authenticated: no labels, nothing else changes (checked again after
  10 minutes).

## Review decisions

- A poll round runs at most a minute and goes on where the last one stopped; state is
  read again after each gh call, and the poll writes only its own fields.
- Merged and closed pull requests are asked about once an hour (per URL).
- A worktree branch is looked up at most every 10 minutes while it has no link.
- `#N` matches by number; a URL by host, owner, repository and number, whatever the
  scheme, case or trailing path (`/files`, `#discussion…`).
- Links to `localhost`, bare addresses and `.local` / `.internal` hosts are ignored.
- A cancelled check run is not a failure.
- Limits: the branch lookup runs in the session's directory, so a `cd elsewhere && git
  push` is looked up there; codemode's nested `bash` calls are seen, other shell tools are not.
