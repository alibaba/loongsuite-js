# opentelemetry-instrumentation-qwen

为 Qwen Code 提供 OpenTelemetry 追踪能力，通过 Hook 机制自动采集 session 级别的 trace，并通过 `intercept.js` 捕获每次 LLM API 调用（DashScope / OpenAI-compatible）的 token 用量和消息内容。

---

## 特性

- **Hook 驱动**：利用 Qwen Code 的 `settings.json` hook 机制（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop` 等），无需修改任何业务代码
- **LLM 调用级追踪**：`intercept.js` 在进程内拦截 HTTP 请求，记录 DashScope / OpenAI-compatible API 的 token 用量、输入输出消息，写入 JSONL 日志
- **嵌套 Subagent 支持**：自动检测 SubagentStart/Stop 时间窗口，构建 TOOL → AGENT 容器层级；顺序 subagent 的 LLM 调用正确嵌套在 AGENT 下
- **并发安全**：事件采用 JSONL 追加写入（`O_APPEND` 原子性），彻底消除并行 hook 进程的读写竞态
- **自动 alias 注入**：安装后 `qwen` 命令自动携带 `NODE_OPTIONS=--require intercept.js`，无需手动配置
- **ARMS 语义规范**：Span 属性对齐 ARMS GenAI 语义规范（`gen_ai.span.kind`、`gen_ai.usage.*`、`gen_ai.tool.*` 等），自动检测 Sunfire 方言

---

## 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | >= 18.0.0 |
| Qwen Code | 任意版本（需配置了 hooks） |

---

## 快速安装（一行命令）

```bash
curl -fsSL https://your-cdn/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --service-name "my-qwen-agent"
```

安装完成后重载 Shell：

```bash
source ~/.bashrc   # 或 source ~/.zshrc
```

**参数说明：**

| 参数 | 说明 |
|------|------|
| `--endpoint` | OTLP 上报地址（必填，支持任意兼容后端）|
| `--service-name` | Trace 中的服务名 |
| `--headers` | 认证请求头，逗号分隔，如 `x-api-key=xxx` |
| `--debug` | 启用 `QWEN_TELEMETRY_DEBUG=1`（控制台输出，无需后端）|

**本地调试模式（无需 OTLP 后端）：**

```bash
export QWEN_TELEMETRY_DEBUG=1
```

---

## 安装方法

### 方式一：npm 全局安装（推荐）

```bash
npm install -g @loongsuite/opentelemetry-instrumentation-qwen
source ~/.bashrc   # 或 source ~/.zshrc
```

### 方式二：源码安装（git clone）

```bash
git clone https://github.com/alibaba/loongsuite-js-plugins.git
cd loongsuite-js-plugins/opentelemetry-instrumentation-qwen
bash scripts/install.sh
```

`scripts/install.sh` 会自动完成：
1. `npm install` — 安装 Node.js 依赖
2. 执行 `otel-qwen-hook install` 写入 `~/.qwen/settings.json` hook 配置
3. 将 `intercept.js` 复制到 `~/.cache/opentelemetry.instrumentation.qwen/intercept.js`
4. 在 `~/.bashrc` / `~/.zshrc` 中添加 `qwen` alias

---

## 配置说明

所有配置通过**环境变量**完成，无需配置文件。

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 导出端点 | —（必填，或启用 debug 模式） |
| `OTEL_EXPORTER_OTLP_HEADERS` | 导出请求头，逗号分隔 `key=value` | — |
| `OTEL_SERVICE_NAME` | Trace 中的 service name | `qwen-agents` |
| `OTEL_RESOURCE_ATTRIBUTES` | 附加资源属性，如 `env=prod,team=infra` | — |
| `QWEN_TELEMETRY_DEBUG` | 设为 `1` 启用 Console 输出（调试用，无需后端） | — |
| `OTEL_QWEN_HOOK_CMD` | 自定义 hook 命令名称 | `otel-qwen-hook` |
| `OTEL_QWEN_LANG` | 强制指定语言（`zh` 或 `en`），不设则自动检测 `$LANGUAGE`、`$LC_ALL`、`$LANG` | 自动检测 |
| `OTEL_QWEN_DEBUG` | 设为 `1` 启用 intercept.js 调试日志 | — |
| `LOONGSUITE_SEMCONV_DIALECT_NAME` | 语义规范方言（`ALIBABA_GROUP` 使用 Sunfire 命名） | 自动检测 |

### 示例：接入 Honeycomb

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<your-api-key>"
export OTEL_RESOURCE_ATTRIBUTES="service.name=my-qwen-agent,env=production"
```

### 示例：本地调试（无后端）

```bash
export QWEN_TELEMETRY_DEBUG=1
```

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
export QWEN_TELEMETRY_DEBUG=1

# 3. 正常使用 qwen，trace 自动上报
qwen "帮我写一个 Python hello world"
```

### alias 的作用

安装后，`~/.bashrc` 中会新增一行：

```bash
alias qwen='NODE_OPTIONS="--require $HOME/.cache/opentelemetry.instrumentation.qwen/intercept.js ${NODE_OPTIONS:-}" qwen'
```

这意味着：
- 每次执行 `qwen` 命令，`intercept.js` 会在进程启动时自动加载
- `intercept.js` 拦截 DashScope / OpenAI-compatible HTTP 请求，记录 token 用量和消息内容
- 这些数据会在 session 结束时（`stop` hook）合并进 OTel trace

### 验证安装

```bash
# 检查环境配置是否正确
otel-qwen-hook check-env

# 查看生成的 hook 配置 JSON
otel-qwen-hook show-config

# 查看 ~/.qwen/settings.json（确认 hooks 已写入）
cat ~/.qwen/settings.json
```

---

## Trace 层级结构

一次 Qwen Code session 会生成如下树状 Span 结构：

```
run_task <prompt 预览>  (TASK — session 根 Span)
├── react step 1  (STEP)
│   ├── chat qwen-max  (LLM)              ← intercept.js 捕获
│   ├── execute_tool read_file  (TOOL)
│   ├── execute_tool bash  (TOOL)
│   ├── execute_tool agent  (TOOL)        ← 顺序 subagent
│   │   └── invoke_agent Explore  (AGENT) ← AGENT 嵌套在 TOOL 下
│   │       ├── chat qwen-max  (LLM)      ← subagent 的 LLM 嵌套在 AGENT 下
│   │       └── execute_tool write_file  (TOOL)
│   └── chat qwen-max  (LLM)              ← 主 agent 的后续 LLM
├── react step 2  (STEP)
│   └── execute_tool write_file  (TOOL)
├── run_task context_compaction  (TASK)    ← PreCompact/PostCompact hook
└── run_task notification  (TASK)          ← Notification hook
```

每个 Span 上会携带（遵循 ARMS GenAI 语义规范）：
- **session Span (TASK)**：`input.value`、`output.value`、`gen_ai.operation.name=run_task`、`gen_ai.session.id`、`gen_ai.framework=qwen-code`
- **turn Span (STEP)**：`gen_ai.operation.name=react`、`gen_ai.react.round`、`gen_ai.react.finish_reason`
- **tool Span (TOOL)**：`gen_ai.operation.name=execute_tool`、`gen_ai.tool.name`、`gen_ai.tool.call.arguments`（JSON）、`gen_ai.tool.call.result`（JSON）
- **LLM call Span (LLM)**：`gen_ai.operation.name=chat`、`gen_ai.provider.name=dashscope`、`gen_ai.request.model`、`gen_ai.usage.input_tokens`、`gen_ai.input.messages`（ARMS Schema）、`gen_ai.output.messages`（ARMS Schema）、`gen_ai.system_instructions`
- **subagent Span (AGENT)**：`gen_ai.operation.name=invoke_agent`、`gen_ai.agent.id`、`gen_ai.agent.name`

### 已知局限：并行 Subagent 的 LLM 归属

当 Qwen Code 同时启动多个 subagent（并行执行）时，各 subagent 的 LLM API 调用会在同一进程内交替发生。由于 HTTP 拦截层（`intercept.js`）捕获的 LLM 调用不携带 subagent 标识符，插件无法判断某次 LLM 调用属于哪个具体的 subagent。

**行为表现**：
- **顺序 subagent**（一个接一个执行）：LLM 调用正确嵌套在对应的 AGENT 容器 span 下
- **并行 subagent**（多个同时执行）：TOOL → AGENT 容器层级正确（有完整时间范围），但 LLM 调用会平铺在 Turn span 下而非嵌套在各自的 AGENT 下

**根因**：qwen-code 的 subagent 在进程内执行，共享同一个 HTTP 通道。LLM 请求中没有任何字段关联到特定 subagent，因此在时间窗口重叠时无法准确归属。

**影响**：仅影响 trace 的可视化层级，所有 span 数据（token 用量、输入输出消息、时间范围等）均完整准确。

---

## CLI 命令参考

```bash
# 安装管理
otel-qwen-hook install             # 写入 ~/.qwen/settings.json hook 配置
otel-qwen-hook install --project   # 写入 ./.qwen/settings.json（项目级别）
otel-qwen-hook uninstall           # 卸载 hooks、intercept.js 和 qwen alias
otel-qwen-hook uninstall --purge   # 卸载并删除整个缓存目录（含 sessions）
otel-qwen-hook uninstall --project # 同时卸载 project-level settings
otel-qwen-hook show-config         # 输出 hook 配置 JSON 片段（可手动粘贴）
otel-qwen-hook check-env           # 检查 telemetry 环境配置

# 以下命令由 Qwen Code 自动调用，通常无需手动执行：
otel-qwen-hook user-prompt-submit    # UserPromptSubmit hook
otel-qwen-hook session-start         # SessionStart hook
otel-qwen-hook pre-tool-use          # PreToolUse hook
otel-qwen-hook post-tool-use         # PostToolUse hook
otel-qwen-hook post-tool-use-failure # PostToolUseFailure hook
otel-qwen-hook stop                  # Stop hook（导出完整 trace）
otel-qwen-hook pre-compact           # PreCompact hook
otel-qwen-hook post-compact          # PostCompact hook
otel-qwen-hook subagent-start        # SubagentStart hook
otel-qwen-hook subagent-stop         # SubagentStop hook（携带子 session 状态）
otel-qwen-hook session-end           # SessionEnd hook
otel-qwen-hook notification          # Notification hook
```

---

## 项目结构

```
opentelemetry-instrumentation-qwen/
├── package.json             # 包描述，name: @loongsuite/opentelemetry-instrumentation-qwen
├── README.md                # 本文档
├── LICENSE                  # Apache-2.0
├── .gitignore
├── bin/
│   └── otel-qwen-hook      # CLI 入口（#!/usr/bin/env node，commander 驱动）
├── src/
│   ├── index.js             # 包入口，导出核心 API
│   ├── cli.js               # 全部 hook 命令实现 + replayEventsAsSpans + exportSessionTrace
│   ├── state.js             # session 状态文件读写（原子写入）
│   ├── telemetry.js         # OTel TracerProvider 配置（OTLP/HTTP + Console）
│   ├── hooks.js             # 工具格式化函数（createToolTitle、createEventData 等）
│   └── intercept.js         # HTTP 拦截器（undici / https / fetch 三策略，支持 Node.js + Bun）
├── scripts/
│   ├── install.sh           # 源码安装脚本
│   ├── uninstall.sh         # 卸载脚本
│   ├── setup-alias.sh       # 向 .bashrc/.zshrc 添加 qwen alias
│   └── remote-install.sh    # 远程一键安装脚本
└── test/
    ├── cli.test.js          # CLI 命令处理器 + replayEventsAsSpans 测试
    ├── hooks.test.js        # Tool 格式化辅助函数测试
    ├── intercept.test.js    # HTTP 拦截 + 协议解析测试
    ├── state.test.js        # 状态文件读写测试
    └── telemetry.test.js    # TracerProvider 配置测试
```

---

## 工作原理

1. **hook 命令注册**：`otel-qwen-hook install` 将 12 个 hook 命令写入 `~/.qwen/settings.json`。Qwen Code 在每个生命周期事件时以子进程方式调用对应命令，并将事件 JSON 通过 stdin 传入。

2. **状态持久化**：每个 session 的事件以 JSONL 追加方式存储在：
   ```
   ~/.cache/opentelemetry.instrumentation.qwen/sessions/<session_id>.events.jsonl
   ```
   每次 hook 调用仅追加一行 JSON（利用 `O_APPEND` 原子性），彻底消除并行 hook 进程的读写竞态。导出时从事件序列重建完整的 session 元数据。

3. **intercept.js**：通过 `NODE_OPTIONS=--require` 在 Qwen Code 进程启动时注入。自动选择最优拦截策略：
   - **Node.js + undici 可用** → undici Dispatcher 拦截（最底层，最可靠）
   - **https.request patch** → 适用于 bundled qwen binary
   - **Node.js 无 undici** → monkey-patch `globalThis.fetch`
   - **Bun 运行时** → monkey-patch `globalThis.fetch`

   拦截到的 LLM 调用写入 JSONL 文件：
   ```
   ~/.cache/opentelemetry.instrumentation.qwen/sessions/proxy_events_<pid>.jsonl
   ```

4. **trace 导出**：`stop` hook 触发时，读取全部 session 事件 + intercept.js JSONL 日志，时间轴合并后按父子关系构建 OTel Span 树，导出到配置的 OTLP 后端，然后执行 `forceFlush` + `shutdown` 确保数据发送完毕。

---

## 测试

```bash
# 运行所有测试
npm test

# 带覆盖率
npm test -- --coverage

# watch 模式
npm run test:watch
```

---

## License

Apache-2.0
