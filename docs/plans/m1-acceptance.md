# M1 acceptance — 2026-11-03

Stock pi 1.5.0, Node 24.16, macOS, tmux 3.6b on a private server
(`tmux -L roost-e2e`), model `deepseek/deepseek-flash` (turn cost $0.003).
Extension loaded with `-e ~/Developer/pi-roost/extensions/index.ts`; CLI
run as `node dist/bin/pi-roost.js` after `npm run build`.

| Step | Result |
|------|--------|
| `pi -e … --model deepseek/deepseek-flash --bg 'list the files …'` | `backgrounded · 46323180 · list the files in this directory` + four hints, exit 0 |
| Kill the tmux session (terminal closed) | Job keeps running; `--json` shows `working`, worker pid 66322 |
| `pi-roost logs 46323180` | Live snapshot from the host: turn finished ("Done in 1969ms") |
| New terminal: `pi-roost attach list` (name substring) | Full worker TUI repainted; typed text reached the worker's editor |
| Ctrl+Z | `detached · 46323180 · …`, exit 0; job still `working` |
| Worker writer lock | `<session>.jsonl.lock` held by the worker pid (DM-8) |
| `pi --session <same file> --bg again` | `pi-roost: session is in use by pid 66322`, exit 1 (AT-7) |
| `pi -p --bg x` | `--bg needs interactive mode …`, exit 1 |
| `pi-roost daemon stop --keep-workers`, then `--json` | New daemon (pid 66299 → 67723) re-adopted the live job (DM-6) |
| `pi-roost stop 4632` | `stopped`, `endedAt` set; `logs` falls back to `screen.txt` |
| Writer lock after stop | Released (pi shut down gracefully on SIGTERM) |
| `pi-roost rm 4632` | Row and job dir gone |
| `pi-roost daemon stop` | No daemon or host processes left, socket dir empty |

Automated: `npm test` — 5 files, 42 tests (lib core, framing, dispatch,
host, daemon), stable over repeated runs.

## Fixed during acceptance

- Detach note was drawn over the worker's last frame: the CLI now moves the
  cursor to the bottom row first.
- `--bg` failures exited 0 because pi ends with `process.exit(0)`; the
  extension now sets the exit code from an `exit` listener.

## Known limits carried into later milestones

- Output produced before the first attach is not replayed; programs that
  repaint on SIGWINCH (pi does) look right, others start blank (M5 snapshot).
- Attaching to an ended job is refused (respawn is M5).
- `node-pty`'s `spawn-helper` loses its exec bit on npm install; the host
  restores it at start.
- One TUI frame stays in the scrollback after `pi --bg` (M0 R1).
- Worker state is process-level only (`working` until exit); M2 adds the
  worker role.
