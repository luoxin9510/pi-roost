# Design notes and acceptance records

Each milestone has a design note or an acceptance record: what Claude Code does, what
pi-roost does, the decisions taken in review, and what was not ported. The first
section covers M1–M10, the PRD milestones. The second covers M11–M20, which port
Claude Code's documented behaviour.

| Milestone | Note | Release |
|---|---|---|
| M0 | `spikes/REPORT.md`: feasibility spikes | — |
| M1 | [daemon and hosting](2026-11-03-m1-daemon-hosting.md), [acceptance](m1-acceptance.md) | 0.1.0 |
| M2 | [worker state](m2-acceptance.md) | 0.1.0 |
| M3 | [agent view, replies](m3-acceptance.md) | 0.1.0 |
| M4 | [← to the background](m4-acceptance.md) | 0.1.0 |
| M5a / M5b | [lifecycle](m5a-acceptance.md) · [summaries, names, notifications](m5b-acceptance.md) | 0.1.0 |
| M6a / M6b | [filters, groups, pins](m6a-acceptance.md) · [@dir, /model, shell jobs, /fork](m6b-acceptance.md) | 0.1.0 |
| M7 | [quit to background, Ctrl+G, CLI, API](m7-acceptance.md) | 0.1.0 |
| M8 | [model and context per row](m8-acceptance.md) | 0.1.5 |
| M9 | [agents talking to each other](m9-agent-comms.md) | 0.1.5 |
| M10 | [worktree isolation](m10-worktree-isolation.md) | 0.1.5 |
| M11 | [pi-mobile](m11-mobile.md) | 0.1.6 |
| M12 | [subagent panel](m12-subagent-panel.md) | 0.1.6 |
| M13 | [subagent lifecycle as in Claude Code](m13-subagent-lifecycle.md) | 0.1.7 |
| M14 | [attach feels like `pi --resume`](m14-attach-like-resume.md) | 0.1.7 |
| M15 | [`.worktreeinclude`, `pi-roost list`, `cleanupDays`, query replies](m15-polish.md) | 0.1.7 |
| M16 | [pull request status, Ready for review](m16-pr-status.md) | 0.1.7 |
| M17 | [pi's editor as the task input](m17-editor-input.md) | 0.1.7 |
| M18 | [agent presets](m18-agent-presets.md) | 0.1.7 |
| M19 | [subagent transcripts](m19-transcript-view.md) | 0.1.7 |
| M20 | [your shell's environment, per workspace](m20-shell-environment.md) | 0.1.7 |
| M21 | [an attach starts from the host's screen](m21-attach-replay.md) | 0.1.9 |
| M22 | [many pi windows, frequent switching](m22-multi-window.md) | 0.1.10 |
| M23 | [/resume and models in the hub](m23-resume-model.md) | 0.1.11 |
| M24 | [usage and cost](m24-usage.md) | 0.1.11 |
| M25 | [marking rows, batch actions](m25-batch.md) | 0.1.11 |
| M26 | [one task, several models, compared](m26-fanout.md) | 0.1.11 |
| M27 | [launch presets](m27-presets.md) | 0.1.11 |
| M28 | [steer or wait, as in pi](m28-steer.md) | 0.1.12 |
| M29 | [a neutral core](m29-neutral-core.md) | 0.1.12 |
| M30 | [agent profiles: terminal agents besides pi](m30-profiles.md) | 0.1.12 |
| M31 | [the agent protocol, TypeScript and Python clients](m31-protocol.md) | 0.1.12 |
| M34 | [telemetry](evals.md) (first of: telemetry, stress, evals) | 0.1.12 |
| M35 | [the stress run, and what it found](m35-stress.md) | 0.1.12 |
| M36 | request ids: a resent reply or dispatch is taken once ([protocol](../protocol.md#request-ids-for-the-clients-that-send-replies-and-start-jobs)) | 0.1.12 |
| M37 | [evals with real models](m37-evals.md) | 0.1.12 |
| M32 | [folders by layer: `adapters/pi/`, package exports](m32-layers.md) | 0.1.12 |
| M33 | [the hub on its own: `pi-roost hub`](m33-hub.md) | 0.1.12 |
| M38 | [interrupted runs carry on; a crash loop is bounded](m38-resume.md) | 0.1.12 |
| M39 | [scheduled tasks](m39-schedules.md) | 0.1.12 |
| M40 | [interrupted runs and schedules for every agent](m40-agents-resume.md) | 0.1.12 |
| M41 | [more evals: a fan-out, a terminal agent, a protocol agent](m37-evals.md#m41-the-other-agents) | 0.1.12 |
| M42 | a stress test that failed under load: the fake worker kept keys as pi does ([M22 tests](m22-multi-window.md#tests)) | 0.1.12 |
| M43 | [the event feed, watches and message rules](m43-events.md) | 0.1.14 |
| M44 | [the concierge, v0: report and relay](m44-concierge.md) | 0.1.14 |
| M45 | [escalation and policy: suggestions, routine answers, undo, act](m45-policy.md) | 0.1.14 |
| M46 | [standing orders: rules it keeps, in every digest, on a clock](m46-orders.md) | 0.1.14 |
| M48 | [the peek, deeper: more to see, an editor to answer in, commands, completion](m48-peek.md) (before M47, at the user's request) | 0.1.14 |
| M47 | [the shared task board: tasks any session takes, a lock, dependencies, the concierge as the lead](m47-tasks.md) | 0.1.14 |
| M49 | [hardening after the board: a stress scenario, an adversarial pass (the hub's ops, the socket's bounds, one-line text)](m49-hardening.md) | 0.1.15 |
| M50 | [agents of the protocol take messages: send, peers, watches and the board's hand-overs reach them](m50-protocol-messages.md) | 0.1.16 |
| M51 | [request ids from the hub and the CLI: a reply or a dispatch whose answer was lost is sent again, taken once](m51-request-ids.md) | 0.1.16 |
| M52 | [the board by project (a repository's), and told when a task can be claimed](m52-board-projects.md) | 0.1.16 |
| M53 | [a session's whole conversation: what came before the last compaction loads as the transcript scrolls up](m53-earlier-history.md) | 0.1.16 |
| M54 | [a task's workspace, as data: stages, dependencies until merged, the store's version 2](m54-workspace-model.md) | 0.1.17 |
| M55 | [start and merge from `/tasks`: a task's worktree and session, review, a local merge into base](m55-start-merge.md) | 0.1.17 |
| M56 | [verify before review: the repository's `verify` and `setup`, read from base, approved by a person](m56-verify.md) | 0.1.17 |
| M57 | [the workspace overlay: the tasks as a pipeline, Ctrl+N, the concierge's `hub_task_start`](m57-workspace-overlay.md) | 0.1.18 |
| M58 | [review in the TUI: a task's diff, comments on its lines sent back, `pi-roost review`](m58-review.md) | 0.1.18 |
| M61 | [a session's own slash commands in its peek](m61-session-commands.md) | 0.1.17 |

Next: [toward an agent development environment](ade-roadmap.md) — task → worktree → verify → review in the TUI → local merge (M54–M60).

Before: [the hub as a control plane](hub-control-plane.md) — a resident concierge agent that reports, relays and, under a policy, answers, and a shared task board (M43–M47, all done); the any-agent route is in [any agent](any-agent.md); measured by the stress run and the evals.

Porting pi-roost to another agent: [`../porting.md`](../porting.md) (in Chinese).
