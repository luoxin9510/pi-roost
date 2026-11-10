# M78: no orphans

## Problem

The daemon and the hosts are built to outlive their parent (M38: a restart of the daemon
resumes hosts that kept running). Tests and the stress runner relied on teardown code that
never runs when the run is killed or interrupted. Found 2026-11-10: 60 daemons (about 3 GB)
from a vitest run and 150 hosts plus 150 stress agents (about 14 GB) from a stress run, all
with ppid 1, days old.

## Three layers

1. **Follow a parent (test mode).** `PI_ROOST_PARENT_PID` is set by the tests and the stress
   runner only. The daemon checks every 2 s (unref'd timer) that the pid is alive
   (`kill(pid, 0)`); gone, it runs `shutdown(false)`: the clean shutdown, hosts terminated too.
   The daemon's environment reaches the hosts it spawns, so a host follows the same pid: gone,
   it kills its worker's process group and exits.
2. **Sweep before a run.** The vitest `globalSetup` (`test/support/global-setup.ts`) and the
   start of `stress/run.ts` call `sweepOrphans` (`lib/orphans.ts`): a process whose command is
   a `daemon/main.ts`, `host/main.ts` or `stress/agent.ts`, that carries a test marker
   (`PI_ROOST_PARENT_PID`, or `PI_ROOST_HOME` as `<tmp>/roost-*`), and whose followed parent is
   not alive, is killed (with a host's children). The environment is read from
   `/proc/<pid>/environ` (Linux) or `ps eww` (macOS); where unreadable the process is skipped.
   Never a process without a marker, never one whose parent is alive (another run). A process
   marked by its home only (started by code from before M78, perhaps in another checkout) is
   killed only once it is an orphan (parent pid 1): with a live parent it is a run in progress.
3. **Home gone, exit.** The same timer, armed only with `PI_ROOST_PARENT_PID`: a daemon whose
   `PI_ROOST_HOME` was deleted shuts down as in 1.

## What normal use keeps

Without `PI_ROOST_PARENT_PID` no timer is armed and nothing is swept: daemon and hosts
outlive their parent as before, and the user's daemon (`dist/daemon/main.js`) is never matched.

Tests: `test/orphans.test.ts`.
