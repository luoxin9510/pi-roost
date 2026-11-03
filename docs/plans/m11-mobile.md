# M11 — pi-mobile: background sessions on the phone (2026-11-03)

[pi-mobile](https://github.com/luoxin9510/pi-mobile) puts every pi on the machine on the phone:
one hub per machine, every pi process links to it over loopback. A pi-roost worker is a
plain pi with the user's packages, so background sessions were on the phone already, and
the hub outlives the terminal while any worker runs. M11 closes the gaps.

## Contract (pi's event bus; neither package imports the other)

| Channel | Emitted by | Data | pi-roost |
|---|---|---|---|
| `pi-mobile:starters` | pi-mobile, when it builds a session's info and on "New session" | `{ register(starter) }` | registers `{ id: "pi-roost", label: "Background session", start({ cwd, prompt, env }) }` in every role |
| `pi-mobile:activity` | pi-mobile, on every call a paired device makes to a session | `{ action }` | a worker reports `remoteAt` (at most once a minute, sent at once) |

The canonical description is the header of pi-mobile's `src/starters.ts`.

## Shipped

| Item | Where | Check |
|------|-------|-------|
| Start a background session from the phone | `extensions/mobile.ts` `startForMobile`: same as a task typed into the agent view (`dispatchModel`/`dispatchThinking`, `worktreeIsolation` default with the M10 discard on a refusal), named after the prompt or the folder | unit tests; live e2e below |
| The phone opens it | only `PI_MOBILE_*` names from the request's `env` go into the worker's environment (carries `PI_MOBILE_SPAWN`) | unit test: other names and a `PATH` from the request are dropped |
| In use is not reaped | `daemon/main.ts` `reapable`: idle counts from `max(stateSince, remoteAt)`; `acceptReport` clamps `remoteAt` to now | daemon test |
| Docs | README "On your phone (pi-mobile)", CHANGELOG | — |

Live e2e (isolated agent dir, roost home and hub; pi 1.5.0 in RPC mode with both extensions,
pi-mobile's test phone speaking the real sealed protocol):

1. the foreground pi's info offers `[{ id: "pi-roost", label: "Background session" }]`;
2. `spawn` with `via: "pi-roost"` answers `{ name: "work" }`;
3. the new session appears on the phone with `spawn: "e2e1"` and the pid of the pi-roost job;
4. a phone call on it sets `remoteAt` in the job's `state.json`.

## Not done

- A reaped session still leaves the phone's list (pi-mobile lists live processes). Waking one
  from the phone needs hub entries without a process.
- `/bg` hands the conversation to another process, which the phone shows as a new session.
