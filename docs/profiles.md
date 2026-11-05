# Agent profiles: terminal agents besides pi

A profile lets roost run a terminal agent it has no code for (level 0 of
[any agent](plans/any-agent.md)). roost starts it in a terminal of its own, as it does a
pi session, and reads what state it is in from that terminal: whether its screen still
moves, what it tells the terminal, and patterns you give. You can attach, detach, stop,
delete and reply to it, give it a worktree, and put it in a preset.

## Defining one

Profiles go in **your** `roost.json` (`~/.pi/agent/roost.json`, or
`~/.config/roost/roost.json` when that exists), under `agentProfiles`. A project's file
cannot define them: a profile is a command roost runs, and a cloned repository must not
choose one.

```json
{
  "agentProfiles": {
    "claude": {
      "command": ["claude"],
      "model": ["--model", "{model}"],
      "resume": ["claude", "--continue"],
      "working": "esc to interrupt",
      "waiting": "Enter to confirm|Do you want to"
    }
  }
}
```

| Key | Meaning |
|---|---|
| `command` | the argv it starts with. An array, never a shell line: no shell, no `$VARS`, no globbing. |
| `task` | how the first task reaches it: `"argv"` (default: added as the last argument), `"type"` (typed in once it is first quiet), or `"none"`. |
| `model`, `thinking` | argv added when `/model` or `/thinking` chose a value; leave one out and the agent takes no such choice. |
| `resume` | argv that reopens its last session; a reply to an ended one starts this and types the reply in. Without it the reply starts `command` again. |
| `working` | a regex (case-insensitive, over the whole screen) meaning it is working, whatever else the screen says. |
| `waiting` | a regex meaning it waits for you; the line it matched is the row's question. |
| `submit` | what is typed after a reply (default `"\r"`). |
| `settleMs` | how long a still screen means quiet (default 3000, 500–60000). |
| `env` | extra environment; names on your `envDenyList` are dropped, as from any job. |

In the argv templates, an element that is exactly `{model}`, `{thinking}` or `{task}`
becomes that value (and goes when there is none). Nothing else is substituted. A
`command` that places `{task}` or `{model}` itself gets it there instead of at the end.
`pi`, `shell`, `off` and `none` are not profile names. A profile with something
malformed (a bad regex, a string for `command`) is left out.

## Using one

- `/profile claude` in the agent view: new sessions run it (the line under the header
  says `runs claude`). Bare `/profile` picks one; `/profile pi` goes back.
- `/model` takes any id while a profile is chosen (the agent's own names: `haiku`, `o3`).
- A preset can name one: `{"presets": {"quick": {"profile": "claude", "model": "haiku"}}}`.
- Fan-out (`/fanout`) and pi agent names run pi sessions only.

## How its row is read

From the strongest signal down:

1. The process: when it exits, done (code 0) or failed.
2. `working` matches: working.
3. `waiting` matches: needs input (a dialog), with the matched line as the question.
4. OSC 133 marks (shell integration): a command running is working.
5. The screen still moving (within `settleMs` of a change, or of a reply typed in):
   working.
6. A notification (OSC 9, OSC 777) or bell since roost last typed into it: needs input,
   with the notification as the question.
7. Otherwise, quiet: done, or waiting for a first prompt when it was never given one.

The row's text is the title it sets (OSC 0/2), else its last line (none for a full-screen
agent without a title). The model column shows the profile and the model chosen at
launch; context, cost, transcript, `/resume`, subagents and peers are not known for it.

## Replies

A reply is typed into its terminal, then `submit`. Steer or wait (Alt+Enter) does not
apply: it goes wherever its input is. A reply suits a text prompt; a menu (pick with the
arrow keys) wants an attach (→), where you answer it as you would anywhere. An ended
one is started again (`resume`, else `command`) and the reply typed in once it is quiet;
if it exits first, the row says what was not typed in.

## Tested with

Claude Code (the profile above): start with a task and a model, a trust dialog shown as
needing input, attach and answer it, replies typed in, `--continue` after a stop with the
conversation kept. Other agents should work the same way; their flags and wording are
theirs to look up.
