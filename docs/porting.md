# pi-roost 移植说明（基于 v0.1.19：main `9e4320b` 加发布提交）

> 目标读者：要在**公司内部 agent**（下文称"宿主 agent"）里重建 pi-roost 的工程师。
> 用法：对照源码 `git checkout v0.1.19`（发布提交；代码与 M60 合入的 main `9e4320b` 相同）逐节实现，每节末尾有验收标准。
> **v0.1.19（本文依据）= v0.1.18 之上再加 M59–M60；v0.1.18 = v0.1.17 之上再加 M57–M58；v0.1.17 = v0.1.16 之上再加 M54–M56 + M61；v0.1.16 = v0.1.15 之上再加 M50–M53；v0.1.15 = v0.1.14 之上再加 M49（加固）；v0.1.14 = v0.1.12 之上再加 M43–M48；v0.1.12 = v0.1.7 之上再加 M21–M42**，概括见本段末尾；下面这一段是 v0.1.7 时的范围，保留不动。
> v0.1.7（`0d16cd4`）包含 M1–M20（计划文档 `docs/plans/m15-polish.md`，见 Step 14）：M8 模型/上下文、M9 agent 间通信、M10 worktree 隔离、M11 pi-mobile、M12/M12b 子 agent 面板、M13 子 agent 生命周期、M14 attach 如 resume、M15 打磨（`.worktreeinclude`、`list`、`cleanupDays`、host 回应终端查询）、M16 PR 状态、M17 任务输入框、M18 agent 预设、M19 子 agent 记录视图、M20 shell 环境。M11 之后的各步都是可选增强，核心（Step 1–8）不依赖它们。
>
> **v0.1.8–v0.1.12 新增**（详见 Step 20–40，附录 C 有提交号）：
> - v0.1.8：修 CLI 误引 pi-tui 的回归，并加了守边界的测试；v0.1.9：M21 attach 从 host 的屏幕开始（回放，取代 M14 的重绘）；v0.1.10：M22 多窗口/频繁切换（不再冻结、行保持真实）。
> - v0.1.11 = 把 agent view 做成"多 agent 中枢"的 hub 路线：M23 `/resume` 与选模型、M24 用量/花费、M25 多选批量、M26 fan-out + `/compare`、M27 启动预设。
> - v0.1.12 = any-agent 路线 + 度量 + 续跑：M28 steer/follow-up；M29 中性内核（`ROOST_*` 名字）、M30 agent 档案（终端 agent 零代码接入）、M31 agent 协议（TS/Python 客户端）、M32 按层分目录（`adapters/pi/`、包导出）、M33 独立 hub（`pi-roost hub`）；M34 telemetry、M35 压测、M36 请求 ID、M37/M41 真模型 evals；M38 中断续跑（`autoResume`）、M39 定时任务（`/schedule`）、M40 全 agent 续跑与定时；M42 一个压测用例的修复（只改测试）。
> - v0.1.13：只有文档（本文同步到 v0.1.12，`docs/` 进发布包）。
> - **v0.1.14 = hub 作为控制平面（`docs/plans/hub-control-plane.md`，M43–M47）+ peek 加深（M48）**，详见 Step 41–46：M43 事件流/watch/消息规则；M44 值班 agent（hub 自己的 agent，daemon 用摘要唤醒）；M45 升级与策略（建议答案、常规代答、撤回、act）；M46 常备指令；M48 peek 加深（更多信息、编辑器回复框、`/` 命令、补全）；M47 共享任务板（会话认领的锁、依赖、值班 agent 当组长）。
> - **v0.1.15 = M49 加固**（`docs/plans/m49-hardening.md`，Step 47）：压测加任务板场景；对抗性审查后修的三件事——hub 专属 op 拒绝已表明是会话的连接、socket 的上限（单行 4 MiB、连接数、在途请求、未读积压）、标题/指令/名字一律单行（防伪造摘要行）。
> - **v0.1.16 = M50–M53**，详见 Step 48–51：M50 协议 agent 也收消息（`send`、`peers`、watch、任务板交办都能到达，客户端 `onMessage`/`on_message`）；M51 hub、CLI、子 agent 面板、`/bg`、手机都带请求 ID，应答丢失时同 ID 重发、只执行一次（`requestOnce`）；M52 任务板按项目（git 仓库）分，依赖完成或丢弃时通知等它的会话；M53 进入会话能看到全部记录：最近一次压缩之前的消息在滚到顶时分批加载。
> - **v0.1.17 = M54–M56 + M61**（ADE 路线 `docs/plans/ade-roadmap.md`，PR #82 的设计文档），详见 Step 52–55：M54 任务的工作区作为数据（`workspace` 字段、阶段 `stage`、依赖"等合并"、`tasks.json` 版本 2）；M61 会话自己的斜杠命令进 peek（按用户要求提前做）；M55 `/tasks start` 给任务开 worktree 和会话、完成进 review、`/tasks merge` 在本地合进基线分支；M56 完成时跑仓库的 `verify` 命令，项目配置 `.roost/project.json` 与每条命令需人批准。合入顺序 M54、M61、M55、M56。
> - **v0.1.18 = M57–M58**（ADE 路线的界面部分，`docs/plans/m57-workspace-overlay.md`、`docs/plans/m58-review.md`），详见 Step 56–57：M57 工作区总览（`/workspaces`、`Ctrl+N`，任务按阶段排成流水线，选中的任务旁边显示它的 worktree 相对基线改了什么，按键都走 `/tasks <动作>`）加值班 agent 的 `hub_task_start`（`act on` 时可以替用户开任务）；M58 评审（在 hub 里看任务相对基线的 diff、在行上写评论、一次性连同退回发给会话；`pi-roost review` 在终端做同样的事）。合入顺序 M57、M58。
> - **v0.1.19 = M59–M60**（ADE 路线的收尾，`docs/plans/m59-shelve-cleanup.md`、`docs/plans/m60-exits.md`），详见 Step 58–59：M59 搁置（`/tasks shelve`：删干净的 worktree、留分支，`start` 再从分支建回来）、清理（`/tasks cleanup` 列出、`cleanup yes` 删除遗留的 worktree 与 verify 日志）、手工合并的识别、`/tasks` 成为每个 pi 会话的命令（手机经 pi-mobile 也能用）、值班 agent 开的会话由 daemon 按值班 agent 自己的 launch 重建；M60 可选出口（`/tasks pr`：推送展示过的那个提交、用 `gh` 开 PR）与重叠标记（改同一批文件的在做任务）。合入顺序 M59、M60；对抗性审查堵上了"会话借子会话首条消息 `/tasks merge` 自行合并"的漏洞。
> - **Step 20 起（M21 及之后）全部是可选增强**；核心 Step 1–8 不依赖它们。其中真正改变"移植怎么做"的是 M29/M31/M32：现在可以不写适配器代码，直接用档案（级别 0）或协议（级别 1）接入，见 §0 与 §1.3。

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
| 扩展（三种角色） | `adapters/pi/*.ts`（M32 前在 `extensions/`） | 每个宿主 agent 进程里加载一次 | **是**（适配层） |
| 公共库 | `lib/*.ts` | — | **否**（M32 把唯一依赖 pi 的 `lib/api.ts` 搬到了 `adapters/pi/api.ts`） |
| hub（视图，M33） | `hub/agent-view.ts` `task-editor.ts` `theme.ts` | 嵌在 pi 里，或 `pi-roost hub` 独立运行 | 只依赖 **pi-tui**（终端 UI 库），不依赖 agent API；pi 的部分经 `adapters/pi/hub-options.ts` 注入 |
| agent 客户端（M31） | `lib/agent-client.ts`（导出 `pi-roost/agent`）、`sdk/python/roost_agent.py` | 跑在 agent 进程里 | 否（TS 客户端只用 node；Python 只用标准库） |

**三级接入**（M29–M31，设计见 `docs/plans/any-agent.md`）：同一套 daemon/host/CLI 可以管三类 agent，按"接入成本"选一级：

| 级别 | 做法 | 你要写什么 | 得到什么 |
|---|---|---|---|
| 0 档案 | 用户 `roost.json` 的 `agentProfiles` 里写一个 argv 档案（M30），host 从终端的 OSC/BEL/屏幕静止推状态，回复**打字**进终端 | **零代码** | 行、attach/detach、stop、删除、worktree、fan-out、预设、批量；降级：模型/上下文/用量/记录视图/子 agent |
| 1 roost agent 协议 | agent 进程里跑一个协议客户端（TS `pi-roost/agent` 或 Python 单文件），自己 `hello`/`report`，接收 `deliver` 并 `ack`（M31，`docs/protocol.md`） | 几十行 | 上面全部 + agent 自己报的状态/问题/模型/用量，回复经 pending/ack 可靠投递，崩溃续跑（M40） |
| 2 深度集成 | `adapters/pi/` 那一套：前台转后台、子 agent 面板、peer 工具、摘要、记录视图、attach 信号 | 本文 Step 1–19 的适配层 | 全部 |

把 pi-roost 移植到新宿主时，**先用级别 0 验证宿主能在 PTY 里跑起来，再决定要不要做级别 1/2**；下文 Step 1–19 讲的是级别 2。

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

从 `adapters/pi/` 统计的**完整** pi API 使用面：

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
| `pi.events.on(channel, fn)`（返回取消函数） | M11：监听 pi-mobile 的 `pi-mobile:starters`、`pi-mobile:activity`（`adapters/pi/mobile.ts`）；`pi.events` 可能不存在（测试宿主），要判空 | 无 pi-mobile 时不需要 |
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
| M53：`tui.layoutRoot`（全屏时的布局根）→ primary `ScrollView`（`scrollTop` `viewportHeight` `children[0]` 即文档容器，内部字段 `currentScrollTop`）；pi 导出的 `sessionEntryToContextMessages` `getMarkdownTheme` `parseSkillBlock`、消息组件（`UserMessageComponent` `AssistantMessageComponent` `ToolExecutionComponent` `BashExecutionComponent` `CustomMessageComponent` `CompactionSummaryMessageComponent` `BranchSummaryMessageComponent` `SkillInvocationMessageComponent`）、内置工具定义（`createReadToolDefinition` 等，带渲染器）；`pi.getSettings()`、`ctx.ui.getToolsExpanded()`；事件 `session_compact` `session_tree` | 在聊天区上方补上压缩前的记录（Step 51）；走的是布局树而不是正式接口 | 可选；宿主若有"在聊天区前插入内容/滚动位置"的接口就用接口 |
| `ctx.hasUI`、`ctx.cwd` | 无界面的会话（headless、scratch）不连 daemon、不装 widget | 必需判空 |
| `ctx.ui.onTerminalInput(fn)`（可 `consume`） | 空提示符按 ← 、Ctrl+Z/Ctrl+D 拦截 | 可降级为命令 |
| `ctx.ui.getEditorText/setEditorText/notify/setStatus/setWidget/setTitle/select` | UI 小件 | 可选 |
| `ctx.model` / `ctx.modelRegistry.find/getAvailable` | 摘要模型调用、/model 列表 | 摘要功能需要 |
| `ctx.getContextUsage()` | M8：上下文窗口占用（tokens / window / percent） | 可选，缺失时不显示 |
| `pi-tui`：`matchesKey` `Key` `isKeyRelease` `Input` `parseKey` `truncateToWidth` `visibleWidth` `Text` | agent view 渲染与按键 | 自带 TUI 时替换 |
| `pi-tui`：`Editor` + `EditorTheme`（M17，`task-editor.ts`）、`decodeKittyPrintable`、`wrapTextWithAnsi`（M19）、`Component` `TUI` 类型 | 任务输入框用宿主自己的多行编辑器（Shift+Enter 换行、长粘贴折叠）；记录视图的换行 | 可降级为单行 `Input` |

> **评估结论模板**（级别 2）：C1–C4 + 6 个 ★ 事件 + `sendUserMessage` 两种投递方式 + `isIdle/abort/shutdown` 齐了 → 可以做出"后台会话 + 状态上报 + 回复 + attach"（对应 M1–M4）。有 `switchSession` → 能做"聊到一半转后台"。有 `ui.custom` + 可停启的 TUI → 能做内嵌 agent view，否则用独立 CLI/TUI 程序（daemon 协议完全够用）。

### 1.3 按接入级别需要什么（M29–M33）

上面 §1.1/§1.2 是**级别 2**（深度集成）的前提。级别 0/1 对宿主的要求低得多：

| 级别 | 宿主 agent 必须具备 | 不需要 |
|---|---|---|
| 0 档案（M30） | 一条 argv 就能启动它，且能在 PTY 里跑（C1）；首条任务能放进 argv（`task: "argv"`）或能在它安静后打字进去（`"type"`）；可选：`--model` 之类的 argv、`resume` 的 argv。状态由 host 从**终端**推：OSC 0/2 标题、OSC 9/777 通知、BEL、OSC 133 提示符标记、备用屏、屏幕静止（`settleMs`），再加档案里自己写的 `working`/`waiting` 正则 | 任何扩展 API、会话文件、写锁（档案 job 是 shell 类 job：没有 worker、没有 `sessionFile`） |
| 1 协议（M31） | 能在 agent 进程里跑协议客户端：从环境读 `ROOST_JOB_ID` / `ROOST_JOB_TOKEN` / `ROOST_SOCKET`（旧名 `PI_JOB_ID` `PI_JOB_TOKEN` `PI_DAEMON_SOCK` 仍认），连 unix socket，先 `hello`（协议版本、名字、capabilities），之后发完整快照 `report`，收 `deliver` 事件、处理完 `ack`。档案里写 `"protocol": true` 让 roost 把身份环境变量给它 | pi 的 API、PTY 重绘信号；agent 用什么语言都行（TS/Python 客户端只用标准库/node） |
| 2 深度集成 | §1.1 + §1.2 全部 | — |

级别 2 在 v0.1.12 里额外用到、§1.2 表里没有的 pi 接口（hub 路线 M23/M24/M28/M33）：

| 接口 | 用在哪 | 重要度 |
|---|---|---|
| `SessionSelectorComponent`（pi-coding-agent 导出）+ `SessionManager.list(cwd, dir, onProgress, signal)` / `SessionManager.listAll(...)` | M23：hub 里的 `/resume`，pi 自己的会话选择器（搜索、本目录/全部、排序、只看已命名），`adapters/pi/hub-options.ts` | 可降级为 hub 自己的列表（源码里有这个回退） |
| 模型列表：嵌在 pi 里用 `ctx.modelRegistry`，独立运行用 `pi --list-models`（`adapters/pi/hub-main.ts` `parseModelList`）；`enabledModels` 决定 Ctrl+P 循环哪些 | M23：Ctrl+L 选模型、Ctrl+P/Shift+Ctrl+P 循环、Shift+Tab 切 thinking | 可选 |
| `ctx.sessionManager.getEntries()` + `ctx.modelRegistry.isUsingOAuth/getProvider(...).auth.oauth.isSubscription` | M24：按 pi footer 的口径数花费（`lib/usage.ts` `sessionUsage`，口径对齐 pi 的 `getUsageCostBreakdown`，代码是自己重写的，不 import）；订阅用量标 `sub`（`adapters/pi/worker.ts`） | 可选 |
| `pi.sendUserMessage(text, { deliverAs: "steer" \| "followUp", expandPromptTemplates: true })` | M28：回复的 `mode`；steer = 当前工具调用结束后并入同一轮，followUp = 等本轮做完（`adapters/pi/worker.ts`） | 缺 steer 时全部当 followUp |
| `TuiAltScreen` + `ProcessTerminal`（pi-tui） | M33：独立 hub 画备用屏，和 pi 的全屏模式画法一致（`adapters/pi/hub-main.ts` `runHub`） | 独立 hub 需要 |
| `initTheme` / `SettingsManager`（pi-coding-agent） | M33：让 pi 的组件（`/resume` 选择器）在独立 hub 里用 pi 的主题 | 可选 |

> pi 的包是 pi 的、不是 roost 的：它们是 peer 依赖，pi 装 roost 时不会装进 roost 的目录。核心（CLI/daemon/host）必须能在纯 node 下跑；独立 hub 运行时才去找用户的 pi 包（见 Step 32）。

---

## 2. 适配层与分层（M29/M32 已落地；移植时仍建议先抽接口）

**现状（v0.1.19；分层自 v0.1.12 的 M32 起未再变，M43–M58 与 M61 的新代码都落在既有的层里：`lib/events.ts` `lib/concierge.ts` `lib/board.ts` 与 M51 的 `requestOnce`（`lib/client.ts`）在 core，`adapters/pi/concierge.ts` 与 M53 的 `adapters/pi/earlier-history.ts` 在适配层，`/log` `/concierge` `/tasks` 在 `hub/`；v0.1.17 的 M54–M56 把 git 步骤放在 core 的 `lib/task-git.ts`、项目配置与批准放在 `lib/project-config.ts`、M61 的 pi 内建命令清单放在 `lib/pi-commands.ts`，task 的新动作在 `daemon/main.ts`；适配层只改 `adapters/pi/worker.ts`（写 `commands.json`、任务 worktree 的提示）、`agent-tools.ts`（`roost_task_done` 进 review 的回话）与 `hub-options.ts`（`taskMerge`、档案命令）；`/tasks start|merge|…` 和 peek 的命令菜单在 `hub/agent-view.ts`；host 多一个 control op `command`；v0.1.18 的 M57–M58 同样：core 新增纯函数 `lib/workspace-view.ts`（总览的分组、图标、按键、详情行）、`lib/task-diff.ts`（取 diff 并解析）、`lib/review.ts`（评论落在哪、终端文本），`lib/task-git.ts` 多了 `taskChanges`，`lib/board.ts` 多了 `reviewText`/`taskPrompt`；daemon 多了 `task` 的 `comment`/`uncomment`，并让值班 agent 可以 `start`；适配层只改 `adapters/pi/concierge.ts`（`hub_task_start`）；`/workspaces` 总览与评审界面在 `hub/agent-view.ts`；CLI `review` 在 `bin/pi-roost.ts`；v0.1.19 的 M59–M60 同样：适配层新增 `adapters/pi/tasks-command.ts`（pi 会话里的 `/tasks` 命令，经 `adapters/pi/index.ts` 注册）与 `adapters/pi/task-start.ts`（从 pi 进程建/恢复任务 worktree 并构造 launch，值班 agent 的 `hub_task_start` 与 `/tasks start` 共用，从 `adapters/pi/concierge.ts` 抽出）；core 的 `lib/task-git.ts` 多了 `removeTaskWorktree` `restoreTaskWorktree` `taskWorktrees` `prTarget` `ghRepoOf` `openTaskPr`，`lib/board.ts` 多了 `workspace.reviewTip` 与 `workspace.pr`，`lib/workspace-view.ts` 多了 `overlaps`；daemon 的 `shelve` `pr` `cleanup`、`settleHandMerges`、`firstMessage`、`conciergeLaunch` 在 `daemon/main.ts`；`h`（搁置）`o`（PR）键与重叠标记在 `hub/agent-view.ts`）**：M29 把名字和数据中性化，M32 把"层"变成真实的目录，并用 `test/cli-deps.test.ts` 守住边界：

| 层 | 目录 | 允许 import | 守护 |
|---|---|---|---|
| 核心 | `lib/` `daemon/` `host/` `bin/` | node、roost 自己的运行时依赖（`node-pty`、`@xterm/*`） | `cli-deps.test.ts`：不得 import `@earendil-works/*`，也不得 import `adapters/`；CLI/daemon/host 的整个 import 图只含 node 与白名单依赖 |
| agent 客户端 | `lib/agent-client.ts`（`pi-roost/agent`）、`sdk/python/roost_agent.py` | 只有 node（TS）/标准库（Python） | 测试：TS 客户端的 import 图连 roost 的运行时依赖都不含 |
| pi 适配器 | `adapters/pi/`（M32 前叫 `extensions/`；`lib/api.ts` 搬来成了 `adapters/pi/api.ts`） | 核心 + pi 的包 | 全仓库只有这里 import `pi-coding-agent` |
| hub | `hub/agent-view.ts` `task-editor.ts` `theme.ts`（M33 从 `adapters/pi/` 搬出） | 核心 + **pi-tui**，其余 pi 包与 `adapters/` 都不行 | `cli-deps.test.ts` 逐文件检查；颜色经 `HubTheme`（`fg`、`bold`）注入，pi 自己的主题满足这个接口 |
| 胶水 | `adapters/pi/hub-options.ts`（`piHubOptions`）、`open-view.ts`（嵌在 pi 里）、`hub-main.ts`（独立运行，`runHub`） | 核心 + pi | hub 需要的 pi 能力（启动/续跑 pi 作业、`/resume` 选择器、设置、预设、agents、profiles）都经 `PiHost`（cwd、argv、模型列表、当前会话）注入 |

- **包导出**（`package.json` `exports`）：`pi-roost/api`（pi 扩展用的 `spawn/list/attach`，指向 `dist/adapters/pi/api`）、`pi-roost/agent`（协议客户端）、`pi-roost/client`（`DaemonClient`，给 hub、脚本等控制端用）、`pi-roost/protocol`（op 与事件的类型）。pi 自己按 `pi.extensions` 加载 `./adapters/pi/index.ts`。
- **`extensions/index.ts` 转发 shim**：M32 之前派发的 job 把 `-e …/extensions/index.ts` 存进了 `job.json` 的命令，重启时还会加载这个路径。所以 shim 保留，只做 `register(pi, "extensions")`；`test/cli-deps.test.ts` 断言 `extensions/` 里只有 `index.ts`、且它只 import `../adapters/pi/index.ts`。
- **只注册一次的守卫**：一个 pi 进程可能同时用两条路径加载同一个扩展（pi 只按路径去重）。`adapters/pi/index.ts` 的 `register(pi, via)` 用 `Symbol.for("pi-roost.loaded-by")` 挂在 `globalThis` 上：已被另一条路径加载就直接返回；同一路径再次加载（测试）照常重新注册。
- **搬迁时的保守做法**：状态目录（`~/.pi/agent/roost`）和运行时目录（`/tmp/pi-roost-<uid>`）**不动**，这样已在运行的 daemon 与 host 仍能互相找到；新配置路径与环境变量名只是"多认一个"，见 §3。

**下面的 `HostAgentAdapter` 接口草案保留作参考**：源码里并没有这个类型（适配器直接调 pi API），但移植时先把宿主差异收进一个接口，能让 `adapters/<宿主>/` 的改动集中。M29 之后，新的"宿主差异"如果只是一个终端 agent，根本不用写适配器——走级别 0 档案；能说 socket 的 agent 走级别 1 协议。

源码里扩展直接调 pi API。移植时建议先定义一个**宿主适配接口**，把 `adapters/pi/` 改写成依赖它，宿主换了只重写适配器：

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

以下文件**不 import 任何 pi 包**（M32 起有测试守着），只需改命名（`pi-roost` → 公司名、`PI_*` 环境变量前缀、`~/.pi/agent` 路径；M29 起多数名字已有中性版本 `ROOST_*`，见下表）。**v0.1.12 的 `lib/` 全部文件按用途分组如下**；其中标 † 的虽不 import pi 的包，但**假定 pi 的数据格式**（会话 JSONL、`pi-subagents` 定义），移植时要按宿主格式改：

```
基础          atomic.ts ids.ts proc.ts paths.ts identity.ts(M29) framing.ts locks.ts version.ts text-width.ts
协议与存储    protocol.ts store.ts
客户端        client.ts(DaemonClient) hostclient.ts attach.ts resume.ts
              agent-client.ts(M31，Reporter/RoostAgent，=pi-roost/agent)
派发与配置    dispatch.ts dispatch-input.ts config.ts profiles.ts(M30) workspace-env.ts(M20)
              worktree.ts schedule.ts(M39) agents.ts†(M18，读 pi-subagents 定义)
状态与展示    heuristics.ts worker-state.ts summarizer.ts† filter.ts view-model.ts list-format.ts
              job-events.ts comms.ts pr.ts transcript.ts†(M19) usage.ts†(M24，pi 会话口径)
终端          term-modes.ts(M21，模式跟踪/StreamTail) term-signals.ts(M30，OSC/BEL/屏幕静止→状态)
观测          telemetry.ts(M34)
定位 pi       pi-resolve.ts(M33，仅 node；找 pi 的包并注册解析钩子，只有独立 hub 用)
daemon/main.ts   host/main.ts   bin/pi-roost.ts
```

另有两处不在 `lib/` 但同样可复用：`stress/`（M35 压测，只用协议客户端与假 agent）、`sdk/python/roost_agent.py`（M31，单文件、纯标准库）。**必须按宿主重写的是 `adapters/pi/` 与（若不想依赖 pi-tui）`hub/`**。

**需要改的点**（全局搜索替换即可）：

| 位置 | 改什么 |
|---|---|
| `lib/paths.ts` `roostHome()` | `~/.pi/agent/roost` → 你的数据目录（M29：`ROOST_HOME` 优先于 `PI_ROOST_HOME`，经 `lib/identity.ts` 的 `roostEnv()` 读取） |
| `lib/paths.ts` `runtimeDir()` | `/tmp/pi-roost-<uid>`（或 `$XDG_RUNTIME_DIR/pi-roost`）→ 你的名字（注意 **unix socket 路径长度上限 ~104 字节**，别放太深）；`ROOST_RUNTIME_DIR` 优先于 `PI_ROOST_RUNTIME_DIR` |
| `lib/config.ts` `userConfigPath()` / `projectConfigPath(cwd)` | M29：用户级 `ROOST_CONFIG_DIR/roost.json`（或 `PI_ROOST_CONFIG_DIR`）；否则 `~/.config/roost/roost.json`（遵循绝对的 `XDG_CONFIG_HOME`）**存在即用**，否则 `~/.pi/agent/roost.json`——只读**其中一个**，不合并，也不搬文件。项目级 `<cwd>/.roost/roost.json` 存在即用，否则 `<cwd>/.pi/roost.json` |
| 环境变量（job 身份，`lib/identity.ts` `JOB_ENV`） | 新名 `ROOST_JOB_ID` `ROOST_JOB_TOKEN` `ROOST_SOCKET` `ROOST_JOB_DIR`；旧名 `PI_JOB_ID` `PI_JOB_TOKEN` `PI_DAEMON_SOCK` `PI_JOB_DIR` **永久并存**：host 两套都设（`jobEnv()`），worker 先读新名（`readJobEnv()`），所以旧 host 起的 worker 仍能找到 job。`JOB_ENV_NAMES`（含 `PI_ROOST_RESTORE`）是"job 永不继承"的名单，daemon 起子进程前要剔除 |
| 其他环境变量 | `PI_ROOST_RESTORE` `PI_ROOST_CHILD` 及 `PI_ROOST_*` 调试变量；`roostEnv(name)` 的规则是 `ROOST_<name>` 优先、`PI_ROOST_<name>` 次之 |
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

worker 判定：扩展加载时看到 `PI_JOB_ID + PI_JOB_TOKEN + PI_DAEMON_SOCK`（M29 起也认新名 `ROOST_JOB_ID + ROOST_JOB_TOKEN + ROOST_SOCKET`，新名优先，见 `lib/identity.ts`）就是 worker（`adapters/pi/worker.ts` `jobIdentity()`），否则是前台。**读完立刻从 `process.env` 删掉 token**（M9 加的），避免 agent 跑的子进程继承。

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

2. **Reporter**（`adapters/pi/worker.ts`）：每次发**完整快照** `WorkerReport`；一次只有一个请求在途；状态变化立即发，仅文本变化最多 15 秒一次；断线 500ms 起退避重连；关闭时 500ms 最终 flush。
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

流程（`adapters/pi/foreground.ts`）：

1. 触发：空提示符 ←（经 `onTerminalInput`，过滤 key release）/ `/bg` / `/background` / 正在跑时 Ctrl+D、`/quit`、`/exit` 的确认框。
2. 若在跑：提示"当前工具结束后转后台"，最多等 10 秒（再按 ← 跳过）→ `abort()` → `waitForIdle()` → 首条提示设为 "Continue where you left off."。
3. **关键交接（C4）**：`ctx.switchSession(scratch)` —— 当前进程切到 `scratch/` 下的一次性会话，原会话的 `session_shutdown` 释放写锁 → 在 `withSession` 回调里 `dispatch(origin:"adopt", sessionFile: 原文件)` → 打开 agent view 并高亮它 → 再切到一个**新的空会话**（不能留在 scratch 目录）。
4. 失败就切回原会话。会话从未写过盘（还没有第一条回复）时拒绝转移。
5. `/bg-fork <prompt>`：复制当前会话文件，`origin:"fork"` 在后台执行 prompt，前台不动。

> 宿主没有 `switchSession` 时的降级：让用户退出前台进程（释放写锁）后再由 CLI 派发 `adopt`，体验差但可用。

### Step 6：agent view（M6a/M6b）

- 纯数据层 `lib/view-model.ts`（分组 Pinned / Needs input / Working / Completed，或按目录；图标、时长、排序）、`lib/filter.ts`（`s:` `n:` `o:` 过滤）、`lib/dispatch-input.ts`（解析 `task` / `@dir task` / `! cmd` / `/model` `/thinking` `/resume`）——**全部可直接复用**。
- 渲染层 `adapters/pi/agent-view.ts`（1200 行，pi-tui 组件）是**移植工作量最大的部分**。（**M33 已把它搬到 `hub/agent-view.ts`**，现在 2500+ 行，只依赖 pi-tui；pi 相关能力经 `adapters/pi/hub-options.ts` 注入，见 Step 32。）daemon 侧只需要 `subscribe` 后监听 `job` / `removed` 事件，加上 `list pin rename reorder stop rm reply respawn`。
- 进入会话：`tui.stop()` → `attachToHost()` → 返回后重置终端模式 → `tui.start()` + 强制重绘（Step 0 的 R2）。
- 如果宿主 TUI 不好扩展，**完全可以把 agent view 做成独立程序**（比如 `roost` CLI 的一个子命令），协议不变。
- 通知（`lib/job-events.ts`）：OSC 9 / OSC 777 / BEL，终端标题显示等待数；同时在宿主事件总线上发 `agents:job_needs_input` / `agents:job_completed`。

### Step 7：摘要模型与空闲回收（M7 等）

- **摘要**（`adapters/pi/worker-extras.ts` + `lib/summarizer.ts`，提示词可直接复用）：每轮结束一次、轮开始 45 秒后一次、之后每 5 分钟一次；自动命名一次；attach 时生成"离开期间"回顾。**关闭 thinking、`maxTokens:1024`、超时 20 秒、只回 JSON**；只发会话末尾约 6000 字符；失败静默回退到启发式文本。公司部署时细节见 `docs/summary-model.md`（中文，含内部 LLM 节点与环境变量白名单的坑）。
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

主要文件：`adapters/pi/mobile.ts`，`daemon/main.ts` `reapable`/`acceptReport`，`lib/protocol.ts` `WorkerReport.remoteAt`。

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

主要文件：`adapters/pi/subagent-panel.ts`（`renderPanel`、`onInput`、`watch`、`stopOrHide`、`openComposer`、`stopAll`），`adapters/pi/peer-link.ts`（`hasChildren`）。

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

主要文件：`daemon/main.ts`（`parentOpen`、`pushChildrenOf`、`scheduleAutoClose`、`closable`、`autoClose`），`lib/view-model.ts`，`adapters/pi/subagent-panel.ts`。

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

主要文件：`adapters/pi/worker-extras.ts`（`registerAttachRepaint`、`attachRepaintReady`），`host/main.ts`（`holdUntilRepaint`、`nudge`），`lib/attach.ts`。

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

- **关联**（worker，`adapters/pi/pr-links.ts`）：监听 `tool_execution_start/end` 的 `bash` 调用（也看 codemode 内嵌的 bash）。`gh pr create/reopen/review/edit/comment/close/ready` 的输出里出现 PR URL 就记下；`gh pr checkout` 或 push 之后，在之后最多 `LOOKUP_RETRIES`（5）条 git/gh/glab/curl 命令内用 `gh pr view` 查当前分支。报告字段 `prLinks`（URL，最多 20）。worktree 会话的分支还由 daemon 自己查（`gh pr list --head <branch>`，无链接时最多每 10 分钟一次）。
- **状态**（daemon）：`state.json.prLinks` 取并集（≤20）；每 `PI_ROOST_PR_POLL_MS`（60 s）一轮，对**最近 7 天有活动或活着**的会话逐个 `gh pr view <url> --json number,url,state,isDraft,reviewDecision,statusCheckRollup,title`（一次一个）；结果存 `state.prs`，推给 `JobRow.prs`。merged/closed 的每 URL 每小时问一次。
- **显示**（`lib/pr.ts`、`lib/view-model.ts`）：行右缘 `#N`，OSC 8 超链接（`FORCE_HYPERLINK=0` 关）；颜色 warning（等检查/评审或检查失败）/ success / accent（已合并）/ dim（draft 或关闭）；多个 PR 显示 `3 PRs`，按最需要关注的上色，偷看里列出。新分组 **Ready for review**（Pinned 与 Needs input 之间）：不在工作也不在等待、PR 打开且非 draft、检查失败或未批准。空组不显示标题。`s:ready` 过滤；输入 `#N` 或 PR URL 时若有行含它就当过滤，否则当任务派发。
- 坑：一轮轮询最长一分钟（`PR_POLL_BUDGET_MS`），下一轮从上次停处续；每次 gh 调用后重新读 state，**轮询只写自己的字段**；`#N` 按编号匹配，URL 按 host/owner/repo/number 匹配（不管 scheme、大小写、尾部路径 `/files`、`#discussion…`）；`localhost`、裸 IP、`.local`/`.internal` 的链接忽略；被取消的 check run 不算失败。`gh` 路径可用 `PI_ROOST_GH` 覆盖（测试用）。
- 限制：分支查询在会话 cwd 里进行；codemode 内嵌的 `bash` 能看到，其他 shell 类工具看不到；GitLab `!N`（glab）未移植。

**验收**：会话里 `gh pr create` 后，行上出现带链接的 `#N`；检查失败时颜色变 warning 且会话进入 Ready for review 组；`s:ready` 只显示该组；输入 `#N` 选中对应会话；`gh` 不在 PATH 时一切照常只是没有标签（用 `PI_ROOST_GH` 指向假脚本可离线验证）。

### Step 16：任务输入框用宿主的编辑器（M17，`docs/plans/m17-editor-input.md`）

解决：agent view 的单行 `Input` 没有多行、没有长粘贴折叠。`task-editor.ts`（M33 起在 `hub/`）包装 pi-tui 的 `Editor`（宿主提示符编辑器的基类），只暴露视图原来从 `Input` 用到的小接口：`getValue`（展开粘贴标记）、`setValue`、`focused`、`handleInput`、`render`，外加 `multiline()`、`atEdge()`。

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

主要文件：`adapters/pi/transcript-view.ts`（`TranscriptView`），`lib/transcript.ts`，`adapters/pi/subagent-panel.ts`（入口）。

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

主要文件：`host/main.ts`（`snapshot`、`replay`），`lib/term-modes.ts`，`adapters/pi/worker-extras.ts`。运行时依赖新增 `@xterm/addon-serialize`（与 `@xterm/headless` 6.0 配套的 0.14）。

**验收**：无人 attach 时启动的全屏 pi worker，`pi-roost attach` 后 0.4 s 内画面完整（对话、编辑框、底栏）；改尺寸、打字、detach、再 attach 都即时，草稿还在；host 日志里没有 repaint 和 nudge。单测：安静的程序不靠信号也能立刻拿到画面；WINCH 重绘排在快照之后；备用屏、鼠标、SGR 鼠标、kitty 标志、隐藏光标完整还原；旧 worker 的标记被剔除；抢占 attach 拿到同一屏幕。


> **Step 21–40 对应 M22–M42**（v0.1.10–v0.1.12）。Step 21 是对 Step 4/13/20 的"在多窗口下压力测试后的补丁"，Step 22–26 是 hub（agent view）的功能路线（只改 `hub/` 与少量 daemon 字段），Step 27–32 是 any-agent 路线（名字中性化 → 档案 → 协议 → 分层 → 独立 hub），Step 33–36 是度量（telemetry、压测、请求 ID、evals），Step 37–39 是续跑与定时，Step 40 只改测试。**全部是可选增强**，彼此依赖关系：Step 28（中性内核）→ 29（档案）→ 30（协议）；Step 31（分层）→ 32（独立 hub）；Step 33（telemetry）→ 34（压测）/ 36（evals）；Step 37（续跑）→ 38（定时）→ 39（全 agent 续跑）；其余互不依赖。

> **Step 41–46 对应 M43–M48**（v0.1.14，`docs/plans/hub-control-plane.md`）：Step 41（事件流）→ 42（值班 agent）→ 43（策略）→ 44（常备指令）→ 46（任务板）依次依赖；Step 45（peek 加深）只依赖 Step 21/22 的 hub，与其余无关。全部可选；没有值班 agent 时事件流和任务板仍可用（任务板的"组长"职责没人做，由用户在 hub 里 `assign`）。

### Step 21：多窗口与频繁切换（M22，`docs/plans/m22-multi-window.md`）

解决：在多个终端窗格（herdr、tmux）里各开一个 pi、在后台会话之间频繁切换时出现的三类现象：① 会话**冻结**——屏幕不动、按键无反应，agent view 却显示它在跑；② 行**陈旧**——"needs input" 在会话早已在别处继续后仍挂着，转到后台的会话一直显示 "starting…"；③ 模型列显示 `anthropic::claude…`，看不出是哪个模型。

根因与做法：

| 根因 | 做法 |
|---|---|
| **Ctrl+Z 漏进了后台的 pi。** 宿主的 Ctrl+Z 会停掉自己的 TUI、给**进程组**发 SIGTSTP、等 SIGCONT 再重启 TUI。worker 在 PTY 里是会话首进程，它的进程组是**孤儿进程组**，内核直接丢弃 SIGTSTP，TUI 于是永远停着，而 agent 循环照跑照报。原来客户端只在一个数据块**恰好**是 `\x1a` 或 `\x1b[122;5u` 时才当 detach 键：快速打字、复用器合并输入、或带锁定位（Num Lock 的 `\x1b[122;133u`）时 Ctrl+Z 夹在别的字节里就放过去了 | `lib/attach.ts` `localDetachAt(s, pasting)`：在数据块**任意位置**找 detach 键——传统 `0x1a`、kitty CSI-u（任意 alternate keys、Caps/Num Lock、带文本、按下或重复，**松开事件不算**）、modifyOtherKeys；括号粘贴内部不算（`pasting` 跨块携带）；返回位置，位置之前的字节仍照常送给会话。worker 里 Ctrl+Z 也走 detach（后台的 pi 永不挂起） |
| 已冻结的会话没人叫醒 | `host/main.ts` `continueWorker()`：**每次 attach 都给 worker 的进程组发 SIGCONT**（`process.kill(-pid)`，失败退回单进程），所以进入一个已被冻住的会话就把它救回来 |
| 被抢占的 attach 还在输入/改尺寸 | 被接管的 attach 不再往 PTY 写、不再 resize |
| 回收时竞态 | 新增 host 控制 op `terminate-idle`：回收器与自动关闭**不再先问 `attached.json` 再 terminate**，而是让 host 自己原子地判断"现在有没有人 attach"，有人就回 `{ok:false, attached:true}` |
| **宿主终端的"面板身份"被继承。** M20 起继承整份环境，`HERDR_ENV` `HERDR_SOCKET_PATH` `HERDR_PANE_ID` 随之进了后台 worker，该终端复用器的 pi 集成就把后台会话的状态报进了 hub 所在的那个面板 | `lib/workspace-env.ts` 的 `ENV_NEVER_PREFIX` 加 `HERDR_`。移植规则：**凡是标识"启动它的终端/面板"的环境变量都要进永不继承名单** |
| **一个会话多个 job。** 从另一个窗口的 pi 再次把同一会话转后台，新 job 旁边留着旧的已结束 job（`fix-login`、`fix-login (2)`），旧行保留最后状态含 "needs input"；在另一个 pi 窗口重新打开一个会话，它已结束的 job 仍显示要输入 | daemon：`supersedeOthers(id)`（新 job 接管同一会话上已结束 job 的**行位置、名字、置顶**，旧记录保留）；`continuedElsewhere(session)`（前台 pi 注册了这个会话时，把它已结束 job 的 "needs input" 或失败改成 done） |
| 首次上报前行不更新 | live job 的 worker pid 出现时就推一次 `job` 事件（以前只在上报时推，第一次上报前一直 "starting…"） |
| **推送丢失**：一个数据块里先来 `list` 回复、紧接着是一个事件；事件先被应用，随后 `await` 之后的代码用较旧的 list 把行整个替换了 | `DaemonClient.requestAt()` 返回回复在事件流里的位置，`position()` 取当前位置，视图把 list 回复**之后**到达的事件在其上重放；监听器抛错不再丢掉同一数据块里后面的事件；视图每 `RESYNC_MS`=15 s 对账一次 list；`ensureLive` 的 respawn 20 s 超时（`lib/resume.ts` `RESPAWN_TIMEOUT_MS`）；视图同一时刻只做一次 attach |
| Reporter 对挂掉的 daemon 狂重连（每秒数百次） | `lib/agent-client.ts` `Reporter`：请求失败后退避 500 ms 翻倍到 5 s（`retryMs`/`backoffUntil`），**状态变化也不例外** |
| 模型列太长 | `lib/view-model.ts` `shortModel()` 去掉 `vendor::`、Bedrock 前缀和 `-vN:M` 后缀；`fitTail()` 放不下时保留末尾 |

坑：这类问题**只在压力下才暴露**——所以 M22 同时加了压测（下节）。移植时若宿主的 Ctrl+Z 也是"挂起自己"，必须同样保证后台 worker 里它不会真的挂起。

测试：`test/stress-attach.test.ts`——60 轮（`STRESS=1` 时 600 轮）attach / 抢占 / 突然断开 / 改尺寸风暴 / 两个 attach 同时 / 不读数据的客户端，对着一个持续输出、回显、处理 SIGUSR2 的 worker；往一个永不读的客户端灌数据；detach/attach 连发；**一个 PTY 在两个会话之间用 Ctrl+Z 切换**（按键夹在别的字节里，40 轮/`STRESS=1` 300 轮）；一个像 pi 那样**自己挂起**的 worker 会被下一次 attach 的 SIGCONT 救回（没有 host 的 SIGCONT 时该用例失败）。另有 daemon 单测：行被接管、在别处继续、pid 先于上报推送；Reporter 退避；detach 键各编码；模型名；`HERDR_` 不被继承。

**验收**：在两个窗口里反复用 Ctrl+Z / ← 切换同一批会话，没有冻结；把会话在另一窗口转后台，旧行消失/并入新行而不是留着 "needs input"；`STRESS=1 npx vitest run test/stress-attach.test.ts` 通过。

### Step 22：hub 里的 `/resume` 与选模型（M23，`docs/plans/m23-resume-model.md`）

解决：让 agent view 像 `pi --resume` 一样打开任何历史会话，像在 pi 里一样给新会话选模型——这是"把 agent view 做成多 agent 中枢"的第一步。

- **`/resume`**：用 pi 自己导出的 `SessionSelectorComponent`（搜索、本目录/全部会话用 Tab 切换、排序、只看已命名），数据来自 `SessionManager.list(cwd, dir, onProgress, signal)` 与 `SessionManager.listAll(...)`（`adapters/pi/hub-options.ts`），以 `Overlay` 盖在列表上，按键交给它。选中后**立即打开**：已有行的会话直接 attach（已结束的先重启，且因为是在这里选的，不要求再按一次 Enter）；没有行的开一个新的后台 job 来接管它（`origin:"adopt"`，保留它自己的模型），worker 一跑起来就 attach；另一个 pi 正在写的会话提示"在另一个 pi 窗口打开"。它的删除键**绝不删除**有活 job 或别的 pi 正在写（`readWriterLock`）的会话。没有 pi 的选择器组件时回退到视图自己的列表（带行的会话标 "listed"）。
- **选模型**：选择器可搜索（输入的每个词、不分大小写，Esc 先清搜索）；配置了 `enabledModels` 就只显示它们，Tab 切到全部。**Ctrl+L**：新会话的模型（在偷看里则是该会话的模型）；**Ctrl+P / Shift+Ctrl+P**：下一个/上一个启用的模型（没有启用的就在全部里循环）；**Shift+Tab**：下一个 thinking 级别。标题下面那一行永远写明"新会话跑什么"：选中的模型，或默认值（`dispatchModel`，否则 hub 所在 pi 自己的模型）。
- 做法在 `hub/agent-view.ts`（按键与状态）与 `adapters/pi/hub-options.ts`（取会话列表、模型来自 `PiHost`）。

**验收**：单测覆盖选择器搜索与范围、循环、thinking、浮层按键、有行/无行的选择、回退、Esc；真 pi（隔离的 runtime）里 pi 的列表在 hub 里渲染、搜索与 Tab 可用、Esc 返回；选中一个会话打开后 Ctrl+Z 回到它的行。

### Step 23：用量与花费（M24，`docs/plans/m24-usage.md`）

解决：会话花了多少钱，在管理它们的地方就能看到。

- **worker 按 pi footer 的口径数**（`lib/usage.ts` `sessionUsage(entries, now, sub)`，输入是 `sessionManager.getEntries()`）：assistant 消息、usage 条目、工具结果、压缩、分支摘要，按 pi 的键归类（口径对齐 pi 的 `getUsageCostBreakdown`，代码是重写的）；还有"自本地午夜起"的部分（`localMidnight`）；按模型分的花费与 token，只留最大的 `USAGE_MODELS`=8 个，其余并入 `other`。订阅（OAuth 到 `isSubscription` 的 provider，或 kimi-coding）标 `sub`（名义价格）。
- 每次启动和每次回复后计算；随行文本的节奏上报（单独的用量变化要等摘要间隔）；daemon 用 `usageFrom()` 校验（不可信 JSON）后存起来，旧 worker 不发时保留上次的值（`WorkerReport.usage`、`JobRow.usage`）。
- **视图**：摘要有空间时每行一个花费列（比模型列、占比列更先让位）；标题 `· $x today · $y all`，覆盖视图里所有会话（含子 agent）；`/usage` 面板：总计、按模型（花费、token、会话数）、按会话（最多的在前，今日份额，`(sub)`）。在更早一天计过数的会话，今日份额为 0（`todayOf`）。
- 级别 0/1 的 agent 没有这些数据时显示破折号而不是 0（协议里 `usage` 是 capability 字段）。

**验收**：单测（求和、今日、按模型、畸形输入、总计、列、面板）；daemon 往返；真 pi：派发的任务行与标题都显示花费，daemon 重启后 worker 重连带回用量。

### Step 24：多选与批量操作（M25，`docs/plans/m25-batch.md`）

解决：一个动作作用于多个会话。

- **Ctrl+O** 标记当前行（第二列一个勾）并移到下一行，所以连按两次标两行；在分组标题上标记整组，再按取消。标记跟着行走，不跟光标；被删的行自动退出。
- 有标记时：输入文字 + Enter **发给每个被标记的会话**（作为回复，不是新任务；shell 任务跳过；提示里数"已发/已存待下次启动/未送达"）；`/model x`、`/thinking x` 全部切换（每个切换照常按 Step 7.5 的"以上报为准"检查），光输入 `/model` 则弹一次选择器；**其他视图命令在有标记时被拒绝**；Ctrl+X 全部停止，2 秒内再按删除（并取消标记）；Ctrl+T 全部置顶，已全部置顶则取消。
- 只作用于**屏幕上可见**的被标记行（折叠的组或过滤掉的行，标记保持不动）；偷看里的 Ctrl+X/Ctrl+T 作用于被偷看的那一行；有标记时 `!`、`@dir` 输入被拒绝并保留（否则会被当回复发出去）；批量发送期间输入框被清空，一个都没送达时还原。Esc 的层级：关闭偷看 → 清输入框 → 清标记 → 离开。页脚写明"几个已标记 + 批量键"。
- 实现在 `hub/agent-view.ts`（`markedRows()`、`sendToMarked()`），daemon 不变——批量就是对每个 id 各发一次现有 op。

**验收**：单测覆盖标记/下移、组标记、批量回复、shell 跳过、批量 model 与选择器、其他命令被拒、停止/删除、置顶、Esc 顺序、被删行；真 pi 手验。

### Step 25：一个任务、多个模型、对比（M26，`docs/plans/m26-fanout.md`）

解决：同一个任务用几个模型并排跑，比较它们各自做了什么，留一个。

- **`/fanout a/x b/y …`**（2–6 个模型；光输入 `/fanout` 弹选择器逐个增删、Esc 完成；`/fanout off` 取消）：**下一个任务**每个模型起一个会话，只生效一次，设置期间标题下一行会写明。每个会话命名 `任务 · 模型`，目录是 git 仓库时**强制**各自一个 worktree（它们的修改不能碰撞）；不在仓库里则共用目录并警告。thinking 与 agent 的选择对全部适用。
- 同一次 fan-out 的会话带同一个 `fanout` id（`DispatchArgs.fanout` → 记录 → `JobRow.fanout`），daemon 重启后保留。
- **`/compare`**（在 fan-out 的某一行上，或 Ctrl+O 标记的行）：每个会话一列——模型、状态、用时、花费与 token、它 worktree 里的改动（相对 base 的文件数/增删行，含未提交的，`lib/worktree.ts` `worktreeChange`）、最后一条回复。← → 选择，Enter 打开该会话，`k` 连按两次**保留它、删除其余**（干净的 worktree 一并删除，否则保留并说明）。
- 约束："保留一个"只在同一次 fan-out 内提供（标记了不同任务的行用 Ctrl+X）；置顶的会话永不被它删除；面板里的字母键在 kitty 编码下也要能用；回复里的转义序列与制表符绝不写到终端。

**验收**：单测（解析、一次性、命名、id 经 daemon 往返、面板布局、保留流程）；真 pi：在临时仓库里两个模型跑一个小任务（后来的 M41 eval 自动化了这个，见 Step 36）。

### Step 26：启动预设（M27，`docs/plans/m27-presets.md`）

解决：把常用的"模型+thinking+worktree+agent+目录+fan-out"存起来，在 hub 里一键套用。

- **预设**（`lib/config.ts` `Preset`/`presetFrom`）：`model` `thinking` `worktree`（布尔） `agent`（M18 的 agent 预设名） `dir`（相对 hub 目录，与 `@dir` 同） `fanout`（2–6 个模型），全可选；M30 又加了 `profile`。放在 `roost.json` 的 `presets`（名字 → 预设）：**用户文件与项目 `roost.json` 都能写，按名字合并，项目的优先**（`loadConfig` 里 `Object.assign(Object.create(null), user.presets, project.presets)`）；畸形条目跳过。
- **命令**：`/preset 名字` 整体应用于新会话（没写的字段回到默认，不残留上一个预设的东西）；光输入 `/preset` 弹选择器（每个预设显示它设了什么；`none` 清除）；`/preset off` 回默认；`/preset save 名字` 把当前新会话用的选择（模型、thinking、worktree、fan-out、正在用的预设的 agent 与目录）存进**用户**文件（`saveUserPreset`）；`/preset rm 名字` 从用户文件删。标题下一行写出正在用的预设；手输的 `@dir`/agent 仍压过预设的；预设里的 fan-out 同 `/fanout`，对下一个任务生效一次。
- **安全**：预设的目录在解析符号链接之后必须仍在 hub 目录之下（否则什么都不启动并说明原因——项目里的预设来自别人克隆的仓库）；`off` `save` `rm` 和继承来的对象键不能当预设名；解析不了的用户文件**绝不覆盖**；读回来会不对的选择（没有 provider 的模型）不保存；没有预设在用时 `/preset off` 什么都不改。

**验收**：单测（解析与合并、应用、保存、删除、选择器、dir 与 agent 进派发）；真 pi 手验。

### Step 27：steer 还是等待（M28，`docs/plans/m28-steer.md`）

解决：给一个**正在工作**的会话的回复，要么并入当前这轮，要么等它做完——用 pi 自己的两个键。

- 偷看里 **Enter = steer**（pi 工作时的 Enter：当前工具调用结束后并入同一轮），**Alt+Enter = followUp**（排在当前工作之后）；会话空闲时两者都是开始新一轮。有标记的行（Step 24）用同样两个键。
- 协议：`reply` op 加 `mode: "steer" | "followUp"`（`lib/protocol.ts` `ReplyMode`）；**缺省（旧客户端、CLI）按 followUp，与以前一致**。daemon 把 `mode` 和 pending 回复存在一起（`PendingReply.mode`），所以重连后重发仍然 steer；`deliver` 事件带 `mode`；worker 交给宿主时 `pi.sendUserMessage(text, { deliverAs: mode === "steer" ? "steer" : "followUp" })`（`adapters/pi/worker.ts`）。
- 提示写明哪种：`joins its current work` / `after its current work`（`hub/agent-view.ts` `sendReply`）。
- 级别 1 的 agent 用 capability `steer` 声明自己会处理它；没有时 steer 当作 followUp（`docs/protocol.md`）。级别 0 的档案 agent 不适用（回复就是打字进终端）。

**验收**：单测（reply 队列、daemon 往返与重发、视图按键）；真 pi：会话正在跑 `sleep 25` 时发的 steer 落在工具结果之后、**同一轮**里，一条最终回答同时回应了两个请求。

### Step 28：中性内核（M29，`docs/plans/m29-neutral-core.md`）

any-agent 路线的第一步（设计见 `docs/plans/any-agent.md`）：名字和数据不再假定 pi，**pi 用户看到的一切不变**。

- **job 身份的中性名字**：`ROOST_JOB_ID` `ROOST_JOB_TOKEN` `ROOST_SOCKET` `ROOST_JOB_DIR`，与旧名 `PI_JOB_ID` `PI_JOB_TOKEN` `PI_DAEMON_SOCK` `PI_JOB_DIR` **同时设置**；worker 先读新名（所以旧 host 起的 worker 仍能找到 job）。`lib/identity.ts` 是唯一清单：`JOB_ENV`、`jobEnv()`、`readJobEnv()`、`JOB_ENV_NAMES`（job 永不继承的名字，含 `PI_ROOST_RESTORE`）、`roostEnv(name)`。
- **roost 自己的设置**：`ROOST_HOME` / `ROOST_RUNTIME_DIR` / `ROOST_CONFIG_DIR` 优先于 `PI_ROOST_*`。配置文件：用户级 `~/.config/roost/roost.json`（遵循绝对的 `XDG_CONFIG_HOME`）存在即用，否则 `~/.pi/agent/roost.json`；项目级 `.roost/roost.json` 存在即用，否则 `.pi/roost.json`。**什么都不搬**；状态目录与运行时目录原地不动，正在跑的 daemon 与 host 仍能互相找到。
- 行里带 `profile`（`JobRow.profile`：现在是 `"pi"` 或 `"shell"`，M30 起可以是档案名）。
- `lib/api.ts` 里依赖 pi 的部分——当时是整个核心里唯一 import pi 包的文件——在 M32 搬进 `adapters/pi/api.ts`；`test/cli-deps.test.ts` 守住 `lib/` 不 import pi 的包。

注意（与设计文档的差异）：`any-agent.md` 设想把 `kind: "pi"|"shell"` 改成 `agent: string`；**实际的 `JobRow.kind` 仍是 `"pi" | "shell"`，另加 `profile` 字段**——档案 job 是 `kind:"shell"` + `profile`。移植时按代码为准。

**验收**：整套测试；真 pi：用新名字起的会话照常启动、上报、收回复；旧名字的 worker 与新 daemon 互通。

### Step 29：agent 档案——终端 agent 零代码接入（M30，级别 0，`docs/plans/m30-profiles.md`、`docs/profiles.md`）

解决：host 没有代码的终端 agent（别的 CLI agent）也能被 roost 管：行、attach/detach、stop、删除、worktree、预设、批量、回复。

**档案**（`lib/profiles.ts` `AgentProfile`，只能写在**用户**的 `roost.json` 的 `agentProfiles` 里——`USER_ONLY`；项目文件不能定义，因为档案是 roost 会运行的命令，克隆来的仓库不该能选一条）：

| 字段 | 含义 |
|---|---|
| `command` | argv 数组，**不是 shell 行**：不走 shell、不展开 `$VAR`、不 glob |
| `task` | 首条任务怎么给：`"argv"`（默认，加在最后）、`"type"`（agent 第一次安静后打字进去）、`"none"` |
| `model` / `thinking` | 选了值时追加的 argv（含 `{model}`/`{thinking}`）；不写就是"该 agent 不支持这个选择" |
| `resume` | 重开上一次会话的 argv；`null`/缺省 = 回复已结束的 job 时用 `command` 重新启动（带模型、不带首条任务）。带 `resume` 的档案在中断时会自动续跑（M40） |
| `working` / `waiting` | 对**整个屏幕**的正则（不分大小写、多行）；`working` 压过一切表示在工作，`waiting` 匹配到的那一行就是行的 question。校验：≤500 字符、必须能编译 |
| `submit` | 回复后打的键，默认 `"\r"`（≤16 字符） |
| `settleMs` | 屏幕静止多久算"安静"，默认 3000，整数 500–60000 |
| `env` | 额外环境变量，走 `envDenyList`；只取前 100 项，名字不合法或值含 `\0` 的条目被忽略（档案不会因此整体丢弃） |
| `protocol` | `true` = 它说 roost agent 协议（Step 30） |

模板规则：argv 里**恰好等于** `{model}` `{thinking}` `{task}` 的元素被整元素替换（值为空则该元素删除），**不做部分替换**；`command` 自己放了 `{task}`/`{model}` 就放在那里而不是追加到末尾（`profileCommand()`）。档案名 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$` 且不能是保留字 `pi shell off none`；有畸形字段（坏正则、`command` 是字符串）的档案整个丢弃。（`any-agent.md` 里写过的 `{session}` 占位符**代码里没有**，只有 `task/model/thinking`。）

**数据模型**：档案 job 是 `kind:"shell"` 且带 `profile`、`term`（`ProfileTerm`：`submit` `settleMs` `waiting` `working` `typeTask`）、`resumeCommand` 的 job——没有 worker、没有会话文件、没有写锁，和 shell job 一样；区别：可以有 worktree，**结束后行保留**（照 `cleanupDays` 清理），**接受回复**，且不会因为空闲被回收（会话活在它自己的进程里）。

**状态怎么来**（`lib/term-signals.ts`）：
1. host 里 `TermSignalCollector` 挂在 xterm 镜像上收集：OSC 0/2 标题、OSC 9 / OSC 777 通知（文本 + 时间）、BEL、OSC 133 标记（A/B→idle，C→busy，D→idle）、是否在备用屏、屏幕文本上次变化的时间 `changedAt`（对屏幕内容取哈希）。host 每秒（有变化时）把它们原子写进 **`term.json`**，同时把屏幕写进 `screen.txt`。
2. daemon 在 `profileTick()` 里读这两个文件，调用 `inferTermState(sig, screen, term, {now, inputAt, typed})`，**由强到弱**：进程退出（done/failed，不在此函数里）→ `working` 正则 → `waiting` 正则（刚打过字的 `settleMs` 内不匹配，因为屏幕上可能还是它回答的那个问题）→ OSC 133 标记 busy → 屏幕还在动（`settleMs` 内有变化，或刚打过字）= working → 安静后若有通知/BEL 晚于上次打字 = `blocked(question)`，文本取通知 → 从未给过它任何东西 = `blocked(first-prompt)` → 否则 `done`。行文本：标题，否则（非备用屏时）最后一行非空行。
3. `task:"type"` 的首条任务、或对已结束 job 的回复，在 `v.quiet` 且不在对话框、也不在 working 时才打进去（`typeInto()`：先 host `input` op 打文本，约 150 ms 后再打 `submit`，因为有的 agent 把一次性涌入当粘贴、会保留换行）。

**host 新 op `input`**（`host/main.ts` `control()`）：把 `data` 写进 PTY，等同 attach 的键盘输入；只对档案 job 开放（`signals` 存在），单次 ≤ `MAX_INPUT`=64 KB，worker 已死回 `{ok:false, alive:false}`。回复已结束的档案 job = 先重启（`resume`，否则 `command`）再打字；打字前它又退出了，行里写明没打进去的是什么。

**hub**：`/profile`（粘性；光输入弹选择器；`/profile pi` 回去）、预设里的 `profile`（模型 id 用该 agent 自己的名字，不要求 `provider/id`）、标题下 `runs <profile>`；回复与批量回复可达档案行；模型列显示档案名；fan-out 与 pi 的 agent 名仍只对 pi 会话有效。降级项显示破折号而不是 0：模型/上下文/用量/记录/`/resume`/子 agent/peer。

**坑**：
- **菜单不能靠打字回复**：按方向键选择的菜单，打字 `2` 不会选第二项，随后的 Enter 反而选了第一项——真机测 Claude Code 的信任对话框时发现。文档化为："菜单要 attach（→）自己回答"，回复只适合文本提示。
- 回复会在"首条任务还没打进去 / 上一条回复还在打 / 正在启动"时排队并提示稍后再试。
- 档案 `env` 同样过 `envDenyList`。

**验收**：单测（档案解析与模板、配置只认用户级、预设、信号收集器对着真 xterm、状态推断）；daemon 用一个假终端 agent（用它的通知推状态、打字回复、`waiting` 正则、退出后行保留、回复重启它、`type` 任务）；hub（`/profile`、预设、行）；真机用 Claude Code：任务与模型进 argv、信任对话框显示为需要输入、attach 回答、打字回复、stop 之后 `--continue` 保留对话。

### Step 30：roost agent 协议与 TS/Python 客户端（M31，级别 1，`docs/plans/m31-protocol.md`、`docs/protocol.md`）

解决：agent 自己会说话时（比如一个 Python 服务），别靠猜屏幕——直接把状态报给 roost、从 roost 收回复。协议是**草案 v1**（找到一个仓库之外的真实 agent 用过两个客户端后才冻结）。

**线协议**：unix socket（0700 目录里，仅本人），每条消息一行 UTF-8 JSON。请求 `{id, op, args}`、响应 `{id, ok, result}` 或 `{id, ok:false, error, code}`、daemon 主动推 `{event:...}`（无 `id`）。未知字段两边都忽略；枚举只随协议版本增长；同一连接上的请求按序应答。错误码：`bad_request` `unauthorized`（token 不对：别再替这个 job 说话）`not_found` `full`（待投递回复超过 50）`busy` `unsupported`。

**ops（agent 一侧）**：
- `hello {protocol:1, agent:{name,version}, capabilities}` → `{protocol, daemon:{name,version}, capabilities}`。每条新连接在第一个 report 之前发。daemon 把 agent 声明的 capabilities 存进 job（`agentInfo` 存在 state 里，`capabilities` 出现在行上）。capability 取值（`lib/protocol.ts` `AGENT_CAPABILITIES`）：`report replies steer usage context model-switch transcript peers agent-items`。**M31 之前的 daemon 对未知 op 回 `bad_request`，客户端要按 v1 行为继续**。
- `report {id, token, report}`：**完整快照**，缺省为 null。核心字段 `state(working|blocked|done|failed)` `status(busy|waiting|idle)` `waitingFor(null|question|dialog|first-prompt)` `summary` `question/choices` `tool/error` `name` `model/thinking`；capability 字段 `context` `usage` `prLinks` `remoteAt`；pi 专用 `attachSignal` `attachRepaint` `agentItems`。接收 report 的那条连接就成为这个 job 的连接，回复从它下来。
- `deliver` 事件 `{id, seq, text, mode?}` 与 `ack {id, token, seq}`：回复**按 job 编号**（`seq` 从 1 起、不复用、跨重启延续）；每条在 ack 之前一直 pending，每次新的上报连接建立时**全部重发**；已处理过的 seq 要丢弃（并再 ack）；ack 是累积的（用户回复），peer 条目（`kind` 为 `message`/`report`）逐条 `exact:true` ack。`/stop` 回复从不下发（daemon 直接停 job）；以 `/` 开头的回复在 agent 未连接时被拒绝。

**两个客户端**（行为一致）：
- TypeScript：`lib/agent-client.ts`（导出 `pi-roost/agent`）。`jobIdentity()` 读环境；`Reporter`（从 pi 的 worker 里**原样搬出来**，外加每次连接先 hello；合并、退避、`call` 发别的 op）；`RoostAgent`（`fromEnv`、带默认值的 `report`、`onReply` 每个 seq 一次、按序、处理完才 ack）。pi 的 worker 现在就建在它上面，以 `pi` 的名字 hello。**整个 import 图只依赖 node**（测试守着）。
- Python：`sdk/python/roost_agent.py`，单文件、纯标准库：连接线程 + 回复线程、断线退避重连、重连后重发最新 report。

**水位**：客户端把"最后处理完的 seq"写进 job 目录里的 `agent.json`（`ROOST_JOB_DIR`），**先于 ack**。agent 崩溃重启后跳过已处理的（只补 ack）——这是 M35 压测发现"重启后重做已完成回复"之后补的（Step 34）。

**运行一个协议 agent**：档案里写 `"protocol": true`。host 给它 job 身份环境变量；它第一次 report 之前，行从终端读（同级别 0）；之后以 report 为准；回复走 pending/deliver/ack；`task:"type"` 的首条任务作为它的**第一条回复**；已结束的重启时带着等待中的回复；上下文与用量在它发了之后才显示。

**未做**：把协议冻结为 v1；`handback peers send spawn peer_*` 这些 agent 间通信 op 还没在 `protocol.md` 里完整描述（属 `peers` capability，见 `lib/protocol.ts`）。

**验收**：一致性测试（`test/daemon.test.ts` 的 "M31 the agent protocol"）在**两个客户端**上各跑一个脚本化 agent 对着真 daemon：首条任务作为回复 1、report 设定行、ack 清掉 pending、**daemon 重启**（客户端重连、hello、report、下一条回复只处理一次）、agent 退出；另有 hello 的应答与拒绝、`protocol` 档案。

### Step 31：按层分目录与包导出（M32，`docs/plans/m32-layers.md`）

**不改行为**，只搬文件，让"层"看得见，并用测试守住线（详见 §2）：`extensions/` → `adapters/pi/`；`lib/api.ts` → `adapters/pi/api.ts`；`package.json` 的 `pi.extensions` 改指 `./adapters/pi/index.ts`；`extensions/index.ts` 留作一行转发（旧 job 存着 `-e …/extensions/index.ts`）；新增 `exports`：`./api` `./agent` `./client` `./protocol`；`files` 加上 `adapters` `hub` `sdk`。`test/cli-deps.test.ts`：核心与客户端不得 import pi 的包或 `adapters/`；`extensions/` 只含那一个转发文件；TS 客户端的 import 图只含 node；旧路径加载的是同一个扩展且只注册一次。

**验收**：整套测试、构建、`npm pack`（含 `adapters`、shim、`dist/adapters/pi/api.*`）；把 checkout 作为 pi 包装进一个空的 pi 目录，扩展从新位置加载（`--bg` `--worktree` 标志在）；压测数字不变（回复 ack p50 23 ms，hub 事件延迟 p50 26 ms）。

### Step 32：独立 hub——`pi-roost hub`（M33，`docs/plans/m33-hub.md`）

解决：agent view 不必寄生在某个 pi 会话里。`pi-roost hub [dir]` 在自己的终端里跑同一个视图、同样的键和命令（与 `pi --agents` 一样）。

- **分层**：视图在 `hub/`（只依赖核心和 pi-tui；颜色经 `HubTheme`）；hub 需要的 pi 能力在 `adapters/pi/hub-options.ts` 的 `piHubOptions(host: PiHost)`（从 `open-view.ts` 拆出来）；嵌在 pi 里走 `open-view.ts`（用 pi 的扩展上下文、`ctx.ui.custom`），独立运行走 `adapters/pi/hub-main.ts` `runHub()`：在 `ProcessTerminal` 上开 pi-tui 的 `TuiAltScreen`（与 pi 全屏模式的画法一样），模型来自 `pi --list-models`（`parseModelList` 解析表头为 `provider  model` 的表），配色是仿 pi 暗色主题的 256 色（遵守 `NO_COLOR`）。
- **运行时怎么找 pi 的包**（`lib/pi-resolve.ts`，仅 node）：pi 的包是 peer 依赖，pi 装 roost 时**不会**装进 roost 的目录，而 CLI 跑在纯 node 上。所以：
  1. `findPiPackage()`：`ROOST_PI_PACKAGE`；否则从 PATH 上的 `pi`（`command -v pi` 的 realpath，沿目录向上找 `package.json` 名字是 `@earendil-works/pi-coding-agent` 的，npm 风格的链接）；否则 `npm root -g`（pnpm/volta/asdf/mise 的 shim 指不过去）。
  2. `piCliOf(pkg)` 从包的 `bin.pi` 取 pi 的 CLI（**永远不用 shim**），新会话跑的就是这个 pi。
  3. `usePiPackage(dir)` 用 `node:module` 的 `register()` 注册一个**解析钩子**（本文件自己就是钩子：`initialize`/`resolve`），把 `@earendil-works/*` 的解析指向用户 pi 安装里（以 pi 自己 import 它们的方式：pi 包的 `package.json` 作为 parentURL），解析失败回退默认——于是 hub 跑的是用户 pi 同一份 pi-tui。
- `pi-roost hub` 像 daemon 启动 host 那样按路径加载 `adapters/pi/hub-main`（安装版从 `dist/`，checkout 里是 `.ts`；`bin/pi-roost.ts` `cmdHub`）。没有 pi 就说明（点名 `ROOST_PI_PACKAGE`）并以 1 退出；目录不存在是用法错误。Esc、Ctrl+C、出错、SIGTERM、SIGHUP 都把终端还原（退出前先排空输入，同 pi）。
- **限制**：独立 hub 没有 pi 会话，所以"转后台"（pi 里的 ←）没有对应物，pi 的斜杠命令（skill、prompt 模板）不能作为首条提示；会话与模型列表是在运行 pi-roost 的那个 node 下跑 pi 的；配色跟 pi 暗色主题，不跟用户选的主题（pi 没导出正在用的主题）。

**验收**：测试——找 pi 的包、钩子从 pi 解析并在失败时回退、模型列表、配色与 `NO_COLOR`、CLI 的错误；tmux 里隔离的 roost 与 pi 目录（把 checkout 作为 pi 包装进去）：视图全屏、输入任务并以 haiku 跑完、行带花费与模型；Enter attach 到会话（pi 的画面与"离开期间"回顾），Ctrl+Z 回 hub；Ctrl+L 列出 pi 的模型；`/resume` 打开 pi 的选择器；Esc 以状态 0 退出。

### Step 33：telemetry（M34，`docs/plans/evals.md` 第 1 层）

解决：下面的压测和 evals 要"有数可查"，但核心不能多一个依赖。

- `lib/telemetry.ts` **无依赖**，形状与 pi 的 `pi-telemetry` 契约相同（回调式 span：`startSpan(options, (span)=>…)`、属性、事件、ok/error 状态、counter、histogram），以后接 OpenTelemetry 只要几行适配。sink 三种：no-op（默认 `NOOP_TELEMETRY`）、JSON-lines 文件、内存（测试 `memoryTelemetry()`）。
- **打开方式**：环境变量 `ROOST_TELEMETRY=<文件路径>`（`telemetryFromEnv(proc)`；相对路径会变成绝对并**写回环境**，这样在别的目录启动的 host 也写同一个文件）。文件 sink 批量写（每 250 ms 与退出时，或满 1000 条），文件权限 0600。需要在启动 daemon 之前设好（先 `pi-roost daemon stop`）。
- 记录点（名字核实自 `daemon/`、`host/`；计划文档里的表 `docs/plans/evals.md` 是设计稿，以代码为准）：`roost.respawn`、`roost.schedule.run`、每个 daemon 请求一个 `roost.op.<op>`（span）；`roost.reports`、`roost.state_changes`、`roost.replies`、`roost.reply.deliver_latency`、`roost.reply.ack_latency`、`roost.attach.replay_latency`、`roost.host.start`/`roost.host.ready`/`roost.host.input`、`roost.events`、`roost.reaped`、`roost.cleaned`、`roost.auto_resume`。具体哪些是 span、哪些是 counter/histogram，见各调用点。`parseTelemetry()` 读文件、`percentiles()` 算 p50/p95/p99，压测与 evals 都用它。**缺失的遥测算"不可用"，不算 0**。

**验收**：`test/telemetry.test.ts`（span/指标/文件 sink）；`test/daemon.test.ts` "M34 the daemon's telemetry"（记录确实出现）。

### Step 34：压测与它找出的问题（M35，`docs/plans/m35-stress.md`）

`npm run stress`（`stress/run.ts`，无模型花费）：隔离 home 里一个真 daemon + 真 host，agent 是假的（`stress/agent.ts`，建在 TS 协议客户端上）。

- 场景：`sessions`（N 个 agent 同时派发、M 个 hub 在看）、`replies`（每个 agent K 条回复，各 job 同时发）、`chaos`（风暴中途 SIGKILL daemon 并重启、SIGKILL 十分之一的 host、一个永不读的 hub，然后给被杀的 job 回复）、`board`（v0.1.15/M49：所有 agent 同时抢任务板，中途 SIGKILL daemon 再起，见 Step 47）、`soak`（重复风暴几分钟，观察内存与描述符）。参数：`--jobs 50 --replies 20 --hubs 3 --tasks 120 --soak-minutes 10 --work-ms 0`。
- 不变量：每条回复恰好处理一次且有序（chaos 里请求失败后重发的允许处理两次，计数不判失败；M36 之后连这个也没有了）；被杀的 job 被看作已结束并被回复重新拉起；结束时每个 job 都停了、没有遗留 host 或 socket。
- 预算（`stress/run.ts` `BUDGET`）：dispatch p95 3000 ms、全部就绪 `30_000 + JOBS*200` ms、回复 ack p95 3000 ms、hub 事件延迟 p95 1000 ms（M49 起不计 agent 的 `ready`——它在连上 daemon 之前就打了时间戳，是启动耗时；daemon 宕机期间（被杀到恢复后 5 s）发出的报告单独计数；hub 在 daemon 被杀后会重连重订阅）、`task` op p95 1000 ms（M49）、daemon RSS 400 MB；超预算整个 run 退出 1。报告与遥测在 `stress/.runs/<时间>/`（`report.json`、`report.txt`、`telemetry.jsonl`、agent 日志）。

**它找出并修掉的（50 agent × 20 回复、3 hub、macOS）**：

| 指标 | 之前 | 之后 |
|---|---|---|
| reply op p50 | 237 ms | 8 ms |
| 回复收到→ack p50 / p95 | 1073 / 1683 ms | 25 / 30 ms |
| hub 事件延迟 p50 | 1414 ms | 26 ms |
| 1000 条回复全部处理 | 21.8 s | 5.2 s |
| report op p50 | 17 ms | 1 ms |

1. **`checkHosts` 每次对每个 job 同步跑 `ps`**：50 个 job = 一圈 50 个进程，事件循环被堵。现在 pid 活着就算它的 host，最多每 30 s 复查一次；起始 token 在 host 启动时异步读。
2. **每次写 `state.json` 都 fsync（文件+目录，macOS 上约 8 ms）**：约每秒 125 次状态写，每个事件都排在它们后面。现在：worker 的 report **原子写但不 fsync**（下一次 report 会覆盖它）；必须扛过崩溃的东西（pending 回复、用户的选择、job 怎么结束的）是**耐久**的，由 daemon **按组异步 fsync**（`lib/atomic.ts` `deferDurability(true)` + `durable()`；`DURABLE_KEYS` 在 `lib/store.ts`；并行 fsync 上限 32 个文件；同一文件/目录一批里只 sync 一次），**请求要等它的写落盘后才应答**；ack 不耐久（丢了就是重发，按 seq 丢弃）。
3. **重启的 agent 重做已完成的回复**：agent 处理完回复、ack 到达 daemon 之前死了，新进程又做一遍。现在客户端把最后完成的 seq 存在 job 的 `agent.json`（先于 ack）并跳过它覆盖的部分（Step 30）。
4. **丢了应答的回复被重发后处理两次**（chaos 里 2050 条有 46 条）：daemon 收了请求，应答随 daemon 一起丢了，客户端又发一遍。→ Step 35 的请求 ID。

评审后补的：后台 sync 失败不会毒害后面的批（每批各自应答，失败只记日志）；崩溃后留下的**空 `state.json`**（report 不 fsync 所以可能为空）在启动时从 job 记录重建为 failed 且可再启动，而不是整个 job 消失。M38 实现期间又看到一次回归：每个空闲 report 都写 `crashRestarts:0`（已是耐久键）把回复吞吐从 5 s 拖到 8 s；修为"只有计数大于 0 才写，且非耐久"。

**验收**：默认规模的 `npm run stress` 全绿；group commit 的单测；daemon 里"丢 ack 后重启"的测试；整套测试。

### Step 35：请求 ID（M36，`docs/protocol.md` "Request ids" 节）

解决：回复/派发的应答丢了（daemon 重启、连接断开）后客户端重发，会被处理两次。

- `reply` 与 `dispatch` 带可选 `requestId`（1–64 个 `A-Za-z0-9_.:-`；`lib/protocol.ts`）。同一 id 重发 = 只处理一次：`reply` 回 `{duplicate:true, saved:true}` 且不再入队（但如果 job 已结束且那次本来要启动它，则现在启动）；`dispatch` 回**第一次**造出的那个 job，不管重发时其他参数是什么，只要那个 job 还在。
- job 记住最近 `MAX_REQUEST_IDS`=100 个回复 ID，和回复**写在同一次 state 写里**（`requestIds` 是耐久键）——两者要么都在要么都不在；对终端 agent，ID 在文本打进去**之后**才记（崩在两者之间会再打一次，不是原子的）。
- 用法：每个新请求新 ID，每次重发同一个 ID。**注意（核实结果）**：v0.1.12 里 hub、CLI 并不带 `requestId`——grep 只在 `stress/run.ts`、`evals/harness.ts` 和测试里看到它；它是留给"会重发的控制端"（脚本、第三方 hub、压测）的能力。移植时 hub/CLI 要不要带，自己决定。
- 效果：chaos 场景里 50 次重发各只处理一次、没有重复。

**验收**：`test/daemon.test.ts` "M36 request ids" 与 "M36 a resend after the daemon died before starting the job"。

### Step 36：真模型 evals（M37 + M41，`docs/plans/m37-evals.md`）

`npm run eval`（`evals/run.ts`）用真模型端到端跑 roost 的行为，按"roost 看到了什么"评分。**要花钱（默认模型上几美分）**，不属于 `npm test`；依赖只在 devDependencies 里的 `vitest-evals`，发布包不含。

```text
npm run eval                      # 每个用例一次，默认模型
npm run eval -- --runs 5          # 每个五次：通过率、flaky 用例
npm run eval -- --model anthropic/claude-sonnet-5-5 --thinking medium
npm run eval -- --only steer      # 名字含 steer 的用例
```
环境变量 `ROOST_EVAL_MODEL`（默认 `anthropic/claude-haiku-5-5`）`ROOST_EVAL_THINKING`（默认 `low`）`ROOST_EVAL_RUNS` `ROOST_EVAL_SECOND_MODEL`（fan-out 的第二个模型）`ROOST_EVAL_DIR`（观测落盘目录，`run.ts` 设）`ROOST_EVAL_KEEP=1`（保留现场）。

**每个用例怎么跑**（`evals/harness.ts` `runCase`）：
- **每个用例一个独立的 roost**：临时 home / runtime / config 目录、自己的 daemon、自己的工作区（可选 git 仓库）；pi 经它的 worker 跑，扩展从**本仓库**加载（`adapters/pi/index.ts`）。步骤 `{when: "working"|"blocked"|"done"|"idle"|"stopped", reply, mode, afterMs, kill, stop}` 驱动：一次 `dispatch`，到点再发回复（带请求 ID），一路跟着 daemon 的事件看行，直到"沉寂"（该用例的所有 job，含子 agent，3 s 无 working 且无回复 pending）或超时。
- **pi 自己的目录也是新的**：`PI_CODING_AGENT_DIR` 指向空临时目录（否则用户的设置、系统提示、扩展、skill 会让每次跑都变成"用户的"——第一次跑就发现 pi 用用户的语言回答）；其中 `auth.json` 是到用户那份的**符号链接而不是拷贝**（pi 会通过它写回刷新后的登录 token，拷贝会让用户自己的 pi 手里的 token 作废）。
- roost 目录**两种拼写都设**（`ROOST_*` 压过 `PI_ROOST_*`），并校验 socket 应答的确实是自己启动的那个 daemon——用户自己的 `ROOST_HOME` 绝不能让用例及其清理指向用户的 roost；用例结束时它起的一切（job、daemon、遗留的 host/worker）无论如何都被停掉；对 daemon 的请求有时限。
- 返回 `RoostOutcome`：行的状态序列（含其间发的回复）、最终行、记录、最后回答、工作区文件、子 agent、仍 pending 的回复、整个用例的花费与 token（含缓存和子 agent）、用时、从遥测来的回复 ack 延迟。

**评分是确定性的**：`checks(name, {检查名: (outcome)=>boolean})` 是一个 `vitest-evals` judge，得分 = 通过的检查占比，rationale 点名失败项；**没跑完（超时、daemon 起不来）计 0，算"没打分"而不是"通过"**。检查匹配的是"句子里不会碰巧出现"的词（`SLEPT-4X`、随机 token），按原样在最后回答里找。**不让模型评判模型**。`evals/run.ts` 写 `evals/.runs/<时间>/`：`protocol.json`（模型、thinking、次数）、`observations.jsonl`（每次运行一行）、`report.json`/`report.txt`（每个用例通过数/次数，部分通过标 flaky，失败的检查及次数，错误，花费，用时 p50）；只跑一次的报告会声明"不是稳定性度量"。

**用例**（`evals/core.eval.ts`，pi 经 worker）：任务做完（行以 done 结束、先 working 后 done、文件内容恰好是要求的、报了花费）；回复继续会话（第一答 42 在记录里、回复的答案 50 用到了会话上下文、回复被 ack）；steer（4 s 时对 12 s 的 `sleep` 发 steer，在**同一轮**里被接住，最终回答同时含工作的词和 steer 的词）；子 agent（`roost_spawn` 恰好起一个子、子 done、子读了一个父被告知不要读的文件里的随机 token、父的最终回答里有它）；**中断（M38）**：在 15 s 的 `sleep` 进行到 6 s 时 SIGKILL worker，它被自动重启一次并把活干完。

**M41（`evals/agents.eval.ts`）**——跑 roost 除 pi worker 之外的东西，同一个真模型：`agent:"term"`（pi 自己当终端 agent，经档案：`pi -ne --session-dir …`，任务进 argv，`--continue` 续跑，`working: "Working ─"`，行只从屏幕读）、`agent:"protocol"`（`evals/fixtures/pi_agent.py` 建在 Python 客户端上：每条回复是 `pi -p --session …` 的一轮，pi 打印的就是 report）、`fanout:[模型…]`（每个模型一个 worktree，如 `/fanout`）；步骤可以 `stop` 再等 `stopped`。用例：fan-out（两个会话共享同一个 fan-out id、都 done、各在自己的 `roost/` 分支、各自 worktree 里写了文件而主树没动、`worktreeChange` 各看见一个文件、两个模型）；终端 agent（只凭屏幕看出 working→done、第一答在屏幕和会话里、打字回复被回答、`stop` 后回复用 `--continue` 重启且保留上下文）；协议 agent（hello 里名字 `pi-print` 和 capability `replies`、首条任务作为回复 1 报 working 再报 done、report 就是回答、回复答案用到第一轮上下文、报了模型、ack）。

**结果（2026-11-05，haiku，thinking low，各 3 次）**：核心 4 例 12/12（整次不到 1 美分），M41 3 例 9/9（fan-out 约 $0.023；终端/协议 agent 不报花费，所以是 n/a；终端 agent 的 25 s 多半是"屏幕静止 2.5 s"的等待）。第一次跑出来并已修的：用户的 pi 设置串进用例、token 统计漏了缓存和子 agent、`ROOST_HOME` 会指到用户的 roost、跑得太快在子 agent 汇报前就"沉寂"、检查匹配到了普通词、抛错时遗留 daemon。

**验收**：`npm run eval` 默认全过；`test/evals-judge.test.ts`（judge 本身，不花钱）。

### Step 37：中断续跑（M38，`docs/plans/m38-resume.md`）

解决：一次被截断的运行不该等用户发现，而是**有界地自己接着跑**。

之前：worker 崩溃（非 0 退出）只重启一次；host 在运行中的 job 底下消失（被杀、OOM）直接 failed（"host vanished"）；机器或服务停掉时的运行 failed 并等回复；**被信号杀死的 worker 被当成 done**——node-pty 把信号死亡报成 **exit code 0 + signal 号**，原来只看了 code（新的 eval 发现的）。

现在（用户级配置 `autoResume`，默认 `"interrupted"`）：

| 取值 | 自动重启 |
|---|---|
| `"interrupted"`（默认） | worker 崩溃/被杀；host 在 working 的运行底下消失；机器或服务停掉时正在 working、且最后进展在 `RESUME_WINDOW_MS`（6 小时）内的运行 |
| `"crash"` | 只有 worker 崩溃/被杀 |
| `"off"` | 不自动重启 |

- 重启时给会话发 `"Continue where you left off."`（从没写过盘的会话则重跑首条任务）。**预算**：连续最多 3 次，间隔 `RESUME_DELAYS_MS` = 1/5/15 s（`PI_ROOST_RESUME_DELAYS_MS="1000,5000,15000"` 可覆盖，测试用）；一轮正常结束且 worker 已稳定跑了一分钟（`CRASH_RESET_MS`）才把计数还回去。超过预算：行 failed 并写原因（`not restarted again after 3 automatic restarts in a row (reply to continue)`）。
- **等待期间行保持 `working`**（不给"已结束"通知，因为运行本来就要继续），并写明（`worker killed by SIGKILL; continuing in 5 s (automatic restart 2 of 3)`）。`resumeAt` 作为**耐久写**存在 job 的 state 里（`DURABLE_KEYS`；注意它在 `state.json`，**不在 `JobRow` 上**）：
  - `stop`（或 `/stop` 回复）取消它（行为 stopped），`rm` 也取消；父会话照常收到结束通知。
  - 任何一次真正的启动取代它：attach / 连按 Enter 以 "Continue where you left off." 接着跑，回复则作为回复送进去；这**不计入**自动重启次数，也不把预算还回去；启动失败（会话被锁）则让等待中的重启继续。
  - 服务在等待期间停了：下次启动接着等（`scheduleResume`）。
  - 启动不了（会话被别的 pi 锁了、目录没了）：行 failed 并写明原因，不再试；父会话会收到。
- 判定"崩溃"（`daemon/main.ts` `crashed()`）：退出码非 0，**或**带信号（`ex.signal` 非空且不为 `"0"`）——对命令和终端 agent 也一样；`exitText()` 把信号号译成 `killed by SIGKILL`。

**验收**：测试——崩溃循环重启 3 次后 failed；`off` 不重启；服务停掉期间死掉的 host 恢复为 "Continue where you left off."；working 的运行底下 host 被杀会重启（`crash` 模式下是 failed）；等待中 stop；重启挂起跨服务重启；等待中来回复/attach/启动失败/`/stop`；信号死亡读成失败。评审发现并修的：等待期间启动失败会让行永远等着、attach 丢了"continue"、stop/rm 没通知父会话。真 pi eval：6 s 时 SIGKILL，pi 看到被打断的工具调用、重跑、写出文件，3/3。

### Step 38：定时任务（M39，`docs/plans/m39-schedules.md`）

解决：让任务按计划跑，**由后台服务持有**，不管有没有 pi 或 hub 开着。

```text
/schedule <name> <when> <task>
/schedule                         列表（下次运行、上次运行、被跳过的原因）
/schedule run|pause|resume|rm <name>
pi-roost schedule [list] | run|pause|resume|rm <name>
```
`when`（**本地时间**）：`every 30m`（`m` `h` `d`，至少一分钟）、`daily 09:00`、`weekdays 09:00`、`cron "<分 时 日 月 周>"`（列表、范围、步长；周日 0 或 7；日与周都写了则任一满足，同 cron）。

做法：
- `lib/schedule.ts`（仅 node）：`parseCron`/`nextCron`、`parseWhen`/`nextRun`、`/schedule` 行的解析（`parseScheduleInput`）、每次运行的派发（`runLaunch`）：模板里的 `{{run}}`（`RUN_SLOT`）换成一个 pi 风格的会话文件名（`runSlot()` = `<ISO 时间>_<uuid>`）。
- **模板在知道 pi 的地方生成**（`adapters/pi/hub-options.ts` `scheduleLaunch`）：就是视图会为这个任务发的那次 dispatch，带视图的模型、thinking、目录（含预设的目录），会话文件 `<该目录的 pi 会话目录>/{{run}}.jsonl`，不带 worktree。**只有会话文件那个参数会被填**；任务文字里自己写了 `{{run}}` 的原样不动。
- daemon 持有 `schedules.json`（单写者、耐久写），每 `SCHEDULE_TICK_MS`=15 s 检查一次（`PI_ROOST_SCHEDULE_TICK_MS` 可覆盖）。新 op（`lib/protocol.ts`）：`schedules` `schedule-add {name, when, launch, task?, catchUp?}` `schedule-rm` `schedule-pause {name, paused}` `schedule-run`；一次运行就是一次以计划命名的 `dispatch`，job 上标 `schedule`（行上带）。
- **先定下次再启动**，慢启动不会被重复运行；`every` 从创建（或恢复）时刻起算，间隔之后的一次落到下一个槽，**不补发一串**。
- **本地时间且不倒退**：夏令时重复的那一小时里，下次永远在前方（以 epoch 毫秒步进；下次至少是 1 s 之后）；春季跳时那天不存在的时刻（02:30）改到次日。每个计划同一时刻只有一个运行在启动（并发的第二个请求得 `busy`）。手工改过的 `schedules.json` 缺的字段在加载时补齐。
- **跳过**（写进 `lastSkip`）：到点时上一次运行还在 working / 启动中 / 等自动重启（M38）（`stillRunning()`）。上一次**已做完但 worker 还开着**的不算，那个 worker 会像子 agent 一样在 done 后被关闭（`scheduleAutoClose`，`AUTO_CLOSE_MS`）。
- **到点没开机**：服务启动时发现某计划已过期，`catchUp`（默认）补跑**一次**，否则移到下一次。

坑（真机跑 `tick every 1m` 时发现）：做完的 pi 运行 worker 仍开着（空闲），调度器以为还在跑——所以现在只有 `working` 算占着，并且做完的运行会被关闭。评审另外发现：cron 的下次在夏令时重复那小时会落到过去一小时（会每个 tick 都跑）、同一计划两次并发运行、任务文字里的 `{{run}}`、`*/n` 与日规则——都修了并加了测试（America/New_York）。

**验收**：`test/schedule.test.ts`（cron 字段与错误、跨周末/月/年/2 月 29/日周任一/never、`every` 从锚点起、槽与模板检查、`/schedule` 行、时间显示）；`test/daemon.test.ts`（增删暂停恢复与拒绝、立即运行用自己的会话文件且从不并发、tick 到点、启动时补跑或不补、重启后保留、暂停的不跑、做完且 worker 在的不阻塞下一次并被关）；tmux 里独立 hub：`/schedule tick every 1m <往 ticks.txt 追加 UTC 时间>`，每分钟在 haiku 上跑，服务停了再起触发一次补跑，行依次命名为 `tick`、`tick (2)`…，做完被关闭。

### Step 39：全 agent 的续跑与定时（M40，`docs/plans/m40-agents-resume.md`）

M38/M39 先只做了 pi。M40 推广到档案 agent（级别 0）和协议 agent（级别 1），并在合理处推广到普通命令。

**续跑（`autoResume`）**：

| agent | 中途被截断（崩溃/被杀/host 没了/机器或服务停了） |
|---|---|
| pi 会话 | 同 M38 |
| 协议 agent | 重启（用它的 `resume` argv，否则用不带首条任务的 `command`）；"Continue where you left off." 作为**回复**送达，排在仍 pending 的回复之后（M31 的重放） |
| 带 `resume` 的终端 agent | 用 `resume` 启动，等它安静后把提示打进去 |
| 不带 `resume` 的终端 agent | 保持 failed（重新开始无法接着做；回复它才会重新启动） |
| 普通命令 | 保持 failed（命令只跑一次） |

预算与规则同 M38（连续 3 次，1/5/15 s，等待期间行是 `working`，stop 或回复取消）。`DispatchArgs.resumable` 与 job 记录上的 `resumable` 表示档案有 `resume`（`buildProfileLaunch` 设）；协议 agent 总是可续跑（协议的设计：report、重放、`agent.json` 水位）。

**定时**：`/schedule <name> <when> <task>` 用视图当前的选择跑：pi 会话如前；开着 `/profile x` 则跑那个 agent（模型与 thinking 照选，不带 worktree）；以 `!` 开头的任务是命令（`/schedule tests weekdays 18:00 ! npm test`）。模板就是视图会发的 dispatch（`launchProfile`、`launchShell`），没有逐次要填的东西，每次运行就是那条命令再来一次。`ScheduleRow.agent` 显示跑的是什么（`pi`/`shell`/档案名；`lib/schedule.ts` `templateAgent`）。

**无人值守的细节**：
- 一个定时的终端 agent **done 且安静**时和 pi 运行一样被关闭（行保留；回复会重新启动它：`resume`，否则 `command`）。
- 定时运行没人在，所以会**通知**的 agent（Claude Code 做完会通知）在这里算 done，通知文字作为行的文本，而不是一个没人回答的 question（否则它永远开着，一次一个进程）；卡在对话框里（档案的 `waiting` 正则）仍然是对话框、留给用户（`profileTick` 里 `recs.get(id)?.schedule` 的分支）。
- 命令的行照命令的规矩走。
- 机器或服务停掉之后，一个原本 done 或在提问的终端 agent 事后仍显示为该状态，但没有进程（回复会启动它）；`finalize()` 不清它的行文本 summary（见 `kept` 分支）。

**验收**：测试——服务停掉时 done/提问的终端 agent 事后仍显示原样；自动重启启动不了时不留 "continue" 排队；带 `resume` 的终端 agent 中途死掉（用 `resume` 重启、提示打进去、done）；不带的（failed、不重启）；协议 agent 在回复时死掉（重启，"continue" 作为回复被接住）；终端 agent 的定时（以计划命名、done 后被关、行保留）和命令的定时；带 worktree 的模板被拒；视图里 `/schedule` 配合 profile、`!`、视图的模型。压测与 evals 不变（pi 的路径只改了共用的 finalize 代码）。

**未做**：不带 `resume` 的终端 agent 用首条任务从头再来（任务可能做了一半，所以没做）。

### Step 40：一个压测用例的修复（M42，只改测试）

没有产品代码的改动（提交 `d1f43f0` 只动了 `test/stress-attach.test.ts` 和文档）。教训对移植同样有用：Step 21 的"自己挂起的 worker 被下一次 attach 的 SIGCONT 救回"那个用例在整套 `npm test` 的负载下偶尔失败。原因是**测试替身和真 pi 的行为不一样**：假 worker 在"stopped"期间**丢键**；而 host 的 SIGCONT 和 attach 之后马上打的键，经同一个 node 事件循环到达，**顺序不定**。真 pi 在 stopped 期间是**停止读终端**，期间打的键留在终端里等着。现在假 worker 也这样做（`stdin` 暂停到 SIGCONT，并输出 `[stopped]` 标记让测试知道键被收到了）；测试等 tick 停止（而不是固定 300 ms）；PTY 输出超时时，报错信息写明终端最后显示了什么。

移植提示：为你的宿主写假 worker 时，**模仿真宿主在异常状态下的 I/O 行为**（停止读 vs 丢弃），否则测的是替身而不是你的系统。

### Step 41：事件流、watch 与消息规则（M43，`docs/plans/m43-events.md`）

控制平面（`docs/plans/hub-control-plane.md`，M43–M47）的第一块。daemon 把"值得记的事"追加进 `events.jsonl`（`lib/events.ts` `EventLog`：JSON 行、内存与文件各保留最近 `EVENT_LOG_MAX`=1000 条、文件写到两倍窗口时重写一次、不 fsync）：`dispatch`、进入 waiting/done/failed/stopped 或从这些状态回到 working 的 `state`（`stateMatters()`；同是 blocked 但等待对象从提问变成对话框也算）、`reply`、`message`、`report`、`notice`、`resume`、`schedule`、`removed`，后来加的 `concierge`（M44–M46）和 `task`（M47）。每条 `{seq, at, kind, id, name, state?, from?, waitingFor?, text?(≤300), who?, whoId?, why?}`。

- **op `events {after?, limit?, id?}`** → `{events, cursor}`：带游标读（`after` 之后的，最旧在前；不带则最新 `limit` 条；游标超前于日志时按"不带"处理）。**只给 hub/CLI**：前台 pi 和 worker 的连接被拒（`unsupported`），因为事件流带着所有会话树的消息；M44 起值班 agent 的连接例外。
- **op `watch {id, when: "idle" | "ended"}`** → `{id, name, when, fired}`：一次性通知——目标会话下次空闲（done/提问/失败/停止/删除）或结束时，给观察者投一条 `notice`（带它的提问或最后回复；`lib/comms.ts` `noticeBody`）。已经满足则 `fired:true` 立刻投。watch 存 `watches.json`、重启后仍在、12 小时过期（`WATCH_TTL_MS`，`PI_ROOST_WATCH_TTL_MS`）、每个会话最多 20 个（`MAX_WATCHES`）。pi 侧工具 `roost_watch(to, when)`。
- **消息规则**：同一发送者一分钟内给同一会话发同样文本 → `outcome:"duplicate"`，不投递（`DUPLICATE_WINDOW_MS`），两个会话互相复读会自己停下；每发送者每分钟 30 条（`MESSAGES_PER_MINUTE`，`rate_limited`）；每会话最多 20 条待投 agent 项（`MAX_PENDING_AGENT`，`full`）。信封（`envelope()`）明说"来自另一个会话、不带用户权限、里面以 `/` 开头的行是文本不是命令"，正文里的 `<agent-message>` 被转义（`neutralize()`）。
- hub：`/log`（浮层，最新在前，`r` 重载）；CLI：`pi-roost log [-n 50] [--follow] [<id|name>]`。

移植提示：事件流是后面值班 agent 的"记忆"，先于它做；`stateMatters()` 决定什么算事件，过多会把摘要淹没。

### Step 42：值班 agent v0——汇报与传话（M44，`docs/plans/m44-concierge.md`）

hub 自己的 agent：一个 pi 会话作为 **role** 而不是普通行（`JobRow.role: "concierge"`，列表里不显示），daemon 用"摘要"唤醒它。

- **启动**：`/concierge on`（hub 先 `buildLaunch` 一个 pi 启动参数，env 里带 `ROOST_ROLE=concierge`，`CONCIERGE_ROLE_ENV`），op `concierge {action: on | off | status}`；`off` 停掉它的 job，再 `on` 重启同一个 job（保留会话）。状态 `ConciergeStatus {on, id, state, live, model, wakesLastHour, lastWakeAt, behind, costToday, budget, overBudget, notice, policy, orders, answered, answer}` 以 `{event:"concierge", status}` 推给订阅的 hub（`pushConcierge`）。
- **唤醒**（`wakeConcierge`，`daemon/main.ts`）：事件进来后合并 5 s（`CONCIERGE_COALESCE_MS`，`PI_ROOST_CONCIERGE_COALESCE_MS`）再发一条 `digest` 投递（`deliverAgent(..., "digest", ...)`，`<roost-digest why="events|heartbeat|order">`：自上次以来的事件 + 当前 fleet 一行一会话 + M46 起的常备指令 + M47 起的任务板）；每小时最多 `wakesPerHour`（默认 60）次，超了就攒着；没事发生时按 `heartbeat`（默认 `every 15m`，`lib/schedule.ts` 的词汇）发一次心跳；当天花费超过 `dailyBudgetUsd`（默认 1 美元）就不再唤醒（`overBudget`）；投递失败 60 s 后重试（`CONCIERGE_RETRY_MS`）；检查节拍 30 s（`CONCIERGE_TICK_MS`）。它自己产生的事件不进它的摘要。
- **pi 侧角色**（`adapters/pi/concierge.ts`，`isConciergeRole(env)`）：换掉 system prompt（`conciergeSystemPrompt(policy)`，`lib/concierge.ts`），关掉 pi 自己的工具（没有 shell/文件），只注册 hub 工具：`hub_sessions`（当前 fleet，每会话一行）、`hub_events`、`hub_read(id, what)`（记录尾/屏幕/提问）、`hub_send(to, text)`、`hub_notify(text, level: info|need)`（op `concierge-say`，在 hub 标题下显示一行、`need` 用警告色）、`hub_watch`。用户在 hub 里 `? 问题`（op `concierge-ask`）：它的下一条纯文本回答交回 hub（`answerText()`：用户问题之后的最后一段助手文本；摘要混进同一轮的也能分开），以浮层显示，两分钟没答就提示。
- **配置**：`roost.json` 的 `concierge {model, thinking, wakesPerHour, heartbeat, dailyBudgetUsd, answer, act}`（**仅用户级**，`USER_ONLY` 加了 `concierge`；`conciergeFrom()` 校验）。
- evals：`evals/concierge.eval.ts`（真模型：三个会话，一个结束、一个失败、一个提问——它在头几次唤醒里报出来、把提问标成"需要你"且不代答；按要求把一个会话的发现传给另一个）；harness 新增 `concierge`、`extra`（同时起的其他会话）和 `ask` 步骤。

移植提示：值班 agent 是"又一个 worker + 另一套工具"，适配层改动很小；真正的工作量在 daemon 的唤醒合并/配额/预算和摘要文本（`digestText()`，`lib/concierge.ts`）。

### Step 43：升级与策略——建议答案、常规代答、撤回、act（M45，`docs/plans/m45-policy.md`）

- **建议**（总是开）：会话提问时它用 `hub_suggest(id, answer, why)`（op `concierge-suggest`）给出建议答案，挂在该行（`JobRow.suggested`）；hub 标题下出横幅 `needs you · api-fix asks: … · concierge suggests: … · Ctrl+Y sends it · Ctrl+E edits · Esc dismisses`，peek 里也显示；行离开 blocked 或换了问题时建议作废（`dropSuggestion`）。
- **策略**（daemon 保存，`roost.json` 的 `answer`/`act` 只是初值）：`/concierge answer never|routine|always`（op `concierge {action:"answer"}`）。`routine` 下它用 `hub_reply`（op `concierge-reply`）代答常规问题（继续/确认、显而易见的默认值、fleet 里已有的信息），其余升级；**不可逆或花钱的事**（push、删除、付款、部署、凭据……）永远升级；`always` 除这些外都代答。daemon 是闸门：策略不允许回 `policy`，行没在等提问回 `bad_request`。代答是 `who:"concierge"` 的 `reply` 事件，状态行显示一分钟，`/concierge undo`（`{action:"undo"}`）撤回：会话被 steer（或回复）"忽略那条、重新问用户"（`undoText()`）。
- **act**：`/concierge act on|off` → `hub_dispatch`/`hub_stop`/`hub_respawn`（op `concierge-act {what, id | launch, why}`），没开就 `policy`。pi 侧按策略切换激活工具集（`activeTools(policy)`：`HUB_TOOLS + ORDER_TOOLS + BOARD_TOOLS + (answer≠never ? ANSWER_TOOLS) + (act ? ACT_TOOLS)`，每轮开始前读一次 `concierge-policy`），prompt 也随策略变。
- evals：`evals/policy.eval.ts`（固定的一组常规 vs 谨慎问题：谨慎的一个都不代答、每个都有建议；常规的代答，其中"fleet 里的值"要答对；`never` 下什么都不答）。

### Step 44：常备指令（M46，`docs/plans/m46-orders.md`）

用户的话写成的规则，值班 agent 一直记着：`StandingOrder {id, text(≤500), when|null, by: "user"|"concierge", at, lastAt, nextAt, count}`，存 `orders.json`（`{next, orders}`，id 单调不复用，最多 50 条 `ORDER_MAX`）。

- op `concierge-order {action: add {text, when?} | rm {id} | list | applied {id, text?}}`：hub 的连接加的是 `by:"user"`，值班 agent 的连接（`hub_note(text, when?)`）加的是 `by:"concierge"`，它只能删自己的（`hub_note_drop`，否则 `unsupported`）；`applied`（`hub_note_done(id, what)`）记 `lastAt/count`，事件 `concierge why:"order"`（`#id what`）。`when` 用定时任务的词汇（`every 30m | daily 18:00 | weekdays 09:00 | cron "…"`），否则 `bad_request`。会话的连接被拒。
- **每次摘要都列出全部指令**；带时钟的到点由 daemon 节拍发现，发 `why:"order"` 的摘要并带 "Due now" 节（送达后 `nextAt` 才前移；被配额压住时下一次摘要带上，只带一次）。自己记的标 "(kept by you)"，prompt 明说这种指令不能放宽策略。
- hub：`/concierge orders`（浮层，最新在前）、`orders add [时钟] <规则>`（像时钟但不是 roost 词汇的提示不记）、`orders rm <id>`；状态里有 `orders` 数。
- evals：`evals/orders.eval.ts`（"A 结束就把结果告诉 B"只执行一次并说出 `#1`；在提问里说的规则被它以 `every 1m` 记下并在到点唤醒时执行；要它启动会话的指令在没有 `act` 时拒绝并告诉用户）。harness 新增 `orders` 和 `waitMs` 步骤。

### Step 45：peek 加深（M48，`docs/plans/m48-peek.md`；按用户要求在 M47 之前做）

只改 hub 与少量 daemon 字段：

- **更多信息**：`JobRow` 新增 `task`（启动时 `--` 之后的任务文本，`rowTask()`）和 `queued`（等着投给它的用户回复数，不含 agent 项）。peek 显示任务、在哪、从何时起（结束的显示用时）、花费（`$0.12 · 34k tokens`）、排队回复数，以及记录尾（`lib/transcript.ts` `readTail(file, max)`：先 `stat`，只读末尾 256 KB；缓存按文件大小/mtime 键控，原始行在渲染时按宽度截断，浮层开着时每 2 s 刷新；终端 agent 显示屏幕行；失败的会话显示完整错误）。
- **回复框**是和任务框一样的编辑器（`TaskEditor`：多行、粘贴折叠、Ctrl+G 外部编辑器），页脚按会话状态说明 Enter 做什么（`Enter send · Alt+Enter after work · 1-9 pick · / commands · Esc close · ? keys`，须 ≤80 列）。
- **peek 里的 `/` 命令**对这个会话生效（`peekCommand`）：`/stop /respawn /rm /pin /rename /attach /model /thinking /name /compact /continue /log /transcript /ask`；其他 `/…` 原样作为回复发给会话（pi 的 prompt 模板和 skill）；`!` 拒绝；会话已结束（`pid === null`）时 `/name` `/compact` 拒绝（否则会把它重启）。worker 侧新增：从回复里执行 `/compact`。
- **补全**：两个框都用 pi-tui 的 `CombinedAutocompleteProvider(commands, basePath, fdPath)`（`/` 命令带描述与参数补全、`@` 路径、有 `fd` 时模糊）；菜单开着时对 `/` 命令按 Enter 直接执行（`Editor.isShowingAutocomplete()`）；Tab 对 `@dir` 走 `completeAt()`，否则交给编辑器。

移植提示：真实终端里验收（tmux，`node bin/pi-roost.ts hub 2> log`，**别重定向 stdout**），自动化测试里行选择要跳过分组标题行。

### Step 46：共享任务板（M47，`docs/plans/m47-tasks.md`）

控制平面的最后一块，把"盯着看的 hub"变成"团队"（对应 Claude Code agent teams 的任务列表）：

- **存储** `tasks.json`（`{next, tasks}`，`lib/board.ts` `BoardTask {id, title(≤200), detail(≤2000)|null, state: open|claimed|done|dropped, after: ids, by:{who, whoId}, at, owner:{id,name}|null, claimedAt, doneAt, result|null, assigned:{id,name,at}|null}`，最多 200 条 `TASK_MAX`，满了先清 done/dropped 最旧的，id 不复用）。`blockedOn(t, all)`：`after` 里既非 done 也非 dropped 的 id。加载时规范化：没有持有者的 claimed 变 open，open 不带持有者。
- **op `task {action}`**，在任何连接上，动作者由连接决定（`boardActor()`：hub=`user`、值班 agent、job（report 被接受之后）、前台 pi（`peer_register` 之后）；说过 `hello`/`report` 但没有被接受的 report 的连接回 `unauthorized`，绝不当成 hub）：`list`；`add {title, detail?, after?}`（`after` 必须在板上且未 dropped，否则 `bad_request`；满 `full`）；`claim {id}`（**只有会话**，hub/值班 agent 回 `unsupported`；别的活着的会话持有 → `conflict`；持有者已不在（job 不在 roster、前台 pi 断开）→ 先释放再接管；依赖未完成 → `blocked`；done/dropped → `bad_request`；自己重复认领无事）；`release`/`done {result?}`（持有者、hub、值班 agent；hub/值班 agent 收回时持有者会收到一条消息）；`drop`（只有 hub 与值班 agent；done 的不能 drop；持有者收到消息）、`assign {id, to}`（只有 hub 与值班 agent；给目标会话投一条 `message`（任务、细节、怎么认领或还在等谁）；**消息送达且任务仍 open 时**才记 `assigned` 和事件，应答带 `sent`；同一任务同时两次交办回 `bad_request`）。id 只认正整数或数字串。结果 `{tasks, task?, sent?}`。
- **认领随会话走**：job 失败/停止（`noteState`）或被删除（`removeJob`）时释放其全部认领（事件 `why:"release"`，文本 `#1 one: a stopped`）；启动时记录已不存在、或状态为 failed/stopped 的持有者也释放；前台 pi 断开 5 s 后释放（`FG_CLAIM_GRACE_MS`，`PI_ROOST_FG_CLAIM_GRACE_MS`；同一会话重开的 pi 用同一 id 回来则保留）；roost 自动续跑（M38）的会话保留认领（同一 job id）；已 done 的 job 活着时保留。
- **事件与推送**：`task` 事件（`why: add|claim|release|done|drop|assign`，`text: "#id title[: result | : to name | : 释放原因]"`）；每次变化向订阅的 hub 推 `{event:"board", board:{open, claimed, blocked, done}}`；每次摘要在 fleet 之后带 "The board (…)" 段（open、blocked、claimed 各一行，`liveOrder`）。daemon capabilities 加 `tasks`。
- **工具**：会话 `roost_tasks` `roost_task_claim` `roost_task_done` `roost_task_release` `roost_task_add`；值班 agent `hub_tasks` `hub_task_add` `hub_task_assign` `hub_task_done` `hub_task_drop` `hub_task_release`（`BOARD_TOOLS`，总是激活；prompt：它是组长不是工人——有空闲会话且有开放任务就交出去、任务完成就告诉用户、会话结束就再交出去、从不自己认领）。
- **hub**：`/tasks`（浮层：open 强调色、blocked 警告色带依赖、claimed 弱化、done 最新在前最多 30 条；是打开那一刻的快照）、`/tasks add <title> [after #n …] [-- detail]`（`after` 要带 `#`，"retry after 3" 是标题；正则无嵌套量词）、`assign <id> <session>`、`done <id> [result]`、`rm <id>`、`release <id>`；板上有东西时标题下一行 `tasks 1 open · 1 blocked · /tasks`（来自 `board` 事件，启动时 `task list` 取一次）。
- **SDK**：TS `RoostAgent.call(op, args)` + `tasks/claimTask/taskDone/releaseTask/addTask`；Python `request(op, args, timeout)`（按请求 id 路由应答：`_send(..., waiter)` 在锁内登记、`_message` 先匹配 id、`_drop` 让等待者以 `disconnected` 失败、发送失败时撤销登记；要在第一次 `report()` 建立连接之后用）+ `RoostError(code, message)` + `tasks/claim_task/task_done/release_task/add_task`。协议一致性测试里 TS 与 Python 两个脚本化 agent 各自在板上挂一个任务、认领、完成。
- evals：`evals/tasks.eval.ts`（一个会话按板工作：两个任务、第二个依赖第一个，事件顺序证明 #2 在 #1 完成后才被认领；值班 agent 把任务交给空闲会话、对方认领并完成、它自己一次都没认领）。harness 新增 `tasks`（按位置写依赖），结果带 `board`、`taskEvents`。首轮 2/2、2/2（`docs/plans/m37-evals.md` 的 M47 节）。

移植提示：认领是"活着的会话持有的锁"，关键在 `ownerLive()` 与四处释放（失败/停止、删除、前台断开、启动清扫）；忘了任何一处，任务就会卡死。独立审核在这一步抓出的问题值得记住：没有 peer 的连接默认当 hub（agent 在 report 被接受前就能冒充）、投递 `await` 之后不复查状态、正则嵌套量词回溯。（"另开一条新连接就是 hub"这条路在 Step 47 才堵上一半：hub 专属 op 拒绝已表明身份的连接。）

### Step 47：任务板之后的加固（M49，`docs/plans/m49-hardening.md`）

M47 上线时只跑了通用压测和普通审查。这一步专门压任务板、并让独立审查以攻击者视角打 daemon，再修它找出的问题。

- **压测 `board` 场景**（默认集合，`--tasks 120`，每第五个任务依赖前一个）：所有 agent 同时抢（从前三个 open 里随机挑、做完再挑），1.5 s 时 SIGKILL daemon 再起。不变量：每个任务完成且只完成一次（事件流和 agent 自己的日志一致）、依赖完成前不被认领、没有认领被释放（所有会话都活着）、交办给"命令"类 job 一律 `unsupported` 且任务不被标记、`tasks.json` id 唯一且 `next` 越过最大 id。压测 agent 是讲协议的命令（`kind: "shell"` + `protocol`），和 `send` 一样，消息层（`holderOf`/`sessionKeyOf`）认为它们没有会话，所以 `assign` 拒绝它们；交办给 pi 会话的路径由 evals 用真模型覆盖。
- **hub 专属 op**：`dispatch stop rm respawn reply pin rename reorder subscribe schedules schedule-* shutdown` 先 `requireHub(conn)`：连接上做过 `hello`/`report`（agent、worker）或 `peer_register`（前台 pi）就回 `unsupported`；`events` `concierge` `concierge-ask` 也拒绝说过 `hello` 的连接。之前前台 pi 的连接能停别的会话、以用户身份回答别人的问题、关掉服务；agent 能改值班 agent 的策略、以用户名义加常备指令。值班 agent 的 `act`（stop/respawn）在策略放行后以 hub 身份执行（内部 `handle()` 传一个去掉 `peer`/`agentSide` 的连接）。**真实客户端本来就各用各的连接**（hub、CLI、pi 的子 agent 面板都另开连接），测试里图省事复用 peer/worker 连接的地方改成各开一条（`comms.test` 的 `hubc()`、`daemon.test` 的 `asWorker()`）。边界：socket 是用户的（0600，所在目录 0700）；新开一条连接且从不表明身份的进程就是 hub——roost 区分 hub 和会话，不把同一用户的进程彼此隔离。
- **socket 上限**：`LineReader` 只扫描新到的数据找换行（旧实现每个 chunk 都对整段未完成行 `split`，几百 MB 无换行的数据能吃掉几 GB 内存和一个核几分钟），超过上限抛一次 `LineTooLong`、之后不再接收；daemon 上限 4 MiB（`LINE_MAX_REQUEST`，超了断这条连接，服务照常），客户端默认 64 MiB（超了关流而不是在 data 回调里抛）。连接数上限 1024（`CONNS_MAX`）；单连接在途请求 256（`INFLIGHT_MAX`，满了 `pause()` 这条 socket，应答出去再 `resume()`；`pumpLines` 仍按到达顺序启动请求；连接关闭时没开始的行丢弃）；客户端未读超过 16 MiB 就断开（`SEND_BACKLOG_MAX`，不再读的订阅者）。
- **单行文本**：任务标题、常备指令、job 名、前台 pi 与 agent `hello` 的名字进来时折叠成一行（换行、制表符变空格；任务的 detail 和 result 保留换行）；加载手改过的 `tasks.json`/`orders.json` 时也折叠；摘要的渲染函数（`taskLine` `orderLine` `eventLine`）对拿到的一切再折叠一次——之前一个标题能在值班 agent 的摘要里自起一行"Due now: …""Standing orders: …"。
- **畸形请求**：非法 JSON、非对象参数、小数/字符串 id、深嵌套、未知 op——带数字 id 的请求一定得到带 code 的应答，其余丢弃；现在有测试。

**验收**：`comms.test` 的 "M49: hardening the socket and the text"（会话连接与 hello 后的连接碰 hub op 被拒；5 MB 无换行断开该连接而服务仍应答；畸形请求都有 code；标题/指令/名字单行、手改的存储被折叠、摘要里没有伪造行）；`framing.test` 的读取上限与长行分块；`npm run stress` 全绿（含 `board`）。

移植提示：给每个 op 想清楚"谁能调"，并在连接上记住身份（`peer`、`agentSide`）——"没表明身份就是 hub"只在**同一条连接**上判断才成立；所有会被拼进给模型看的文本（摘要、信封）的短字段都要在入口和渲染两处折成一行。

### Step 48：协议 agent 也收消息（M50，`docs/plans/m50-protocol-messages.md`）

M49 的压测发现：任务板的交办（`/tasks assign`、值班 agent 的 `hub_task_assign`）只能发给 pi 会话。协议里从一开始就有 `agent-items` 能力，但 daemon 的消息层按会话文件找人，协议 agent 没有会话文件，于是被排除；客户端也把 agent 项丢了。

- **daemon**：协议 agent 按 job 寻址，键是 `job:<id>`（`recKey(r)`：pi job 用会话文件，协议 job 用 `job:<id>`，普通命令为空）。它因此能持有消息（`holderOf`）、发送与 watch（`sessionKeyOf`）、出现在 `peers` 里、做 `send`/watch 通知/任务板 `assign` 的目标，任务被 drop 或收回时也会被告知。它收不收由 `hello` 的 `agent-items` 决定：没声明的不进 `peers`，发给它的消息、交办、它自己要的 watch 一律立即 `unsupported`（`refusesItems`），而不是在队列里（最多 20 条）永远等；还没连上的（hello 未知）连上时再收。普通命令仍然没有会话。协议 agent 不能 `spawn`（子会话不会出现在任何面板里，`parentOpen` 是 pi 的）。
- **客户端**：TS 的 `onMessage(m)`、Python 的 `on_message(m)`。提供了它，客户端在 hello 里声明 `agent-items` 和 `peers`，每次 report 带 `agentItems: true`；daemon 就在这条连接上推送 agent 项，和回复一起按 seq 顺序、一次一条交给处理函数，各自 `exact` ack，最后完成的 seq 与回复一样记下（重启的 agent 不会收两次）。`AgentMessage`/`Message`：`seq` `kind`（`message` `report` `notice`）`text`（信封：来自谁，不带用户权威）`from`（Python 叫 `sender`）`relation`。另有 `peers()` `send(to, message)` `watch(id, when)`。
- **审查修复**：agent 连上前已排队的项，若它第一次 report 不带 `agentItems`，就丢掉（不会有人 ack，挂着的行永远不会被关闭清理）；agent 自己的 watch 随记录删除（之前按会话文件保存，它没有）；客户端对不处理的 `digest` 也 ack。

**验收**：`daemon.test` 的协议一致性用例（两种客户端）：hub 挂任务并交办给脚本 agent，它作为消息到达，agent 认领并完成，事件流里有交办、没有遗留；`comms.test` 的 "M50"（前台 pi 与协议 agent 按 id 互发并互见于 `peers`、agent watch 一个 job 并被告知、hub drop 它持有的任务时它被告知；没声明 `agent-items` 的不被列出、消息/交办/watch 都被拒且不排队；普通命令仍拒交办；agent 不能 spawn）；`npm run stress` 的 `board` 场景：hub 在抢之前先交办最多 20 个任务，每个送达 agent 的都恰好被做一次（`handed` = `handedSeen`）。

移植提示：消息层的"收件人键"不要绑在某一种 agent 的特征（会话文件）上；能力（收不收）要显式声明，不支持的立即拒绝，不要让队列替它等。

### Step 49：hub 与 CLI 也带请求 ID（M51，`docs/plans/m51-request-ids.md`）

M36 让重发变得安全（同一 `requestId` 的 `reply`/`dispatch` 只执行一次），但只有压测和 evals 带 ID；hub、CLI、pi 的子 agent 面板、`/bg` 都不带，daemon 重启时丢了应答的回复只能显示成错误（发没发出去谁也不知道），手动再发可能排两次（这就是 v0.1.15 限制 23）。

- `lib/client.ts` 的 `requestOnce(via, op, args, {timeoutMs, tag})`：请求带 ID（`newRequestId(tag)`：tag、pid、时间、4 个随机字节，符合 daemon 的规则）；因为连接断了而没有应答（`closed` 错误、socket 错误、连不上）时，用同一个 ID 在 `via()` 给的新连接上重发，等待 200 ms 起翻倍到 2 s，最多 15 s。daemon 明确拒绝（带 code 的应答）不重发。`DaemonClient.isClosed` 表示连接是否已断。
- **拒绝的判定**：只有 daemon 答的才算（`DaemonError.fromDaemon`）；本地产生的 code（比如 `connectOrStart` 的 `start_timeout`）不算，会重试。请求发出后才放弃，错误是 `lost`（可能已被执行），`refusedByDaemon` 对它为假：`/bg`、手机启动、hub 的 adopt 与 fan-out 不会因此删掉会话可能已在用的 worktree。从没发出去：原样抛出原错误。
- **hub**：回复（peek、批量、`/model` `/thinking`、peek 里的 `/compact` 等；Ctrl+Y 采纳建议仍用它自己的 ID）与派发（新会话、`/resume`、fan-out）都走它；`live(deadline)` 最多等 10 s（且不超过请求自己的期限）让 hub 的连接重连，hub 关闭时抛 `GiveUp` 立即停止。peek 回复一次只发一条（重发期间再按 Enter 不做事）；批量回复和 fan-out 遇到第一个没有应答的就停，不再逐个等；重发得到 `duplicate` 显示为已发送。pi 的子 agent 面板（回复）、`/bg` 与手机启动（派发）、`pi-roost reply` 同样走它，各自重连；面板为重发开的连接用完关闭。

**验收**：`request-once.test`（应答丢失后同一 ID 重发、连接被拒、拒绝只发一次、重发时的本地错误重试并以 `lost` 放弃、从未发出则原样抛错、`GiveUp` 立即停止、给定的 ID 保留、超时放弃、ID 合规）；`comms.test` 的 "M51"（写出后连接立刻断开的回复被重发且只排队一次，对着真 daemon）；hub 的测试检查回复都带 ID。

移植提示：幂等键要从**所有**用户入口带上，否则服务端的去重形同虚设；区分"对方拒绝"和"本地没送到/不知道送没送到"，后者绝不能触发清理类的副作用（删 worktree）。

### Step 50：任务板按项目分，依赖完成时通知（M52，`docs/plans/m52-board-projects.md`）

补 M47 任务板的两个缺口：整台机器只有一块板；等依赖的会话只能自己反复看，或靠值班 agent 转告（v0.1.15 限制 31）。

- **项目**：任务有 `project`，即 git 仓库根目录（`lib/board.ts` 的 `projectOf`：从目录往上找 `.git`；worktree 的 `.git` 是文件，指向的 git 目录里的 `commondir` 给出主仓库，所以 roost 的隔离会话与所在仓库共用一块板；bare 仓库的 worktree 归到 bare 仓库本身；没有 `commondir`（如子模块）的就是该检出目录本身；结果都取 realpath），或 `null`（给任何会话）。旧任务没有项目。会话的项目是它工作的目录（job 的目录、前台 pi 的目录；daemon 按目录缓存，只缓存找到的结果，所以后来 `git init` 的目录会被重新识别）。会话只能列、认领、完成、交还本项目的和给任何人的任务；别的项目的对它是 `not_found`（它持有的仍是它的）；它添加的任务属于本项目，仓库外的会话添加的给任何人。
- **hub 与值班 agent** 看全部（`list` 可以用目录指定项目：该项目的加给任何人的）。hub 的 `/tasks` 显示它所在仓库的板（`/tasks all` 看全部；不在仓库里时显示全部），`/tasks add` 加到该仓库；显示的任务属于多个项目时每行带项目名（`[api]`），浮层、摘要、工具里都是。值班 agent 的 `hub_task_add` 有 `project`（目录），不给就是给任何人。`assign` 给一个在任务项目之外工作的会话回 `unsupported`（它认领不了）。
- **可认领通知**：认领因 `blocked` 被拒的会话记进任务的 `waiting`（最多 20，`TASK_WAITING_MAX`）；一个任务 done 或 dropped 时，所有只等它、现在不再等别的的开放任务被"打开"：`waiting` 里的会话、被交办的会话、挂任务的 job（值班 agent 除外）各收到一条来自 `roost` 的消息（"Task #n (title) can be claimed now: #m, which it waited on, is done"），刚完成依赖的那个会话自己不收；`waiting` 清空；事件流记一条 `task` 事件 `why: "open"`。认领成功也清掉 `waiting`。还有别的依赖没完成的不打开。

**验收**：`board.test`（`projectOf`：仓库、子目录、worktree、bare 仓库的 worktree、没有 commondir 的检出、仓库外；一个项目的会话能看到什么；多项目时行带名字）；`comms.test` 的 "M52"（两个仓库加一个 worktree：worktree 里的 pi 看到并认领 api 的和公共的，看不到 web 的，它加的属于 api；hub 按项目列；跨项目交办被拒；被阻塞的会话在依赖完成时被告知、事件流的 `open`、两个依赖的任务只在第二个完成时打开、drop 也打开、完成依赖的会话自己不被告知）；hub 的 `/tasks` 测试；`npm run stress` 的 `board`。

移植提示：项目的判定用宿主已有的工作目录信息即可；git worktree 要读 `commondir`，不要靠路径模式猜；"依赖满足就通知"挂在完成/丢弃这两个状态迁移上，只通知"刚刚转为可认领"的任务，避免重复。

### Step 51：进入会话能看到全部记录，滚到顶按需加载（M53，`docs/plans/m53-earlier-history.md`）

从 hub 进入会话只能看到一部分对话。原因在 pi 而不在 attach：pi 的聊天区从最近一次压缩开始渲染（`buildContextEntries`：压缩摘要、保留的消息、之后的内容），打开、恢复会话时如此，运行中压缩时也会清空聊天区重画；更早的内容在会话文件里，但不在屏幕上，滚轮停在摘要处。（attach 本身带着 pi 的整个画面：全屏 pi 在备用屏上自己维护滚动视图，host 的回放恢复了鼠标模式，滚轮本来就到得了 pi。）

- **行为**：在 roost 跑的会话（worker）里，最近一次压缩之前的消息插在 pi 聊天区之上、标题之下，每次一打（`HISTORY_CHUNK` = 12）：滚动视图每到顶（滚轮、PgUp、Home、拖滚动条），就加载下一批更早的，视图停在原来那几行上，再往上滚就读到新加载的。上面一行写还剩多少（`↑ 28 earlier messages (before compaction): scroll up to load`），全部加载后写 `── the start of the session ──`。屏幕还没满（压缩后聊天很短）时会自动继续加载直到满。用 pi 自己的消息组件画（与 pi 恢复会话时一样：提示、助手文本（按 `hideThinkingBlock` 隐藏思考）、工具调用及结果、`!` 命令、显示的自定义消息、更早压缩和分支的摘要）。运行中再压缩、`/tree` 换分支、换会话（`/new` `/resume`）都从头开始。
- **实现**（`adapters/pi/earlier-history.ts`，由 worker 扩展注册）：`earlierEntries(branch)` 取当前分支上最近一次压缩的第一条保留消息之前的条目（与 pi 的 `buildContextEntries` 同一规则），`historyUnits` 用 pi 导出的 `sessionEntryToContextMessages` 转成消息并把工具调用与结果配对。扩展拿不到聊天容器，于是用一个什么都不画的 widget 的工厂函数拿到 TUI（与 M14 的重绘同一手法）；它第一次渲染时，把历史组件插进 pi 的文档容器、聊天容器之前——文档容器是 TUI 布局根下 primary `ScrollView` 的子节点（`transcriptView`）；关闭时移除。加载：组件渲染时发现视图在顶部，就加一批并把视图下移新增的行数。pi-tui 是先渲染滚动内容、再按内容高度钳位位置、最后平移，所以位置要在这次渲染里改（ScrollView 的 `currentScrollTop` 字段）；没有这个字段的版本在帧后 `scrollTo`。

**验收**：`earlier-history.test`（边界：一次压缩、两次、找不到第一条保留消息；保留与配对的消息；用 pi 组件画；只在顶部加载、每帧只加载一次；开头那行；重置；用 pi-tui 真实的 `ScrollView`/`VStack`：找到滚动视图、历史插在聊天之前、加载一批时聊天停在同一行）。手工：在伪终端里跑真的全屏 pi 1.5.0，一个 40 轮对话压缩到只剩最后一轮的会话：第一帧就显示最新的一条更早消息（屏幕未满），滚轮一路滚到 "the start of the session"。

移植提示：先确认宿主"看不到历史"到底是终端回放的问题还是宿主自己只渲染上下文窗口；后者只能在宿主进程里补。宿主若提供"在聊天区前插入内容"和"滚动位置"的正式扩展接口，就不需要像这里这样走布局树。

### Step 52：任务的工作区，作为数据（M54，`docs/plans/m54-workspace-model.md`；设计见 `docs/plans/ade-roadmap.md`）

"代理开发环境"路线（任务 → 工作区 → 代理干活 → 验证 → 人工评审 → 本地合并）的第一步：任务板先认得"工作区"是什么，并知道依赖它的任务该怎么等。本步不产生任何工作区（M55 才产生），没有工作区的板行为不变。

- **数据**（`lib/board.ts` `TaskWorkspace`）：任务可带 `workspace: {path, branch, baseRef, baseSha, stage, note, verify?, merge?, comments?}`。`stage` 取 `working | verifying | review | merging | conflict | failed | shelved | merged`；`state` 仍是四个值、跟着认领走，`merged` 即 `done`。有工作区的任务以 `stage` 为准。
- **依赖**（`dependencyMet`，`blockedOn`、认领、hub、摘要、M52 的通知都用它）：被丢弃的从不拦；别的项目的拦到 done；有工作区的拦到 **merged**（手工标 done 而没合并的仍拦）；其余拦到 done。通知等待者的消息对已合并的写 `merged`。
- **显示与计数**：`#4 in review · api-fix · title (note)`；被它拦的 `#9 blocked on #4 (in review) · title`，排在摘要和 hub 列表里已认领任务之后。`boardSummary` 多了 `workspaces`（在工作区、未合并、未丢弃；不再算 open/claimed）和 `needsYou`（review、conflict、failed）；摘要行 `2 in workspaces (1 needs you)`；只有工作区在跑时 hub 状态行也显示板。
- **闸门**（审查后）：有工作区的任务不能被不持有它的会话认领、不能 `assign`、不能凭一句话标 `done`（合并才算完成）：回 `unsupported`/`bad_request` 并指向 `/tasks start`；会话的工具不把它列为可认领（`claimable`），M52 的"可认领"消息也跳过它；工作区未合并的 dropped 任务在 200 条上限清扫时不被清掉。
- **存储**：`tasks.json` 写 `version: 2`（`daemon/main.ts` `TASKS_VERSION`）。加载时保留不认识的字段（更新的 daemon 写的）；`parseWorkspace` 规范化（字符串有界、sha 校验、评论最多 200 条）；损坏的（路径非绝对、无分支、未知阶段）保留为 `failed` 加说明，**绝不丢弃**（worktree 里可能有成果）；`merged` 的任务 state 强制为 `done`；`done` 而没合并的改成 `open` + `failed` 加说明。回退到旧 daemon 不受支持（它第一次保存就会丢掉 `workspace` 字段）。
- **协议**：`hello` 的 `capabilities` 多了 `workspaces`；`BoardTask.workspace?`；`board` 事件多了 `workspaces`、`needsYou` 计数（`docs/protocol.md` 已描述）。

**验收标准**：`board.test` 的 "M54: workspaces on the board"（规范化与损坏记录、每条依赖规则、计数、摘要行与行文）；`comms.test` 的 "M54: workspaces load normalised…"（真 daemon 加载含 merged、损坏、手工 done、review 的文件：被 review 中的任务拦住的认领被拒，保存成 version 2 且保留未知字段，`hello` 里有 `workspaces`）。

移植提示：状态机别去扩展原有的 `state`——旧客户端、清扫、通知都依赖它的四个值；把新概念放进一个可忽略的可选字段，由它自己的 `stage` 说话，并在加载时把不一致的记录归一而不是丢掉。

### Step 53：会话自己的斜杠命令，进 peek 的回复框（M61，`docs/plans/m61-session-commands.md`；按用户要求在 M55 之前做）

M61 是用户在 2026-11-06 要求提前做的（和 M48 先于 M47 一样），所以合入顺序是 M54、M61、M55、M56。此前回复框只补全 hub 的命令（M48）；别的 `/…` 当回复发给会话，pi 的 `sendUserMessage(text, {expandPromptTemplates: true})` 本来就会跑扩展命令、skill 和提示模板——缺的是菜单从不列出它们，而 pi 的**内建命令**（`/session` `/tree` `/export`…）由 pi 的交互编辑器处理，`sendUserMessage` 根本不跑。

- **菜单**（输入 `/`，按序、描述里带标签）：`hub`（stop respawn rm pin rename attach model thinking name compact continue log transcript ask）、`pi`（不与 hub 重名的内建命令）、`extension`（会话的扩展命令）、`skill`（`skill:name`）、`prompt`（提示模板）。会话没在跑时把需要它的命令标 `(not running)`，工作中的会话把内建命令标 `(when idle)`；终端 agent（M30 档案）只显示 hub 命令和档案声明的命令。
- **会话的命令表**：worker 在每次 `session_start`（启动、reload、new、resume、fork）把 `pi.getCommands()` 映射成 `{name, description, source: "extension"|"prompt"|"skill"}` 原子写进 job 目录的 `commands.json`（`lib/store.ts` `commandsPath`/`writeCommands`/`readCommands`，最多 300 条，描述单行、≤200 字符）；hub 在 peek 菜单打开时读，按文件 mtime 缓存；没写过的（旧 worker）只列 hub 和 pi 内建。
- **pi 内建命令清单**（`lib/pi-commands.ts`）：pi 不导出清单，所以把 pi 1.5.0 的清单带在代码里，并标明各自怎么跑——`hub`（hub 自己有：`model thinking name compact`，从 pi 组里去掉）、`screen`（跑完有输出：`session export copy reload new clone changelog hotkeys`）、`picker`（在 pi 里开选择器/对话框：`settings scoped-models tree fork resume trust login logout import share bug`）、`confirm`（`quit`，2 s 内再输一次）。`PiCommand.args` 标明哪些带参数（`export import bug login` 及 hub 的四个）：别的命令后面带字，pi 会当提示词发给模型，所以 peek 拒绝；裸的 `/import` 也拒绝（需要路径）；名字按 pi 的写法发（`/Export x` → `/export x`）。测试读已安装 pi 的 `slash-commands.js`，名字增减就失败，pi 升级不会让清单悄悄过期。
- **往 pi 里打字**：host 新增 control op `command`（`lib/hostclient.ts` `HostControlOp`；`{text}`，只对 pi worker，档案 host 拒绝）：单行、以 `/` 开头、**≤500 字符**、无控制字符；host 把它作为 bracketed paste（`ESC[200~`…`ESC[201~`）写入——pi 的编辑器当文本收，不弹补全菜单——再写 `\r` 提交。末尾空格放进 paste 里面（pi 会 trim，结尾 `\` 会让回车变成换行）。hub 在这些情况拒绝并说明原因：不是 pi 会话、没在跑、正在工作或有对话框（`working`，或 `waitingFor: "dialog"`；`blocked` 等问题/首条提示的会话编辑器是空的，可以）、有人 attach（host 的 `status` 有 `attached`；host 在写入那一刻再查一次，hub 的 `status` 可能过期）。`screen` 命令等约 800 ms 取 host 的 `snapshot`，显示在覆盖层里（标题是命令，`r` 重载，Esc 关闭）；`picker` 命令输入后 attach，让选择器直接在用户面前。扩展命令、skill、提示模板仍当回复发，提示写 `/name · session`。从 peek 一次只跑一个内建命令；没有 host 的前台 pi 提示去那边跑。
- **档案**：agent 档案可声明 `commands: [{name, description?}]`（≤100 条，`lib/profiles.ts` 校验），在 peek 菜单里列在档案名下，Enter 把 `/name args` 当回复发（host 照 M30 打进 agent）；hub 经 `adapters/pi/hub-options.ts` 的 `profileCommands` 取。

**验收标准**：`pi-commands.test`（清单与已装 pi 一致）；worker 测试（`session_start` 写 `commands.json`、有界）；`host.test`（档案 host 拒绝 `command`、非单行斜杠文本拒绝、pi host 写 bracketed paste 加 `\r`）；`agent-view.test`（菜单四组按序带标签；`(not running)`/`(when idle)`；idle 行 `/session` 先 `command` 再 `snapshot` 并开覆盖层；`/tree` 先 `command` 再 attach；`/quit` 需第二次；工作中/已 attach/档案行的拒绝；扩展命令当回复发；档案声明的命令被列出并当回复发）。手工：对着真 pi 1.5.0 粘贴 `/session` 再回车，显示会话信息。

移植提示：宿主的内建命令若不对扩展开放，就只能"替用户在编辑器里打字"——用 bracketed paste 避免触发补全，并在写入那一刻（不是更早）确认没人在用编辑器。

### Step 54：`/tasks start` 与 `/tasks merge`（M55，`docs/plans/m55-start-merge.md`）

任务有了自己的 worktree 和会话（`start`），会话说完成时进 review（`done`），人在 hub 里把它在本地合进基线分支（`merge`）；不 push。验证留给 M56，界面留给 M57–M58。

- **start**（hub/CLI，`task {action:"start", id, workspace, launch}`）：hub 取任务的项目（仓库根）和基线（主检出当前分支，`git symbolic-ref --short HEAD`；detached HEAD、bare 仓库、没有项目的任务一律拒绝），用 `createTaskWorktree`（`lib/task-git.ts`）建 worktree：tag `t<id>-<slug>-<4 hex>`（hex 之前最多 32 字符），放主检出的 `.pi/worktrees/` 下，分支 `roost/<tag>`，从基线的头开始，`.worktreeinclude` 照常复制。再像 `/new` 一样构造 pi 启动参数（模型、thinking、agent），首条提示是任务（标题、细节、完成时怎么做）。daemon 校验任务（open、没有活的持有者、不被阻塞、没被丢弃或完成、在仓库里）和工作区（`validWorktree`、launch 的 cwd 在其内、分支 `roost/t<id>-…`、`baseRef` 是分支名、`baseSha` 是提交号），派发 job 时在记录上写 `task: <id>` 而**不**写 `job.worktree`（所以删 job 绝不删 worktree），为它认领任务并置 `stage: working`；被拒就让 hub 丢掉刚建的 worktree。已有工作区而没有活持有者的任务再 `start`，在同一 worktree 里派发新会话（提示说"已有成果：先看 `git log` 和对基线的 diff"），并重新检查 worktree。worker 对任务 worktree 里的会话加提示（`lib/worktree.ts` `taskWorktreeNote`：任务、分支、"在此分支提交，然后 `roost_task_done`"）。
- **done → review**：持有任务的会话 `done`：worktree 必须干净（`git status --porcelain` 为空，忽略文件除外），否则 `bad_request`"commit your work first"；然后 `stage: review`、`note: "not verified"`、保存结果、`task` 事件（`why: "stage"`）、计入 `needsYou`。hub 和值班 agent 仍不能标 done。`roost_task_done` 的工具回话说明"进入评审，由人合并"（`adapters/pi/agent-tools.ts`）。
- **merge**（只有 hub/CLI；值班 agent 和会话回 `unsupported`；从 `review`、已解决的 `conflict` 或重试的 `failed`）：在**每仓库一把锁**下（daemon 内一个，加 git common dir 里独占创建的 `roost-merge.lock`，用后删除；超过 10 分钟的陈旧锁被接管）：① 同步：在 worktree 里 `git merge --no-edit <baseRef>`，冲突则 `stage: conflict`、冲突文件进 note、基线不动；已解决的冲突（没有 `MERGE_HEAD` 且基线是 `HEAD` 的祖先）继续；然后检查 worktree 干净、`user.name`/`user.email` 已设。② 意图：在碰基线之前写 `workspace.merge = {tip, oldBase, at}`。③ 进基线：基线分支无论在哪个检出（`git worktree list --porcelain`），该检出须干净（否则退回 `review` 并说在哪），然后 `git merge --ff-only <branch>` 或 `git merge --no-ff --no-edit <branch>`（config `taskMerge`：`"ff"` 默认 / `"no-ff"`）；基线不在任何检出时用 `git update-ref refs/heads/<baseRef> <tip> <oldBase>`。基线在同步后动了（ff 被拒、update-ref 失败）则回到 ①，最多 `MERGE_TRIES`（3）次，之后退回 `review` 说"base keeps moving"；钩子等别的失败：基线仍是 `oldBase` 则退回 `review` 带 git 的消息，基线已含 tip 则当作已合并。④ 记 `into`、`stage: merged`、`state: done`、发事件、通知依赖它的会话（M52 的消息写 "merged"），然后清理：worktree 干净就删，分支只在确认其 tip 已在基线后才 `-D`。⑤ daemon 启动时找到 `merging` 的任务并结算：记录的 tip 已在基线 → merged（并清理），否则 `review` 带 "merge interrupted"。
- **back / abort / commit / drop**：`back`（hub、值班 agent）置 `stage: working`，活着的持有者收到带 note 的消息，没有活会话则提示 `/tasks start`；`abort`（hub）在 `conflict` 时 `git merge --abort` 回 `review`；`commit`（hub）`git add -A && git commit -m <message 或 "work on #id">`，同步中（`MERGE_HEAD`）拒绝；有工作区的任务被 `drop`：worktree 干净就删（分支保留），否则留着并在回复里说在哪。
- **审查后**：每个任务的工作区一次只做一件事（两次 start、合并期间的 drop/`back` 回 `conflict`；merging 的任务不能 drop；同一仓库同时第二次 merge 也回 `conflict`，锁文件挡另一个 daemon）；损坏记录（无路径、路径已不在）绝不进 git（`commit` `merge` `abort` 拒绝，否则 `git -C ""` 会在 daemon 自己的目录里跑）；合并的是分支（`refs/heads/<branch>`），且只在 worktree 仍在该分支上时：被换到 detached HEAD 或别的分支则退回 review 带说明；merge 抛异常也立即按重启的规则结算，绝不停在 `merging`；`git status` 等都关掉可选锁，不与 agent 同时的提交抢 index.lock；合并后若仍有会话在那个 worktree 里，worktree 保留（目录不能在它脚下消失），并告诉它任务已合并，worktree 和分支留到手工删除（M59 的 `/tasks cleanup` 列出并清理，v0.1.19 起已有）。与计划文的出入：先同步再查干净（冲突的同步本来就脏）；`no-ff` 需要基线有检出（基线不在任何检出时更新必然是快进）；重启结算不去 abort `MERGE_HEAD`（`merging` 只在干净同步之后才会到）。
- **范围外**：值班 agent 的 `hub_task_start`（需要 daemon 向 hub 发请求，尚不存在，移到 M57）；bare 仓库不支持 start；CLI 的 `pi-roost tasks …` 不变，入口是 hub 的 `/tasks start | merge | back | abort | commit`。`lib/worktree.ts` 把 `addWorktree` 抽出来给会话的 worktree 和任务的共用。

**验收标准**：`task-git.test`（真仓库：tag 预算；从当前分支建、detached HEAD 拒绝；同步干净/冲突/已解决；ff、no-ff、合并中基线移动、检出不干净、基线在别的 worktree、基线不在任何检出（update-ref）、会失败的 `pre-merge-commit` 钩子、手工合并过的分支；合并后清理删分支；锁）；`comms.test`（真 daemon：start 派发进 worktree 并认领；被阻塞的任务和坏工作区被拒；有改动的 done 被拒、干净后进 review；hub 能 merge，会话和值班 agent 被拒；依赖者收到 "merged"；带 `merging` 任务重启后结算）。

移植提示：合并的原则是"永远不在主检出里解决冲突、永远不丢未进基线的提交"：先在任务自己的 worktree 里同步，碰基线前写下意图（tip、旧基线），崩溃后凭意图和"tip 是否已在基线"结算，而不是猜；分支只在确认 tip 已在基线后才删。

### Step 55：合并前验证、项目配置与信任（M56，`docs/plans/m56-verify.md`）

会话说完成时，在任务的 worktree 里跑仓库的 `verify` 命令；评审只看通过的成果，失败退回会话；仓库要求 roost 运行的每条命令都要人批准。

- **配置**（`lib/project-config.ts`）：`.roost/project.json` 从**仓库基线分支**读（`git cat-file -e` 再 `git show <baseRef>:.roost/project.json`），绝不从任务 worktree 读（agent 能改它）：`verify`、`setup`（命令，≤2000 字符）、`verifyTimeout`（秒，默认 600，最大 3600）、`maxRounds`（默认 3，1–10）。缺失或无效的文件等于没有配置（无效时有说明）。个人覆盖 `<roostHome>/projects/<仓库路径 sha256 前 16 hex>.json` 逐字段优先，其命令同样要批准。
- **信任**：`<roostHome>/approvals.json` 按仓库记每条已批准命令文本的 sha256。未批准的命令不运行：`verify` 未批准 → 任务进 `review` 带 "not verified: /tasks approve N to run `npm test`"；`setup` 未批准 → 会话不带它启动并说明。`/tasks approve N`（只有 hub）先完整显示命令（dry 调用返回命令的 hash，批准要带回这个 hash，期间基线上的命令变了 daemon 回 `conflict`，因为 agent 能移动基线分支），用户键入即批准；措辞诚实：批准让命令在你的账户下运行，它调用的东西（`package.json` 脚本、测试文件）不在 hash 覆盖内。显示后的批准窗口 `APPROVE_MS` = 30 s（`hub/agent-view.ts`）。值班 agent 永远不批准。
- **verify**：会话的 `roost_task_done`（worktree 干净）在配置了且已批准 verify 时把任务置 `verifying`，保存结果。它作为 **shell job** 在 worktree 里跑，名 `verify #N`：`/bin/sh -c 'exec >"$ROOST_VERIFY_LOG" 2>&1` 换行 + 命令（整个脚本的输出进日志；最初把重定向放在命令后面，`a; b >log` 只记 `b`，测试抓到了），用户的环境策略和 `workspaceEnv`（`envPolicy(loadUserConfig())`，同 hub 的 `!` 命令），外加 `ROOST_TASK_ID` `ROOST_WORKTREE` `ROOST_BRANCH` `ROOST_BASE`；日志 `<roostHome>/verify/<任务 id>-<轮次>.log`。每个仓库同时最多 `VERIFY_SLOTS`（2）个，其余在 `verifying` 里排队（note "queued"），一个结束再起；槽位的计数与占用在同一步完成，不会两个都看到最后一个空位。超时停掉 job，算失败 "timed out after Ns"。退出码 0 → `review`，note "verified: <命令> (Ns)"，`workspace.verify = {ok, at, log, tail, rounds}`；否则轮次 +1：低于 `maxRounds` 回 `working`，会话收到日志最后 40 行（≤4000 字符）和"fix it, commit, then roost_task_done again"；到 `maxRounds`（或没有活会话）则 `failed`，计入 `needsYou`。结果记下时 `verify #N` 行消失。daemon 重启发现 `verifying` 而没有 verify job（运行或排队）→ `review` 带 "not verified (interrupted)"，重启遗留的 verify/setup job 被停掉并移除。
- **`/tasks verify N`**（hub）从 review 或 failed 重跑，轮次清零；**`/tasks pass N`**（hub）把 failed 记为 review 带 "passed by hand"，失败计数重来。`/tasks merge` 在 M56 里不再重跑 verify（"基线动了再验"留给 M58）。
- **setup**：`/tasks start` 的**首次**启动（不是再启动）在配置了且已批准 `setup` 时，先在新 worktree 里以 shell job `setup #N` 运行，退出码 0 才派发会话（此时 `start` 的结果没有 `job`，会话随后到）；失败 → `failed`、note "setup failed: <最后一行>"、保留日志和 worktree。待派发的 launch 只在内存里，setup 期间 daemon 重启 → `failed` 带 "setup interrupted: /tasks start again"。setup 运行期间 `start` 被拒。
- **审查后**：drop 一个正在 verify/setup 的任务会停掉 job 并保留 worktree，之后才结束的 job 绝不改写已 drop 任务的阶段；同一任务第二个 `done` 在第一个处理期间被拒；无法派发的 verify/setup 把任务留在 `failed`/`review` 并说明原因。未改变的：命令拿到的是经用户策略过滤的 daemon 环境；**verify 日志不清理**（v0.1.19 的 M59 起 `/tasks cleanup yes` 会清已完成、已丢弃的任务的日志）；排队中的 verify 只有 `drop` 能取消。
- **范围外**：teardown；基线移动后合并前重验；值班 agent 批准（信任是人的事，永不）。
- **一个教训**：一个单测把示例命令（`... && npm test`）真跑了，而 `npm test` 又跑了这个测试：fork 炸弹。这里的测试**从不**运行真的测试命令。

**验收标准**：`project-config.test`（从分支而非 worktree 读、无效文件、覆盖、批准的往返、tail 助手）；`comms.test`（真 daemon、真仓库：done → verifying → 退出 0 进 review；失败带 tail 退回再到 `maxRounds` 后 failed；未批准 → review 带说明；approve 后 verify 才跑；两个排队；超时；`verifying` 时重启 → review；setup 先于会话运行、setup 失败 → failed；pass）。

移植提示：被信任的命令必须来自 agent **改不了**的地方（基线分支，不是它的 worktree），批准的是"你看到的那段文本"（hash 对账），并且验证命令的输出落文件、只把结尾交回会话。

### Step 56：工作区总览与值班 agent 的 `hub_task_start`（M57，`docs/plans/m57-workspace-overlay.md`）

把"任务 → worktree → 评审 → 合并"的流水线做成 hub 里的一个界面：一眼看出什么在等你，并用按键推进。本步没有新的数据，只读 M54 的 `workspace` 加 git。

- **入口**：`/workspaces`（`/ws`）打开覆盖层，列当前仓库的任务（不在仓库里则列所有项目的）；`Ctrl+N` 打开并停在下一个需要你的任务（hub 列表里；覆盖层里按 `n`）。有任务在工作区时，hub 的板头行写 `Ctrl+N workspaces`，有任务需要你时用警告色。
- **分组与顺序**（`lib/workspace-view.ts`）：REVIEW；CONFLICT · FAILED；VERIFYING；WORKING（含 merging）；OPEN（仓库里没有工作区的开放任务，附持有它的 `· after #4`）；SHELVED；MERGED（最近一天的，新的在前，最多 10 条：`WS_MERGED_MS` = 1 天、`WS_MERGED_MAX` = 10）。组内按 id。图标：`◆` review、`✕` conflict 或 failed、`⧗` verifying、`●` 会话在干活、`◐` 会话在问（等你）、`○` 空闲或没有会话、`·` 开放、`–` shelved、`✓` merged；颜色只是补充。"需要你"= review、conflict、failed，加上会话在提问的 working 任务。
- **详情**：任务细节、阶段与 note、分支与基线、会话（名字与状态，或已不在）、相对基线的改动、verify 结果（失败给最后三行）、合并提交、文件（放得下多少列多少）、会话最后一句话、结果。宽度不到 **100 列**时详情移到列表下方（各占一半），选中项始终可见，按键行与提示留在底部。每一行都按宽度截断（测试覆盖 8–120 列）。
- **改动怎么读**（`lib/task-git.ts` `taskChanges(path, baseRef)`）：基线取 `git merge-base HEAD refs/heads/<baseRef>`（分支与基线的共同祖先，所以基线自己后来的提交不算），然后并行跑 `diff --numstat -M -z`、`diff --name-status -M -z`、`ls-files --others --exclude-standard -z`、`rev-list --count base..HEAD`、`status --porcelain`；已提交和未提交的都算，改名写成 `a → b`，未跟踪文件按新增，另给基线没有的提交数和是否有未提交内容。git 说不清（worktree 没了、没有基线）就是 `undefined`。不拿可选锁，不抢 agent 的 index.lock。总览里每个任务在阶段、note 或 verify 变了时重读，或超过 5 s 时重读；`r` 强制重读。覆盖层跟着 `board` 事件重载（同一时间只载一次，载入期间又来的事件或动作在这次之后再载一次，因为在途的应答可能早于变化）。
- **按键**（每个字母不同，只有选中任务当前阶段有的才显示、才生效；都等于 `/tasks <动词> <id>`，同样的检查、同样的消息）：`s` start（开放任务，或有工作区而没有活会话的任务再启动）、`m` merge、`b` back（先写一行 note，回车）、`v` verify、`p` pass（failed）、`x` abort（冲突的同步）、`a` approve（先完整显示仓库的命令，再按 `y`；其他键都算否，连按两次 `a` 不算批准，批准带的是当时显示内容的 hash）、`t`/`→`/Enter attach 到它的会话（Enter 在 M58 里改为进评审）、`n` 下一个需要你的、`r` 重载、Esc 关闭。`b` 的 note 属于写它的那个任务，不管输入期间选中项因重载移到哪里。覆盖层若被别的覆盖层顶替而没关，就不再跟随板；`Ctrl+N` 在第一次还在载入时再按不会多开。
- **值班 agent 的 `hub_task_start`**（`adapters/pi/concierge.ts`，加入 `ACT_TOOLS`，所以只有 `/concierge act on` 才可用）：值班 agent **在自己的进程里**用 `createTaskWorktree` 建 worktree、用 `buildLaunch`（`taskPrompt` 作首条提示）构造 pi 启动参数，再发 `task {action:"start", workspace, launch}`；任务已有工作区（没有活持有者）就复用它，不再新建。拒绝的 start 会丢掉刚建的 worktree（`refusedByDaemon` 才丢，网络错误之类不丢）。daemon 这边：值班 agent 的 `start` 在 `act` 开着时放行，否则回 `policy`（会话和其他人仍回 `unsupported`）；对新的工作区额外校验 `baseSha` 在 `refs/heads/<baseRef>` 上且在 worktree 的 `HEAD` 之下（调用方，包括值班 agent，不能指定别的分支去合并）；去掉 launch 环境里值班 agent 的角色变量和任何 job 的身份变量（`ROOST_JOB*`、`PI_ROOST_SOCKET` 之类）、拒绝档案（只起 pi 会话）、`origin` 记为 `dispatch`、清掉 `requestId`；记一条 `concierge` 事件（`why: "act"`，"started #N (…) in 分支"）。提示词写明：用户要求或有常备指令才启动，合并永远是用户的。
- **与路线图的出入**：路线图（M55 的范围外一节）原本让 hub 代为执行，需要 daemon 向 hub 发请求，这个通道不存在；实际做法是值班 agent 自己在进程里建 worktree 和 launch（git 步骤和 launch 构造本来就在 `lib/`），daemon 仍做 start 的全部检查。**已知缺口**：daemon 把值班 agent 的 launch（argv、`sessionFile`、环境策略）在上述校验之后原样收下（和 M45 起的 `hub_dispatch` 一样）；由 daemon 为值班 agent 重建 launch 留给 M59 加固（**已在 v0.1.19 做了**，见 Step 58）。
- **范围外**：diff 与评论（M58）、搁置（`h`，M59）、鼠标。

**验收标准**：`workspace-view.test`（分组与顺序、已合并的窗口与上限、图标、下一个需要你（回绕、会话在问）、各阶段的按键、详情行、一行）；`task-git.test` 的 `taskChanges`（真仓库：已提交与未提交、新文件、任务自己改名的文件、基线上改名的文件、基线自己的提交不计入、没有基线）；`agent-view.test`（`/workspaces` 宽屏并排、窄屏上下，`Ctrl+N` 停在下一个需要你的，`n` 回绕，`m`、带 note 的 `b`、开放任务的 `s`，阶段没有的键不动作，板头提示）；`comms.test`（值班 agent 的 start 在没有 act 时被拒、有 act 时放行，job 环境里没有值班 agent 的角色，会话被拒）。

移植提示：总览只是 `/tasks` 的一层皮，所有动作都走同一套 op，界面不自己决定什么能做；"相对基线改了什么"要用共同祖先而不是基线当前的头，否则基线前进会让每个任务看起来都"删除"了别人的改动。

### Step 57：评审——diff、行评论与退回（M58，`docs/plans/m58-review.md`）

在 hub 里看一个任务相对基线的 diff，在行上写评论，一次性连同退回发给会话；终端里有同样的 `pi-roost review`。合并前的重新 verify 不在本步（基线动了，验证仍由人按 `v`）。

- **入口**：总览里选中任务按 Enter，或 `/tasks review <id>`；Esc 回总览（从总览进来的话）。键：`j`/`k` 行、`n`/`p` 上/下一个 hunk、`]`/`[` 下/上一个文件、`c` 在光标行写评论、`d` 删该行最后一条、`b` 退回（写 note，回车）、`m` 合并、`r` 重载。`m`/`b` 之后评审关闭；合并或退回没成功（冲突、被拒）则评审保持打开，忙时的 Enter 保留已键入的文字；载入失败回总览；载入期间再按 Enter 不会多开。评审打开时光标在 diff 的第一行，`]` 落在文件第一行，`p` 去的是上一个 hunk（不是停在当前这个）。
- **diff**（`lib/task-diff.ts` `taskDiff(path, baseRef)`）：从分支与基线的共同祖先（`merge-base HEAD refs/heads/<base>`）到工作树，`git diff -M`，所以已提交和未提交的都在、基线自己后来的提交不在；未跟踪文件当新文件；忽略 `diff.noprefix` 和外部 diff 驱动。按文件、按 hunk 显示，行号是新版本的（被删的行用旧版本的）；改名写 `old → new`；二进制文件一行；变更超过 **2000 行**或 **256 KiB** 的文件只显示一行说明（"用编辑器打开"）；整个 diff 最多读 **4 MiB**（超过则 `truncated`，显示"cut short"）；单行最多 2000 字符再按宽度用 `…` 截断，不折行；tab 显示为四个空格，控制字符显示为空格。没有 hunk 的文件会说明原因（只改名、空文件、只改权限）。
- **评论**（`lib/board.ts` `ReviewComment` `{file, line, text, lineText, tip, at}`）：`lineText` 是该行的种类加内容（`+drop table users;`），`tip` 是评论时的提交。评论落在"文件相同、行号相同、且（若存了 `lineText`）内容相同"的行下面（`lib/review.ts` `commentOn`）；对不上的是**过期评论**（outdated）：列在文件顶部，保留不丢。指向已不在 diff 里的文件的评论，在最后一个文件之后单独占一页，`d` 在那里也能删。
- **daemon**（`task comment` / `task uncomment`，只有人——hub 或 CLI；会话和值班 agent 回 `unsupported`；已 merged 的任务回 `bad_request`）：`comment {file, line ≥ 1, text, lineText?, tip?}`，文件名 ≤ 4096、文本走 `taskText`（`TASK_TEXT_MAX`）、`lineText` ≤ 1000、`tip` 必须是 sha；每个任务最多 **200** 条（`REVIEW_COMMENTS_MAX`），满了让先退回；`at` 取 `max(now, 上一条的 at + 1)`，所以同一任务里唯一。`uncomment {comment: {file, line, at}}` 用文件、行号和时间指名（不用列表下标，hub 看到的列表可能已变），找不到回 `not_found`。结果 `note` 是"N comments"。
- **退回**（M55 的 `back` 增强）：评论随消息发给活着的持有会话（`reviewText`：每条 `- 文件:行 (行内容前 120 字符): 评论`，总长 ≤ **4000** 字符 `REVIEW_TEXT_MAX`，放不下的计入"… and N more comments, sent with the next send-back"）。**只清掉真正送达的**：`tellOwner` 现在被等待并返回是否送达/排队；不收消息的会话（回 false）评论保留，note 说明；放不下的几条留给下一次退回，note 数出来。note 形如 `sent back (2 comments): …`。没有活会话时评论保留，下一次 `/tasks start` 把它们写进会话首条提示（`taskPrompt`："The review asks for changes…"），且只清掉提示里实际带上的那几条（同一份列表、同一个截断）。
- **CLI**：`pi-roost review <id>` 打印 diff 与评论（文件、hunk、行下评论、过期评论、不在 diff 里的文件的评论）；`review <id> comment <file>:<line> <text>` 取新版本里该行号的行（只有新版本没有时才取被删的行），不在 diff 里的行拒绝；`review <id> back [note]`。打印时名字和评论里的控制字符（C0、DEL、C1、换行）一律换成空格（`termText`）。
- **范围外**：合并前基线移动后的重新 verify；并排 diff；行区间评论；语法着色。

**验收标准**：`task-diff.test`（解析器：改名、二进制、带引号的路径、末尾无换行、省略的计数、只改权限、各上限；真仓库上的 `taskDiff`：基线后来的提交不计入、未跟踪、二进制、摘要、含空格和非 ASCII 的名字）；`review.test`（评论的位置、过期评论、打印的评审）；`agent-view.test`（总览 Enter 进评审、移动、`c` 发出的内容、评论在行下、`d`、`]` 到二进制文件、Esc 回总览、带 note 的 `b`、`/tasks review`、10–120 列各宽度）；`comms.test`（hub 加评论，会话和坏输入被拒，`uncomment`，`back` 把评论发给会话并清掉）。

移植提示：评论要同时记行号和行内容，行动了就标过期而不是悄悄挂到别的行上或丢掉；"清掉已发送的评论"必须以送达为准，而且按对象身份（不是下标），因为发送期间别的评论可能进来。

### Step 58：搁置、清理遗留、`/tasks` 进每个 pi 会话与加固（M59，`docs/plans/m59-shelve-cleanup.md`）

任务可以先放一边再取回；循环留下的东西可以清掉；手工合并的分支能被认出来；任务板成为每个 pi 会话的命令（手机经 pi-mobile 也能用）；值班 agent 开的会话由 daemon 按值班 agent 自己的启动方式重建。本步还包含对 M54–M59 整条循环的对抗性审查结果（见"审查后"）。

- **搁置**（`task shelve {id}`，hub 总览 `h` / `/tasks shelve <id>` / pi 里的 `/tasks shelve`；**只有人**，会话和值班 agent 回 `unsupported`）：只能从 review、failed、或没有活会话的 working 搁置；会话在跑、有 verify/setup 在跑或排队、worktree 有未提交的改动都拒绝（改动要先 `/tasks commit`）。做法：`removeTaskWorktree`（`git worktree remove`，**只删干净的**；目录已不在则只 `prune`）；分支和任务记录留着；认领交还（`state: open`、owner 清空）；阶段 `shelved`，note `on the shelf: branch … kept`。已搁置的任务除 `start`（和评论）外所有动作都拒绝并说明。`start` 用 `restoreTaskWorktree` 在**原路径**从分支重新 `git worktree add <path> <branch>`（`.worktreeinclude` 照常复制），然后像普通 start 一样起会话；hub、pi 命令、值班 agent 三条路都先恢复。已搁置任务上的评论保留，下一次 start 的提示带上；搁置被中途打断（worktree 已删而阶段没改）下次再搁置即可；start 发现 worktree 不在（无论什么阶段）会从分支重建，start 被拒时再删掉。setup 在会话派发之前一直占着位置，期间不能搁置或再 start。
- **手工合并**（`settleHandMerges`，任务板被列出时最多每 10 s 检查一次，`PI_ROOST_HAND_MERGE_MS` 可调）：阶段为 review/failed/conflict/shelved 的任务，若**分支仍在"送去评审的那个提交"**（`workspace.reviewTip`，会话的 `done` 时记录）、该提交带有自己在基线旧提交之上的提交（`tip !== baseSha` 且 `baseSha` 是它的祖先）、已在基线里、worktree（若在）干净，就当作合并：记 `merge {tip, oldBase, at}`，走与 `/tasks merge` 相同的收尾（`finishMerge`：通知依赖它的任务、没有会话在里面则清 worktree 和分支），note "merged by hand"。被重置到基线上的分支、评审后又动过的分支**不算**合并。检查不在独立的定时器上，靠任务板的列出（hub 每次变化都会列）。
- **清理**（`task cleanup {dry?}`，没有 `id`；**只有人**，会话、值班 agent 回 `unsupported`；`/tasks cleanup` 列出，`/tasks cleanup yes` 执行）：(1) 已丢弃任务的 worktree（只删干净的，**分支保留**，里面可能有成果）；(2) 已合并但因当时有会话而留下的 worktree（连同分支，前提是它的提交确认在基线里，`cleanupMergedTask`）；(3) 没有任何任务持有的任务分支（`roost/t<id>-…`）的 worktree（任务已被清掉，或 start 没来得及记下工作区）：只处理 `.pi/worktrees` 之内的、**创建不满 10 分钟的不动**（用目录 mtime 判断，防止撞上刚建好、工作区还没记下的 start），只删干净的，分支保留；(4) 任务已完成、丢弃或已不存在的 verify 日志。**绝不**删有改动的 worktree（列为 kept）、未合并的分支、会话或命令正在用的东西（有 `workspaceBusy`/verify/setup 在跑或认领它的会话还活着的任务整个跳过）。没有东西可清时回 `nothing left behind`。
- **`/tasks` 进每个 pi 会话**（`adapters/pi/tasks-command.ts`，在 `adapters/pi/index.ts` 注册；`adapters/pi/task-start.ts` 是从 pi 进程里建/恢复 worktree 并构造 launch 的共用部分，值班 agent 的 `hub_task_start` 也改用它）：它在**自己的连接**上以"人"的身份说话（未注册为会话的连接，与 hub、CLI 同一类）。无参数列出会话所在仓库的任务板（图标与阶段）；动词 `start` `merge` `back <id> [note]` `verify` `pass` `shelve` `approve` `pr` `cleanup [yes]`。`approve` 与 `pr` 先显示再让同一条命令在 **30 s** 内重复一次才执行（批准和确认都带 hash）；用法串在 `TASKS_USAGE`。理由：斜杠命令是人敲的——pi 不会执行模型写出来的斜杠命令。手机上的 pi-mobile 会话于是同样能用。
- **值班 agent 开的会话由 daemon 重建**（`conciergeLaunch`，补上 M57 留下的缺口，`hub_dispatch` 和 `hub_task_start` 都走它）：daemon 用**值班 agent 自己 job 的启动方式**（pi 程序和它的标志、环境，去掉角色与 job 身份变量，环境策略）重建要开的会话；只从值班 agent 提交的 launch 里取：任务（`--` 之后的那个参数）、`cwd`（必须是存在的绝对目录）、新的会话文件（绝对路径、`.jsonl`、不存在、没有别的 job 用）、名字、形状合规的 model（`provider/id`）与 thinking。它给的 argv、其他标志、环境、`envForce`/`envDeny`、agent、档案、worktree 一概不用；值班 agent 自己的 launch 未知（不是 pi 会话）则拒绝。
- **一个子会话（或值班 agent 开的会话）的首条消息只能是任务文本**（`firstMessage`，高危发现）：会话原本可以 `roost_spawn` 一个子会话，让它的首条消息是 `/tasks merge 5`——pi 会把以 `/` 开头的首条消息当命令执行，而 pi 里的 `/tasks` 以"人"的身份说话，等于会话自己合并了自己的任务。现在 daemon 在 `spawnChild`、值班 agent 的 start/dispatch 里要求 launch 的命令是"`--` 后恰好一个参数"，且该参数不得以（可带前导空白的）`/`、`!`、`@` 开头，否则 `bad_request`。到会话输入的其他途径本来就是人的：回复由 hub 发出，定时任务是用户的，值班 agent 对会话的回答拒绝以 `/`、`!` 开头的命令。
- **已知边界（说明而非改动）**：socket 的信任边界是"未注册为会话的连接就是人"——有 shell 的 agent 可以自己开一个连接，或者直接 `git merge`；pi-roost 的规则管的是经过它的工具的事。搁置或清理时 worktree 里被忽略的文件（`.env`、构建产物）会随之消失，恢复只复制 `.worktreeinclude`；清理只给被 pi-roost 起的 `.pi/worktrees` 之内的；新会话文件只检查（绝对、`.jsonl`、新、无人用），不限定在 pi 的会话目录里。
- **范围外**：手机上的"需要你"推送——pi-mobile 的通知跟随它自己会话的状态（会话在提问），"一个任务在 review"不是在提问的会话，需要 pi-mobile 的契约（今天只有 `pi-mobile:starters` 和 `pi-mobile:activity`）增加一条通道，那是 pi-mobile 的事；`.roost/project.json` 的 `teardown` 命令；PR 出口留给 M60。

**验收标准**：`task-git.test`（只删干净的 worktree 且保留分支、从分支恢复、列出任务 worktree）；`comms.test`（会话在跑和有改动时搁置被拒；搁置后 worktree 没了、分支在、merge 被拒、start 带回；手工合并的分支在下一次列出时被标为合并并放行它的依赖；cleanup 的 dry 与真实执行——丢弃的、孤儿的、有改动的保留、日志——对会话被拒；值班 agent 的 launch 由它自己的重建（程序、标志、`--` 后的任务），已存在的会话文件被拒；子会话首条消息以 `/` `!` `@` 开头被拒；分支重置到基线上不算手工合并）；`tasks-command.test`（pi 命令：板、merge 的错误、带 note 的 back、shelve、approve 两次、cleanup、用法）；`agent-view.test`（`/tasks shelve`、`/tasks cleanup [yes]`、已搁置任务的 start 先恢复 worktree）。

移植提示：凡是"人才能做"的动作，信任依据必须是**来源通道**而不是消息内容；而模型能影响的每一个文本入口（首条消息、转述、给会话的回答）都要保证不会被宿主当成命令执行。守卫放在 daemon，不放在各个调用方里。

### Step 59：可选出口——PR 与重叠标记（M60，`docs/plans/m60-exits.md`）

本地合并是循环的终点；PR 是人可以改走的另一个出口；总览还会提示"两个在做的任务改了同一批文件"。这是 ADE 路线的最后一步。

- **`task pr {id, dry?, hash?}`**（hub 总览 `o` 再 `y` / `/tasks pr <id>` 再敲一次（30 s 内）/ pi 里的 `/tasks pr`；**只有人**，会话、值班 agent、协议 agent 都回 `unsupported`）：只能从 review，且 worktree 干净。**先展示后执行**：`dry` 调用回 `note`（`push <分支> at <提交前 8 位> to <remote> (<推送 URL>) and open a pull request into <基线> on <owner/repo>`，或"gh picks the repository"）和 `hash`；确认调用必须带这个 `hash`，不一致就 `conflict`（"the branch or its remote changed since it was shown"）。**hash 覆盖四样东西**：分支提交（tip）、remote 名、remote 的推送 URL、gh 将要用的仓库（`commandHash(tip \n remote \n url \n repo)`）。
- **去哪里**（`lib/task-git.ts` `prTarget`）：remote 是 `origin`，没有就取唯一的一个（多个而没有 origin、或一个都没有：拒绝）；名字必须匹配 `^(?!-)[A-Za-z0-9._/-]{1,100}$`（可能被读成 git 选项的拒绝，推送时命令行里还加 `--`）；URL 取 `git remote get-url --push`（`pushurl` 和 `insteadOf` 都算——agent 能改 `.git/config`，所以展示的必须是实际推送的地方）；`ghRepoOf(url)` 从 URL 里解出 `owner/repo`（非 github.com 带主机名；https/ssh/scp 形式；不是论坛 URL 则无 `--repo`，由 gh 自己选）。
- **做什么**（`openTaskPr`）：`git push --set-upstream -- <remote> <tip>:refs/heads/<分支>`（**推的是展示过的那个提交，不是推送时分支的当前位置**——仍然活着的会话可能在其间又提交；从不 force），超时 **120 s**；然后在 worktree 里 `gh pr create --head <分支> --base <基线> --title <任务标题> --body <详情、结果、verify 是否通过、"Task #N, opened by pi-roost.">`（有 `repo` 时加 `--repo`），超时 **60 s**。失败要说清是哪一步（推送还是 gh）和 git/gh 的原话；gh 说已有的 PR、或先前开成了但被超时打断的，用 `gh pr view <分支>` 找到并记录，所以失败后再试一次能成功。只记录 `https://` 且无控制字符的 URL；git、gh、钩子的输出都截成一行并去掉控制字符（C0 与 C1）。
- **任务仍在 review**：记 `workspace.pr = {url, tip, at}`，note `pull request: <url>`，事件 `pr`；PR 是出口而不是阶段。note 只在任务此时仍在 review 且没被丢弃时才写（推送要花时间）。在论坛上合并并拉回基线后，M59 的手工合并识别会在下次列板时发现它。
- **重叠**（`lib/workspace-view.ts` `overlaps`）：同一仓库内同时在做（working、verifying、review、要修的 fix）的任务，若总览读到的改动文件有交集（改名取新名），该行标 `⚠`，详情写 `overlap #6 changes src/rate.ts too`（最多列 3 个文件）；已合并的任务不参与；不同仓库不比较。详情里还有 PR 一行。
- **审查后保留的已知问题（说明而非改动）**：`git push` 会执行仓库的 `pre-push` 钩子（同一账户下的 agent 能写一个，就像它能运行任何程序）；推送带上分支上远端缺少的所有提交，包括基线本地领先的那些。
- **范围外**：每个工作区一段端口（`ROOST_PORT`）——路线图写的是"如果 setup 到时需要"，没有人需要，没做；PR 开出之后的状态（M16 显示的是会话的 PR，不是任务的）。

**验收标准**：`comms.test`（review 之前、对会话都被拒；dry 的 note；错误的 hash 被拒；真往一个 bare remote 推送，PATH 上放一个假 `gh`，断言它收到的参数和 body；任务保持阶段并记下 PR）；`workspace-view.test`（重叠：只比同仓库、改名、已合并的不参与；详情的重叠与 PR 行；review 阶段的 `o` 键）；`agent-view.test`、`tasks-command.test`（`/tasks pr` 敲两次；`o` 再 `y`）。

移植提示：确认必须绑定"你看到的"——提交、地点、将用的仓库——任何一样在展示与执行之间变了就拒绝；地点要读**实际生效**的配置（推送 URL），不要读名字；推送要推展示过的提交而不是名字指向的当前位置。

---

## 5. 配置项（`lib/config.ts`）

用户级 `roost.json`（`~/.config/roost/roost.json` 存在即用，否则 `~/.pi/agent/roost.json`；只读其一，不合并），项目级 `.roost/roost.json`（存在即用，否则 `.pi/roost.json`）可覆盖**部分**键：

| 键 | 默认 | 仅用户级 |
|---|---|---|
| `fullscreen` | `true` | |
| `rowDetails` | `true` | |
| `worktreeIsolation` | `"off"`（取值 `"off"` / `"children"` / `"all"`，M10） | |
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
| `autoResume`（M38） | `"interrupted"`（另有 `"crash"`、`"off"`） | （不在 `USER_ONLY` 里，但 daemon 只读用户文件：`loadUserConfig().autoResume`，项目文件里写了没有效果） |
| `presets`（M27） | 无；`{名字: {model thinking worktree agent dir fanout profile}}`。**用户文件与项目文件都能写，按名字合并，项目的优先**；畸形条目跳过；`/preset save` 只写用户文件 | |
| `agentProfiles`（M30） | 无；`{档案名: {command task model thinking resume working waiting submit settleMs env protocol commands}}`（`commands`，M61：≤100 条 `{name, description?}`），见 Step 29 | ✔（项目文件不能定义，因为档案是 roost 要运行的命令） |
| `taskMerge`（M55） | `"ff"`（另有 `"no-ff"`：`/tasks merge` 总是做合并提交，需要基线分支有检出） | |
| `concierge`（M44–M46） | 无；`{model: "anthropic/claude-haiku-5-5", thinking: "off", wakesPerHour: 60, heartbeat: "every 15m", dailyBudgetUsd: 1, answer: "never", act: false}`，见 Step 42–43；`answer`/`act` 只是初值，之后由 daemon 保存（`concierge.json`） | ✔ |

> 表中"仅用户级"的集合就是 `lib/config.ts` 的 `USER_ONLY`：`envAllowList inheritEnv envDenyList workspaceEnv summaryModel agentExternalMessages agentMaxDepth agentMaxChildren agentMaxTree agentMaxTotal agentProfiles concierge`（v0.1.12 起含 `agentProfiles`，M30 加的；v0.1.14 起含 `concierge`，M44 加的）。`presets` 和 `autoResume` **不在**其中。（v0.1.5 的旧表把 `agentTools` 也标成了仅用户级，那是错的。）`inheritEnv:false` 时 `envPolicy()` 会把 `workspaceEnv` 强制成 `"off"`。

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
| 视图与 daemon 对账间隔（M22） | 15 s | `hub/agent-view.ts` `RESYNC_MS` |
| `ensureLive` 里 respawn 的超时（M22） | 20 s | `lib/resume.ts` `RESPAWN_TIMEOUT_MS` |
| Reporter 失败退避（M22） | 500 ms 翻倍至 5 s | `lib/agent-client.ts` `retryMs` |
| Reporter 请求超时 / 关闭时最终 flush（M22/M31） | 4 s / 500 ms | `agent-client.ts` `REQUEST_TIMEOUT_MS` / `FINAL_FLUSH_MS` |
| 每 session 用量里保留的模型数（M24） | 8（其余并入 `other`） | `lib/usage.ts` `USAGE_MODELS` |
| 自动续跑间隔，连续最多几次（M38） | 1 s / 5 s / 15 s，共 3 次 | `daemon/main.ts` `RESUME_DELAYS_MS`（`PI_ROOST_RESUME_DELAYS_MS`，逗号分隔毫秒） |
| 宕机/重启后仍会自动续跑的最长间隔（M38） | 6 h | `daemon/main.ts` `RESUME_WINDOW_MS` |
| 定时任务检查间隔（M39） | 15 s | `daemon/main.ts` `SCHEDULE_TICK_MS`（`PI_ROOST_SCHEDULE_TICK_MS`） |
| 定时运行/子 agent done 后自动关闭的等待（M13/M39/M40） | 3 s（需已 done 满一半） | `daemon/main.ts` `AUTO_CLOSE_MS`（`PI_ROOST_AUTO_CLOSE_MS`），`scheduleAutoClose()` 对定时运行同样适用 |
| 一个计划的 `every` 最小间隔（M39） | 1 min | `lib/schedule.ts` `parseWhen` |
| 下次运行至少领先现在（M39） | 1 s | `daemon/main.ts` `runSchedule`（`Math.max(next, now + 1000)`） |
| 档案 `settleMs` 默认 / 范围（M30） | 3000 ms / 500–60000 | `lib/profiles.ts` |
| host 写 `term.json` 的间隔（M30） | 1 s（有变化时） | `host/main.ts` `termTimer` |
| host `input` op 单次上限（M30） | 64 KB | `host/main.ts` `MAX_INPUT` |
| 打字回复里文本与 `submit` 的间隔（M30） | 约 150 ms | `daemon/main.ts` `typeInto` |
| 每个 job 记住的回复请求 ID（M36） | 100 个 | `daemon/main.ts` `MAX_REQUEST_IDS` |
| 待投递回复上限 | 50 条（`full` 错误码） | `docs/protocol.md` |
| 对 live host 的 token 复查间隔（M35） | 30 s | `daemon/main.ts` `HOST_VERIFY_MS` |
| 并行 fsync 的文件数上限（M35） | 32 | `lib/atomic.ts` `SYNC_PARALLEL` |
| telemetry 文件写入批次（M34） | 250 ms 或满 1000 条 | `lib/telemetry.ts` `fileTelemetry` |
| 压测预算（M35） | dispatch p95 3000 ms；全部就绪 30 s + 200 ms×job 数；ack p95 3000 ms；hub 事件延迟 p95 1000 ms；daemon RSS 400 MB | `stress/run.ts` `BUDGET` |
| eval 单用例时限 / "沉寂"判定（M37） | 180 s / 3 s | `evals/harness.ts` `runCase` |
| 事件日志保留 / 单条文本上限（M43） | 1000 条 / 300 字符 | `lib/events.ts` `EVENT_LOG_MAX` / `EVENT_TEXT_MAX` |
| watch 过期 / 每会话上限（M43） | 12 h / 20 | `lib/comms.ts` `WATCH_TTL_MS`（`PI_ROOST_WATCH_TTL_MS`）/ `MAX_WATCHES` |
| 重复消息窗口（M43） | 60 s | `lib/comms.ts` `DUPLICATE_WINDOW_MS` |
| 值班 agent 唤醒合并 / 投递失败重试 / 节拍（M44） | 5 s / 60 s / 30 s | `daemon/main.ts` `CONCIERGE_COALESCE_MS` `CONCIERGE_RETRY_MS` `CONCIERGE_TICK_MS`（各有 `PI_ROOST_CONCIERGE_*` 变量；`PI_ROOST_CONCIERGE_HEARTBEAT_MS` 覆盖心跳） |
| 值班 agent 默认每小时唤醒 / 心跳 / 日预算（M44） | 60 次 / `every 15m` / 1 美元 | `lib/concierge.ts` `CONCIERGE_DEFAULTS` |
| `?` 提问等待回答（M44） | 2 min | `hub/agent-view.ts` `asked()` |
| 代答在状态行显示（M45） | 60 s | `hub/agent-view.ts` `conciergeLine()` |
| 常备指令上限 / 单条长度（M46） | 50 / 500 | `lib/concierge.ts` `ORDER_MAX` / `ORDER_TEXT_MAX` |
| 任务板上限 / 标题 / 细节与结果（M47） | 200 / 200 / 2000 | `lib/board.ts` `TASK_MAX` `TASK_TITLE_MAX` `TASK_TEXT_MAX` |
| 前台 pi 断开后认领保留（M47） | 5 s | `daemon/main.ts` `FG_CLAIM_GRACE_MS`（`PI_ROOST_FG_CLAIM_GRACE_MS`） |
| peek 记录尾读取 / 刷新（M48） | 末尾 256 KB / 2 s | `hub/agent-view.ts`（`readTail`） |
| 请求单行上限（daemon / 客户端，M49） | 4 MiB / 64 MiB | `daemon/main.ts` `LINE_MAX_REQUEST` / `lib/protocol.ts` `LINE_MAX` |
| 连接数 / 单连接在途请求 / 未读积压（M49） | 1024 / 256 / 16 MiB | `daemon/main.ts` `CONNS_MAX` `INFLIGHT_MAX` `SEND_BACKLOG_MAX` |
| 协议 agent 未连上时排队的消息（M50） | 20 | `daemon/main.ts`（与 pi 会话的消息队列同一上限） |
| 请求重发：总时长 / 间隔（M51） | 15 s / 200 ms 翻倍到 2 s | `lib/client.ts` `requestOnce`（`timeoutMs`） |
| hub 等连接恢复（M51） | 10 s（且不超过请求期限） | `hub/agent-view.ts` `live()` |
| 等待可认领的会话（每个任务，M52） | 20 | `lib/board.ts` `TASK_WAITING_MAX` |
| 目录到项目的缓存（M52） | 500 条（满了清空；只缓存找到的） | `daemon/main.ts` `projectAt` |
| 滚到顶一次加载的更早消息（M53） | 12 | `adapters/pi/earlier-history.ts` `HISTORY_CHUNK` |
| `tasks.json` 版本（M54） | 2 | `daemon/main.ts` `TASKS_VERSION` |
| 每个仓库同时跑的 verify 数（M56） | 2 | `daemon/main.ts` `VERIFY_SLOTS` |
| 合并时基线移动后的重试次数（M55） | 3 | `daemon/main.ts` `MERGE_TRIES` |
| 合并锁陈旧阈值（M55） | 10 min（600 000 ms） | `lib/task-git.ts` `withMergeLock(staleMs)` |
| `/tasks approve` 显示后的批准窗口（M56） | 30 s | `hub/agent-view.ts` `APPROVE_MS` |
| `verifyTimeout` 默认 / 上限（M56） | 600 s / 3600 s | `lib/project-config.ts` `VERIFY_TIMEOUT_DEFAULT` / `VERIFY_TIMEOUT_MAX` |
| `maxRounds` 默认 / 上限（M56） | 3 / 10 | `lib/project-config.ts` `MAX_ROUNDS_DEFAULT` / `MAX_ROUNDS_MAX` |
| 项目配置里一条命令的长度（M56） | 2000 字符 | `lib/project-config.ts` `COMMAND_MAX` |
| 任务工作区的 note / 评论条数（M54） | 500 字符 / 200 条 | `lib/board.ts` `TASK_NOTE_MAX` / `parseWorkspace` |
| host `command` op 的文本上限（M61） | 500 字符（单行、以 `/` 开头、无控制字符） | `host/main.ts` |
| 会话 `commands.json` 的条数上限（M61） | 300（描述 ≤200 字符） | `lib/pi-commands.ts` `MAX_SESSION_COMMANDS` |
| 档案声明的命令数上限（M61） | 100 | `lib/profiles.ts` |
| 评审里一个文件的变更行数 / 字节上限（M58） | 2000 行 / 256 KiB（超过只显示一行说明） | `lib/task-diff.ts` `DIFF_FILE_MAX_LINES` / `DIFF_FILE_MAX_BYTES` |
| 评审一次读取的 diff 总量（M58） | 4 MiB（超过则 `truncated`） | `lib/task-diff.ts` `DIFF_TOTAL_MAX_BYTES` |
| 评审里单行的字符上限（M58） | 2000（显示时再按宽度用 `…` 截断） | `lib/task-diff.ts` `DIFF_LINE_MAX` |
| 一个任务的评审评论条数（M58） | 200 | `lib/board.ts` `REVIEW_COMMENTS_MAX` |
| 退回时发给会话的评论文本（M58） | 4000 字符（放不下的留给下一次退回） | `lib/board.ts` `REVIEW_TEXT_MAX` |
| 总览里已合并任务的数量 / 时间窗（M57） | 10 条 / 1 天 | `lib/workspace-view.ts` `WS_MERGED_MAX` / `WS_MERGED_MS` |
| 总览改为上下排版的宽度（M57） | 小于 100 列 | `hub/agent-view.ts`（`width >= 100` 才并排） |
| 手工合并的检查间隔（M59） | 10 s（`PI_ROOST_HAND_MERGE_MS`） | `daemon` `settleHandMerges` |
| 清理不动多新的无主 worktree（M59） | 10 min（按目录 mtime） | `daemon` `cleanupLeftovers` |
| `/tasks approve` / `/tasks pr` 再敲一次的窗口（M59/M60） | 30 s | `adapters/pi/tasks-command.ts` `APPROVE_MS`、`hub/agent-view.ts` |
| PR 的 `git push` / `gh` 超时（M60） | 120 s / 60 s | `lib/task-git.ts` `openTaskPr` |
| 删除 worktree 的 `git worktree remove` 超时（M59） | 30 s | `lib/task-git.ts` `removeTaskWorktree` |

调试用环境变量：`PI_ROOST_HOME` `PI_ROOST_RUNTIME_DIR` `PI_ROOST_CONFIG_DIR` `PI_ROOST_HOST_ENTRY` `PI_ROOST_REAP_MINUTES` `PI_ROOST_REAP_CHECK_MS` `PI_ROOST_SHELL_KEEP_MS` `PI_ROOST_PROGRESS_MS` `PI_ROOST_FIRST_PROGRESS_MS`；v0.1.7 新增：`PI_ROOST_AUTO_CLOSE_MS`（M13）、`PI_ROOST_CLEANUP_DAYS` `PI_ROOST_CLEANUP_CHECK_MS`（M15）、`PI_ROOST_PR_POLL_MS` `PI_ROOST_GH`（M16，`gh` 可执行文件路径）——测试全靠它们把时间缩短、把目录隔离到临时路径、用假的 `gh`。（内部标记变量 `PI_ROOST_RESTORE`、`PI_ROOST_CHILD` 见 §3。）

v0.1.12 新增：`ROOST_HOME` `ROOST_RUNTIME_DIR` `ROOST_CONFIG_DIR`（M29，分别优先于 `PI_ROOST_*` 同名）；`PI_ROOST_RESUME_DELAYS_MS`（M38）；`PI_ROOST_SCHEDULE_TICK_MS`（M39）；`ROOST_TELEMETRY=<绝对路径.jsonl>`（M34，需在启动 daemon 前设）；`ROOST_PI_PACKAGE`（M33，独立 hub 找 pi 的包）；`ROOST_EVAL_MODEL` `ROOST_EVAL_THINKING` `ROOST_EVAL_RUNS` `ROOST_EVAL_SECOND_MODEL` `ROOST_EVAL_DIR` `ROOST_EVAL_KEEP`（M37/M41）；跑测试时的 `STRESS=1`（`test/stress-attach.test.ts` 从 60 轮加到 600 轮）。

v0.1.14 新增：`PI_ROOST_WATCH_TTL_MS`（M43）；`PI_ROOST_CONCIERGE_COALESCE_MS` `PI_ROOST_CONCIERGE_RETRY_MS` `PI_ROOST_CONCIERGE_TICK_MS` `PI_ROOST_CONCIERGE_HEARTBEAT_MS`（M44）；`ROOST_ROLE=concierge`（M44，hub 为值班 agent 构造启动参数时写进 env，`adapters/pi/hub-options.ts`；pi 扩展据此换成值班角色，`isConciergeRole()`；daemon 在 `concierge-act` 里会把它从代启动的 env 中去掉）；`PI_ROOST_FG_CLAIM_GRACE_MS`（M47）。

v0.1.19 新增：`PI_ROOST_HAND_MERGE_MS`（M59，手工合并的检查间隔，默认 10000）。

---

## 7. 构建与打包

- Node ≥ 22.19，ESM，源码直接是 `.ts`（`allowImportingTsExtensions` + `erasableSyntaxOnly`：**只用可擦除的 TS 语法**，不能用 enum/namespace/参数属性）。
- 扩展由宿主直接加载 `.ts`；daemon/host/bin 由 `tsc -p tsconfig.build.json` 编译到 `dist/`（`rewriteRelativeImportExtensions` 把 `.ts` 导入改成 `.js`），`scripts/fix-dts.mjs` 修 `.d.ts` 里的导入。宿主不能直接加载 TS 时，扩展也一起编译。
- `lib/client.ts` `packageRoot()` 从模块位置向上找 `package.json` 来定位 `dist/daemon/main.js`、`dist/host/main.js`——**打包目录结构变了要同步改**。
- 本地安装（`scripts/install-local.sh`）：先在旁边建新副本再原子替换（daemon 是懒加载 node-pty 的，不能从半装好的目录运行）；替换前 `daemon stop --keep-workers`，后台会话不断。
- 运行时依赖只有三个：`node-pty`、`@xterm/headless`、`@xterm/addon-serialize`（M21）。CLI、daemon、host 不能引用宿主的包（peer 依赖），`test/cli-deps.test.ts` 守着（M32 起扩成整套分层检查，见 §2）。
- **包导出（M32，`package.json` `exports`）**：`./api`（`dist/adapters/pi/api`，给别的 pi 扩展用）、`./agent`（`dist/lib/agent-client`，协议客户端）、`./client`（`dist/lib/client`，`DaemonClient`）、`./protocol`（`dist/lib/protocol`，类型）、`./package.json`。`bin`：`pi-roost` → `dist/bin/pi-roost.js`。peerDependencies：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`（都是 `*`，不由 roost 安装）。
- **`files` 字段**：`adapters hub extensions lib sdk dist README.md CHANGELOG.md LICENSE`——`extensions/` 只剩一行转发 shim，`sdk/` 带着 Python 客户端。`stress/` 和 `evals/` **不在**发布包里（`vitest-evals` 也只在 devDependencies）。
- **`pi-roost hub` 的入口**（`bin/pi-roost.ts` `cmdHub`）：在**纯 node** 下运行：先 `findPiPackage()` 找 pi 的包（`ROOST_PI_PACKAGE` → PATH 上的 `pi` 沿目录向上 → `npm root -g`），`piCliOf()` 从包的 `bin.pi` 取 CLI，`usePiPackage()` 注册 `node:module` 解析钩子把 `@earendil-works/*` 指向用户的 pi，然后才按路径 `import("../adapters/pi/hub-main.{ts|js}")`（安装版是 `dist/` 里的 `.js`，checkout 里是 `.ts`）。找不到 pi 就报错（点名 `ROOST_PI_PACKAGE`）并以 1 退出。`pi-roost schedule` 子命令同样在纯 node 下，但**添加**计划要在 hub 里（`/schedule`，因为模板要 pi 来生成）。
- **Python SDK**：`sdk/python/roost_agent.py` 单文件、纯标准库（`docs/protocol.md` 写 3.8+），不需要 pip 安装——复制文件或把 `sdk/python` 加进 `PYTHONPATH` 即可。
- 构建：`npm run build` = `tsc -p tsconfig.build.json && node scripts/fix-dts.mjs`；`prepare` 会自动 build；`prepublishOnly` = `check` + `test` + `build`。`npm run stress` / `npm run eval` 都直接 `node stress/run.ts` / `node evals/run.ts`（Node ≥ 22.19 的类型剥离）。

---

## 8. 测试策略

`test/` 下 **49 个** vitest 文件（v0.1.7 时 25 个，v0.1.12 时 38 个；`pool: "forks"`，超时 20 s），移植时建议**先移植测试**：

| 测试 | 覆盖 | 移植难度 |
|---|---|---|
| `framing` `lib-core` `config` `dispatch` `dispatch-input` `view-model` `worker-state` `comms` `fit-screen` | 纯函数 | 直接复用 |
| `list-format`（M15）`pr`（M16：URL 识别、状态判定、`#N` 匹配）`transcript`（M19：分支遍历、截断、转义清理）`agents`（M18：定义发现与优先级、`agentArgs`、`pickAgent`） | 纯函数 / 临时目录里的文件 | 直接复用（`agents` 要换成宿主的定义格式） |
| `workspace-env`（M20） | 真 zsh（隔离 `ZDOTDIR`+precmd 钩子）、假 direnv、会挂住的 rc、tcsh/csh 的 `.cshrc`；never/deny/allowlist 规则 | 需要本机有对应 shell；缺 zsh/tcsh 的环境会跳过相应用例 |
| `worktree` | 在临时 git 仓库上真跑：创建、状态、清理的各种情况、`.worktreeinclude` 复制与"是否算成果"的判断（M15） | 直接复用（需要 git） |
| `daemon` `host` | 用临时目录 + 假 worker 起真 daemon/host；M13 自动关闭与 `parentOpen`、M11 的 `remoteAt` 不被回收、M21 attach 快照（序列截断、模式只计一次、备用屏不覆盖主屏）；`term-modes` 模式跟踪与未完序列 | 改路径/env 前缀即可 |
| `reporter` `reply-queue` `summaries` `worker-wiring` `foreground` `agent-view` `mobile`（M11：只放行 `PI_MOBILE_*`）`subagent-panel`（M12/13：排序、树、`(+N)`、行生命周期、宽度 1–200 不溢出、按键） | 用假的 `ExtensionAPI` 驱动 | 换成你的适配器 mock |

v0.1.8–v0.1.12 新增/扩充的测试（按 `ls test/` 核实）：

| 测试 | 覆盖 | 移植难度 |
|---|---|---|
| `cli-deps`（M32/M33） | CLI/daemon/host 不 import pi 的包；`lib daemon host bin` 不 import `@earendil-works/*` 和 `adapters/`；`hub/` 只许 pi-tui；`extensions/` 只含转发；TS 客户端 import 图只含 node；旧路径加载同一扩展且只注册一次 | 改目录名即可，**强烈建议保留** |
| `stress-attach`（M22/M42） | attach/takeover/断开/改尺寸/不读数据客户端的压力轮次；一个 PTY 在两个会话间用 Ctrl+Z 切换；自己挂起的 worker 被 SIGCONT 救回（`STRESS=1` 加大轮数） | 需要 PTY；假 worker 要像真宿主那样**停止读终端**而不是丢键 |
| `attach-keys`、`client-order`（M22） | detach 键各种编码（`localDetachAt`）；list 回复与事件的顺序（`requestAt`/`position`） | 纯函数/小，直接复用 |
| `term-modes`（M21） | 终端模式跟踪（含被截断的序列、`StreamTail`） | 直接复用 |
| `profiles`（M30） | 档案解析、校验、模板、配置只认用户级；`lib/term-signals.ts` 的测试也在这里：信号收集器对着真 xterm、`inferTermState` 的优先级 | 直接复用 |
| `identity`（M29）、`config` | `ROOST_*`/`PI_*` 并存与优先级、配置路径候选 | 直接复用 |
| `usage`（M24）、`transcript`、`list-format`、`view-model` | 用量口径与列/面板、记录、行格式 | `usage` 的口径要按宿主的会话格式改 |
| `schedule`（M39） | cron 字段与错误、下次运行（周末/月末/闰日/日周任一/never）、`every` 锚点、模板检查、夏令时 | 纯函数，直接复用 |
| `telemetry`（M34） | span/指标/文件 sink、`percentiles` | 直接复用 |
| `evals-judge`（M37） | `checks()` judge 本身（不花钱） | 直接复用 |
| `hub-standalone`（M33） | 找 pi 的包、解析钩子（从 pi 解析、失败回退）、模型列表、配色与 `NO_COLOR`、CLI 错误 | 取决于宿主是否也做独立 hub |
| `daemon`（大幅扩充） | M22 一会话一行；M30 档案 agent（用假终端 agent）；**M31 协议一致性：TS 与 Python 两个客户端各跑一个脚本化 agent 对着真 daemon**；M34 遥测；M35 丢 ack 后重启、崩溃后空 state 文件；M36 请求 ID；M38 续跑；M39 定时；M40 全 agent 续跑与定时 | 改路径/env 前缀即可；Python 一致性用例在没有 python 时跳过 |
| `reporter`（M22 退避）、`reply-queue`（M28 steer）、`agent-view`（M23–M30 的键、`/preset` `/fanout` `/compare` `/usage` `/schedule` `/profile`）、`mobile`、`foreground`… | 用假的 `ExtensionAPI` 驱动 | 换成你的适配器 mock |

v0.1.14 新增/扩充（M43–M48）：

| 测试 | 覆盖 | 移植难度 |
|---|---|---|
| `events`（M43） | `EventLog`：追加、窗口、文件重写、游标与超前游标、`eventLine` | 纯函数/临时文件，直接复用 |
| `comms`（大幅扩充，M43–M48） | 对着真 daemon：watch 的触发与过期、重复消息、速率与队列上限、事件流只给 hub；M44 值班 agent 的 on/off/状态推送、唤醒合并、配额、预算、心跳、`?` 问答；M45 建议/代答闸门/undo/act；M46 指令的存储、闸门、摘要、时钟唤醒、重启；M47 任务板的存储与加载规范化、闸门（含 report 前的连接）、锁与四种释放、接管、上限与清扫、重启、交办消息（含未送达）、drop/release 通知持有者、摘要；M48 行的 `task`/`queued` | 改路径/env 前缀即可 |
| `concierge`（M44–M47） | pi 侧角色：工具注册与按策略激活（含 `BOARD_TOOLS`）、prompt 替换、纯文本回答交回 hub、摘要渲染 | 换成你的适配器 mock |
| `agent-view`（扩充，M43–M48） | `/log`、`/concierge …`、横幅与 Ctrl+Y/E、`/concierge orders`、`/tasks` 与标题计数（含 `after` 正则边角）、peek 的信息/回复框/命令/补全（行选择要跳过分组标题） | 换成你的适配器 mock |
| `daemon` 的协议一致性用例（M31 + M47） | TS 与 Python 脚本化 agent 各在板上挂任务、认领、完成（Python 的应答按请求 id 路由） | 改路径/env 前缀即可 |

v0.1.15 新增（M49）：`comms` 的 "M49: hardening the socket and the text"（hub op 闸门、超长行、畸形请求、单行文本）；`framing` 的 `LineReader` 上限与长行分块。`comms`/`daemon` 里原来一条连接既当会话又当 hub 的用例改成各开一条（`hubc()`、`asWorker()`）。测试总数 433。

v0.1.16 新增（M50–M53）：`comms` 的 "M50"（协议 agent 收发消息、`peers`、watch、交办、拒绝不收的）"M51"（写出后断线的回复只排队一次）"M52"（多仓库与 worktree 的板、可认领通知）；`daemon` 的协议一致性用例改成 hub 交办、agent 收到消息后认领；`request-once.test`（M51）；`board.test`（M52 的 `projectOf` 等纯函数，用真 git）；`earlier-history.test`（M53：边界、用 pi 组件画、在 pi-tui 真实布局帧里的加载与锚定、对着假 pi 的挂载/重置/移除）；测试夹具 `agent-ts.ts`/`agent-py.py` 加了 `onMessage`。测试总数 452。

v0.1.17 新增（M54–M56、M61）：`task-git.test`（M55：真仓库上的 worktree 创建、同步、ff/no-ff/update-ref 合并、移动的基线、钩子失败、清理、合并锁）；`project-config.test`（M56：从基线分支读配置、覆盖、批准、日志尾）；`pi-commands.test`（M61：内建清单对照已安装的 pi）；`board.test` 加 M54 的工作区、依赖与计数；`comms.test` 加 M54 加载规范化、M55 start/done/merge/重启结算、M56 verify/setup/批准/超时/排队；`host.test` 加 `command` op；`worker-wiring.test` 加 `commands.json`；`agent-view.test` 加 M61 的命令菜单与 `/tasks` 新动作；`profiles.test` 加 `commands` 校验。测试从不运行真的测试命令（M56 的 fork 炸弹教训）。测试总数 522（46 个文件）。

v0.1.18 新增（M57–M58）：`workspace-view.test`（M57：分组、顺序、图标、按键、详情）；`task-diff.test`（M58：diff 解析器与真仓库上的 `taskDiff`）；`review.test`（M58：评论位置、过期评论、打印的评审）；`task-git.test` 加 `taskChanges`；`agent-view.test` 加总览（宽/窄、`Ctrl+N`、各键）与评审（移动、评论、退回、各宽度）；`comms.test` 加值班 agent 的 start（有无 act）、评论/`uncomment`、`back` 带评论。测试总数 565（49 个文件）。

v0.1.19 新增（M59–M60）：`tasks-command.test`（M59：pi 里的 `/tasks`：板、merge 的错误、带 note 的 back、shelve、approve 两次、cleanup、用法；M60：`/tasks pr` 两次）；`task-git.test` 加 `removeTaskWorktree`/`restoreTaskWorktree`/`taskWorktrees`；`comms.test` 加搁置（会话在跑/有改动被拒、start 恢复）、手工合并（含分支被重置不算）、cleanup 的 dry 与真实执行、值班 agent 的 launch 由 daemon 重建、子会话首条消息不得以 `/` `!` `@` 开头、`pr`（被拒的情形、dry 的 note、错误的 hash、真推到 bare remote 加假 `gh`）；`workspace-view.test` 加重叠与 PR 行；`agent-view.test` 加 `h`、`o` 再 `y`、`/tasks shelve|cleanup|pr`、已搁置任务的 start 先恢复 worktree。测试从不运行真的测试命令。测试总数 577（50 个文件）。

**单列**：
- `npm run stress`（M35，`stress/run.ts`）：真 daemon + 真 host + 假 agent，场景 `sessions replies chaos board soak`（默认跑前四个；`board` 是 M49 加的），不变量 + 预算，**不花钱**，应当在每次改动 daemon 的存储/事件路径后跑；默认规模约几十秒。
- `npm run eval`（M37/M41，`evals/run.ts`）：**真模型，要花钱，需要凭证**，不属于 `npm test`；每个用例一个隔离的 roost（见 Step 36）。`--runs N` 才能谈稳定性，一次通过不说明稳定。

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
10. 安全模型是**同用户互信**：token 不是安全边界，同用户进程都能读 `state.json`。如果要求多租户隔离，需要重新设计。M49 起 daemon 区分 hub 和会话（会话的连接用不了 hub 专属 op），但一个有 shell 的会话另开一条连接、不表明身份，仍然就是 hub：这是区分，不是沙箱。
11. （M11）被回收的会话会从 pi-mobile 手机列表消失，手机无法唤醒；`/bg` 对手机来说是新会话。
12. （M12/M19）记录视图是全屏浮层而不是原地绘制；展开工具完整输出只能 attach 去看；`context_edit` 未应用，压缩前的消息仍显示。
13. （M13）不按天删除子会话记录，只有 `cleanupDays` 的统一清理；`/tasks` 的"隐藏失败/停止行"没有对应，面板只有一个。
14. （M14）依赖宿主默认全屏且 `tui.stop({preserveScreen:true})` 可用；宿主没有这个选项时 attach 仍会刷屏、闪烁（可退回 resize 抖动，即旧路径）。
15. （M16）PR 状态依赖 `gh`；不支持 GitLab `!N`（glab）；分支查找在会话 cwd 里做，`cd elsewhere && git push` 会在 elsewhere 查；codemode 之外的 shell 类工具看不到。
16. （M17）任务输入框不支持图片粘贴；长单行折行时 ↑↓ 仍按逻辑行在行间移动。
17. （M18）只读 pi-subagents 的定义（`npm/node_modules` 里的包），不支持 chains、skills、runner、`package:` 名字；项目 agent 只能用 `@name` 选；没有选择器 UI 和每 agent 颜色。
18. （M20）工作区环境只支持 zsh/bash/fish/tcsh/csh 的钩子和 direnv 后备，没有 nushell/xonsh/ksh；整份环境存进 `job.json`（0600），respawn 不重读派发者的环境，只重新求工作区那一层；探针运行你的 shell rc，慢 rc 会吃掉启动预算（8 s 封顶）。
19. （M30）**档案 agent 的菜单不能靠打字选**：方向键菜单里打 `2` 不会选第二项，随后的 Enter 反而选了第一项；这类提示要 attach（→）自己回答。回复只适合文本提示。档案 agent 的模型/上下文/用量/记录视图/`/resume`/子 agent/peer 都没有（显示破折号）；档案状态是**推断**，没有正则和通知的 agent 只能靠"屏幕静止"，长时间不刷新屏幕时可能被判成"安静"（用 `working` 正则或调大 `settleMs`）。
20. （M31）协议只是**草案 v1**，在有仓库之外的真实 agent 用过两个客户端之前不冻结；agent 间通信 op（`handback peers send spawn peer_*`）的参数仍以 `lib/protocol.ts` 为准；协议 agent 收消息、`peers`/`send`/`watch` 的客户端用法 M50 起已写进 `docs/protocol.md`。`hello` 对 M31 之前的 daemon 会得到 `bad_request`，客户端按 v1 行为继续。
21. （M33）独立 hub 没有 pi 会话：没有"转后台"，pi 的斜杠命令（skill、prompt 模板）不能当首条提示；它用运行 pi-roost 的那个 node 去跑 pi，pi 若装在另一个 node 版本下且不能在这个 node 下运行就会失败；配色跟 pi 的暗色主题，不跟用户选的主题。
22. （M37/M41）evals **要花钱、要有可用的模型凭证**（`auth.json` 以符号链接接进隔离的 pi 目录）；终端/协议 agent 的用例不报花费；只有 `--runs N` 才能说稳定性；不让模型评判模型，所以只能检查确定性的东西。
23. （M36/M51）请求 ID 只在客户端带了才有用：v0.1.16 起 hub、CLI、子 agent 面板、`/bg`、手机都带；自己写的控制端要自己带（`requestOnce`）。重发最多 15 s，之后放弃的请求报 `lost`（可能已执行），由用户决定是否再发。
24. （M38/M40）续跑**只重启，不恢复中途的工具调用**：重启后给会话发 "Continue where you left off."，由宿主自己看会话记录决定怎么继续（pi 会看到被打断的工具调用并重跑）；不带 `resume` 的终端 agent、普通命令中断后保持 failed；预算只有连续 3 次；宕机后只对最后进展在 6 小时内的运行自动续跑。
25. （M39）定时**只认本地时间**，没有时区选项；cron 只有 5 个字段；夏令时重复的那一小时里不会重复运行，春季不存在的时刻改到次日；一个计划的上一次运行没做完就**跳过**而不是排队；定时模板不带 worktree，不带 fan-out；过去运行的行按 `cleanupDays` 清理。
26. （M22）孤儿进程组的 SIGTSTP 被内核丢弃——宿主若有"Ctrl+Z 挂起自己"，后台 worker 里必须拦下，否则会永久冻结（见 Step 21）。
27. （M29）设计文档（`any-agent.md`）与代码有出入的地方以代码为准：`kind` 仍是 `"pi" | "shell"` 加 `profile`，没有 `agent: string`；档案占位符只有 `{task} {model} {thinking}`，没有 `{session}`；档案状态经 `term.json` 文件由 daemon 读取，而不是 host 推的 `term` 事件。
28. （M44）值班 agent 是**又一个会花钱的会话**：默认 haiku、每小时最多 60 次唤醒、每天 1 美元封顶；预算用完当天不再唤醒，第二天自动恢复；它没有 shell/文件工具，只能看记录尾和屏幕；`?` 的回答靠"用户问题之后的最后一段助手文本"识别，它若在同一轮里既处理摘要又回答，摘要部分会被丢掉。
29. （M45）"常规问题"的判断在 prompt 里，不在代码里：不可逆清单（push/删除/付款/部署/凭据）靠模型遵守，evals 只能抽样验证；`undo` 只是告诉会话"忽略那条"，已经执行的动作撤不回。
30. （M46）常备指令的时钟只认 `lib/schedule.ts` 的词汇；到点唤醒受每小时配额和日预算约束，被压住时随下一次摘要带上（只带一次）；指令"应用过"全靠它自己上报（`hub_note_done`）。
31. （M47）任务板按项目分（M52 起，见限制 35）；任何会话都能把板挂满 200 条开放任务（只清 done/dropped），失控的会话要用户来停；值班 agent 交办只是发消息，对方不认领就一直 `assigned`，hub 里能看到 "handed to … 2m ago"；`/tasks` 浮层是打开时的快照（标题计数是实时的）。
32. （M48）peek 的记录尾只读文件末尾 256 KB，长工具输出会被截去头部；`/` 命令只在 peek 的回复框里按会话解释，任务框里仍是 hub 命令；`!` 在 peek 里拒绝（不会把命令当回复发）。
33. （M49）任务板的 `assign` 和 `send` 一样只能发给有会话的 job：pi 会话、前台 pi，M50 起还有声明了 `agent-items` 的协议 agent；普通命令和没声明的协议 agent 回 `unsupported`；名字和标题被折成一行，`/log` 里多行的问题/结果也显示成一行；连接被暂停（在途请求满 256）时察觉不到对端关闭，直到有应答出去；同一用户的进程能占满 1024 个连接。
34. （M50）协议 agent 的消息按 seq 一次一条交给处理函数，处理函数不返回就不会有下一条（和回复一样）；协议 agent 不能 `spawn`；它的消息队列与 pi 会话一样最多 20 条，没连上时排队，第一次 report 说不收就丢弃。
35. （M52）项目只认 git 仓库（向上找 `.git`，worktree 读 `commondir`）；不在仓库里的会话只看到"给任何人"的任务；会话的项目在任务添加时固定，会话后来换目录不会带走任务（已持有的仍归它）；一个被交办但还没认领的会话换到别的项目后就看不到那个任务了；跨项目交办被拒。
36. （M53）只在 pi 全屏模式（默认）里生效，主屏模式（`tuiMode: "regular"`）和前台 pi 不变；靠 pi 1.5.0 的布局树（primary `ScrollView`、文档容器最后一个子节点是聊天容器、`currentScrollTop` 字段），pi 改了这些就要跟着改；扩展工具的自定义渲染器拿不到，用通用样式；扩展的自定义条目渲染、cache 预热提示不显示；`hideThinkingBlock`/`outputPad` 只在会话开始时读；Ctrl+O 的展开状态按加载那一刻。
37. （M61）peek 里打内建命令时，若会话的 pi 编辑器里还留着上次 attach 没发的草稿（Ctrl+G/← 离开时可能留下），粘贴的命令接在草稿后面，**一起提交**；扩展命令的参数补全没有（pi 只在自己的编辑器里补，菜单只列名字和描述）；pi 的内建清单是写死的 1.5.0 版，靠测试对照已装的 pi 才能发现过期；每个 peek 一次只跑一个内建命令。
38. （M55）`no-ff` 合并需要基线分支在某个检出里（否则只能快进）；合并后若仍有会话在任务的 worktree 里，worktree 和分支留着（目录不能在它脚下消失），要手工 `git worktree remove` / `git branch -d`，或在 v0.1.19 起用 `/tasks cleanup yes`（M59，见第 42 条）；值班 agent 在 `/concierge act on` 时可以 `start` 任务（M57 的 `hub_task_start`，见第 40 条），否则只能 `back` 和发消息；bare 仓库不支持 `start`（没有主检出可分支）；`merge` 只有 hub/CLI，会话和值班 agent 不能合并；回退到 v0.1.16 的 daemon 会在第一次保存时丢掉任务的 `workspace`。
39. （M56）verify 日志（`<roostHome>/verify/`）v0.1.18 之前不清理，v0.1.19 起由 `/tasks cleanup yes` 清掉已完成、已丢弃或任务已不在的那些（M59）；批准的 hash 只覆盖命令文本，不覆盖它调用的脚本和测试文件；命令拿到的是经用户环境策略过滤的 daemon 环境；排队中的 verify 只能靠 `drop` 取消；`merge` 不会因基线移动而重新 verify（M58）；`teardown` 还没有。
40. （M57）值班 agent 的 `hub_task_start` 是在它自己的进程里建 worktree 和 launch 的（路线图原本让 hub 做，见 Step 56）：daemon 校验任务、`baseSha`、去掉角色与 job 身份的环境变量，但**不重建**值班 agent 的 launch（v0.1.18 时 argv、`sessionFile`、环境策略原样收下，同 `hub_dispatch`；**v0.1.19 起已由 daemon 重建**，见 Step 58）；总览里每个任务的改动每 5 s 或在阶段/note/verify 变化时才重读，所以可能略有滞后（`r` 强制）；搁置（`h`）v0.1.19 起有（M59），没有鼠标；总览按仓库分，不在仓库里的 hub 才混列所有项目；已合并的只显示最近一天、最多 10 条。
41. （M58）评审是按文件一页一页看的纯文本 diff：没有并排、没有行区间评论、没有语法着色；评论只挂在一行上，行号和内容都对得上才算在原处，否则标过期（保留，但要人自己对照）；超过 2000 行或 256 KiB 的文件、超过 4 MiB 的整个 diff 不展示（要在编辑器里看）；合并前基线移动后不会自动重新 verify（按 `v` 手动）；评论是人写的：会话和值班 agent 不能加、不能删；不收消息的会话收不到退回的评论，它们留在任务上，等下一次 `/tasks start` 写进首条提示；`pi-roost review ... comment` 只能挂在 diff 里已有的行上。
42. （M59）**信任边界**：socket 上没有注册为会话的连接就是"人"（hub、CLI、pi 的 `/tasks` 命令都是这样）。有 shell 的 agent 可以自己开一个这样的连接，或直接 `git merge`；pi-roost 的规则只管经过它的工具的事，不是沙箱。已堵上的路径是"借一个会话的输入变成人的命令"：子会话/值班 agent 开的会话的首条消息不得以 `/` `!` `@` 开头（`firstMessage`），对会话的回答拒绝命令；到会话输入的其余入口（hub 的回复、用户的定时）本来就是人的。移植时在宿主里要同样检查"宿主会把哪些文本当命令执行"。
43. （M59）搁置或清理 worktree 时，里面被 git 忽略的文件（`.env`、构建产物、依赖目录）随 worktree 一起没了；恢复只复制 `.worktreeinclude` 列出的。只有干净的 worktree 才会被搁置或清理，有未提交改动的一律保留并说明。值班 agent 开会话时的新会话文件只检查（绝对路径、`.jsonl`、不存在、没有别的 job 用），并不限定在 pi 的会话目录里。
44. （M59）手工合并靠任务板被列出时检查（最多每 10 s 一次），没有自己的定时器；只认"送去评审的那个提交"，评审后又动过的分支、被重置到基线上的分支不算合并（要人自己 `/tasks merge` 或丢弃）；清理会删已完成任务的 verify 日志；清理不动创建不满 10 分钟的无主 worktree（它可能属于刚开始的 start）。
45. （M59）手机上"需要你"的推送**没做**：pi-mobile 的通知跟随它自己会话的状态（会话在提问），"任务在 review"不是在提问的会话；要 pi-mobile 的契约（今天只有 `pi-mobile:starters` 和 `pi-mobile:activity`）增加一条通道，那是 pi-mobile 的事。手机上能用的是 `/tasks` 命令本身（pi-mobile 里敲斜杠命令）。`.roost/project.json` 的 `teardown` 命令也没有。
46. （M60）`git push` 会运行仓库的 `pre-push` 钩子（同一账户下的 agent 能写一个，就像它能运行任何程序）；推送带上分支上远端缺少的全部提交，包括基线本地领先的那些；推送 URL 不是论坛 URL 时 `gh` 自己选仓库（展示里写明 "gh picks the repository"）；remote 是 `origin`，否则唯一的一个，多个而没有 origin 就拒绝；PR 开出之后任务就留在 review，PR 的状态（评审、检查、合并）不会回写到任务上——在论坛上合并并拉回基线后才靠手工合并识别；`ROOST_PORT`（每个工作区一段端口）没做；重叠标记依赖总览读到的改动，最多滞后一个重读周期（5 s，`r` 强制）。

---

## 附录 A：daemon op 一览（v0.1.19）

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
| `hello {protocol, agent?, capabilities?}` | agent 客户端（M31） | 每条新连接在第一个 `report` 之前发；回 `{protocol, daemon:{name,version}, capabilities}`；旧 daemon 回 `bad_request` |
| `schedules` | hub/CLI（M39） | 列出计划（`ScheduleRow[]`：`name when task agent cwd model paused catchUp nextAt lastRunAt lastJob lastSkip`） |
| `schedule-add {name, when, launch, task?, catchUp?}` | hub（M39） | 新增计划；同名已存在回 `exists`（先 `rm`）、名字须匹配 `SCHEDULE_NAME`（1–40 字符）、总数上限 100（`limit`）；`launch` 是带 `{{run}}` 的 dispatch 模板 |
| `schedule-rm {name}` `schedule-pause {name, paused}` | hub/CLI（M39） | 删除 / 暂停与恢复 |
| `schedule-run {name}` | hub/CLI（M39） | 立即运行一次，返回 `{name, id}`；上一次还在跑则 `busy` |
| `events {after?, limit?, id?}` | hub/CLI（M43） | 事件流，带游标；会话连接被拒（值班 agent 除外） |
| `watch {id, when}` | 前台/worker（M43） | 一次性 idle/ended 通知 |
| `concierge {action: on {launch?} \| off \| status \| answer {answer} \| act {act} \| undo}` | hub（M44/M45） | 值班 agent 的开关、状态、策略、撤回 |
| `concierge-ask {text}` | hub（M44） | `?` 提问 |
| `concierge-say {kind, text}` `concierge-policy` `concierge-suggest {id, text, why?}` `concierge-reply {id, text, why?}` `concierge-act {what, id \| launch, why?}` | 值班 agent 自己的连接（M44/M45） | 通知/读策略/建议/代答（闸门：`policy`）/启停（闸门：`policy`） |
| `concierge-order {action: add \| rm \| list \| applied}` | hub 与值班 agent（M46） | 常备指令 |
| `task {action: list \| add \| claim \| release \| done \| drop \| assign \| start \| merge \| back \| abort \| commit \| approve \| verify \| pass \| comment \| uncomment}` | 任意（M47）；`merge abort commit approve verify pass comment uncomment` 只有 hub/CLI，`start` 还有值班 agent（M57，需 `act`），`back` 还有值班 agent | 共享任务板；动作者由连接决定，见 Step 46；新动作见 Step 54–55 |

**v0.1.12 的 op 与字段变化**（在上表 v0.1.7 内容之上）：
- **新增 op**：`hello`（M31）、`schedules` `schedule-add` `schedule-rm` `schedule-pause` `schedule-run`（M39）。`lib/protocol.ts` 的 `OpArgs`/`OpResults` 是权威清单。
- **`reply`**：`mode?: "steer" | "followUp"`（M28；缺省 = 等待）、`requestId?`（M36；同 ID 重发只处理一次，应答带 `duplicate:true`）；结果多了 `duplicate?`。`deliver` 事件带 `mode`。
- **`dispatch` 的 `DispatchArgs`** 新增：`fanout`（M26：同一次 fan-out 共享的 id）、`profile` `term` `resumeCommand` `taskInArgv`（M30）、`protocol`（M31）、`resumable`（M40）、`requestId`（M36）；`worktree` 的校验与 M10 相同。
- **`JobRow`** 新增：`usage`（M24）、`fanout`（M26，且 `worktree` 多了 `base`）、`profile`（M29：`"pi"`/`"shell"`/档案名）、`schedule`（M39：由哪个计划起的）、`capabilities`（M31：agent 在 hello 里声明的）。**`resumeAt`、`agentInfo`、`requestIds` 在 `state.json` 里，不在 `JobRow` 上**。
- **`WorkerReport`** 新增：`usage`（M24）；协议文档把 `context` `usage` `prLinks` `remoteAt` 列为 capability 字段，`attachSignal` `attachRepaint` `agentItems` 为 pi 专用。
- **host 帧协议的 control op** 现在是 `detach input snapshot status terminate terminate-idle`：`input {data}`（M30，把文本写进 PTY，仅档案 job，≤64 KB）、`terminate-idle`（M22，只在没人 attach 时停止，由 host 原子判断，有人则回 `{ok:false, attached:true}`）。host 还写 `term.json`（M30）。
- 推送事件 `deliver` 现在是 `{event:"deliver", id, seq, text, kind?, from?, relation?, ref?, mode?}`。

**v0.1.14 的 op 与字段变化**（在上表 v0.1.12 内容之上）：
- **新增 op**：`events` `watch`（M43）、`concierge` `concierge-ask` `concierge-say`（M44）、`concierge-policy` `concierge-suggest` `concierge-reply` `concierge-act`（M45）、`concierge-order`（M46）、`task`（M47）。
- **`JobRow`** 新增：`role`（`"concierge" | null`，M44）、`suggested`（M45）、`task` `queued`（M48）。
- **`send`** 结果的 `outcome` 多了 `"duplicate"`（M43）；`deliver` 的 `kind` 多了 `notice`（M43）和 `digest`（M44）。
- **推送事件**新增：`{event:"concierge", status}`（M44）、`{event:"board", board}`（M47）。
- **事件流**的 `kind`：`dispatch state reply message report notice resume schedule removed concierge task`。
- **daemon capabilities**：`replies steer agent-items peers spawn handback events watch tasks`。
- **文件**（都在 roost home）：`events.jsonl`（M43）、`watches.json`（M43）、`concierge.json`（M44）、`orders.json`（M46）、`tasks.json`（M47）。
- **错误码**新增用法：`policy`（M45，策略不允许）、`conflict` `blocked`（M47，认领）、`unauthorized`（M47，没有被接受的 report 的 agent 连接碰任务板）。

**v0.1.15 的变化**（M49，没有新 op）：
- `dispatch stop rm respawn reply pin rename reorder subscribe schedules schedule-add schedule-rm schedule-pause schedule-run shutdown` 在做过 `hello`/`report`/`peer_register` 的连接上回 `unsupported`；`events` `concierge` `concierge-ask` 也拒绝说过 `hello` 的连接。
- 请求行最长 4 MiB（超了断开连接）；最多 1024 个连接；单连接在途 256 个请求；未读积压 16 MiB 断开。
- `task add` 的标题、`concierge-order add` 的文本、`dispatch` 的名字、`peer_register`/`hello` 的名字折成一行（`dispatch` 名字最长 200）。

**v0.1.16 的变化**（M50–M53，没有新 op）：
- **协议 agent 是消息的收件人**（M50）：按 `job:<id>` 寻址；`hello` 的 `capabilities` 含 `agent-items` 才收，含 `peers` 才能列出；`report` 带 `agentItems: true`。`send` `peers` `watch` 与 `task assign` 都可以指向它；不收的立即 `unsupported`；它不能 `spawn`。
- **`reply` 与 `dispatch` 的 `requestId`**（M51）：hub、CLI、面板、`/bg`、手机都带；没有新字段。
- **`task`**（M52）：`list {project?}`（hub 与值班 agent 用绝对路径指定项目，否则 `bad_request`）、`add {project?}`；`BoardTask` 新增 `project`（仓库根或 `null`）与 `waiting`（`{id,name}[]`）；会话只能动本项目和给任何人的任务（别的回 `not_found`）；`assign` 给别的项目的会话回 `unsupported`；`claim` 回 `blocked` 时把会话记进 `waiting`。事件流 `task` 的 `why` 多了 `open`（`who: "roost"`）。
- M53 只在 pi 扩展里，没有协议变化。

**v0.1.17 的变化**（M54–M56、M61，没有新 op，`task` 多了动作）：
- **`task` 的新动作**（M55/M56）：`start {id, workspace:{path,branch,baseRef,baseSha}, launch}`（结果带 `job`；首次启动且有已批准的 `setup` 时结果没有 `job`）、`merge {id, mode?: "ff"|"no-ff"}`、`back {id, note?}`、`abort {id}`、`commit {id, message?}`、`approve {id, dry?, hash?}`（结果的 `hash` 是显示过的命令的 hash）、`verify {id}`、`pass {id}`；结果多了 `job?`、`note?`、`hash?`。
- **`hello` 的 capabilities** 多了 `workspaces`（daemon 现在是 `replies steer agent-items peers spawn handback events watch tasks workspaces`）。
- **`BoardTask`** 新增 `workspace?`（M54）；**`board` 事件**多了 `workspaces`、`needsYou` 计数；事件流 `task` 的 `why` 多了 `stage`。`tasks.json` 是 version 2。
- **`JobRow`/job 记录**：job 记录新增 `task`（M55，为任务在其 worktree 里启动的会话，不带 `worktree`）、`verifyOf`/`setupOf`（M56，那些 shell job 属于哪个任务）；roost home 新增 `approvals.json`、`projects/<hash>.json`、`verify/<id>-<round>.log`；job 目录新增 `commands.json`（M61）。
- **host 帧协议 control op** 多了 `command {text}`（M61，仅 pi worker，≤500 字符的单行斜杠命令，bracketed paste + `\r`）。
- **config**：`taskMerge`（M55）；`.roost/project.json`（M56，从基线分支读）；档案的 `commands`（M61）。

**v0.1.18 的变化**（M57–M58，没有新 op，`task` 多了动作）：
- **`task` 的新动作**（M58）：`comment {id, comment:{file, line, text, lineText?, tip?}}`、`uncomment {id, comment:{file, line, at}}`（只有人：hub、CLI；已 merged 的任务拒绝；每任务最多 200 条）；`back` 现在把评论随消息发给持有者并清掉送达的，没有活会话则留给下一次 `start` 的提示。
- **值班 agent 可以 `start`**（M57）：`act` 开着时放行，否则回 `policy`；新工作区的 `baseSha` 要在 `refs/heads/<baseRef>` 上且在 worktree 的 `HEAD` 之下；launch 的值班 agent 角色和 job 身份环境变量被去掉，档案被拒；记一条 `concierge` 事件（`why: "act"`）。
- **`BoardTask.workspace.comments`**（M58，`ReviewComment {file, line, text, lineText, tip, at}`）；`docs/protocol.md` 已描述。
- **CLI**：`pi-roost review <id>`、`review <id> comment <file>:<line> <text>`、`review <id> back [note]`（M58）。hub 新增 `/workspaces`（`/ws`）、`Ctrl+N`、`/tasks review <id>`。
- **值班 agent 的工具**：`hub_task_start`（M57，在 `ACT_TOOLS` 里）。

**v0.1.19 的变化**（M59–M60，没有新 op，`task` 多了动作）：
- **`task` 的新动作**（M59/M60，都只有人——hub、CLI、pi 里的 `/tasks`；会话、值班 agent、协议 agent 回 `unsupported`）：`shelve {id}`（从 review/failed/无会话的 working；删干净的 worktree、留分支，阶段 `shelved`、认领交还；`start` 恢复）、`cleanup {dry?}`（**不带 `id`**；结果的 `note` 一行一项；`dry` 只列出）、`pr {id, dry?, hash?}`（从 review；`dry` 回 `note` 与 `hash`，确认带同一个 `hash`，不符回 `conflict`）。
- **列出任务板时**顺带检查手工合并（最多每 10 s）；被识别的任务进入 `merged`，note "merged by hand"。
- **launch 的校验**：值班 agent 的 `start`/`hub_dispatch` 的 launch 由 daemon 按值班 agent 自己的 job 重建（只取任务、`cwd`、新会话文件、名字、model、thinking）；`spawn` 和值班 agent 的 launch 里的首条消息（`--` 后恰好一个参数）不得以 `/` `!` `@` 开头（`bad_request`）。
- **`BoardTask.workspace`** 新增 `reviewTip?`（M59，送去评审的提交）与 `pr?: {url, tip, at}`（M60）；事件流 `task` 多了 `pr`。`docs/protocol.md` 已描述。
- **pi 命令**：`/tasks [start | merge | back <id> [note] | verify | pass | shelve | approve | pr <id> | cleanup [yes]]`（`adapters/pi/tasks-command.ts`，每个 pi 会话都有）。hub 总览新增 `h`（搁置）、`o` 再 `y`（PR），行上的 `⚠` 表示重叠。

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
| 20 | M21 attach 回放 | `host/main.ts` `snapshot/replay` + `lib/term-modes.ts` + `@xterm/addon-serialize` | 中（模式跟踪细节多，**取代**阶段 13 的重绘做法，建议直接做这个） |
| 21 | M22 多窗口/频繁切换 | `lib/attach.ts` `localDetachAt`、host SIGCONT/`terminate-idle`、daemon `supersedeOthers`/`continuedElsewhere`、Reporter 退避、`stress-attach` 测试 | 小到中（**强烈建议**：不做会冻结） |
| 22–26 | M23–M27 hub 功能（`/resume`+选模型、用量、批量、fan-out+`/compare`、预设） | `hub/agent-view.ts` + `hub-options.ts` + `usage.ts` + `config.ts` | 中（都在视图里；daemon 只多几个字段） |
| 27 | M28 steer/follow-up | `protocol.ts` `ReplyMode` + worker `deliverAs` | 小 |
| 28 | M29 中性内核 | `lib/identity.ts` + `paths.ts`/`config.ts` 的候选路径 | 小（改名为主） |
| 29 | M30 档案（级别 0） | `profiles.ts` `term-signals.ts` + host `input`/`term.json` + daemon `profileTick` | 中（**移植到新宿主的最快路径**：零适配代码） |
| 30 | M31 协议（级别 1） | `docs/protocol.md` + `agent-client.ts` + `sdk/python` + daemon `hello` | 中 |
| 31 | M32 分层 | 目录搬迁 + `exports` + `cli-deps.test.ts` | 小 |
| 32 | M33 独立 hub | `pi-resolve.ts` + `hub-main.ts` + `bin` 的 `hub` | 中（视宿主是否有 pi-tui 同类物；依赖宿主的 TUI 库能脱离宿主运行） |
| 33–34 | M34 telemetry、M35 压测 | `lib/telemetry.ts`、`stress/` + daemon 的 group commit | 中（压测会逼出真问题，**值得做**） |
| 35 | M36 请求 ID | daemon `reply`/`dispatch` + `requestIds` | 小 |
| 36 | M37/M41 evals | `evals/` | 中（要真模型与凭证） |
| 37 | M38 中断续跑 | daemon `finalize` + `RESUME_DELAYS_MS` | 中（要处理好"信号死亡报成 code 0"） |
| 38 | M39 定时任务 | `lib/schedule.ts` + daemon ticker + hub `/schedule` | 中 |
| 39 | M40 全 agent 续跑/定时 | daemon 的 `resumable`、`profileTick` 分支、`templateAgent` | 小到中 |
| 40 | M42 | 仅测试 | — |
| 41 | M43 事件流/watch/消息规则 | `lib/events.ts` + daemon `record()`/`fireWatches` + hub `/log` + CLI `log` | 小到中 |
| 42 | M44 值班 agent v0 | `lib/concierge.ts` + `adapters/pi/concierge.ts` + daemon `wakeConcierge` 一族 + hub `/concierge` `?` | 中（唤醒合并/配额/预算是主体） |
| 43 | M45 策略 | daemon 闸门 + hub 横幅/Ctrl+Y/E + prompt | 中 |
| 44 | M46 常备指令 | daemon `orderOp`/时钟 + 摘要 + hub `/concierge orders` | 小到中 |
| 45 | M48 peek 加深 | `hub/agent-view.ts`（peek、`TaskEditor`、补全）+ `lib/transcript.ts` `readTail` | 中（全在视图里） |
| 46 | M47 任务板 | `lib/board.ts` + daemon `taskOp`/四处释放 + 两套工具 + hub `/tasks` + SDK | 中 |
| 47 | M49 加固 | daemon `requireHub`/`pumpLines`/`send` 积压、`lib/protocol.ts` `LineReader`、单行折叠 + 压测 `board` 场景 | 小 |
| 48 | M50 协议 agent 收消息 | daemon `recKey`/`refusesItems` + `lib/agent-client.ts` `onMessage` + `sdk/python/roost_agent.py` `on_message` | 小到中 |
| 49 | M51 请求 ID | `lib/client.ts` `requestOnce` + hub/面板/`/bg`/手机/CLI 的调用点 | 小 |
| 50 | M52 任务板按项目、可认领通知 | `lib/board.ts` `projectOf` + daemon `taskOp`/`tellOpened` + hub `/tasks` | 小到中 |
| 51 | M53 压缩前的记录 | `adapters/pi/earlier-history.ts`（依赖宿主 TUI 的内部结构） | 小（有正式接口时）到中 |

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
| `0d16cd4` | PR #32：发布 v0.1.7（v0.1.7 时的依据，tag `v0.1.7`） |
| `84e4d2e` | PR #33：v0.1.7 的文档 |
| `30e1dd8` | PR #34：修 CLI——pi-tui 不能在 pi 之外加载（并加了守边界的测试） |
| `4cf69b9` | PR #35：发布 v0.1.8（tag `v0.1.8`） |
| `e47ce4d` | PR #36：M21 attach 从 host 的屏幕开始（回放） |
| `61c4615` | PR #37：发布 v0.1.9（tag `v0.1.9`） |
| `b17d1c5` | PR #38：M22 不再冻结、多窗口下行保持真实 |
| `5c1f7d7` | PR #39：发布 v0.1.10（tag `v0.1.10`） |
| `11affd8` | PR #40：文档与测试里用中性的示例名字 |
| `d2c2604` | PR #41：Linux 下压力测试的 SIGUSR2 竞态、符号链接清理 |
| `6dc91f1` | PR #42：M23 `/resume` 与选模型 |
| `aabbc5a` | PR #43：M24 用量与花费 |
| `a933051` | PR #44：M25 多选批量 |
| `1d573d7` | PR #45：M26 fan-out 与 `/compare` |
| `5099af6` | PR #46：M27 启动预设 |
| `199ae0b` | PR #47：发布 v0.1.11（tag `v0.1.11`） |
| `cc67061` | PR #48：M28 steer 或等待 |
| `ac4312b` | PR #49：设计——any agent（`docs/plans/any-agent.md`） |
| `30865dd` | PR #50：M29 中性内核 |
| `4f43256` | PR #51：M30 agent 档案（级别 0） |
| `79e64ae` | PR #52：M31 agent 协议与 TS/Python 客户端 |
| `c77c873` | PR #53：M34 telemetry（及压测、evals 的方案） |
| `fbaa22f` | PR #54：M35 压测及它找出的修复 |
| `6e5a271` | PR #55：M36 请求 ID |
| `df39832` | PR #56：M37 真模型 evals |
| `65b64d7` | PR #57：M32 按层分目录 |
| `510c2f5` | PR #58：M33 独立 hub（`pi-roost hub`） |
| `b90f1f4` | PR #59：M38 中断续跑 |
| `ed74256` | PR #60：M39 定时任务 |
| `bac1080` | PR #61：M40 全 agent 的续跑与定时 |
| `6972c06` | PR #62：M41 更多 evals（fan-out、终端 agent、协议 agent） |
| `d1f43f0` | PR #63：M42 压测用例不再在负载下失败 |
| `871ed9a` | PR #64：发布 v0.1.12（tag `v0.1.12`） |
| `074499e` | PR #65：本文同步到 v0.1.12 |
| `2ffd947` | PR #66：发布 v0.1.13（只有文档；`docs/` 进发布包，tag `v0.1.13`） |
| `3a2280a` | PR #67：设计——hub 作为控制平面（M43–M47） |
| `fac2040` | PR #68：M43 事件流、watch 与消息规则 |
| `6ca9673` | PR #69：M44 值班 agent v0 |
| `33e8842` | PR #70：M45 升级与策略 |
| `16809e0` | PR #71：M46 常备指令 |
| `ec1bb74` | PR #72：M48 peek 加深 |
| `26c5575` | PR #73：M47 共享任务板（含独立审核的修复） |
| `14a62bf` | PR #74：发布 v0.1.14（tag `v0.1.14`；代码与 `26c5575` 相同） |
| `51acab8` | PR #75：M49 任务板之后的加固（压测场景、对抗性审查的修复） |
| `3912808` | PR #76：发布 v0.1.15（tag `v0.1.15`；代码与 `51acab8` 相同） |
| `d9f2ded` | PR #77：M50 协议 agent 收消息 |
| `e52a316` | PR #78：M51 hub 与 CLI 的请求 ID |
| `05a58d2` | PR #79：M52 任务板按项目、可认领通知 |
| `0031cb0` | PR #80：M53 压缩前的记录，滚到顶按需加载 |
| `801e9e9` | PR #81：发布 v0.1.16（tag `v0.1.16`；代码与 `0031cb0` 相同） |
| `f13977e` | PR #82：设计——代理开发环境路线（`docs/plans/ade-roadmap.md`，M54–M60） |
| `89606df` | PR #83：M54 任务的工作区，作为数据 |
| `c470c4f` | PR #84：M61 会话自己的斜杠命令进 peek（按用户要求在 M55 之前做） |
| `78b47d9` | PR #85：M55 `/tasks start` 与 `/tasks merge` |
| `1f26d30` | PR #86：M56 合并前验证、项目配置与信任 |
| `5ce0be7` | PR #87：发布 v0.1.17（tag `v0.1.17`；代码与 `1f26d30` 相同） |
| `6d96617` | PR #88：M57 工作区总览与值班 agent 的 `hub_task_start` |
| `a10e666` | PR #89：M58 评审（diff、行评论、退回） |
| `3ea3e9e` | PR #90：发布 v0.1.18（tag `v0.1.18`；代码与 `a10e666` 相同） |
| `77602c7` | PR #91：M59 搁置、清理、`/tasks` 进 pi 会话、加固 |
| `9e4320b` | PR #92：M60 可选出口（PR）与重叠标记 |
| （发布提交） | PR #93：发布 v0.1.19（本文依据，tag `v0.1.19`；代码与 `9e4320b` 相同） |

> **关于 SHA**：M22（PR #38）之后 main 的历史被改写过。上表的 SHA 取自**当前 main** 的 `git log --first-parent`（PR #33–#49 是合并提交，#50 起是 squash 提交）。`gh pr list --state merged` 返回的 `mergeCommit` 对 PR #38 等是旧历史里的 SHA（如 #38 为 `f0a9e65`，该提交对象仍在库里但不在 first-parent 上），以本表为准；v0.1.8–v0.1.12 的 tag 指向各自的发布合并/提交（`v0.1.8`=`4cf69b9`，`v0.1.9`=`61c4615`，`v0.1.10`=`5c1f7d7`，`v0.1.11`=`199ae0b`，`v0.1.12`=`871ed9a`，`v0.1.13`=`2ffd947`，`v0.1.14`=`14a62bf`，`v0.1.15`=`3912808`，`v0.1.16`=`801e9e9`，`v0.1.17`=`5ce0be7`，`v0.1.18`=`3ea3e9e`，`v0.1.19`=PR #93 的 squash 提交）。PR #65 起全部是 squash 提交，`git log --first-parent` 与 `gh pr list --state merged` 的 SHA 一致。M32 的编号虽小于 M34–M37，但实际在它们之后合入（计划里特意先做度量再做分层）。

所需 pi 最低版本（v0.1.19 / v0.1.18 / v0.1.17 / v0.1.16 / v0.1.15 / v0.1.14 仍以 **pi 1.5.0** 验证（v0.1.17 的 M61 内建命令清单对照 1.5.0 的 `slash-commands.js` 核对，并在真 pi 1.5.0 上验证了 bracketed paste 的 `/session`），M53 依赖的布局树结构也是在 1.5.0 上核对的，M44–M48 的 tmux 实测与 evals 都在 1.5.0 上做；v0.1.12 同样：`package.json` 的 devDependencies 钉在 1.5.0，M32 的安装验证、M33 的 tmux 实测和 M37 的 evals 都在 1.5.0 上做；级别 0/1 接入不需要 pi）：协议层以 `parentToolCallId`（0.99.0）为准，M8 用到的 `getContextUsage`（≥0.49）和 `thinking_level_select`（≥0.71）都更早；但 v0.1.7 的 README 与全部实机验收都基于 **pi 1.5.0 或更新**（M14 的全屏默认、`tui.stop({preserveScreen})`、M12/M19 的 `setWidget` placement 与 overlay 选项都是在 1.5.0 上验证的；仓库没有记录这些 TUI 选项各自从哪个 pi 版本开始提供，移植到别的宿主时按 §1.2 逐项核对）。
