# pi-roost

A roost of coding-agent sessions on one machine: a daemon runs and keeps them, a hub (the TUI) and the CLI drive them, and they talk to each other through it.

## Callers

Who is on the other end of a connection to the daemon. Every op is allowed or refused by the caller's kind.

**Caller**:
Who is on the other end of one connection to the daemon, as the daemon judges it: a Person, a Session, the Concierge, or an Unregistered agent.
_Avoid_: actor, peer (a peer is what `peer_register` makes: one way a Session becomes known)

**Person**:
The user, through the hub or the CLI: a connection that never identified itself as an agent. The daemon's socket is the user's own, so such a connection is trusted as the user.
_Avoid_: user connection, hub (the hub is one program a Person uses)

**Session**:
An agent session the roost knows: a job the daemon runs, or a foreground pi registered as a peer.
_Avoid_: worker (one kind of Session), agent (also covers ones the roost does not know)

**Concierge**:
The resident session that watches the roost for the Person and, under its policy, answers and acts for them.
_Avoid_: lead, supervisor

**Unregistered agent**:
A connection that said it is an agent (a hello or a report) but whose report the daemon has not accepted. It may do nothing but identify.
_Avoid_: anonymous peer
