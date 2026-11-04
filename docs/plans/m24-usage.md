# M24: usage and cost in the hub

What the sessions spend, where they are managed.

- The worker counts its session as pi's footer does (`lib/usage.ts` `sessionUsage`):
  assistant messages, usage entries, tool results, compactions and branch summaries, keyed as pi keys them; the share since
  local midnight; cost and tokens per model (the largest eight, the rest as `other`). A
  subscription (OAuth to a provider marked `isSubscription`, kimi-coding) marks it notional (`sub`).
- Counted at each start and after each reply; sent with the row text's pace (a change
  of usage alone waits the summary interval), stored by the daemon (`usageFrom`
  validates it), kept when a report has none (older workers).
- The view: a cost column per row when the summary keeps its room (it goes before the
  model and share do); the header `· $x today · $y all` over every session in the view,
  subagents included; `/usage`: totals, by model (cost, tokens, sessions), by session
  (most first, today's share, `(sub)`). Today's share of a session counted on an earlier
  day is 0.
- Checked: unit (sums, today, models, malformed input, totals, columns, panel), daemon
  round trip, and a real pi: a dispatched task's row and the header show its cost, and a
  daemon restart gets the usage again from the workers' reconnect.
