# M39: scheduled tasks

The second durable-inspired piece of [any agent](any-agent.md): a task that runs on a
schedule, owned by the background service, so it runs whether or not a pi or a hub is
open.

## Use

```text
/schedule <name> <when> <task>
/schedule                         list (next run, last run, why one was skipped)
/schedule run|pause|resume|rm <name>
pi-roost schedule [list] | run|pause|resume|rm <name>
```

`when`, local time: `every 30m` (`m`, `h`, `d`; one minute at least), `daily 09:00`,
`weekdays 09:00`, `cron "<minute hour day-of-month month day-of-week>"` (lists, ranges,
steps; Sunday 0 or 7; day of month and day of week both given: either, as cron does).

## How

- `lib/schedule.ts` (node only): parsing, the next run, the `/schedule` line, and a run's
  dispatch: the template's `{{run}}` replaced by a session file name as pi names one
  (`<ISO time>_<uuid>`).
- The template is made where pi is known (`adapters/pi/hub-options.ts`
  `scheduleLaunch`): the dispatch the view would send for the task, with the view's
  model, thinking level and directory (a preset's directory included), its session
  file `<that directory's pi session folder>/{{run}}.jsonl`, no worktree.
- The daemon keeps `schedules.json` (one writer, durable writes) and checks every 15 s
  (`PI_ROOST_SCHEDULE_TICK_MS`). Ops: `schedules`, `schedule-add`, `schedule-rm`,
  `schedule-pause`, `schedule-run` (`lib/protocol.ts`). A run is a `dispatch` named after
  the schedule, its job marked `schedule` (rows carry it).
- The next run is set before a run starts, so a slow start is never run twice. `every`
  counts from when the schedule was made (or resumed): a run after a gap goes to the next
  slot, never a burst.
- Local time without going back: in the hour a DST change repeats, the next run is
  always ahead (steps in epoch time; a run is never set to less than a second ahead).
  On a spring-forward day a time that does not exist (02:30) runs the next day.
- One run starting at a time per schedule (two requests at once: the second is busy).
- Only the session file's own argument is filled: a task that says `{{run}}` is left as
  written. A hand-edited `schedules.json` has what it lacks made good on load.
- Skipped, and said in `lastSkip`: a due run while the previous one is still working
  (starting, working, or waiting for its automatic restart, M38). A finished run whose
  worker is still up does not count; that worker is closed once done, as a subagent's.
- Off when due: on start, a schedule whose run fell due runs once (`catchUp`, the
  default), or moves to its next run.

## Checked

- `test/schedule.test.ts`: cron fields and errors, next matches across weekends, month
  and year ends, 29 February, either-day rule, never; `when` forms; `every` from its
  anchor; the run slot and template checks; the `/schedule` line; times shown.
- `test/daemon.test.ts`: add, list, pause, resume, rm and refusals; run now (its own
  session file, named after the schedule, never two at once); due runs on the tick;
  catch-up at start or not; kept across a restart, paused ones not run; a finished run
  with its worker up not holding the next one, and its worker closed.
- In a real terminal (tmux, the standalone hub, an isolated roost and pi directory with
  this checkout installed): `/schedule tick every 1m <append the UTC time to ticks.txt>`
  from the view, runs on haiku every minute, a catch-up run after the service was
  stopped and started, the rows named `tick`, `tick (2)`, ..., closed when done.
  The first try found that a finished pi run keeps its worker up (idle), which the
  scheduler took for still running: only `working` holds a run now, and finished runs
  are closed. The review found a cron next run landing an hour in the past in the hour
  DST repeats (it would have run on every tick), two runs at once, `{{run}}` in task text
  and `*/n` in the day rule: fixed, with tests (America/New_York).

## Not yet

- Scheduled commands and terminal agents (pi sessions only).
- A worktree per run, a fan-out per run.
- Rows of past runs go as other rows do (`cleanupDays`).
