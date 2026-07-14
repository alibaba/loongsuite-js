# 更新日志

本文档记录 `opentelemetry-instrumentation-openclaw` 的重要变更。

## [0.1.5-beta] - 2026-07-14

### 新增

- **自定义 SpanProcessor 注入（`spanProcessorModule`）**：
  - 新增配置项 `spanProcessorModule`（或环境变量 `ARMS_SPAN_PROCESSOR_MODULE`），指向一个默认导出 `SpanProcessor` 的 JS/MJS 模块；绝对路径原样使用，相对路径相对 `OPENCLAW_HOME`（`~/.openclaw`）解析
  - 用于注入依赖 span 类型/内容的动态属性（如按 model 判定成本档位、按工具名判定工具类别），或将 span 转发到额外后端；补足 `globalSpanAttributes` 仅支持静态值的空缺
  - 通过包子路径导出 helper：`@loongsuite/opentelemetry-instrumentation-openclaw/span-processor` 提供 `defineGenAiSpanProcessor`，按 GenAI span 类型分派（`onLlmEnding`/`onToolEnding`/`onAgentEnding`/`onStepEnding`/`onEntryEnding`），并屏蔽语义规范方言差异
  - 加载失败/校验不通过时优雅降级到内置 processor；用户回调全程 try/catch 隔离，绝不影响内置导出管道
- **`openclaw.trace.close_reason` 诊断属性**：ENTRY span 上标注 trace 关闭方式（`normal` / `runid_recovered` / `stale_sweeper`），便于在 ARMS 中定位异常关闭的调用链

### 修复

- **修复跨天巨长 ENTRY/AGENT span（时长被拉到 1d+）**：
  - 根因：`agent_end` 仅按 channel 归属 context，当其解析到的 channel 与 `llm_input` 注册的 channel 不一致时，找不到本轮 context、关不掉已开的 ENTRY/AGENT span；这些泄漏的 span 在内存中滞留，直到之后某次 `agent_end` 或会话 reset 时以 `Date.now()` 被误关，产生天级时长
  - 主修：`agent_end` 在 channel 解析不到可关闭 span 时，用 openclaw 附带的 `runId` 兜回本轮 context（channel 优先、runId 补充，不改动常见路径）
  - 加固：过期上下文清扫器（sweeper）对仍开放的 ENTRY/AGENT/STEP span 主动强制关闭，使用**有界的最后活动时间**而非 `Date.now()`，并彻底清理所有查找结构
- **修复工具 span 因 channel 错配被静默丢弃**：`before_tool_call` 在 `agent/` 通道无锚点时，用 `runId` 兜回 context 恢复工具 span（并对 `runId==sessionId` 且上下文正在关闭的场景加守卫，避免挂到上一轮 trace）

### 说明

- 新增单元测试：`span-processor.test.ts`（类型分派/方言容错/优雅降级/运行时隔离）、`channel-mismatch-repro.test.ts`（工具 span channel 错配恢复）、`agent-end-stale-close.test.ts`（`agent_end` runId 兜回 + sweeper 有界强关）
- `spanProcessorModule` 会加载并执行本地任意代码，仅指向可信模块

---

## [0.1.4-beta] - 2026-05-26

### 新增

- **`gen_ai.tool.definitions` 属性采集**：
  - 从 `llm_input` hook 的 `tools` 字段提取工具定义列表，序列化为 JSON 写入 LLM span
  - 包含工具名称、类型、描述和参数 schema
  - 需要 OpenClaw >= 2026.5.14（低版本 `tools` 字段缺失，静默跳过）
- **`gen_ai.response.time_to_first_token` 属性采集**：
  - 新增监听 `model_call_ended` hook，从 `timeToFirstByteMs` 字段提取首包耗时
  - 转换为纳秒写入 LLM span，符合 OpenTelemetry GenAI 语义规范
  - 需要 OpenClaw >= 2026.4.27（低版本不触发 `model_call_ended`，静默跳过）
  - 每个 LLM span 携带各自对应的 TTFB（多次 LLM 调用场景下不再共享同一值）
  - 通过 Promise 通知 + 200ms 超时兜底确保首个 LLM span 也能获取到 TTFB
  - 老版本 OpenClaw（不支持 `model_call_ended`）自动跳过等待，零额外延迟
- **`gen_ai.agent.name` 属性传播至所有 GenAI span**：
  - 所有 GenAI span（ENTRY、AGENT、STEP、LLM、TOOL）均携带 `gen_ai.agent.name` 属性
  - 值来源于 `hookCtx.agentId`，在 `TraceContext` 生命周期内一致
  - 符合 ARMS GenAI 语义规范中"有条件时必须"的要求

### ⚠️ Breaking Changes

- **`otel.scope.name` 变更为 `aliyun.opentelemetry.instrumentation.openclaw`**：
  - 原值 `opentelemetry-instrumentation-openclaw`，现对齐跨语言探针命名规范
  - 同时变更 `ArmsExporter` 和 `ExtendedTelemetryHandler` 两处 tracer 创建的 scope name
  - **注意**：如有基于 `otel.scope.name` 的告警规则或 dashboard 查询，需同步更新

### 说明

- 在不支持 `model_call_ended` hook 的 OpenClaw 老版本上，`registerTypedHook()` 仅产生 warn 级别诊断日志，不影响插件加载和其他 hook 的正常工作
- 在 `llm_input` 不包含 `tools` 字段的老版本上，插件通过 nullish 检查静默降级
- 新增集成测试 Flow 7（工具定义 + TTFB）、Flow 8（向后兼容降级）和 Flow 9（`gen_ai.agent.name` 全量传播）
- 新增 `invocation-builder.test.ts` 单元测试（含 `gen_ai.agent.name` 覆盖）

---

## [0.1.3-beta] - 2026-05-07

### 背景

- `0.1.2` 版本已支持完整的 ReAct 多轮链路分段（ENTRY → AGENT → STEP → LLM/TOOL），但尚不支持 W3C Trace Context 传播，无法与上游调用方关联 trace。
- 本次 `0.1.3-beta` 的核心目标是：引入 trace 传播能力、迁移至 `@loongsuite/opentelemetry-util-genai` handler 架构、支持环境变量配置降级。

### 新增

- **自定义 Resource / Span 属性注入**：
  - 配置文件支持 `resourceAttributes`（注入到 Resource）和 `globalSpanAttributes`（注入到所有 span）
  - 环境变量支持 `OTEL_RESOURCE_ATTRIBUTES`（标准 OTel 格式 `key1=value1,key2=value2`）和 `OTEL_SPAN_ATTRIBUTES`（同格式）
  - 优先级：配置文件 > 环境变量；per-request `customAttributes` > `globalSpanAttributes` > 内置属性
  - 新增测试用例：`test/custom-attributes.test.ts`（13 个用例覆盖解析、优先级、注入、边界场景）
- **W3C Trace Context 传播**：
  - 支持从 HTTP 请求头 `traceparent` 继承上游 trace context，所有 span 自动关联到上游调用链
  - 支持向下游 LLM API 请求注入 `traceparent`，实现端到端全链路追踪
  - 配置项 `enableTracePropagation`（布尔）和 `propagationTargetUrls`（URL 子串数组）
- **WebSocket 消息体嵌入传播协议**（`<!--otel:{JSON}-->`）：
  - 支持在消息内容末尾嵌入 `<!--otel:{"tp":"00-...", "attr":{...}}-->` 传递 traceparent 和自定义属性
  - 自定义属性传播到 ENTRY/AGENT/STEP/LLM 所有 span
  - 安全限制：最多 20 个属性，key 最长 128 字符，value 最长 1024 字符，禁止 `openclaw.` 和 `gen_ai.` 前缀
- **环境变量配置降级**：当 `openclaw.json` 中未设置对应字段时，自动从环境变量读取：
  - `ARMS_OTLP_ENDPOINT` → endpoint
  - `ARMS_LICENSE_KEY` → headers.x-arms-license-key
  - `ARMS_PROJECT` → headers.x-arms-project
  - `ARMS_CMS_WORKSPACE` → headers.x-cms-workspace
  - `ARMS_SERVICE_NAME` / `OTEL_SERVICE_NAME` → serviceName
  - `ARMS_TRACE_DEBUG` → debug
  - `ARMS_ENABLE_TRACE_PROPAGATION` → enableTracePropagation
- Resource 新增 `gen_ai.agent.system=openclaw` 属性
- 插件 manifest 新增 `activation` 声明，兼容 OpenClaw 2026.5.4 gateway 启动加载机制
- 安装脚本自动检测 OpenClaw 版本，>= 2026.4.25 时写入 `hooks.allowConversationAccess: true`；低版本跳过以避免配置校验报错
- 新增测试用例：`trace-compat.test.ts`（999 行）、`trace-propagation.test.ts`（441 行）

### 变更

- **架构迁移**：span 构建和生命周期管理迁移至 `@loongsuite/opentelemetry-util-genai`：
  - 新增 `src/invocation-builder.ts`：统一构建 LLM/Tool/Entry/Agent/Step 的 invocation 对象
  - 新增 `src/invocation-compat.ts`：新旧 invocation 格式兼容层（消息序列化、finish_reasons、span kind dialect）
  - 新增 `src/trace-propagation.ts`：W3C Trace Context 解析、HTTP Server/Client monkey-patch、消息体嵌入提取
  - `src/index.ts` 重构：从直接操作 span 改为操作 invocation + handler 驱动
- 新增 `@loongsuite/opentelemetry-util-genai` 依赖
- 配置优先级明确为：配置文件 > 环境变量 > 默认值
- 安装脚本（`install.sh`、`install-wget.sh`、`install-local-test.sh`）新增 OpenClaw 版本检测，>= 2026.4.25 时写入 `hooks.allowConversationAccess`；低版本自动跳过

### 修复

- 修复 ENTRY/STEP span 结束时间虚高问题：将 ENTRY 和 STEP span 的 endTime 改为在 `agent_end` handler 同步阶段预先捕获，不再使用 `setTimeout` 回调内的 `Date.now()`。此前 OpenClaw 运行时在 agent 执行完成后的内部收尾处理（会话清理、上下文维护、消息交付等）会延迟回调执行，导致 ENTRY span 时长比实际请求处理时长多出数十秒。修复后 ENTRY、AGENT、STEP 三个 span 使用同一时间戳结束，`request.duration_ms` 也相应修正
- 修复 WebSocket 场景下自定义属性丢失问题：将 `extractOtelFromContent()` 和 `ensureEntrySpan()` 移出 `isUserMessage` 条件块，使 WebSocket 通道（`rawChannelId` 以 `agent/` 开头）也能正确提取 trace context 和 custom attributes
- 修复 OpenClaw 2026.5.4 插件不加载问题：manifest 缺少 `activation` 声明导致 gateway 启动时跳过加载

---

## [0.1.2] - 2026-03-26

### 背景

- `0.1.1` 版本的主链路结构为：`ENTRY -> AGENT -> LLM -> TOOL -> TOOL...`，尚不支持真实多轮 `LLM <-> TOOL` 交错分段。
- `0.1.1` 在并发场景下仍存在断链/串链风险（包括 runId 错绑、上下文误关联等）。
- 本次 `0.1.2` 的核心目标是：补齐多轮 LLM 分段能力、引入 STEP 轮次语义，并系统性修复并发稳定性。

### 新增

- 新增 ReAct 轮次的 STEP span 支持：
  - `gen_ai.span.kind=STEP`
  - `gen_ai.operation.name=react`
  - `gen_ai.react.round`
  - `gen_ai.react.finish_reason`
- 新增 ReAct STEP span，支持真实多轮链路分段追踪

### 变更

- 升级 Trace 层级，支持真实多轮交错链路：
  - `ENTRY -> AGENT -> STEP -> (LLM/TOOL...)`
- 重构并发会话/并发 run 的上下文状态管理。
- 将 LLM 分段主路径切换为 Hook 驱动（以 `before_message_write` 为主）。
- 优化 TOOL 匹配策略（优先 `toolCallId(+runId)`，缺失时同名 fallback）。
- 对齐插件本地 Hook 事件类型与 OpenClaw 源码定义。

### 修复

- 修复并发场景下 runId 迟到绑定与跨会话 runId 污染问题。
- 修复上下文清理竞态导致的孤儿 span/断链问题。
- 修复 exporter 在并发收尾时误清理父 span 状态的问题。
- 修复 `agent_end` 指标提取问题：
  - `agent.message_count` 改为基于 `event.messages` 计算
  - `agent.tool_call_count` 改为基于 assistant 工具调用块计数
  - AGENT usage token 改为使用缓存的 `llm_output` usage
- 修复同一 STEP 内连续 LLM span 可能缺失 `gen_ai.input.messages` 的问题（增加输入快照回退）。
  - 说明：该问题是在 `0.1.2` 实施过程中暴露并修复，不属于 `0.1.1` 既有问题。

### 说明

- 宿主运行时中，`after_tool_call` 偶发缺失 `runId`/`toolCallId` 仍可能发生；插件保留 fallback 匹配机制（设计内行为）。
