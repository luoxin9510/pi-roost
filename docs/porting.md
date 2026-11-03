# pi-roost 移植说明（基于 2f40878 / v0.1.5）

> 目标读者：要在**公司内部 agent**（下文称"宿主 agent"）里重建 pi-roost 的工程师。
> 用法：对照源码 `git checkout 2f40878`（main，M8、M9、M10 均已合入，含 M8 三轮 review 修复）逐节实现，每节末尾有验收标准。

---

## 0. 一句话架构

```text
 宿主 agent (agent view) ──┐                     ┌── host ── PTY ── 宿主 agent worker (会话 A)
 宿主 agent (任意前台会话) ─┼── unix socket ── daemon ── host ── PTY ── 宿主 agent worker (会话 B)
 roost CLI ────────────────┘   (JSON lines)      └── host ── PTY ── sh -c "npm test"
                                                    ↑ host socket（二进制帧）
```

三类进程 + 一个扩展：

| 组件 | 文件 | 进程数 | 依赖宿主 agent？ |
|---|---|---|---|
| daemon | `daemon/main.ts` | 每用户 1 个，按需启动 | **否** |
| host | `host/main.ts` | 每个会话 1 个，持有 PTY | **否**（只依赖 `node-pty`、`@xterm/headless`） |
| CLI | `bin/pi-roost.ts` | 临时 | **否** |
| 扩展（三种角色） | `extensions/*.ts` | 每个宿主 agent 进程里加载一次 | **是**（适配层） |
| 公共库 | `lib/*.ts` | — | 只有 `lib/api.ts` 依赖（`SessionManager`） |

**核心思想**：每个后台会话就是一个**完整、普通的宿主 agent 交互进程**，跑在 host 持有的伪终端里。attach 时把真实终端直通过去，看到的就是 agent 原本的 TUI；detach 后进程继续跑。worker 内的扩展只负责**上报状态**和**接收回复**，不改 agent 本身。

---

## 1. 移植可行性评估：宿主 agent 必须具备的能力

先拿下表对照公司 agent。**标 ★ 的是硬性前提**，缺了整套方案不成立；其余缺失时有降级方案。

### 1.1 进程/CLI 层

| # | 能力 | pi 里的对应 | 用途 | 缺失时 |
|---|---|---|---|---|
| C1 ★ | 交互式 TUI 模式能在 PTY 里正常运行 | `pi` | worker 就是它 | 无解 |
| C2 ★ | 命令行指定会话文件续跑：`--session <file>` | `--session` | 启动/重启 worker，崩溃恢复 | 无解（必须能从持久化会话恢复） |
| C3 ★ | 命令行带首条提示词：`agent [flags] -- "<task>"` | 位置参数 | 派发任务 | 可改为 worker 扩展启动后读 env 再 `sendUserMessage` |
| C4 ★ | 会话文件可在**第一次写入前**先分配路径 | `SessionManager.create(cwd).getSessionFile()`，延迟写盘 | daemon 接受"文件尚不存在"的任务 | 让会话 ID 由外部指定 |
| C5 | 命令行加载扩展：`-e <path>` | `-e` | 未安装时测试 | 依赖已安装的扩展 |
| C6 | 自定义 flag：`--bg`、`--agents` | `pi.registerFlag` | `agent --bg "task"` | 改用独立 CLI 命令 |
| C7 | 同一 cwd 下启动时不弹阻塞对话框 | — | **坑**：pi 在 cwd ≠ 会话原 cwd 时会弹"continue in current cwd"对话框 | host 必须以会话原 cwd 启动 |
| C8 | 机器上有 `git`（≥ 支持 `worktree`） | — | M10 worktree 隔离 | 不做 M10 |

### 1.2 扩展 API 层（适配层要用的全部接口）

从 `extensions/` 统计的**完整** pi API 使用面：

**事件**（`pi.on`）：

| 事件 | 用在哪 | 作用 |
|---|---|---|
| `session_start`（含 `reason`: startup/reload/resume/new/fork） ★ | 全部角色 | 建连、加写锁、注册 peer、恢复状态 |
| `session_shutdown`（含 `reason`: quit/resume…） ★ | 全部角色 | 释放写锁、最后一次 flush |
| `agent_start` ★ | worker | 状态 → working |
| `agent_settled`（含 `aborted`） ★ | worker、前台 | 一轮结束：判定 done/blocked/failed，触发摘要、hand-back |
| `message_end`（含 `message.role`、`content`、`stopReason`、`errorMessage`） ★ | worker | 收集最后一条 assistant 文本、错误；agent 消息的 ack |
| `tool_execution_start/end`（含 `toolName`、`parentToolCallId`） | worker、前台 | 行显示当前工具；前台转后台时等工具结束 |
| `ui_prompt_start/end`（含 `kind`、`title`） | worker | 识别"在等对话框"（需要输入） |
| `session_info_changed`（含 `name`） | worker | 会话改名同步 |
| `model_select` / `thinking_level_select` | worker | 行里的模型名、thinking 级别（M8） |
| `session_before_compact` / `session_compact` / `session_compact_failed` | 前台、peer | 压缩期间不投递消息 |
| `input`、`thinking_level_select` | 前台 | 小功能（/bg 拦截等） |
| `before_agent_start`（可返回 `{systemPrompt}` 改写系统提示） | 前台、worker | M10：worker 在系统提示后追加 worktree 说明 |

**API 调用**：

| 调用 | 作用 | 重要度 |
|---|---|---|
| `pi.sendUserMessage(text, { deliverAs: "followUp" })` | 把用户回复投进正在跑的轮次 | ★ |
| `pi.sendUserMessage(text)` | 空闲时开始新一轮 | ★ |
| `pi.sendMessage({customType, content, display, details}, { triggerTurn, deliverAs: "steer" })` | M9：agent 消息，在下一个工具边界插入 | M9 必需 |
| `pi.registerTool` / `pi.registerMessageRenderer` | M9：`roost_agents/send/spawn` 三个工具 | M9 必需 |
| `pi.registerCommand` | `/agents` `/bg` `/background` `/fork` | 必需 |
| `pi.registerFlag` / `pi.getFlag` | `--bg` `--bg-name` `--agents` `--agents-cwd` | 可降级 |
| `pi.events.emit` | 发 `agents:job_needs_input` / `agents:job_completed` | 可选 |
| `pi.setSessionName` / `pi.setModel` / `pi.getThinkingLevel` / `pi.appendEntry` / `pi.getCommands` | 自动命名、/model、/thinking、DI-5 | 可选 |
| `ctx.sessionManager.getSessionFile()` / `getSessionName()` / `getBranch()` | 会话定位、读历史 | ★ |
| `ctx.isIdle()` / `ctx.waitForIdle()` / `ctx.abort()` | 投递节奏、转后台 | ★ |
| `ctx.shutdown()` | `--bg` 派发后退出、关 agent view | ★ |
| `ctx.switchSession(file, { withSession })` | **前台转后台**：切到 scratch 会话放开原文件 | 转后台功能必需 |
| `ctx.ui.custom()` + `tui.stop()/start()` | 全屏 agent view；attach 时交出终端 | agent view 必需 |
| `ctx.ui.onTerminalInput(fn)`（可 `consume`） | 空提示符按 ← 、Ctrl+Z/Ctrl+D 拦截 | 可降级为命令 |
| `ctx.ui.getEditorText/setEditorText/notify/setStatus/setWidget/setTitle/select` | UI 小件 | 可选 |
| `ctx.model` / `ctx.modelRegistry.find/getAvailable` | 摘要模型调用、/model 列表 | 摘要功能需要 |
| `ctx.getContextUsage()` | M8：上下文窗口占用（tokens / window / percent） | 可选，缺失时不显示 |
| `pi-tui`：`matchesKey` `Key` `isKeyRelease` `Input` `parseKey` `truncateToWidth` `visibleWidth` `Text` | agent view 渲染与按键 | 自带 TUI 时替换 |

> **评估结论模板**：C1–C4 + 6 个 ★ 事件 + `sendUserMessage` 两种投递方式 + `isIdle/abort/shutdown` 齐了 → 可以做出"后台会话 + 状态上报 + 回复 + attach"（对应 M1–M4）。有 `switchSession` → 能做"聊到一半转后台"。有 `ui.custom` + 可停启的 TUI → 能做内嵌 agent view，否则用独立 CLI/TUI 程序（daemon 协议完全够用）。

---

## 2. 推荐的移植结构：先抽一个适配层

源码里扩展直接调 pi API。移植时建议先定义一个**宿主适配接口**，把 `extensions/` 改写成依赖它，宿主换了只重写适配器：

```ts
// adapter.ts —— 宿主 agent 需要实现的最小接口（M1–M4 范围）
export interface HostAgentAdapter {
  // —— 进程/CLI ——
  /** worker 的完整 argv：[execPath, cli, "--session", file, ...passthrough, "--", task] */
  buildWorkerCommand(o: { sessionFile: string; task?: string; model?: string; thinking?: string; passthrough: string[] }): string[];
  /** 为 cwd 分配一个新会话文件路径（不必落盘） */
  allocateSession(cwd: string): string;

  // —— 事件 ——
  onSessionStart(fn: (e: { reason: "startup" | "reload" | "resume" | "new" | "fork" }) => void): void;
  onSessionShutdown(fn: (e: { reason: string }) => void | Promise<void>): void;
  onRunStart(fn: () => void): void;                                  // agent_start
  onRunSettled(fn: (e: { aborted: boolean }) => void): void;         // agent_settled
  onAssistantMessageEnd(fn: (m: { text: string; stopReason?: string; error?: string }) => void): void;
  onToolStart(fn: (e: { name: string; nested: boolean }) => void): void;
  onToolEnd(fn: (e: { nested: boolean }) => void): void;
  onDialogStart?(fn: (e: { kind: string; title?: string }) => void): void;
  onDialogEnd?(fn: () => void): void;

  // —— 动作 ——
  sendUser(text: string, mode: "followUp" | "start"): void;
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;

  // —— 会话读取 ——
  sessionFile(): string | undefined;
  sessionName(): string | undefined;
  lastAssistant(): { text: string; stopReason?: string; error?: string } | undefined;
  messageCount(): number;
}
```

M5+（转后台、agent view、摘要、M9）再增量加 `switchSession`、`openFullscreen`、`onTerminalInput`、`complete(model, system, user)`、`sendAgentMessage`、`registerTool` 等。

---

## 3. 可原样复用的层（直接拷贝）

以下文件**不 import 任何 pi 包**，只需改命名（`pi-roost` → 公司名、`PI_*` 环境变量前缀、`~/.pi/agent` 路径）：

```
lib/atomic.ts  ids.ts  proc.ts  paths.ts  framing.ts  protocol.ts  store.ts  locks.ts
lib/client.ts  hostclient.ts  attach.ts  resume.ts  dispatch.ts  config.ts  version.ts
lib/heuristics.ts  worker-state.ts  summarizer.ts  filter.ts  dispatch-input.ts
lib/view-model.ts  job-events.ts  comms.ts  worktree.ts
daemon/main.ts   host/main.ts   bin/pi-roost.ts
```

**需要改的点**（全局搜索替换即可）：

| 位置 | 改什么 |
|---|---|
| `lib/paths.ts` `roostHome()` | `~/.pi/agent/roost` → 你的数据目录 |
| `lib/paths.ts` `runtimeDir()` | `/tmp/pi-roost-<uid>` → 你的名字（注意 **unix socket 路径长度上限 ~104 字节**，别放太深） |
| `lib/config.ts` `userConfigPath()` | `~/.pi/agent/roost.json` |
| 环境变量 | `PI_JOB_ID` `PI_JOB_TOKEN` `PI_DAEMON_SOCK` `PI_JOB_DIR` `PI_ROOST_RESTORE` `PI_ROOST_CHILD` 及 `PI_ROOST_*` 调试变量 |
| `lib/dispatch.ts` `VALUE_FLAGS/BOOL_FLAGS/PATH_FLAGS` | 宿主 agent 中**必须透传给 worker** 的 flag（扩展路径、模型、离线等），相对路径转绝对 |
| `lib/dispatch.ts` `buildLaunch().command` | worker 的 argv 形状（见 C2/C3） |
| `lib/store.ts` `taskArg()` | pi 把 `@` 开头的参数当文件附件，所以前面加空格。按宿主 CLI 的特殊前缀调整 |
| `lib/store.ts` `respawnCommand()` | 依赖 argv 里 `--` 分隔首条提示词；宿主不同要同步改 |
| `lib/store.ts` `SESSION_RESTORED_FLAGS` | 宿主会从会话记录里自己恢复、因而重启时**不能**再传的 flag（pi 是 `--model --provider --thinking`） |
| `lib/worktree.ts` `WORKTREES_DIR` / `BRANCH_PREFIX` | worktree 目录 `.pi/worktrees/`、分支前缀 `roost/` |
| `lib/heuristics.ts` `QUESTION_PHRASES` | 判断"agent 在问问题"的中英文短语，可按公司 agent 的口癖增补 |
| `lib/client.ts` `connectOrStart()` 清理的 env 列表 | 跟着环境变量前缀改 |

---

## 4. 分步重建（按里程碑顺序，每步可独立验收）

原项目就是按这个顺序做的（`docs/plans/m*-acceptance.md` 里有每步的原始验收记录，强烈建议逐份读）。

### Step 0：可行性 spike（对应 M0，`spikes/REPORT.md`）

在宿主 agent 上先验证 5 个风险点，**全过再动工**：

| 风险 | 要验证的事 | pi 上的结论/坑 |
|---|---|---|
| R1 | 扩展在 `session_start` 里派发后立即 `shutdown()` 能干净退出 | 可行；TUI 已画的内容会被重绘掉，提示信息要在 `process.once("exit")` 里打印。未知 flag 会吃掉下一个单词 |
| R2 | 从全屏组件里 `tui.stop()`，扩展自己接管 stdin（raw 模式），再 `tui.start()` 恢复 | 可行；stdin 是 utf8 字符串，要 `Buffer.from` 后再写 socket；恢复前要重置 worker 留下的终端模式 |
| R3 | 在编辑器之前截获 ←（空提示符） | 可行；**kitty 键盘协议下按下+松开都会命中**，必须先 `isKeyRelease()` 过滤 |
| R4 | 切会话时换 cwd | pi 不支持；改为"同一会话文件在新 cwd 重启 worker" |
| R5 | 切到一个 scratch 会话以放开原会话文件，原文件零写入 | 可行；scratch 文件永不落盘；会话文件延迟写，daemon 必须接受尚不存在的文件 |

### Step 1：daemon + host + CLI，跑起"后台会话"（M1）

**要实现的东西：**

1. **目录与权限**（`lib/paths.ts` `ensureDirs()`）：runtime 目录 `0700`，拒绝符号链接、拒绝非本人所有；socket `chmod 0600`。这是**唯一的安全边界**（同用户信任模型）。
2. **原子写**（`lib/atomic.ts`）：tmp 文件 + `fsync` + `rename` + fsync 目录。所有 JSON 状态都走它。
3. **进程身份**（`lib/proc.ts`）：`pid` 会复用，所以用 `ps -o lstart= -p <pid>`（`LC_ALL=C`）的启动时间作 token，`(pid, token)` 才能唯一标识进程。
4. **锁**（`lib/locks.ts`）：`O_EXCL`（`"wx"`）创建锁文件，内容 `{pid, token, at}`；持有者死了（`sameProcess` 失败）才算陈旧锁。注意"文件已创建但内容还没写"的空窗期不能误删。
   - `daemon.lock`：保证每用户一个 daemon。
   - `<sessionFile>.lock`：**会话写锁**，同一会话文件任何时刻只能有一个写者（前台或 worker）。
5. **存储布局**（`lib/store.ts`）：

   ```
   <roostHome>/
     daemon.log           JSON lines
     roster.json          { jobId: {hostPid, hostToken} }  —— daemon 重启时重新认领存活的 host
     scratch/             转后台用的一次性会话
     jobs/<id>/
       job.json           不可变：id name cwd sessionFile command env model thinking origin kind createdAt versions (+M9 parentSession/rootSession/parentPeer)
       state.json         可变，**只有 daemon 写**
       worker.json        host 写：worker pid
       exit.json          host 写：{code, signal, at}
       attached.json      host 写：{attached, at}
       screen.txt         host 写：当前屏幕快照
       host.log
       tmp/
   <runtimeDir>/daemon.sock  daemon.lock  host-<id>.sock
   ```

   **单写者原则**：每个文件只有一个写者，这是整个系统无竞态的关键，移植时不要破坏。

6. **daemon 协议**（`lib/protocol.ts`）：unix socket 上的 **JSON Lines**，请求 `{id, op, args}`，响应 `{id, ok, result}` 或 `{id, ok:false, error, code}`，服务端推送 `{event: ...}`。M1 需要的 op：`ping list dispatch stop rm resolve status shutdown subscribe`。
7. **host 进程**（`host/main.ts`），参数只有 `<jobId>`：
   - 读 `job.json`，用 `node-pty` 以**会话原 cwd** 启动命令，env = `job.env` + `TERM=xterm-256color` + 身份变量（`PI_JOB_ID/TOKEN`、`PI_DAEMON_SOCK`、`PI_JOB_DIR`；shell 任务**不给**身份）。
   - PTY 输出同时写进 `@xterm/headless` 虚拟终端（scrollback 1000），定时把屏幕文本原子写到 `screen.txt`。
   - 监听 `host-<id>.sock`，**二进制帧协议**（`lib/framing.ts`）：`[type:u8][len:u32 BE][payload]`，上限 16MB。类型：`HELLO=1 DATA=2 RESIZE=3 DETACHED=4 CONTROL=5 REPLY=6`。
   - 首帧必须是 `HELLO {role:"attach"|"control", cols, rows}`。
     - `attach`：一次只允许一个，新的来了踢掉旧的（`DETACHED{reason:"takeover"}`）；attach 时把 PTY 缩一行再恢复，**强迫 TUI 全量重绘**。
     - `control`：`snapshot / status / detach / terminate`，回一个 `REPLY`。
   - `terminate`：SIGTERM，5 秒后 SIGKILL。worker 退出后写 `exit.json`、最后一次屏幕快照，再退出。
   - **node-pty 坑**：npm 用 `--ignore-scripts` 安装时 `spawn-helper` 会丢可执行位，host 启动时 `fixSpawnHelper()` 自动 `chmod 755`。Linux 没有预编译包，需要 `make`、C++ 编译器、`python3`。
8. **daemon**（`daemon/main.ts`）：
   - 启动：拿 `daemon.lock` → `loadJobs()`（读所有 job，按 `roster.json` 重新认领 `(pid,token)` 仍匹配的 host，其余 `finalize(startup)`）→ 监听 socket。
   - 被动启动：客户端 `DaemonClient.connectOrStart()` 连不上就 `spawn(node, daemon/main.js, {detached, stdio:"ignore", cwd:"/"})` 后轮询 `ping`（3 秒超时）。**启动前要从 env 里删掉 job 身份变量**，否则 worker 拉起的 daemon 会继承。
   - 每秒 `checkHosts()`：host 进程没了就 `finalize()`。
   - `dispatch` 校验：cwd 是绝对路径且存在；command 是非空字符串数组；会话文件绝对路径；**会话写锁被占或已有 job 在跑同一文件 → 拒绝（`locked`）**；名字重复自动加 ` (2)`。
   - 每个 job 生成 `jobToken`（16 字节随机）写进 `state.json`，host 透传给 worker 用于认证。
9. **CLI**（`bin/pi-roost.ts`）：`--json`、`attach`、`logs`、`reply`、`stop`、`rm`、`respawn`、`daemon status|logs|stop [--keep-workers]`；版本不一致时提示 `daemon stop --keep-workers && respawn --all`。
10. **attach 客户端**（`lib/attach.ts`）：raw 模式直通；本地拦截 Ctrl+Z（含 kitty 的 `CSI 122;5u`）detach；退出时输出 `TERMINAL_RESET`（关 kitty 键盘、bracketed paste、鼠标、modifyOtherKeys，显示光标）。

**验收**：`agent --bg "写个 hello world"` 立即返回；关掉终端；`roost --json` 能看到它；`roost attach <id>` 看到原生 TUI，Ctrl+Z 退出后它继续跑；`kill` 掉 daemon 后再执行任何命令，daemon 自动起来并**重新认领**正在跑的 host。

### Step 2：worker 角色——状态上报（M2）

worker 判定：扩展加载时看到 `PI_JOB_ID + PI_JOB_TOKEN + PI_DAEMON_SOCK` 就是 worker（`extensions/worker.ts` `jobIdentity()`），否则是前台。**读完立刻从 `process.env` 删掉 token**（M9 加的），避免 agent 跑的子进程继承。

1. **状态机**（`lib/worker-state.ts` `WorkerTracker`，纯函数，可直接复用）：

   | 输入事件 | 结果 |
   |---|---|
   | `agentStart` | `working / busy` |
   | `toolStart(name)` / `toolEnd` | 记录当前工具（**忽略嵌套工具** `parentToolCallId`） |
   | `assistantMessage` | 记最后文本、错误 |
   | `agentSettled(aborted)` | 有错且未中止 → `failed`；最后一句像问题 → `blocked + waitingFor:"question"` + 提取 choices；否则 `done` |
   | `dialogStart/End` | `blocked + waitingFor:"dialog"`（`custom` 类型要持续 2 秒才算，避免把非阻塞小部件当对话框） |
   | 启动 5 秒内没有开始任何轮次且无消息 | `blocked + waitingFor:"first-prompt"` |
   | `restore(lastAssistant)` | `PI_ROOST_RESTORE=1` 重启且无新提示时，用会话最后一条回复还原状态（`stopReason==="toolUse"` 说明被切断，不还原） |

2. **Reporter**（`extensions/worker.ts`）：每次发**完整快照** `WorkerReport`；一次只有一个请求在途；状态变化立即发，仅文本变化最多 15 秒一次；断线 500ms 起退避重连；关闭时 500ms 最终 flush。
3. **daemon `report` op**（`acceptReport`）：校验 `jobToken`；该连接登记为这个 job 的 `workerConn`；`stopping` 中的 job 不再接受上报（daemon 接管状态）；所有字段截断（summary 500、question 2000、choices ≤20×200…）。
4. **finalize 状态裁决**（`daemon/main.ts` `finalize()`）——这是最需要照抄的逻辑：

   | 情况 | 最终状态 |
   |---|---|
   | shell 任务 | 退出码 0 → done，否则 failed；5 分钟后行自动消失 |
   | 被 reaper 回收 | 保持原状态，标 `reaped`（working 视为 done） |
   | 用户 stop | `stopped` |
   | daemon 启动时发现 host 已死、无 exit.json | 之前 working 且 48h 内有进度 → `failed`（"机器重启？回复即可恢复"）；否则 `stopped` |
   | 无 exit.json（host 消失） | `failed: host vanished` |
   | 退出码 ≠ 0 | `failed`；若之前在 working 且 `crashRestarts < 1` → **自动重启一次**，提示词 "Continue where you left off." |
   | 退出码 0 | worker 最后报告的是 failed / 问题 → 保留；否则 `done` |

   崩溃预算：一轮正常结束、且重启后已稳定运行 60 秒，才把 `crashRestarts` 清零（防止崩溃循环）。

**验收**：agent view/`--json` 能实时看到 working → done/blocked/failed；问它一个需要确认的问题，状态变 blocked 且带 question；`kill -9` worker，自动重启一次并继续。

### Step 3：回复投递（M3）

1. **daemon `reply`**：每条回复先追加到 `state.json.pendingReplies`（`replySeq` 递增），**worker ack 之前一直保留**，断线不丢。worker 在线就推 `deliver{seq,text}`；离线但 host 活着 → 保存；job 已结束 → `respawn` 后由新 worker 取走。`/stop` 是特殊回复。最多 50 条排队。
2. **worker `ReplyQueue`**：按 seq 排序去重；正在跑 → `sendUserMessage(text, {deliverAs:"followUp"})`；空闲 → `sendUserMessage(text)` 并等 10 秒确认轮次真的开始；**对话框打开时暂停**、压缩中重试；`/model xxx`、`/thinking xxx` 在 worker 内直接应用；交给 agent 后 `ack(seq)`（累积确认）。
3. **respawn**（`respawnCommand()`）：会话写过盘 → 去掉原来的首条提示词（已经在会话里了），可选附加新提示词；从没写过盘 → 原命令重跑。设 `state.restore=true` 让 worker 走 `restore()`。

**验收**：在 blocked 的会话上 `roost reply <id> "yes"`，worker 接着干；daemon 重启期间发的回复不丢；回复一个已结束的会话会把它重新拉起。

### Step 4：attach 与 detach 细节（M4）

- host attach/detach 时写 `attached.json`，若 worker 上报过 `attachSignal:true` 就给 worker 发 **SIGUSR2**；worker 据此在"离开期间"回顾（recap）上判断是否有人在看。**注意**：注册一个空的 SIGUSR2 处理器兜底，否则会话切换的空窗期信号会杀死进程。
- worker 内注册 detach 键：空提示符 ←、Ctrl+Z、`/exit` → 通过 `hostControl(socket, "detach")` 让 host 踢掉 attach（**对话框打开时不拦截**）。
- `lib/resume.ts` `ensureLive()`：attach 前若会话已结束先 respawn，等 host socket 就绪（15 秒超时）。

### Step 5：前台角色——"聊到一半转后台"（M5a/M5b）

流程（`extensions/foreground.ts`）：

1. 触发：空提示符 ←（经 `onTerminalInput`，过滤 key release）/ `/bg` / `/background` / 正在跑时 Ctrl+D、`/quit`、`/exit` 的确认框。
2. 若在跑：提示"当前工具结束后转后台"，最多等 10 秒（再按 ← 跳过）→ `abort()` → `waitForIdle()` → 首条提示设为 "Continue where you left off."。
3. **关键交接（C4）**：`ctx.switchSession(scratch)` —— 当前进程切到 `scratch/` 下的一次性会话，原会话的 `session_shutdown` 释放写锁 → 在 `withSession` 回调里 `dispatch(origin:"adopt", sessionFile: 原文件)` → 打开 agent view 并高亮它 → 再切到一个**新的空会话**（不能留在 scratch 目录）。
4. 失败就切回原会话。会话从未写过盘（还没有第一条回复）时拒绝转移。
5. `/fork <prompt>`：复制当前会话文件，`origin:"fork"` 在后台执行 prompt，前台不动。

> 宿主没有 `switchSession` 时的降级：让用户退出前台进程（释放写锁）后再由 CLI 派发 `adopt`，体验差但可用。

### Step 6：agent view（M6a/M6b）

- 纯数据层 `lib/view-model.ts`（分组 Pinned / Needs input / Working / Completed，或按目录；图标、时长、排序）、`lib/filter.ts`（`s:` `n:` `o:` 过滤）、`lib/dispatch-input.ts`（解析 `task` / `@dir task` / `! cmd` / `/model` `/thinking` `/resume`）——**全部可直接复用**。
- 渲染层 `extensions/agent-view.ts`（1200 行，pi-tui 组件）是**移植工作量最大的部分**。daemon 侧只需要 `subscribe` 后监听 `job` / `removed` 事件，加上 `list pin rename reorder stop rm reply respawn`。
- 进入会话：`tui.stop()` → `attachToHost()` → 返回后重置终端模式 → `tui.start()` + 强制重绘（Step 0 的 R2）。
- 如果宿主 TUI 不好扩展，**完全可以把 agent view 做成独立程序**（比如 `roost` CLI 的一个子命令），协议不变。
- 通知（`lib/job-events.ts`）：OSC 9 / OSC 777 / BEL，终端标题显示等待数；同时在宿主事件总线上发 `agents:job_needs_input` / `agents:job_completed`。

### Step 7：摘要模型与空闲回收（M7 等）

- **摘要**（`extensions/worker-extras.ts` + `lib/summarizer.ts`，提示词可直接复用）：每轮结束一次、轮开始 45 秒后一次、之后每 5 分钟一次；自动命名一次；attach 时生成"离开期间"回顾。**关闭 thinking、`maxTokens:1024`、超时 20 秒、只回 JSON**；只发会话末尾约 6000 字符；失败静默回退到启发式文本。公司部署时细节见 `docs/summary-model.md`（中文，含内部 LLM 节点与环境变量白名单的坑）。
- **空闲回收**（`reapIdle()`，每 30 秒）：未置顶、非 working、非对话框、无待投递、空闲超过 `reapIdleMinutes`（默认 60）、**且没人 attach** 的 worker 被 terminate，标 `reaped`；回复或 attach 时自动重启。中间有 await，**拿到 host 状态后要重新判断一次**（源码里有这个双检）。

### Step 7.5：模型与上下文显示、切换运行中会话的模型（M8）

见 `docs/plans/m8-acceptance.md`。

- worker 的 `WorkerReport` 增加 `thinking` 和 `context: {tokens, window, percent}`（`ctx.getContextUsage()`；压缩后 `tokens` 为 null，直到下一条回复）。在 `session_start`、`message_end`、`agent_settled`、`model_select`、`thinking_level_select`、`session_compact` 时刷新。
- thinking 变化立即上报；只有 context 变化时按行文本的节流走。daemon 用 `contextFrom()` 校验（不可信 JSON），旧 worker 不发时保留上次的值。
- 行右侧列 `model · 43%`：≥80% 警告色，≥95% 错误色；窄屏时只显示百分比，再窄就隐藏（摘要至少保留 24 列）；`rowDetails:false` 关闭。偷看里显示 `provider/id · thinking high · ctx 86k / 200k (43%)`。
- 在偷看里输入 `/model x`、`/thinking x`：作为回复投递，worker 的 `ReplyQueue.applySetting` 直接调用 `pi.setModel` 等（正在进行的请求不受影响，下一次请求生效）。
- 刷新时机还包括 `tool_execution_start` 和 `/tree`。**坑**：pi 先执行 `message_end` 的处理器、后保存消息，所以在 `message_end` 里读到的上下文占用会落后一次请求；要等消息保存后再读。
- **切换要以上报为准**：偷看先显示"已请求切换到 …"，worker 上报出新模型后才显示"现在使用 …"；8 秒内没看到就提示"仍在用 …"，并把提示放在前面（`model switch failed (credentials? envAllowList): still …, not …`），因为最常见的原因是后台会话的环境里没有该模型的凭据。worker 要检查 `pi.setModel` 返回 `false` 或抛错的情况；宿主把 thinking 级别降档时，显示最接近的受支持级别。待确认的切换按"会话 + 设置项"分别跟踪（`/thinking` 不会取消 `/model` 的检查），连续切换只以最后一次为准。
- **模型/thinking 在重启与交接时的传递规则（移植时别漏）**：
  | 场景 | 传什么 |
  |---|---|
  | respawn 一个已写盘的会话 | 先去掉派发命令里的 `SESSION_RESTORED_FLAGS`，再传 worker **最后上报**的 `model`/`thinking`（`st.model ?? rec.model`），传之前校验格式。只靠会话记录不够：pi 对续跑的会话只有在它回答之后才记录模型，thinking 只在变化时记录 |
  | worker 在第一次上报前就结束了 | 回退到派发时的 `rec.model` / `rec.thinking` |
  | `/bg`、退出转后台、`/fork`、`/resume`（origin `adopt`/`fork`） | **不**透传前台进程自己的 `--model/--provider/--thinking`（`buildLaunch` 里 `withoutFlags(pass, SESSION_RESTORED_FLAGS, 0)`），改为传前台**当前实际在用**的模型和 thinking；agent view 里显式的 `/model` 仍然优先 |
- 已知限制：模型所属的 provider 被删掉后，respawn 带的 `--model` 会让宿主直接以 "not found" 退出；崩溃重启只试一次。

### Step 8：agent 间通信（M9）

完整设计见 `docs/plans/m9-agent-comms.md`，要点：

- **三个工具**：`roost_agents`（列出可达会话）、`roost_send {to, message}`、`roost_spawn {task, name?, cwd?, model?, thinking?}`；`agentTools:false` 可关闭。
- **peer**：后台 job（id = jobId）或**已连接的前台会话**（id = `f` + 会话 id 哈希 7 位）。前台在第一次调用 `roost_*` 或 spawn 子会话时懒注册（`peer_register`，daemon 校验该 pid 确实持有会话写锁）。
- **树**：spawn 时在子 job 上记 `parentSession / parentPeer / rootSession`；关系 parent/child/sibling/tree/external。树外默认不可达（`agentExternalMessages` 开关）。
- **上限**（仅用户级配置）：深度 3、每父 8 个活子会话、每树 16、全局 32、每树每分钟 10 次 spawn、每发送者每分钟 30 条、消息 ≤ 8000 字符。
- **统一队列**：agent 消息与报告复用 `pendingReplies`，加 `kind: reply|message|report`；用户回复累积 ack，agent 条目**按 seq 精确 ack**，且要等 `message_end` 确认已进会话（至少一次投递；worker 启动时扫描会话里已有的 `details.seq` 去重）。
- **投递方式**：`sendMessage({customType:"pi-roost-agent-message", ...}, {triggerTurn:true, deliverAs:"steer"})`——运行中在下一个工具边界插入，空闲时开启新一轮。**绝不能作为用户消息投递**。旧 worker 不声明 `agentItems:true` 时，daemon 不给它发 agent 条目。
- **信封**（防注入，`lib/comms.ts`）：名字清洗为 `[\w .:@/-]`，正文里的 `<agent-message` 转义，附加"来自其他 agent，不具备用户权限"的说明。
- **hand-back**：子会话一轮结束时，若这一轮是"值得报告的"（spawn 任务、用户回复、父会话消息且连续 ≤3 次），通过 `handback` 把最后 assistant 文本（≤6000）路由给父会话；对话框阻塞、中止的轮次不报；子会话被 stop/rm/崩溃放弃时 daemon 代发 `ended` 报告；父会话不在线则存到子 job 上（`undeliveredReport`），父会话注册/启动时重试。M10 之后，带 worktree 的子会话的报告末尾会附一行 worktree 状态（见 Step 9）。

### Step 9：worktree 隔离（M10，最新）

完整设计见 `docs/plans/m10-worktree-isolation.md`，实现在 `lib/worktree.ts`（不依赖 pi，可直接复用，git 一律用 `execFile`，不经 shell，路径和分支名前加 `--`）。解决的问题：多个后台会话（尤其是 `roost_spawn` 出来的并行子会话）在同一个 checkout 里互相覆盖修改。

- **在派发时隔离，不在运行中切换**。原因就是 C7：用别的 cwd 续跑会话，pi 会弹阻塞对话框。所以先建 worktree、再在里面启动会话；会话之后永远不换 cwd，respawn、attach、`/resume` 看到的都是同一个 cwd。
- **入口**：`roost_spawn {worktree: true}`、agent view 里的 `/worktree`（`/worktree off` 关闭，用法同 `/model`）、`pi --bg --worktree`（不能和 `--session` 一起用）、`api.spawn({worktree:true})`；默认值来自配置 `worktreeIsolation`：`"off"`（默认）/ `"children"`（只给 roost_spawn）/ `"all"`（所有新的 pi 派发）。显式指定优先。shell 任务、adopt、`/fork` 永远不建 worktree。
- **布局**：仓库根 = 派发 cwd 的 `git rev-parse --show-toplevel`；worktree 放在**主 checkout** 下的 `.pi/worktrees/<slug>-<4位hex>`，分支 `roost/<slug>-<4位hex>`，从派发 checkout 的 `HEAD` 创建（`git worktree add -b <branch> -- <path> <base>`）；slug 来自会话名（小写 ASCII，≤32 字符，空时为 `task`）。派发 cwd 是子目录时映射到 worktree 里的同一子目录。`.pi/worktrees/` 只写一次到 `info/exclude`（用 `git rev-parse --git-path` 定位，对链接 worktree 和 submodule 都对），不改任何受跟踪文件。派发 checkout 里未提交的改动**不会**带进 worktree，脏时要提示；被忽略的文件（`node_modules`、`.env`）也不复制。
- **谁来创建**：由**派发方**创建（`lib/dispatch.ts` `prepareIsolation()`），因为会话文件要用 worktree 的 cwd 来分配（pi 按 cwd 分目录存会话，`/resume` 也按 cwd 列），而只有 agent 进程有 `SessionManager`。派发被 daemon **明确拒绝**（错误码不是 `closed`）时用 `discard()` 回滚；超时或连接断开不回滚，因为会话可能已经启动了。回滚也只删干净的 worktree 和仍停在 base 的分支。
- **daemon 不信任派发方**：`dispatch` 收到 `worktree:{path, branch, repo, base}` 后，以及 `rm` 删除任何东西之前，都调用 `validWorktree()` 校验：base 是 commit id；目录名符合 `<slug>-<hex4>`、分支是 `roost/` 加同名；目录位于主 checkout 的 `.pi/worktrees/` 下；path 和 repo 共享同一个 git common dir；path 本身是 toplevel 且检出的就是那个分支；cwd 在 worktree 里面。这样伪造的派发请求没法让 `rm` 删掉 `main` 或别的目录。daemon 的 git 调用全部异步并带超时（5 秒，remove 20 秒）。
- **会话自己知道**：有 worktree 的 worker 在 `before_agent_start` 里往系统提示末尾追加一段说明（`worktreeNote()`）：你在自己的 worktree/分支上工作，其他会话在别处；完成的工作提交到这个分支；不要切分支，也不要改主仓库里的文件。
- **报告**：子会话的报告末尾加 `Worktree: <path> · branch <branch> · <n> commits on it · uncommitted changes`（daemon 在路由报告时用 `git status --porcelain` 和 `git rev-list --count base..branch` 算；git 失败就省略这一行，不让报告失败）。
- **`rm` 时的清理**（`cleanupWorktree()`，**只要里面可能有成果就绝不删除**）：

  | 情况 | 处理 |
  |---|---|
  | 别的 job（包括已结束、可续跑的）或已连接的前台 peer 的 cwd 在这个 worktree 里 | 保留 |
  | worktree 目录已不存在 | `git worktree prune`；分支有超出 base 的提交就保留，否则删除 |
  | 有未提交、未跟踪或被忽略的文件 | worktree 和分支都保留 |
  | 干净，但分支移动过 | 删除 worktree，保留分支 |
  | 干净，分支仍在 base | 删除 worktree 和分支 |

  SIGKILL 后 worker 仍未退出则跳过清理。`rm` 返回 `worktree:{path, branch, removed, branchKept, reason?}`，CLI 打印、view 显示；git 失败不会让 `rm` 失败。没有 `--force`，要强删就手动 `git worktree remove --force`。
- **respawn**：worktree 已经不在时直接失败，并给出恢复命令 `git worktree add <path> <branch>`。
- **view**：偷看里显示 `⎇ <branch>`；`JobRow.worktree:{path, branch}` 同时出现在 `--json` 和 API 里。

**验收**：父会话 spawn 两个 `worktree: true` 的子会话改同一个文件；两个都在各自分支上提交；父会话收到的报告里写明了分支；`rm` 后 worktree 被删、分支保留。

---

## 5. 配置项（`lib/config.ts`）

用户级 `roost.json`，项目级 `.pi/roost.json` 可覆盖**部分**键：

| 键 | 默认 | 仅用户级 |
|---|---|---|
| `fullscreen` | `true` | |
| `rowDetails` | `true` | |
| `worktreeIsolation` | `"off"` | |
| `groupBy` | `"state"` | |
| `summaryModel` | 无 | ✔ |
| `dispatchModel` / `dispatchThinking` | 宿主默认 | |
| `reapIdleMinutes` | `60` | |
| `notify` | `"auto"` | |
| `leftArrowOpensAgents` | `true` | |
| `defaultToAgentsView` | `false` | |
| `envAllowList` | `[]` | ✔ |
| `agentTools` / `agentExternalMessages` | `true` / `false` | ✔ |
| `agentMaxDepth/Children/Tree/Total` | 3 / 8 / 16 / 32 | ✔ |

"仅用户级"的原因：别人克隆来的仓库不能决定**你的环境变量**流向哪里、**会话记录**发给哪个模型、agent 能扩散多远。移植时保留这条规则。

**后台环境白名单**（`lib/dispatch.ts` `allowListedEnv()`）：`PATH HOME USER LOGNAME SHELL LANG LC_* TERM COLORTERM TMPDIR` + 代理变量（大小写都认）+ `envAllowList`。**在派发那一刻**快照进 `job.json`，respawn 沿用。公司环境通常要加 API key 变量和 `NODE_EXTRA_CA_CERTS`。

---

## 6. 关键常量速查

| 常量 | 值 | 位置 |
|---|---|---|
| 首条提示等待 | 5 s | `worker-state.ts` `FIRST_PROMPT_MS` |
| custom 对话框判定 | 2 s | `CUSTOM_DIALOG_MS` |
| 文本上报间隔 | 15 s | `SUMMARY_INTERVAL_MS` |
| 前台转后台等工具 | 10 s | `foreground.ts` `TOOL_WAIT_MS` |
| 回复后等轮次开始 | 10 s | `worker.ts` `START_WAIT_MS` |
| daemon 等 host 停止 | 6 s | `daemon` `WAIT_MS` |
| 视为"近期进度" | 48 h | `RECENT_MS` |
| reaper 检查 | 30 s | `REAP_CHECK_MS` |
| 崩溃预算重置 | 60 s | `CRASH_RESET_MS` |
| shell 行保留 | 5 min | `SHELL_KEEP_MS` |
| host SIGTERM→SIGKILL | 5 s | `host` `terminateWorker` |
| 摘要首次/周期/超时 | 45 s / 5 min / 20 s | `worker-extras.ts` |

调试用环境变量：`PI_ROOST_HOME` `PI_ROOST_RUNTIME_DIR` `PI_ROOST_CONFIG_DIR` `PI_ROOST_HOST_ENTRY` `PI_ROOST_REAP_MINUTES` `PI_ROOST_REAP_CHECK_MS` `PI_ROOST_SHELL_KEEP_MS` `PI_ROOST_PROGRESS_MS` `PI_ROOST_FIRST_PROGRESS_MS`——测试全靠它们把时间缩短、把目录隔离到临时路径。

---

## 7. 构建与打包

- Node ≥ 22.19，ESM，源码直接是 `.ts`（`allowImportingTsExtensions` + `erasableSyntaxOnly`：**只用可擦除的 TS 语法**，不能用 enum/namespace/参数属性）。
- 扩展由宿主直接加载 `.ts`；daemon/host/bin 由 `tsc -p tsconfig.build.json` 编译到 `dist/`（`rewriteRelativeImportExtensions` 把 `.ts` 导入改成 `.js`），`scripts/fix-dts.mjs` 修 `.d.ts` 里的导入。宿主不能直接加载 TS 时，扩展也一起编译。
- `lib/client.ts` `packageRoot()` 从模块位置向上找 `package.json` 来定位 `dist/daemon/main.js`、`dist/host/main.js`——**打包目录结构变了要同步改**。
- 本地安装（`scripts/install-local.sh`）：先在旁边建新副本再原子替换（daemon 是懒加载 node-pty 的，不能从半装好的目录运行）；替换前 `daemon stop --keep-workers`，后台会话不断。
- 运行时依赖只有两个：`node-pty`、`@xterm/headless`。

---

## 8. 测试策略

`test/` 下 18 个 vitest 文件（`pool: "forks"`，超时 20 s），移植时建议**先移植测试**：

| 测试 | 覆盖 | 移植难度 |
|---|---|---|
| `framing` `lib-core` `config` `dispatch` `dispatch-input` `view-model` `worker-state` `comms` `fit-screen` | 纯函数 | 直接复用 |
| `worktree` | 在临时 git 仓库上真跑：创建、状态、5 种清理情况 | 直接复用（需要 git） |
| `daemon` `host` | 用临时目录 + 假 worker 起真 daemon/host | 改路径/env 前缀即可 |
| `reporter` `reply-queue` `summaries` `worker-wiring` `foreground` `agent-view` | 用假的 `ExtensionAPI` 驱动 | 换成你的适配器 mock |

另外每个里程碑的 `docs/plans/m*-acceptance.md` 是**手工验收清单**（真实终端、tmux 里的操作步骤），重建完对着走一遍。

---

## 9. 已知限制与坑（移植时同样会遇到）

1. 只支持 macOS/Linux（unix socket + PTY）。Windows 需要 named pipe + ConPTY，基本等于重写 host。
2. 部分终端（Terminal.app、未开 `extended-keys` 的 tmux）把 Ctrl+Enter 当回车。
3. 宿主自己的双击 Ctrl+C 退出拦不住。
4. 从前台扩展写 stdout 会被 TUI 重绘吃掉，要在 exit 时打印。
5. 宿主若把 `@xxx` 参数当文件附件，首条提示词要转义（`taskArg`）。
6. kitty 键盘协议的 key release 事件会让按键触发两次。
7. 会话文件延迟写盘：daemon、respawn、转后台都要处理"文件还不存在"。
8. 版本升级后旧 daemon 仍跑旧代码：CLI 检测版本差异并提示 `daemon stop --keep-workers && respawn --all`。
9. worktree 只能在派发时创建：运行中的会话不能搬进 worktree（C7 对话框），只读任务就不要开隔离。
10. 安全模型是**同用户互信**：token 不是安全边界，同用户进程都能读 `state.json`。如果公司要求多租户隔离，需要重新设计。

---

## 附录 A：daemon op 一览（v0.1.5）

| op | 调用方 | 说明 |
|---|---|---|
| `ping` `status` | 任意 | 版本/健康检查 |
| `list {all?, cwd?}` | view/CLI | 默认隐藏结束超过 48h 的 |
| `subscribe` | view | 之后推送 `job` / `removed` 事件 |
| `dispatch DispatchArgs` | 前台/CLI/API | 新建 job 并启动 host；M10 可带 `worktree`，daemon 会校验 |
| `stop` `resolve` `pin` `rename` `reorder` | view/CLI | 管理 |
| `rm` | view/CLI | 停止并删除；M10 返回 worktree 清理结果 |
| `respawn {id?|all, restart?, prompt?}` | view/CLI | 重启已结束的（或在跑的） |
| `reply {id, text}` | view/CLI | 投递用户回复 |
| `shutdown {keepWorkers?}` | CLI | 停 daemon，可保留 host 继续跑 |
| `report {id, token, report}` | worker | 状态快照，同时绑定连接 |
| `ack {id, token, seq, exact?}` | worker | 确认投递 |
| `peer_register` `peers` `send` `spawn` `peer_ack` | 前台/worker（M9） | 通信 |
| `handback` | 子 worker（M9） | 报告给父会话 |

推送事件：`{event:"job", job: JobRow}`、`{event:"removed", id}`、`{event:"deliver", id, seq, text, kind?, from?, relation?, ref?}`。

## 附录 B：建议的移植顺序与工作量估计

| 阶段 | 内容 | 主要文件 | 相对工作量 |
|---|---|---|---|
| 0 | spike 5 个风险点 | `spikes/` | 小 |
| 1 | 拷贝 lib + daemon + host + CLI，改前缀/路径/argv | 约 3000 行，基本不改逻辑 | 小 |
| 2–4 | 写适配器，移植 worker 角色 | `worker.ts` `worker-extras.ts` | 中 |
| 5 | 前台转后台 | `foreground.ts` | 中（取决于有无 `switchSession`） |
| 6 | agent view | `agent-view.ts` | **大**（取决于 TUI 框架） |
| 7 | 摘要、回收 | 复用为主 | 小 |
| 7.5 | M8 模型/上下文显示与切换 | `worker.ts` `view-model.ts` `store.ts` | 小 |
| 8 | M9 通信 | `peer-link.ts` `agent-tools.ts` `comms.ts` + daemon 部分 | 中 |
| 9 | M10 worktree 隔离 | `worktree.ts`（复用）+ 各派发入口 + daemon 校验/清理 | 小到中 |

## 附录 C：版本对应

| 提交 | 内容 |
|---|---|
| `0a6a80c` | v0.1.1，M1–M7 |
| `a89e146` | M9 agent 间通信合入 |
| `ec5394b` | M8 模型与上下文合入 |
| `638fdd7` | M10 worktree 隔离合入 |
| `95e2599` | M8 三轮 review 修复合入 |
| `2f40878` | 发布 v0.1.5（本文依据；之前文档里写的 0.2.0 已改为 0.1.5） |

所需 pi 最低版本以 `parentToolCallId`（0.99.0）为准；M8 用到的 `getContextUsage`（≥0.49）和 `thinking_level_select`（≥0.71）都更早。
