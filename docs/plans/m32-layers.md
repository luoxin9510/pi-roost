# M32: folders by layer

Part of [any agent](any-agent.md). No behaviour change: files move so the layers the plan
names can be seen, and a test holds the lines between them.

| Layer | Where | May import |
|---|---|---|
| core | `lib/`, `daemon/`, `host/`, `bin/` | node, roost's runtime dependencies (node-pty, @xterm) |
| agent clients | `lib/agent-client.ts` (`pi-roost/agent`), `sdk/python/roost_agent.py` | node alone (the TS client's whole import graph) |
| pi's adapter | `adapters/pi/` (was `extensions/`; `lib/api.ts` moved here as `adapters/pi/api.ts`) | the core, pi's packages |
| hubs | inside pi's adapter for now (`adapters/pi/agent-view.ts`); split out in M33 | the core, pi-tui |

- `package.json`: pi loads `./adapters/pi/index.ts`. `extensions/index.ts` stays as a
  one-line re-export: a job dispatched before the move saved a command that loads that
  path with `-e`, and starts again with it.
- Package exports: `pi-roost/api` (pi's, now from `dist/adapters/pi/`), `pi-roost/agent`
  (the agent client), and new `pi-roost/client` (`DaemonClient`, for controllers: hubs,
  scripts) and `pi-roost/protocol` (the ops' and events' types).
- `test/cli-deps.test.ts`: the core imports no pi package and nothing from `adapters/`;
  `extensions/` holds only the re-export; the agent client's import graph is node alone;
  the old path loads the same extension.

## Checked

- The whole suite (348 tests), the build, `npm pack` (adapters, the shim and
  `dist/adapters/pi/api.*` in the package).
- pi installed the checkout as a package into an empty pi directory and loaded the
  extension from its new place (its `--bg`, `--worktree` flags present).
- Evals on haiku: 4/4. Stress run as in M35: reply ack p50 23 ms, hub event lag p50 26
  ms, 1000 replies in 5.1 s, every invariant held: unchanged.
