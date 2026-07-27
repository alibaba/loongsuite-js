# Changelog

## 0.1.0 (2026-07-27)

首个 npm 正式稳定版本，包含 `0.1.0-beta.0` 至 `0.1.0-beta.13`
期间完成的能力与修复，以及以下多模态增强。

### Features

- **多模态 URI 元数据自动采集**：启用实验语义规范并将消息内容采集到
  Span 时，自动从 LLM 输入和输出消息的 `Uri` Part 汇总
  `gen_ai.input.multimodal_metadata` /
  `gen_ai.output.multimodal_metadata`；行为与 Python util 保持一致，仅汇总
  URI，不包含 Blob、Base64Blob 或 File。

### Bug Fixes

- **多模态消息字段规范化**：TypeScript 公共 API 继续使用 `mimeType` /
  `fileId`，写入 `gen_ai.input.messages`、`gen_ai.output.messages` 和
  `gen_ai.system_instructions` 时转换为 Schema 要求的 `mime_type` /
  `file_id`。
- **Instrumentation scope 版本一致性**：默认 `otel.scope.version` 与 npm
  包版本统一为 `0.1.0`。

## 0.1.0-beta.13 (2026-07-23)

### Features

- **GenAI Skill 属性支持**：`ExecuteToolInvocation` 新增
  `skillName` / `skillId` / `skillVersion` / `skillDescription`，并在
  `execute_tool` span 写入对应 `gen_ai.skill.*` 属性。
- **Event Log Skill 自动识别**：批处理和流式转换默认识别 `Skill` /
  `load_skill` / `read_skill` / `skill_view` / `skill_manage` 等一等公民工具，
  并从 tool-call arguments 的 `skills/<name>/...` 路径识别读取定义、访问
  Skill 资源与执行脚本等操作。
- 新增 `ConvertOptions.skillDetection` / `TurnStreamOptions.skillDetection`，
  支持关闭推断、自定义工具名、关闭路径启发式和同步自定义 detector。
- 显式 `gen_ai.skill.*` 始终优先且在关闭推断时仍保留；配置同时覆盖 batch、
  streaming 和嵌套 Subagent。

### Documentation

- 新增 `docs/skill-support.md`，说明 Skill 语义、识别范围、优先级、配置、
  示例与边界。

## 0.1.0-beta.12 (2026-07-23)

### Bug Fixes

- **显式 trace context**：`TurnStreamSession` 可通过 `traceId` / `parentSpanId` 接收权威父上下文；ENTRY 创建后的冲突 context 会被忽略并产生 `LATE_TRACE_CONTEXT_IGNORED` 告警。
- **释放 subagent 驻留记录**：父 TOOL finalize 后立即释放已消费的 subagent payload；迟到或找不到父 TOOL 的记录会分别产生 `LATE_SUBAGENT_DROP` / `UNMATCHED_SUBAGENT_DROP` 告警，并计入 `lateDroppedRecordCount`。
- **补齐流式分批字段**：在 STEP finalize 前增量刷新 `system_instructions` / `tool_definitions`，并在 `end()` 时回填 AGENT，保持与批处理字段一致。
- **修正内存可观测性与文档**：`pendingRecordCount` 统计父 step、subagent 和用户输入记录；明确 grace 窗口约束以及剩余的 O(step count) / O(total input size) 状态。
- **稳定 CI 内存测试**：为显式 GC 压测设置合理超时，避免默认 5 秒限制导致 Node.js 20/22 作业失败或取消。

## 0.1.0-beta.11 (2026-07-21)

### Features

- **流式 Event Log → Trace 转换 API**：新增 `createTurnStreamSession` / `TurnStreamSession`。单个 turn 的生命周期为 `push(records)` → `end()`：ENTRY/AGENT 在首次 push 时创建并**保持打开**，每个**完整的 step** 增量转换、其子 span 立即导出并释放，turn 结束时才关闭 ENTRY/AGENT 并写入 turn 级聚合。使内存与 turn 内 step 数解耦（适用于数千轮 react 的超长 turn，规避一次性转换的 OOM）。
  - **`graceSteps`（look-back 窗口，默认 2）**：一个 step 只有在其后又出现 `graceSteps` 个新 step.id 时才 finalize，容忍上游有限的乱序发射（如同毫秒 tie 导致的 distance-1 交错）。
  - **`lateDroppedRecordCount` + `LATE_STEP_DROP` 警告**：超出 look-back 窗口的迟到记录会被丢弃并计数/告警，供调用方观测（而非静默丢失）。
  - **`pendingRecordCount` 只读探针**：当前缓冲(未 finalize)的记录数，恒定在 grace 窗口内，可用于监控驻留。
- **SPEC §2.5「事件按 step 顺序输出」约束**：批处理转换仍与顺序无关；流式消费方以 K 个 step 的 look-back 窗口判定 step 完成，据此约定上游应连续输出同一 step 的事件。

### Internal

- 抽取共享的 `accumulateResponseUsage` / `newResponseUsageAcc` / `usageFieldsFromAcc`（token 聚合的单一真源，批处理 `buildInvokeAgentInvocation` 与流式会话共用，行为等价）；导出 `parseInputMessages` / `parseOutputMessages`。
- **批处理路径 `convertEventLogToTrace` / `convertTurn` 保持不变**：流式作为独立 API，现有全部单测(222，含 1 个需 `--expose-gc` 的堆测量)与逐 span 等价对拍全绿。

## 0.1.0-beta.10 (2026-07-14)

### Features

- **公共属性 Baggage 自动透传**：`startEntry` / `startInvokeAgent` / `startCreateAgent` 现在会把已设置的 `gen_ai.agent.name` / `gen_ai.user.id` / `gen_ai.session.id` 写入 OpenTelemetry Baggage;在该 Entry/Agent span 生命周期内(以其 `contextToken` 为父 context 创建的)LLM / Tool / ReAct Step / Embedding / Retrieval / Rerank / Memory 等 GenAI 子 span 会**自动继承**这三个公共属性,无需在每个子 invocation 上手动设置。
  - **fill-only**:仅当子 invocation 对应字段为空时才回填,显式设置的值始终优先。
  - 仅作用于本工具创建的 GenAI span;通过 OTel SDK 直接创建的普通业务 span 不受影响。
  - 探针创建的子 span 能否继承取决于探针是否读取 baggage(本工具负责把值写入 baggage)。
- 新增并导出 helper `setCommonBaggage(ctx, attrs)` / `backfillCommonFromBaggage(invocation, ctx)`。

### Bug Fixes

- 清理基础 `TelemetryHandler.startLlm` 中一处无副作用的空操作 `context.with(...)`。

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

## Pre-release baseline (2026-04-14)

> 源码初始实现里程碑；未以正式 `0.1.0` 发布到 npm。

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
