# M23: /resume and models in the hub

The first step of making the agent view a hub for many agents: open any past session
from it as easily as `pi --resume`, and choose what a new session runs as easily as in pi.

## /resume

- pi's own `SessionSelectorComponent` (exported by pi-coding-agent): search, this
  directory or all sessions (Tab), sort, named only. Loaded through `SessionManager.list`
  and `listAll`. Shown in place of the list (`Overlay`); its keys go to it.
- The session picked opens at once: a row that has it is attached (started again first
  when it ended, without the usual "Enter again" since it was chosen here); otherwise a
  new background job adopts it (`origin: "adopt"`, its own model kept) and is attached
  as soon as its worker runs. A session another pi writes: "open in another pi window".
- Its delete key never removes a session a live job or another pi is writing.
- When pi's component cannot be built (a pi without it), the view's own list, now with
  the sessions that have rows too (marked "listed").

## Models

- The picker is searchable (every typed word, any case; Esc clears the search first);
  with `enabledModels` set it shows those, Tab for all models (pi's scoped/all).
- Ctrl+L: the model for new sessions; in a peek, for that session.
- Ctrl+P / Shift+Ctrl+P: the next / previous enabled model (all when none is enabled).
- Shift+Tab: the next thinking level.
- The line under the header always says what a new session runs: the chosen model, or
  the default (`dispatchModel`, else the hub's own pi model).

## Checked

- Unit: picker search and scopes, cycling, thinking, the overlay's keys, a pick with and
  without a row, the fallback, Esc.
- In a real pi (isolated runtime): pi's list renders in the hub, search and Tab work, Esc
  returns; Ctrl+L search picks; a session picked opens and Ctrl+Z comes back to its row.
