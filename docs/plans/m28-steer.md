# M28: steer or wait, as in pi

A reply to a session that is working either joins the work under way or waits for it,
with pi's own keys (an idea durable's `whenBusy: "steer"` names too).

- In a peek: Enter steers (pi's Enter while it works: after the current tool calls, into
  the same run); Alt+Enter queues it after the current work (pi's Alt+Enter, follow-up).
  An idle session starts a turn either way. Marked rows (M25) take the same two keys.
- The reply op takes `mode: "steer" | "followUp"`; absent (older clients, the CLI) it
  waits, as before. The daemon keeps the mode with the pending reply, so a resend after a
  reconnect steers too; the worker hands it to pi as `deliverAs`.
- The notice says which: "joins its current work" or "after its current work".
- Checked: unit (reply queue, daemon round trip and resend, view keys) and a real pi: a
  steer typed while the session ran `sleep 25` landed after the tool result in the same
  run, and its one final answer carried both requests.
