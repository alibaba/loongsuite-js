import { LEVELS, type Level } from "./types.ts"

/** Configuration values resolved from OTEL env vars (OPENCODE_* kept as fallback). */
export type PluginConfig = {
  enabled: boolean
  endpoint: string
  metricsInterval: number
  logsInterval: number
  metricPrefix: string
  otlpHeaders: string | undefined
  resourceAttributes: string | undefined
  disabledMetrics: Set<string>
  tracesDisabled: boolean
  logsDisabled: boolean
  /** Max characters per role content in gen_ai.input/output.messages (0 = unlimited). */
  maxContentSize: number
}

/** Parses a positive integer from an environment variable, returning `fallback` if absent or invalid. */
export function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  if (!/^[1-9]\d*$/.test(raw)) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : fallback
}

function firstEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]
    if (value && value.length > 0) return value
  }
  return undefined
}

function parseEnvIntFromKeys(keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = process.env[key]
    if (!raw) continue
    if (!/^[1-9]\d*$/.test(raw)) return fallback
    const n = Number(raw)
    return Number.isSafeInteger(n) ? n : fallback
  }
  return fallback
}

/**
 * Reads OTEL environment variables first, then falls back to legacy `OPENCODE_*`.
 */
export function loadConfig(): PluginConfig {
  const endpoint = firstEnv([
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OPENCODE_OTLP_ENDPOINT",
  ]) ?? "http://localhost:4318"

  const otlpHeaders = firstEnv([
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OPENCODE_OTLP_HEADERS",
  ])

  const resourceAttributes = firstEnv([
    "OTEL_RESOURCE_ATTRIBUTES",
    "OPENCODE_RESOURCE_ATTRIBUTES",
  ])

  const disabledMetrics = new Set(
    (firstEnv(["OTEL_DISABLE_METRICS", "OPENCODE_DISABLE_METRICS"]) ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  )
  const otelLogsExporter = process.env["OTEL_LOGS_EXPORTER"]
  const logsDisabled = otelLogsExporter
    ? otelLogsExporter === "none"
    : !process.env["OPENCODE_ENABLE_LOGS"]
  const tracesDisabled = process.env["OTEL_TRACES_EXPORTER"] === "none"
    || !!process.env["OPENCODE_DISABLE_TRACES"]
  const enabled = !!process.env["OPENCODE_ENABLE_TELEMETRY"]
    || !!firstEnv([
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    ])

  return {
    enabled,
    endpoint,
    metricsInterval: parseEnvIntFromKeys(["OTEL_METRIC_EXPORT_INTERVAL", "OPENCODE_OTLP_METRICS_INTERVAL"], 60000),
    logsInterval: parseEnvIntFromKeys(["OTEL_BLRP_SCHEDULE_DELAY", "OPENCODE_OTLP_LOGS_INTERVAL"], 5000),
    metricPrefix: firstEnv(["OTEL_METRIC_PREFIX", "OPENCODE_METRIC_PREFIX"]) ?? "opencode.",
    otlpHeaders,
    resourceAttributes,
    disabledMetrics,
    tracesDisabled,
    logsDisabled,
    maxContentSize: parseEnvIntFromKeys(["OTEL_TRACE_MAX_CONTENT_SIZE", "OPENCODE_TRACE_MAX_CONTENT_SIZE"], 2048),
  }
}

/**
 * Parses a comma-separated `key=value` header string into a plain object.
 * Returns `undefined` when the input is absent or empty.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  const result: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=")
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const val = pair.slice(idx + 1).trim()
    if (key) result[key] = val
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Resolves an opencode log level string to a `Level`.
 * Returns `current` unchanged when the input does not match a known level.
 */
export function resolveLogLevel(logLevel: string, current: Level): Level {
  const candidate = logLevel.toLowerCase()
  if (candidate in LEVELS) return candidate as Level
  return current
}
