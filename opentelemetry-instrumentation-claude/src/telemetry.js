// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * telemetry.js — OpenTelemetry TracerProvider configuration
 *
 * Priority order for telemetry backend:
 *   1. OTEL_EXPORTER_OTLP_ENDPOINT env var → OTLP/HTTP exporter
 *   2. CLAUDE_TELEMETRY_DEBUG=1            → ConsoleSpanExporter
 *   3. Neither                             → throw RuntimeError
 *
 * Service name priority (highest first):
 *   1. OTEL_SERVICE_NAME env var
 *   2. service.name inside OTEL_RESOURCE_ATTRIBUTES
 *   3. defaultServiceName argument (fallback: "claude-agents")
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor, ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { Resource } = require("@opentelemetry/resources");
const { trace } = require("@opentelemetry/api");
const config = require("./config");

// 1 MB attribute length limit (aligned with Python version)
const MAX_ATTRIBUTE_LENGTH = 1 * 1024 * 1024;

let _tracerProvider = null;

/**
 * Resolve the effective service name respecting OTel env vars.
 * @param {string} defaultName
 * @returns {string}
 */
function resolveServiceName(defaultName = "claude-agents") {
  const cfgName = config.getServiceName("").trim();
  if (cfgName) return cfgName;

  const attrs = parseResourceAttributes();
  if (attrs["service.name"]) return attrs["service.name"];

  return defaultName;
}

/**
 * Parse all key=value pairs from OTEL_RESOURCE_ATTRIBUTES.
 * @returns {Record<string, string>}
 */
function parseResourceAttributes() {
  const attrs = {};
  const raw = config.getResourceAttributes();
  if (!raw) return attrs;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) attrs[key] = val;
  }
  return attrs;
}

/**
 * Build the full Resource attributes object.
 * Priority: OTEL_SERVICE_NAME > OTEL_RESOURCE_ATTRIBUTES service.name > default
 * All other OTEL_RESOURCE_ATTRIBUTES are included as-is.
 * @param {string} serviceName
 * @returns {Record<string, string>}
 */
function buildResourceAttrs(serviceName) {
  const envAttrs = parseResourceAttributes();
  envAttrs["service.name"] = resolveServiceName(serviceName);
  envAttrs["gen_ai.agent.system"] = "claude";
  return envAttrs;
}

/**
 * Parse OTEL_EXPORTER_OTLP_HEADERS into a plain object.
 * @returns {Record<string, string>}
 */
function parseOtlpHeaders() {
  const headers = {};
  const raw = config.getHeaders();
  if (!raw) return headers;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    headers[key] = val;
  }
  return headers;
}

/**
 * Configure and return an OTLP/HTTP TracerProvider.
 * @param {string} endpoint
 * @param {string} serviceName
 * @returns {NodeTracerProvider}
 */
function configureOtlp(endpoint, serviceName) {
  const resource = new Resource(buildResourceAttrs(serviceName));
  const otlpEndpoint = endpoint.endsWith("/v1/traces")
    ? endpoint
    : endpoint.replace(/\/$/, "") + "/v1/traces";

  const exporter = new OTLPTraceExporter({
    url: otlpEndpoint,
    headers: parseOtlpHeaders(),
  });

  const provider = new NodeTracerProvider({
    resource,
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH },
  });
  provider.addSpanProcessor(
    new BatchSpanProcessor(exporter, {
      maxExportBatchSize: 64,
      exportTimeoutMillis: 60000,
    })
  );
  provider.register();
  _tracerProvider = provider;
  return provider;
}

/**
 * Configure a console (debug) TracerProvider.
 * @param {string} serviceName
 * @returns {NodeTracerProvider}
 */
function configureConsole(serviceName) {
  const resource = new Resource(buildResourceAttrs(serviceName));
  const provider = new NodeTracerProvider({
    resource,
    spanLimits: { attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH },
  });
  provider.addSpanProcessor(
    new BatchSpanProcessor(new ConsoleSpanExporter(), {
      maxExportBatchSize: 64,
      exportTimeoutMillis: 60000,
    })
  );
  provider.register();
  _tracerProvider = provider;
  return provider;
}

/**
 * Configure telemetry. Idempotent — returns existing provider on repeat calls.
 * @param {string} [serviceName="claude-agents"]
 * @returns {NodeTracerProvider}
 */
function configureTelemetry(serviceName = "claude-agents") {
  if (_tracerProvider) return _tracerProvider;

  const endpoint = config.getEndpoint();
  if (endpoint) {
    try {
      const provider = configureOtlp(endpoint, serviceName);
      console.error(`📊 OpenTelemetry configured → ${endpoint}`);
      return provider;
    } catch (err) {
      throw new Error(`Failed to configure OTEL telemetry: ${err.message}`);
    }
  }

  if (config.isDebug()) {
    console.error("🔍 Debug mode: telemetry output to console");
    return configureConsole(serviceName);
  }

  throw new Error(
    "\n❌ NO TELEMETRY BACKEND CONFIGURED!\n\n" +
    "Configure one of the following:\n\n" +
    "1. Any OTEL backend:\n" +
    "   export OTEL_EXPORTER_OTLP_ENDPOINT=\"https://api.honeycomb.io\"\n" +
    "   export OTEL_EXPORTER_OTLP_HEADERS=\"x-honeycomb-team=your_key\"\n\n" +
    "2. Config file (~/.claude/otel-config.json):\n" +
    "   { \"otlp_endpoint\": \"https://api.honeycomb.io\" }\n\n" +
    "3. Debug mode (console output only):\n" +
    "   export CLAUDE_TELEMETRY_DEBUG=1\n"
  );
}

/**
 * Force-flush and shutdown the active TracerProvider.
 * @returns {Promise<void>}
 */
async function shutdownTelemetry() {
  const provider = _tracerProvider || trace.getTracerProvider();
  if (provider && typeof provider.forceFlush === "function") {
    await provider.forceFlush();
  }
  if (provider && typeof provider.shutdown === "function") {
    await provider.shutdown();
  }
}

module.exports = { configureTelemetry, shutdownTelemetry, resolveServiceName, parseResourceAttributes, buildResourceAttrs };
