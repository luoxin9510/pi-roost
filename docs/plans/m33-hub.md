# M33: the hub on its own

The last milestone of [any agent](any-agent.md)'s core. `pi-roost hub [dir]` runs the
agent view in a terminal of its own, with no pi session around it: the same view, keys
and commands as `pi --agents`.

## Layers

| | Where | Imports |
|---|---|---|
| the hub | `hub/agent-view.ts`, `hub/task-editor.ts`, `hub/theme.ts` (moved from `adapters/pi/`) | the core and pi-tui only; colours through `HubTheme` (`fg`, `bold`), which pi's own theme satisfies |
| what the hub needs from pi | `adapters/pi/hub-options.ts` (`piHubOptions`), split out of `open-view.ts` | launching and resuming pi jobs (session files), pi's /resume picker, settings, presets, agents, profiles; what the host knows comes in a `PiHost` (cwd, argv, models, the current session) |
| inside pi | `adapters/pi/open-view.ts` | pi's extension context: its models, its session, `ctx.ui.custom` |
| on its own | `adapters/pi/hub-main.ts` (`runHub`) | a pi-tui `TuiAltScreen` on a `ProcessTerminal`, as pi's fullscreen mode draws; models from `pi --list-models`; a 256-colour theme after pi's dark one (`NO_COLOR` honoured) |

The test of the layers (`test/cli-deps.test.ts`) adds: `hub/` imports pi-tui and nothing
else of pi's, and nothing from `adapters/`.

## pi's packages

They are pi's, not roost's (peer dependencies, left out when pi installs roost), and the
CLI runs on plain node. `lib/pi-resolve.ts` (node only) finds pi's package
(`ROOST_PI_PACKAGE`; else up from the pi on the PATH, an npm-style link; else `npm root
-g`, where a pnpm, volta, asdf or mise shim does not lead), takes pi's CLI from the
package's `bin` (never the shim), and registers a resolve hook (`node:module` `register`)
that resolves `@earendil-works/*` from pi's installation, as pi itself imports them: the
hub runs the same pi-tui as the user's pi, and new sessions run that pi. `pi-roost hub`
loads `adapters/pi/hub-main` by path, as the daemon starts the host: from `dist/` when
installed (it is built now), from the `.ts` in a checkout.

Without pi it says so (naming `ROOST_PI_PACKAGE`) and exits 1; a missing directory is a
usage error. It leaves the terminal as it found it on Esc, Ctrl+C, an error, SIGTERM or
SIGHUP (input drained before the screen is given back, as pi does).

## Checked

- The suite, with new tests: finding pi's package, the hook resolving pi's packages
  from pi and falling back, the model list, colours and `NO_COLOR`, the CLI's errors.
- In a real terminal (tmux), an isolated roost and pi directory with this checkout
  installed as a pi package: the view drawn full screen; a task typed and started on
  haiku, done, its file written, the row with cost and model; Enter attached to the
  session (pi's screen and the "while you were away" recap), Ctrl+Z back to the hub;
  Ctrl+L listed pi's models; /resume opened pi's session picker with the session; Esc
  left with status 0.

## Not yet

- The standalone hub has no pi session, so nothing moves to the background from it
  (that is `←` in pi) and pi's slash commands (skills, prompt templates) are not offered
  as first prompts.
- Sessions and the model list run pi under the node that runs pi-roost; a pi installed
  for another node that it cannot run under would fail there.
- Its colours follow pi's dark theme, not the user's chosen pi theme (pi does not export
  the theme in use).
