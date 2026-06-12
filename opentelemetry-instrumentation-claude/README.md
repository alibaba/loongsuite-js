# opentelemetry-instrumentation-claude

为 Claude Code 提供 OpenTelemetry 追踪能力，通过 Hook 机制自动采集 session 级别的 trace，并通过 `intercept.js` 捕获每次 LLM API 调用的 token 用量和消息内容。

---

## ✨ 特性

- **Hook 驱动**：利用 Claude Code 的 `settings.json` hook 机制（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 等），无需修改任何业务代码
- **LLM 调用级追踪**：`intercept.js` 在进程内拦截 HTTP 请求，记录 Anthropic / OpenAI API 的 token 用量、输入输出消息，写入 JSONL 日志
- **嵌套 Subagent 支持**：完整的父→子 Span 层级，适用于多 Agent 协作场景
- **原子状态写入**：基于 `rename` 的原子文件写入，防止并发 hook 进程读取到半写文件
- **自动 alias 注入**：安装后 `claude` 命令自动携带 `NODE_OPTIONS=--require intercept.js`，无需手动配置
- **一键安装**：`npm install -g` 后 postinstall 自动完成全部配置，或 `bash scripts/install.sh` 源码安装

---

## 📦 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | >= 18.0.0 |
| Claude Code | 任意版本（需配置了 hooks） |

---

## ⚡ 快速安装（一行命令）

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/remote-install.sh | bash -s -- \
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
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/remote-install.sh | bash --debug
```

---

## 🚀 安装方法

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

## ⚙️ 配置说明

所有配置通过**环境变量**完成，无需配置文件。

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP 导出端点 | —（必填，或启用 debug 模式） |
| `OTEL_EXPORTER_OTLP_HEADERS` | 导出请求头，逗号分隔 `key=value` | — |
| `OTEL_SERVICE_NAME` | Trace 中的 service name | `claude-agents` |
| `OTEL_RESOURCE_ATTRIBUTES` | 附加资源属性，如 `env=prod,team=infra` | — |
| `CLAUDE_TELEMETRY_DEBUG` | 设为 `1` 启用 Console 输出（调试用，无需后端） | — |
| `OTEL_CLAUDE_HOOK_CMD` | 自定义 hook 命令名称 | `otel-claude-hook` |
| `OTEL_CLAUDE_LANG` | 强制指定语言（`zh` 或 `en`），不设则自动检测 `$LANGUAGE`、`$LC_ALL`、`$LANG` | 自动检测 |

### 示例：接入 Honeycomb

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://api.honeycomb.io"
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<your-api-key>"
export OTEL_RESOURCE_ATTRIBUTES="service.name=my-claude-agent,env=production"
```

### 示例：本地调试（无后端）

```bash
export CLAUDE_TELEMETRY_DEBUG=1
```

---

## 📖 使用方法

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
alias claude='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 NODE_OPTIONS="--require $HOME/.cache/opentelemetry.instrumentation.claude/intercept.js" npx -y @anthropic-ai/claude-code@latest'
```

这意味着：
- 每次执行 `claude` 命令，`intercept.js` 会在进程启动时自动加载
- `intercept.js` 拦截 Anthropic/OpenAI HTTP 请求，记录 token 用量和消息内容
- 这些数据会在 session 结束时（`stop` hook）合并进 OTel trace

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

## 🌲 Trace 层级结构

一次 Claude session 会生成如下树状 Span 结构：

```
🤖 <prompt 预览>  (claude.session 根 Span)
├── 👤 Turn 1: <用户输入>
│   ├── 🔧 Bash: ls -la /tmp
│   ├── 🔧 Read: /path/to/file.py
│   └── 🧠 LLM call (claude-sonnet-4-5)   ← intercept.js 捕获
├── 👤 Turn 2: <下一轮输入>
│   └── 🔧 Write: /path/to/output.py
├── 🧠 LLM call (claude-sonnet-4-5)       ← intercept.js 捕获
├── 🗜️ Context compaction                  ← PreCompact hook
├── 🔔 Notification: 任务完成              ← Notification hook
└── 🤖 Subagent: <子任务描述>             ← SubagentStop hook
    ├── 🔧 Bash: pytest tests/
    └── 🧠 LLM call (claude-haiku-4-5)
```

每个 Span 上会携带：
- **session Span**：`session_id`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`turns`、`tools_used`
- **tool Span**：`gen_ai.tool.name`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result`、`input.*`、`response.*`
- **LLM call Span**：`gen_ai.request.model`、`gen_ai.usage.input_tokens`、`gen_ai.input.messages`、`gen_ai.output.messages`

---

## 🖥️ CLI 命令参考

```bash
# 安装管理
otel-claude-hook install             # 写入 ~/.claude/settings.json hook 配置
otel-claude-hook install --project   # 写入 ./.claude/settings.json（项目级别）
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

## 📁 项目结构

```
opentelemetry-instrumentation-claude/
├── package.json             # 包描述，name: @agenttrack/opentelemetry-instrumentation-claude
├── README.md                # 本文档
├── scripts/install.sh               # 源码安装脚本（bash scripts/install.sh）
└── scripts/remote-install.sh        # 远程一键安装脚本（curl | bash）
├── bin/
│   └── otel-claude-hook     # CLI 入口（#!/usr/bin/env node，commander 驱动）
├── src/
│   ├── index.js             # 包入口，导出核心 API
│   ├── cli.js               # 全部 hook 命令实现 + replayEventsAsSpans + exportSessionTrace
│   ├── state.js             # session 状态文件读写（原子写入，格式与 Python 版兼容）
│   ├── telemetry.js         # OTel TracerProvider 配置（OTLP/HTTP + Console）
│   ├── hooks.js             # 工具格式化函数（createToolTitle、createEventData 等）
│   └── intercept.js         # HTTP 拦截器（从 Python 包复制，支持 Node.js + Bun）
└── scripts/
    ├── setup-alias.sh       # 向 .bashrc/.zshrc 添加 claude alias
    └── uninstall.sh         # 卸载脚本
```

---

## 🔧 工作原理

1. **hook 命令注册**：`otel-claude-hook install` 将 8 个 hook 命令写入 `~/.claude/settings.json`。Claude Code 在每个生命周期事件时以子进程方式调用对应命令，并将事件 JSON 通过 stdin 传入。

2. **状态持久化**：每个 session 的事件序列存储在：
   ```
   ~/.cache/opentelemetry.instrumentation.claude/sessions/<session_id>.json
   ```
   写入采用 `rename` 原子操作，防止并发 hook 进程读到半写文件。

3. **intercept.js**：通过 `NODE_OPTIONS=--require` 在 Claude Code 进程启动时注入。自动选择最优拦截策略：
   - **Node.js + undici 可用** → undici Dispatcher 拦截（最底层，最可靠）
   - **https.request patch** → 适用于 bundled claude binary
   - **Node.js 无 undici** → monkey-patch `globalThis.fetch`
   - **Bun 运行时** → monkey-patch `globalThis.fetch`

   拦截到的 LLM 调用写入 JSONL 文件：
   ```
   ~/.cache/opentelemetry.instrumentation.claude/sessions/proxy_events_<uuid>.jsonl
   ```

4. **trace 导出**：`stop` hook 触发时，读取全部 session 事件 + intercept.js JSONL 日志，时间轴合并后按父子关系构建 OTel Span 树，导出到配置的 OTLP 后端，然后执行 `forceFlush` + `shutdown` 确保数据发送完毕。

---

## 📝 License

Apache-2.0
