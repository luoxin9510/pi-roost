# Measuring roost: telemetry, stress tests, evals

Status: built (2026-11-05): telemetry M34, stress [M35](m35-stress.md), request ids M36, evals [M37](m37-evals.md). Comes before M32–M33: what follows is measured.

## What pi has

- **`@earendil-works/pi-telemetry`** (public, 1.5.0): a vendor-neutral contract, not a
  backend. Spans started around a callback (`startSpan(options, (span) => ...)`, no
  public `end()`), attributes, events, `ok`/`error` status, counters and histograms with
  typed schemas, cross-process propagation, a no-op context and an in-memory reference.
  No exporter: an application plugs in OpenTelemetry, Sentry or logs. In pi 1.5.0
  `pi-ai` emits `pi.ai.request` spans (first chunk, blocks) and metrics
  (`pi.ai.request.duration`, `pi.ai.first_chunk.duration`, `pi.ai.tokens`, `pi.ai.cost`)
  when a request is given a parent span; chord (durable) uses it too. The coding agent
  does not let an extension hand it a telemetry context, so a pi extension cannot read
  pi's own spans today.
- **`pi-evals`** (private, in pi's repository): behavioural evals on `vitest-evals`
  (public, Sentry's). A harness drives pi's SDK in process with an isolated home,
  workspace and session; cases are `describeEval(...)` suites with deterministic
  judges; a Docker runner pairs `with_docs` / `without_docs` arms over repetitions and
  reports pass-rate lift. Results go to `.eval/<time>_<id>/` (protocol, planned runs,
  observations with telemetry, native sessions, report). One repetition is never taken
  as stability; missing telemetry is unavailable, not zero.

Neither fits roost as it is: telemetry would be a dependency of the core (roost stays
independent), and pi-evals is unpublished, Docker-bound and measures documentation lift
for pi alone. What we take: the span contract's shape, the eval layout and its rules.

## Three layers

### 1. roost telemetry (`lib/telemetry.ts`, no dependency)

The same shape as pi-telemetry (callback spans, attributes, events, status, counters,
histograms), so an adapter to it, or to OpenTelemetry, is a few lines later. Sinks: no-op
(default), a JSON-lines file (`ROOST_TELEMETRY=path`), in memory (tests). Spans and
metrics where roost's time goes:

| Name | What |
|---|---|
| `roost.dispatch` | request to host up (attributes: kind, profile, worktree) |
| `roost.respawn` | why (reply, crash, restart), to host up |
| `roost.reply` | reply received → delivered → acked (`roost.reply.ack_latency`) |
| `roost.report` | reports per job, state changes (`roost.reports`) |
| `roost.host.start` | spawn to listening |
| `roost.attach` | attach to snapshot sent (`roost.attach.replay_latency`) |
| `roost.reap`, `roost.cleanup` | what went and why |
| `roost.term` | level 0: typing, state changes inferred |
| `roost.events` | subscribers, events pushed, slow consumers |

### 2. stress (`stress/`, `npm run stress`, no model cost)

Fake agents only (the protocol fixtures, the fake terminal agent, shell jobs), a real
daemon and real hosts, in an isolated home. Scenarios, each with a size knob:

- **many sessions**: N jobs dispatched at once (default 50; up to 200), each reporting
  every few hundred ms; M subscribers (hubs) watching.
- **reply storm**: thousands of replies across jobs; each must reach its agent once, in
  order, and be acked.
- **chaos**: the daemon killed and restarted under load (`keepWorkers`), hosts killed
  with SIGKILL, a subscriber that never reads, a worker reconnect storm.
- **attach churn**: attach, type, detach in a loop on busy jobs (the existing attach
  stress, folded in).
- **soak**: an hour at a moderate load, watching memory and file descriptors.

Invariants checked after each run: no reply lost or handled twice, rows equal to what
agents last reported, no orphan hosts or sockets, every job ends in a final state.
Measured (from telemetry and the OS): dispatch and reply latency p50/p95/p99, reports
per second, daemon CPU and RSS, event lag per subscriber. Budgets live in the scenario
file; a run over budget fails. Output: `stress/.runs/<time>/report.json` and `.txt`.

### 3. evals (`evals/`, `npm run eval`, real models)

`vitest-evals` as a dev dependency only (nothing of it ships). A harness starts an
isolated roost (own home, runtime and config) and drives it through its socket, as the
hub does; the agents are real: pi through its worker, a level 0 profile, a protocol
agent. Cases:

- a task to done; a question answered by a reply; steer versus follow-up;
- a subagent spawned and its report reaching the parent (M9/M13);
- fan-out over two models and `/compare`'s data;
- a level 0 agent (Claude Code): dialog seen as needing input, a typed reply, resume;
- a protocol agent driven by a model.

Grading is deterministic (row states and their order, files in the worktree, replies
acked, reports received), with cost and latency from roost's telemetry and the usage
pi reports. Repetitions (`--runs N`), pass rate per case, flakiness flagged; one run
never claims stability; a run that cannot be scored blocks the headline, as in
pi-evals. Results in `evals/.runs/<time>/` (protocol, planned runs, observations,
sessions, report). Models and spending caps are arguments; the default is the cheapest
model the user names.

## Order

1. Telemetry, instrumenting the daemon and host (the suite checks spans exist).
2. Stress, using it; run it and fix what it finds.
3. Evals; run them on a cheap model, then the user's.
4. Then M32–M33 as planned, each measured by the stress run before and after.
