# M35: the stress run, and what it found

The second layer of [measuring roost](evals.md). `npm run stress` (`stress/run.ts`): a
real daemon and real hosts in an isolated home, fake agents on the TypeScript client
(`stress/agent.ts`), no model cost.

- Scenarios: `sessions` (N agents dispatched at once, M hubs watching), `replies`
  (K replies to each, the jobs at once), `chaos` (the daemon SIGKILLed and restarted
  mid-storm, a tenth of the hosts SIGKILLed, a hub that never reads, then replies to the
  killed jobs), `soak` (the storm repeated for minutes, memory and descriptors watched).
  Sizes: `--jobs 50 --replies 20 --hubs 3 --soak-minutes 10 --work-ms 0`.
- Invariants: every reply handled exactly once and in order (a reply whose request
  failed in the chaos and was sent again may be handled twice: counted, not failed), the
  killed jobs seen as ended and started again by a reply, every job stopped at the end,
  no host or socket left.
- Measured: client-side dispatch, reply deliver and ack latency (telemetry), event lag at
  the hubs, per-op times, daemon RSS, CPU and descriptors. Budgets in the file; over
  budget fails the run. Report and telemetry in `stress/.runs/<time>/`.

## What it found (50 agents × 20 replies, 3 hubs, macOS)

| | before | after |
|---|---|---|
| reply op, p50 | 237 ms | 8 ms |
| reply received → acked, p50 / p95 | 1073 / 1683 ms | 25 / 30 ms |
| event lag at a hub, p50 | 1414 ms | 26 ms |
| 1000 replies, all handled | 21.8 s | 5.2 s |
| report op, p50 | 17 ms | 1 ms |

1. **A `ps` per job on every host check.** `checkHosts` verified each live host's start
   token with a synchronous `ps`: 50 jobs, 50 processes in a row, the loop blocked. Now a
   live pid is its host, rechecked at most every 30 s; the start token is read
   asynchronously when a host starts.
2. **An fsync per state write.** Every report, reply and ack rewrote `state.json` with a
   file and a directory fsync (about 8 ms on macOS), on the daemon's loop: about 125 state
   writes a second, and every event waited behind them. Now a worker's report is written
   atomically without fsync (the next report replaces it), what must survive a crash
   (pending replies, user choices, how a job ends) is durable, and the daemon syncs those
   in groups off the loop (`deferDurability`, `durable()`), answering a request only once
   its writes are on disk. Acks are not durable: a lost one means a resend, dropped by seq.
3. **A restarted agent redid a finished reply.** When an agent died after handling a
   reply but before its ack reached the daemon, the new process handled it again. The
   clients now keep the last finished seq in the job's `agent.json` (before the ack) and
   skip what it covers.
4. **Replies resent after a lost response are handled twice** (46 of 2050 in a chaos
   run): the daemon took the request, its answer was lost with the daemon, the client sent
   it again. Not fixable without request ids: the next item of the plan.

After review: a failed background sync no longer poisons the ones after it (each batch
answers for itself, at most 32 files open at once, failures logged); a state file that a
machine crash left empty (reports are written without fsync) is rebuilt at start from
the job's record, failed and startable, instead of the job disappearing.

Checked by: the stress run itself (green at the default size), unit tests for group
commit, a daemon test for a restart after a lost ack, the suite.
