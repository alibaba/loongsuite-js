// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { trace, type Tracer } from "@opentelemetry/api";

import {
  getEndpoint,
  getHeaders,
  getResourceAttributes,
  getServiceName,
  isDebug,
} from "./config.js";

const TRACER_NAME = "@loongsuite/opentelemetry-instrumentation-qodercli";
let providerSingleton: NodeTracerProvider | null = null;

interface ConfiguredTelemetry {
  tracer: Tracer;
  provider: NodeTracerProvider;
}

/**
 * The OTLP/HTTP-proto exporter does NOT auto-append `/v1/traces` to a URL
 * passed via the `url` constructor option (it treats it as the absolute
 * traces endpoint).  But OTEL spec semantics say `OTEL_EXPORTER_OTLP_ENDPOINT`
 * is a *base URL* and the trace path should be appended.  We honor the
 * spec semantics so that ARMS / SLS-OTEL endpoints — which canonically
 * end at `/apm/trace/opentelemetry` — work without users having to know
 * to append `/v1/traces` themselves.
 *
 * If the URL already includes `/v1/traces`, leave it alone.
 */
function ensureTracesPath(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  return `${trimmed}/v1/traces`;
}

function parseHeadersString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k.length > 0) out[k] = v;
  }
  return out;
}

function parseResourceAttributesString(s: string): Record<string, string> {
  return parseHeadersString(s);
}

/** Build the resource with mandatory attributes from Constitution C4. */
function buildResource(): ReturnType<typeof resourceFromAttributes> {
  const attrs: Record<string, string> = {
    "service.name": getServiceName(),
    // Constitution C4: gen_ai.agent.system identifies the agent type.
    "gen_ai.agent.system": "qodercli",
    // Constitution C4: ARMS uses this to recognize AI applications.
    "acs.arms.service.feature": "genai_app",
  };

  const resAttrs = getResourceAttributes();
  if (resAttrs) {
    Object.assign(attrs, parseResourceAttributesString(resAttrs));
    // Don't allow user override of the C4-mandated identifiers.
    attrs["gen_ai.agent.system"] = "qodercli";
    attrs["acs.arms.service.feature"] = "genai_app";
  }

  return resourceFromAttributes(attrs);
}

/**
 * Configure (idempotent) the global tracer provider for the qoder-cli plugin.
 *
 * Honors:
 *   - Constitution C4 (resource attrs)
 *   - Constitution C8 (empty endpoint never throws — falls back to console / noop)
 *   - QODERCLI_TELEMETRY_DEBUG=1 (adds ConsoleSpanExporter)
 */
export function configureTelemetry(extraExporter?: SpanExporter): ConfiguredTelemetry {
  if (providerSingleton) {
    return {
      tracer: trace.getTracer(TRACER_NAME),
      provider: providerSingleton,
    };
  }

  const processors: SpanProcessor[] = [];
  const endpoint = getEndpoint();
  if (endpoint) {
    const headersStr = getHeaders();
    const exporter = new OTLPTraceExporter({
      url: ensureTracesPath(endpoint),
      headers: headersStr ? parseHeadersString(headersStr) : undefined,
    });
    processors.push(new BatchSpanProcessor(exporter));
  }

  if (isDebug()) {
    processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  if (extraExporter) {
    processors.push(new BatchSpanProcessor(extraExporter));
  }

  const provider = new NodeTracerProvider({
    resource: buildResource(),
    spanProcessors: processors,
  });

  provider.register();
  providerSingleton = provider;

  return {
    tracer: trace.getTracer(TRACER_NAME),
    provider,
  };
}

/** Force-flush + shutdown the global provider. Safe to call multiple times. */
export async function shutdownTelemetry(timeoutMs = 5000): Promise<void> {
  const provider = providerSingleton;
  if (!provider) return;
  try {
    await Promise.race([
      provider.forceFlush(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    await Promise.race([
      provider.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* swallow — shutdown must never throw out of the hook */
  } finally {
    providerSingleton = null;
  }
}

export const TRACER_LIB_NAME = TRACER_NAME;

/** Exposed for tests so we can reset between runs. */
export function _resetProviderForTest(): void {
  providerSingleton = null;
}
