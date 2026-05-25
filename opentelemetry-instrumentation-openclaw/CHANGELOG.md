# 更新日志

本文档记录 `opentelemetry-instrumentation-openclaw` 的重要变更。

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
