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

## The cases

`evals/core.eval.ts`, pi through its worker:

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

## M41: the other agents

`evals/agents.eval.ts` runs what roost runs besides a pi worker, with the same real
model. A case says `agent: "term"` (pi itself as a terminal agent, through a profile:
`pi -ne --session-dir …`, the task as an argument, `--model`/`--thinking`, resume with
`--continue`, `working: "Working ─"`; its row is read from its screen), `agent:
"protocol"` (`evals/fixtures/pi_agent.py` on the Python client: each reply is one turn
of `pi -p --session …`, what pi printed is the report) or `fanout: [models]` (one task
per model, each in its own worktree, as `/fanout` does). A step may `stop` the job, and
wait for `stopped`. The outcome adds the screen, the row's texts in order, the agent's
hello (name, capabilities), the model, the command, and per fan-out session its
worktree's files and change.

| Case | Checks |
|---|---|
| fan-out | two sessions sharing one fan-out id, both done; each on its own `roost/` branch; each wrote the file in its worktree, the main tree untouched; `/compare`'s change (`worktreeChange`) sees one file each; two models |
| terminal agent | working, then done, seen from the screen alone; the first answer (42) on the screen; a typed reply answered (50); `stop`, then a reply starts it again with `--continue` and the answer (51) shows it kept its context; done, nothing pending |
| protocol agent | hello seen (name `pi-print`, capability `replies`); the first task came as a reply and was reported done; the report is the answer (42); the reply's answer (50) had the first turn's context; the model it reported; acked |

Results (2026-11-05, `anthropic/claude-haiku-5-5`, thinking low, 3 runs each):

```
PASS   fan-out          3/3  p50 7s   $0.0234
PASS   terminal agent   3/3  p50 25s  cost n/a
PASS   protocol agent   3/3  p50 5s   cost n/a
total 9/9
```

A terminal or protocol agent reports no cost (pi's worker does, through its extension);
the fan-out's is two sessions'. The terminal agent's 25 s are mostly settling: its row
is read from the screen, so each turn ends with 2.5 s of a still screen, and a resume
starts pi over.

## Next cases

A question answered by a reply (`blocked` → reply → done), once a case makes pi ask
reliably; a terminal agent's dialog seen as needing input (pi has none that a typed
reply answers; another agent's would need that agent installed).
