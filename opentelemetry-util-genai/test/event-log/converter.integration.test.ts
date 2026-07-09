import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { ExtendedTelemetryHandler } from "../../src/extended-handler.js";
import { convertEventLogToTrace } from "../../src/event-log/converter.js";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SPAN_KIND,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown[] {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf-8"),
  );
}

// Enable experimental mode + SPAN_ONLY content capture so messages get
// serialized into span attributes (mirrors how plugins enable it in prod).
const ORIGINAL_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  ORIGINAL_ENV.OTEL_SEMCONV_STABILITY_OPT_IN =
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  ORIGINAL_ENV.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "SPAN_ONLY";
});
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let handler: ExtendedTelemetryHandler;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
});

function spansByKind(spans: ReadableSpan[], kind: GenAiSpanKindValues) {
  return spans.filter((s) => s.attributes[GEN_AI_SPAN_KIND] === kind);
}

describe("integration: span tree structure", () => {
  it("produces ENTRY → AGENT → STEP → (LLM + TOOL) for single-turn-simple", async () => {
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(5);

    expect(spansByKind(spans, GenAiSpanKindValues.ENTRY)).toHaveLength(1);
    expect(spansByKind(spans, GenAiSpanKindValues.AGENT)).toHaveLength(1);
    expect(spansByKind(spans, GenAiSpanKindValues.STEP)).toHaveLength(1);
    expect(spansByKind(spans, GenAiSpanKindValues.LLM)).toHaveLength(1);
    expect(spansByKind(spans, GenAiSpanKindValues.TOOL)).toHaveLength(1);

    // Verify parent chain: ENTRY (no parent within trace) → AGENT → STEP → LLM/TOOL
    const entry = spansByKind(spans, GenAiSpanKindValues.ENTRY)[0]!;
    const agent = spansByKind(spans, GenAiSpanKindValues.AGENT)[0]!;
    const step = spansByKind(spans, GenAiSpanKindValues.STEP)[0]!;
    const llm = spansByKind(spans, GenAiSpanKindValues.LLM)[0]!;
    const tool = spansByKind(spans, GenAiSpanKindValues.TOOL)[0]!;

    expect(agent.parentSpanId).toBe(entry.spanContext().spanId);
    expect(step.parentSpanId).toBe(agent.spanContext().spanId);
    expect(llm.parentSpanId).toBe(step.spanContext().spanId);
    expect(tool.parentSpanId).toBe(step.spanContext().spanId);
  });
});

describe("integration: trace_id propagation", () => {
  it("all spans inherit trace_id from the event log when provided", async () => {
    const records = loadFixture("single-turn-simple");
    const expected = "4bf92f3577b34da6a3ce929d0e0e4736";
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(expected);
    }
  });

  it("falls back to SDK-allocated trace_id when event log omits trace_id", async () => {
    const records = (loadFixture("single-turn-simple") as Record<string, unknown>[]).map(
      (r) => {
        const copy = { ...r };
        delete copy["trace_id"];
        return copy;
      },
    );
    const result = convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1); // all spans of the turn share one allocated trace_id
    // SDK-allocated trace_id is non-empty 32-hex
    expect([...traceIds][0]).toMatch(/^[0-9a-f]{32}$/);
    expect(result.traceIds.length).toBe(1); // also captured back into result
  });
});

describe("integration: multi-turn → multi-trace", () => {
  it("each turn yields its own trace_id and disjoint span set", async () => {
    const records = loadFixture("multi-turn-react");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(2);
    expect(traceIds.has("11111111111111111111111111111111")).toBe(true);
    expect(traceIds.has("22222222222222222222222222222222")).toBe(true);
  });
});

describe("integration: GenAI attribute completeness", () => {
  it("LLM span carries required ARMS GenAI attributes", async () => {
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const llm = spansByKind(spans, GenAiSpanKindValues.LLM)[0]!;
    const attrs = llm.attributes;
    expect(attrs[GEN_AI_SPAN_KIND]).toBe(GenAiSpanKindValues.LLM);
    expect(attrs[GEN_AI_PROVIDER_NAME]).toBe("openai");
    expect(attrs[GEN_AI_REQUEST_MODEL]).toBe("gpt-5");
    expect(attrs[GEN_AI_RESPONSE_MODEL]).toBe("gpt-5-2026-04");
    expect(attrs[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["tool_calls"]);
    expect(attrs[GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(attrs[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);
    expect(attrs[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(120);
    // Messages are serialized JSON strings when SPAN_ONLY content capture is on
    expect(typeof attrs[GEN_AI_INPUT_MESSAGES]).toBe("string");
    expect(typeof attrs[GEN_AI_OUTPUT_MESSAGES]).toBe("string");
    const inMsgs = JSON.parse(attrs[GEN_AI_INPUT_MESSAGES] as string);
    expect(Array.isArray(inMsgs)).toBe(true);
    expect(inMsgs[0].role).toBe("user");
  });

  it("LLM span propagates Anthropic-style cache token attributes", async () => {
    const records = loadFixture("with-cache-tokens");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const llm = spansByKind(spans, GenAiSpanKindValues.LLM)[0]!;
    expect(llm.attributes[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(10500);
    expect(llm.attributes[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(1200);
    expect(llm.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(12000);
  });
});

describe("integration: timestamp accuracy", () => {
  it("LLM span start/end match the event time_unix_nano in ms", async () => {
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const llm = spansByKind(spans, GenAiSpanKindValues.LLM)[0]!;

    // OTel ReadableSpan startTime/endTime is [seconds, nanos] tuple.
    // Convert to ms for comparison.
    const startMs = llm.startTime[0] * 1000 + Math.floor(llm.startTime[1] / 1_000_000);
    const endMs = llm.endTime[0] * 1000 + Math.floor(llm.endTime[1] / 1_000_000);
    // request nano: 1779667200000000000 → 1779667200000 ms
    // response nano: 1779667200500000000 → 1779667200500 ms
    expect(startMs).toBe(1779667200000);
    expect(endMs).toBe(1779667200500);
  });
});
