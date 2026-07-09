import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  GEN_AI_AGENT_NAME,
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

function spansByKind(spans: ReadableSpan[], kind: string) {
  return spans.filter((s) => s.attributes[GEN_AI_SPAN_KIND] === kind);
}

describe("subagent nesting", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let handler: ExtendedTelemetryHandler;

  function setup() {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
  }

  it("creates nested AGENT→STEP→LLM under TOOL span with correct parent chain", async () => {
    setup();
    const records = loadFixture("subagent-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    // Expected: ENTRY + parent AGENT + parent STEP + parent LLM + TOOL +
    //           child AGENT + child STEP + child LLM = 8
    expect(spans).toHaveLength(8);

    const entries = spansByKind(spans, GenAiSpanKindValues.ENTRY);
    const agents = spansByKind(spans, GenAiSpanKindValues.AGENT);
    const steps = spansByKind(spans, GenAiSpanKindValues.STEP);
    const llms = spansByKind(spans, GenAiSpanKindValues.LLM);
    const tools = spansByKind(spans, GenAiSpanKindValues.TOOL);

    expect(entries).toHaveLength(1);
    expect(agents).toHaveLength(2); // parent + child
    expect(steps).toHaveLength(2);  // parent + child
    expect(llms).toHaveLength(2);   // parent + child
    expect(tools).toHaveLength(1);

    // Child AGENT parent = TOOL span
    const toolSpan = tools[0]!;
    const childAgent = agents.find(
      (a) => a.attributes[GEN_AI_AGENT_NAME] === "child-agent",
    )!;
    expect(childAgent).toBeDefined();
    expect(childAgent.parentSpanId).toBe(toolSpan.spanContext().spanId);

    // Child LLM parent = child STEP, child STEP parent = child AGENT
    const childStep = steps.find(
      (s) => s.parentSpanId === childAgent.spanContext().spanId,
    )!;
    expect(childStep).toBeDefined();
    const childLlm = llms.find(
      (l) => l.attributes[GEN_AI_REQUEST_MODEL] === "claude-haiku",
    )!;
    expect(childLlm).toBeDefined();
    expect(childLlm.parentSpanId).toBe(childStep.spanContext().spanId);
  });

  it("does not affect traces without subagent records (regression)", async () => {
    setup();
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    // single-turn-simple has no gen_ai.agent.scope field → same as before
    expect(spans).toHaveLength(5);
    expect(spansByKind(spans, GenAiSpanKindValues.AGENT)).toHaveLength(1);
  });

  it("extends TOOL span time range to cover child agent", async () => {
    setup();
    const records = loadFixture("subagent-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const toolSpan = spansByKind(spans, GenAiSpanKindValues.TOOL)[0]!;
    const childLlm = spans.find(
      (s) =>
        s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM &&
        s.attributes[GEN_AI_REQUEST_MODEL] === "claude-haiku",
    )!;

    // Tool span must end >= child LLM end
    const toolEndMs = toolSpan.endTime[0] * 1000 + Math.floor(toolSpan.endTime[1] / 1e6);
    const childEndMs = childLlm.endTime[0] * 1000 + Math.floor(childLlm.endTime[1] / 1e6);
    expect(toolEndMs).toBeGreaterThanOrEqual(childEndMs);
  });

  it("child agent has independent agentName from child records", async () => {
    setup();
    const records = loadFixture("subagent-simple");
    convertEventLogToTrace(records, { handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    const agents = spansByKind(spans, GenAiSpanKindValues.AGENT);
    const parentAgent = agents.find(
      (a) => a.attributes[GEN_AI_AGENT_NAME] === "claude-code",
    );
    const childAgent = agents.find(
      (a) => a.attributes[GEN_AI_AGENT_NAME] === "child-agent",
    );
    expect(parentAgent).toBeDefined();
    expect(childAgent).toBeDefined();

    // Parent AGENT token should NOT include child tokens
    expect(parentAgent!.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(500);
  });
});
