<p>
  <img src="https://raw.githubusercontent.com/luoxin9510/pi-roost/main/assets/agent-view.png" alt="pi-roost agent view" width="1100">
</p>

# pi-roost

**Every background pi session on one screen.**<br>
**一个屏幕，管理所有后台 pi 会话。**

[![npm version](https://img.shields.io/npm/v/pi-roost?style=for-the-badge)](https://www.npmjs.com/package/pi-roost)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)](#install--安装)

> English and Chinese side by side: each section is in English first, then in Chinese.<br>
> 本文中英对照：每一节先英文，后中文。

Run many pi sessions at once without juggling terminals. Hand a task to the background,
keep working, and come back when something needs you. pi-roost lists every session on one
screen: what each one is doing right now, which one is asking you a question, and what has
finished. Answer from the list, jump into any session, jump back out. Close the terminal and
the sessions keep going.

想同时跑好几个 pi 任务，又不想开一堆终端窗口来回切换？把任务交给后台，你继续干自己的事，等有会话需要你时再回来。pi-roost 把所有会话列在同一个屏幕上：每个会话此刻在做什么，哪个在等你回答，哪些已经完成，一目了然。你可以直接在列表里回复，随时进入任意一个会话，也随时退回列表。关掉终端，会话照样在跑。

- **Fire and forget.** Type a task, press Enter, and it runs in the background.<br>
  **派完就走**：输入任务，按回车，它就在后台跑起来。
- **See everything at a glance.** A live one-line summary per session, grouped into
  *Needs input*, *Working* and *Completed*.<br>
  **一眼看全**：每个会话一行实时摘要，按“需要输入 / 进行中 / 已完成”分组。
- **Answer without switching.** Peek at a session and reply right in the list.<br>
  **不切换就回复**：按空格偷看会话，在列表里直接回答它的问题。
- **Jump in, jump out.** Enter opens a session full-screen; ← on its empty prompt brings
  you back.<br>
  **随进随出**：回车进入会话全屏操作，在它的空提示符下按 ← 回到列表。
- **Move what you already have.** ← on an empty prompt (or `/bg`) sends the current
  conversation to the background, right where it was.<br>
  **聊到一半也能转后台**：在任意会话的空提示符下按 ←（或输入 `/bg`），当前对话原样转到后台继续跑。
- **Outlives the terminal.** A per-user daemon keeps the sessions alive.<br>
  **不怕关终端**：每个用户一个常驻的后台守护进程，会话不会随终端一起退出。

pi-roost is a plain pi package: one extension, a small per-user daemon and a PTY host per
session. Pi itself is not changed.

pi-roost 是一个普通的 pi 包：一个扩展，加上每个用户一个小型守护进程、每个会话一个 PTY 宿主进程。pi 本身不做任何修改。

## Install · 安装

```bash
pi install npm:pi-roost
```

Requires pi 1.5.0 or newer, on macOS or Linux. On Linux, installing builds
[node-pty](https://github.com/microsoft/node-pty) from source, so it needs `make`, a C++
compiler and Python (`build-essential` and `python3` on Debian and Ubuntu).

需要 pi 1.5.0 或更高版本，支持 macOS 和 Linux。在 Linux 上安装时会从源码编译 [node-pty](https://github.com/microsoft/node-pty)，所以需要 `make`、C++ 编译器和 Python（Debian、Ubuntu 上装 `build-essential` 和 `python3` 即可）。

## Try this first · 快速上手

```bash
pi --agents
```

Type a task at the bottom and press Enter. It starts in the background and shows up as a
row with a live one-line summary. Start a few more. Then:

在底部输入一个任务，按回车。它会在后台启动，并作为一行出现在列表里，带一行实时摘要。多派几个，然后试试：

- **Space** on a row peeks at it: the latest output, and a reply box if it asked something.<br>
  在某一行按 **空格**，偷看它的最新输出；如果它在问问题，会出现回复框。
- **Enter** (or →) opens the session full-screen. **←** on its empty prompt, or **Ctrl+Z**,
  brings you back to the list.<br>
  按 **回车**（或 →）全屏进入会话。在它的空提示符下按 **←**，或按 **Ctrl+Z**，回到列表。
- **Esc** leaves the view. The sessions keep going; `pi --agents` shows them again.<br>
  按 **Esc** 离开视图。会话继续运行，再次 `pi --agents` 就能看到它们。

Already in a normal pi conversation that will take a while? Press **←** on the empty
prompt (or type `/bg`) and it moves to the background, right where it was.

正在一个普通 pi 对话里，任务要跑很久？在空提示符下按 **←**（或输入 `/bg`），它就原样转到后台继续。

A cheap summary model makes the list much more useful: sessions get names and progress
summaries. Add one to `~/.pi/agent/roost.json`, for example
`{"summaryModel": "anthropic/claude-haiku-5-5"}`.

配一个便宜的摘要模型，列表会好用很多：会话会自动命名，并显示进度摘要。在 `~/.pi/agent/roost.json` 里加上，例如 `{"summaryModel": "anthropic/claude-haiku-5-5"}`。想用公司内部的 LLM 节点，见 [docs/summary-model.md](docs/summary-model.md)（中文）。

## What you get · 功能

**One list, grouped by what needs you.** Sessions are grouped into *Needs input*,
*Working* and *Completed* (or by directory, Ctrl+S). The terminal title counts the ones
waiting for you, and the terminal notifies you when one asks a question or finishes.

**一个列表，按“需要你做什么”分组。** 会话分为“需要输入”“进行中”“已完成”三组（按 Ctrl+S 可改为按目录分组）。终端标题会显示有几个在等你，有会话提问或完成时，终端会发通知。

**Dispatch from anywhere. · 随处派发任务。**

| Input · 输入 | What it does | 作用 |
|---|---|---|
| `fix the flaky test` | a new background session in this directory | 在当前目录开一个新的后台会话 |
| `@api fix the flaky test` | the same, in `./api` (Tab completes repos and worktrees) | 同上，但在 `./api` 里（Tab 可补全仓库和 worktree） |
| `! npm test` | a shell command as a job; the row shows its last output line | 把一条 shell 命令作为任务运行，这一行显示它最后一行输出 |
| `/model`, `/thinking` | model and thinking level for sessions started from this view (bare: pick from a list) | 设置从这个视图新开的会话所用的模型和 thinking 级别（不带参数则从列表里选） |
| `/resume` | bring back an earlier session of this directory | 找回当前目录以前的会话 |
| Ctrl+G | write a long task in `$VISUAL` / `$EDITOR` | 在 `$VISUAL` / `$EDITOR` 里写长任务 |
| Ctrl+Enter | start the task and open it straight away (needs a terminal that reports Ctrl+Enter) | 派发任务并立刻进入（需要终端能识别 Ctrl+Enter） |

From the shell: `pi --bg "run the tests and summarise failures"`.

在 shell 里也可以直接派发：`pi --bg "run the tests and summarise failures"`。

**Move conversations to the background. · 把对话转到后台。** In any pi session:
在任意 pi 会话里：

- **←** on an empty prompt, `/bg` or `/background`: this conversation continues in the
  background and the agent view opens with it highlighted.<br>
  空提示符下按 **←**，或输入 `/bg`、`/background`：当前对话转到后台继续，agent 视图打开并高亮它。
- `/fork <prompt>`: a copy of this conversation runs `<prompt>` in the background while
  you keep going here.<br>
  `/fork <prompt>`：复制一份当前对话，在后台执行 `<prompt>`，你在这里继续聊。
- Quitting (Ctrl+D, `/quit`) while a turn is running offers to move it to the background
  instead of stopping it.<br>
  正在执行时退出（Ctrl+D、`/quit`），会提示你把它转到后台，而不是直接停掉。

**Sessions outlive the terminal.** A per-user daemon owns every session, so closing the
terminal, or the pi you started them from, does not stop them. A session that crashes is
restarted once. One that has sat idle for an hour stops its process (it is still listed,
and replying or opening it starts it again where it left off); pin it with Ctrl+T to keep
it running.

**会话比终端活得久。** 所有会话都归每个用户一个的守护进程管理，所以关掉终端、或者关掉派发它们的那个 pi，会话都不会停。会话崩溃会自动重启一次。空闲超过一小时的会话会停掉进程（它仍在列表里，回复或进入它就会从停下的地方接着跑）；按 Ctrl+T 置顶可以让它一直运行。

**Keep it tidy.** Filter with `s:working`, `n:auth`, `o:error` (combine with spaces),
rename with Ctrl+R, reorder with Shift+↑/↓, fold groups, pin, and stop with Ctrl+X (twice
to delete). Press `?` in the view for every key.

**保持整洁。** 用 `s:working`、`n:auth`、`o:error` 过滤（可以用空格组合），Ctrl+R 改名，Shift+↑/↓ 调整顺序，还能折叠分组、置顶，Ctrl+X 停止（连按两次删除）。在视图里按 `?` 查看所有按键。

**See and switch each session's model.** Every row shows the session's model and how full
its context window is (`claude-opus-5-5 · 43%`, yellow from 80%, red from 95%); the peek
adds the thinking level and the token counts (`ctx 86k / 200k`). In a peek, `/model` and
`/thinking` switch that session (bare: pick from a list). A turn in progress finishes its
current model request, and the next request uses the new model. The switch is saved in
the session, so a session that is restarted later keeps it.

**查看并切换每个会话的模型。** 每一行都显示这个会话用的模型，以及上下文窗口用了多少（`claude-opus-5-5 · 43%`，80% 起变黄，95% 起变红）。偷看时还会显示 thinking 级别和 token 数（`ctx 86k / 200k`）。在偷看里输入 `/model`、`/thinking`，就能切换这个会话的模型和 thinking 级别（不带参数则从列表里选）。正在执行的一轮会先跑完当前这次模型请求，下一次请求就用新模型。切换会记录在会话里，会话之后重启也会保留。

## Agents talking to each other · agent 之间通信

Every pi session with pi-roost gets three tools, modelled on Claude Code's background agents:

装了 pi-roost 的每个 pi 会话都会多出三个工具，仿照 Claude Code 的后台 agent 设计：

| Tool · 工具 | What it does | 作用 |
|---|---|---|
| `roost_spawn` | start a background child session on a task; its report (final reply, question or failure) comes back by itself when it finishes | 派一个后台子会话去做任务；它完成时，汇报（最终回复、提问或失败原因）会自动送回来 |
| `roost_send` | message another session by id or exact name; it arrives at that session's next step | 按 id 或准确名字给另一个会话发消息，对方在下一步就会收到 |
| `roost_agents` | list the sessions you can reach, with state and what each is doing or asking | 列出能通信的会话，以及各自的状态、正在做什么或在问什么 |

So a session can fan work out to children and gather their results, the way subagent
workflows do, except that every child is a full pi session you can watch, peek at, answer
or attach to in the agent view (children show as `↳ name`).

这样一个会话就能像 subagent 工作流那样，把任务分派给多个子会话，再收集它们的结果。区别在于每个子会话都是完整的 pi 会话：你可以在 agent 视图里看它、偷看它、回答它的问题，或者直接进入它（子会话显示为 `↳ 名字`）。

How it behaves · 运行方式：

- Messages arrive mid-turn (before the agent's next step) or start a turn when the session is
  idle. They are wrapped in `<agent-message from=… relation=…>` and say they come from an
  agent, not the user: they cannot approve actions or change instructions.<br>
  消息会在对方干活的间隙（下一步之前）插进去；对方空闲时，消息会直接触发新一轮。消息带有 `<agent-message from=… relation=…>` 包装，并声明来自 agent 而不是用户，不能批准操作或改变指令。
- A child reports when a run it was given ends: its task, your reply to it, or its parent's
  answer (at most 3 parent-started reports in a row). Runs started by other agents' messages
  do not report by themselves, so sessions cannot keep waking each other; they answer with
  `roost_send` instead. Stopping or removing a child tells its parent.<br>
  子会话在“交给它的那一轮”结束时汇报：它的任务、你对它的回复，或父会话对它的回答（父会话触发的汇报连续最多 3 次）。由其他 agent 消息触发的那一轮不会自动汇报，所以会话之间不会互相唤醒停不下来；需要回复时用 `roost_send`。停止或删除子会话时，父会话会收到通知。
- Reach: free inside one spawn tree (parent, children, siblings). Sessions outside the tree
  only with `agentExternalMessages: true`, by exact id.<br>
  通信范围：同一棵会话树内（父、子、兄弟）可以自由通信；树外的会话只有开启 `agentExternalMessages: true` 后，才能用准确的 id 发消息。
- Nothing is lost when the receiver is not running: a job keeps messages until it reads them
  (an ended job starts again for them; one you stopped is not woken). A foreground parent
  that moved to the background (←) keeps getting its children's reports.<br>
  对方没在运行时消息不会丢：后台任务会一直保留消息，直到读取（已结束的任务会为此重新启动，你手动停掉的不会被唤醒）。前台父会话按 ← 转到后台后，仍然能收到子会话的汇报。
- Limits: 3 levels deep, 8 running children per session, 16 per tree, 32 overall, 30
  messages and 10 spawns a minute.<br>
  限制：最多 3 层；每个会话最多 8 个运行中的子会话，每棵树最多 16 个，全局最多 32 个；每分钟最多 30 条消息、10 次派发。

Design notes: [`docs/plans/m9-agent-comms.md`](docs/plans/m9-agent-comms.md).

设计说明：[`docs/plans/m9-agent-comms.md`](docs/plans/m9-agent-comms.md)。

## Keys · 按键

| Key · 按键 | In the agent view | 在 agent 视图里 |
|---|---|---|
| ↑ ↓ PgUp PgDn | move (Home and End too, when the input is empty) | 移动（输入框为空时 Home、End 也可以） |
| Enter | open the session · start the typed task · fold a group | 进入会话 · 派发输入的任务 · 折叠分组 |
| → | open the session | 进入会话 |
| Space | peek and reply | 偷看并回复 |
| Ctrl+Enter | start the typed task and open it | 派发输入的任务并进入 |
| Ctrl+X | stop; again within 2 s to delete | 停止；2 秒内再按一次删除 |
| Ctrl+S | group by state / directory | 按状态 / 目录分组 |
| Ctrl+T | pin / unpin | 置顶 / 取消置顶 |
| Ctrl+R | rename | 改名 |
| Shift+↑ Shift+↓ | move the row within its group | 在分组内移动这一行 |
| Alt+↑ Alt+↓ | previous / next group | 上一个 / 下一个分组 |
| Alt+1…9 | open row N of this directory | 进入当前目录的第 N 行 |
| Ctrl+F | find by name | 按名字查找 |
| Esc | close the peek · clear the input · leave | 关闭偷看 · 清空输入 · 离开 |

Inside a session, ← on an empty prompt, `/exit` or Ctrl+Z goes back to the list.

在会话里，空提示符下按 ←、输入 `/exit` 或按 Ctrl+Z，都会回到列表。

## Configuration · 配置

`~/.pi/agent/roost.json` (a project can override some keys in `.pi/roost.json`):

配置文件是 `~/.pi/agent/roost.json`（项目可以在 `.pi/roost.json` 里覆盖部分配置项）：

```json
{
  "fullscreen": true,
  "rowDetails": true,
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

| Key · 配置项 | Default · 默认值 | What it does | 作用 |
|---|---|---|---|
| `fullscreen` | `true` | the view covers the terminal; `false` shows it below the conversation | 视图铺满终端；`false` 时显示在对话下方 |
| `rowDetails` | `true` | each row shows its model and context window use (hidden on narrow terminals) | 每一行显示模型和上下文窗口占用（终端太窄时自动隐藏） |
| `groupBy` | `"state"` | or `"directory"` (Ctrl+S toggles and remembers) | 或 `"directory"`（Ctrl+S 切换并记住） |
| `summaryModel` | none · 无 | a cheap model for row summaries, session names and "while you were away" recaps; without it rows show the latest output; any model pi can reach works, including a company endpoint ([guide](docs/summary-model.md), in Chinese) | 一个便宜的模型，用来写行摘要、给会话命名、生成“离开期间”回顾；不配置时行里显示最新输出；pi 能调用的模型都可以，包括公司内部节点（见[说明](docs/summary-model.md)） |
| `dispatchModel`, `dispatchThinking` | pi's defaults · pi 的默认值 | for sessions started from the view | 从视图新开的会话所用的模型和 thinking 级别 |
| `reapIdleMinutes` | `60` | stop the process of a session idle this long (it restarts on demand) | 会话空闲这么久后停掉进程（需要时自动重启） |
| `notify` | `"auto"` | `"osc9"`, `"osc777"`, `"bell"` or `"off"` | 通知方式：`"osc9"`、`"osc777"`、`"bell"` 或 `"off"` |
| `leftArrowOpensAgents` | `true` | ← on an empty prompt moves the conversation to the background | 空提示符下按 ← 把对话转到后台 |
| `defaultToAgentsView` | `false` | plain `pi` opens the agent view | 直接运行 `pi` 时打开 agent 视图 |
| `envAllowList` | `[]` | extra environment variables for background sessions | 额外传给后台会话的环境变量 |
| `agentTools` | `true` | the `roost_*` tools in every session | 在每个会话里提供 `roost_*` 工具 |
| `agentExternalMessages` | `false` | agents may message sessions outside their spawn tree (by exact id) | 允许 agent 给会话树之外的会话发消息（需准确 id） |
| `agentMaxDepth`, `agentMaxChildren`, `agentMaxTree`, `agentMaxTotal` | `3`, `8`, `16`, `32` | spawn limits | 派发子会话的数量限制 |

Background sessions get a small environment (`PATH`, `HOME`, `SHELL`, `LANG`, `TERM`,
proxy variables and a few more) plus `envAllowList`. A project's `.pi/roost.json` cannot
set `envAllowList`, `summaryModel` or the `agent*` reach and limit keys.

后台会话只拿到一小组环境变量（`PATH`、`HOME`、`SHELL`、`LANG`、`TERM`、代理变量等少数几个），外加 `envAllowList` 里列出的。项目的 `.pi/roost.json` 不能设置 `envAllowList`、`summaryModel` 以及 `agent*` 开头的通信范围和数量限制，这样别人克隆来的仓库没法决定你的环境变量和会话记录发往哪里，也没法放宽 agent 的通信范围。

## CLI · 命令行

The package installs a `pi-roost` command:

这个包会安装一个 `pi-roost` 命令：

```text
pi-roost --json [--all] [--cwd <dir>]   list sessions as JSON              以 JSON 列出会话
pi-roost attach <id|name>               open a session (Ctrl+Z detaches)   进入会话（Ctrl+Z 退出）
pi-roost logs <id|name>                 print its current or last screen   打印它当前或最后的屏幕
pi-roost reply <id|name> <text>         send a reply                       发送回复
pi-roost stop <id|name>                 stop it                            停止
pi-roost rm <id|name>                   stop it and delete its record      停止并删除记录
pi-roost respawn <id|name> | --all      start ended sessions again (or restart live ones)
                                        重新启动已结束的会话（或重启运行中的）
pi-roost daemon status|logs|stop [--keep-workers]
```

If `pi-roost` is not on your `PATH` (pi installs packages under its own directory),
run it as `node ~/.pi/agent/npm/node_modules/pi-roost/dist/bin/pi-roost.js`.

如果 `pi-roost` 不在你的 `PATH` 里（pi 把包装在自己的目录下），可以这样运行：`node ~/.pi/agent/npm/node_modules/pi-roost/dist/bin/pi-roost.js`。

## For extension authors · 给扩展作者

pi-roost emits `agents:job_needs_input` and `agents:job_completed` on `pi.events` with
`{ id, name, cwd, state, summary, question, error }`.

pi-roost 会在 `pi.events` 上发出 `agents:job_needs_input` 和 `agents:job_completed` 事件，内容为 `{ id, name, cwd, state, summary, question, error }`。

Other extensions and scripts can drive it through `pi-roost/api`:

其他扩展和脚本可以通过 `pi-roost/api` 调用它：

```ts
import { spawn, list, attach } from "pi-roost/api";

// inside a pi extension; from a plain script, also pass piCli: the path of pi's cli.js
// 在 pi 扩展里直接用；在普通脚本里还要传 piCli：pi 的 cli.js 路径
const { id } = await spawn({ task: "run the regression suite", cwd: process.cwd() });
const jobs = await list({ cwd: process.cwd() });
await attach(id); // hands this terminal to the session until it detaches · 把当前终端交给会话，直到退出
```

## How it works · 工作原理

```text
 pi (agent view) ──┐                    ┌── host ── pty ── pi worker (session A)
 pi (any session) ─┼── unix socket ── daemon ── host ── pty ── pi worker (session B)
 pi-roost CLI ─────┘                    └── host ── pty ── sh -c "npm test"
```

- The **daemon** (one per user, started on demand) keeps the list of sessions and their
  state under `~/.pi/agent/roost/`.<br>
  **守护进程**（每个用户一个，按需启动）在 `~/.pi/agent/roost/` 下记录会话列表和状态。
- Each session runs as an ordinary `pi` process in a pseudo-terminal owned by a **host**
  process, so opening a session shows exactly what pi draws, and detaching leaves it
  running.<br>
  每个会话都是一个普通的 `pi` 进程，跑在一个由 **宿主进程** 持有的伪终端里，所以进入会话时看到的就是 pi 原本的画面，退出后它继续运行。
- Inside each worker the same extension reports state (working, waiting for input,
  done), the question it asked, and summaries.<br>
  在每个 worker 里，同一个扩展负责上报状态（进行中、等待输入、完成）、它提出的问题以及摘要。
- The sessions are normal pi session files; `pi --resume` sees them too.<br>
  这些会话都是普通的 pi 会话文件，`pi --resume` 也能看到。

## Limitations · 限制

- macOS and Linux only (it needs Unix sockets and a PTY).<br>
  只支持 macOS 和 Linux（需要 Unix socket 和伪终端）。
- Some terminals (Terminal.app, tmux without `extended-keys`) send Ctrl+Enter as Enter:
  the task starts but does not open; press Enter on its row.<br>
  有些终端（Terminal.app、没开 `extended-keys` 的 tmux）把 Ctrl+Enter 当作回车发送：任务会启动，但不会自动进入，在它那一行按回车即可。
- Pi's own double Ctrl+C quits without the offer to move the turn to the background.<br>
  pi 自带的连按两次 Ctrl+C 会直接退出，不会提示转到后台。
- Pi's bare `/fork` is pi's; pi-roost's needs a prompt: `/fork <prompt>`.<br>
  不带参数的 `/fork` 是 pi 自己的命令；pi-roost 的需要带上提示词：`/fork <prompt>`。

## Development · 开发

```bash
git clone https://github.com/luoxin9510/pi-roost && cd pi-roost
npm install
npm test
pi -e ./extensions/index.ts --agents      # try the checkout without installing · 不安装直接试用
npm run install:local                     # or install the checkout as a local pi package · 或作为本地 pi 包安装
```

Design notes and milestone acceptance records are in [`docs/plans/`](docs/plans/).

设计说明和各里程碑的验收记录在 [`docs/plans/`](docs/plans/)。

## License · 许可证

[MIT](LICENSE)
