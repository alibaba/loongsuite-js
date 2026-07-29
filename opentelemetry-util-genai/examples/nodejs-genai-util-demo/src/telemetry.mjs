import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  Resource,
  detectResourcesSync,
  envDetectorSync,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ExtendedTelemetryHandler } from "@loongsuite/otel-util-genai";

export const DEMO_SERVICE_NAME = "loongsuite-genai-node-demo";

function createResource({ serviceName = DEMO_SERVICE_NAME } = {}) {
  const detected = detectResourcesSync({ detectors: [envDetectorSync] });
  return Resource.default()
    .merge(detected)
    .merge(
      new Resource({
        "service.name": serviceName,
        "acs.arms.service.feature": "genai_app",
        "gen_ai.instrumentation.sdk.name": "loongsuite-genai-utils",
      }),
    );
}

function createRuntime(provider, exporter) {
  provider.register();
  return {
    provider,
    exporter,
    handler: new ExtendedTelemetryHandler({ tracerProvider: provider }),
    tracer: trace.getTracer("loongsuite-genai-node-demo", "1.0.0"),
    async shutdown() {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export function createInMemoryRuntime(options = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    resource: createResource(options),
  });
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  return createRuntime(provider, exporter);
}

export function createOtlpRuntime(options = {}) {
  const provider = new NodeTracerProvider({
    resource: createResource(options),
  });
  const exporter = new OTLPTraceExporter();
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  return createRuntime(provider, exporter);
}

export function formatSpanTree(spans) {
  const byParent = new Map();
  for (const span of spans) {
    const parentId = span.parentSpanId ?? "";
    const children = byParent.get(parentId) ?? [];
    children.push(span);
    byParent.set(parentId, children);
  }

  for (const children of byParent.values()) {
    children.sort((left, right) => {
      const leftStart = left.startTime[0] * 1e9 + left.startTime[1];
      const rightStart = right.startTime[0] * 1e9 + right.startTime[1];
      return leftStart - rightStart;
    });
  }

  const lines = [];
  function visit(parentId, depth) {
    for (const span of byParent.get(parentId) ?? []) {
      const kind = span.attributes["gen_ai.span.kind"];
      lines.push(`${"  ".repeat(depth)}${kind ? `${kind} ` : ""}${span.name}`);
      visit(span.spanContext().spanId, depth + 1);
    }
  }
  visit("", 0);
  return lines.join("\n");
}
