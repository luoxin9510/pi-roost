# M8 — model and context window in the agent view: acceptance (2026-11-03)

Requests:

- In the agent view, set the model of new sessions and of running sessions.
- Each row shows the running session's model and its context window use.

## Shipped

| Item | Where | Check |
|------|-------|-------|
| Model and thinking for new sessions | M6b (`/model`, `/thinking` in the dispatch input, `dispatchModel`) | unchanged |
| `/model`, `/thinking` in a peek switch that session; bare opens a picker; an unknown model is refused in the view | `extensions/agent-view.ts` (`sessionSetting`) | test; live: `/model anthropic/claude-haiku-4-5` → the row showed it within one report, window 1M → 200k |
| A turn in progress keeps its current request | worker `ReplyQueue.applySetting` → `pi.setModel` | live: `/model` sent during `sleep 6`: the `toolUse` message came from claude-haiku-5-5, the final one from claude-haiku-4-5 |
| Worker reports `thinking` and `context` (`ctx.getContextUsage()`) | `lib/worker-state.ts`, `extensions/worker.ts` | tests; refreshed at `session_start`, `message_end`, `agent_settled`, `model_select`, `thinking_level_select`, `session_compact` |
| Thinking changes go out at once; context use alone is throttled like row text | `Reporter.schedule`, `stateChanged` | test |
| Daemon validates and stores them; old workers that send neither keep the last values | `daemon/main.ts` `acceptReport`, `contextFrom` | test |
| Row column `model · 43%`, one width per render so it lines up (right-aligned, ages padded); warning ≥ 80 %, error ≥ 95 %; share only, then nothing, when narrow (summary keeps 24 columns) | `lib/view-model.ts`, `AgentView.columnsFor` / `detailText` | tests at 100, 64 and 44 columns; alignment test |
| Peek line: `provider/id · thinking high · ctx 86k / 200k (43%)`; `ctx ? / 200k` after a compaction | `modelFacts` | test |
| `rowDetails: false` hides the column | `lib/config.ts` | test |
| Fix: respawn kept the dispatch's `--model`/`--thinking`, undoing a switch | `lib/store.ts` `respawnCommand` drops `--model`, `--provider`, `--thinking` for a written session (pi restores them from its `model_change` / `thinking_level_change` entries) | test; live: switched to claude-haiku-4-5 / off, stopped, replied → respawned with both kept |

Thresholds are fixed (80 / 95 %), not settings.

## pi API used (for forks)

- `ctx.getContextUsage()`: pi ≥ 0.49.0
- `thinking_level_select` event, `pi.getThinkingLevel()`: pi ≥ 0.71.0

Both are older than what pi-roost already needs (`parentToolCallId`, 0.99.0), so the
minimum pi version does not change.

## Review fixes (PR #15)

Two independent reviews (data path; agent view). Fixed:

- A switch is no longer reported as done when it is only sent. The peek says "asked … to
  use …", then "now uses …" once a report shows it. If no report shows it within 8 s, it
  says "still on …" (for a model, most likely no credentials in the background session's
  environment). A thinking level that pi lowered is shown as the closest one supported. The
  worker also checks `pi.setModel`'s `false` result.
- Context use after an assistant message is read once pi has saved the message (pi runs
  `message_end` handlers first), so the share is no longer one request behind. `/tree`
  refreshes it too.
- `/bg`, quitting into the background, `/fork` and `/resume` (origins `adopt`/`fork`)
  no longer pass the foreground pi's `--model`/`--provider`/`--thinking`: the session's own
  model wins, as on respawn. An explicit `/model` from the view still wins.
- The peek footer fits 80 columns again (`/model` is under `?`).
- The tone follows the rounded share (79.6 % shows as 80 % and is a warning).
- `formatTokens(999_500)` is `1M`, not `1000k`. `contextFrom` rejects a window that
  rounds to 0.
- The row is re-read when a picker choice is sent. A session that is starting gets
  "try again in a moment". `/model default` in a peek explains that a running session has
  no default.
- Tests: the alignment test really has ages of different widths and a CJK model name.
  The reporter test waits for the throttled send instead of flushing with `close()`. New
  tests cover the switch confirmation, adjustment and timeout; shell rows; and
  adopt/fork flags.

Left as is: column widths are measured over all rows, as `nameWidth` is, so they do not
jump while you filter.

## Tests

Automated: 17 files, 170 tests (with M9 merged in). Live runs against pi 1.5.0 with an isolated
`PI_ROOST_HOME` and claude-haiku-5-5 / claude-haiku-4-5.
