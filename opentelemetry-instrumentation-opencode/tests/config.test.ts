import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { parseEnvInt, loadConfig, resolveLogLevel } from "../src/config.ts"

describe("parseEnvInt", () => {
  test("returns fallback when env var is unset", () => {
    delete process.env["TEST_INT"]
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("parses a valid positive integer", () => {
    process.env["TEST_INT"] = "1000"
    expect(parseEnvInt("TEST_INT", 42)).toBe(1000)
  })

  test("returns fallback for non-numeric value", () => {
    process.env["TEST_INT"] = "fast"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for zero", () => {
    process.env["TEST_INT"] = "0"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for negative value", () => {
    process.env["TEST_INT"] = "-5"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for float string", () => {
    process.env["TEST_INT"] = "1.5"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for partial numeric string", () => {
    process.env["TEST_INT"] = "5000ms"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  afterEach(() => { delete process.env["TEST_INT"] })
})

describe("loadConfig", () => {
  const vars = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_BLRP_SCHEDULE_DELAY",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_DISABLE_METRICS",
    "OTEL_TRACES_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRIC_PREFIX",
    "OTEL_TRACE_MAX_CONTENT_SIZE",
    "OPENCODE_ENABLE_TELEMETRY",
    "OPENCODE_OTLP_ENDPOINT",
    "OPENCODE_OTLP_METRICS_INTERVAL",
    "OPENCODE_OTLP_LOGS_INTERVAL",
    "OPENCODE_OTLP_HEADERS",
    "OPENCODE_RESOURCE_ATTRIBUTES",
    "OPENCODE_DISABLE_METRICS",
    "OPENCODE_DISABLE_TRACES",
    "OPENCODE_ENABLE_LOGS",
    "OPENCODE_TRACE_MAX_CONTENT_SIZE",
    "OPENCODE_METRIC_PREFIX",
  ]
  beforeEach(() => vars.forEach((k) => delete process.env[k]))
  afterEach(() => vars.forEach((k) => delete process.env[k]))

  test("defaults when no env vars set", () => {
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.endpoint).toBe("http://localhost:4318")
    expect(cfg.metricsInterval).toBe(60000)
    expect(cfg.logsInterval).toBe(5000)
  })

  test("enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://collector:4318"
    expect(loadConfig().enabled).toBe(true)
  })

  test("reads custom endpoint from OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://collector:4317"
    expect(loadConfig().endpoint).toBe("http://collector:4317")
  })

  test("reads custom intervals from OTEL env vars", () => {
    process.env["OTEL_METRIC_EXPORT_INTERVAL"] = "30000"
    process.env["OTEL_BLRP_SCHEDULE_DELAY"] = "2000"
    const cfg = loadConfig()
    expect(cfg.metricsInterval).toBe(30000)
    expect(cfg.logsInterval).toBe(2000)
  })

  test("falls back to defaults for invalid interval values", () => {
    process.env["OTEL_METRIC_EXPORT_INTERVAL"] = "notanumber"
    process.env["OTEL_BLRP_SCHEDULE_DELAY"] = "0"
    const cfg = loadConfig()
    expect(cfg.metricsInterval).toBe(60000)
    expect(cfg.logsInterval).toBe(5000)
  })

  test("reads OTEL_EXPORTER_OTLP_HEADERS directly", () => {
    process.env["OTEL_EXPORTER_OTLP_HEADERS"] = "api-key=abc123"
    expect(loadConfig().otlpHeaders).toBe("api-key=abc123")
  })

  test("reads OTEL_RESOURCE_ATTRIBUTES directly", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    expect(loadConfig().resourceAttributes).toBe("team=platform,env=prod")
  })

  test("disabledMetrics is empty set when OTEL_DISABLE_METRICS is unset", () => {
    expect(loadConfig().disabledMetrics.size).toBe(0)
  })

  test("disabledMetrics parses a single metric name", () => {
    process.env["OTEL_DISABLE_METRICS"] = "session.count"
    expect(loadConfig().disabledMetrics).toEqual(new Set(["session.count"]))
  })

  test("disabledMetrics parses a comma-separated list", () => {
    process.env["OTEL_DISABLE_METRICS"] = "session.count,cache.count,retry.count"
    const { disabledMetrics } = loadConfig()
    expect(disabledMetrics.has("session.count")).toBe(true)
    expect(disabledMetrics.has("cache.count")).toBe(true)
    expect(disabledMetrics.has("retry.count")).toBe(true)
  })

  test("disabledMetrics trims whitespace around names", () => {
    process.env["OTEL_DISABLE_METRICS"] = " session.count , cache.count "
    const { disabledMetrics } = loadConfig()
    expect(disabledMetrics.has("session.count")).toBe(true)
    expect(disabledMetrics.has("cache.count")).toBe(true)
  })

  test("disabledMetrics ignores empty segments from trailing commas", () => {
    process.env["OTEL_DISABLE_METRICS"] = "session.count,"
    expect(loadConfig().disabledMetrics.size).toBe(1)
  })

  test("OTEL vars take precedence over OPENCODE fallback", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "http://otel:4318"
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://legacy:4318"
    process.env["OTEL_METRIC_EXPORT_INTERVAL"] = "1111"
    process.env["OPENCODE_OTLP_METRICS_INTERVAL"] = "2222"
    process.env["OTEL_DISABLE_METRICS"] = "retry.count"
    process.env["OPENCODE_DISABLE_METRICS"] = "session.count"
    const cfg = loadConfig()
    expect(cfg.endpoint).toBe("http://otel:4318")
    expect(cfg.metricsInterval).toBe(1111)
    expect(cfg.disabledMetrics.has("retry.count")).toBe(true)
    expect(cfg.disabledMetrics.has("session.count")).toBe(false)
  })

  test("falls back to OPENCODE vars when OTEL vars are missing", () => {
    process.env["OPENCODE_ENABLE_TELEMETRY"] = "1"
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://legacy:4318"
    process.env["OPENCODE_OTLP_METRICS_INTERVAL"] = "1234"
    process.env["OPENCODE_OTLP_LOGS_INTERVAL"] = "5678"
    process.env["OPENCODE_DISABLE_METRICS"] = "session.count"
    process.env["OPENCODE_OTLP_HEADERS"] = "x=1"
    process.env["OPENCODE_RESOURCE_ATTRIBUTES"] = "a=b"
    process.env["OPENCODE_DISABLE_TRACES"] = "1"
    process.env["OPENCODE_TRACE_MAX_CONTENT_SIZE"] = "4096"
    process.env["OPENCODE_METRIC_PREFIX"] = "legacy."
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.endpoint).toBe("http://legacy:4318")
    expect(cfg.metricsInterval).toBe(1234)
    expect(cfg.logsInterval).toBe(5678)
    expect(cfg.disabledMetrics.has("session.count")).toBe(true)
    expect(cfg.otlpHeaders).toBe("x=1")
    expect(cfg.resourceAttributes).toBe("a=b")
    expect(cfg.tracesDisabled).toBe(true)
    expect(cfg.maxContentSize).toBe(4096)
    expect(cfg.metricPrefix).toBe("legacy.")
  })
})

describe("resolveLogLevel", () => {
  test("resolves known level (uppercase input)", () => {
    expect(resolveLogLevel("DEBUG", "info")).toBe("debug")
    expect(resolveLogLevel("WARN", "info")).toBe("warn")
    expect(resolveLogLevel("ERROR", "info")).toBe("error")
  })

  test("resolves known level (lowercase input)", () => {
    expect(resolveLogLevel("debug", "info")).toBe("debug")
  })

  test("returns current level for unknown value", () => {
    expect(resolveLogLevel("verbose", "info")).toBe("info")
    expect(resolveLogLevel("", "warn")).toBe("warn")
  })
})
