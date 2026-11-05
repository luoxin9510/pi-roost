# M38: interrupted runs carry on

The first of the durable-inspired pieces of [any agent](any-agent.md): a run that was cut
short is not left for the user to notice; it carries on by itself, a bounded number of
times.

## Before

- A worker that crashed mid-run (non-zero exit) was restarted once.
- A host gone under a running job (killed, out of memory) failed it ("host vanished").
- A run cut by the machine or the service going down failed, waiting for a reply.
- A worker killed by a signal showed as **done**: node-pty reports it as exit code 0 with
  the signal's number, and only the code was read. Found by the new eval (below).

## Now

`autoResume` in the user's `roost.json`:

| | restarts by itself |
|---|---|
| `"interrupted"` (default) | a worker crash or kill mid-run; a host gone under a working run; a run that was working when the machine or the service went down, if its last progress is within 6 hours |
| `"crash"` | worker crashes and kills mid-run only |
| `"off"` | nothing |

A restart sends "Continue where you left off." to the session (a session pi never wrote
runs its first task again). The budget: 3 automatic restarts in a row, after 1, 5 and
15 s (`PI_ROOST_RESUME_DELAYS_MS`); a turn that ends normally once the worker has been up
a minute gives it back. Past it, the row fails with why ("not restarted again after 3
automatic restarts in a row (reply to continue)").

While a restart waits, the row stays **working** (no "finished" notification for a run
that is still meant to go on) and says so ("worker killed by SIGKILL; continuing in 5 s
(automatic restart 2 of 3)"). `resumeAt` is kept in the job's state as a durable write:

- `stop` calls it off (the row is stopped); `rm` too.
- A reply, Enter twice, `respawn`: any start takes its place (with the reply instead).
- The service going down while it waits: the next start takes it up.
- A restart that cannot start (the session locked by another pi, its directory gone)
  fails with the reason and is not tried again.

Exits read as crashes now: a non-zero code or a signal (`killed by SIGKILL`); for
commands and terminal agents too.

pi jobs only. Terminal agents (level 0) and protocol agents are started as commands; a
restart of theirs would type or send a prompt into an agent roost knows less about, so
they keep failing as before (a later step).

## Checked

- Tests: a crash loop restarted 3 times then failed; `off` restarts nothing; a host
  that died while the service was down resumed with "Continue where you left off."; a host
  killed under a working run restarted (`crash`: failed); stop while a restart waits; a
  restart pending across a service restart; a reply while one waits; signal deaths read as
  failures. 360 tests.
- Eval, real pi on haiku: the worker SIGKILLed 6 s into a 15 s `sleep`; restarted once,
  pi saw the interrupted tool call, ran it again, wrote the file: 3/3.
- Stress: first run of the branch showed 1000 replies in 8 s instead of 5 and hub event
  lag p95 ~1000 ms instead of ~100: every idle report wrote `crashRestarts: 0`, which
  had been made a durable key (an fsync per report). It is written only when there is a
  count, and is not durable (losing a reset to a crash only leaves fewer restarts).
  After: 4.8 to 4.9 s, p95 119 to 142 ms, as main.
