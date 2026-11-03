# M12: subagent panel below the prompt (acceptance, 2026-11-03)

PRD: "PRD: pi-roost 会话内子 agent 面板（M12）" (Claude Docs,
https://claude.ai/artifact/1bnS9z9j9TGV13UVBuQbkp), modelled on Claude Code's subagent panel
("Observe and steer running forks", footer actions).

## Shipped

| PRD | What | Where |
|---|---|---|
| SP-1–SP-4 | panel below the editor while the session has children; a row each (icon, name, age, sentence, `⎇ branch`, `(+N)` descendants); at most `subagentPanelRows` with `… N more (/agents)`; key hint | `extensions/subagent-panel.ts` `renderPanel` |
| SP-5, SP-6 | ↓ on an empty prompt (focus probe, no dialog, no agent view) selects; ↑↓ move, ↑ on the first row / Esc / ← leave; any other key leaves and goes to the prompt | `onInput` |
| SP-7–SP-9 | Enter / → attaches (an ended child is respawned first); the child's detach keys return; the parent's turn keeps running meanwhile | `enter` (same flow as the agent view) |
| SP-10 | live rows from daemon events; connects only when the session has children (`hasChildren`) or after a `roost_spawn` | `watch` |
| SP-11 | `x` stops a running child (the parent gets `ended (stopped)`), on a stopped one hides its row | `stopOrHide` |
| SP-12 | grandchildren counted as `(+N)` | `descendantCounts` |
| SP-13 | a child that starts waiting or finishes is highlighted for 5 s | `flash` |
| SP-14 | `/subagents` selects the panel | command |
| — | the panel works in an attached worker too (nested attach) | registered for both roles |

Not done (P2): SP-15 stop all, SP-16 message a child from the panel.

## Checks

- Automated: `test/subagent-panel.test.ts` (ordering, descendants, rows, overflow and
  selection, widths 1–200 never exceed the terminal, short terminals, keys).
- Live (pi 1.5.0, claude-haiku-5-5, isolated `PI_ROOST_HOME`): two children appear within
  a second; ↓ ↓ Enter opens the second; ← on its prompt returns with the selection kept;
  ← while selected only leaves the panel (the parent is not moved to the background);
  typing goes to the prompt; entering a child while the parent ran `sleep 15` and coming
  back: the parent's turn finished and the child's report arrived; `x` stopped a child (the
  parent got the report), `x` again hid it; `pi -c` showed the panel again at start; a
  stopped child was restarted on Enter; in the parent moved to the background (←) and
  attached from the agent view, the worker's panel opened its child and came back.
