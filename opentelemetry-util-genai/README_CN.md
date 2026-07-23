# @loongsuite/otel-util-genai

面向 Node.js 的 OpenTelemetry GenAI 工具库 — 为生成式 AI 操作提供标准化的遥测数据采集，涵盖 LLM、Agent、Embedding、Tool、Retrieval、Rerank、Memory、Entry 和 ReAct Step。

本库是 Python 版 `opentelemetry-util-genai` 的 Node.js 等价实现，遵循相同的语义约定和 API 设计模式。

## 安装

```bash
npm install @loongsuite/otel-util-genai
```

## 功能特性

- **LLM（聊天/补全）**：追踪 LLM 请求，支持完整消息内容、Token 用量和流式首 Token 时间（TTFT）
- **Agent**：创建和调用 Agent，支持工具定义和会话上下文
- **Embedding**：监控向量嵌入生成，包括维度数和编码格式
- **Tool 执行**：追踪工具调用的参数和返回结果
- **Retrieval（检索）**：观测从向量数据库检索文档的查询和结果
- **Rerank（重排）**：追踪文档重排操作及评分详情
- **Memory（记忆）**：记录记忆操作（添加、搜索、更新、删除等）
- **Entry（入口）**：标记 AI 应用系统入口点，包含会话/用户上下文
- **ReAct Step（推理-行动步骤）**：追踪 Agent 中的每一轮推理-行动迭代

## 快速开始

### 使用 TelemetryHandler（仅 LLM）

```typescript
import {
  TelemetryHandler,
  createLLMInvocation,
} from "@loongsuite/otel-util-genai";

const handler = new TelemetryHandler();

// 回调模式（推荐）
await handler.llm(
  createLLMInvocation({
    requestModel: "gpt-4",
    provider: "openai",
    inputMessages: [
      { role: "user", parts: [{ type: "text", content: "Hello!" }] },
    ],
  }),
  async (inv) => {
    // 在此调用你的 LLM API...
    inv.outputMessages = [
      {
        role: "assistant",
        parts: [{ type: "text", content: "Hi there!" }],
        finishReason: "stop",
      },
    ];
    inv.inputTokens = 5;
    inv.outputTokens = 10;
  },
);

// 或使用手动 start/stop 模式
const inv = createLLMInvocation({ requestModel: "gpt-4", provider: "openai" });
handler.startLlm(inv);
try {
  // 调用你的 LLM API...
  inv.inputTokens = 5;
  inv.outputTokens = 10;
  handler.stopLlm(inv);
} catch (err) {
  handler.failLlm(inv, {
    message: String(err),
    type: err instanceof Error ? err.constructor.name : "Error",
  });
}
```

### 使用 ExtendedTelemetryHandler（全部操作类型）

```typescript
import {
  ExtendedTelemetryHandler,
  createEmbeddingInvocation,
  createRetrievalInvocation,
  createInvokeAgentInvocation,
  createMemoryInvocation,
} from "@loongsuite/otel-util-genai";

const handler = new ExtendedTelemetryHandler();

// Embedding（向量嵌入）
handler.embedding(
  createEmbeddingInvocation("text-embedding-3-small"),
  (inv) => {
    inv.inputTokens = 100;
    inv.dimensionCount = 1536;
  },
);

// Retrieval（检索）
handler.retrieval(
  createRetrievalInvocation({ dataSourceId: "my_vector_store", topK: 5 }),
  (inv) => {
    inv.documents = [
      { id: "doc1", score: 0.95, content: "..." },
      { id: "doc2", score: 0.87, content: "..." },
    ];
  },
);

// Agent（智能体）
await handler.invokeAgent(
  createInvokeAgentInvocation("openai", { agentName: "research-agent" }),
  async (inv) => {
    // ... Agent 调用逻辑
    inv.inputTokens = 500;
    inv.outputTokens = 200;
  },
);

// Memory（记忆）
handler.memory(createMemoryInvocation("search", { userId: "user-1" }), (inv) => {
  inv.outputMessages = [{ content: "remembered context" }];
});
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|---|---|---|
| `OTEL_SEMCONV_STABILITY_OPT_IN` | 设为 `gen_ai_latest_experimental` 以启用实验性功能 | - |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | 内容采集模式：`NO_CONTENT`、`SPAN_ONLY`、`EVENT_ONLY`、`SPAN_AND_EVENT` | `NO_CONTENT` |
| `OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT` | 是否发射 `gen_ai.client.inference.operation.details` 事件：`true`/`false` | 取决于内容采集模式 |

## 支持的操作类型

| 操作 | Span Kind | `gen_ai.operation.name` | Handler 方法 |
|---|---|---|---|
| LLM 聊天 | LLM | `chat` | `llm()` / `startLlm()` |
| 创建 Agent | AGENT | `create_agent` | `createAgent()` / `startCreateAgent()` |
| 调用 Agent | AGENT | `invoke_agent` | `invokeAgent()` / `startInvokeAgent()` |
| Embedding | EMBEDDING | `embeddings` | `embedding()` / `startEmbedding()` |
| 执行 Tool | TOOL | `execute_tool` | `executeTool()` / `startExecuteTool()` |
| Retrieval | RETRIEVER | `retrieval` | `retrieval()` / `startRetrieval()` |
| Rerank | RERANKER | `rerank_documents` | `rerank()` / `startRerank()` |
| Memory | MEMORY | `memory_operation` | `memory()` / `startMemory()` |
| Entry | ENTRY | `enter` | `entry()` / `startEntry()` |
| ReAct Step | STEP | `react` | `reactStep()` / `startReactStep()` |

## 语义约定

本库遵循 [OpenTelemetry GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)，并包含 LoongSuite 扩展：

- `gen_ai.span.kind` — 逻辑 Span Kind 分类
- 扩展操作名称（`retrieval`、`rerank_documents`、`enter`、`react`）
- Memory 操作属性（`gen_ai.memory.*`）
- 缓存 Token 用量（`gen_ai.usage.cache_creation.input_tokens`、`gen_ai.usage.cache_read.input_tokens`）
- 总 Token 计算（`gen_ai.usage.total_tokens`）
- 首 Token 时间（`gen_ai.response.time_to_first_token`）

## API 参考

### 核心类

- **`TelemetryHandler`** — 管理 LLM 调用生命周期，包括 Span、指标和事件发射
- **`ExtendedTelemetryHandler`** — 继承 `TelemetryHandler`，支持全部 GenAI 操作类型

### 工厂函数

- `createLLMInvocation(init?)` — 创建 LLM 调用对象（带默认值）
- `createEmbeddingInvocation(requestModel, init?)` — 创建 Embedding 调用对象
- `createExecuteToolInvocation(toolName, init?)` — 创建工具执行调用对象
- `createCreateAgentInvocation(provider, init?)` — 创建 Agent 创建调用对象
- `createInvokeAgentInvocation(provider, init?)` — 创建 Agent 调用对象
- `createRetrievalInvocation(init?)` — 创建检索调用对象
- `createRerankInvocation(provider, init?)` — 创建重排调用对象
- `createMemoryInvocation(operation, init?)` — 创建记忆操作调用对象
- `createEntryInvocation(init?)` — 创建入口调用对象
- `createReactStepInvocation(init?)` — 创建 ReAct 步骤调用对象

### 单例访问器

- `getTelemetryHandler(options?)` — 获取或创建默认的 `TelemetryHandler`
- `getExtendedTelemetryHandler(options?)` — 获取或创建默认的 `ExtendedTelemetryHandler`

## Event Log → Trace 转换

本包提供将 [loongsuite-pilot AI 事件日志规范](https://github.com/alibaba/loongsuite-pilot)
格式的事件流转换为符合 ARMS GenAI 语义规范的 OTel span 树
（`ENTRY → AGENT → STEP → LLM/TOOL`）的能力。Agent 插件可以只输出 event log，
trace 结构的构造交给本 SDK 完成。

```ts
import { readFileSync } from "node:fs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  ExtendedTelemetryHandler,
  convertEventLogToTrace,
} from "@loongsuite/otel-util-genai";

const provider = new BasicTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

const records = JSON.parse(readFileSync("turn-events.json", "utf-8"));
const { traceIds, spanCount, warnings } = convertEventLogToTrace(records, {
  handler,
  strict: false,
});
await provider.forceFlush();

console.log(`已导出 ${spanCount} 个 span，覆盖 ${traceIds.length} 个 trace`);
if (warnings.length) console.warn(warnings);
```

### 辅助函数：直接获取 `ReadableSpan[]`

如果你**没有**现成的 TracerProvider——例如你在做 pilot / 下游 exporter，
需要拿到 span **数据**喂给自己的 `OTLPTraceExporter`——用辅助函数：

```ts
import { convertEventLogToReadableSpans } from "@loongsuite/otel-util-genai";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

const exporter = new OTLPTraceExporter({ url, headers });
const { spans, traceIds, warnings } = await convertEventLogToReadableSpans(records);
exporter.export(spans, (result) => {
  if (result.code !== 0) console.error("export failed", result.error);
});
```

辅助函数内部一次性创建私有 `BasicTracerProvider` + `InMemorySpanExporter`，
运行转换、抓取 finished spans 后销毁 provider。**绝不**注册到全局，不会污
染宿主进程的 OTel context。运行时需要 `@opentelemetry/sdk-trace-base`
（声明为可选 peer dep——由消费方安装）。

### 行为要点

- 按 `gen_ai.turn.id` 分组（每个 turn 一个独立 OTel trace），再按
  `gen_ai.step.id` 分组（每个 step 一个 STEP span）。
- 同一 step 内 `llm.request` + `llm.response` 配对成 1 个 LLM span；
  `tool.call` + `tool.result` 配对成 1 个 TOOL span。
- 事件日志中的 `trace_id` 会被消费——生成的 span 通过虚拟父 context 继承同
  一个 trace_id。若缺失则由 SDK 自动分配。
- `gen_ai.input.messages_delta` 会在整个 turn 内累积，重建出每个 LLM span
  完整的 `gen_ai.input.messages`。
- `gen_ai.usage.total_tokens` 优先采用上游报告值；仅当上游未提供（缺失，或值为
  0 而 input/output 非零等不可用情况）时，才回退计算 `input + output`。
- `strict: true` 在首个错误处抛出 `EventLogConversionError`；否则非致命问题
  以 `warnings` 数组返回。

### 把自定义 event 字段透传到 span

`passthroughKeys` 是一个白名单,把 event log 里的字段原样(字段名即 span 属性
名,不改名)拷贝到生成的 span 上。`convertEventLogToTrace` 和
`convertEventLogToReadableSpans` 都支持。

```ts
convertEventLogToTrace(records, {
  handler,
  passthroughKeys: [
    "deployment.env",             // turn 级标签 → 广播到所有 span
    "gen_ai.request.temperature", // per-record → 每个 LLM span 取各自的值
  ],
});
```

- **turn 级**:整个 turn 只解析一次的字段,写到该 turn 的每个 span
  (ENTRY/AGENT/STEP/LLM/TOOL)。
- **per-record**:LLM / TOOL span 额外从自身源 record 读取,同名时覆盖 turn 级值。
- **fill-only(只补空位)**:透传仅在 span 尚未携带该属性时才写入,绝不覆盖
  转换器已产出的属性(token 聚合、model、common 属性等)。若确实要覆盖这些,
  请直接构建 invocation 并使用 `invocation.attributes`。
- 建议只放小的标量字段(env / id / temperature / 自定义 tag),避免透传
  `gen_ai.input.messages` 这类大字段。
- 不传 `passthroughKeys` 时行为完全不变。

### 流式转换(`createTurnStreamSession`)

`convertEventLogToTrace` 一次性转换整个 turn——必须把该 turn 的全部记录持有在内存中。
对于**超长 turn**(数千轮 ReAct)这可能耗尽内存。`createTurnStreamSession` 对单个 turn
**增量转换**:首次 `push` 时创建并保持 ENTRY/AGENT 打开,每个完整的 STEP 在 finalize 时
转换并导出(随即释放)其子 span,`end()` 时才关闭 ENTRY/AGENT 并写入 turn 级聚合。
活跃 span 与未 finalize 事件的工作集受 grace 窗口限制;已 finalize ID 仍为
O(step 数),累计输入消息仍为 O(输入总量)。流式转换避免保留所有已完成 span 和批处理
路径驻留的 O(N²) 消息快照,但不承诺任意输入内容下总内存恒定。

```ts
import { createTurnStreamSession } from "@loongsuite/otel-util-genai";

const session = createTurnStreamSession({
  handler,
  passthroughKeys,
  // 可选;一旦提供即作为权威上下文:
  traceId,
  parentSpanId,
});
session.push(batch1); // 增量喂入(如每次轮询一批);完整的 step 此刻即转换
session.push(batch2);
const result = session.end(); // 关闭 ENTRY/AGENT,flush 最后的 step

// result: { traceId?, spanCount, lateDroppedRecordCount, warnings }
if (result.lateDroppedRecordCount > 0) raiseAlarm(result.warnings);
```

- **一个 session 对应一个 turn**;`push`/`end` 必须串行调用(会话持有可变状态)。对于
  边界明确、已完整的 turn,批处理 `convertEventLogToTrace` 仍是合适选择。
- **trace context 必须在 ENTRY 创建前确定**。可选的 `traceId` / `parentSpanId`
  构造参数一旦提供即为权威值。不传时使用首次父记录触发 ENTRY 之前观察到的第一个有效
  event context;若仍不存在则由 SDK 分配 trace ID。ENTRY 创建后到达的 context 无法
  重新挂接已有 span,并产生 `LATE_TRACE_CONTEXT_IGNORED`。`parentSpanId` 必须与
  `traceId` 一起传入。
- **`graceSteps`(默认 2)**——look-back 窗口:一个 step 只有在其后又出现 `graceSteps`
  个新 `gen_ai.step.id` 时(或 `end()` 时)才被 finalize,以容忍上游有限的乱序发射
  (例如某 step 的尾部 `tool.result` 与下一 step 落在同一毫秒)。到达已 finalize step 的
  记录会被丢弃、计入 `lateDroppedRecordCount` 并产生 `LATE_STEP_DROP` 警告——上游的顺序
  约定见 `EVENT_LOG_TO_TRACE_SPEC.md` §2.5。
- subagent 记录在父 TOOL finalize 后立即释放。之后到达的 child 以
  `LATE_SUBAGENT_DROP` 丢弃;到 `end()` 仍找不到父 TOOL 的 child 以
  `UNMATCHED_SUBAGENT_DROP` 丢弃。
- **`session.pendingRecordCount`**——session 当前持有的全部父 step、subagent 和用户输入
  记录数。父 step 驻留受 grace 窗口控制,但单个未结束 step 仍可能包含大量记录。
- 批处理 `convertEventLogToTrace` 未改动,且与流式共用底层转换,两条路径产出等价的 span。

## 许可证

Apache License 2.0
