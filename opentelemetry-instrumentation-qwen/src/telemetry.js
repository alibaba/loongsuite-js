// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * telemetry.js — OpenTelemetry TracerProvider configuration
 *
 * Priority order for telemetry backend:
 *   1. OTEL_EXPORTER_OTLP_ENDPOINT env var → OTLP/HTTP exporter
 *   2. QWEN_TELEMETRY_DEBUG=1            → ConsoleSpanExporter
 *   3. Neither                             → throw RuntimeError
 *
 * Service name priority (highest first):
 *   1. OTEL_SERVICE_NAME env var
 *   2. service.name inside OTEL_RESOURCE_ATTRIBUTES
 *   3. defaultServiceName argument (fallback: "qwen-agents")
 */

const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { BatchSpanProcessor, ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { Resource } = require("@opentelemetry/resources");
const { trace } = require("@opentelemetry/api");

const MAX_ATTRIBUTE_LENGTH = 1 * 1024 * 1024; // 1 MB

let _tracerProvider = null;

function resolveServiceName(defaultName = "qwen-agents") {
  const envName = (process.env.OTEL_SERVICE_NAME || "").trim();
  if (envName) return envName;

  for (const attr of (process.env.OTEL_RESOURCE_ATTRIBUTES || "").split(",")) {
    const trimmed = attr.trim();
    if (trimmed.startsWith("service.name=")) {
      return trimmed.slice("service.name=".length).trim();
    }
  }

  return defaultName;
}

function parseOtlpHeaders() {
  const headers = {};
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS || "";
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

function configureOtlp(endpoint, serviceName) {
  const resource = new Resource({ "service.name": resolveServiceName(serviceName) });
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

function configureConsole(serviceName) {
  const resource = new Resource({ "service.name": resolveServiceName(serviceName) });
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

function configureTelemetry(serviceName = "qwen-agents") {
  if (_tracerProvider) return _tracerProvider;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    try {
      const provider = configureOtlp(endpoint, serviceName);
      console.error(`📊 OpenTelemetry configured → ${endpoint}`);
      return provider;
    } catch (err) {
      throw new Error(`Failed to configure OTEL telemetry: ${err.message}`);
    }
  }

  if (process.env.QWEN_TELEMETRY_DEBUG) {
    console.error("🔍 Debug mode: telemetry output to console");
    return configureConsole(serviceName);
  }

  throw new Error(
    "\n❌ NO TELEMETRY BACKEND CONFIGURED!\n\n" +
    "Configure one of the following:\n\n" +
    "1. Any OTEL backend:\n" +
    "   export OTEL_EXPORTER_OTLP_ENDPOINT=\"https://your-collector:4318\"\n" +
    "   export OTEL_EXPORTER_OTLP_HEADERS=\"x-api-key=your_key\"\n\n" +
    "2. Debug mode (console output only):\n" +
    "   export QWEN_TELEMETRY_DEBUG=1\n"
  );
}

async function shutdownTelemetry() {
  const provider = _tracerProvider || trace.getTracerProvider();
  if (provider && typeof provider.forceFlush === "function") {
    await provider.forceFlush();
  }
  if (provider && typeof provider.shutdown === "function") {
    await provider.shutdown();
  }
}

module.exports = { configureTelemetry, shutdownTelemetry, resolveServiceName };
