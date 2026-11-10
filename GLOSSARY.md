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

**Schedule**:
A named dispatch template with a rhythm (`every 2h`, `daily 09:00`, a cron expression): the daemon starts a Session from it each time a slot comes due, never two runs at once.
_Avoid_: cron job, timer

**Watch**:
A Session's standing request to be told once, as a notice, when another job is next idle or has ended; it expires if it never fires, and a session keeps a few at a time.
_Avoid_: subscription, listener

**Standing order**:
A rule in the user's words that the Concierge keeps: it is in every digest, and one with a rhythm (`daily 18:00`) wakes the Concierge when its time comes. The Person or the Concierge adds one; the Person's are the Person's to drop. The Concierge says when it has applied one; the model applies it, the daemon only keeps it.
_Avoid_: rule, reminder, instruction

## The hub

**Hub**:
The TUI a Person drives the roost with: the list of Sessions, the input, dispatch and the peek, and the Overlays on top. It talks to the daemon only through one port (`hub/roost-port.ts`).
_Avoid_: dashboard, agent view (the name of the class that is the hub's core)

**Overlay**:
A screen the Hub shows in place of its list (workspaces, review, the task board, the concierge, schedules, the log, usage, compare), with its own keys. It is built from a host (the port, the theme, a few verbs) and sees pushed events through `onEvent`; it does not hold the Hub.
_Avoid_: modal, popup, panel (the subagent panel is another thing)

**Layer**:
What is open on top of the Hub's view (the list, or a row's peek) and takes the keys: the help, a picker, a rename, or an Overlay. One at a time (M79): what opens last is what is open; the concierge's answer waits for the one open to close.
_Avoid_: mode (the view and the layer are two things: a picker over a peek closes back to the peek)

## The protocol

**Op**:
One request the daemon answers over its socket (`ping`, `dispatch`, `task`, ...). Each has a schema for its arguments and one for its result (`lib/protocol-schema.ts`), which are the source of its TypeScript types and of its row in the op reference of `docs/protocol.md`. `task`, `concierge`, `concierge-order` and `concierge-act` are one Op with a variant per `action` (or `what`).
_Avoid_: command (a slash command is the Hub's), endpoint, message (a message is what one Session sends another)

**Capability**:
A word in a `hello` that says what the sender can do. The daemon's (`DAEMON_CAPABILITIES`) say which ops and deliveries an agent may expect; an agent's (`AGENT_CAPABILITIES`) say what roost may expect of it. Unknown ones are ignored; the lists only grow with a protocol version.
_Avoid_: feature, flag
