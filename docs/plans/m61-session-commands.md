# M61: a session's own slash commands in its peek

Asked by the user (2026-11-06), done before M55 as M48 was before M47: the peek's reply
box runs the session's own slash commands, not only the hub's, with a display that says
what each will do and completion as in pi.

Before M61 the reply box completed the hub's commands for a session (M48: `stop`,
`respawn`, `model`, `compact`, …). Any other `/…` went to the session as a reply, where
pi's `sendUserMessage(text, { expandPromptTemplates: true })` already ran extension
commands, skills and prompt templates. Missing: the menu never listed them, and pi's
built-in commands (`/session`, `/tree`, `/export`, …) never ran: they are handled by
pi's interactive editor, not by `sendUserMessage`.

## Use

```text
/            the menu lists, in this order, with a tag in the description:
  hub        the hub's commands for the session (M48): stop, respawn, rm, pin, rename,
             attach, model, thinking, name, compact, continue, log, transcript, ask
  pi         pi's built-in commands not already above: session, export, copy, reload,
             new, clone, changelog, hotkeys (run in the session, their output shown);
             settings, tree, fork, resume, scoped-models, trust, login, logout, import,
             share, bug (open in pi: typed there, then the hub attaches to it); quit
             (twice within 2 s)
  extension  the session's extension commands, with their descriptions
  skill      its skills (skill:name)
  prompt     its prompt templates
```

- What is shown fits the row: a session that is not running marks the commands that need
  it `(not running)`; a working one marks pi's built-ins `(when idle)`; a terminal agent
  (M30 profile) shows the hub's commands and the commands its profile declares.
- Enter on a built-in that shows output types it into the session's pi, waits for the
  screen to settle and opens the session's screen in an overlay (as `/transcript` does for
  a terminal agent), titled with the command; `r` reloads it, Esc closes.
- Enter on one that opens a picker in pi types it there and attaches, so the picker is in
  front of the user.
- An extension command, a skill or a prompt template goes as a reply, as before; the
  notice says `/name · session` instead of `sent`.

## How

### The session's command list

The worker writes `commands.json` in the job's directory (`lib/store.ts`
`commandsPath(id)`) on every `session_start` (startup, reload, new, resume, fork): pi's
`pi.getCommands()` mapped to `{ name, description, source: "extension" | "prompt" |
"skill" }`, at most 300, descriptions one line and at most 200 characters, written
atomically. The hub reads it when the peek's menu opens, cached by the file's mtime. A
session that wrote none (an older worker) lists the hub's and pi's built-ins only.

### pi's built-ins

pi does not export its list (`BUILTIN_SLASH_COMMANDS` is internal to
`@earendil-works/pi-coding-agent`'s `dist/core/slash-commands.js`), so
`lib/pi-commands.ts` carries the list of pi 1.5.0 with how each runs:

- `hub`: the hub has its own (`model`, `thinking`, `name`, `compact`): left out of the
  pi group.
- `screen`: runs and shows something (`session`, `export`, `copy`, `reload`, `new`,
  `clone`, `changelog`, `hotkeys`).
- `picker`: opens a picker or dialog in pi (`settings`, `scoped-models`, `tree`, `fork`,
  `resume`, `trust`, `login`, `logout`, `import`, `share`, `bug`).
- `confirm`: `quit` (ends the session).

A test reads the installed pi's `slash-commands.js` and fails when a name is added or
removed, so a pi upgrade cannot leave the list stale.

### Typing into pi

The host gets a control op `command` (`lib/hostclient.ts` `HostControlOp`), for a pi
worker only (an agent profile has `input`): `{ text }`, a single line that starts with
`/`, at most 500 characters, no control characters. The host writes it as a bracketed
paste (`ESC[200~` text `ESC[201~`), so pi's editor takes it as text without opening its
completion menu, then `\r`, which submits it to pi's editor handler. (Checked against a
real pi 1.5.0: `/session` pasted this way then Enter shows the session's info.)

The hub refuses, with the reason, when: the row is not a pi session; it is not running;
it is working or a dialog is open in it (state `working`, or `waitingFor: "dialog"`; a `blocked` session waiting on a question or its first prompt is fine: its editor is free); someone is
attached to it (the host's `status` says `attached`: their editor is theirs). For
`screen` commands it then waits ~800 ms and asks the host for a `snapshot`, shown in the
overlay; for `picker` ones it attaches (the same path as `/attach`).

### Profiles

An agent profile may declare `commands: [{ name, description? }]` (at most 100). They
are listed under the profile's name; Enter sends `/name args` as a reply, which the host
types into the agent as any reply to a profile (M30).

## Tests

- `test/pi-commands.test.ts`: the list matches the installed pi's names.
- worker: `commands.json` written on `session_start` from `getCommands()`, bounded.
- host: `command` refused for a profile host, for text that is not one slash line;
  written as a bracketed paste plus `\r` for a pi host.
- the view: the reply box's menu has the four groups in order with tags; `(not running)`
  and `(when idle)` marks; `/session` on an idle row calls `command` then `snapshot` and
  opens the overlay; `/tree` calls `command` then attaches; `/quit` needs a second
  `/quit`; refusals for a working row, an attached row, a profile row; an extension
  command goes as a reply; a profile's declared command is listed and sent as a reply.
