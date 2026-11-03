<p>
  <img src="https://raw.githubusercontent.com/luoxin9510/pi-roost/main/assets/agent-view.png" alt="pi-roost agent view" width="1100">
</p>

# pi-roost

**Every background pi session on one screen.** · [中文介绍](#中文介绍)

[![npm version](https://img.shields.io/npm/v/pi-roost?style=for-the-badge)](https://www.npmjs.com/package/pi-roost)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)](#install)

Run many pi sessions at once without juggling terminals. Hand a task to the background,
keep working, and come back when something needs you. pi-roost lists every session on one
screen: what each one is doing right now, which one is asking you a question, and what has
finished. Answer from the list, jump into any session, jump back out. Close the terminal and
the sessions keep going.

- **Fire and forget.** Type a task, press Enter, and it runs in the background.
- **See everything at a glance.** A live one-line summary per session, grouped into
  *Needs input*, *Working* and *Completed*.
- **Answer without switching.** Peek at a session and reply right in the list.
- **Jump in, jump out.** Enter opens a session full-screen; ← on its empty prompt brings
  you back.
- **Move what you already have.** ← on an empty prompt (or `/bg`) sends the current
  conversation to the background, right where it was.
- **Outlives the terminal.** A per-user daemon keeps the sessions alive.

pi-roost is a plain pi package: one extension, a small per-user daemon and a PTY host per
session. Pi itself is not changed.

## 中文介绍

**一个屏幕，管理所有后台 pi 会话。**

想同时跑好几个 pi 任务，又不想开一堆终端窗口来回切换？把任务交给后台，你继续干自己的事，等有会话需要你时再回来。pi-roost 把所有会话列在同一个屏幕上：每个会话此刻在做什么，哪个在等你回答，哪些已经完成，一目了然。你可以直接在列表里回复，随时进入任意一个会话，也随时退回列表。关掉终端，会话照样在跑。

- **派完就走**：输入任务，按回车，它就在后台跑起来。
- **一眼看全**：每个会话一行实时摘要，按“需要输入 / 进行中 / 已完成”分组。
- **不切换就回复**：按空格偷看会话，在列表里直接回答它的问题。
- **随进随出**：回车进入会话全屏操作，在它的空提示符下按 ← 回到列表。
- **聊到一半也能转后台**：在任意会话的空提示符下按 ←（或输入 `/bg`），当前对话原样转到后台继续跑。
- **不怕关终端**：每个用户一个常驻的后台守护进程，会话不会随终端一起退出。

```bash
pi install npm:pi-roost
pi --agents
```

建议在 `~/.pi/agent/roost.json` 里配置一个便宜的摘要模型，例如 `{"summaryModel": "anthropic/claude-haiku-5-5"}`，这样会话会自动命名、显示进度摘要。想用公司内部的 LLM 节点，见 [docs/summary-model.md](docs/summary-model.md)。完整的按键、配置和 CLI 说明见下面的英文文档。

## Install

```bash
pi install npm:pi-roost
```

Requires pi 1.5.0 or newer, on macOS or Linux. On Linux, installing builds
[node-pty](https://github.com/microsoft/node-pty) from source, so it needs `make`, a C++
compiler and Python (`build-essential` and `python3` on Debian and Ubuntu).

## Try this first

```bash
pi --agents
```

Type a task at the bottom and press Enter. It starts in the background and shows up as a
row with a live one-line summary. Start a few more. Then:

- **Space** on a row peeks at it: the latest output, and a reply box if it asked something.
- **Enter** (or →) opens the session full-screen. **←** on its empty prompt, or **Ctrl+Z**,
  brings you back to the list.
- **Esc** leaves the view. The sessions keep going; `pi --agents` shows them again.

Already in a normal pi conversation that will take a while? Press **←** on the empty
prompt (or type `/bg`) and it moves to the background, right where it was.

## What you get

**One list, grouped by what needs you.** Sessions are grouped into *Needs input*,
*Working* and *Completed* (or by directory, Ctrl+S). The terminal title counts the ones
waiting for you, and the terminal notifies you when one asks a question or finishes.

**Dispatch from anywhere.**

| Input | What it does |
|---|---|
| `fix the flaky test` | a new background session in this directory |
| `@api fix the flaky test` | the same, in `./api` (Tab completes repos and worktrees) |
| `! npm test` | a shell command as a job; the row shows its last output line |
| `/model`, `/thinking` | model and thinking level for sessions started from this view (bare: pick from a list) |
| `/resume` | bring back an earlier session of this directory |
| Ctrl+G | write a long task in `$VISUAL` / `$EDITOR` |
| Ctrl+Enter | start the task and open it straight away (needs a terminal that reports Ctrl+Enter) |

From the shell: `pi --bg "run the tests and summarise failures"`.

**Move conversations to the background.** In any pi session:

- **←** on an empty prompt, `/bg` or `/background`: this conversation continues in the
  background and the agent view opens with it highlighted.
- `/fork <prompt>`: a copy of this conversation runs `<prompt>` in the background while
  you keep going here.
- Quitting (Ctrl+D, `/quit`) while a turn is running offers to move it to the background
  instead of stopping it.

**Sessions outlive the terminal.** A per-user daemon owns every session, so closing the
terminal, or the pi you started them from, does not stop them. A session that crashes is
restarted once. One that has sat idle for an hour stops its process (it is still listed,
and replying or opening it starts it again where it left off); pin it with Ctrl+T to keep
it running.

**Keep it tidy.** Filter with `s:working`, `n:auth`, `o:error` (combine with spaces),
rename with Ctrl+R, reorder with Shift+↑/↓, fold groups, pin, and stop with Ctrl+X (twice
to delete). Press `?` in the view for every key.

## Keys

| Key | In the agent view |
|---|---|
| ↑ ↓ PgUp PgDn | move (Home and End too, when the input is empty) |
| Enter | open the session · start the typed task · fold a group |
| → | open the session |
| Space | peek and reply |
| Ctrl+Enter | start the typed task and open it |
| Ctrl+X | stop; again within 2 s to delete |
| Ctrl+S | group by state / directory |
| Ctrl+T | pin / unpin |
| Ctrl+R | rename |
| Shift+↑ Shift+↓ | move the row within its group |
| Alt+↑ Alt+↓ | previous / next group |
| Alt+1…9 | open row N of this directory |
| Ctrl+F | find by name |
| Esc | close the peek · clear the input · leave |

Inside a session, ← on an empty prompt, `/exit` or Ctrl+Z goes back to the list.

## Configuration

`~/.pi/agent/roost.json` (a project can override some keys in `.pi/roost.json`):

```json
{
  "fullscreen": true,
  "groupBy": "state",
  "summaryModel": "anthropic/claude-haiku-5-5",
  "dispatchModel": "anthropic/claude-sonnet-5-5",
  "dispatchThinking": "medium",
  "reapIdleMinutes": 60,
  "notify": "auto",
  "leftArrowOpensAgents": true,
  "defaultToAgentsView": false,
  "envAllowList": ["GITHUB_TOKEN"]
}
```

| Key | Default | |
|---|---|---|
| `fullscreen` | `true` | the view covers the terminal; `false` shows it below the conversation |
| `groupBy` | `"state"` | or `"directory"` (Ctrl+S toggles and remembers) |
| `summaryModel` | none | a cheap model for row summaries, session names and "while you were away" recaps; without it rows show the latest output; any model pi can reach works, including a company endpoint ([guide](docs/summary-model.md), in Chinese) |
| `dispatchModel`, `dispatchThinking` | pi's defaults | for sessions started from the view |
| `reapIdleMinutes` | `60` | stop the process of a session idle this long (it restarts on demand) |
| `notify` | `"auto"` | `"osc9"`, `"osc777"`, `"bell"` or `"off"` |
| `leftArrowOpensAgents` | `true` | ← on an empty prompt moves the conversation to the background |
| `defaultToAgentsView` | `false` | plain `pi` opens the agent view |
| `envAllowList` | `[]` | extra environment variables for background sessions |

Background sessions get a small environment (`PATH`, `HOME`, `SHELL`, `LANG`, `TERM`,
proxy variables and a few more) plus `envAllowList`. A project's `.pi/roost.json` cannot
set `envAllowList` or `summaryModel`.

## CLI

The package installs a `pi-roost` command:

```text
pi-roost --json [--all] [--cwd <dir>]   list sessions as JSON
pi-roost attach <id|name>               open a session (Ctrl+Z detaches)
pi-roost logs <id|name>                 print its current or last screen
pi-roost reply <id|name> <text>         send a reply
pi-roost stop <id|name>                 stop it
pi-roost rm <id|name>                   stop it and delete its record
pi-roost respawn <id|name> | --all      start ended sessions again (or restart live ones)
pi-roost daemon status|logs|stop [--keep-workers]
```

If `pi-roost` is not on your `PATH` (pi installs packages under its own directory),
run it as `node ~/.pi/agent/npm/node_modules/pi-roost/dist/bin/pi-roost.js`.

## For extension authors

pi-roost emits `agents:job_needs_input` and `agents:job_completed` on `pi.events` with
`{ id, name, cwd, state, summary, question, error }`.

Other extensions and scripts can drive it through `pi-roost/api`:

```ts
import { spawn, list, attach } from "pi-roost/api";

// inside a pi extension; from a plain script, also pass piCli: the path of pi's cli.js
const { id } = await spawn({ task: "run the regression suite", cwd: process.cwd() });
const jobs = await list({ cwd: process.cwd() });
await attach(id); // hands this terminal to the session until it detaches
```

## How it works

```text
 pi (agent view) ──┐                    ┌── host ── pty ── pi worker (session A)
 pi (any session) ─┼── unix socket ── daemon ── host ── pty ── pi worker (session B)
 pi-roost CLI ─────┘                    └── host ── pty ── sh -c "npm test"
```

- The **daemon** (one per user, started on demand) keeps the list of sessions and their
  state under `~/.pi/agent/roost/`.
- Each session runs as an ordinary `pi` process in a pseudo-terminal owned by a **host**
  process, so opening a session shows exactly what pi draws, and detaching leaves it
  running.
- Inside each worker the same extension reports state (working, waiting for input,
  done), the question it asked, and summaries.
- The sessions are normal pi session files; `pi --resume` sees them too.

## Limitations

- macOS and Linux only (it needs Unix sockets and a PTY).
- Some terminals (Terminal.app, tmux without `extended-keys`) send Ctrl+Enter as Enter:
  the task starts but does not open; press Enter on its row.
- Pi's own double Ctrl+C quits without the offer to move the turn to the background.
- Pi's bare `/fork` is pi's; pi-roost's needs a prompt: `/fork <prompt>`.

## Development

```bash
git clone https://github.com/luoxin9510/pi-roost && cd pi-roost
npm install
npm test
pi -e ./extensions/index.ts --agents      # try the checkout without installing
npm run install:local                     # or install the checkout as a local pi package
```

Design notes and milestone acceptance records are in [`docs/plans/`](docs/plans/).

## License

[MIT](LICENSE)
