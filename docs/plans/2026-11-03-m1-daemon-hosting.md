# M1 — Daemon + hosting: implementation plan

PRD: "PRD: pi-agents — Claude Code Agent View for pi" (Claude Docs,
https://claude.ai/artifact/DWnqP1UEbxufkPeLDiqHv8). M1 scope: DM-1…DM-3,
DM-6, DM-8 (writer lock), PTY host, `pi-roost attach|logs|stop|rm|--json`,
`pi-roost daemon status|logs|stop [--keep-workers]`, `pi --bg`.
M0 findings: `spikes/REPORT.md`.

**Acceptance:** `pi --bg "list files"`, close the terminal, `pi-roost attach
<id>` in a new terminal shows the live session; `pi-roost --json` shows it.

## Decisions (made for M1, revisit if they hurt)

- Package and CLI are named `pi-roost` (npm `pi-agents` is taken).
- State root `~/.pi/agent/roost/` (not `agents/`, to avoid colliding with
  other packages). Override with `PI_ROOST_HOME` (tests use it).
- Runtime dir for sockets: `$XDG_RUNTIME_DIR/pi-roost`, else
  `/tmp/pi-roost-<uid>`, mode 0700. Override `PI_ROOST_RUNTIME_DIR`.
  Keep paths short: macOS `sun_path` is 104 bytes.
- `daemon/`, `host/`, `bin/` and `lib/` are compiled by `tsc` to `dist/`
  (Node refuses type stripping under `node_modules`). The extension stays
  `.ts` and is loaded by pi; it imports `lib/*.ts` directly. Source uses
  `.ts` import specifiers; `rewriteRelativeImportExtensions` emits `.js`.
- No enums, namespaces or parameter properties (erasable syntax only), so
  lib code also runs under Node type stripping and pi's loader.
- Attach repaint: on attach the host nudges the PTY size (rows-1, then
  rows) so the worker repaints in full. No serialize addon.
- M1 has no worker role yet (M2). State comes from the process only:
  alive → `working`; exit 0 → `done`; non-zero → `failed`; stopped by us →
  `stopped`.
- Env names from the PRD: `PI_JOB_ID`, `PI_JOB_TOKEN`, `PI_DAEMON_SOCK`,
  `PI_JOB_DIR`.

## Files

```
lib/paths.ts      roostHome(), runtimeDir(), jobDir(id), daemon/host socket paths; ensureDirs()
lib/atomic.ts     writeFileAtomic(path, data, mode=0o600), writeJsonAtomic, readJson<T>(path): T | undefined
lib/proc.ts       isAlive(pid), processStartToken(pid): string | undefined (ps -o lstart=), sameProcess(pid, token)
lib/locks.ts      acquireDaemonLock / releaseDaemonLock; acquireWriterLock(file) / releaseWriterLock(file) / readWriterLock(file)
lib/ids.ts        newJobId() 8 hex, newToken() 32 hex
lib/store.ts      JobRecord (job.json), JobState (state.json), ExitRecord (exit.json); create/read/update/list/remove
lib/framing.ts    host socket binary frames: encode(type, payload) / FrameDecoder
lib/protocol.ts   control-socket NDJSON request/response/event types
lib/client.ts     DaemonClient: connect(), connectOrStart(), request(op, args), subscribe()
lib/attach.ts     attachToHost(sockPath, io): raw passthrough, resize, local detach key
host/main.ts      PTY host process (one per job)
daemon/main.ts    daemon process
bin/pi-roost.ts   shell CLI
extensions/index.ts  --bg flag, writer lock
test/*.test.ts    vitest
```

## Data shapes

```ts
// job.json — immutable launch record (PRD §8.2)
interface JobRecord {
  id: string; name: string; cwd: string;
  sessionFile: string;            // may not exist yet: pi writes lazily
  command: string[];              // full argv: [execPath, piCli, ...args]
  env: Record<string, string>;    // allow-listed env captured at dispatch
  model?: string; thinking?: string;
  origin: "bg" | "dispatch" | "adopt" | "fork";
  createdAt: number;              // ms epoch
  piVersion?: string; roostVersion: string;
}
// state.json — daemon-owned, unknown fields preserved on update
interface JobState {
  state: "working" | "blocked" | "done" | "failed" | "stopped";
  hostPid?: number; hostToken?: string;   // processStartToken of the host
  workerPid?: number;
  startedAt: number; endedAt?: number; updatedAt: number;
  pinned?: boolean;
  [k: string]: unknown;
}
// exit.json — written by the host when the worker exits
interface ExitRecord { code: number | null; signal: string | null; at: number }
```

`--json` row (PRD §6.10): `{ id, cwd, kind: "pi", startedAt, state, pid,
status, waitingFor, sessionFile, name }`; `status`/`waitingFor` are `null`
in M1.

## Host socket framing (`lib/framing.ts`)

Frame = `u8 type | u32be length | payload`. Types:

| type | dir | payload |
|------|-----|---------|
| 1 HELLO | c→h | JSON `{ role: "attach" \| "control", cols?, rows? }` |
| 2 DATA | both | raw bytes (attach only) |
| 3 RESIZE | c→h | JSON `{ cols, rows }` |
| 4 DETACHED | h→c | JSON `{ reason: "takeover" \| "exit" \| "request" }` then close |
| 5 CONTROL | c→h | JSON `{ op: "snapshot" \| "status" \| "detach" \| "terminate" }` |
| 6 REPLY | h→c | JSON reply to CONTROL |

`FrameDecoder.push(buf)` returns complete frames and keeps partial ones.
Max frame 16 MiB; larger → error.

## Host (`host/main.ts`)

`node dist/host/main.js <jobId>`; reads `job.json`; started detached by
the daemon (`spawn(..., { detached: true, stdio: "ignore" })` + `unref`).

1. `chmod +x` node-pty's `spawn-helper` if it lost it (known npm issue);
   spawn `command` in a PTY (`cwd`, `env` + job env vars, `TERM`
   xterm-256color, 120x30 until first attach).
2. Mirror output into `@xterm/headless` (scrollback 1000). Every 2 s while
   dirty and on exit, write `screen.txt` (visible buffer as plain text,
   trailing blank lines trimmed) atomically.
3. Listen on `host-<id>.sock` (unlink stale first, mode 0600).
   - one attach client at a time; a new attach sends the old one
     `DETACHED {reason:"takeover"}` and closes it (AT-6);
   - attach: apply HELLO cols/rows, nudge resize for a full repaint, then
     pipe DATA both ways; RESIZE → `pty.resize`;
   - control: `snapshot` → `{ text }`, `status` → `{ workerPid, alive,
     attached, cols, rows }`, `detach` → kick the attach client
     (`request`), `terminate` → SIGTERM worker, SIGKILL after 5 s.
4. Worker exit: write `exit.json`, flush `screen.txt`, send attach client
   `DETACHED {reason:"exit"}`, close server, unlink socket, exit 0.
5. Host never dies from a client error (catch per socket).

## Daemon (`daemon/main.ts`)

1. DM-1 single instance: `acquireDaemonLock()` writes
   `roost/daemon.lock` with `{ pid, token, version, socket }` via
   O_EXCL; if present and `sameProcess(pid, token)`, exit 0 (already
   running); else stale → replace.
2. DM-3 listen on `<runtime>/daemon.sock` (0600), NDJSON. Request
   `{ id, op, args }` → `{ id, ok: true, result } | { id, ok: false,
   error }`. Pushed events `{ event, job }` to subscribers.
3. Ops: `ping`, `list {all?, cwd?}`, `dispatch {cwd, sessionFile, command,
   env, name, model?, thinking?, origin}` → `{ id, name }`,
   `stop {id}`, `rm {id}`, `status`, `shutdown {keepWorkers?}`,
   `subscribe`, `resolve {query}` (id prefix or name substring → id;
   ambiguous → error listing matches).
4. Dispatch: refuse when `readWriterLock(sessionFile)` names a live
   process (AT-7/DM-8, error `locked`). Create job dir, `job.json`,
   `state.json {working}`, spawn host, record `hostPid` + token in
   `roster.json` and state. Duplicate names get ` (2)`, ` (3)`.
5. Watch hosts: poll every 1 s (`isAlive(hostPid)`); when a host is gone,
   read `exit.json` → `done` / `failed` / `stopped` (if we asked it to
   stop), set `endedAt`, drop from roster, push event.
6. `stop`: control `terminate`, mark intent; `rm`: stop if live, then
   delete the job dir. `list` returns every job; the CLI applies the
   48 h cut-off for `--json` without `--all`.
7. DM-6: on start, read `roster.json`; for each entry still alive
   (`sameProcess`) keep it; else finalize as in 5.
8. `shutdown {keepWorkers}`: without it, terminate every host first.
   Release lock, unlink socket, exit.
9. Log: JSONL `roost/daemon.log` (`{ t, level, msg, ... }`).
10. Daemon idles forever; no auto-exit in M1.

`lib/client.ts` `connectOrStart()`: try the socket; if refused/missing,
spawn `node dist/daemon/main.js` detached, wait up to 3 s for `ping`.

## CLI (`bin/pi-roost.ts`, `#!/usr/bin/env node`)

- `pi-roost attach <id|name>` — resolve, read socket path, `attachToHost`.
  Detach on local Ctrl+Z (`0x1a`, or kitty `CSI 122;5u`), on
  `DETACHED`, or when the host closes. Prints `detached · <id>` /
  `session ended · <id>`.
- `pi-roost logs <id|name>` — live host: control `snapshot`; else
  `screen.txt`. Print to stdout.
- `pi-roost stop|rm <id|name>`
- `pi-roost --json [--all] [--cwd d]` — JSON array of rows (stdout only).
  Without `--all`, hides rows that ended more than 48 h ago.
- `pi-roost daemon status|logs|stop [--keep-workers]` — status prints
  version, socket dir, live job count, node-pty load error if any.
- Exit codes: 0 ok, 1 error (message on stderr), 2 usage.

`lib/attach.ts`: stdin raw + binary (`setEncoding` not set when run from
the CLI; in pi the caller must undo pi's utf8 mode — M0 R2), HELLO with
`process.stdout.columns/rows`, SIGWINCH → RESIZE, restore raw mode and
reset kitty/bracketed paste/mouse/modifyOtherKeys on detach (AT-4:
`\x1b[<u\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4;0m\x1b[?25h`).

## Extension (`extensions/index.ts`)

- `pi.registerFlag("bg", { type: "string" })`,
  `pi.registerFlag("bg-name", { type: "string" })`.
- `session_start` with `--bg <task>`:
  - not interactive (`!ctx.hasUI`, i.e. `-p`/json/rpc) → print error, exit 1;
  - session file: the current one if `--session` was given and it holds
    messages (continue as a job), else a fresh path from
    `SessionManager.create(ctx.cwd).getSessionFile()` (lazy, no file yet);
  - command: `[process.execPath, process.argv[1], "--session", file,
    ...passthrough, task]` where passthrough = `--model`, `--thinking`
    and every `-e/--extension <path>` from `process.argv` (dev loading);
  - env: allow-list (`PATH HOME USER SHELL LANG LC_* TERM COLORTERM
    HTTP_PROXY HTTPS_PROXY NO_PROXY` + upper/lower case variants);
  - release our own writer lock first (the current process will exit),
    `connectOrStart()`, `dispatch`, print on exit (M0 R1):
    `backgrounded · <id> · <name>` and the four hints
    (`pi-roost attach|logs|stop <id>`, `pi-roost --json`), then
    `ctx.shutdown()`.
- Writer lock (DM-8): on `session_start` acquire `<session>.lock` for the
  session file unless `PI_ROOST_SCRATCH` is set; if a live process holds
  it, `ctx.ui.notify` a warning (M1 does not block). Release on
  `session_shutdown`. Lock contents `{ pid, token, at }`.
- Worker processes (env `PI_JOB_ID` set) do the same lock handling; the
  rest of the worker role is M2.

## Tasks

1. **Build setup** — deps (`node-pty`, `@xterm/headless`; dev `vitest`),
   `tsconfig.build.json` (emit to `dist/`, `rewriteRelativeImportExtensions`,
   `erasableSyntaxOnly`), scripts `build`, `test`, `check`. `bin` field
   `pi-roost: dist/bin/pi-roost.js`; `files` includes `dist`.
2. **lib core** — paths, atomic, proc, ids, locks, store + unit tests
   (temp `PI_ROOST_HOME`).
3. **framing + protocol** + unit tests (split frames, multiple frames per
   chunk, oversize).
4. **host** + integration test: job whose command is `sh -c 'echo hi;
   read x; echo got:$x'`; attach, see `hi`, send `abc\r`, see `got:abc`,
   exit.json code 0, screen.txt contains `got:abc`; takeover test.
5. **daemon + client** + integration test: start daemon with temp dirs,
   dispatch fake job, list shows `working`, job ends → `done`; stop →
   `stopped`; locked session refused; daemon restart re-adopts a live job
   (DM-6); shutdown keepWorkers leaves the host alive.
6. **attach lib + CLI** + tests for `--json`, `resolve`, `logs` (fake jobs).
7. **extension** — `--bg`, writer lock. Type-check; manual run.
8. **E2E acceptance** in tmux with real pi: `pi -e extensions/index.ts --bg
   "<cheap prompt>"`, kill the tmux window, new window `pi-roost attach`,
   `--json`. Record results in `docs/plans/m1-acceptance.md`.

Each task ends with `npm run check && npm test` green and one commit.
