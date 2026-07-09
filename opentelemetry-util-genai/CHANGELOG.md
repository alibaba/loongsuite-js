# Changelog

## 0.1.0-beta.9 (2026-07-08)

### Features

- **自定义字段透传**：`convertEventLogToTrace` / `convertEventLogToReadableSpans` 新增 `ConvertOptions.passthroughKeys` 白名单,可把 event log 里的自定义字段原样(不改名)写到对应 span。
  - 粒度:turn 级字段广播到该 turn 的全部 span(ENTRY/AGENT/STEP/LLM/TOOL);LLM/TOOL 额外读取自身源 record,同名时 per-record 覆盖 turn 级。
  - **fill-only 语义**:透传仅在 span 尚未携带该属性时写入,永不覆盖转换器已产出的属性(token 聚合、model、common 属性、TTFT 等)。
  - 不传 `passthroughKeys` 时行为完全不变(向后兼容)。
- 新增并导出 helper `applyPassthroughAttributes(attrs, passthrough)`(fill-only 合并),供直接构建 invocation 的插件作者复用。

### Bug Fixes

- **total_tokens 优先采用上游值**：LLM / AGENT span 的 `gen_ai.usage.total_tokens` 现在优先采用 event log 里上游报告的 `gen_ai.usage.total_tokens`,仅当上游未提供时才回退到计算值 `input + output`。此前一律用 `input + output`,忽略上游值,导致 cache 占比高的 provider(如 Anthropic)total 偏小。AGENT 聚合遵循「全部 token response 都报了 total 才用其求和,否则整体回退」,避免上游值与计算值混用。⚠️ 属于行为变更:上游携带 `total_tokens` 的数据,span 上的 total 数值会随之改变。

### Type Changes (additive, backward compatible)

- `LLMInvocation` / `EntryInvocation` / `InvokeAgentInvocation` / `ReactStepInvocation` / `ExecuteToolInvocation` 新增可选字段 `passthroughAttributes?: Record<string, unknown>`。
- `LLMInvocation` / `InvokeAgentInvocation` 新增可选字段 `totalTokens?: number | null`(上游报告的 total,未设置时按 `input + output` 计算)。

## 0.1.0-beta.8 (2026-06-24)

### Bug Fixes

- **TTFT 透传**：`buildLlmInvocation` 现在从 event log 的 `gen_ai.response.time_to_first_token`（纳秒）读取首包延迟并通过 `invocation.attributes` 写入 LLM span。之前该字段在 event log → OTLP trace 链路中被丢弃（SLS/JSONL/HTTP flusher 不受影响）。
- **parent_span_id 读取范围收窄**：`groupByTurn` 现在只从 `event.name="other"` 事件读取 `parent_span_id`（做法 A 的 ENTRY 标记事件）。之前从所有事件读取，与 pilot hook processor 在每条事件上写入 intra-trace 父 span ID 的既有约定冲突，导致多步 turn 必触发 `Inconsistent parent_span_id` false-positive warning，且 ENTRY span parentSpanId 被错误设为某个 STEP span ID。

## 0.1.0-beta.6 (2026-06-16)

### Features

- **支持上游 parentSpanId**：`convertEventLogToTrace` 现在从 event log 的 `parent_span_id` 字段读取上游 span ID，作为 ENTRY span 的真实 parent，实现插件 trace 与上游调用方 trace 的 parent-child 真实关联（如上游平台 → claude-code → LLM/TOOL 的完整链路）。不含 `parent_span_id` 的 records 维持原有 synthetic parent 行为（完全向后兼容）。
- 新增 `isValidSpanId` 校验函数并导出。

## 0.1.0-beta.5 (2026-06-09)

### Features

- **Subagent 嵌套**：当 TOOL span 有关联的子 session records（标记 `gen_ai.agent.scope=subagent` + `gen_ai.subagent.parent_tool_call.id`）时，转换器在 TOOL span 下自动创建嵌套的 `AGENT → STEP → LLM/TOOL` 子树。子 records 不参与父级 ENTRY/AGENT 的 token 聚合和 output.messages 构建。TOOL span 时间范围自动扩展以包裹子 agent。初始版本支持 1 层嵌套。不含 subagent 标记的 records 行为完全不变（向后兼容）。

## 0.1.0-beta.4 (2026-06-01)

### Features

- **做法 A 支持**：`event.name = "other"` 事件中的 `gen_ai.input.messages_delta` / `gen_ai.input.messages` 现在被提取为 ENTRY/AGENT 的用户输入。所有 `other` 事件不生成任何 span（有 messages 的归 ENTRY，没 messages 的静默丢弃）。做法 B（legacy user-hook llm.request）仍兼容但标记为 deprecated。

### Bug Fixes

- **STEP span startTime 防御性修复**：STEP 的 startTime 现在优先取 step 内 LLM 事件（`llm.request` / `llm.response`）的最早时间，仅在无 LLM 事件时 fallback 到全部 records 的最早时间。修复上游 tool.call 事件 step.id 标错时 STEP span 时间范围被拉歪（如 48s vs 实际 1.6s）的问题。正常数据下行为不变。

### Documentation

- **EVENT_LOG_TO_TRACE_SPEC.md §5 重写**：做法 A（event.name="other"）升级为 [MUST] 推荐；做法 B 标为已过期准备废弃。
- **EVENT_LOG_TO_TRACE_SPEC.md 8 处修正**（基于 review）：§11 warnings 合格标准排除 user-hook 类；§3.4 AGENT token 双算风险约束；§5.1 真实 LLM 调用必须自带用户消息；§3.2 model fallback 链；§4.2 合并策略细节表；§11 补 peer dep 安装提示；§2.4 round 正则限制说明；§8.2 事件→span 非一一对应措辞。

## 0.1.0-beta.2 (2026-06-01)

### Features

- **response.id 自动合并**：同一 step 内多条 `llm.response` 如果带相同的 `gen_ai.response.id`，转换器会在配对前自动合并为一条（parts 按时间顺序拼接，token 取有值的那条，model/finish_reason 取最后非空值）。解决 qoder / cursor 等上游把 thinking + text 拆成 2 条 event 导致"残影 LLM span"的问题。
- **response-only model fallback**：当 `llm.response` 没有配对的 `llm.request` 时，`gen_ai.request.model` 现在会 fallback 到 `gen_ai.response.model`。之前这种场景 model 字段为 undefined（span name 显示为 `chat unknown`）。

### Documentation

- 更新 `EVENT_LOG_TO_TRACE_SPEC.md` §4.2 / §12，反映 response.id 合并兼容路径。
- 更新 `PLUGIN_FEEDBACK_QODER.md` / `PLUGIN_FEEDBACK_CURSOR.md`，同步修正。

## 0.1.0-beta.1 (2026-05-28)

### Features

- **ARMS GenAI common attributes coverage** — `gen_ai.agent.name`, `gen_ai.user.id`, `gen_ai.session.id` are now written on **every span kind** (ENTRY / AGENT / STEP / LLM / TOOL / EMBEDDING / RETRIEVER / RERANKER / MEMORY), per ARMS GenAI semantic conventions update. Previously only some span kinds carried them.
- New helper `applyCommonGenAiAttributes(attrs, invocation)` in `span-utils` for plugin authors who build invocations directly.
- Event log → trace converter automatically resolves these three attributes per turn (with fallback `gen_ai.agent.name → gen_ai.agent.type`) and propagates to all generated spans.

### Type Changes (additive, backward compatible)

- `LLMInvocation` adds `agentName?` / `userId?` / `sessionId?`
- `ExecuteToolInvocation` adds the same three
- `ReactStepInvocation` adds the same three
- `EmbeddingInvocation` / `RetrievalInvocation` / `RerankInvocation` add the same three
- `InvokeAgentInvocation` adds `userId?` / `sessionId?` (already had `agentName`)
- `EntryInvocation` adds `agentName?` (already had `sessionId`/`userId`)
- `MemoryInvocation` adds `agentName?` / `sessionId?` (already had `userId`)

All new fields are optional — plugins ignoring them stay fully backward compatible.

## 0.1.0-beta.0 (2026-05-27)

### Features

- First public beta on npm under `@loongsuite/otel-util-genai`.
- Event log → OTel span tree converter (`convertEventLogToTrace` / `convertEventLogToReadableSpans`).
- user-hook events auto-merge into ENTRY span input.messages.

## 0.1.0 (2026-04-14)

### Features

- Initial release of `@loongsuite/otel-util-genai`
- `TelemetryHandler` for LLM invocation lifecycle management (start/stop/fail + callback pattern)
- `ExtendedTelemetryHandler` with support for all GenAI operation types:
  - LLM (chat/completion)
  - Create Agent / Invoke Agent
  - Embedding
  - Execute Tool
  - Retrieval
  - Rerank
  - Memory (add, search, update, delete, etc.)
  - Entry (AI application system entry point)
  - ReAct Step (Reasoning-Acting iteration)
- Custom `instrumentationName` / `instrumentationVersion` options for controlling `otel.scope.name` and `otel.scope.version` on emitted spans
- Custom `startTime` / `endTime` passthrough on all start/stop methods for event-driven timestamp control
- Span attribute utilities following OpenTelemetry GenAI semantic conventions
- Metrics recording with duration and token usage histograms
- Environment variable configuration for content capturing and event emission
- Extended semantic convention constants (`gen_ai.span.kind`, memory attributes, etc.)
- Complete TypeScript type definitions for all invocation types
- `@opentelemetry/api` as peer dependency for proper singleton sharing
- Vitest-based test suite with 92 tests
