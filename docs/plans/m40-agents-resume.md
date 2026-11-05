# M40: interrupted runs and schedules for every agent

[M38](m38-resume.md) (a run cut short carries on) and [M39](m39-schedules.md) (scheduled
tasks) were for pi sessions. Now for the agents of [profiles](../profiles.md) too: a
terminal agent (level 0) and a protocol agent (level 1), and for plain commands where it
makes sense.

## Carrying on (`autoResume`)

| Agent | cut short mid-work (crash, kill, host gone, the machine or the service down) |
|---|---|
| pi session | as M38: started again, "Continue where you left off." |
| protocol agent | started again (its `resume` argv, else its command without the first task); "Continue where you left off." reaches it as a reply, after any reply still pending (M31 replays them) |
| terminal agent with `resume` | started with `resume`, the prompt typed in once it is quiet |
| terminal agent without `resume` | left failed, as before: a fresh start could not carry on (reply to start it again) |
| a plain command | left failed (a command is run once) |

The same budget and rules as M38: 3 times in a row after 1, 5 and 15 s, the row
`working` while it waits, stop or a reply calls it off. `resumable` on the dispatch and
the job record says a profile has `resume` (`buildProfileLaunch` sets it); a protocol
agent is always resumable, by the protocol's design (reports, replays, the `agent.json`
watermark).

## Schedules

`/schedule <name> <when> <task>` runs the task with the view's choices: a pi session as
before; with `/profile x` on, that agent (its model and thinking as chosen, no worktree);
a task starting with `!` is a command (`/schedule tests weekdays 18:00 ! npm test`). The
template is the dispatch the view would send (`launchProfile`, `launchShell`); nothing
to fill per run, each run is the command again. Lists show what runs (`agent`: `pi`,
`shell`, or the profile's name).

A scheduled terminal agent that is done and quiet is closed, as a pi run is (its row
stays; a reply starts it with `resume`). One that notifies when it finishes (Claude Code
does) shows as needing input instead, with the notification as the question, and
stays for you: attach or stop it. A command's row goes as a command's does.

## Checked

- Tests: a terminal agent with `resume` dying mid-work (restarted with `resume`, the
  prompt typed, done); one without (failed, not restarted); a protocol agent dying on a
  reply (restarted, "continue" taken as a reply); a schedule of a terminal agent (named
  after it, closed once done, the row kept) and of a command; a template with a worktree
  refused; `/schedule` in the view with a profile, with `!`, with the view's model.
- The stress run and the evals as before (pi's paths are untouched but for the shared
  finalize code).

## Not yet

- A terminal agent without `resume` could be started from scratch with its first task
  again; it is not (the task may have been half done).
