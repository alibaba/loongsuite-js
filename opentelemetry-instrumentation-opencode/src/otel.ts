import { logs } from "@opentelemetry/api-logs"
import { metrics, trace } from "@opentelemetry/api"
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { ATTR_HOST_ARCH } from "@opentelemetry/semantic-conventions/incubating"
import type { Instruments } from "./types.ts"

/**
 * Builds an OTel `Resource` seeded with `service.name`, `app.version`, `os.type`, and
 * `host.arch`. Additional attributes from `OTEL_RESOURCE_ATTRIBUTES` are merged in and
 * may override the defaults.
 */
export function buildResource(version: string) {
  const attrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: process.env["OTEL_SERVICE_NAME"] ?? "opencode",
    "app.version": version,
    "os.type": process.platform,
    [ATTR_HOST_ARCH]: process.arch,
    "acs.arms.service.feature": "genai_app",
  }
  const raw = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  if (raw) {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf("=")
      if (idx > 0) {
        const key = pair.slice(0, idx).trim()
        const val = pair.slice(idx + 1).trim()
        if (key) attrs[key] = val
      }
    }
  }
  return resourceFromAttributes(attrs)
}

/** Handles returned by `setupOtel`, used for graceful shutdown. */
export type OtelProviders = {
  meterProvider: MeterProvider
  loggerProvider: LoggerProvider | null
  tracerProvider: BasicTracerProvider | null
}

/**
 * Initialises the OTel SDK — creates a `MeterProvider`, `LoggerProvider`, and optionally a
 * `TracerProvider` backed by OTLP exporters pointed at `endpoint`, and registers them as
 * the global providers.
 */
export function setupOtel(
  endpoint: string,
  metricsInterval: number,
  logsInterval: number,
  version: string,
  tracesDisabled: boolean,
  logsDisabled: boolean,
  headers?: Record<string, string>,
): OtelProviders {
  const resource = buildResource(version)

  const tracesUrl = process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] || endpoint + "/v1/traces"
  const metricsUrl = process.env["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"] || endpoint + "/v1/metrics"
  const logsUrl = process.env["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"] || endpoint + "/v1/logs"

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: metricsUrl, headers }),
        exportIntervalMillis: metricsInterval,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(meterProvider)

  const loggerProvider = logsDisabled ? null : (() => {
    const lp = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor(new OTLPLogExporter({ url: logsUrl, headers }), {
          scheduledDelayMillis: logsInterval,
        }),
      ],
    })
    logs.setGlobalLoggerProvider(lp)
    return lp
  })()

  const tracerProvider = tracesDisabled ? null : (() => {
    const tp = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl, headers }))],
    })
    trace.setGlobalTracerProvider(tp)
    return tp
  })()

  return { meterProvider, loggerProvider, tracerProvider }
}

/** Creates all metric instruments using the provided `MeterProvider`. Metric names are prefixed with `prefix`. */
export function createInstruments(prefix: string, meterProvider: MeterProvider): Instruments {
  const meter = meterProvider.getMeter("com.opencode")
  return {
    sessionCounter: meter.createCounter(`${prefix}session.count`, {
      unit: "{session}",
      description: "Count of opencode sessions started",
    }),
    tokenCounter: meter.createCounter(`${prefix}token.usage`, {
      unit: "{token}",
      description: "Number of tokens used",
    }),
    costCounter: meter.createCounter(`${prefix}cost.usage`, {
      unit: "[USD]",
      description: "Cost of the opencode session in USD",
    }),
    linesCounter: meter.createCounter(`${prefix}lines_of_code.count`, {
      unit: "{line}",
      description: "Count of lines of code added or removed",
    }),
    commitCounter: meter.createCounter(`${prefix}commit.count`, {
      unit: "{commit}",
      description: "Number of git commits created",
    }),
    toolDurationHistogram: meter.createHistogram(`${prefix}tool.duration`, {
      unit: "ms",
      description: "Duration of tool executions in milliseconds",
    }),
    cacheCounter: meter.createCounter(`${prefix}cache.count`, {
      unit: "{request}",
      description: "Token cache activity (cacheRead/cacheCreation) per completed assistant message",
    }),
    sessionDurationHistogram: meter.createHistogram(`${prefix}session.duration`, {
      unit: "ms",
      description: "Duration of a session from created to idle in milliseconds",
    }),
    messageCounter: meter.createCounter(`${prefix}message.count`, {
      unit: "{message}",
      description: "Number of completed assistant messages per session",
    }),
    sessionTokenGauge: meter.createHistogram(`${prefix}session.token.total`, {
      unit: "{token}",
      description: "Total tokens consumed per session, recorded as a histogram on session idle",
    }),
    sessionCostGauge: meter.createHistogram(`${prefix}session.cost.total`, {
      unit: "[USD]",
      description: "Total cost per session in USD, recorded as a histogram on session idle",
    }),
    modelUsageCounter: meter.createCounter(`${prefix}model.usage`, {
      unit: "{request}",
      description: "Number of completed assistant messages per model and provider",
    }),
    retryCounter: meter.createCounter(`${prefix}retry.count`, {
      unit: "{retry}",
      description: "Number of API retries observed via session.status events",
    }),
  }
}
