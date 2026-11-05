# M29: a neutral core

The first step of [any agent](any-agent.md): names and data that no longer assume pi,
with nothing pi users see changing.

- A job's identity reaches its worker under neutral names as well as the old ones:
  `ROOST_JOB_ID`, `ROOST_JOB_TOKEN`, `ROOST_SOCKET`, `ROOST_JOB_DIR` (and `PI_JOB_ID`,
  `PI_JOB_TOKEN`, `PI_DAEMON_SOCK`, `PI_JOB_DIR`). Workers read the new name first, so a
  worker started by an older host still finds its job. One list (`lib/identity.ts`) says
  which names a job never inherits.
- roost's own settings: `ROOST_HOME`, `ROOST_RUNTIME_DIR`, `ROOST_CONFIG_DIR` before
  their `PI_ROOST_*` names. The user's file is `~/.config/roost/roost.json` when it exists
  (honouring `XDG_CONFIG_HOME`), else `~/.pi/agent/roost.json`; a project's is
  `.roost/roost.json` when it exists, else `.pi/roost.json`. Nothing is moved; the state
  and runtime directories stay where they are, so running daemons and hosts keep finding
  each other.
- Rows say which agent runs them: `profile` (`"pi"` or `"shell"` for now).
- A test keeps `lib/` free of pi's packages (only `lib/api.ts`, the extension API for
  other pi extensions, uses pi), next to the existing one for the daemon, host and CLI.
- Checked: the suite (new: names, config locations, profile on rows) and a real pi:
  sessions start, report and take replies with the new names.
