# M22: many pi windows, frequent switching

Reported with pi run in several herdr panes, switching between background sessions often:

1. a session freezes after switching: its screen stops and keys do nothing, while the
   agent view still shows it running;
2. rows stay stale: "needs input" long after the session went on in another window, a
   session moved to the background stuck on "starting…";
3. the model column shows `anthropic::claude…`, not the part that tells models apart.

## Causes

- **Ctrl+Z reaching the worker.** pi's Ctrl+Z stops its TUI, sends SIGTSTP to its process
  group and restarts the TUI on SIGCONT. A worker leads its own session in the PTY: its
  group is orphaned and the kernel discards SIGTSTP, so the TUI stays stopped for good
  while the agent loop runs on and reports. The client only took a chunk that was exactly
  `\x1a` or `\x1b[122;5u` as its detach key: Ctrl+Z among other bytes (fast typing, a
  multiplexer that batches input) or with lock bits (`\x1b[122;133u`, Num Lock) went on.
- **herdr's pane identity inherited.** M20 carries the whole environment, `HERDR_ENV`,
  `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` included: herdr's pi integration in a background
  worker reported that session's state into the pane the hub ran in.
- **One session, several jobs.** A session moved to the background again (from a pi in
  another window) got a new job beside its old, ended one (`fix-login`, `fix-login (2)`);
  the old row kept its last state, "needs input" included. A session reopened in another
  pi window left its ended job asking for input.
- **No push before the first report.** A pi row was pushed on reports only: until the
  worker's first report it showed "starting…".
- **Lost pushes.** A `list` reply and an event in the same chunk: the event was applied
  before the code after the await, which then replaced the rows with the older list.

## Changes

- `lib/attach.ts` `localDetachAt`: Ctrl+Z anywhere in a chunk, legacy, kitty CSI-u (any
  alternate keys, Caps/Num Lock, text, press or repeat), modifyOtherKeys; not inside a
  bracketed paste. The bytes before it still go to the session.
- worker: Ctrl+Z detaches (pi never suspends in the background).
- host: SIGCONT to the worker's group on every attach (a session stuck this way resumes);
  an attach taken over no longer types or resizes; `terminate-idle` (the reaper's and
  auto-close's stop) decides in the host whether someone is attached; a HELLO while the
  host is finishing gets `exit`; a mirror write that throws does not drop the client's
  output.
- daemon: `supersedeOthers` (a job on a session takes over the rows of the ended jobs on
  it, their name and pin; their records stay), `continuedElsewhere` (a foreground pi
  registering a session turns its ended job's "needs input" or failure into done), a push
  when a live job's worker pid appears.
- `HERDR_` joins the never-carried prefixes.
- agent view: one attach at a time; a 15 s resync; events after a list reply are replayed
  on top of it (`DaemonClient.requestAt`, `position`); listener errors no longer drop the
  rest of a chunk; `ensureLive`'s respawn times out after 20 s.
- Reporter: a failed request backs off (0.5 s doubling to 5 s) even for state changes.
- `shortModel` drops `vendor::` and Bedrock prefixes and `-vN:M` suffixes; `fitTail`.

## Tests

- `test/stress-attach.test.ts`: 60 rounds (600 with `STRESS=1`) of attach, takeover,
  abrupt drops, resize storms, two attaches at once and clients that stop reading against
  a worker that streams, echoes and handles SIGUSR2; a flood into a client that never
  reads; detach/attach bursts; one PTY switching between two sessions with Ctrl+Z, keys
  typed before and with it (40, 300 with `STRESS=1`); a worker that suspends itself as pi
  does is resumed by the next attach (fails without the host's SIGCONT).
- daemon: rows taken over, continued elsewhere, pid pushed before a report.
- reporter back-off, client stream order, detach key encodings, model names, herdr env.
