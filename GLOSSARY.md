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

## Tasks and their workspaces

**Task**:
A piece of work on the roost's board: added by the Person or the Concierge, taken by a Session, done with a result.
_Avoid_: ticket, job (a job is a session or command the daemon runs)

**Workspace**:
A Task's own branch and working copy in a repository, with the Stage it is at. The worktree is only where its files are on disk.
_Avoid_: worktree (for the concept), sandbox

**Stage**:
Where a Workspace is in its life: working, verifying, review, merging, conflict, failed, shelved or merged.
_Avoid_: status, phase

**Base**:
The branch a Workspace was made from and is merged back into.
_Avoid_: target, trunk, main (one possible Base)

**Verify**:
The repository's own check of a Workspace (its verify command, approved by the Person), run when the Session says the Task is done.
_Avoid_: CI, tests (what the command runs is the repository's business)

**Review**:
The Stage where a verified Workspace waits for the Person: to merge it, send it back, or leave it.
_Avoid_: approval (approving is of the repository's commands)
