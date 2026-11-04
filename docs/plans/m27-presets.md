# M27: launch presets

Saved combinations for new sessions, chosen in the hub.

- A preset: `model`, `thinking`, `worktree` (true / false), `agent` (an agent preset's
  name), `dir` (relative to the hub's directory, as `@dir` takes it) and `fanout` (two
  to six models). All optional.
- Kept in `roost.json` under `presets` (name → preset): the user's file and a project's
  `.pi/roost.json` (the project's wins by name). Malformed entries are skipped.
- `/preset name` applies it to new sessions (what it leaves out stays as it was);
  bare `/preset`: a picker (each preset with what it sets; `none` clears); `/preset off`
  goes back to the defaults; `/preset save name` saves what new sessions use now
  (model, thinking, worktree, fan-out, the agent and directory of the preset in use) to
  the user's file; `/preset rm name` removes it from the user's file.
- The line under the header names the preset in use; a typed `@dir` or agent still wins
  over the preset's; a preset's fan-out applies to the next task, as `/fanout` does
  (applying the preset again sets it again).
- Checked: unit (parsing and merging, apply, save, remove, picker, dir and agent in
  dispatch) and a real pi.
