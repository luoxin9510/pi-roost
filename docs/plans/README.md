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
| M28 | [steer or wait, as in pi](m28-steer.md) | next |
| M29 | [a neutral core](m29-neutral-core.md) | next |
| M30 | [agent profiles: terminal agents besides pi](m30-profiles.md) | next |
| M31 | [the agent protocol, TypeScript and Python clients](m31-protocol.md) | next |
| M34 | [telemetry](evals.md) (first of: telemetry, stress, evals) | next |
| M35 | [the stress run, and what it found](m35-stress.md) | next |
| M36 | request ids: a resent reply or dispatch is taken once ([protocol](../protocol.md#request-ids-for-the-clients-that-send-replies-and-start-jobs)) | next |
| M37 | [evals with real models](m37-evals.md) | next |
| M32 | [folders by layer: `adapters/pi/`, package exports](m32-layers.md) | next |
| M33 | [the hub on its own: `pi-roost hub`](m33-hub.md) | next |
| M38 | [interrupted runs carry on; a crash loop is bounded](m38-resume.md) | next |
| M39 | [scheduled tasks](m39-schedules.md) | next |
| M40 | [interrupted runs and schedules for every agent](m40-agents-resume.md) | next |

Next: see [any agent](any-agent.md); measured by the stress run and the evals.

Porting pi-roost to another agent: [`../porting.md`](../porting.md) (in Chinese).
