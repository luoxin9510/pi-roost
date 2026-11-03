# pi-roost

Agent view for [pi](https://github.com/earendil-works/pi): one screen that
lists every background pi session, shows which are working, waiting or done,
and lets you dispatch, peek, reply, attach and detach without leaving the
terminal. Sessions keep running when the terminal closes.

A plain pi package (extension + background daemon + PTY host). No changes to
pi; targets stock pi ≥ 1.5.0 on Linux and macOS.

Status: M0 spikes ([report](spikes/REPORT.md)), M1 daemon + hosting
([acceptance](docs/plans/m1-acceptance.md)) M2 worker state
([acceptance](docs/plans/m2-acceptance.md)) M3 agent view
([acceptance](docs/plans/m3-acceptance.md)) and M4 backgrounding
([acceptance](docs/plans/m4-acceptance.md)) M5a lifecycle
([acceptance](docs/plans/m5a-acceptance.md)) M5b summaries and notifications
([acceptance](docs/plans/m5b-acceptance.md)) M6a organising
([acceptance](docs/plans/m6a-acceptance.md)) M6b dispatch extras and /fork
([acceptance](docs/plans/m6b-acceptance.md)) and M7 parity extras
([acceptance](docs/plans/m7-acceptance.md)) done.

## Layout

- `extensions/index.ts` — the one extension entry; picks agent view,
  foreground or worker role from context
- `lib/` — shared modules (paths, locks, job store, framing, protocol, clients)
- `daemon/main.ts` — per-user daemon: roster, dispatch, stop/rm, re-adopt
- `host/main.ts` — one PTY host per job: worker PTY, screen snapshot, attach socket
- `bin/pi-roost.ts` — shell CLI
- `spikes/` — M0 API spikes, runnable with `pi -ne --offline -e spikes/<file>.ts`

## Install (local package, not on npm)

```sh
npm install
npm run install:local        # build, pack, install to ~/.pi/agent/local-packages/pi-roost, pi install it
pi --agents                  # the agent view (or /agents in any session)
pi --bg "run the tests and summarise failures"
ln -s ~/.pi/agent/local-packages/pi-roost/dist/bin/pi-roost.js ~/.local/bin/pi-roost   # optional CLI
```

The installed copy is separate from the checkout: run `npm run install:local` again to
update it (it stops the daemon first). Don't also pass `-e ./extensions/index.ts` while it
is installed. Uninstall with `pi remove ~/.pi/agent/local-packages/pi-roost`.

## Try it (development)

```sh
npm install && npm run build
pi -e ./extensions/index.ts --bg "run the tests and summarise failures"
pi -e ./extensions/index.ts --agents --no-session   # the agent view (or /agents in any session)
# in any pi session: ← on an empty prompt (or /bg) moves the conversation to the background
node dist/bin/pi-roost.js --json
node dist/bin/pi-roost.js attach <id|name>   # Ctrl+Z detaches
node dist/bin/pi-roost.js stop <id|name>
```

## Develop

```sh
npm install
npm run check
```
