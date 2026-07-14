import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import {
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SPAN_KIND,
  GEN_AI_USAGE_INPUT_TOKENS,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown[] {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf-8"),
  );
}

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

describe("convertEventLogToReadableSpans", () => {
  it("returns an empty result for empty input", async () => {
    const result = await convertEventLogToReadableSpans([]);
    expect(result.spans).toEqual([]);
    expect(result.traceIds).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("produces ReadableSpan[] with full span tree for single-turn fixture", async () => {
    const records = loadFixture("single-turn-simple");
    const result = await convertEventLogToReadableSpans(records);
    expect(result.spans).toHaveLength(5); // ENTRY + AGENT + STEP + LLM + TOOL
    expect(result.traceIds).toEqual(["4bf92f3577b34da6a3ce929d0e0e4736"]);
    expect(result.warnings).toEqual([]);

    // All spans share the trace_id
    for (const span of result.spans) {
      expect(span.spanContext().traceId).toBe(
        "4bf92f3577b34da6a3ce929d0e0e4736",
      );
    }

    // Each ReadableSpan carries gen_ai.span.kind
    const kinds = result.spans
      .map((s) => s.attributes[GEN_AI_SPAN_KIND])
      .sort();
    expect(kinds).toEqual(
      [
        GenAiSpanKindValues.AGENT,
        GenAiSpanKindValues.ENTRY,
        GenAiSpanKindValues.LLM,
        GenAiSpanKindValues.STEP,
        GenAiSpanKindValues.TOOL,
      ].sort(),
    );
  });

  it("produces independent traces for multi-turn fixture", async () => {
    const records = loadFixture("multi-turn-react");
    const result = await convertEventLogToReadableSpans(records);
    expect(result.traceIds).toHaveLength(2);
    const distinctTraceIds = new Set(result.spans.map((s) => s.spanContext().traceId));
    expect(distinctTraceIds.size).toBe(2);
  });

  it("preserves LLM attributes (provider, model, tokens) on returned ReadableSpan", async () => {
    const records = loadFixture("with-cache-tokens");
    const result = await convertEventLogToReadableSpans(records);
    const llm = result.spans.find(
      (s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM,
    );
    expect(llm).toBeDefined();
    expect(llm!.attributes[GEN_AI_PROVIDER_NAME]).toBe("anthropic");
    expect(llm!.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-sonnet-4-5");
    expect(llm!.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(12000);
  });

  it("propagates strict-mode errors", async () => {
    const records = loadFixture("orphan-llm-request");
    await expect(
      convertEventLogToReadableSpans(records, { strict: true }),
    ).rejects.toThrow(/strict mode/);
  });

  it("collects warnings when strict=false (default)", async () => {
    const records = loadFixture("orphan-llm-request");
    const result = await convertEventLogToReadableSpans(records);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.spans.length).toBeGreaterThan(0);
  });
});
