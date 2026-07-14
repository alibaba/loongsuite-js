import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createTraceParentContext,
  isValidSpanId,
} from "../../src/event-log/parent-context.js";
import { groupByTurn } from "../../src/event-log/grouping.js";
import { convertEventLogToTrace } from "../../src/event-log/converter.js";
import { ExtendedTelemetryHandler } from "../../src/extended-handler.js";
import { EventName, type EventLogRecord } from "../../src/event-log/types.js";
import { GEN_AI_SPAN_KIND, GenAiSpanKindValues } from "../../src/semconv/gen-ai-extended-attributes.js";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  ORIGINAL_ENV.OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
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

describe("isValidSpanId", () => {
  it("accepts lowercase 16-hex non-zero", () => {
    expect(isValidSpanId("cafebabecafebabe")).toBe(true);
  });
  it("rejects all-zero", () => {
    expect(isValidSpanId("0000000000000000")).toBe(false);
  });
  it("rejects wrong length", () => {
    expect(isValidSpanId("cafe")).toBe(false);
    expect(isValidSpanId("c".repeat(32))).toBe(false);
  });
  it("rejects uppercase", () => {
    expect(isValidSpanId("CAFEBABECAFEBABE")).toBe(false);
  });
  it("rejects non-string", () => {
    expect(isValidSpanId(undefined)).toBe(false);
    expect(isValidSpanId(null)).toBe(false);
    expect(isValidSpanId(123)).toBe(false);
  });
});

describe("createTraceParentContext with parentSpanId", () => {
  const TRACE_ID = "a".repeat(32);
  const PARENT_SPAN_ID = "cafebabecafebabe";

  it("uses synthetic spanId when parentSpanId omitted (backward compat)", () => {
    const ctx = createTraceParentContext(TRACE_ID);
    const sc = trace.getSpan(ctx)!.spanContext();
    expect(sc.traceId).toBe(TRACE_ID);
    expect(sc.spanId).toBe("0".repeat(15) + "1");
  });

  it("uses provided parentSpanId when valid", () => {
    const ctx = createTraceParentContext(TRACE_ID, PARENT_SPAN_ID);
    const sc = trace.getSpan(ctx)!.spanContext();
    expect(sc.traceId).toBe(TRACE_ID);
    expect(sc.spanId).toBe(PARENT_SPAN_ID);
  });

  it("falls back to synthetic when parentSpanId is invalid", () => {
    for (const bad of ["xyz", "0".repeat(16), "CAFE", undefined]) {
      const ctx = createTraceParentContext(TRACE_ID, bad);
      const sc = trace.getSpan(ctx)!.spanContext();
      expect(sc.spanId).toBe("0".repeat(15) + "1");
    }
  });
});

describe("groupByTurn parent_span_id", () => {
  it("extracts valid parent_span_id from event.name=other", () => {
    const warnings: string[] = [];
    const groups = groupByTurn(
      [{ "event.name": EventName.OTHER, "gen_ai.turn.id": "t1", trace_id: "a".repeat(32), parent_span_id: "cafebabecafebabe" } as EventLogRecord],
      warnings,
    );
    expect(groups[0]!.parentSpanId).toBe("cafebabecafebabe");
    expect(warnings).toHaveLength(0);
  });

  it("ignores parent_span_id on non-other events (intra-trace noise)", () => {
    const warnings: string[] = [];
    const groups = groupByTurn(
      [
        { "event.name": EventName.LLM_REQUEST, "gen_ai.turn.id": "t1", parent_span_id: "cafebabecafebabe" } as EventLogRecord,
        { "event.name": EventName.LLM_RESPONSE, "gen_ai.turn.id": "t1", parent_span_id: "deadbeefdeadbeef" } as EventLogRecord,
      ],
      warnings,
    );
    expect(groups[0]!.parentSpanId).toBeUndefined();
    expect(warnings.filter((w) => w.includes("parent_span_id"))).toHaveLength(0);
  });

  it("first valid wins from other events, warns on inconsistent", () => {
    const warnings: string[] = [];
    const groups = groupByTurn(
      [
        { "event.name": EventName.OTHER, "gen_ai.turn.id": "t1", parent_span_id: "cafebabecafebabe" } as EventLogRecord,
        { "event.name": EventName.OTHER, "gen_ai.turn.id": "t1", parent_span_id: "deadbeefdeadbeef" } as EventLogRecord,
      ],
      warnings,
    );
    expect(groups[0]!.parentSpanId).toBe("cafebabecafebabe");
    expect(warnings.some((w) => w.includes("Inconsistent parent_span_id"))).toBe(true);
  });

  it("warns on invalid in other event, keeps undefined", () => {
    const warnings: string[] = [];
    const groups = groupByTurn(
      [{ "event.name": EventName.OTHER, "gen_ai.turn.id": "t1", parent_span_id: "not-hex" } as EventLogRecord],
      warnings,
    );
    expect(groups[0]!.parentSpanId).toBeUndefined();
    expect(warnings.some((w) => w.includes("Invalid parent_span_id"))).toBe(true);
  });

  it("silent when absent", () => {
    const warnings: string[] = [];
    const groups = groupByTurn(
      [{ "event.name": EventName.LLM_REQUEST, "gen_ai.turn.id": "t1" } as EventLogRecord],
      warnings,
    );
    expect(groups[0]!.parentSpanId).toBeUndefined();
    expect(warnings.filter((w) => w.includes("parent_span_id"))).toHaveLength(0);
  });
});

describe("E2E: ENTRY span parentSpanId equals upstream value", () => {
  it("uses real upstream parentSpanId instead of synthetic", async () => {
    const TRACE_ID = "b".repeat(32);
    const PARENT_SPAN_ID = "cafebabecafebabe";

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    const records: EventLogRecord[] = [
      // event.name="other" carries the upstream parent_span_id (做法 A)
      {
        time_unix_nano: "1780000000500000000",
        "event.id": "user-input",
        "event.name": EventName.OTHER,
        trace_id: TRACE_ID,
        parent_span_id: PARENT_SPAN_ID,
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "hi" }] },
        ]),
      },
      {
        time_unix_nano: "1780000001000000000",
        "event.id": "req",
        "event.name": EventName.LLM_REQUEST,
        trace_id: TRACE_ID,
        parent_span_id: "aaaaaaaaaaaaaaaa", // intra-trace parent (STEP span) — should be ignored
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.request.model": "qwen-max",
      },
      {
        time_unix_nano: "1780000002000000000",
        "event.id": "resp",
        "event.name": EventName.LLM_RESPONSE,
        trace_id: TRACE_ID,
        parent_span_id: "bbbbbbbbbbbbbbbb", // intra-trace parent — should be ignored
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.request.model": "qwen-max",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      },
    ];

    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const entry = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY)!;
    expect(entry).toBeDefined();
    // ENTRY's parentSpanId should be the real upstream value, NOT synthetic
    expect(entry.parentSpanId).toBe(PARENT_SPAN_ID);
    // All spans share the same traceId
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(TRACE_ID);
    }
  });

  it("falls back to synthetic when parent_span_id absent (backward compat)", async () => {
    const TRACE_ID = "c".repeat(32);

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    const records: EventLogRecord[] = [
      {
        time_unix_nano: "1780000001000000000",
        "event.id": "req",
        "event.name": EventName.LLM_REQUEST,
        trace_id: TRACE_ID,
        // no parent_span_id
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.request.model": "qwen-max",
      },
      {
        time_unix_nano: "1780000002000000000",
        "event.id": "resp",
        "event.name": EventName.LLM_RESPONSE,
        trace_id: TRACE_ID,
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.request.model": "qwen-max",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      },
    ];

    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const entry = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY)!;
    // Synthetic parent
    expect(entry.parentSpanId).toBe("0".repeat(15) + "1");
  });
});
