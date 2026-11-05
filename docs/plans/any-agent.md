# Any agent: roost without pi lock-in

Status: design (2026-11-05), reviewed once. Milestones M29–M33 build it, one step at a
time, with pi as the baseline: pi stays the default and the most integrated agent, and
nothing pi users have today may regress.

## Why

Every person and team has an agent of their own: pi, Claude Code, Codex, Aider, an
in-house CLI, a Python service. roost should manage any of them, at the level of
integration each can afford, with no dependency on any agent's packages in its core,
and pi as one supported agent among others (the most integrated one).

## Where roost is tied to pi today

Only one file of the core imports a pi package (`lib/api.ts`: `SessionManager` and pi's
argv), but the core assumes pi in many quieter ways:

| Assumption | Where |
|---|---|
| a job is `kind: "pi" \| "shell"`; everything not a shell is pi | `lib/protocol.ts` (JobRow, DispatchArgs), daemon branches on `kind === "shell"`, `lib/resume.ts` |
| every agent session is a file, and the file is a key | `daemon/main.ts`: absolute path required, writer lock, spawn trees and peers keyed by it |
| pi's argv | `lib/dispatch.ts` (`VALUE_FLAGS`, `passthroughArgs`, `--session`, task after `--`) |
| pi's transcript and usage | `lib/transcript.ts` (pi session JSONL), `lib/usage.ts`, `lib/summarizer.ts` (prompt says coding agent) |
| pi's names | `PI_JOB_ID`/`PI_JOB_TOKEN`/`PI_DAEMON_SOCK` (host, worker; the daemon strips them), `PI_ROOST_*`, `~/.pi/agent/roost(.json)`, `<cwd>/.pi/roost.json`, `/tmp/pi-roost-<uid>`, `PI_CODING_AGENT_DIR` |
| worker report fields only pi fills | `attachSignal`/`attachRepaint` (SIGUSR2 repaint), `remoteAt`, `agentItems`, `prLinks`, `context`, `usage` |

The shell job is already a level 0 agent in miniature (no report, state from the
process): the generic path grows out of it rather than beside it.

## Three levels of integration

### Level 0: any terminal agent, no code (agent profiles)

A profile in the user's `roost.json`:

```json
{
  "agentProfiles": {
    "codex": {
      "command": ["codex"],
      "task": "argv",
      "model": ["--model", "{model}"],
      "resume": null,
      "waiting": "Do you want to|\\(y/n\\)",
      "submit": "\r"
    }
  }
}
```

- `command` is an argv, never a shell string; `{model}`, `{thinking}`, `{task}`,
  `{session}` replace whole argv elements, no shell and no environment expansion.
  `task`: `"argv"` (appended), `"type"` (typed once the agent first goes quiet) or
  `"none"`. `resume`: an argv to reopen a session, or null (then "start again" means a
  fresh start with the first task).
- **State, from the strongest signal down** (decided in the host, which owns the
  terminal mirror, and pushed to the daemon as a new `term` event on the host link):
  1. the process: exit code gives done or failed (exists today);
  2. what the agent tells the terminal: OSC 9 / OSC 777 notifications and BEL mean it
     wants you; OSC 0/2 titles give the row text; OSC 133 prompt marks give idle;
  3. the screen settling: a hash of the screen content (ignoring the cursor line and
     spinner glyphs) unchanged for a few seconds means quiet;
  4. optional profile regexes over the whole screen (`waiting`, `working`), never tied
     to the last line.
- Row text: the OSC title when there is one, else nothing for alt-screen agents, else
  the last non-empty line.
- A reply is typed into the terminal and followed by `submit`, through a new host
  `input` op. Steer or follow-up does not apply.
- What works: rows, attach and detach, stop, delete, worktrees, fan-out, presets, marks,
  reaping. What degrades, shown as such (a dash, never a zero): model, context, usage,
  transcript (falls back to the screen), `/resume`, subagents and peers.

### Level 1: any agent that can speak a socket (the roost agent protocol)

A versioned protocol over the daemon's unix socket, JSON lines, written down in
`docs/protocol.md`. Before it is frozen as v1:

- a `hello` with `protocol: 1`, the agent's name and version, and its capabilities
  (`report`, `replies`, `steer`, `usage`, `context`, `model-switch`, `transcript`,
  `peers`); the daemon answers with its own;
- the report is a full snapshot every time (kept: easy for clients), split into the core
  fields every agent can fill (state, status, waiting-for, summary, question, choices,
  name, model) and capability fields (usage, context, ...), with agent extras under `ext`;
- seq and ack rules written out: replies are numbered per job, resent until acked,
  dropped by seq on resend, numbering continues across reconnects; the token comes in
  the environment at spawn and stays for the job's life;
- unknown fields are ignored; enums grow only with a protocol version; errors are coded
  (`unauthorized`, `bad_request`, `not_found`, `full`, `unsupported`).
- It ships as a draft in M31 and is frozen only once the Python client has been through
  it.

The job's identity comes in neutral names (the old ones stay accepted for good, and the
daemon strips both kinds from what a job inherits):

| Variable | Old name | Meaning |
|---|---|---|
| `ROOST_JOB_ID` | `PI_JOB_ID` | the job |
| `ROOST_JOB_TOKEN` | `PI_JOB_TOKEN` | its secret; every worker request carries it |
| `ROOST_SOCKET` | `PI_DAEMON_SOCK` | the daemon's socket |

A job's children inherit these too: a third-party agent's subprocesses can talk as the
job. The token only lets them report for that one job and read its replies.

Clients: TypeScript (`pi-roost/agent`, the transport the pi worker uses today, moved
into `lib/`) and Python (one file, standard library only). Conformance tests drive a real
daemon with a scripted worker in each.

### Level 2: deep integration (pi today)

Moving a foreground conversation to the background, the subagent panel, peer tools, the
summary model, detach keys inside the agent's own TUI, attach repaint by signal. pi's
adapter stays the reference; `docs/porting.md` the guide.

## Data model changes

- `kind: "pi" | "shell"` becomes `agent: string` (a profile name; `"pi"` built in,
  `"shell"` built in) with the capabilities above. Old records read as before.
- `sessionFile` becomes an optional, opaque `sessionRef`; what the daemon keys by a file
  today (spawn trees, peers, one row per session, writer locks) keys by job id, and by
  `sessionRef` only for agents that have one.

## Names and paths, kept compatible

- The npm package and the `pi-roost` binary keep their names.
- `ROOST_*` settings variables are read first, `PI_ROOST_*` after.
- `~/.config/roost/roost.json` is read as well as `~/.pi/agent/roost.json`; nothing is
  moved. A project's file may be `.roost/roost.json` or `.pi/roost.json`.
- The state directory (`~/.pi/agent/roost`) and the runtime directory
  (`/tmp/pi-roost-<uid>`) do not move, so running daemons and hosts keep finding each
  other.

## The shape of the repository

| Layer | Contents | May import |
|---|---|---|
| core | daemon, PTY host, protocol, client, CLI, config, worktrees, view model | Node and roost's own runtime dependencies (node-pty, @xterm/headless) |
| agent clients | `pi-roost/agent` (TS), `sdk/python/roost_agent.py` | the protocol types only |
| adapters | `adapters/pi/` (`extensions/` before M32), profiles | the core, the client, that agent's own packages |
| hubs | hub logic and drawing, inside pi and standalone | the core and pi-tui (a terminal UI library, not an agent interface) |

One package, folders by layer (npm workspaces only if a second package is ever
published). A test keeps the line: the daemon, the host, the CLI and the agent clients
import no pi package; the hubs may use pi-tui; only `adapters/pi/` uses pi's agent API
(`pi-coding-agent`).

## Milestones

| | Builds | Checked by |
|---|---|---|
| M29 | neutral core, no behaviour change: `agent` field with capabilities, optional `sessionRef`, `ROOST_*` names and config candidates, `lib/api.ts`'s pi parts moved to the adapter, the import-boundary test | the whole suite; pi runs as before against old records and old workers |
| M30 | level 0: profiles, host `input` op, host `term` events (OSC, BEL, screen settling, regexes), typed replies, degraded columns | a fake terminal agent in tests; a real third-party CLI agent by hand (OSC signals) |
| M31 | level 1: `docs/protocol.md` draft, `hello` and capabilities, the TS client extracted and the pi worker rebuilt on it, the Python client, conformance tests; then frozen as v1 | scripted workers in TS and Python against a real daemon |
| M32 | folders by layer (`adapters/pi/`), package exports for the core and the client | the whole suite; pi installs and runs as before |
| M33 | the hub split from pi's extension context; `pi-roost hub` runs it standalone, drawn with pi-tui | a real terminal without a pi session around it |

After these, the durable-inspired work (request ids, interrupted runs, scheduled tasks)
goes into the protocol, so every agent gets it.

## Out of scope

- Windows: roost is POSIX-only today (unix sockets, `/tmp`, `getuid`, node-pty use).
- Peers, subagents and transcripts for level 0 agents.

## Safety

- Profiles are user config only: a project's file cannot define them.
- Profile commands are argv templates: no shell, no environment expansion, placeholders
  replace whole elements.
- A profile's own `env` entries go through the same deny list as everything a job
  inherits.
- The daemon socket stays owner-only (0700 runtime directory); the job token is scoped to
  one job.
