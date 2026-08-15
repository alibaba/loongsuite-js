import { trace } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import {
  getEndpoint,
  getHeaders,
  getServiceName,
  getResourceAttributes,
  isDebug,
} from "./config.js";

const MAX_ATTRIBUTE_LENGTH = 1 * 1024 * 1024;
const ACS_ARMS_SERVICE_FEATURE = "acs.arms.service.feature";

let _provider: NodeTracerProvider | null = null;

function resolveServiceName(defaultName = "codex-agent"): string {
  const name = getServiceName();
  if (name) return name;

  for (const attr of getResourceAttributes().split(",")) {
    const trimmed = attr.trim();
    if (trimmed.startsWith("service.name=")) {
      return trimmed.slice("service.name=".length).trim();
    }
  }

  return defaultName;
}

function parseOtlpHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = getHeaders();
  if (!raw) return headers;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) headers[key] = val;
  }
  return headers;
}

function createProvider(serviceName: string): NodeTracerProvider {
  const resource = new Resource({
    "service.name": resolveServiceName(serviceName),
    [ACS_ARMS_SERVICE_FEATURE]: "genai_app",
    "gen_ai.agent.system": "codex",
  });
  return new NodeTracerProvider({
    resource,
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH },
  });
}

export function configureTelemetry(serviceName = "codex-agent"): NodeTracerProvider {
  if (_provider) return _provider;

  const endpoint = getEndpoint();
  if (endpoint) {
    const provider = createProvider(serviceName);
    const otlpUrl = endpoint.endsWith("/v1/traces")
      ? endpoint
      : endpoint.replace(/\/$/, "") + "/v1/traces";

    const exporter = new OTLPTraceExporter({
      url: otlpUrl,
      headers: parseOtlpHeaders(),
    });
    provider.addSpanProcessor(
      new BatchSpanProcessor(exporter, {
        maxExportBatchSize: 64,
        exportTimeoutMillis: 60_000,
      }),
    );
    provider.register();
    _provider = provider;
    process.stderr.write(`[otel-codex-hook] OpenTelemetry configured → ${endpoint}\n`);
    return provider;
  }

  if (isDebug()) {
    const provider = createProvider(serviceName);
    provider.addSpanProcessor(
      new BatchSpanProcessor(new ConsoleSpanExporter(), {
        maxExportBatchSize: 64,
        exportTimeoutMillis: 60_000,
      }),
    );
    provider.register();
    _provider = provider;
    process.stderr.write("[otel-codex-hook] Debug mode: telemetry output to console\n");
    return provider;
  }

  throw new Error(
    "\nNO TELEMETRY BACKEND CONFIGURED!\n\n" +
    "Configure one of the following:\n\n" +
    "1. Any OTEL backend:\n" +
    '   export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-otlp-endpoint:4318"\n\n' +
    "2. Debug mode (console output only):\n" +
    "   export CODEX_TELEMETRY_DEBUG=1\n",
  );
}

export async function shutdownTelemetry(): Promise<void> {
  const provider = _provider || (trace.getTracerProvider() as NodeTracerProvider);
  if (provider && typeof provider.forceFlush === "function") {
    await provider.forceFlush();
  }
  if (provider && typeof provider.shutdown === "function") {
    await provider.shutdown();
  }
  _provider = null;
}
