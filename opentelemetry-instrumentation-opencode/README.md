# opentelemetry-instrumentation-opencode

为 [OpenCode](https://opencode.ai) 提供 OpenTelemetry 可观测能力，自动采集 session 级别的 Trace、Metrics 和 Logs，并通过 OTLP 协议上报到任意兼容后端（Jaeger、Alibaba Sunfire, Grafana、SigNoz、阿里云 ARMS 等）。

---

## ✨ 特性

- **Plugin 驱动**：以 OpenCode plugin 形式接入，零侵入，无需修改任何业务代码
- **完整 Trace 链路**：Entry → Agent → Step → LLM / Tool / Permission 完整父子 Span 层级
- **丰富指标**：session 数、token 用量、成本、代码行数、git commit 数、工具耗时等 13+ 指标
- **结构化日志**：用户 prompt、session 生命周期事件通过 OTLP Logs 上报
- **零配置启用**：设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 即自动开启，无需其他操作
- **Semconv 方言**：自动检测 sunfire 端点，无缝兼容阿里集团内部 ARMS（`gen_ai.span_kind_name`）

---

## 📦 环境要求

| 依赖 | 版本 |
|------|------|
| OpenCode | 任意版本（需支持 plugin 机制）|
| Bun | >= 1.0（用于测试；运行时无需）|

---

## ⚡ 快速安装（一行命令）

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/opencode/remote-install.sh | bash -s -- \
  --endpoint "https://your-endpoint:4318" \
  --service-name "my-opencode-agent"
```

安装完成后重载 Shell 并重启 OpenCode：

```bash
source ~/.bashrc   # 或 source ~/.zshrc
```

脚本会自动：
1. `npm install` 安装 OTel 依赖
2. 写入口文件到 `~/.config/opencode/plugins/`（OpenCode 自动加载）
3. 将 OTLP 配置写入 `~/.bashrc` / `~/.zshrc`

**参数说明：**

| 参数 | 说明 |
|------|------|
| `--endpoint` | OTLP 基础上报地址，自动拼接 `/v1/traces`、`/v1/metrics`、`/v1/logs` |
| `--traces-endpoint` | 独立的 Traces OTLP 端点（完整 URL，优先于 `--endpoint`）|
| `--metrics-endpoint` | 独立的 Metrics OTLP 端点（完整 URL，优先于 `--endpoint`）|
| `--logs-endpoint` | 独立的 Logs OTLP 端点（完整 URL，优先于 `--endpoint`）|
| `--headers` | 认证请求头，逗号分隔，如 `authorization=Bearer xxx` |
| `--service-name` | Trace 中的服务名（写入 `OTEL_SERVICE_NAME`）|
| `--debug` | 启用控制台输出（无需后端，本地调试用）|

---

## 🚀 安装方法

### 方式一：一键脚本（推荐）

```bash
# 克隆仓库后在插件目录执行
bash scripts/install.sh \
  --endpoint "https://your-endpoint:4318" \
  --service-name "my-agent"
```

### 方式二：手动配置

将以下文件写入 `~/.config/opencode/plugins/opentelemetry-instrumentation-opencode.ts`：

```ts
import { OtelPlugin } from "/absolute/path/to/opentelemetry-instrumentation-opencode/src/index.ts"
export default OtelPlugin
```

然后设置环境变量：

```json
{
  "plugins": ["@loongsuite/opentelemetry-instrumentation-opencode"]
}
```

---

## ⚙️ 配置说明

所有配置通过**环境变量**完成，无需配置文件。优先读取 OTEL 标准变量，兼容 `OPENCODE_*` 旧变量作为 fallback。

### 核心配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP 基础上报端点（设置后自动启用遥测），自动拼接 `/v1/traces` 等路径 | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 独立的 Traces 端点（完整 URL，优先于基础端点）| — |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 独立的 Metrics 端点（完整 URL，优先于基础端点）| — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | 独立的 Logs 端点（完整 URL，优先于基础端点）| — |
| `OTEL_EXPORTER_OTLP_HEADERS` | 请求头，逗号分隔 `key=value`，如认证 token | — |
| `OTEL_RESOURCE_ATTRIBUTES` | 附加资源属性，如 `env=prod,team=ml` | — |
| `OPENCODE_ENABLE_TELEMETRY` | 旧版：设为任意值启用遥测 | — |

### Trace 配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_TRACES_EXPORTER` | 设为 `none` 禁用 Trace | — |
| `OTEL_TRACE_MAX_CONTENT_SIZE` | `gen_ai.input/output.messages` 单条最大字符数（0 = 不限）| `2048` |
| `OPENCODE_DISABLE_TRACES` | 旧版：设为任意值禁用 Trace | — |

### Metrics 配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_METRIC_EXPORT_INTERVAL` | 指标上报间隔（毫秒）| `60000` |
| `OTEL_METRIC_PREFIX` | 所有指标名称前缀 | `opencode.` |
| `OTEL_DISABLE_METRICS` | 逗号分隔的禁用指标名列表 | — |

### Logs 配置

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `OTEL_LOGS_EXPORTER` | 设为 `otlp` 启用日志；`none` 禁用 | 默认禁用 |
| `OTEL_BLRP_SCHEDULE_DELAY` | 日志批量上报延迟（毫秒）| `5000` |

### Semconv 方言

部分后端（如阿里集团内部 ARMS）要求 span kind 属性名为 `gen_ai.span_kind_name` 而非默认的 `gen_ai.span.kind`。

| 环境变量 | 说明 |
|----------|------|
| `LOONGSUITE_SEMCONV_DIALECT_NAME` | 设为 `ALIBABA_GROUP` 启用阿里集团方言 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 端点含 `sunfire` 时自动切换到阿里集团方言 |

### 配置示例

**禁用部分指标：**

```bash
export OTEL_DISABLE_METRICS="opencode.cost.usage,opencode.session.cost.total"
```

---

## 🌲 Trace 层级结构

一次 OpenCode 用户消息会生成如下树状 Span 结构：

```
🚪 enter (ENTRY)
└── 🤖 invoke_agent <agent-name> (AGENT)
    └── 📋 step <n> (STEP)
        ├── 🧠 <model>/<prompt 预览> (LLM)
        │     gen_ai.input.messages, gen_ai.output.messages
        │     gen_ai.usage.input_tokens, gen_ai.usage.output_tokens
        ├── 🔧 tool:<tool-name> (TOOL)
        │     gen_ai.tool.name, gen_ai.tool.call.arguments, gen_ai.tool.call.result
        └── 🔐 permission:<tool-name> (TOOL)
              permission.decision, permission.reason
```

### 关键 Span Attributes

| Attribute | 说明 |
|---|---|
| `gen_ai.system` | 固定为 `opencode` |
| `gen_ai.operation.name` | 操作类型：`enter`、`invoke_agent`、`step`、`chat`、`tool` |
| `gen_ai.agent.name` | Agent 显示名称 |
| `gen_ai.agent.id` | Agent ID |
| `gen_ai.request.model` | LLM 调用使用的模型 ID |
| `gen_ai.response.model` | LLM 响应实际使用的模型 |
| `gen_ai.response.finish_reasons` | 完成原因 JSON 数组（`["stop"]`、`["tool_calls"]`、`["error"]`）|
| `gen_ai.response.time_to_first_token` | 首 token 延迟（纳秒）|
| `gen_ai.response.reasoning_time` | 推理耗时（毫秒）|
| `gen_ai.usage.input_tokens` | 消耗的输入 token 数 |
| `gen_ai.usage.output_tokens` | 生成的输出 token 数 |
| `gen_ai.usage.cache_read.input_tokens` | 缓存读取的输入 token 数 |
| `gen_ai.usage.cache_creation.input_tokens` | 缓存创建的输入 token 数 |
| `gen_ai.output.type` | 输出类型（固定 `text`）|
| `gen_ai.system_instructions` | 系统提示词（JSON 格式）|
| `gen_ai.input.messages` | JSON 格式的输入消息（按 `maxContentSize` 截断）|
| `gen_ai.output.messages` | JSON 格式的输出消息（按 `maxContentSize` 截断）|
| `gen_ai.user.id` | 用户标识（= sessionID）|
| `gen_ai.framework` | 框架标识（固定 `opencode`）|
| `gen_ai.tool.name` | 工具名称 |
| `gen_ai.tool.call.arguments` | 工具调用参数（JSON）|
| `gen_ai.tool.call.result` | 工具执行结果 |
| `project.id` | OpenCode 项目 ID |
| `session.id` | OpenCode session ID |

---

## 📊 Metrics 列表

所有指标默认以 `opencode.` 为前缀（可通过 `OTEL_METRIC_PREFIX` 修改）。

| 指标名 | 类型 | 单位 | 说明 |
|--------|------|------|------|
| `opencode.session.count` | Counter | `{session}` | 启动的 session 数 |
| `opencode.token.usage` | Counter | `{token}` | Token 用量（按 `type` 分：input/output/cacheRead/cacheCreation）|
| `opencode.cost.usage` | Counter | `{USD}` | 累计费用（美元）|
| `opencode.lines_of_code.count` | Counter | `{line}` | 代码行变化数（来自 `session.diff`）|
| `opencode.commit.count` | Counter | `{commit}` | 检测到的 git commit 数 |
| `opencode.tool.duration` | Histogram | `ms` | 工具执行耗时 |
| `opencode.cache.count` | Counter | `{request}` | 每条消息的缓存命中/创建次数 |
| `opencode.session.duration` | Histogram | `ms` | session 生命周期（created → idle）|
| `opencode.message.count` | Counter | `{message}` | 完成的 assistant 消息数 |
| `opencode.session.token.total` | Histogram | `{token}` | 每个 session 的 token 总量（session idle 时记录）|
| `opencode.session.cost.total` | Histogram | `{USD}` | 每个 session 的费用总量（session idle 时记录）|
| `opencode.model.usage` | Counter | `{request}` | 按模型/provider 统计的请求数 |
| `opencode.retry.count` | Counter | `{retry}` | 通过 `session.status` 观测到的 API 重试次数 |

---

## 📁 项目结构

```
opentelemetry-instrumentation-opencode/
├── package.json
├── README.md
├── tsconfig.json
└── src/
    ├── index.ts          # Plugin 入口，事件路由
    ├── config.ts         # 环境变量解析
    ├── otel.ts           # OTel SDK 初始化（MeterProvider / TracerProvider / LoggerProvider）
    ├── probe.ts          # OTLP 端点连通性检测
    ├── types.ts          # HandlerContext、Instruments 等类型定义
    ├── util.ts           # Span 工具函数（genAiSpanAttrs、truncate 等）
    └── handlers/
        ├── session.ts    # session 生命周期（created / idle / error / status）
        ├── message.ts    # LLM 调用 Span、token/成本指标、session 历史
        ├── permission.ts # 工具权限请求/回复 Span
        └── activity.ts   # git commit、代码行数、工具耗时
```

---

## 🔧 工作原理

1. **Plugin 接入**：`OtelPlugin` 以 OpenCode plugin 形式注册，监听 OpenCode 的事件总线（`session.*`、`message.*`、`permission.*`、`command.*`）。

2. **Trace 构建**：每次用户发送消息时，创建 Entry → Agent span 链，后续的 LLM 调用、工具调用、权限请求均作为子 span 挂载其下，`session.idle` 时关闭链路。

3. **Metrics 采集**：基于 OTel `MeterProvider`，通过 `PeriodicExportingMetricReader` 按配置间隔上报；session 结束时额外上报 session 级别的 token/成本总量。

4. **进程退出保障**：拦截 `process.exit` 并统一 SIGTERM/SIGINT 信号处理，确保进程退出前执行 `forceFlush` + `shutdown`，最后一批 Span 不丢失。

5. **端点探测**：启动时 TCP 探测 OTLP 端点连通性，不可达时打印警告，不阻塞插件正常运行。

---

## 🗑️ 卸载

```bash
bash scripts/uninstall.sh
```

卸载脚本会自动：
- 清理 `~/.bashrc` / `~/.zshrc` / `~/.bash_profile` 中的环境变量配置块
- 卸载全局 npm 包

---

## 🛠️ 开发

```bash
# 安装依赖
bun install

# 运行测试
bun test

# 类型检查
bun run typecheck
```

---

## 📝 License

[MPL-2.0](./LICENSE)
