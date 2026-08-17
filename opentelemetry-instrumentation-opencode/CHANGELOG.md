# Changelog

本文档记录 `@loongsuite/opentelemetry-instrumentation-opencode` 的重要变更。  
格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **Per-signal OTLP 端点**：安装脚本和运行时支持 `--traces-endpoint`、`--metrics-endpoint`、`--logs-endpoint` 参数，对应环境变量 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `METRICS` / `LOGS`，允许为 Traces、Metrics、Logs 分别指定独立的完整 URL 端点（优先于基础 `--endpoint`）。
- **LLM 应用标识**：Resource 属性新增 `acs.arms.service.feature: "genai_app"`，用于 ARMS 侧识别 GenAI 应用。
- **STEP Span**：为 ReAct 循环引入步骤级别的 Span（`step-start` / `step-finish`），LLM 和 TOOL Span 自动挂载到当前 STEP Span 下，链路树结构变为 ENTRY → AGENT → STEP → LLM / TOOL。
- **LLM Span 新增属性**：`gen_ai.response.model`、`gen_ai.response.finish_reasons`（JSON 数组）、`gen_ai.response.time_to_first_token`（纳秒）、`gen_ai.response.reasoning_time`（毫秒）、`gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_creation.input_tokens`、`gen_ai.output.type`、`gen_ai.system_instructions`。
- **AGENT Span 累计 token**：每次 LLM 调用完成后，在 AGENT Span 上更新累计的 `input_tokens`、`output_tokens`、`cache_read.input_tokens`、`cache_creation.input_tokens`。
- **ENTRY Span TTFT**：在第一个 text part 到达时，为 ENTRY 和 AGENT Span 写入 invocation 级别的 `gen_ai.response.time_to_first_token`。
- **通用属性**：所有 GenAI Span 新增 `gen_ai.user.id`（= sessionID）和 `gen_ai.framework`（固定 `opencode`）。

### 变更

- `accumulateSessionTotals` 扩展为分别累计 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`，不再仅记录总量。
- `SessionTotals` 类型新增 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 字段。
- `ActiveMessageSpan` 类型新增 `startTimeMs`、`firstTextTimeMs`、`reasoningTimeMs` 字段，用于计算 TTFT 和推理时间。
- `ActiveInvocation` 类型新增 `entryStartTime`、`firstTokenSet` 字段。

### 修复

- README 中 `gen_ci.usage.output_tokens` typo 修正为 `gen_ai.usage.output_tokens`。

## [0.5.0] - 2026-04-15

### 破坏性变更

- **包名**：由 `@ali/opencode-plugin-otel` 更名为 `@loongsuite/opentelemetry-instrumentation-opencode`。依赖与安装方式需同步更新。
- **发布配置**：移除 `publishConfig.registry`（原指向阿里云内网 AnPM）。发布到 npm 或私有 registry 时请在项目或 CI 中自行配置 registry。

### 变更

- **`package.json` 元数据**：补充 `description`、`license`、`keywords`、`homepage`、`bugs`，以及 `repository.directory`（指向本 monorepo 子目录）。
- **OpenCode 应用日志**：`client.app.log` 的 `service` 字段由 `loongsuite-instrumentation-opencode` 改为 `loongsuite/opentelemetry-instrumentation-opencode`，与新的包标识一致。

### 新增

- 脚本：`npm run test`（底层为 `bun test`），与现有 `npm run typecheck` 一并用于本地校验。

### 迁移说明

从旧包迁移时：

1. 将依赖中的 `@ali/opencode-plugin-otel` 替换为 `@loongsuite/opentelemetry-instrumentation-opencode`（版本号请使用 `0.5.0` 或更高）。
2. 若曾依赖内网 registry 安装旧包，请改为在 `.npmrc` 或 CI 中配置可访问的 npm 源后再安装。
3. 若你在日志或监控中按 `service` 字段过滤 OpenCode 插件日志，请将过滤条件更新为 `loongsuite/opentelemetry-instrumentation-opencode`。
