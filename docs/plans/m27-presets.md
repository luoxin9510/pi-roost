# M27: launch presets

Saved combinations for new sessions, chosen in the hub.

- A preset: `model`, `thinking`, `worktree` (true / false), `agent` (an agent preset's
  name), `dir` (relative to the hub's directory, as `@dir` takes it) and `fanout` (two
  to six models). All optional.
- Kept in `roost.json` under `presets` (name → preset): the user's file and a project's
  `.pi/roost.json` (the project's wins by name). Malformed entries are skipped.
- `/preset name` applies it to new sessions as a whole (what it leaves out is the default:
  nothing of the previous preset stays);
  bare `/preset`: a picker (each preset with what it sets; `none` clears); `/preset off`
  goes back to the defaults; `/preset save name` saves what new sessions use now
  (model, thinking, worktree, fan-out, the agent and directory of the preset in use) to
  the user's file; `/preset rm name` removes it from the user's file.
- The line under the header names the preset in use; a typed `@dir` or agent still wins
  over the preset's; a preset's fan-out applies to the next task, as `/fanout` does
  (applying the preset again sets it again).
- Safety: a preset's directory must stay under the hub's after links are resolved (else
  nothing starts and the notice says why); names `off`, `save`, `rm` and inherited
  object keys are not presets; a user file that does not parse is never overwritten;
  choices that would not read back (a model without its provider) are not saved;
  `/preset off` with no preset in use changes nothing.
- Checked: unit (parsing and merging, apply, save, remove, picker, dir and agent in
  dispatch) and a real pi.
