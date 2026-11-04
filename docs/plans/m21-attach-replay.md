# M21: an attach starts from the host's screen

Status: implemented (2026-11-04). Reported from a port of pi-roost: entering a session
sometimes showed an old screen, leftovers in the wrong place, or a flash, until the
worker redrew; and M14's host test failed on Linux every time.

## What was wrong (M14's model)

The host keeps a full mirror of the session's screen (an `@xterm/headless` terminal that
every PTY byte goes into), but an attach did not use it. Instead:

1. it resized the PTY to the client's size (SIGWINCH);
2. for a worker that announced `attachRepaint`, it held all output back, up to 1.5 s,
   until the worker's repaint marker (`OSC 7700`);
3. it sent SIGUSR2, and the worker wrote the marker and redrew itself (`tui.stop` /
   `start` / `requestRender(true)`);
4. with no marker in time it cleared the screen and nudged the size (a visible flash).

Four problems:

- **No replay.** The picture depended on the worker redrawing. Shell jobs, older
  workers and anything that does not redraw showed a blank or stale screen.
- **Timing.** The repaint needed the signal delivered, a timer, and the marker. A slow
  machine hit the 1.5 s fallback: a clear plus a resize, so a flash.
- **A race.** SIGWINCH (step 1) and SIGUSR2 (step 3) are two signals, and their order
  is not fixed. Output the program wrote for SIGWINCH after the marker reached the user
  as a second draw. The test showed it on Linux (`painted\r\nwinch\r\n`): bash runs
  pending traps in signal-number order, and SIGUSR2 is 12 there but 31 on macOS.
- **Two draws** on every size change.

## What it does now

tmux's model: the host's mirror is the truth.

1. HELLO `{replay: true}`, then the PTY and the mirror take the client's size.
2. `term.write("", cb)`: once the mirror has parsed every byte that came before the
   attach, the host sends a **snapshot** of it (`@xterm/addon-serialize`,
   `scrollback: 0`):
   - an SGR reset, home and clear;
   - the main screen's rows;
   - the alternate screen when the program is on it (cleared first, since the user's
     terminal may be on its own alternate screen with the agent view);
   - the cursor, the colours, and the modes serialize carries (application cursor,
     bracketed paste, mouse tracking);
   - the modes it does not carry, which the host follows in the output itself
     (`lib/term-modes.ts` `ModeTracker`): cursor visibility, SGR/UTF-8/urxvt mouse
     encodings, focus events, the kitty keyboard flag stack, modifyOtherKeys.
3. Bytes that arrive after that point are queued and sent after the snapshot, then
   forwarded as they come. The client ends up with exactly the mirror's screen and stays
   in step with it. What the program draws for the new size arrives after the snapshot
   and is applied on top, as it was on the mirror. Nothing is held back, nothing is lost,
   and the order of signals does not matter.
4. `attached.json` says `replay: true`. A worker that sees it does not repaint, so the
   screen is drawn once. SIGUSR2 is still sent: the "while you were away" recap uses it.
   An older worker still repaints; its marker is stripped, and its redraw is a harmless
   second draw.

Removed: the hold, `REPAINT_WAIT_MS`, the clear-and-nudge fallback, and the host's
query answering while held. Terminal queries reach the client with the stream once a
client is attached.

No scrollback goes into the snapshot, so entering a session still prints no history into
the user's terminal (M14's goal).

## Review decisions

- **A sequence cut at the snapshot point.** A chunk may end inside an escape sequence.
  The part already written sits in the mirror's parser, not in the snapshot, and the
  rest is in the pending output, so the client would print the rest as text. The host
  follows the unfinished sequence (`StreamTail`: CSI, OSC/DCS/APC/PM/SOS up to ST or
  BEL, charset designations) and sends it first.
- **Modes at the snapshot point.** They are taken in `replay()`, not when the snapshot
  is written. A kitty push in the window would otherwise count twice, leaving the
  user's keyboard in kitty mode after detach.
- **The alternate screen alone.** When the program is on its alternate screen, the
  snapshot sends only that screen; the main rows would replace what the user's own main
  screen shows.
- **The client reset first.** `CLIENT_RESET` covers SGR, the scroll region, origin
  mode, the charset, cursor visibility, every mouse mode and encoding, focus, bracketed
  paste, application cursor, autowrap and the cursor shape. Modes are then set only
  where they differ from the defaults.
- **More state followed.**
  - DECSTBM: reset on resize; after setting it, the cursor is put back, origin mode
    considered.
  - DECSCUSR and the G0 charset.
  - RIS and DECSTR reset everything.
  - The kitty flags have one stack for each screen, as the protocol does, at most 32
    deep.
- **Resize order.** The mirror's resize waits for what it has yet to parse; the PTY's is
  immediate.
- **Terminal queries.** The host keeps answering them until the snapshot point is
  parsed: queries from before it never reach the client.

- Second round:
  - a resize clears the tracked scroll region at once, not when the mirror gets to it;
    a region the program sets for the new size must not be lost;
  - a scroll region per screen;
  - the cursor is put back after origin mode even without a region;
  - a string that overflows the 64 KB tail keeps its start;
  - ESC inside a string aborts it, and so do CAN/SUB;
  - sequences cut between chunks include cursor shape, charset and DECSTR;
  - a full kitty stack drops its oldest entry.

Left as is: a client that detaches right after receiving a query never answers it
(rare; the program times out, as with any terminal that goes away).

## Tested

- Host:
  - a quiet program's screen arrives at once, with no signal involved;
  - a SIGWINCH redraw arrives after the snapshot and is shown;
  - a full screen with the alternate screen, mouse, SGR mouse, kitty flags and a hidden
    cursor comes back whole;
  - an older worker's marker is dropped;
  - a takeover gets the same screen.
- `ModeTracker`: each mode, the kitty stack (push, pop, set or/and-not), and a sequence
  cut between chunks.
- End to end with a real pi 1.5.0 worker started while nobody was attached:
  - `pi-roost attach` showed the full screen (conversation, editor, footer) within
    0.4 s;
  - typing worked, and so did a resize (120×35 to 90×28) and detaching;
  - attaching again was just as immediate, with the unsent draft still in the editor;
  - the host log showed no repaint and no nudge.

## Not changed

The client (`lib/attach.ts`) is unchanged: it still resets the modes it may have been
left in on detach, and leaves the alternate screen only if the stream entered it.
