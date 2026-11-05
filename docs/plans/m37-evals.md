# M37: evals with real models

The third layer of [measuring roost](evals.md). `npm run eval` runs roost's behaviour
with a real model, end to end, and grades what roost saw. It costs model money (cents on
the default model); it is not part of `npm test`.

```
npm run eval                                   # each case once, the default model
npm run eval -- --runs 5                       # five runs each: pass rates, flaky cases
npm run eval -- --model anthropic/claude-sonnet-5-5 --thinking medium
npm run eval -- --only steer                   # cases whose name contains "steer"
```

## How a case runs

`evals/harness.ts` (`runCase`): each case gets a roost of its own (a temporary home,
runtime and config directory, its own daemon) and a workspace with the case's files
(optionally a git repository). pi runs through its worker, loaded from this checkout
(`pi -ne -e extensions/index.ts`), as the hub starts it: a `dispatch`, then replies when
the case's steps say so (`{when: "working" | "blocked" | "done", reply, mode, afterMs}`),
with request ids, and the row followed through the daemon's events until it settles (nothing
of the case's, its subagents included, working for 3 s, no reply pending) or the case's time runs out.

pi's own directory is a fresh one too (`PI_CODING_AGENT_DIR`): the user's settings,
system prompt, extensions and skills would make the runs theirs. Its `auth.json` is a
link to the user's, not a copy: pi writes refreshed login tokens through it, and a copy
would rotate a token the user's own pi still holds.

Roost's directories are set under both spellings (`ROOST_*` wins over `PI_ROOST_*`), and
the case checks that the socket answers for the daemon it started: a user's own
`ROOST_HOME` must never point a case, and its cleanup, at the user's roost. A case ends
with everything it started stopped (its jobs, its daemon, any host or worker left),
whatever happened; requests to the daemon have time limits.

What comes back (`RoostOutcome`): the row's states in order (with the replies sent
between them), the final row, the transcript, the last answer, the workspace's files,
the subagents (rows whose parent session is the case's), the replies still pending,
cost and tokens of everything the case ran (pi's usage, cache included), the time, and
reply ack latency from roost's telemetry.

## Grading

Deterministic: `checks(name, {check: (outcome) => boolean})` is a `vitest-evals` judge
whose score is the share of checks that pass and whose rationale names the ones that
fail. A case that did not finish (timed out, the daemon did not start) scores 0: it is
counted as not scored, not as a pass. Checks match words no sentence has by chance
(`SLEPT-4X`, a random token), as written, in the last answer. No model judges another.

`evals/run.ts` writes `evals/.runs/<time>/`: `protocol.json` (model, thinking, runs),
`observations.jsonl` (one line per run: score, failed checks, error, states, cost,
tokens, time, the answer), `report.json` and `report.txt` (per case: passed/runs,
flaky when some runs pass and some fail, the checks that failed and how often, errors,
cost, time p50). A report of one run each says it is not a measure of stability.

## The cases (`evals/core.eval.ts`)

| Case | Checks |
|---|---|
| task to done | the row ends done; working came before done; the file has exactly the content asked; a cost was reported |
| reply continues | done; the first answer (42) is in the transcript; the reply's answer (50) uses the session's context; the reply was acked |
| steer | a steer sent 4 s into a 12 s `sleep` is taken in the same run (one done after it, not two); the sleep ran and the last answer has both the work's word and the steer's; acked |
| subagent | `roost_spawn` starts exactly one child; it ends done; the child reads a random token from a file the parent is told not to read (and does not); the parent's last answer has the token |
| interrupted (M38) | the pi worker is SIGKILLed 6 s into a 15 s `sleep`; it is restarted once by itself and the work is finished (the file written) |

## First results (2026-11-05)

`anthropic/claude-haiku-5-5`, thinking low, 3 runs each:

```
PASS   task to done     3/3  p50 5s
PASS   reply continues  3/3  p50 6s
PASS   steer            3/3  p50 17s
PASS   subagent         3/3  p50 6s
total 12/12
```

Under a cent for the whole run. What a first run showed and was fixed: the user's pi
settings reached the cases (they answered in the user's language), so pi's directory
is isolated now; token counts left out cache and the subagents' use. The review found
that a user's `ROOST_HOME` would have reached the user's roost, that the run could
settle before a subagent reported, that checks matched any "child" or "done", and that
a run that threw left its daemon and environment behind; all fixed.

## Next cases

From [the plan](evals.md): fan-out over two models and `/compare`'s data; a level 0
agent (dialog seen as needing input, a typed reply, resume); a protocol agent driven by
a model; a question answered by a reply (`blocked` → reply → done), once a case makes
pi ask reliably.
