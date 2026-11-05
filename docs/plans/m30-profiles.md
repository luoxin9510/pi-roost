# M30: agent profiles (level 0)

The second step of [any agent](any-agent.md): terminal agents roost has no code for,
run from a profile in the user's `roost.json`. The guide is [`../profiles.md`](../profiles.md).

- `agentProfiles` (user config only): `command`, `task` (argv / type / none), `model`,
  `thinking`, `resume`, `working`, `waiting`, `submit`, `settleMs`, `env`. argv templates:
  placeholders replace whole elements, no shell, no environment expansion; the profile's
  `env` goes through the deny list. `lib/profiles.ts`.
- A profile job is a shell-kind job with `profile`, `term` (how its screen is read and
  replies are typed) and `resumeCommand` on its record: no worker, no session file, no
  writer lock, as a shell job; unlike one, it may have a worktree, its row stays after it
  exits, and it takes replies.
- The host collects the terminal's signals (`lib/term-signals.ts`): OSC 0/2 titles,
  OSC 9 / 777 notifications, BEL, OSC 133 marks, the alternate screen, and when the
  screen's text last changed; it writes them to `term.json` and the screen to
  `screen.txt` together, every second while it changes.
- The daemon decides the row from them (`inferTermState`, strongest first: regexes,
  OSC 133, a moving screen, a notification or bell since the last input, quiet). A task
  of `task: "type"`, or a reply to an ended job, is typed in once it is quiet at a prompt
  (never into a dialog).
- A new host op, `input`, types text into the terminal; a reply is the text, then the
  profile's `submit` a moment later (some agents take a burst as a paste). A reply to an
  ended one restarts it (`resume`, else `command`); if it exits before the reply is typed,
  the row says so.
- The hub: `/profile` (sticky, bare picks), `profile` in presets (with the agent's own
  model ids), `runs <profile>` on the line under the header, replies and marked replies
  reach profile rows, their model column shows the profile; fan-out and pi agent names
  stay pi's.
- Checked: unit (profiles, templates, config is the user's only, presets, the signal
  collector against a real xterm, the state inference), the daemon with a fake terminal
  agent (state from its notifications, typed replies, the waiting regex, the row kept
  after exit, a reply restarting it, a typed first task), the hub (`/profile`, presets,
  rows), and Claude Code by hand: a task and a model in argv, its trust dialog as
  needing input, attach to answer, a typed reply, `--continue` after a stop with the
  conversation kept.
- Found by hand: a menu cannot be answered by typed text (a `2` did not pick the second
  item, and the Enter took the first); documented: menus want an attach.
