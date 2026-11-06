# M51: request ids from the hub and the CLI

M36 made a resend safe: a `reply` or a `dispatch` sent again with the same `requestId` is
taken once. But only the stress run and the evals sent ids; the hub, the CLI, pi's panel
and `/bg` did not, so a reply whose answer was lost when the daemon restarted was shown as
an error (sent or not, nobody knew), and sending it again by hand could queue it twice.

## What changed

- `requestOnce(via, op, args, {timeoutMs, tag})` in `lib/client.ts`: the request goes with
  an id (`newRequestId(tag)`: the tag, the pid, the time, four random bytes; within the
  daemon's rule), and when no answer comes because the connection went (a `closed` error,
  a socket error, no connection to be had), it is sent again with the same id on the
  connection `via()` gives then, waiting 200 ms doubling to 2 s, for 15 s at most. A
  refusal (the daemon answered with a code) is not sent again. `DaemonClient.isClosed`
  says whether a connection is gone.
- The hub's replies (the peek, the batch, `/model` and `/thinking`, the peek's `/compact`
  and others, Ctrl+Y on a suggestion with its own id as before) and dispatches (new
  sessions, `/resume`, fan-outs) go through it; `live()` waits up to 10 s for the hub's
  connection to be made again. pi's subagent panel (its replies), `/bg` and the phone's
  start (their dispatches), and `pi-roost reply` do too, each connecting again itself.

## Review

- A refusal is what the daemon answered (`DaemonError.fromDaemon`); a code made on this
  side (`start_timeout` from `connectOrStart`, say) is not one, and is tried again. Given
  up after the request was sent, the error is `lost` (it may have been taken), and
  `refusedByDaemon` is false for it: `/bg`, the phone and the hub's adopt and fan-out do
  not discard a worktree a session may already run in. Never sent: the error as it was.
- The hub's `live()` waits no longer than the request's own deadline; a hub that closes
  throws `GiveUp`, which stops at once. A peek reply is sent one at a time (a second
  Enter while it is sent again does nothing); a batch reply or a fan-out stops at the
  first that got no answer instead of waiting for each; a resend answered `duplicate`
  says sent.
- pi's panel closes a connection it opened for a resend.
- A dispatch whose job was removed before the resend makes a new one (the daemon finds
  the request id on the job record).

## Tests

`test/request-once.test.ts` (resent with one id after a lost answer and a refused
connection; a refusal once; a local error on a resend tried again and given up as `lost`;
never sent, the error as it was; `GiveUp` at once; an id given is kept; it gives up after its time; ids fit the
rule); `test/comms.test.ts` "M51" (a reply whose connection goes right after it is
written is sent again and queued once, against the real daemon); the hub's tests check
that its replies carry an id.
