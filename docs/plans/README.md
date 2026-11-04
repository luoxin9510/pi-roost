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
| M23 | [/resume and models in the hub](m23-resume-model.md) | next |
| M24 | [usage and cost](m24-usage.md) | next |
| M25 | [marking rows, batch actions](m25-batch.md) | next |

Porting pi-roost to another agent: [`../porting.md`](../porting.md) (in Chinese).
