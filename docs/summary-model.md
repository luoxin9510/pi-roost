# 用自己的模型做摘要（公司内部 LLM 节点）

pi-roost 的 agent view 可以用一个 LLM 给每个后台会话写摘要。这个模型不一定要用 Anthropic、OpenAI 这类公共服务，只要 pi 能调用，就可以换成公司内部部署的节点。

本文说明怎么把 `summaryModel` 指向公司内部节点，以及后台会话特有的几个坑。

## 摘要模型做什么

配置了 `summaryModel` 之后，每个后台 worker 会用它做四件事：

| 用途 | 何时调用 | 不配置时的表现 |
|---|---|---|
| 行摘要（这一轮做了什么，是否在问你问题，建议回复） | 每轮结束一次 | 显示最后一句输出 |
| 进度摘要（正在做什么） | 一轮开始 45 秒后一次，之后每 5 分钟一次 | 显示当前工具名 |
| 自动命名 | 未命名的会话收到第一条消息时，只做一次 | 取第一句话的前 6 个词 |
| "离开期间"回顾 | attach 回会话时 | 统计列表（轮数、工具、问题） |

每次调用都会**关闭 thinking**，并设置 `maxTokens: 1024`、超时 20 秒，要求模型**只回 JSON**。
发送给模型的是会话记录的最后约 6000 字符。这部分内容会离开本机，这也是建议在公司里用内部节点的原因。

调用失败、超时或回复无法解析时，会静默回退到不调模型的显示方式，不会影响会话本身。

## 第 1 步：让 pi 认识公司节点

摘要模型走的是 pi 自己的模型注册表（`ctx.modelRegistry`），所以先在 pi 里配好模型。在 `~/.pi/agent/models.json` 里加一个 provider：

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "corp": {
      "baseUrl": "https://llm.corp.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$CORP_LLM_API_KEY",
      "models": [
        { "id": "qwen3-8b-instruct" }
      ]
    }
  }
}
```

- `corp` 是 provider 名，可以随便起，后面要用到。
- `api` 填节点实际支持的协议，大多数内部网关都兼容 OpenAI 协议。完整字段见 pi 文档 `models-configuration.md`。
- `apiKey` 有三种写法：
  - `$环境变量`：从环境变量读取。注意看下面第 4 步。
  - 直接写字面值。
  - `!命令`：以 `!` 开头，请求时执行命令取 key，比如从公司的密钥工具获取。
- 如果公司只是在公共服务前面加了一层代理，就不用新建 provider，只改内置 provider 的 `baseUrl`：
  `{"providers": {"anthropic": {"baseUrl": "https://proxy.corp.example.com/v1"}}}`

## 第 2 步：先在前台验证

```sh
pi --list-models corp                  # 应能看到 corp/qwen3-8b-instruct
pi -p --no-session --model corp/qwen3-8b-instruct --thinking off \
  'Reply with JSON only: {"ok": true}'
```

只有看到 `{"ok": true}`，才说明认证和网络都通了，模型也能按要求只回 JSON。

## 第 3 步：设置 summaryModel

在 `~/.pi/agent/roost.json` 里写：

```json
{
  "summaryModel": "corp/qwen3-8b-instruct"
}
```

- 格式是 `provider/模型ID`，在**第一个** `/` 处切分，所以模型 ID 里可以带 `/`，比如 `corp/qwen/qwen3-8b`。
- 只能在用户级配置里设置。项目里的 `.pi/roost.json` 设置 `summaryModel` 会被忽略，这样别人克隆来的仓库就没法决定你的会话记录发往哪里。
- worker 每次调用前都会重新读取这个文件，改完不用重启。

## 第 4 步：后台会话的环境变量（最常见的坑）

后台 worker **不会继承你终端里的全部环境变量**。它只拿到一个白名单，并且是在**派发那一刻**记录进 `job.json` 的：

- 默认带上：`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`LANG`、`LC_*`、`TERM`、`COLORTERM`、`TMPDIR`，以及 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`ALL_PROXY`（大小写都认）。
- 其他变量都要显式加到 `envAllowList`：

```json
{
  "summaryModel": "corp/qwen3-8b-instruct",
  "envAllowList": ["CORP_LLM_API_KEY", "NODE_EXTRA_CA_CERTS"]
}
```

公司环境里通常需要加上：

| 变量 | 原因 |
|---|---|
| `apiKey` 里引用的 `$变量` | 不加的话，前台能用，后台摘要会静默失败 |
| `NODE_EXTRA_CA_CERTS` | 公司自签 CA 或 TLS 中间人代理时，不加会报证书错误 |
| 公司网关要求的其他头或令牌变量 | 同上 |

注意几点：

- `envAllowList` 只对**之后新派发**的会话生效。已有会话的环境是派发时记录的，`respawn` 也沿用原来的记录。改完后要新开会话验证。
- 用 `/login` 存进 `~/.pi/agent/auth.json` 的凭据**不受**环境变量白名单影响。能用这种方式的话最省事。
- `!命令` 形式的 key 在 worker 进程里执行，同样只能看到白名单里的环境变量。

## 对模型的要求

- **能关闭 thinking，或者本身就不思考。** 只会推理的模型可能把 1024 个 token 全花在思考上，最后没有正文。选指令模型（instruct 或 chat），不要选 reasoning 模型。
- **能稳定输出 JSON。** 只要回复里包含一个 `{...}` 就能解析，前后有说明文字或代码块也可以。7B 到 8B 的指令模型一般够用。
- **20 秒内响应。** 内部节点排队比较长的话，摘要会经常回退。
- **用量：** 每个后台会话每轮结束调用一次，运行期间每 5 分钟再调用一次。同时跑很多会话时，要考虑节点的限流。

用 `dispatchModel` 也可以让 agent view 里新开的会话直接用公司模型干活：

```json
{ "dispatchModel": "corp/qwen3-coder-32b", "dispatchThinking": "off" }
```

## 排错

| 现象 | 检查 |
|---|---|
| 行文字一直是最后一句输出，没有摘要 | 先做第 2 步的前台验证；再确认会话是在修改 `envAllowList` 之后新开的 |
| 前台正常，后台没有摘要 | 几乎都是环境变量的问题，见第 4 步 |
| 偶尔有摘要，偶尔没有 | 超时（20 秒）或模型偶尔不输出 JSON |
| 证书错误 | 把 `NODE_EXTRA_CA_CERTS` 加到 `envAllowList` |
| 想看后台实际拿到的环境 | `~/.pi/agent/roost/jobs/<id>/job.json` 里的 `env` 字段 |
| 想看摘要结果 | `~/.pi/agent/roost/jobs/<id>/state.json` 里的 `summary` 字段 |
