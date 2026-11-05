# M31: the agent protocol and its clients

The third step of [any agent](any-agent.md): the protocol between an agent and roost,
written down ([`../protocol.md`](../protocol.md), draft v1), with a client in TypeScript
and one in Python, and pi's worker on the TypeScript one.

- `hello` (new op): the agent's protocol version, name, version and capabilities; the
  daemon answers with its protocol (1), its version and what it offers. Kept with the job
  (`agentInfo` in its state; `capabilities` on its row). A daemon from before M31 answers
  `bad_request`: the clients go on without it.
- The TypeScript client, `lib/agent-client.ts` (package export `pi-roost/agent`): the
  job's identity, `Reporter` (moved out of pi's worker unchanged, plus the hello on each
  connection) and `RoostAgent` (fromEnv, report with defaults, onReply once per seq, in
  order, acked after the handler). pi's worker imports it and says hello as `pi`.
- The Python client, `sdk/python/roost_agent.py`: one file, standard library only, the
  same behaviour (a connection thread, a reply thread, reconnect with backoff, the latest
  report resent).
- A profile with `"protocol": true` runs such an agent: the host gives it the job's
  identity, its reports set the row (its terminal only until the first), replies go
  through the pending/deliver/ack path, a `task: "type"` task is its first reply, an
  ended one restarts with its reply waiting, and context and usage show when it sends
  them.
- Checked: the suite, plus conformance tests running a scripted agent on each client
  against a real daemon (the first task as a reply, reports, acks, a daemon restart under
  it with the next reply taken once, its exit); hello answers and refusals; profiles
  with `protocol`.
- Not yet: the protocol frozen as v1 (after an agent outside this repository has used
  a client), the peer ops described in full.
