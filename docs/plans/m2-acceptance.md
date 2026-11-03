# M2 — worker role + state: acceptance (2026-11-03)

Scope: PRD C6, §6.8, SM-1, SM-3, PK-4 dialog detection.
Acceptance (PRD §10): `--json` reports working → done; a test extension's
`confirm()` produces blocked/dialog.

## Design

- The extension detects `PI_JOB_ID`/`PI_JOB_TOKEN`/`PI_DAEMON_SOCK` (set
  by the PTY host) and registers the worker role (`extensions/worker.ts`).
- `lib/worker-state.ts` reduces pi events into a full `WorkerReport`
  snapshot: `agent_start` → working/busy; `agent_settled` → failed (model
  error), blocked/question (SM-3 question heuristics on the final text,
  with numbered choices for PK-3) or done; `ui_prompt_start` →
  blocked/dialog (`custom` only after 2 s, R6); no turn within 5 s of start
  in an empty session → blocked/first-prompt.
- Reports go over the daemon socket (`report` op, job token checked). State
  changes are sent at once, row-text-only changes at most every 15 s
  (SM-1); the reporter reconnects and resends the latest snapshot after a
  daemon restart.
- The daemon stores the report in `state.json`; rows gain `summary`,
  `question`, `choices`, `model`, `error`; `status`/`waitingFor` are shown
  only while the worker is alive. On a clean exit a reported failed turn or
  open question stands (blocked/question is answered by restarting the
  session); a dialog or a missing first prompt ends as done; a non-zero
  exit is failed; stop wins over any report.

## Review fixes (PR #1)

Independent review found: an error retried successfully still counted as
failed; text from an earlier message or run leaked into the verdict;
`/new`/`/resume`/`/fork` kept the old state; the final report could be
lost on shutdown; concurrent sends; no request timeout; sign-off phrases
("let me know…", "是否…") read as questions; nested dialogs cleared too
early; a dead worker could stay "needs input" on a dialog. All fixed with
tests (`test/worker-state.test.ts`, `test/reporter.test.ts`).

## Run

Stock pi 1.5.0, private tmux server, fixture `test/fixtures/ask-extension.ts`
(`/ask` opens `confirm("Deploy to staging?")` without a model call), model
`deepseek/deepseek-flash`.

| Job | Transitions (daemon log) | Final row |
|-----|--------------------------|-----------|
| `--bg '/ask'` | working → blocked (dialog); attach, answer Yes → done | done/idle |
| "Run ls … reply with one short line" | working → done | done/idle, summary "目录下有两个文件：a.txt 和 b.txt。" |
| "Ask me one yes/no question about deleting a.txt" | working → blocked (question) | blocked/waiting/question, question "是否要删除 a.txt？请回答 yes 或 no。" |

Automated: `npm test` — 7 files, 63 tests (adds heuristics, tracker,
daemon report handling and finalize rules).

## Left for later

- Model-written summaries and suggested replies (SM-2, M5).
- Question detection is heuristic; Chinese and English phrases only.
