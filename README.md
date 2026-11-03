# pi-roost

Agent view for [pi](https://github.com/earendil-works/pi): one screen that
lists every background pi session, shows which are working, waiting or done,
and lets you dispatch, peek, reply, attach and detach without leaving the
terminal. Sessions keep running when the terminal closes.

A plain pi package (extension + background daemon + PTY host). No changes to
pi; targets stock pi ≥ 1.5.0 on Linux and macOS.

Status: M0 (spikes) done, see [spikes/REPORT.md](spikes/REPORT.md).

## Layout

- `extensions/index.ts` — the one extension entry; picks agent view,
  foreground or worker role from context
- `spikes/` — M0 API spikes, runnable with `pi -ne --offline -e spikes/<file>.ts`

## Develop

```sh
npm install
npm run check
```
