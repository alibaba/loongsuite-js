# @loongsuite/otel-util-genai

OpenTelemetry GenAI utility library for Node.js — standardized telemetry collection for Generative AI operations including LLM, Agent, Embedding, Tool, Retrieval, Rerank, Memory, Entry, and ReAct Step.

This is the Node.js equivalent of the Python `opentelemetry-util-genai` package, following the same semantic conventions and API design patterns.

## Installation

```bash
npm install @loongsuite/otel-util-genai
```

## Features

- **LLM (Chat/Completion)**: Track LLM requests with full message content, token usage, and streaming TTFT
- **Agent**: Create and invoke agents with tool definitions and conversation context
- **Embedding**: Monitor embedding generation with dimension counts and encoding formats
- **Tool Execution**: Trace tool calls with arguments and results
- **Retrieval**: Observe document retrieval from vector stores with query and results
- **Rerank**: Track document reranking operations with scoring details
- **Memory**: Record memory operations (add, search, update, delete, etc.)
- **Entry**: Mark AI application system entry points with session/user context
- **ReAct Step**: Track individual Reasoning-Acting iterations in agents

## Quick Start

### Using TelemetryHandler (LLM only)

```typescript
import {
  TelemetryHandler,
  createLLMInvocation,
} from "@loongsuite/otel-util-genai";

const handler = new TelemetryHandler();

// Callback pattern (recommended)
await handler.llm(
  createLLMInvocation({
    requestModel: "gpt-4",
    provider: "openai",
    inputMessages: [
      { role: "user", parts: [{ type: "text", content: "Hello!" }] },
    ],
  }),
  async (inv) => {
    // Call your LLM API here...
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

// Or manual start/stop pattern
const inv = createLLMInvocation({ requestModel: "gpt-4", provider: "openai" });
handler.startLlm(inv);
try {
  // Call your LLM API...
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

### Using ExtendedTelemetryHandler (All operations)

```typescript
import {
  ExtendedTelemetryHandler,
  createEmbeddingInvocation,
  createRetrievalInvocation,
  createInvokeAgentInvocation,
  createMemoryInvocation,
} from "@loongsuite/otel-util-genai";

const handler = new ExtendedTelemetryHandler();

// Embedding
handler.embedding(
  createEmbeddingInvocation("text-embedding-3-small"),
  (inv) => {
    inv.inputTokens = 100;
    inv.dimensionCount = 1536;
  },
);

// Retrieval
handler.retrieval(
  createRetrievalInvocation({ dataSourceId: "my_vector_store", topK: 5 }),
  (inv) => {
    inv.documents = [
      { id: "doc1", score: 0.95, content: "..." },
      { id: "doc2", score: 0.87, content: "..." },
    ];
  },
);

// Agent
await handler.invokeAgent(
  createInvokeAgentInvocation("openai", { agentName: "research-agent" }),
  async (inv) => {
    // ... agent invocation
    inv.inputTokens = 500;
    inv.outputTokens = 200;
  },
);

// Memory
handler.memory(createMemoryInvocation("search", { userId: "user-1" }), (inv) => {
  inv.outputMessages = [{ content: "remembered context" }];
});
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OTEL_SEMCONV_STABILITY_OPT_IN` | Set to `gen_ai_latest_experimental` to enable experimental features | - |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | Content capturing mode: `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, `SPAN_AND_EVENT` | `NO_CONTENT` |
| `OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT` | Whether to emit `gen_ai.client.inference.operation.details` events: `true`/`false` | Based on content mode |

## Supported Operation Types

| Operation | Span Kind | `gen_ai.operation.name` | Handler Method |
|---|---|---|---|
| LLM Chat | LLM | `chat` | `llm()` / `startLlm()` |
| Create Agent | AGENT | `create_agent` | `createAgent()` / `startCreateAgent()` |
| Invoke Agent | AGENT | `invoke_agent` | `invokeAgent()` / `startInvokeAgent()` |
| Embedding | EMBEDDING | `embeddings` | `embedding()` / `startEmbedding()` |
| Execute Tool | TOOL | `execute_tool` | `executeTool()` / `startExecuteTool()` |
| Retrieval | RETRIEVER | `retrieval` | `retrieval()` / `startRetrieval()` |
| Rerank | RERANKER | `rerank_documents` | `rerank()` / `startRerank()` |
| Memory | MEMORY | `memory_operation` | `memory()` / `startMemory()` |
| Entry | ENTRY | `enter` | `entry()` / `startEntry()` |
| ReAct Step | STEP | `react` | `reactStep()` / `startReactStep()` |

## Semantic Conventions

This library follows the [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) with LoongSuite extensions for:

- `gen_ai.span.kind` — Logical span kind classification
- Extended operation names (`retrieval`, `rerank_documents`, `enter`, `react`)
- Memory operation attributes (`gen_ai.memory.*`)
- Cache token usage (`gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_read.input_tokens`)
- Total token calculation (`gen_ai.usage.total_tokens`)
- Time to first token (`gen_ai.response.time_to_first_token`)

## API Reference

### Core Classes

- **`TelemetryHandler`** — Manages LLM invocation lifecycles with span, metrics, and event emission
- **`ExtendedTelemetryHandler`** — Extends `TelemetryHandler` with support for all GenAI operation types

### Factory Functions

- `createLLMInvocation(init?)` — Create an LLM invocation with defaults
- `createEmbeddingInvocation(requestModel, init?)` — Create an embedding invocation
- `createExecuteToolInvocation(toolName, init?)` — Create a tool execution invocation
- `createCreateAgentInvocation(provider, init?)` — Create an agent creation invocation
- `createInvokeAgentInvocation(provider, init?)` — Create an agent invocation
- `createRetrievalInvocation(init?)` — Create a retrieval invocation
- `createRerankInvocation(provider, init?)` — Create a rerank invocation
- `createMemoryInvocation(operation, init?)` — Create a memory invocation
- `createEntryInvocation(init?)` — Create an entry invocation
- `createReactStepInvocation(init?)` — Create a ReAct step invocation

### Singleton Accessors

- `getTelemetryHandler(options?)` — Get or create the default `TelemetryHandler`
- `getExtendedTelemetryHandler(options?)` — Get or create the default `ExtendedTelemetryHandler`

## Event Log → Trace conversion

The package can convert a flat list of records that follow the
[loongsuite-pilot AI event schema](https://github.com/alibaba/loongsuite-pilot)
into an OTel span tree (`ENTRY → AGENT → STEP → LLM/TOOL`) that satisfies the
ARMS GenAI semantic conventions. This lets agent plugins keep emitting only
event logs and delegate trace shape to this SDK.

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

console.log(`Exported ${spanCount} spans across ${traceIds.length} traces`);
if (warnings.length) console.warn(warnings);
```

### Helper: returning `ReadableSpan[]` directly

If you don't already own a TracerProvider — for example you're building a
downstream pilot/exporter that needs the span data as values to feed into
your own `OTLPTraceExporter` — use the helper:

```ts
import { convertEventLogToReadableSpans } from "@loongsuite/otel-util-genai";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

const exporter = new OTLPTraceExporter({ url, headers });
const { spans, traceIds, warnings } = await convertEventLogToReadableSpans(records);
exporter.export(spans, (result) => {
  if (result.code !== 0) console.error("export failed", result.error);
});
```

The helper internally spins up a private `BasicTracerProvider` +
`InMemorySpanExporter`, runs the conversion, captures finished spans, and
tears the provider down. It is never registered globally, so it cannot
pollute the host process's OTel context. Requires
`@opentelemetry/sdk-trace-base` at runtime (declared as an optional peer
dep — install it in the consumer package).

### Behavior summary

- Records are grouped by `gen_ai.turn.id` (one OTel trace per turn) then by
  `gen_ai.step.id` (one STEP span per step).
- Each `llm.request` + `llm.response` pair becomes one LLM span; each
  `tool.call` + `tool.result` pair becomes one TOOL span.
- `trace_id` on the records is honored — generated spans inherit it via a
  synthetic parent context. If `trace_id` is missing the SDK allocates one.
- `gen_ai.input.messages_delta` is accumulated across the whole turn to
  reconstruct full `gen_ai.input.messages` for each LLM span.
- `gen_ai.usage.total_tokens` prefers the upstream-reported value; it falls
  back to `input + output` only when the upstream did not provide a usable
  total (missing, or `0` while input/output are non-zero).
- `strict: true` throws `EventLogConversionError` on the first issue;
  otherwise non-fatal problems are returned in `warnings`.

### Passing custom event fields through to spans

`passthroughKeys` is an allowlist of event-log field names to copy verbatim
onto the generated spans (the field name is used as the span attribute name —
no renaming). Both `convertEventLogToTrace` and
`convertEventLogToReadableSpans` accept it.

```ts
convertEventLogToTrace(records, {
  handler,
  passthroughKeys: [
    "deployment.env",             // turn-level tag → broadcast to every span
    "gen_ai.request.temperature", // per-record → each LLM span gets its own value
  ],
});
```

- **Turn-level**: a field resolved once per turn is written to every span of
  that turn (ENTRY/AGENT/STEP/LLM/TOOL).
- **Per-record**: LLM and TOOL spans additionally read the field off their own
  source records, overriding the turn-level value on collision.
- **Fill-only**: a pass-through field is only written when the span does not
  already carry that attribute, so converter-managed attributes (token usage,
  model, common attributes, ...) are never overwritten. To override those,
  build the invocation directly and use `invocation.attributes` instead.
- Prefer listing small scalar fields (env / id / temperature / custom tags);
  avoid large payload fields such as `gen_ai.input.messages`.
- Omit `passthroughKeys` to keep behavior unchanged.

### Skill attributes and automatic detection

Skill-related operations reuse existing TOOL spans and are represented by
`gen_ai.skill.name`, `gen_ai.skill.id`, `gen_ai.skill.version`, and
`gen_ai.skill.description`; no new Skill span is created. Event-log conversion
detects first-class Skill tools by default and recognizes reads, resource
access, and script execution from `skills/<name>/...` paths in tool-call
arguments.

```ts
convertEventLogToTrace(records, {
  handler,
  skillDetection: {
    toolNames: ["Skill", "load_skill", "read_skill"],
    pathHeuristic: true,
  },
});
```

Set `skillDetection: false` to disable inference; explicit
`gen_ai.skill.*` fields are still preserved. See
[`docs/skill-support.md`](docs/skill-support.md) for precedence, configuration,
boundaries, and examples.

### Streaming conversion (`createTurnStreamSession`)

`convertEventLogToTrace` converts a whole turn at once — it must hold every
record of the turn in memory. For **very long turns** (thousands of ReAct steps)
this can exhaust memory. `createTurnStreamSession` converts a single turn
**incrementally**: ENTRY/AGENT are opened on the first `push` and kept open,
each completed STEP is converted and its child spans exported (and freed) as it
finalizes, and ENTRY/AGENT are closed on `end()` with the turn-level aggregates.
The live-span and unfinalized-event working set is bounded by the grace window.
Compact finalized IDs remain O(step count), and accumulated input messages
remain O(total input size); streaming avoids retaining completed spans and the
batch converter's retained O(N²) message snapshots rather than claiming
constant memory for arbitrary input content.

```ts
import { createTurnStreamSession } from "@loongsuite/otel-util-genai";

const session = createTurnStreamSession({
  handler,
  passthroughKeys,
  // Optional, but authoritative when supplied:
  traceId,
  parentSpanId,
});
session.push(batch1); // feed records incrementally (e.g. per poll); complete steps convert now
session.push(batch2);
const result = session.end(); // close ENTRY/AGENT, flush the last steps

// result: { traceId?, spanCount, lateDroppedRecordCount, warnings }
if (result.lateDroppedRecordCount > 0) raiseAlarm(result.warnings);
```

- **One session per turn.** `push`/`end` must be called serially (the session
  holds mutable state). The batch converter remains the right choice for
  bounded, already-complete turns.
- **Trace context must be known before ENTRY starts.** Optional `traceId` and
  `parentSpanId` constructor options are authoritative. When omitted, the first
  valid event context observed before the first parent record starts ENTRY is
  used; otherwise the SDK allocates a trace ID. Context arriving after ENTRY
  starts cannot re-parent existing spans and produces
  `LATE_TRACE_CONTEXT_IGNORED`. `parentSpanId` requires `traceId`.
- **`graceSteps` (default 2)** — look-back window: a step is finalized only once
  `graceSteps` newer `gen_ai.step.id`s have appeared (or at `end()`). This
  tolerates bounded out-of-order emission (e.g. a step's trailing `tool.result`
  sharing the next step's millisecond). Records arriving for an
  already-finalized step are dropped, counted in `lateDroppedRecordCount`, and
  reported via a `LATE_STEP_DROP` warning — see `EVENT_LOG_TO_TRACE_SPEC.md`
  §2.5 for the ordering expectation this places on producers.
- Subagent records are released when their parent TOOL finalizes. Child records
  arriving later are dropped with `LATE_SUBAGENT_DROP`; children that never
  find a parent are dropped at `end()` with `UNMATCHED_SUBAGENT_DROP`.
- **`session.pendingRecordCount`** — all parent-step, subagent, and user-input
  records currently retained by the session. Parent-step retention is governed
  by the grace window, but a single open step may contain many records.
- The batch `convertEventLogToTrace` is unchanged and shares the same underlying
  conversion, so both paths produce equivalent spans.

## License

Apache License 2.0
