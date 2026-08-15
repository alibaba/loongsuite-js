import { describe, expect, it } from "vitest";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  GEN_AI_CLIENT_OPERATION_DURATION,
  GEN_AI_CLIENT_TOKEN_USAGE,
} from "../src/semconv/gen-ai-extended-attributes.js";
import { ExtendedTelemetryHandler } from "../src/extended-handler.js";
import {
  createEntryInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createReactStepInvocation,
} from "../src/extended-types.js";
import { createLLMInvocation } from "../src/types.js";
import { getReadableSpanParentId } from "./otel-version-compat.js";

describe("OpenTelemetry SDK compatibility", () => {
  it("uses consumer-owned trace and metric providers", async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const metricExporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE,
    );
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000,
    });
    const meterProvider = new MeterProvider({ readers: [metricReader] });

    try {
      const handler = new ExtendedTelemetryHandler({
        tracerProvider,
        meterProvider,
      });
      const entry = handler.startEntry(
        createEntryInvocation({ sessionId: "compat-session" }),
      );
      const agent = handler.startInvokeAgent(
        createInvokeAgentInvocation("openai", { agentName: "compat-agent" }),
        entry.contextToken ?? undefined,
      );
      const step = handler.startReactStep(
        createReactStepInvocation({ round: 1 }),
        agent.contextToken ?? undefined,
      );
      const llm = handler.startLlm(
        createLLMInvocation({
          requestModel: "compat-model",
          inputTokens: 11,
          outputTokens: 7,
        }),
        step.contextToken ?? undefined,
      );
      handler.stopLlm(llm);
      const tool = handler.startExecuteTool(
        createExecuteToolInvocation("compat-tool"),
        step.contextToken ?? undefined,
      );
      handler.stopExecuteTool(tool);
      handler.stopReactStep(step);
      handler.stopInvokeAgent(agent);
      handler.stopEntry(entry);

      await tracerProvider.forceFlush();
      await meterProvider.forceFlush();

      const spans = spanExporter.getFinishedSpans();
      expect(spans).toHaveLength(5);
      const byName = new Map(spans.map((span) => [span.name, span]));
      expect(
        getReadableSpanParentId(byName.get("invoke_agent compat-agent")!),
      ).toBe(byName.get("enter_ai_application_system")!.spanContext().spanId);
      expect(getReadableSpanParentId(byName.get("react step")!)).toBe(
        byName.get("invoke_agent compat-agent")!.spanContext().spanId,
      );
      expect(getReadableSpanParentId(byName.get("chat compat-model")!)).toBe(
        byName.get("react step")!.spanContext().spanId,
      );
      expect(
        getReadableSpanParentId(byName.get("execute_tool compat-tool")!),
      ).toBe(byName.get("react step")!.spanContext().spanId);

      const metricNames = metricExporter
        .getMetrics()
        .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
        .flatMap((scopeMetrics) => scopeMetrics.metrics)
        .map((metric) => metric.descriptor.name);
      expect(metricNames).toContain(GEN_AI_CLIENT_OPERATION_DURATION);
      expect(metricNames).toContain(GEN_AI_CLIENT_TOKEN_USAGE);
    } finally {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
    }
  });
});
