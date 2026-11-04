# pi-roost 移植说明（基于 0d16cd4 / v0.1.7）

> 目标读者：要在**公司内部 agent**（下文称"宿主 agent"）里重建 pi-roost 的工程师。
> 用法：对照源码 `git checkout v0.1.7`（`0d16cd4`，即 main）逐节实现，每节末尾有验收标准。
> v0.1.7 包含 M1–M20（计划文档 `docs/plans/m15-polish.md`，见 Step 14）：M8 模型/上下文、M9 agent 间通信、M10 worktree 隔离、M11 pi-mobile、M12/M12b 子 agent 面板、M13 子 agent 生命周期、M14 attach 如 resume、M15 打磨（`.worktreeinclude`、`list`、`cleanupDays`、host 回应终端查询）、M16 PR 状态、M17 任务输入框、M18 agent 预设、M19 子 agent 记录视图、M20 shell 环境。M11 之后的各步都是可选增强，核心（Step 1–8）不依赖它们。

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
| `tool_execution_start/end`（含 `toolName`、`parentToolCallId`） | worker、前台、子 agent 面板、`pr-links.ts` | 行显示当前工具；前台转后台时等工具结束；面板在工具结束后刷新；M16 从 `bash` 调用（含 codemode 内嵌）的命令和输出里找 PR 链接 |
| `ui_prompt_start/end`（含 `kind`、`title`） | worker | 识别"在等对话框"（需要输入） |
| `session_info_changed`（含 `name`） | worker | 会话改名同步 |
| `model_select` / `thinking_level_select` | worker | 行里的模型名、thinking 级别（M8） |
| `session_before_compact` / `session_compact` / `session_compact_failed` | 前台、peer | 压缩期间不投递消息 |
| `input`、`thinking_level_select` | 前台 | 小功能（/bg 拦截等） |
| `session_tree` | worker | `/tree` 切分支后刷新上下文占用（M8） |
| `before_agent_start`（可返回 `{systemPrompt}` 改写系统提示） | 前台、worker | M10：worker 在系统提示后追加 worktree 说明 |

**API 调用**：

| 调用 | 作用 | 重要度 |
|---|---|---|
| `pi.sendUserMessage(text, { deliverAs: "followUp" })` | 把用户回复投进正在跑的轮次 | ★ |
| `pi.sendUserMessage(text)` | 空闲时开始新一轮 | ★ |
| `pi.sendMessage({customType, content, display, details}, { triggerTurn, deliverAs: "steer" })` | M9：agent 消息，在下一个工具边界插入 | M9 必需 |
| `pi.registerTool` / `pi.registerMessageRenderer` | M9：`roost_agents/send/spawn` 三个工具 | M9 必需 |
| `pi.registerCommand` | `/agents` `/bg` `/background` `/bg-fork` | 必需 |
| `pi.registerFlag` / `pi.getFlag` | `--bg` `--bg-name` `--agents` `--agents-cwd` `--worktree`（M10），`--agent`（M18，`pi.registerFlag("agent", {type:"string"})`，与 `--bg` 合用） | 可降级 |
| `pi.events.on(channel, fn)`（返回取消函数） | M11：监听 pi-mobile 的 `pi-mobile:starters`、`pi-mobile:activity`（`extensions/mobile.ts`）；`pi.events` 可能不存在（测试宿主），要判空 | 无 pi-mobile 时不需要 |
| `pi.events.emit` | 发 `agents:job_needs_input` / `agents:job_completed` | 可选 |
| `pi.setSessionName` / `pi.setModel` / `pi.getThinkingLevel` / `pi.appendEntry` / `pi.getCommands` | 自动命名、/model、/thinking、DI-5 | 可选 |
| `ctx.sessionManager.getSessionFile()` / `getSessionName()` / `getBranch()` | 会话定位、读历史 | ★ |
| `ctx.isIdle()` / `ctx.waitForIdle()` / `ctx.abort()` | 投递节奏、转后台 | ★ |
| `ctx.shutdown()` | `--bg` 派发后退出、关 agent view | ★ |
| `ctx.switchSession(file, { withSession })` | **前台转后台**：切到 scratch 会话放开原文件 | 转后台功能必需 |
| `ctx.ui.custom()` + `tui.stop()/start()` | 全屏 agent view；attach 时交出终端 | agent view 必需 |
| `ctx.ui.custom(factory, { overlay: true, overlayOptions: { width:"100%", maxHeight:"100%", row:0, col:0 }, onHandle })` | M19：记录视图作为全屏浮层盖在对话上，`onHandle` 拿到句柄用 `hide()` 关闭 | 记录视图需要；没有浮层就改成独立程序 |
| `tui.stop({ preserveScreen: true })` / `tui.start()` / `tui.requestRender(true)` | M14：交出终端时不把对话刷进滚动区；worker 收到 attach 信号后在真实终端上重新启动 TUI 并整屏重绘 | M14 必需（宿主默认全屏时尤其） |
| `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` | M12 子 agent 面板画在输入框下面；M14 用一个**不画任何内容**的 widget 拿到当前 `TUI` 引用（`worker-extras.ts` `registerAttachRepaint`） | 面板需要；M14 可换成别的拿 TUI 的办法 |
| `ctx.hasUI`、`ctx.cwd` | 无界面的会话（headless、scratch）不连 daemon、不装 widget | 必需判空 |
| `ctx.ui.onTerminalInput(fn)`（可 `consume`） | 空提示符按 ← 、Ctrl+Z/Ctrl+D 拦截 | 可降级为命令 |
| `ctx.ui.getEditorText/setEditorText/notify/setStatus/setWidget/setTitle/select` | UI 小件 | 可选 |
| `ctx.model` / `ctx.modelRegistry.find/getAvailable` | 摘要模型调用、/model 列表 | 摘要功能需要 |
| `ctx.getContextUsage()` | M8：上下文窗口占用（tokens / window / percent） | 可选，缺失时不显示 |
| `pi-tui`：`matchesKey` `Key` `isKeyRelease` `Input` `parseKey` `truncateToWidth` `visibleWidth` `Text` | agent view 渲染与按键 | 自带 TUI 时替换 |
| `pi-tui`：`Editor` + `EditorTheme`（M17，`task-editor.ts`）、`decodeKittyPrintable`、`wrapTextWithAnsi`（M19）、`Component` `TUI` 类型 | 任务输入框用宿主自己的多行编辑器（Shift+Enter 换行、长粘贴折叠）；记录视图的换行 | 可降级为单行 `Input` |

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
5. `/bg-fork <prompt>`：复制当前会话文件，`origin:"fork"` 在后台执行 prompt，前台不动。

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

### Step 9：worktree 隔离（M10）

完整设计见 `docs/plans/m10-worktree-isolation.md`，实现在 `lib/worktree.ts`（不依赖 pi，可直接复用，git 一律用 `execFile`，不经 shell，路径和分支名前加 `--`）。解决的问题：多个后台会话（尤其是 `roost_spawn` 出来的并行子会话）在同一个 checkout 里互相覆盖修改。

- **在派发时隔离，不在运行中切换**。原因就是 C7：用别的 cwd 续跑会话，pi 会弹阻塞对话框。所以先建 worktree、再在里面启动会话；会话之后永远不换 cwd，respawn、attach、`/resume` 看到的都是同一个 cwd。
- **入口**：`roost_spawn {worktree: true}`、agent view 里的 `/worktree`（`/worktree off` 关闭，用法同 `/model`）、`pi --bg --worktree`（不能和 `--session` 一起用）、`api.spawn({worktree:true})`；默认值来自配置 `worktreeIsolation`：`"off"`（默认）/ `"children"`（只给 roost_spawn）/ `"all"`（所有新的 pi 派发）。显式指定优先。shell 任务、adopt、`/fork` 永远不建 worktree。
- **布局**：仓库根 = 派发 cwd 的 `git rev-parse --show-toplevel`；worktree 放在**主 checkout** 下的 `.pi/worktrees/<slug>-<4位hex>`，分支 `roost/<slug>-<4位hex>`，从派发 checkout 的 `HEAD` 创建（`git worktree add -b <branch> -- <path> <base>`）；slug 来自会话名（小写 ASCII，≤32 字符，空时为 `task`）。派发 cwd 是子目录时映射到 worktree 里的同一子目录。`.pi/worktrees/` 只写一次到 `info/exclude`（用 `git rev-parse --git-path` 定位，对链接 worktree 和 submodule 都对），不改任何受跟踪文件。派发 checkout 里未提交的改动**不会**带进 worktree，脏时要提示；被忽略的文件（`node_modules`、`.env`）默认也不复制（M15 的 `.worktreeinclude` 可点名复制，见 Step 14）。
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

> Step 10–19 对应 M11–M20，彼此大多独立，可按需取舍。依赖关系：Step 11 → 12 → 18（面板 → 生命周期 → 记录视图）；Step 13 依赖 Step 6 的 attach 流程；其余互不依赖。

### Step 10：手机端启动与"使用中不回收"（M11，`docs/plans/m11-mobile.md`）

[pi-mobile](https://github.com/luoxin9510/pi-mobile) 把本机所有 pi 进程挂到手机上。worker 本来就是普通 pi，手机上早就看得到；M11 补两个缺口：手机的 **New session** 能起后台会话；手机正在用的会话不被空闲回收。**两个包都不 import 对方**，只通过 pi 的事件总线约定通道：

| 通道 | 谁发 | 数据 | pi-roost 做什么 |
|---|---|---|---|
| `pi-mobile:starters` | pi-mobile（建会话信息和点 New session 时） | `{ register(starter) }` | 在**每种角色**里注册 `{ id:"pi-roost", label:"Background session", start({cwd, prompt, env}) }` |
| `pi-mobile:activity` | pi-mobile（已配对设备每次调用会话） | `{ action }` | worker 上报 `remoteAt`，**最多每分钟一次**（`onMobileActivity(pi, fn, everyMs = 60_000)`），上报立即发 |

要点：

- `startForMobile` 走与"在 agent view 里输入任务"相同的路径（`dispatchModel/dispatchThinking`、`worktreeIsolation` 默认值、daemon 明确拒绝时 `discard()` 回滚 worktree），名字取自提示词或目录名。
- **环境只放行 `PI_MOBILE_*`**：请求的 `env` 里只有这个前缀的名字（允许数字）进 worker 环境（带 `PI_MOBILE_SPAWN`，手机凭它认出新会话）；请求里的 `PATH` 等其他名字一律丢弃，否则手机端能改 worker 的环境。
- daemon `reapable`：空闲时间从 `max(stateSince, remoteAt)` 算起；`acceptReport` 把 `remoteAt` 夹到不超过"现在"（防止伪造未来时间导致永不回收）。
- 限制：被回收的会话会从手机列表消失（pi-mobile 只列存活进程）；`/bg` 把对话交给另一个进程，手机上显示为新会话。

主要文件：`extensions/mobile.ts`，`daemon/main.ts` `reapable`/`acceptReport`，`lib/protocol.ts` `WorkerReport.remoteAt`。

**验收**：单测里请求带 `PATH` 和 `PI_MOBILE_SPAWN`，只有后者进了 worker 环境；手机（或测试 phone）发起 `spawn via:"pi-roost"` 得到新会话；对该会话做一次调用后，`state.json` 里出现 `remoteAt`；把 `reapIdleMinutes` 调小，手机持续使用的会话不被回收。

### Step 11：子 agent 面板（M12 / M12b，`docs/plans/m12-subagent-panel.md`）

解决：`roost_spawn` 出来的子会话只能去 agent view 找。面板画在父会话**输入框下面**（`setWidget(..., {placement:"belowEditor"})`）。

- 每行：图标、名字、年龄、一句话、`⎇ branch`、`(+N)` 后代数；最多 `subagentPanelRows` 行，多的显示 `… N more (/agents)`；有键位提示。
- 键：空提示符按 ↓ 选中（先探测"焦点在编辑器、没有对话框、没开 agent view"）；↑↓ 移动，第一行按 ↑ / Esc / ← 离开；**其他键离开面板并交给输入框**；Enter / → 进入（已结束的要按两次，休眠的直接唤醒；M19 之后 Enter 改为记录视图，见 Step 18）；`x` 两次停止运行中的子会话（父会话收到 `ended (stopped)`），已停止的 `x` 隐藏行；`m`（M12b）在选中行下开一行输入，Enter 以**用户回复**发给子会话（会触发它的汇报），Esc 取消；`K` 两次或 `/subagents stop` 停掉全部；`/subagents` 选中面板。（Claude Code 的 Ctrl+X Ctrl+K 被 pi 的 Ctrl+X 复制占用，所以用 `K`。）
- 数据：订阅 daemon 的 `job` 事件；**只在会话有子会话（`hasChildren`）或刚 `roost_spawn` 后才连 daemon**。进入子会话的流程与 agent view 相同（Step 6），子会话的 detach 键能回来，父会话这期间继续跑。worker 里也注册同一个面板（嵌套 attach）。
- 子会话变成 blocked/failed 时高亮 5 s。
- 评审修出的坑：headless 和 scratch 会话**绝不连**；用代数计数器丢弃旧会话遗留的连接结果；会话切换时清定时器；重连退避到 30 s 封顶并提示"lost the connection"；重启/停止子会话前要确认；输入框里未发出的消息不丢。
- 终端宽度 1–200 都不能让任何一行超宽（有测试逐宽度验证）。
- 命令 `/fork` 改名为 `/bg-fork`：与 pi 内置 `/fork` 重名会被 pi 从补全里剔除。
- 配置：`subagentPanel`（默认 `true`）、`subagentPanelRows`（默认 5，1–10）。

主要文件：`extensions/subagent-panel.ts`（`renderPanel`、`onInput`、`watch`、`stopOrHide`、`openComposer`、`stopAll`），`extensions/peer-link.ts`（`hasChildren`）。

**验收**：父会话 spawn 两个子会话，1 秒内出现两行；↓ ↓ Enter 进入第二个，← 回来时选中保留；选中状态下按 ← 只离开面板而不会把父会话转后台；进入子会话期间父会话的一轮正常结束、子会话的报告到达；`x` 停止（父会话收到报告）、再 `x` 隐藏；`m` 发出的消息被子会话处理。

### Step 12：子 agent 生命周期，与 Claude Code 一致（M13，`docs/plans/m13-subagent-lifecycle.md`）

解决：M9/M12 的子会话完成后进程一直不退，agent view 里每个子会话占一行、永不消失，太吵。对齐 Claude Code：

| 行为 | 实现 |
|---|---|
| agent view 不把有 `parentSession` 的行列为独立行 | `lib/view-model.ts` `listed(row, mode)`；父会话的偷看里写 `N subagents (k running)`；配置 `agentViewSubagents: "inline"` 恢复旧外观 |
| **父 pi 已关闭而子会话还在工作/等待时必须列出**，否则活儿无人看见 | daemon 给 `JobRow` 带 `parentOpen`：有前台 pi 持有该会话，或有活 job 记录着它，才为 true；**已结束或已回收的父 job 不算**（它的面板不在屏幕上）。前台 pi 注册/离开、job 的 worker 启动/结束时，daemon 用 `pushChildrenOf()` 重推子会话行 |
| 完成并汇报后关掉子会话的 worker | `scheduleAutoClose()`：最后一次 `done`/`idle` 报告或 `done` 的 handback 后 `AUTO_CLOSE_MS`（3 s，`PI_ROOST_AUTO_CLOSE_MS` 可覆盖）；检查项同空闲回收（未置顶、没人 attach、空闲、无待投递、非 starting/stopping），另加：done 已满一半等待时间、**自己的子会话没有还在跑的**。每次 done 且 idle 的报告重新计时，子会话的 worker 结束时重新检查其父。记录保持 `done`，标 `reaped`；`roost_send`/`m`/Enter 会从会话文件重新拉起 |
| 面板里完成即消失，页脚提示 | `done` 行立即移除，页脚显示 `/subagents to see subagents` 30 s（`LINGER_MS`）；failed/stopped 行从 `stateSince` 起保留 30 s，`x` 可提前隐藏 |
| `/subagents` 也列最近 30 s 完成的；`/subagents all` 列全部 | 排在运行中的下面；离开面板回到普通行 |
| 嵌套子 agent 画成树 | 孙会话在父下面（`└`，每级缩进两格），有后代的行带 `(+N)`；**若某行本该消失但其下面还有显示的行，它保留**，保证有路径 |
| `K` 两次 / `/subagents stop` | 停整棵树（含嵌套）并如实提示 |

坑：关闭前后两次检查（中间有 await）；父会话只在它**运行时**才算"持有"；关闭失败会重试。被用户 stop 的子会话不会自动恢复，给它发消息被拒绝（`outcome:"stopped"`）。未移植：按 Claude 的 `cleanupPeriodDays` 删除子会话记录（pi-roost 改为 M15 的 `cleanupDays`）。

配置：`subagentAutoClose`（默认 `true`）、`agentViewSubagents`（默认 `"hide"`）。

主要文件：`daemon/main.ts`（`parentOpen`、`pushChildrenOf`、`scheduleAutoClose`、`closable`、`autoClose`），`lib/view-model.ts`，`extensions/subagent-panel.ts`。

**验收**：spawn 一个子会话让它完成：agent view 里没有它的行；约 3 秒后它的 worker 被关闭（记录 `done`、`reaped`，没有多余的 "ended" 报告）；面板里行立即消失、页脚提示 30 s；`roost_send` 给它发消息后它重新跑起来；`subagentAutoClose:false` 时不关闭；关掉父 pi 后仍在工作的子会话出现在 agent view 里，父 pi 重新打开后又消失。

### Step 13：attach 手感如 `pi --resume`（M14，`docs/plans/m14-attach-like-resume.md`）

> **M21 已取代下面第 1–4 点的"重绘 + 扣输出"做法和下方的验收单测**，见 Step 20。移植时直接做 Step 20；第 5–7 点仍然适用。`attachRepaint` 报告字段和 worker 的重绘只为 M21 之前的 host 保留。

解决：宿主默认**全屏**（pi 1.5.0：备用屏、鼠标、应用内滚动）。worker 在无人观看时启动，进入备用屏、开鼠标上报、请求 kitty 键盘协议——但**只发生在 PTY 里**，真实终端没有这些模式。attach 时表现为：闪烁（host 把 PTY 缩一行再放大 = 两次整屏渲染）、滚轮不好使、每次进入都把你离开的那个视图的对话刷进终端滚动区。

做法（详见计划文档的 "What changes" 与 "Review decisions"）：

1. worker 里 `registerAttachRepaint`：收到 host 的 attach 信号（SIGUSR2）后 `tui.stop({preserveScreen:true})` → `tui.start()` → `requestRender(true)`，等同在真实终端上重新 `pi --resume` 一次。延迟 `REPAINT_DELAY_MS`（15 ms）。`attached.json` 里出现新的 `at`（接管）时再重绘一次。
2. worker 在报告里声明 `attachRepaint: true`；host 看到才**跳过缩放抖动和清屏**，并**先发 attach 尺寸再发信号**，pi 只画一次。shell 任务和旧 worker 仍走旧路径（清屏 + `nudge()`，现在由 host 发，不再由客户端发）。
3. **私有标记** `REPAINT_MARKER = OSC 7700;pi-roost-repaint`（`lib/attach.ts`）：worker 重绘前先写它，host 在 attach 流上**扣住输出直到看见标记**，这样 attach 尺寸引起的 SIGWINCH 重绘（针对用户还没进入的备用屏）不会到真实终端。`REPAINT_WAIT_MS`（1.5 s，`host/main.ts`）内没有标记就回退为清屏 + nudge。转发给客户端前一律剔除标记。
4. host 对 attach 先回一个 HELLO 帧（M14 是 `{repaint}`，M21 起是 `{replay:true}`）；客户端先收到数据而不是 HELLO，说明对面是旧 host，由客户端自己清屏。
5. agent view 和子 agent 面板交出终端时都用 `tui.stop({preserveScreen:true})`。
6. `TERMINAL_RESET` 增加：离开备用屏（**仅当这条流进入过备用屏**，否则主屏上的陈旧光标位置会被恢复）、重置焦点事件、同步输出、自动换行。
7. 常规模式（`tuiMode:"regular"`）同样重启，它的整帧会清屏和滚动区。

坑：全局记录"上次处理的 attach"，`session_start` 也要检查——会话切换（`/new`、`/resume`）期间 attach 也必须重绘；报告里的 `attachRepaint` 只在会话 TUI 在手时才声明。

主要文件：`extensions/worker-extras.ts`（`registerAttachRepaint`、`attachRepaintReady`），`host/main.ts`（`holdUntilRepaint`、`nudge`），`lib/attach.ts`。

**验收**：tmux 里 attach，抓到的流 = 离开/进入备用屏、模式设置、查询、**一帧**，没有对话刷屏；PageUp 在应用内滚动会话；Ctrl+Z 回到 agent view 且主屏滚动区未被污染；单测：声明 `attachRepaint` 的 worker 收到信号且既没有清屏也没有缩放，没声明的两者都有。

### Step 14：M15 打磨（`docs/plans/m15-polish.md`）

四个互不相关的小功能：

1. **`.worktreeinclude`**（Claude Code 同名功能；`lib/worktree.ts`）：源 checkout 根目录的 `.worktreeinclude`（gitignore 语法）里点名、**且被 git 忽略**的文件/目录，在建 worktree 时复制进去（`copyIncluded`，`cpSync` + `COPYFILE_FICLONE`，失败的跳过；跟踪文件本来就在 worktree 里；永不复制 pi-roost 自己的 `.pi/worktrees/`）。`createWorktree` 返回 `included`。**`rm` 时的配套规则**（让 M10 的"有被忽略的文件就保留"更精确）：被忽略的条目若 (a) 被**源 checkout** 的 include 文件覆盖，且 (b) 是依赖/缓存目录（`REBUILT` 集合：`node_modules .venv __pycache__ target .next` 等）或内容与源 checkout 逐字节相同（`sameTree`/`sameEntry`，最多比较 `TREE_MAX`=5000 个文件，超了就当作有改动），就不算成果；改过的 `.env`、include 目录里的新文件都算成果，worktree 保留。判断用源 checkout 的 include 文件，不用 worktree 里那份（会话可以改它）。状态用 `git status --porcelain=v1 -z --ignored`（`-z`：任意文件名都不会被引号搞乱）。
2. **`pi-roost list`（`ls`）**（`lib/list-format.ts` `formatList`）：给人看的表，行集合与 agent view 一致（`listed()`），`--subagents`/`--all` 加上子会话，`--cwd`；`--json` 仍给程序用。
3. **`cleanupDays`**（默认 30，0 = 不清）：daemon 每小时（`PI_ROOST_CLEANUP_CHECK_MS` 可覆盖，`PI_ROOST_CLEANUP_DAYS` 可覆盖天数）移除结束超过 N 天的会话**记录**，会话文件保留。`cleanable()` 排除：shell 任务、在跑/启动/停止/重启中、置顶、blocked、有待投递或暂存报告、仍有活子会话的父会话；有 worktree 的记录若 worktree 脏、有未覆盖的被忽略文件、或分支领先 base，也不清（记录里写着成果在哪）。
4. **host 在无人 attach 时回应终端查询**（设备属性、光标位置等）：`host/main.ts` 里 xterm headless 的 `term.onData` 把应答写回 PTY；attach 中（用户的终端自己会回）或等重绘标记期间（用户终端看不到查询）不回，worker 已死也不回。否则 worker 在无人观看时启动，可能卡在等终端应答上。

评审修出的坑：daemon 里的 git **一律异步带超时**，绝不阻塞事件循环；清理前后各检查一次（`cleanable` 调两遍）；include 条目与链接目标做比较而不是只看存在。

**验收**：include 文件点名的 `.env` 出现在新 worktree；未改动时 `rm` 干净地删掉 worktree，改过 `.env` 后 `rm` 保留；`pi-roost ls` 与 agent view 行一致；`PI_ROOST_CLEANUP_DAYS` 设小后结束的记录被清而会话文件仍在；无人 attach 时，向 worker 的终端查询（如 `CSI c`）得到应答而启动不卡住。

### Step 15：PR 状态与 "Ready for review"（M16，`docs/plans/m16-pr-status.md`）

解决：看不出会话的 PR 到哪一步。依赖 `gh`（没装或没登录就静默无标签，10 分钟后再试）。

- **关联**（worker，`extensions/pr-links.ts`）：监听 `tool_execution_start/end` 的 `bash` 调用（也看 codemode 内嵌的 bash）。`gh pr create/reopen/review/edit/comment/close/ready` 的输出里出现 PR URL 就记下；`gh pr checkout` 或 push 之后，在之后最多 `LOOKUP_RETRIES`（5）条 git/gh/glab/curl 命令内用 `gh pr view` 查当前分支。报告字段 `prLinks`（URL，最多 20）。worktree 会话的分支还由 daemon 自己查（`gh pr list --head <branch>`，无链接时最多每 10 分钟一次）。
- **状态**（daemon）：`state.json.prLinks` 取并集（≤20）；每 `PI_ROOST_PR_POLL_MS`（60 s）一轮，对**最近 7 天有活动或活着**的会话逐个 `gh pr view <url> --json number,url,state,isDraft,reviewDecision,statusCheckRollup,title`（一次一个）；结果存 `state.prs`，推给 `JobRow.prs`。merged/closed 的每 URL 每小时问一次。
- **显示**（`lib/pr.ts`、`lib/view-model.ts`）：行右缘 `#N`，OSC 8 超链接（`FORCE_HYPERLINK=0` 关）；颜色 warning（等检查/评审或检查失败）/ success / accent（已合并）/ dim（draft 或关闭）；多个 PR 显示 `3 PRs`，按最需要关注的上色，偷看里列出。新分组 **Ready for review**（Pinned 与 Needs input 之间）：不在工作也不在等待、PR 打开且非 draft、检查失败或未批准。空组不显示标题。`s:ready` 过滤；输入 `#N` 或 PR URL 时若有行含它就当过滤，否则当任务派发。
- 坑：一轮轮询最长一分钟（`PR_POLL_BUDGET_MS`），下一轮从上次停处续；每次 gh 调用后重新读 state，**轮询只写自己的字段**；`#N` 按编号匹配，URL 按 host/owner/repo/number 匹配（不管 scheme、大小写、尾部路径 `/files`、`#discussion…`）；`localhost`、裸 IP、`.local`/`.internal` 的链接忽略；被取消的 check run 不算失败。`gh` 路径可用 `PI_ROOST_GH` 覆盖（测试用）。
- 限制：分支查询在会话 cwd 里进行；codemode 内嵌的 `bash` 能看到，其他 shell 类工具看不到；GitLab `!N`（glab）未移植。

**验收**：会话里 `gh pr create` 后，行上出现带链接的 `#N`；检查失败时颜色变 warning 且会话进入 Ready for review 组；`s:ready` 只显示该组；输入 `#N` 选中对应会话；`gh` 不在 PATH 时一切照常只是没有标签（用 `PI_ROOST_GH` 指向假脚本可离线验证）。

### Step 16：任务输入框用宿主的编辑器（M17，`docs/plans/m17-editor-input.md`）

解决：agent view 的单行 `Input` 没有多行、没有长粘贴折叠。`extensions/task-editor.ts` 包装 pi-tui 的 `Editor`（宿主提示符编辑器的基类），只暴露视图原来从 `Input` 用到的小接口：`getValue`（展开粘贴标记）、`setValue`、`focused`、`handleInput`、`render`，外加 `multiline()`、`atEdge()`。

- 视图自己保留的键：Enter 派发、Ctrl+Enter 派发并 attach、Esc、Tab 补全 `@dir`、空输入框里 Space/`?`。Shift+Enter、Alt+Enter、Ctrl+J 交给编辑器加一行。↑↓ 默认移动行选择，**多行任务内部**才移动光标，到首/末行再切回行选择。
- 长的括号粘贴在屏幕上显示为 `[paste #1 +30 lines]`，发送时是完整内容。Ctrl+G（外部编辑器）的结果原样放进编辑器，同时 `tui.stop({preserveScreen:true})`。空时那一行显示提示。
- 评审修出的坑：裸 LF（旧终端的 Ctrl+J）当换行交给编辑器，视图自己的 Enter 只认 CR；**括号粘贴未结束期间所有分片都交给编辑器**（分片可能恰好是 `\r`、空格或 `?`，不能当按键）；Tab 补全 `@dir` 只替换末尾那个词，之前的折叠粘贴保持折叠。
- 未移植：图片粘贴（宿主的 `CustomEditor` 经键位管理器读剪贴板，扩展拿不到；派发会话的首条提示本来也是文本）。限制：长单行折行时 ↑↓ 仍在行间移动（按逻辑行算）；宿主的 jump 模式（Ctrl+]）不会被视图已处理的键取消。

**验收**：输入 Shift+Enter 得到多行任务并派发出去，会话收到完整多行文本；粘贴 30 行得到 `[paste #1 +30 lines]` 且派发内容是完整 30 行；单行时 ↑↓ 仍切换选中行。

### Step 17：agent 预设（M18，`docs/plans/m18-agent-presets.md`）

解决：Claude Code 的 `<agent-name> <prompt>` / `@name` / `--agent` / `a:` 过滤。宿主若有自己的 agent 定义文件就读那个；pi 本身没有，pi-roost 读 **pi-subagents** 的 markdown 定义（`lib/agents.ts`，纯文件解析，可复用）。

- **定义与优先级**（低 → 高，同名后者覆盖；同一层里包之间先到先得）：pi-subagents 内置（`npm/node_modules/pi-subagents/agents`）→ 包声明的目录（`pi-subagents.agents` 或 `pi.subagents.agents`）→ 用户 `~/.pi/agent/agents/**`（`PI_CODING_AGENT_DIR`）、`~/.agents/**` → 项目 `.agents/**`、`.pi/agents/**`（从仓库根到 cwd；不在仓库内只读 cwd 自己的；家目录永远不当项目）。前置字段：`name description model thinking tools systemPromptMode`，正文是系统提示。跳过：`*.chain.md`、有 `runner`（别的 CLI）、`disabled: true`、没有 `description`、名字不是普通标识符；`aliases` 也算名字；`excludeTools` → `--exclude-tools`（永不排除 pi-roost 自己的工具）。
- **启动参数**（`agentArgs`）：`--model`、`--thinking`、`--tools`（**再加上 `roost_*`**，子会话才能汇报和通信）、`--system-prompt`（替换，默认）或 `--append-system-prompt`；带 `+x`/`-x` 修饰的 tools 原样传。`buildLaunch` 在 agent 设置了 model/thinking 时丢掉前台自己的 `--model/--thinking`。**优先级（强 → 弱）**：视图里选的 `/model`、`/thinking` → `roost_spawn` 的 `model/thinking` → `--bg` 时手输的 `--model/--thinking` → agent 的 → `dispatchModel/dispatchThinking`。续跑的会话保留 agent 的 tools 和提示参数（它们不在 `SESSION_RESTORED_FLAGS` 里）。
- **选择入口**：agent view 里首词（名字或别名）或 `@name` 后接任务；单独一个名字当任务。**项目里的 agent 来自别人克隆的仓库，只能用 `@name` 显式选**（pi-subagents 对项目 agent 也要确认信任）；`/…` 命令和 `!…` 不解析，`name !cmd` 拒绝。配置 `dispatchAgent` 是视图和 `--bg` 的默认值，未知名字**拒绝任务并提示**（命令和 `!` 照常）。`pi --bg "task" --agent name`；`roost_spawn {agent}`；`DispatchArgs.agent` → 记录 `agent` → `JobRow.agent`（偷看里显示，`a:` 过滤匹配）。
- 未移植：agent 选择器 UI 和每 agent 颜色；pi-subagents 的 `chains/skills/extensions/inheritProjectContext/inheritSkills`、runner；`package:` 作用域名；`settings.json` 里按路径列出的包（只读 `npm/node_modules`）。已知行为：`pi --session <已写过的文件> --bg --agent x` 时 agent 的 model/thinking 会替换会话原有的；`@dir` 目标的 agent 从视图所在目录找。

**验收**：`~/.pi/agent/agents/reviewer.md` 定义 model 和 tools 后，视图里输入 `reviewer 看一下这个 diff` 派发的会话用了该 model、工具集含 `roost_*`、系统提示被替换，偷看里显示 agent 名；`a:reviewer` 能过滤；同名的项目 agent 只有 `@reviewer` 才选中；`dispatchAgent` 设成不存在的名字时任务被拒绝并给出信息。

### Step 18：子 agent 记录视图（M19，`docs/plans/m19-transcript-view.md`）

解决：面板里 Enter 过去是 attach 子会话的 PTY。Claude Code 是在会话里看子 agent 的对话、路径回 main、能直接打字恢复它。M19 把 **Enter 改为记录视图，→ 保持 attach**。

- 视图是**全屏浮层**（`ctx.ui.custom` + overlay，见 §1.2），盖在对话上；**不 attach 任何东西**，子会话照跑、PTY 不动。头部是路径 `main › parent › child` 加状态和年龄。
- 键：打字/Enter = 给当前显示的子 agent 发消息（走 daemon `reply`：送达，或把它重新拉起；没发出去的消息回到输入框）；输入框为空时 ↑↓/Enter 在树里选行并打开（`← parent`、同级——当前的标记出来、直接子级）；Esc = 先清输入框，再上一级（父的记录，**不是**之前看的那一行），顶层子会话再 Esc 回到对话；PgUp/PgDn 滚动，否则跟随末尾；Ctrl+O = 离开并 attach（已结束的要再按一次 Ctrl+O 才启动，`ARM_MS` 2.5 s 内；输入框有内容时不触发）。
- **读取**（`lib/transcript.ts`，纯函数）：只读会话文件的**最后 `READ_MAX`（4 MB）**，被截断时提示"更早的消息被截掉"；从最后一条 entry 沿 `parentId` 走**当前分支**；列出：用户提示、assistant 文本、工具调用及其结果前 3 行（`RESULT_LINES`，错误标出）、会显示的自定义消息（pi-roost 发给子会话的）、压缩、assistant 错误。**不含 thinking**。展示给终端的所有字符串都经 `clean()` 去掉转义序列和控制字符（名字、摘要、问题、错误也一样）。每 500 ms `stat` 轮询文件，工作中的子会话记录会实时增长。
- 评审修出的坑：没有会话文件的行（shell 任务）要说明而不是沿用上一个的内容；"消息没发出去"只在仍显示同一个子 agent 时才还回输入框；树的选中跟随行而不是下标；终端不到 10 行时不画树但输入框和键保留；记录打开时会话切换或 pi 关闭要关掉它，并且通过宿主的 `done` 关闭；被截断的开头仅在那一行确实被截时才丢弃。
- 未移植：原地（非浮层）记录；展开工具的完整输出（三行+计数，Ctrl+O 去 attach 看全部）；不应用 `context_edit`，压缩前的消息仍显示（视图展示"发生了什么"而非模型上下文）。

主要文件：`extensions/transcript-view.ts`（`TranscriptView`），`lib/transcript.ts`，`extensions/subagent-panel.ts`（入口）。

**验收**：父会话有一个正在工作的子会话，面板里 Enter 看到它的对话并随工作增长；在里面打字后消息送达子会话；↑↓ 切到同级/父级，Esc 逐级回到对话；Ctrl+O 进入它的 PTY；对一个含大量历史的会话文件（>4 MB）显示截断提示；会话文件里混入转义序列不会污染终端。

### Step 19：后台会话看到 shell 看到的环境（M20，`docs/plans/m20-shell-environment.md`）

解决：旧的白名单环境缺 API key、`NODE_OPTIONS`、`AWS_PROFILE`、`JAVA_HOME`、公司 CA 等；而在中心目录开的 hub 往各个工作区派会话时，hub 目录的 `.envrc` 不该跟着所有会话，工作区自己的却没加载。两层：

1. **派发时继承**（`lib/dispatch.ts` `workerEnv()`）：取派发进程的**全部**环境，去掉：任务身份（`PI_JOB_*`、`PI_DAEMON_SOCK`、`PI_ROOST_RESTORE`）；指代启动终端的变量（`lib/workspace-env.ts` `ENV_NEVER`：`TERM*` `TMUX*` `STY` `WINDOWID`、iTerm/kitty/WezTerm/Alacritty/Ghostty/Zellij 的 id、`COLUMNS/LINES`、`PWD/OLDPWD/SHLVL/_`、`GPG_TTY/SSH_TTY`，前缀 `VSCODE_ KONSOLE_ ITERM_ KITTY_ WEZTERM_ ZELLIJ_`——会话跑在自己的 PTY 里，之后可能从别的终端甚至手机打开）；`envDenyList`（精确名或 `PREFIX*`，`envAllowList` 里的名字照样放行）；无法设置的名字（含 `=` 或 NUL）。`inheritEnv:false` 回到旧白名单。
2. **每次启动时在 PTY host 里求工作区环境**（`lib/workspace-env.ts` `workspaceEnv()`，在 host spawn worker 之前，总预算 `PROBE_TIMEOUT_MS`=8000 ms，约 70% 给 shell、其余给 direnv；attach 等待是 15 s，必须小于它）：
   - 在会话目录里跑 `$SHELL -i -c`：zsh = `cd` 后跑全部 `chpwd_functions` 和 `precmd_functions`；bash = `PROMPT_COMMAND`（含数组）；fish = `emit fish_prompt`；tcsh/csh = `cd` 后跑 `cwdcmd`、`precmd` 别名（direnv 的 tcsh 钩子是 `precmd` 别名；macOS 的 csh 就是 tcsh）；然后在标记之后 `env -0`。direnv 钩子卸载旧目录变量（`DIRENV_DIFF`）并加载新目录的；mise/fnm/nvm 同理，信任规则仍归它们自己。
   - 没有受支持的 shell 或失败：若 PATH 上有 direnv，则 `direnv export json` 并应用差异；否则保持携带的环境。shell 已跑过但没动 hub 目录的 direnv（装了 direnv 但 rc 没钩子）时，再叠一次 `direnv export json`。
   - 细节坑：探针要**关 stdin**、用会话自己的 `TERM`（**不能是 `dumb`**，很多 rc 在 dumb 终端上提前返回）；探针放在**独立进程组**里，结束后整组杀掉（rc 在后台留下的 `nohup x &` 随之消失；自己脱离进程组的 ssh-agent/gpg-agent 不会）；以 shell 退出为准，后台子进程握着 stdout 不会让探针一直等；退出钩子失败也不丢已有输出；shell 里无法持有的变量名（`FOO-BAR`）沿用基础环境的；输出末尾有**结束标记**，被截断的不采用；探针自己的变量和 `envKept` 不放行的名字要从结果里剔除（防 rc 把被禁的秘密重新导出）；`PWD` 设为会话目录；`envAllowList` 的名字在派发时和在 host 里都过 deny list（`envForce`）；探针期间收到 stop（SIGTERM/SIGHUP）要杀探针并把 job 按"从未运行"结束（`earlyStop`）。
   - 每次启动都求值，所以回收后唤醒会拿到改过的 `.envrc`；shell 任务（`!cmd`）同样处理；`workspaceEnv:"direnv"` 跳过 shell，`"off"` 两者都跳过；`inheritEnv:false` 时强制 `off`（`envPolicy()`）。M20 之前的记录没有 `workspaceEnv` 字段，按旧方式启动。respawn 不重新读派发者的环境，只重新求工作区那一层。实测约 40 ms（zsh + direnv）。
3. **传递**：`DispatchArgs.workspaceEnv / envDeny / envForce` 进 `job.json`（整份环境也在里面，0600 文件在 0700 目录里，与 `~/.pi/agent/auth.json` 同级的信任）。
4. **安全**：`inheritEnv/workspaceEnv/envDenyList/envAllowList` 全是用户级配置，项目的 `.pi/roost.json` 不能设置。探针运行的是你自己的 shell rc，在你派发的目录里，与你在那里 `cd` 一下跑的代码一样。
- 未做：nushell/xonsh/ksh 钩子（只有 direnv 后备）。

主要文件：`lib/workspace-env.ts`、`lib/dispatch.ts`（`workerEnv`/`buildLaunch`）、`lib/config.ts`（`envPolicy`）、`host/main.ts`。

**验收**：hub 在目录 A（`.envrc` 设 `HUB_VAR`），在目录 B（`.envrc` 设 `WS_VAR`）派发 `!env`：看到 `WS_VAR`、没有 `HUB_VAR`、`DIRENV_DIR` 指向 B、`PWD` 为 B、有你 shell 的自定义变量、没有 `TMUX`；`envDenyList` 里的名字即使 rc 重新导出也不在；rc 里写 `sleep 100` 的会话在 8 秒内照样启动；`inheritEnv:false` 时回到白名单。

---

### Step 20：attach 从 host 的屏幕开始（M21，`docs/plans/m21-attach-replay.md`）

解决：M14 依赖 worker 收到 SIGUSR2 后重绘，host 扣住输出直到重绘标记。这有四个问题：没有回放（shell 任务、旧 worker、空闲时不重绘的程序看到的是旧画面或空白）；依赖时序（1.5 s 超时回退为清屏 + 缩放，会闪一下）；SIGWINCH 和 SIGUSR2 两个信号的先后不确定（Linux 上 bash 按信号编号执行 trap，USR2=12 先跑，WINCH 的重绘漏到标记之后，M14 的测试在 Linux 上稳定失败）；每次都画两遍。

做法（tmux 的模型：host 的镜像就是真相）：

1. attach 时 host 回 `HELLO {replay:true}`，先把 PTY 和镜像都调到客户端尺寸。
2. `term.write("", cb)`：等镜像把 attach 之前收到的字节都解析完，在回调里发**快照**。快照由 `@xterm/addon-serialize` 生成（`serialize({scrollback:0})`，不往用户的滚动区倒历史），前面加 SGR 重置、回到左上角、清屏；程序在备用屏时，`?1049h` 之后再清一次（用户终端可能正停在 agent view 的备用屏上）；最后追加 serialize 不覆盖的模式。
3. serialize 能还原应用光标键、bracketed paste、鼠标跟踪，但**不能还原**光标显隐、SGR/UTF-8/urxvt 鼠标编码、焦点事件、kitty 键盘标志栈、modifyOtherKeys。这些由 host 在输出流里自己跟踪（`lib/term-modes.ts` `ModeTracker`；序列可能被 chunk 截断，要留尾巴拼接）。
   坑（审核发现）：
   - **快照点可能落在一个转义序列中间**：前半截已进镜像的解析器、不在快照里，后半截在排队的输出里，客户端会把后半截当文字打出来。host 用 `StreamTail` 记住流末尾未完成的序列，快照后先发它。
   - **模式要在快照点取**（`replay()` 里同步取 `modes.restore()`），不能等回调时再取，否则窗口里到达的 kitty push 会被算两次，detach 后键盘停在 kitty 模式。
   - **程序在备用屏时只发备用屏**，主屏内容会落到用户自己的主屏上（从 shell 里 attach 后，detach 回来 shell 画面被换掉）。
   - **先复位客户端**（`CLIENT_RESET`：SGR、滚动区、原点模式、字符集、光标显示、各种鼠标、焦点、bracketed paste、光标形状），因为只发"与默认值不同"的模式，而用户终端可能停在别的状态。
   - 还要跟踪：滚动区 DECSTBM（改尺寸时清除；设置会把光标移到左上角，之后要按原点模式放回光标）、光标形状 DECSCUSR、G0 字符集、RIS/DECSTR；kitty 标志栈主屏、备用屏各一个。
   - 镜像的 `resize` 要排在尚未解析的写入之后（`term.write("", () => term.resize())`），PTY 的 resize 立即做。
   - attach 后到快照点解析完之前，host 仍要回答终端查询（这些查询客户端永远收不到）。
4. 快照之后到达的字节先排队，快照发出后按顺序转发，之后照常直通。客户端最终就是镜像的屏幕，并和镜像同步；程序针对新尺寸的重绘排在快照之后，原样叠加。不扣输出、不丢输出、和信号先后无关。
5. `attached.json` 写 `replay:true`，新 worker 看到就不再重绘（只画一次）。SIGUSR2 照发，"离开期间"回顾要用。旧 worker 仍会重绘，它的标记照样剔除，多画一次也无害。
6. 删除：扣输出、`REPAINT_WAIT_MS`、清屏 + nudge 回退。有人 attach 时终端查询交给用户终端回答（随数据流到达）。

主要文件：`host/main.ts`（`snapshot`、`replay`），`lib/term-modes.ts`，`extensions/worker-extras.ts`。运行时依赖新增 `@xterm/addon-serialize`（与 `@xterm/headless` 6.0 配套的 0.14）。

**验收**：无人 attach 时启动的全屏 pi worker，`pi-roost attach` 后 0.4 s 内画面完整（对话、编辑框、底栏）；改尺寸、打字、detach、再 attach 都即时，草稿还在；host 日志里没有 repaint 和 nudge。单测：安静的程序不靠信号也能立刻拿到画面；WINCH 重绘排在快照之后；备用屏、鼠标、SGR 鼠标、kitty 标志、隐藏光标完整还原；旧 worker 的标记被剔除；抢占 attach 拿到同一屏幕。

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
| `dispatchAgent`（M18） | 无 | |
| `subagentPanel` / `subagentPanelRows`（M12） | `true` / `5`（1–10 的整数） | |
| `subagentAutoClose`（M13） | `true` | |
| `agentViewSubagents`（M13） | `"hide"`（或 `"inline"`） | |
| `reapIdleMinutes` | `60` | |
| `cleanupDays`（M15） | `30`（0–3650，0 = 不清） | |
| `notify` | `"auto"` | |
| `leftArrowOpensAgents` | `true` | |
| `defaultToAgentsView` | `false` | |
| `envAllowList` | `[]` | ✔ |
| `inheritEnv`, `workspaceEnv`, `envDenyList` | `true`, `"shell"`（`"direnv"`/`"off"`）, `[]` | ✔（M20） |
| `agentTools` | `true` | |
| `agentExternalMessages` | `false` | ✔ |
| `agentMaxDepth/Children/Tree/Total` | 3 / 8 / 16 / 32 | ✔ |

> 表中"仅用户级"的集合就是 `lib/config.ts` 的 `USER_ONLY`：`envAllowList inheritEnv envDenyList workspaceEnv summaryModel agentExternalMessages agentMaxDepth agentMaxChildren agentMaxTree agentMaxTotal`。（v0.1.5 的旧表把 `agentTools` 也标成了仅用户级，那是错的。）`inheritEnv:false` 时 `envPolicy()` 会把 `workspaceEnv` 强制成 `"off"`。

"仅用户级"的原因：别人克隆来的仓库不能决定**你的环境变量**流向哪里、**会话记录**发给哪个模型、agent 能扩散多远。移植时保留这条规则。

**后台环境**（M20 起，`lib/dispatch.ts` `workerEnv()`）：默认继承派发方的全部环境，去掉任务身份和启动终端相关的变量（`lib/workspace-env.ts` `ENV_NEVER`）以及 `envDenyList`；宿主每次启动 worker 时再在会话目录里跑一遍 shell 的 cd hook（direnv/mise/fnm），见 `docs/plans/m20-shell-environment.md`。`inheritEnv: false` 时用旧的白名单（`allowListedEnv()`）：`PATH HOME USER LOGNAME SHELL LANG LC_* TERM COLORTERM TMPDIR` + 代理变量（大小写都认）+ `envAllowList`。**在派发那一刻**快照进 `job.json`，respawn 沿用。公司环境通常要加 API key 变量和 `NODE_EXTRA_CA_CERTS`。

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
| 手机活动上报节流（M11） | 60 s | `mobile.ts` `onMobileActivity(everyMs)` |
| 子会话完成后自动关闭等待（M13） | 3 s（需已 done 满一半时间） | `daemon` `AUTO_CLOSE_MS`（`PI_ROOST_AUTO_CLOSE_MS`） |
| 面板里完成/失败/停止行保留、页脚提示（M13） | 30 s | `subagent-panel.ts` `LINGER_MS` |
| 面板里 blocked/failed 高亮（M12） | 5 s | `subagent-panel.ts`（`onEvent` 内的定时器） |
| 面板重连退避上限（M12） | 30 s | `subagent-panel.ts` `watch` |
| attach 等待重绘标记（M14，M21 已删除） | — | 原 `host/main.ts` `REPAINT_WAIT_MS` |
| worker 收到 attach 信号后重绘延迟（M14） | 15 ms | `worker-extras.ts` `REPAINT_DELAY_MS` |
| 等待 host socket 就绪（`ensureLive`） | 15 s | `lib/resume.ts` `START_TIMEOUT_MS` |
| 记录清理检查间隔（M15） | 1 h | `daemon` `cleanupOld`（`PI_ROOST_CLEANUP_CHECK_MS`） |
| 比较 include 目录的文件数上限（M15） | 5000 | `worktree.ts` `TREE_MAX` |
| PR 轮询间隔 / 单轮预算（M16） | 60 s / 60 s | `daemon` `PR_POLL_MS`（`PI_ROOST_PR_POLL_MS`）/ `PR_POLL_BUDGET_MS` |
| PR 只轮询最近活跃的会话（M16） | 7 天 | `daemon` `PR_ACTIVE_MS` |
| worktree 分支的 PR 查找间隔；`gh` 缺失后重试（M16） | 10 min / 10 min | `daemon` `PR_LIST_MS`、`ghMissingUntil` |
| merged/closed PR 重查（M16） | 每 URL 1 h | `daemon`（`checked[url]`） |
| 每个会话记录的 PR 链接上限（M16） | 20 | `daemon` `MAX_PR_LINKS`、`pr-links.ts` `MAX_LINKS` |
| 提交/推送后查分支 PR 的重试条数（M16） | 5 | `lib/pr.ts` `LOOKUP_RETRIES` |
| `gh` 单次调用超时（M16） | 20 s | `daemon` `gh()` |
| 记录视图轮询会话文件（M19） | 500 ms | `transcript-view.ts`（`pollMs` 默认） |
| 记录视图读取上限（M19） | 4 MB（读尾部） | `lib/transcript.ts` `READ_MAX` |
| 记录视图 Ctrl+O 二次确认窗口 / 提示显示（M19） | 2.5 s / 4 s | `transcript-view.ts` `ARM_MS` / `NOTICE_MS` |
| 记录视图每个工具结果显示行数（M19） | 3 | `transcript-view.ts` `RESULT_LINES` |
| 工作区环境探针总预算（M20） | 8000 ms（70% 给 shell） | `lib/workspace-env.ts` `PROBE_TIMEOUT_MS` |

调试用环境变量：`PI_ROOST_HOME` `PI_ROOST_RUNTIME_DIR` `PI_ROOST_CONFIG_DIR` `PI_ROOST_HOST_ENTRY` `PI_ROOST_REAP_MINUTES` `PI_ROOST_REAP_CHECK_MS` `PI_ROOST_SHELL_KEEP_MS` `PI_ROOST_PROGRESS_MS` `PI_ROOST_FIRST_PROGRESS_MS`；v0.1.7 新增：`PI_ROOST_AUTO_CLOSE_MS`（M13）、`PI_ROOST_CLEANUP_DAYS` `PI_ROOST_CLEANUP_CHECK_MS`（M15）、`PI_ROOST_PR_POLL_MS` `PI_ROOST_GH`（M16，`gh` 可执行文件路径）——测试全靠它们把时间缩短、把目录隔离到临时路径、用假的 `gh`。（内部标记变量 `PI_ROOST_RESTORE`、`PI_ROOST_CHILD` 见 §3。）

---

## 7. 构建与打包

- Node ≥ 22.19，ESM，源码直接是 `.ts`（`allowImportingTsExtensions` + `erasableSyntaxOnly`：**只用可擦除的 TS 语法**，不能用 enum/namespace/参数属性）。
- 扩展由宿主直接加载 `.ts`；daemon/host/bin 由 `tsc -p tsconfig.build.json` 编译到 `dist/`（`rewriteRelativeImportExtensions` 把 `.ts` 导入改成 `.js`），`scripts/fix-dts.mjs` 修 `.d.ts` 里的导入。宿主不能直接加载 TS 时，扩展也一起编译。
- `lib/client.ts` `packageRoot()` 从模块位置向上找 `package.json` 来定位 `dist/daemon/main.js`、`dist/host/main.js`——**打包目录结构变了要同步改**。
- 本地安装（`scripts/install-local.sh`）：先在旁边建新副本再原子替换（daemon 是懒加载 node-pty 的，不能从半装好的目录运行）；替换前 `daemon stop --keep-workers`，后台会话不断。
- 运行时依赖只有三个：`node-pty`、`@xterm/headless`、`@xterm/addon-serialize`（M21）。CLI、daemon、host 不能引用宿主的包（peer 依赖），`test/cli-deps.test.ts` 守着。

---

## 8. 测试策略

`test/` 下 25 个 vitest 文件（`pool: "forks"`，超时 20 s），移植时建议**先移植测试**：

| 测试 | 覆盖 | 移植难度 |
|---|---|---|
| `framing` `lib-core` `config` `dispatch` `dispatch-input` `view-model` `worker-state` `comms` `fit-screen` | 纯函数 | 直接复用 |
| `list-format`（M15）`pr`（M16：URL 识别、状态判定、`#N` 匹配）`transcript`（M19：分支遍历、截断、转义清理）`agents`（M18：定义发现与优先级、`agentArgs`、`pickAgent`） | 纯函数 / 临时目录里的文件 | 直接复用（`agents` 要换成宿主的定义格式） |
| `workspace-env`（M20） | 真 zsh（隔离 `ZDOTDIR`+precmd 钩子）、假 direnv、会挂住的 rc、tcsh/csh 的 `.cshrc`；never/deny/allowlist 规则 | 需要本机有对应 shell；缺 zsh/tcsh 的环境会跳过相应用例 |
| `worktree` | 在临时 git 仓库上真跑：创建、状态、清理的各种情况、`.worktreeinclude` 复制与"是否算成果"的判断（M15） | 直接复用（需要 git） |
| `daemon` `host` | 用临时目录 + 假 worker 起真 daemon/host；M13 自动关闭与 `parentOpen`、M11 的 `remoteAt` 不被回收、M21 attach 快照（序列截断、模式只计一次、备用屏不覆盖主屏）；`term-modes` 模式跟踪与未完序列 | 改路径/env 前缀即可 |
| `reporter` `reply-queue` `summaries` `worker-wiring` `foreground` `agent-view` `mobile`（M11：只放行 `PI_MOBILE_*`）`subagent-panel`（M12/13：排序、树、`(+N)`、行生命周期、宽度 1–200 不溢出、按键） | 用假的 `ExtensionAPI` 驱动 | 换成你的适配器 mock |

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
11. （M11）被回收的会话会从 pi-mobile 手机列表消失，手机无法唤醒；`/bg` 对手机来说是新会话。
12. （M12/M19）记录视图是全屏浮层而不是原地绘制；展开工具完整输出只能 attach 去看；`context_edit` 未应用，压缩前的消息仍显示。
13. （M13）不按天删除子会话记录，只有 `cleanupDays` 的统一清理；`/tasks` 的"隐藏失败/停止行"没有对应，面板只有一个。
14. （M14）依赖宿主默认全屏且 `tui.stop({preserveScreen:true})` 可用；宿主没有这个选项时 attach 仍会刷屏、闪烁（可退回 resize 抖动，即旧路径）。
15. （M16）PR 状态依赖 `gh`；不支持 GitLab `!N`（glab）；分支查找在会话 cwd 里做，`cd elsewhere && git push` 会在 elsewhere 查；codemode 之外的 shell 类工具看不到。
16. （M17）任务输入框不支持图片粘贴；长单行折行时 ↑↓ 仍按逻辑行在行间移动。
17. （M18）只读 pi-subagents 的定义（`npm/node_modules` 里的包），不支持 chains、skills、runner、`package:` 名字；项目 agent 只能用 `@name` 选；没有选择器 UI 和每 agent 颜色。
18. （M20）工作区环境只支持 zsh/bash/fish/tcsh/csh 的钩子和 direnv 后备，没有 nushell/xonsh/ksh；整份环境存进 `job.json`（0600），respawn 不重读派发者的环境，只重新求工作区那一层；探针运行你的 shell rc，慢 rc 会吃掉启动预算（8 s 封顶）。

---

## 附录 A：daemon op 一览（v0.1.7）

| op | 调用方 | 说明 |
|---|---|---|
| `ping` `status` | 任意 | 版本/健康检查 |
| `list {all?, cwd?}` | view/CLI | 默认隐藏结束超过 48h 的 |
| `subscribe` | view | 之后推送 `job` / `removed` 事件 |
| `dispatch DispatchArgs` | 前台/CLI/API/手机（M11） | 新建 job 并启动 host；M10 可带 `worktree`，daemon 会校验；M18 `agent`；M20 `workspaceEnv` `envDeny` `envForce` |
| `stop` `resolve` `pin` `rename` `reorder` | view/CLI | 管理 |
| `rm` | view/CLI | 停止并删除；M10 返回 worktree 清理结果 |
| `respawn {id?|all, restart?, prompt?}` | view/CLI | 重启已结束的（或在跑的） |
| `reply {id, text}` | view/CLI | 投递用户回复 |
| `shutdown {keepWorkers?}` | CLI | 停 daemon，可保留 host 继续跑 |
| `report {id, token, report}` | worker | 状态快照，同时绑定连接；v0.1.7 新增字段 `attachRepaint`（M14）、`remoteAt`（M11）、`prLinks`（M16） |
| `ack {id, token, seq, exact?}` | worker | 确认投递 |
| `peer_register` `peers` `send` `spawn` `peer_ack` | 前台/worker（M9） | 通信 |
| `handback` | 子 worker（M9） | 报告给父会话 |

**v0.1.7 没有新增 op**：M11–M20 的新功能都复用现有 op，只在字段上扩展——`list`/`job` 事件里的 `JobRow` 新增 `parentOpen`（M13）、`agent`（M18）、`prs`（M16，`PrInfo[]`），M10 的 `worktree`；`dispatch` 的 `DispatchArgs` 新增 `agent` `workspaceEnv` `envDeny` `envForce`；`report` 的 `WorkerReport` 新增 `attachRepaint`（M21 起只有旧 host 读）`remoteAt` `prLinks`。`reply`（M19 记录视图发消息、M12b 面板 `m`）、`respawn`（M13 唤醒休眠的子会话）、`rm`（M15 `.worktreeinclude` 感知的清理）语义不变。host 帧协议新增：attach 的首个回复帧 `HELLO {repaint}`（M14）/ `{replay:true}`（M21，之后第一帧 DATA 是快照），`attached.json` 的 `replay`（M21），数据流里的私有标记 `OSC 7700;pi-roost-repaint`（M21 起 host 只负责剔除）。

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
| 10 | M11 手机端启动（可选，需 pi-mobile 同类物） | `mobile.ts` + daemon `reapable` | 小 |
| 11 | M12/M12b 子 agent 面板 | `subagent-panel.ts` | **中到大**（取决于 TUI 框架是否有"输入框下方 widget"） |
| 12 | M13 子 agent 生命周期 | `daemon` 自动关闭/`parentOpen`、`view-model.ts`、面板树 | 中 |
| 13 | M14 attach 如 resume | `worker-extras.ts` 重绘 + `host/main.ts` 扣流 + `attach.ts` | 中（需要宿主能 `stop({preserveScreen})`+重启 TUI） |
| 14 | M15 打磨 | `worktree.ts` include、`list-format.ts`、daemon 清理、host 查询应答 | 小 |
| 15 | M16 PR 状态 | `pr.ts`（复用）+ `pr-links.ts` + daemon 轮询 | 小到中（需 `gh`） |
| 16 | M17 任务输入框 | `task-editor.ts` | 小（宿主有现成多行编辑器时） |
| 17 | M18 agent 预设 | `agents.ts`（按宿主的定义格式改写） | 小到中 |
| 18 | M19 记录视图 | `transcript.ts`（复用，要按宿主会话文件格式改）+ `transcript-view.ts` | 中 |
| 19 | M20 shell 环境 | `workspace-env.ts`（复用）+ `dispatch.ts` + host | 小到中（需在真实 shell/direnv 上调） |

## 附录 C：版本对应

| 提交 | 内容 |
|---|---|
| `0a6a80c` | v0.1.1，M1–M7 |
| `a89e146` | M9 agent 间通信合入 |
| `ec5394b` | M8 模型与上下文合入 |
| `638fdd7` | M10 worktree 隔离合入 |
| `95e2599` | M8 三轮 review 修复合入 |
| `2f40878` | 发布 v0.1.5（本文上一版依据；之前文档里写的 0.2.0 已改为 0.1.5） |
| `ebc5f73` | PR #20：M11 pi-mobile 集成（手机端启动、使用中不回收） |
| `53ab6de` | PR #21：M12 子 agent 面板 |
| `f88f2dd` | PR #22：M12b 面板操作（`m` 发消息、`K` 全停） |
| `2ba2872` | PR #23：发布 v0.1.6 |
| `823525a` | PR #24：M13 子 agent 生命周期 |
| `efa93d1` | PR #25：M14 attach 如 `pi --resume` |
| `0837c75` | PR #26：M15 打磨（`.worktreeinclude`、`list`、`cleanupDays`、host 应答终端查询） |
| `894dcaa` | PR #27：M16 PR 状态与 Ready for review |
| `2901f24` | PR #28：M17 任务输入框用宿主编辑器 |
| `510c27b` | PR #29：M18 agent 预设 |
| `4636ae9` | PR #30：M19 子 agent 记录视图 |
| `fc62184` | PR #31：M20 shell 环境 |
| `0d16cd4` | PR #32：发布 v0.1.7（本文依据，tag `v0.1.7`） |

所需 pi 最低版本：协议层以 `parentToolCallId`（0.99.0）为准，M8 用到的 `getContextUsage`（≥0.49）和 `thinking_level_select`（≥0.71）都更早；但 v0.1.7 的 README 与全部实机验收都基于 **pi 1.5.0 或更新**（M14 的全屏默认、`tui.stop({preserveScreen})`、M12/M19 的 `setWidget` placement 与 overlay 选项都是在 1.5.0 上验证的；仓库没有记录这些 TUI 选项各自从哪个 pi 版本开始提供，移植到别的宿主时按 §1.2 逐项核对）。
