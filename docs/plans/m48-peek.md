# M48: the peek, deeper (more to see, an editor to answer in, commands, completion)

Status: done 2026-11-05. The user liked the peek (Space on a row: what it asks or
said last, a reply box) and asked for more of it: more information, a freer reply box,
slash commands in it, a display that adapts to what the session is doing, and
autocompletion. Done before M47 (the task board) at the user's request.

## Use

```text
Space                      the peek: what the session is doing, asking or said; a reply box
reply › …                  an editor, as the task box: several lines (Shift+Enter / Ctrl+J), pastes folded, Ctrl+G external editor
Enter · Alt+Enter          send (joins its work) · send after its work (as before)
/                          a command for that session; Tab or typing opens the list:
  /stop /respawn /rm       stop · start again · delete (twice, as Ctrl+X)
  /pin /rename <name>      pin · rename (as Ctrl+T, Ctrl+R)
  /attach                  attach (as →)
  /model /thinking         switch its model or thinking level (as before)
  /name <name>             the session's own name (pi's /name, run in the session)
  /compact                 compact its context (run in the session)
  /continue                "Continue where you left off."
  /log                     its events (the feed, this session only)
  /transcript              its transcript tail in an overlay (a terminal agent: its screen)
  /ask <question>          ask the concierge about it (with the concierge on)
@path                      completion from the session's directory (Tab, as in pi)
```

The peek shows, besides what it showed (the sentence, numbered choices, the concierge's
suggestion, the facts line, the model line, a dialog note):

- **the task** it was started on (one line), **where** (cwd, `~`-shortened) and **since
  when** (started, elapsed; ended, how long it took);
- **what it has cost** (`$0.12 · 34k tokens`, `(sub)` on a subscription) on the model line;
- **the tail** of its transcript: the last few things it said and did (assistant lines,
  tool calls as `⚙ tool name`), live while the peek is open (refreshed every 2 s); a
  terminal agent's last screen lines instead; a failed session's error, whole;
- **what waits for it**: replies queued (`2 replies queued`), a watch on it.

The display adapts to the state: a **blocked** session leads with its question, the
choices and the suggestion, and the reply box says `answer ›`; a **failed** one leads
with the error and the box says `Enter: Continue where you left off`; a **done** one
leads with its result and the tail; a **working** one with what it does now (the tool,
how long) and the live tail. The tail takes the room the terminal has (more lines on a
tall terminal, fewer on a short one).

Autocompletion, in both boxes (the task box and the reply box), is pi's own (pi-tui's
`CombinedAutocompleteProvider`): `/` at the start opens the commands (the view's for the
task box; the session's for the reply box) with a description each and argument
completion (`/model` the models, `/thinking` the levels, `/preset` the presets,
`/profile` the profiles, `/concierge` its verbs); `@` opens paths under the directory
(the hub's for a task, the session's in a peek), with fuzzy matching when `fd` is
installed (found on the PATH once); ↑↓ choose, Tab takes it, Enter takes it and, on a
command, runs it at once (as pi's prompt does; on a path it only completes), Esc closes
the menu. The view's own Tab completion of `@dir` (M6) stays for the task box; any other
Tab goes to the editor, which opens the menu as pi's Tab does.

## How

### The reply box is an editor

`hub/task-editor.ts`'s `TaskEditor` takes a prompt (`reply › `, `answer › `) and is used
for the reply too (`this.reply`): the same keys as the task box (Shift+Enter/Ctrl+J a
line, a paste folded, undo, kill ring), `Ctrl+G` opens `$VISUAL`/`$EDITOR` on the reply
as on a task. ↑↓ move within a reply of several lines (as M17 for the task); on one
line they move between rows as before. Enter/Alt+Enter send as before. The digit
shortcut (1-9 on an empty reply fills a choice) stays.

### Commands in the peek

`sendReply` sees `/`: the first word names a command. The view's commands on that
session (`stop`, `respawn`, `rm`, `pin`, `rename`, `attach`, `log`, `transcript`, `ask`,
`continue`) run in the hub (the same code the keys use); `model`, `thinking` as before
(M8); `name` and `compact` go to the session as a reply, where the worker runs them
(`/name` as before, `/compact` through `ctx.compact()`; a session that is not running is
not started for them). Any other `/…` goes to the session as a plain reply, as before
M48 (pi's prompt templates and skills run there). `rm` needs a second `/rm` within 2 s
(as Ctrl+X Ctrl+X). `!` is refused as before.

### More in the row

`JobRow.task` (the first prompt, at most 200 characters, from the job's argv after `--`,
or the shell command) comes from the daemon's `list`. Everything else is there already
(`startedAt`, `endedAt`, `usage`, `error`, `cwd`, pending replies are counted from the
state file by the daemon: `JobRow.queued`).

### The tail

`lib/transcript.ts` (`readTail`, `transcriptItems`) reads the session file's end in the
hub (the hub runs where the sessions are): the last 256 KB (`readTail(file, max)`),
enough for a few lines. The peek keeps a small cache per row of raw lines (the file's
size and mtime as the key): every 2 s at most it `stat`s the file and reads it only when
that changed; the lines are cut to the width when rendered, so a narrower terminal is
fine. A terminal agent (`kind: "shell"`): `screen.txt`'s last lines (`lib/store.ts`
`screenPath`). The tail is the last N items that fit: N from the terminal's rows (at
least 3, at most 12), each item one line (`› the assistant's text…`, `⚙ read_file
src/x.ts`), the newest last. The `/transcript` overlay lays its text out again when the
width changes.

### Autocompletion

`TaskEditor` takes an `AutocompleteProvider`; the view builds one per box from pi-tui's
`CombinedAutocompleteProvider(commands, basePath)` with the commands as `SlashCommand`s
(name, description, `getArgumentCompletions`). The task box's commands are the view's
(`/model`, `/thinking`, `/resume`, `/worktree`, `/fanout`, `/compare`, `/preset`,
`/profile`, `/schedule`, `/concierge`, `/log`, `/usage`, `/subagents`, `/help`, `/exit`,
and pi's prompt templates and skills from `commands()`); the reply box's are the
session commands above. The base path is the dispatch directory (task) or the row's cwd
(reply). Tab in the task box: the editor's menu when it is open, else the view's `@dir`
completion (as M6). The editor's menu takes ↑↓/Enter/Tab/Esc while open: the view asks
the editor (`autocompleteOpen()`) before handling those keys.

### Tests

`test/agent-view.test.ts` ("M48: the peek, deeper"): the peek shows the task, where and
since when, the cost, the queued replies, the tail from a session file (a fixture; the
tail follows the file), a failed row's error whole and the box's hint per state;
`/stop`, `/respawn`, `/rename`, `/pin`, `/continue`, `/compact` and `/name` (replies),
an unknown command and `!` refused, a reply of two lines sent whole, `/rm` twice; `/log`
and `/transcript` overlays for that session; `/tra` + Tab completes to `/transcript`
through pi-tui's menu. `test/comms.test.ts` ("M48"): `task` (after `--`) and `queued`
(a reply pending, then acked) on the row. The worker's `/compact` (`ctx.compact()`) has
no unit test of its own: it sits beside `/model` in `applySetting`.

## Not in M48

- Attaching from the peek with the reply pre-typed into pi's prompt.
- Editing the task of a session that has not started (the queue is the daemon's).
- A peek on several marked rows at once.
