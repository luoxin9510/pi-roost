# M6a — organise the agent view: acceptance (2026-11-03)

Scope (PRD §10 M6, first half): AV-K6…K10, K13, K14, DI-7, the `groupBy`
setting. P1 rows of §2: "Ctrl+S group by directory, persisted", "Pin
Ctrl+T keeps process alive; reorder Shift+↑↓; rename Ctrl+R; collapse",
"s: n: o: filters". Dispatch extras (DI-3…DI-6, BG-8) follow in M6b;
Shift+Enter newlines and Ctrl+G ($EDITOR, a P2 row) come with pi's editor
component in M7.

## Design

- Daemon ops `pin`, `rename`, `reorder`; rows carry `pinned` and `order`.
  Pinned jobs are never reaped (DM-4). `rename` updates the job record (so
  `attach <name>` finds it), the row, and a live worker's session (`/name`
  through the reply queue, so its next report keeps the name).
- `lib/filter.ts` (DI-7): input made only of `s:` `n:` `o:` tokens is a
  filter, not a task. `s:` takes states, groups and prefixes (`s:comp`,
  `s:needs`, `s:pinned`, `s:running`); bare `o:` means "has a result".
  Kinds combine with AND, several values of one kind with OR. While a
  filter applies, groups open, nothing folds, the first match is selected
  and Enter attaches. "no sessions match" when empty.
- Layout (`lib/view-model.ts`): `groupBy: "directory"` gives Pinned, then
  one section per directory (most recent activity first, `~` paths).
  Reordered rows keep their order below rows never moved.
- Keys: Ctrl+S grouping (saved to `~/.pi/agent/roost.json`), Ctrl+T pin,
  Ctrl+R rename (own input; Enter saves, Esc cancels), Shift+↑/↓ reorder
  within the group, Alt+↑/↓ previous/next group header, Alt+1…9 attach to
  row N of the selected row's directory, Ctrl+F types `n:`. The `?` overlay
  lists them.
- Found on the way: the host wrote `workerPid` into `state.json` while the
  daemon rewrote it, so a daemon change made at that moment could be lost
  (seen as a flaky test). The host now writes `worker.json`; `state.json`
  has one writer.

## Run (stock pi 1.5.0, tmux 110×32, deepseek-flash)

Two `--bg` jobs, in `e2e/` and `e2e/sub/`; `pi --agents`.

| Key | Result |
|-----|--------|
| Ctrl+S | sections `Pinned`… then `~/.claude/jobs/…/e2e` and `…/e2e/sub`; `~/.pi/agent/roost.json` = `{"groupBy": "directory"}` |
| type `n:beta` | only the BETA row; footer `filtering (s: n: o:) · Enter/→ attach · Esc clear` |
| Ctrl+C, Ctrl+T | row moved under `Pinned (1)`; `--json` `pinned: true` |
| Ctrl+R, new name, Enter | row `renamed live job`; still so after the worker's next reports |

Automated: 14 files, 118 tests (filters, directory layout, manual order,
view keys with a fake daemon, daemon organise ops).
