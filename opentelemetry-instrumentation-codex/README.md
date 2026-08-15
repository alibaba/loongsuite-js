# opentelemetry-instrumentation-codex

OpenAI Codex CLI 的 OpenTelemetry 可观测插件 — 将 AI Agent 执行链路上报到任何兼容 OTLP 的后端。

无需修改 Codex 源码。插件通过 Codex 内置的 Hooks 机制工作：在会话过程中累积事件，会话结束时解析 transcript 文件获取 token 用量，最终导出符合 ARMS GenAI 语义规范的 OpenTelemetry 链路数据。

多轮会话中，每一轮产生独立的 trace（唯一 traceId），所有轮次共享同一个 `gen_ai.session.id`。

### 数据输出方式

插件支持两种数据输出方式，可同时启用：

| 方式 | 说明 | 用途 |
|------|------|------|
| **OTLP 导出** | 直接上报到任何 OTLP 兼容后端 | 独立使用，接入 Jaeger / ARMS / Grafana Tempo 等 |
| **JSONL 日志** | 写入本地 JSONL 文件（event_t schema） | 与 [ai-agent-collector](https://github.com/alibaba/loongcollector) 集成，集中采集多个 Agent 数据 |

## Span 层级结构

遵循 [ARMS GenAI 语义规范](https://opentelemetry.io/docs/specs/semconv/gen-ai/)：

```
enter_ai_application_system (ENTRY)
└── invoke_agent codex (AGENT)          ← 汇总全部 token
    ├── react step (STEP, round=1)
    │   ├── chat <model> (LLM)          ← 每轮 LLM 调用均有 token 指标
    │   ├── execute_tool shell (TOOL)
    │   └── execute_tool apply_patch (TOOL)
    ├── react step (STEP, round=2)
    │   ├── chat <model> (LLM)
    │   └── execute_tool shell (TOOL)
    └── react step (STEP, round=3)
        └── chat <model> (LLM)          ← finish_reason=stop
```

### Span 属性覆盖

| Span 类型 | 关键属性 |
|---|---|
| LLM (`chat`) | `gen_ai.usage.input_tokens`, `output_tokens`, `total_tokens`, `cache_read.input_tokens`, `response.model`, `response.finish_reasons`, `conversation.id`, `provider.name`, `input/output.messages` |
| AGENT (`invoke_agent`) | `agent.name`, `request.model`, `response.model`, 汇总 `usage.*` token, `conversation.id`, `framework` |
| TOOL (`execute_tool`) | `tool.name`, `tool.call.id`, `tool.type`, `tool.call.arguments`, `tool.call.result` |
| STEP (`react`) | `react.round` |
| ENTRY (`enter`) | `session.id`, `conversation.id`, `input/output.messages` |

### Token 用量获取

Token 数据来源于 Codex 的 transcript JSONL 文件（`~/.codex/sessions/.../*.jsonl`）。Codex 在每次 LLM 调用后写入 `token_count` 事件，包含 `last_token_usage`（单次调用）和 `total_token_usage`（累计）。

插件在 Stop hook 时解析 transcript，按时序将 token 数据注入对应的 LLM span，并在 AGENT span 上汇总全轮次 token 总量。

---

## 快速开始

### 方式一：一行远程安装（推荐）

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-codex/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --service-name "my-codex-agent"
```

支持的参数：

| 参数 | 说明 |
|------|------|
| `--endpoint <url>` | OTLP 后端地址，写入 `~/.codex/otel-config.json` |
| `--service-name <name>` | 服务名 |
| `--headers <kv>` | OTLP 请求头（逗号分隔的 key=value） |
| `--debug` | 启用调试输出 |
| `--tarball-url <url>` | 覆盖默认的 tarball 下载地址 |
| `--lang zh\|en` | 强制输出语言 |

### 方式二：本地安装

```bash
# 从源码安装
cd opentelemetry-instrumentation-codex
bash scripts/install.sh

# 或通过 npm 全局安装
npm install -g @loongsuite/opentelemetry-instrumentation-codex
```

安装时自动将 hooks 注册到 `~/.codex/config.toml`。

### 验证安装

```bash
otel-codex-hook check-env
```

---

## 配置

支持两种配置方式：**配置文件** 和 **环境变量**。同一字段优先级：配置文件 > 环境变量 > 默认值。空字符串视同未设置。

### 配置文件：`~/.codex/otel-config.json`

唯一识别的配置文件路径（JSON 格式）。完整字段表：

| JSON 字段 | 环境变量 fallback | 默认值 | 说明 |
|---|---|---|---|
| `otlp_endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | `""` | OTLP/HTTP 后端地址；空值=不启用 trace 导出 |
| `otlp_headers` | `OTEL_EXPORTER_OTLP_HEADERS` | `""` | OTLP 请求头，逗号分隔 `k=v`，如 `Authorization=Bearer xxx` |
| `service_name` | `OTEL_SERVICE_NAME` | `""` | OTel resource `service.name` |
| `resource_attributes` | `OTEL_RESOURCE_ATTRIBUTES` | `""` | OTel resource attributes，逗号分隔 `k=v` |
| `log_enabled` | `OTEL_CODEX_LOG_ENABLED` | `false` | 是否写本地 JSONL 日志 |
| `log_dir` | `OTEL_CODEX_LOG_DIR` | `""` | JSONL 输出目录；空值时按 `~/.cache/opentelemetry.instrumentation.codex/sessions` 解析 |
| `log_filename_format` | `OTEL_CODEX_LOG_FILENAME_FORMAT` | `"hook"` | `hook` → `codex-YYYY-MM-DD.jsonl`（按日滚动）；其他值 → `codex.jsonl.YYYYMMDD` |
| `debug` | `CODEX_TELEMETRY_DEBUG` | `false` | 调试模式，trace 输出到 console；支持 `1` / `true`（**注意是 `CODEX_`,不是 `CLAUDE_`**） |

> ⚠️ JSON key **必须使用上表小写形式**。把 `OTEL_EXPORTER_OTLP_ENDPOINT` 这类大写名字塞进 JSON 不会被读取（那是环境变量名）。

#### 示例：仅 OTLP 上报

```json
{
  "otlp_endpoint": "https://your-otlp-endpoint:4318",
  "otlp_headers": "Authorization=Bearer xxx",
  "service_name": "my-codex-agent"
}
```

#### 示例：仅 JSONL 日志（与 ai-agent-collector / loongsuite-pilot 集成）

```json
{
  "log_enabled": true,
  "log_dir": "~/.loongsuite-pilot/logs/codex",
  "log_filename_format": "hook"
}
```

#### 示例：同时启用 OTLP 和 JSONL

两种输出独立，互不冲突。

```json
{
  "otlp_endpoint": "https://your-otlp-endpoint:4318",
  "otlp_headers": "Authorization=Bearer xxx",
  "service_name": "my-codex-agent",
  "log_enabled": true,
  "log_dir": "/path/to/logs"
}
```

### 环境变量

每个配置字段都有对应环境变量（见上表第二列）。

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-otlp-endpoint:4318"
export OTEL_EXPORTER_OTLP_HEADERS="x-api-key=your-key"
export CODEX_TELEMETRY_DEBUG=1
```

### OTel SDK 标准环境变量（仅环境变量生效）

以下变量由依赖库 `@loongsuite/opentelemetry-util-genai` 直接从 `process.env` 读取，**写到 `otel-config.json` 不会被读到**，必须通过环境变量设置：

| 环境变量 | 用途 |
|---|---|
| `OTEL_SEMCONV_STABILITY_OPT_IN` | 启用最新 GenAI 实验语义；值必须是 `gen_ai_latest_experimental` |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | 控制 prompt/response 内容采集；值如 `SPAN_ONLY` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP 协议；ARMS 必须 `http/protobuf` |

#### 启用消息内容采集

默认情况下 `gen_ai.input.messages` 和 `gen_ai.output.messages` 不包含在 span 中。启用方式：

```bash
export OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
```

> 注意：值必须是 `gen_ai_latest_experimental`，仅使用 `gen_ai` 不生效。

### 服务名优先级

1. `service_name`（配置文件）/ `OTEL_SERVICE_NAME`（环境变量）
2. `resource_attributes` / `OTEL_RESOURCE_ATTRIBUTES` 中的 `service.name=...`
3. 默认值 `codex-agent`

---

## 接入阿里云 ARMS

`~/.codex/otel-config.json`（小写 key）：

```json
{
  "otlp_endpoint": "https://proj-xxx.cn-hangzhou.log.aliyuncs.com/apm/trace/opentelemetry",
  "otlp_headers": "x-arms-license-key=xxx,x-arms-project=yyy,x-cms-workspace=zzz",
  "service_name": "my-app"
}
```

环境变量（SDK 标准变量，**只能**通过环境变量设置）：

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf      # ARMS 必须用 protobuf,JSON 不会被索引
export OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY
```

> 从 ARMS 控制台 → 接入中心 获取 `x-arms-license-key`、`x-arms-project` 和 `x-cms-workspace`。

---

## CLI 命令

```bash
otel-codex-hook install             # 注册 5 个 hook 到 ~/.codex/hooks.json,trust hash 写入 ~/.codex/config.toml [hooks.state]
otel-codex-hook install --quiet     # 抑制非错误 stderr(pilot 安装场景使用)
otel-codex-hook uninstall           # 清理 hooks.json + config.toml 中的 trust 段
otel-codex-hook uninstall --purge   # 同时删除 ~/.cache/opentelemetry.instrumentation.codex/
otel-codex-hook check-env           # 检查配置状态（OTLP + JSONL 日志）
otel-codex-hook show-config         # 打印 hook 配置（TOML/JSON 格式）
```

> install 流程会同时:① 生成 `~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh` Node wrapper;② 把 5 个 hook 写入 `~/.codex/hooks.json`(若已有用户其他 hook,append 而不覆盖);③ 计算 5 个 SHA-256 trust hash 写入 `~/.codex/config.toml` 的 `[hooks.state]` 段(BEGIN/END marker 包裹);④ 若 `[features] hooks = false` 改为 `true` 并 stderr 警告。

### Hook 事件

| 命令 | Hook 事件 | 说明 | 写入 hooks.json 的 command |
|------|-----------|------|----------|
| `session-start` | SessionStart | 初始化会话状态 | `bash <hook-entry.sh> session-start` |
| `user-prompt-submit` | UserPromptSubmit | 记录用户输入 | `bash <hook-entry.sh> user-prompt-submit` |
| `pre-tool-use` | PreToolUse | 记录工具调用开始 | `bash <hook-entry.sh> pre-tool-use` |
| `post-tool-use` | PostToolUse | 记录工具调用完成 | `bash <hook-entry.sh> post-tool-use` |
| `stop` | Stop | 解析 transcript、生成并导出 trace + JSONL | `bash <hook-entry.sh> stop` |

`<hook-entry.sh>` 是 install 时生成的 wrapper(`~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh`),内含 Node.js 路径自动探测逻辑。

---

## 手动配置 Hooks

> ⚠️ **不推荐手动配置**。新版 codex(>= 2026-04-22 stable hooks)对每个 hook 启用了 trust 机制,需要在 `~/.codex/config.toml` 的 `[hooks.state."<key>"]` 写入与 hook 内容匹配的 SHA-256 `trusted_hash`,hash 算法包含绝对路径,不可手抄。请直接使用:

```bash
otel-codex-hook install
```

旧版本插件(及更早 codex 版本)曾把 hooks 直接写到 `~/.codex/config.toml`,新版插件只读 `~/.codex/hooks.json` + `[hooks.state]` 中的 trust hash,这种老格式已**不再被识别**。如果你的 `config.toml` 含老格式段(`# OpenTelemetry instrumentation hooks` 注释 + `[[hooks.X]]` 数组段),`otel-codex-hook install` 会自动清理。

排查 hook 是否生效:

```bash
codex                # 启动 TUI;若有 Untrusted/Modified hook 会自动弹出 "Hooks need review"
                     # 或在输入框输入 /hooks 查看所有 hook trust 状态
```

更多诊断方法见 `loongsuite-pilot` 的 `~/.loongsuite-pilot/skills/references/codex-diagnostics.md`。

---

## 卸载

```bash
# 方式一：使用卸载脚本
bash scripts/uninstall.sh

# 方式二：使用 CLI
otel-codex-hook uninstall

# 完全清理（包括缓存和会话数据）
otel-codex-hook uninstall --purge
```

卸载会移除 `~/.codex/config.toml` 中的 hooks 配置和 `~/.local/bin/otel-codex-hook` wrapper（如果存在）。会话数据保留在 `~/.cache/opentelemetry.instrumentation.codex/sessions/`，如需完全删除：

```bash
rm -rf ~/.cache/opentelemetry.instrumentation.codex
```

---

## 开发

```bash
npm install
npm run build       # 编译 TypeScript（tsup）
npm run dev         # 监听模式
npm run typecheck   # 仅类型检查
```

### 打包

```bash
bash scripts/pack.sh
# 输出: dist/otel-codex-hook.tar.gz
```

要求 Node.js >= 18.0.0。

---

## 许可证

Apache-2.0 — 详见 [LICENSE](../LICENSE)。
