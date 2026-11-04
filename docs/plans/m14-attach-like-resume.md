# M14: attach feels like `pi --resume`

Status: implemented (2026-11-04). Entering a session from the agent view or the subagent
panel did not feel like pi: the screen flickered, the mouse wheel and in-app scrolling did
not work, and the transcript of the view you left was printed into the terminal's
scrollback each time.

## Why

- pi 1.5.0 runs **fullscreen** by default (`tuiMode: "fullscreen"`: alternate screen, mouse
  tracking, in-app scrolling and search). A worker starts while nobody watches, so it
  entered the alternate screen, turned mouse reporting on and asked for the kitty keyboard
  protocol **in the PTY only**. The real terminal never got those modes; on attach it saw
  frames drawn for a screen it was not on.
- The host forced a redraw by resizing the PTY one row smaller and back: two full renders.
- The foreground `tui.stop()` before attaching, without `preserveScreen`, made fullscreen
  pi print its whole transcript into the main screen.

## What changes

- The worker (`registerAttachRepaint`) answers the host's attach signal (SIGUSR2, AT-5)
  by `tui.stop({ preserveScreen: true })` + `tui.start()` + `requestRender(true)`: the
  same start a fresh `pi --resume` makes, now on the real terminal (alternate screen,
  mouse, bracketed paste, kitty keyboard query answered by the user's terminal), then one
  synchronized frame. A takeover (a new `at` in `attached.json`) repaints again.
- Workers say so in their reports (`attachRepaint: true`); the host then skips both the
  resize nudge and its screen clear, and sends the attach size before the signal, so pi
  draws once at the right size. Shell jobs and older workers keep the nudge and the clear
  (now sent by the host, not the client).
- The agent view and the subagent panel stop their TUI with `preserveScreen`.
- `TERMINAL_RESET` after detach also leaves the alternate screen and resets focus events,
  synchronized output and autowrap, so `pi-roost attach` from a shell returns cleanly; the
  foreground's `tui.start()` re-enters its own screen.

A regular-mode pi (`tuiMode: "regular"`) gets the same restart: its first frame clears
and writes the whole session into the scrollback, as a resume does.

## Tests

- Host: a worker with `attachRepaint` gets the signal and neither the clear nor a resize;
  one without gets the clear and the nudge.
- Live (tmux): attach stream = leave/enter alternate screen, modes, queries, one frame; no
  transcript dump; PageUp scrolls the session in-app; Ctrl+Z restores the agent view with
  the main-screen scrollback untouched.
