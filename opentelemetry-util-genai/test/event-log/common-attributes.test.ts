import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_SESSION_ID,
  GEN_AI_SPAN_KIND,
  GEN_AI_USER_ID,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown[] {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf-8"));
}

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

describe("ARMS GenAI common attributes propagation (agent.name / user.id / session.id)", () => {
  it("all 5 span kinds carry gen_ai.agent.name from event log gen_ai.agent.type fallback", async () => {
    const records = loadFixture("single-turn-simple");
    const { spans } = await convertEventLogToReadableSpans(records);

    expect(spans).toHaveLength(5);
    const kinds = [
      GenAiSpanKindValues.ENTRY,
      GenAiSpanKindValues.AGENT,
      GenAiSpanKindValues.STEP,
      GenAiSpanKindValues.LLM,
      GenAiSpanKindValues.TOOL,
    ];
    for (const kind of kinds) {
      const span = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === kind);
      expect(span, `kind ${kind} span should exist`).toBeDefined();
      expect(
        span!.attributes[GEN_AI_AGENT_NAME],
        `${kind} span should have gen_ai.agent.name`,
      ).toBe("codex"); // fixture: gen_ai.agent.name = "codex"
    }
  });

  it("all 5 span kinds carry gen_ai.user.id", async () => {
    const records = loadFixture("single-turn-simple");
    const { spans } = await convertEventLogToReadableSpans(records);

    for (const kind of [
      GenAiSpanKindValues.ENTRY,
      GenAiSpanKindValues.AGENT,
      GenAiSpanKindValues.STEP,
      GenAiSpanKindValues.LLM,
      GenAiSpanKindValues.TOOL,
    ]) {
      const span = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === kind);
      expect(span!.attributes[GEN_AI_USER_ID], `${kind} should have user.id`).toBe(
        "emp_001", // fixture: user.id = "emp_001"
      );
    }
  });

  it("all 5 span kinds carry gen_ai.session.id", async () => {
    const records = loadFixture("single-turn-simple");
    const { spans } = await convertEventLogToReadableSpans(records);

    for (const kind of [
      GenAiSpanKindValues.ENTRY,
      GenAiSpanKindValues.AGENT,
      GenAiSpanKindValues.STEP,
      GenAiSpanKindValues.LLM,
      GenAiSpanKindValues.TOOL,
    ]) {
      const span = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === kind);
      expect(
        span!.attributes[GEN_AI_SESSION_ID],
        `${kind} should have session.id`,
      ).toBe("sess_alpha"); // fixture: gen_ai.session.id = "sess_alpha"
    }
  });

  it("falls back to gen_ai.agent.type when gen_ai.agent.name is absent", async () => {
    // multi-turn-react fixture has only gen_ai.agent.type, not gen_ai.agent.name
    const records = loadFixture("multi-turn-react");
    const { spans } = await convertEventLogToReadableSpans(records);

    // turn A's spans should all have agent.name = "claude-code" (from agent.type)
    const turnASpans = spans.filter(
      (s) => s.spanContext().traceId === "11111111111111111111111111111111",
    );
    expect(turnASpans.length).toBeGreaterThan(0);
    for (const s of turnASpans) {
      expect(s.attributes[GEN_AI_AGENT_NAME]).toBe("claude-code");
    }
  });
});

describe("Plugin direct-call scenario (handler API, bypassing event-log converter)", () => {
  // Verify the apply functions write the 3 common attributes when invocation
  // carries them — proving plugins that don't go through the converter still
  // benefit from the fix when they choose to populate these fields.
  it("ExtendedTelemetryHandler.startLlm + stopLlm writes agent.name/user.id/session.id when set", async () => {
    const sdkBase = await import("@opentelemetry/sdk-trace-base");
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = sdkBase;
    const { ExtendedTelemetryHandler } = await import("../../src/extended-handler.js");
    const { createLLMInvocation } = await import("../../src/types.js");

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    const inv = createLLMInvocation({
      requestModel: "gpt-5",
      provider: "openai",
      agentName: "codex",
      userId: "u1",
      sessionId: "s1",
    });
    handler.startLlm(inv);
    handler.stopLlm(inv);
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[GEN_AI_AGENT_NAME]).toBe("codex");
    expect(spans[0]!.attributes[GEN_AI_USER_ID]).toBe("u1");
    expect(spans[0]!.attributes[GEN_AI_SESSION_ID]).toBe("s1");
  });

  it("Handler does NOT write the 3 fields when invocation lacks them (backward compatible)", async () => {
    const sdkBase = await import("@opentelemetry/sdk-trace-base");
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = sdkBase;
    const { ExtendedTelemetryHandler } = await import("../../src/extended-handler.js");
    const { createLLMInvocation } = await import("../../src/types.js");

    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    const inv = createLLMInvocation({
      requestModel: "gpt-5",
      provider: "openai",
      // intentionally omit agentName/userId/sessionId
    });
    handler.startLlm(inv);
    handler.stopLlm(inv);
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans[0]!.attributes[GEN_AI_AGENT_NAME]).toBeUndefined();
    expect(spans[0]!.attributes[GEN_AI_USER_ID]).toBeUndefined();
    expect(spans[0]!.attributes[GEN_AI_SESSION_ID]).toBeUndefined();
  });
});
