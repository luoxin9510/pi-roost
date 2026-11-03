# M0 spike report

Run on 2026-11-03 against stock pi 1.5.0 (npm global, Node 24.16, macOS,
tmux 3.6b). Source read at the pi fork `~/Developer/pi`, HEAD `9c9ce8547`
(v1.5.0+49). Each spike loads with `pi -ne --offline -e spikes/<file>.ts`
and logs to `/tmp/roost-spike-<r>.log`.

| Risk | Spike | Verdict |
|------|-------|---------|
| R1 `--bg` early exit | `r1-bg-early-exit.ts` | **Go**, with a cosmetic caveat |
| R2 attach passthrough from `custom()` | `r2-attach-passthrough.ts` | **Go** |
| R3 ← via `onTerminalInput` | `r3-left-arrow.ts` | **Go**, must filter key releases |
| R4 worktree cwd switch | (source read only) | **No-go on API**, use the PRD fallback |
| R5 handoff to scratch session | `r5-handoff-scratch.ts` | **Go** |

## R1 — `pi --bg "task"`

- `parseArgs` hands an unknown `--flag value` pair to `unknownFlags` and
  consumes the value, so `"task"` never becomes `initialMessage`
  (`cli/args.ts:250-262`). No `input` or `agent_start` fired.
- `session_start` runs inside `init()`, before `run()` processes initial
  messages; the session is idle, so `ctx.shutdown()` exits at once
  (`shutdownHandler` → `isIdle` → `shutdown()`). session_start → exit took
  ~55 ms, exit code 0.
- Output written to stdout while the TUI is up is repainted away. Print the
  `backgrounded · <id> · <name>` line from `process.once("exit")`.
- Caveat: pi starts its TUI before extensions load, so one frame of header
  and footer (~30 lines, more on the first run of a new version because of
  the changelog) stays in the inline scrollback. Acceptable for v1; the
  `pi-roost bg` script is the clean path.
- Consequence for the CLI: any extension flag followed by a bare word eats
  that word. `pi --agents "x"` would treat `x` as the flag's value.

## R2 — `tui.stop()` / `tui.start()` from a `custom()` component

- Same pattern as pi's own external-editor path
  (`handleOpenExternalEditor`: `ui.stop()` → child → `ui.start()` +
  `requestRender(true)`).
- Synchronous child with inherited stdio: view repaints, keeps focus, Esc
  resolves `custom()` and the editor takes input again.
- Asynchronous variant (what attach needs): after `tui.stop()` the
  extension owns stdin (`setRawMode(true)`, `resume()`, own `data`
  listener) while the event loop keeps running; pi saw none of those keys.
  `ProcessTerminal.stop()` removes pi's stdin listener, pauses stdin,
  restores raw mode, pops the kitty protocol and modifyOtherKeys, so the
  terminal is clean for a passthrough.
- Detail for the real attach: pi leaves stdin in utf8 mode, so `data`
  chunks are strings. Either `setEncoding` back to binary during attach or
  convert with `Buffer.from` before writing to the host socket.
- `tui.start()` re-negotiates kitty/bracketed paste itself; AT-4 (reset
  modes the worker set) still has to be done by us before `start()`.

## R3 — ← on an empty editor

- `onTerminalInput` sees raw input before the editor; `{ consume: true }`
  stops it; `getEditorText()` is current. Verified in tmux: ← on empty
  prompt hit, ← with text moved the cursor (`abc` → `abXc`).
- `matchesKey(data, Key.left)` accepts legacy `CSI D`, SS3 `O D` and kitty
  `CSI 1;1D` / `:1` / `:2` / `:3`, and rejects Shift/Alt/Ctrl+←.
- **Pitfall found**: pi requests kitty flags 7 (includes event types), and
  the TUI drops key releases only when dispatching to the focused
  component (`tui.ts:1155`), after extension listeners ran. A kitty
  release also matches `Key.left`, so one press fires twice. Filter with
  `isKeyRelease(data)` first; verified with injected press + release bytes
  → exactly one hit.
- Not verified: `getEditorText()` during IME composition (needs a real
  IME). Keep the `ctrl+b` fallback from the PRD in reserve.

## R4 — worktree cwd switch (read only, P2)

`ExtensionCommandContext.switchSession(path, { withSession })` exposes no
`cwdOverride` (`core/extensions/types.ts:448-450`); only the internal
`AgentSessionRuntime.switchSession` has it. Use the PRD fallback: restart
the worker in the new cwd from the same session file.

## R5 — handoff to a scratch session

- `SessionManager.create(cwd, dir)` + `ctx.switchSession(scratchFile, {
  withSession })` from a command: old runtime gets `session_shutdown`
  (`reason: "resume"`), new one `session_start` (`reason: "resume"`), then
  `withSession` runs and its `next.ui.custom()` view opens. ~30 ms total.
- The original file's sha1 was identical before the handoff, after it,
  after `/name` in the scratch session, and after quit: it has no second
  writer.
- pi writes session files lazily (nothing on disk before the first
  assistant message). The scratch file never hit disk, which is what we
  want; but BG-1 with zero messages means the daemon must accept a job
  whose session file does not exist yet.
- Other extensions see an ordinary `resume` switch; `isHandoffScratch()`
  (R5 mitigation) is still needed.

## Found on the way

- `pi --session <file>` from a cwd other than the session's own opens a
  blocking "continue in current cwd" dialog. The daemon must spawn every
  worker with `cwd` = the session's cwd (from `job.json`).
- npm: `pi-agents`, `pi-fleet`, `pi-hive`, `pi-deck`, `pi-dock` and
  `pi-agent-view` are taken (PRD Q1). The package is named `pi-roost`.
