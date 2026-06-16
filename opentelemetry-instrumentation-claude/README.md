# opentelemetry-instrumentation-claude

为 Claude Code 提供 OpenTelemetry 追踪能力，通过 Hook 机制自动采集 session 级别的 trace，并通过解析 Claude Code 原生 transcript 或 `intercept.js` HTTP 拦截捕获每次 LLM API 调用的 token 用量和消息内容。

Trace 数据完全遵循 [ARMS GenAI 语义规范](../arms/semantic-conventions/arms_docs/trace/gen-ai.md)，使用 `@loongsuite/opentelemetry-util-genai` SDK 的 `ExtendedTelemetryHandler` 生成标准化 Span。

---

## 特性

- **ARMS 语义规范兼容**：Span 层级遵循 ENTRY → AGENT → STEP → TOOL/LLM 标准结构，属性名、消息格式完全符合 ARMS GenAI Trace 规范
- **Hook 驱动**：利用 Claude Code 的 `settings.json` hook 机制（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 等），无需修改任何业务代码
- **LLM 调用级追踪**：优先解析 Claude Code 原生 transcript JSONL（兼容所有版本），回退到 `intercept.js` 进程内 HTTP 拦截，记录 Anthropic / OpenAI API 的 token 用量、输入输出消息
- **Per-turn 独立 Trace**：每轮对话生成独立的 trace（新 traceId），同一 session 的所有 turn 共享 `gen_ai.session.id`
- **多模态图片支持**：Anthropic、OpenAI Chat、OpenAI Responses 协议的图片内容块自动转换为 `BlobPart`（base64）/ `UriPart`（URL）格式
- **标准化消息格式**：输入/输出消息自动转换为 ARMS JSON Schema 格式（`InputMessage`、`OutputMessage`、`SystemInstruction`），支持 Anthropic、OpenAI Chat、OpenAI Responses 三种协议
- **嵌套 Subagent 支持**：完整的父→子 Span 层级，适用于多 Agent 协作场景
- **语义方言支持**：自动检测 Sunfire 端点，切换 `gen_ai.span_kind_name`（ALIBABA_GROUP）/ `gen_ai.span.kind`（默认）属性名
- **原子状态写入**：基于 `rename` 的原子文件写入，防止并发 hook 进程读取到半写文件
- **自动 alias 注入**：安装后 `claude` 命令自动携带 telemetry 环境变量，无需手动配置
- **Cursor IDE 兼容**：hook 配置包含 `matcher` 字段，自动检测并跳过 Cursor IDE 调用
- **配置文件支持**：可通过 `~/.claude/otel-config.json` 配置所有 OTLP 参数，优先于环境变量，避免与本地其他 OTel 工具冲突
- **JSONL 日志采集**：可选的本地日志功能，支持 chain hash 增量校验和每日文件轮转，与 trace 数据关联
- **纯日志模式（Log-only）**：支持仅输出 JSONL 日志而不上报 OTel Trace，适用于与 ai-agent-collector 等第三方采集工具集成
- **一键安装**：`npm install -g` 后 postinstall 自动完成全部配置，或 `bash scripts/install.sh` 源码安装

---

## 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | >= 18.0.0 |
| Claude Code | 任意版本（需配置了 hooks） |

---

## 快速安装（一行命令）

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-claude/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --service-name "my-claude-agent"
```

安装完成后重载 Shell：

```bash
source ~/.bashrc   # 或 source ~/.zshrc
```

脚本会自动：注册 hooks、安装 intercept.js、写入 shell alias、**并将 OTLP 配置写入 `~/.bashrc`**，无需手动 export。

**参数说明：**

| 参数 | 说明 |
|------|------|
| `--endpoint` | OTLP 上报地址（必填，支持任意兼容后端）|
| `--service-name` | Trace 中的服务名 |
| `--headers` | 认证请求头，逗号分隔，如 `x-api-key=xxx` |
| `--debug` | 启用 `CLAUDE_TELEMETRY_DEBUG=1`（控制台输出，无需后端）|

**本地调试模式（无需 OTLP 后端）：**

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-claude/remote-install.sh | bash --debug
```

---

## 安装方法

### 方式一：npm 全局安装（推荐）

```bash
npm install -g @loongsuite/opentelemetry-instrumentation-claude
source ~/.bashrc   # 或 source ~/.zshrc
```

postinstall 脚本自动完成所有配置：hooks 注册、intercept.js 复制、shell alias 写入，无需手动操作。

### 方式二：源码安装（git clone）

```bash
git clone https://github.com/alibaba/loongsuite-js.git
cd loongsuite-js/opentelemetry-instrumentation-claude
bash scripts/install.sh
```

`scripts/install.sh` 会自动完成：
1. `npm install` — 安装 Node.js 依赖
2. 全局注册 `otel-claude-hook` 到 PATH
3. 将 `intercept.js` 复制到 `~/.cache/opentelemetry.instrumentation.claude/intercept.js`
4. 执行 `otel-claude-hook install` 写入 `~/.claude/settings.json` hook 配置
5. 在 `~/.bashrc` / `~/.zshrc` 中添加 `claude` alias

---

## 配置说明

支持两种配置方式：**配置文件**和**环境变量**。配置文件优先于环境变量，适用于本地有其他 OTel 工具使用相同环境变量的场景。

### 方式一：配置文件（推荐）

创建 `~/.claude/otel-config.json`：

```json
{
  "otlp_endpoint": "https://your-otlp-endpoint:4318",
  "otlp_headers": "x-api-key=abc123,x-other=val",
  "service_name": "my-claude-agent",
  "resource_attributes": "env=prod,team=infra",
  "debug": false,
  "semconv_dialect": "",
  "log_enabled": false,
  "log_dir": ""
}
```

所有字段均为可选，未设置的字段回退到对应的环境变量，再回退到默认值。

**优先级：配置文件 > 环境变量 > 默认值**

| 配置文件字段 | 对应环境变量 | 说明 | 默认值 |
|---|---|---|---|
| `otlp_endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 导出端点 | —（必填，或启用 debug） |
| `otlp_headers` | `OTEL_EXPORTER_OTLP_HEADERS` | 导出请求头，逗号分隔 `key=value` | — |
| `service_name` | `OTEL_SERVICE_NAME` | Trace 中的 service name | `claude-agents` |
| `resource_attributes` | `OTEL_RESOURCE_ATTRIBUTES` | 附加资源属性 | — |
| `debug` | `CLAUDE_TELEMETRY_DEBUG` | 启用 Console 输出（调试用） | `false` |
| `semconv_dialect` | `LOONGSUITE_SEMCONV_DIALECT_NAME` | 语义规范方言 | 自动检测 |
| `log_enabled` | `OTEL_CLAUDE_LOG_ENABLED` | 启用 JSONL 日志采集 | `false` |
| `log_dir` | `OTEL_CLAUDE_LOG_DIR` | JSONL 日志目录 | `~/.loongcollector/data/` |
| `log_filename_format` | `OTEL_CLAUDE_LOG_FILENAME_FORMAT` | 日志文件名格式：`default` 或 `hook` | `default` |

### 方式二：环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 导出端点 | —（必填，或启用 debug 模式） |
| `OTEL_EXPORTER_OTLP_HEADERS` | 导出请求头，逗号分隔 `key=value` | — |
| `OTEL_SERVICE_NAME` | Trace 中的 service name | `claude-agents` |
| `OTEL_RESOURCE_ATTRIBUTES` | 附加资源属性，如 `env=prod,team=infra` | — |
| `CLAUDE_TELEMETRY_DEBUG` | 设为 `1` 启用 Console 输出（调试用，无需后端） | — |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | 设为 `gen_ai_latest_experimental` 启用 GenAI 语义规范实验特性（消息内容捕获的前置条件） | —（alias 已自动设置） |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | 消息内容捕获模式：`SPAN_ONLY`（写入 Span 属性）、`EVENT_ONLY`（作为 Event 发出）、`SPAN_AND_EVENT`（两者都写）、`NO_CONTENT`（不捕获） | `SPAN_ONLY`（alias 已自动设置） |
| `OTEL_CLAUDE_HOOK_CMD` | 自定义 hook 命令名称 | `otel-claude-hook` |
| `OTEL_CLAUDE_LANG` | 强制指定语言（`zh` 或 `en`），不设则自动检测 `$LANGUAGE`、`$LC_ALL`、`$LANG` | 自动检测 |
| `LOONGSUITE_SEMCONV_DIALECT_NAME` | 语义规范方言：`ALIBABA_GROUP` 使用 `gen_ai.span_kind_name`，默认使用 `gen_ai.span.kind` | 自动检测 |
| `OTEL_CLAUDE_LOG_ENABLED` | 设为 `1` 启用 JSONL 日志采集 | — |
| `OTEL_CLAUDE_LOG_DIR` | JSONL 日志文件目录 | `~/.loongcollector/data/` |

### 示例：配置文件接入 Honeycomb

```json
{
  "otlp_endpoint": "https://api.honeycomb.io",
  "otlp_headers": "x-honeycomb-team=<your-api-key>",
  "resource_attributes": "service.name=my-claude-agent,env=production"
}
```

### 示例：环境变量接入 Honeycomb

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<your-api-key>"
export OTEL_RESOURCE_ATTRIBUTES="service.name=my-claude-agent,env=production"
```

### 示例：本地调试（无后端）

```bash
export CLAUDE_TELEMETRY_DEBUG=1
```

或在配置文件中：

```json
{
  "debug": true
}
```

### 纯日志模式（Log-only）

当只需要本地 JSONL 日志采集而不上报 OTel Trace 时，可以启用纯日志模式。适用于与 ai-agent-collector 集成等场景。

在 `~/.claude/otel-config.json` 中：

```json
{
  "log_enabled": true,
  "log_dir": "~/.ai-agent-collector/logs/claude-code"
}
```

或通过环境变量：

```bash
export OTEL_CLAUDE_LOG_ENABLED=1
export OTEL_CLAUDE_LOG_DIR="~/.ai-agent-collector/logs/claude-code"
```

**注意**：纯日志模式下无需配置 `otlp_endpoint` 或 `debug`。插件会跳过 OTel Trace 导出，仅将每轮对话的详细记录写入本地 JSONL 文件。

日志文件格式：
- 默认路径：`<log_dir>/claude-code.jsonl.YYYYMMDD`
- 可通过 `log_filename_format: "hook"` 切换为 `<log_dir>/claude-code-YYYY-MM-DD.jsonl`（兼容 ai-agent-collector 的 BaseHookInput）
- 每行一个 JSON 对象，遵循 AI Agent EventSchema（event_t）规范，包含 `event.name`（`llm.request`/`llm.response`/`tool.call`/`tool.result`）、`session.id`、`message.role`、token 用量等字段
- 按天自动轮转

---

## 使用方法

### 快速开始

```bash
# 1. 重载 shell（使 alias 生效）
source ~/.bashrc   # 或 source ~/.zshrc

# 2. 配置 telemetry 后端（二选一）
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<your-key>"
# 或
export CLAUDE_TELEMETRY_DEBUG=1

# 3. 正常使用 claude，trace 自动上报
claude "帮我写一个 Python hello world"
```

### alias 的作用

安装后，`~/.bashrc` 中会新增一行：

```bash
alias claude='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta npx -y @anthropic-ai/claude-code@latest'
```

这意味着：
- 每次执行 `claude` 命令，自动携带 telemetry 相关环境变量
- GenAI SDK 环境变量（`OTEL_SEMCONV_STABILITY_OPT_IN` 等）由 `otel-claude-hook` 入口点自动设置
- LLM 调用数据优先从 Claude Code 原生 transcript 获取，无需 `intercept.js` HTTP 拦截
- 每轮对话结束时（`stop` hook）生成独立的 OTel trace

### 验证安装

```bash
# 检查环境配置是否正确
otel-claude-hook check-env

# 查看生成的 hook 配置 JSON
otel-claude-hook show-config

# 查看 ~/.claude/settings.json（确认 hooks 已写入）
cat ~/.claude/settings.json
```

---

## Trace 层级结构（ARMS 语义规范）

每轮对话（turn）生成一个独立的 trace，同一 session 的所有 turn 共享 `gen_ai.session.id`：

```
Session (gen_ai.session.id = "abc-123")
├── Turn 1 (traceId = A)
│   ENTRY: enter_ai_application_system           ← gen_ai.span.kind=ENTRY
│   └── AGENT: invoke_agent claude-code          ← gen_ai.span.kind=AGENT
│       ├── STEP: react step (round=1)           ← gen_ai.span.kind=STEP
│       │   ├── LLM: chat claude-sonnet-4-5      ← gen_ai.span.kind=LLM (finish=tool_use)
│       │   ├── TOOL: execute_tool Bash          ← gen_ai.span.kind=TOOL
│       │   └── TOOL: execute_tool Read          ← gen_ai.span.kind=TOOL
│       ├── STEP: react step (round=2)
│       │   ├── LLM: chat claude-sonnet-4-5      ← (finish=tool_use)
│       │   └── TOOL: execute_tool Write
│       └── STEP: react step (round=3)
│           └── LLM: chat claude-sonnet-4-5      ← (finish=stop)
├── Turn 2 (traceId = B)
│   ENTRY → AGENT →
│       ├── STEP (round=1): LLM + TOOL(Agent)
│       │                     └── AGENT: invoke_agent Explore  ← 子 Agent
│       └── STEP (round=2): LLM (finish=stop)
└── Turn 3 (traceId = C)
    ENTRY → AGENT → STEP (round=1): LLM (finish=stop)
```

STEP = 一次 LLM 推理周期 + 由该推理触发的工具调用（0 或多个）。

### 各层级 Span 属性

所有 Span 均携带 `gen_ai.session.id`（公共属性）。

| Span 类型 | 关键属性 |
|-----------|---------|
| **ENTRY** | `gen_ai.session.id`, `gen_ai.operation.name=enter_ai_application_system` |
| **AGENT** | `gen_ai.agent.name`, `gen_ai.provider.name`, `gen_ai.conversation.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| **STEP** | `gen_ai.react.round`, `gen_ai.operation.name=react_step` |
| **TOOL** | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` |
| **LLM** | `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` |

### 消息格式

输入/输出消息遵循 ARMS JSON Schema 定义：

**InputMessage**: `{ role, parts: [TextPart | ToolCallPart | ToolCallResponsePart | ReasoningPart] }`

**OutputMessage**: `{ role, parts: [...], finishReason }`

**SystemInstruction**: `[{ type: "text", content: "..." }]`

支持的消息类型：
- `TextPart`: `{ type: "text", content: "..." }`
- `ToolCallPart`: `{ type: "tool_call", id, name, arguments }`
- `ToolCallResponsePart`: `{ type: "tool_call_response", id, response }`
- `ReasoningPart`: `{ type: "reasoning", content: "..." }`

---

## CLI 命令参考

```bash
# 安装管理
otel-claude-hook install             # 写入 ~/.claude/settings.json hook 配置
otel-claude-hook install --project   # 写入 ./.claude/settings.json（项目级别）
otel-claude-hook install --no-alias  # 跳过 shell alias 设置（用于 pilot 等托管安装）
otel-claude-hook uninstall           # 卸载 hooks、intercept.js 和 claude alias
otel-claude-hook uninstall --purge   # 卸载并删除整个缓存目录（含 sessions）
otel-claude-hook uninstall --project # 同时卸载 project-level settings
otel-claude-hook show-config         # 输出 hook 配置 JSON 片段（可手动粘贴）
otel-claude-hook check-env           # 检查 telemetry 环境配置

# 以下命令由 Claude Code 自动调用，通常无需手动执行：
otel-claude-hook user-prompt-submit  # UserPromptSubmit hook
otel-claude-hook pre-tool-use        # PreToolUse hook
otel-claude-hook post-tool-use       # PostToolUse hook
otel-claude-hook stop                # Stop hook（导出完整 trace）
otel-claude-hook pre-compact         # PreCompact hook
otel-claude-hook subagent-start      # SubagentStart hook
otel-claude-hook subagent-stop       # SubagentStop hook（携带子 session 状态）
otel-claude-hook notification        # Notification hook
```

---

## 项目结构

```
opentelemetry-instrumentation-claude/
├── package.json
├── README.md
├── bin/
│   └── otel-claude-hook             # CLI 入口（#!/usr/bin/env node，commander 驱动）
├── src/
│   ├── index.js                     # 包入口，导出核心 API
│   ├── cli.js                       # hook 命令实现 + replayEventsAsSpans + exportSessionTrace
│   ├── config.js                    # 配置加载（~/.claude/otel-config.json + 环境变量 + 默认值）
│   ├── logger.js                    # JSONL 日志采集（chain hash + 每日文件轮转）
│   ├── message-converter.js         # LLM 消息格式转换（Anthropic/OpenAI → ARMS 语义规范）
│   ├── state.js                     # session 状态文件读写（原子写入）
│   ├── telemetry.js                 # OTel TracerProvider 配置（OTLP/HTTP + Console）
│   ├── hooks.js                     # 工具格式化函数 + extractToolResult/extractToolError
│   ├── transcript.js                # Claude Code 原生 transcript JSONL 解析（优先数据源）
│   └── intercept.js                 # HTTP 拦截器（回退数据源，支持 Node.js + Bun）
├── scripts/
│   ├── install.sh                   # 源码安装脚本
│   ├── remote-install.sh            # 远程一键安装脚本
│   ├── setup-alias.sh               # 向 .bashrc/.zshrc 添加 claude alias
│   └── uninstall.sh                 # 卸载脚本
└── test/
    ├── cli.test.js                  # CLI + replayEventsAsSpans + exportSessionTrace 测试
    ├── config.test.js               # 配置文件加载、优先级、缺失文件兜底测试
    ├── logger.test.js               # JSONL 日志、chain hash、文件轮转测试
    ├── message-converter.test.js    # 消息格式转换测试（3 协议 × 多场景）
    ├── transcript.test.js           # transcript JSONL 解析测试
    ├── hooks.test.js                # hooks 工具函数测试
    ├── state.test.js                # 状态文件读写测试
    ├── intercept.test.js            # HTTP 拦截器测试
    └── telemetry.test.js            # TracerProvider 配置测试
```

---

## 工作原理

1. **配置加载**：`config.js` 在首次访问时读取 `~/.claude/otel-config.json`（如存在），并缓存在内存中。后续所有模块（telemetry、cli、logger）通过 config 模块获取配置，遵循 **配置文件 > 环境变量 > 默认值** 的优先级。

2. **hook 命令注册**：`otel-claude-hook install` 将 8 个 hook 命令写入 `~/.claude/settings.json`。Claude Code 在每个生命周期事件时以子进程方式调用对应命令，并将事件 JSON 通过 stdin 传入。

2. **状态持久化**：每个 session 的事件序列存储在：
   ```
   ~/.cache/opentelemetry.instrumentation.claude/sessions/<session_id>.json
   ```
   写入采用 `rename` 原子操作，防止并发 hook 进程读到半写文件。

3. **Transcript 解析**（优先）：`transcript.js` 解析 Claude Code 原生 session transcript（`~/.claude/projects/<hash>/<session-id>.jsonl`），提取每次 LLM 调用的模型、token 用量、输入输出消息。支持流式分块合并和去重。不依赖 HTTP 拦截，兼容所有 Claude Code 版本。

4. **intercept.js**（回退）：当 transcript 不可用时，通过 `NODE_OPTIONS=--require` 注入 HTTP 拦截。自动选择最优策略：
   - **Node.js + undici** → undici Dispatcher 拦截
   - **https.request patch** → 适用于 bundled binary
   - **globalThis.fetch patch** → Bun 运行时

   拦截到的 LLM 调用写入：`~/.cache/opentelemetry.instrumentation.claude/sessions/proxy_events_<pid>.jsonl`

5. **消息格式转换**：`message-converter.js` 将 LLM 请求/响应数据转换为 ARMS 语义规范格式：
   - Anthropic API（`content blocks`）→ `InputMessage` / `OutputMessage`
   - OpenAI Chat API（`tool_calls` / `role:tool`）→ `InputMessage` / `OutputMessage`
   - OpenAI Responses API（`function_call_output`）→ `InputMessage` / `OutputMessage`

6. **trace 导出**：`stop` hook 在每轮对话结束时触发，`exportSessionTrace` 通过 `ExtendedTelemetryHandler` SDK 构建标准化 Span 树：
   - 按 `user_prompt_submit` 事件将累积事件拆分为独立 turn
   - 每个 turn 创建独立的 ENTRY → AGENT Span 层级（新 traceId），共享 `gen_ai.session.id`
   - 每次 `llm_call` 事件开启新的 STEP Span，后续 TOOL Span 挂在该 STEP 下
   - 嵌套 Subagent 递归处理子事件流
   - 导出成功后清空已导出事件，避免下轮重复导出
   - 执行 `forceFlush` + `shutdown` 确保数据发送完毕

7. **JSONL 日志采集**（可选）：当 `log_enabled=true` 时，`logger.js` 在 trace 导出完成后将每轮对话的详细记录写入本地 JSONL 文件：
   - 文件路径：`<log_dir>/claude-code.jsonl.YYYYMMDD`，按天自动轮转
   - 每条记录遵循 AI Agent EventSchema（event_t）规范：`event.name` 区分事件类型（`llm.request`/`llm.response`/`tool.call`/`tool.result`），包含 `event.id`、`session.id`、`turn.id`、`step.id`、`message.role`、`user.id`、`agent.type` 等标准字段
   - LLM 请求和响应拆分为独立事件：`llm.request` 携带 `input.messages_delta`/`input.messages_hash`，`llm.response` 携带 `output.messages`/`usage.*` token 用量
   - 工具调用和结果拆分为独立事件：`tool.call` 携带 `tool.arguments`，`tool.result` 携带 `tool.result`/`tool.result.status`/`tool.result.duration_ms`
   - **Chain hash 增量校验**：使用 `H_n = sha256(H_{n-1} + serialize(msg_n))` 算法检测消息是否被上下文压缩修改。仅在 hash 不匹配时记录完整 `input.messages`，正常情况下只记录增量 `input.messages_delta`，大幅节省存储

---

## 本地开发与测试

### 前置准备

```bash
# 进入 monorepo 根目录
cd loongsuite-js-plugins

# 先构建 SDK 依赖（包含 CJS 产物）
cd opentelemetry-util-genai
npm install
npm run build
cd ..

# 安装插件依赖
cd opentelemetry-instrumentation-claude
npm install
```

### 运行测试

```bash
# 运行全部测试（含覆盖率）
# 注意：如果环境中有 NODE_OPTIONS="--require intercept.js"，需要清除
NODE_OPTIONS="" npm test

# 仅运行某个测试文件
NODE_OPTIONS="" npx jest test/cli.test.js --no-coverage

# 监听模式（开发时实时运行）
NODE_OPTIONS="" npx jest --watch
```

### 本地端到端测试

1. **Debug 模式（Console 输出，无需后端）**

```bash
# 安装 hooks 到 ~/.claude/settings.json
node bin/otel-claude-hook install --user

# 设置 debug 模式，trace 输出到 stderr
export CLAUDE_TELEMETRY_DEBUG=1

# 启动 claude，intercept.js 自动加载
source ~/.bashrc
claude "hello"

# session 结束后，终端会输出完整的 span 数据
```

2. **本地 OTLP 后端（如 Jaeger）**

```bash
# 启动 Jaeger all-in-one（Docker）
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# 配置 OTLP 端点
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="claude-agents-dev"

# 使用 claude
source ~/.bashrc
claude "帮我列出当前目录的文件"

# 打开 Jaeger UI 查看 trace
open http://localhost:16686
```

3. **验证 Span 层级**

在 Jaeger UI 或 debug 输出中确认：
- 根 Span 为 `enter_ai_application_system`（ENTRY）
- 下一层为 `invoke_agent claude-code`（AGENT）
- 每轮对话为 `react step`（STEP），带 `gen_ai.react.round` 属性
- 工具调用为 `execute_tool <name>`（TOOL）
- LLM 调用为 `chat <model>`（LLM），带完整的 `gen_ai.input.messages` / `gen_ai.output.messages`
- 子 Agent 为嵌套的 `invoke_agent <type>`（AGENT）

---

## License

Apache-2.0
