# pi-roost

Agent view for [pi](https://github.com/earendil-works/pi): one screen that
lists every background pi session, shows which are working, waiting or done,
and lets you dispatch, peek, reply, attach and detach without leaving the
terminal. Sessions keep running when the terminal closes.

A plain pi package (extension + background daemon + PTY host). No changes to
pi; targets stock pi ≥ 1.5.0 on Linux and macOS.

Status: M0 spikes ([report](spikes/REPORT.md)) and M1 daemon + hosting
([acceptance](docs/plans/m1-acceptance.md)) done.

## Layout

- `extensions/index.ts` — the one extension entry; picks agent view,
  foreground or worker role from context
- `lib/` — shared modules (paths, locks, job store, framing, protocol, clients)
- `daemon/main.ts` — per-user daemon: roster, dispatch, stop/rm, re-adopt
- `host/main.ts` — one PTY host per job: worker PTY, screen snapshot, attach socket
- `bin/pi-roost.ts` — shell CLI
- `spikes/` — M0 API spikes, runnable with `pi -ne --offline -e spikes/<file>.ts`

## Try it (development)

```sh
npm install && npm run build
pi -e ./extensions/index.ts --bg "run the tests and summarise failures"
node dist/bin/pi-roost.js --json
node dist/bin/pi-roost.js attach <id|name>   # Ctrl+Z detaches
node dist/bin/pi-roost.js stop <id|name>
```

## Develop

```sh
npm install
npm run check
```
