# M25: marking rows, acting on all of them

One action for many sessions from the hub.

- Ctrl+O marks the selected row (a check in the second column) and moves to the next,
  so Ctrl+O Ctrl+O marks two; on a group header it marks the whole group, again unmarks
  it. Marks follow the rows, not the cursor; a removed row drops out.
- With rows marked:
  - typed text and Enter go to every marked session as a reply (not a new task); shell
    jobs are skipped; the notice counts sent, saved for the next start and not delivered;
  - `/model x`, `/thinking x` switch all of them (each switch is checked as a peek's is);
    bare, one picker for all; other view commands are refused while rows are marked;
  - Ctrl+X stops them all, again within 2 s deletes them (and unmarks them);
  - Ctrl+T pins them all, or unpins them when all are pinned already.
- Esc: closes the peek, clears the input, then clears the marks, then leaves.
- The footer says how many are marked and the batch keys.
- Checked: unit (marking, moving on, group marks, batch reply, shell skip, batch model
  and picker, refusal of other commands, stop/delete, pin/unpin, Esc order, a removed
  row) and a real pi.
