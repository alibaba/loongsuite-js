// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { hostname } from "node:os";
import { basename } from "node:path";
import type {
  ArmsTraceConfig,
  OpenClawPluginApi,
  SpanData,
} from "./types.js";
import { PLUGIN_VERSION } from "./version.js";

// Semantic convention dialect:
// LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP → gen_ai.span_kind_name
// default (ALIBABA_CLOUD or unset)             → gen_ai.span.kind
// Auto-detect: endpoint containing "sunfire" implies ALIBABA_GROUP
function resolveSpanKindAttr(dialect?: string, endpoint?: string): string {
  const sunfire = (endpoint ?? process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "").includes("sunfire");
  const d = dialect ?? process.env["LOONGSUITE_SEMCONV_DIALECT_NAME"];
  return d === "ALIBABA_GROUP" || sunfire ? "gen_ai.span_kind_name" : "gen_ai.span.kind";
}

const SPAN_KIND_ATTR = resolveSpanKindAttr();

const MAX_ATTR_LENGTH = 3_200_000;

function truncate(value: string): string {
  return value.length > MAX_ATTR_LENGTH
    ? value.substring(0, MAX_ATTR_LENGTH)
    : value;
}

/**
 * Exports OpenClaw trace spans to Alibaba Cloud CMS via OTLP/Protobuf.
 *
 * Uses a dedicated BasicTracerProvider (without calling `.register()`) to
 * avoid conflicts with the global provider registered by diagnostics-otel.
 */
export class ArmsExporter {
  private readonly config: ArmsTraceConfig;
  private readonly api: OpenClawPluginApi;
  private provider: BasicTracerProvider | null = null;
  private tracer: ReturnType<BasicTracerProvider["getTracer"]> | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private openSpans = new Map<string, Span>();

  constructor(api: OpenClawPluginApi, config: ArmsTraceConfig) {
    this.api = api;
    this.config = config;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const instanceName =
      this.config.serviceName || basename(process.cwd()) || "openclaw-agent";
    const instanceId = `${instanceName}@${hostname()}:${process.pid}`;
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.config.serviceName,
      "service.instance.id": instanceId,
      "host.name": hostname(),
      "telemetry.sdk.language": "nodejs",
      "acs.arms.service.feature": "genai_app",
      "gen_ai.agent.system": "openclaw",
      ...this.config.resourceAttributes,
    });

    const traceUrl = this.resolveTraceUrl();
    this.api.logger.info(`[ArmsTrace] Initializing exporter → ${traceUrl}`);

    const exporter = new OTLPTraceExporter({
      url: traceUrl,
      headers: this.config.headers,
    });

    const spanProcessor = new BatchSpanProcessor(exporter, {
      maxQueueSize: 100,
      maxExportBatchSize: this.config.batchSize,
      scheduledDelayMillis: this.config.flushIntervalMs,
    });

    this.provider = new BasicTracerProvider({
      resource,
      spanProcessors: [spanProcessor],
    });

    // Intentionally NOT calling provider.register() to avoid overriding
    // the global TracerProvider that diagnostics-otel may have registered.
    this.tracer = this.provider.getTracer("opentelemetry-instrumentation-openclaw", PLUGIN_VERSION);
    this.initialized = true;
    this.api.logger.info(
      `[ArmsTrace] Exporter initialized (service=${this.config.serviceName})`,
    );
  }

  private resolveTraceUrl(): string {
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    if (/\/v1\/traces$/i.test(endpoint)) {
      return endpoint;
    }
    return `${endpoint}/v1/traces`;
  }

  // ---------------------------------------------------------------------------
  // Long-lived span management (root / agent spans that start and end later)
  // ---------------------------------------------------------------------------

  async startSpan(spanData: SpanData, spanId: string): Promise<void> {
    try {
      await this.ensureInitialized();
      this.doStartSpan(spanData, spanId);
    } catch (err) {
      this.api.logger.error(`[ArmsTrace] Failed to start span: ${err}`);
    }
  }

  private doStartSpan(spanData: SpanData, spanId: string): void {
    if (!this.tracer) return;

    const spanKind = this.mapSpanKind(spanData.type);
    const parentContext = this.resolveParentContext(spanData.parentSpanId);

    const genAiSpanKind = this.mapGenAiSpanKind(spanData.type);
    const spanAttrs = this.flattenAttributes(spanData.attributes);
    if (genAiSpanKind) {
      spanAttrs[SPAN_KIND_ATTR] = genAiSpanKind;
    }

    const span = this.tracer.startSpan(
      spanData.name,
      {
        kind: spanKind,
        startTime: spanData.startTime,
        attributes: spanAttrs,
      },
      parentContext,
    );

    this.openSpans.set(spanId, span);

    if (this.config.debug) {
      const sc = span.spanContext();
      this.api.logger.info(
        `[ArmsTrace] Started span: name=${spanData.name}, type=${spanData.type}, traceId=${sc.traceId}, spanId=${sc.spanId}`,
      );
    }
  }

  endSpanById(
    spanId: string,
    endTime: number,
    additionalAttrs?: Record<string, string | number | boolean>,
    output?: unknown,
    input?: unknown,
  ): void {
    const span = this.openSpans.get(spanId);
    if (!span) return;

    if (additionalAttrs) {
      for (const [key, value] of Object.entries(additionalAttrs)) {
        if (value !== undefined && value !== null) {
          span.setAttribute(key, value);
        }
      }
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end(endTime || Date.now());
    this.openSpans.delete(spanId);

    if (this.config.debug) {
      const sc = span.spanContext();
      this.api.logger.info(
        `[ArmsTrace] Ended span: spanId=${spanId}, traceId=${sc.traceId}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Fire-and-forget span export (short-lived spans that start and end atomically)
  // ---------------------------------------------------------------------------

  async export(spanData: SpanData): Promise<void> {
    await this.ensureInitialized();
    if (!this.tracer) return;

    const spanKind = this.mapSpanKind(spanData.type);
    const parentContext = this.resolveParentContext(spanData.parentSpanId);

    const exportGenAiSpanKind = this.mapGenAiSpanKind(spanData.type);
    const exportSpanAttrs = this.flattenAttributes(spanData.attributes);
    if (exportGenAiSpanKind) {
      exportSpanAttrs[SPAN_KIND_ATTR] = exportGenAiSpanKind;
    }

    const span = this.tracer.startSpan(
      spanData.name,
      {
        kind: spanKind,
        startTime: spanData.startTime,
        attributes: exportSpanAttrs,
      },
      parentContext,
    );

    const hasError =
      spanData.attributes["error"] === true ||
      !!spanData.attributes["error.type"];
    span.setStatus({
      code: hasError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span.end(spanData.endTime || Date.now());

    if (this.config.debug) {
      const sc = span.spanContext();
      this.api.logger.info(
        `[ArmsTrace] Exported span: name=${spanData.name}, type=${spanData.type}, traceId=${sc.traceId}, spanId=${sc.spanId}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Trace lifecycle
  // ---------------------------------------------------------------------------

  endTrace(): void {
    // Keep as a lifecycle marker only.
    // Do NOT clear openSpans here, otherwise one run ending can wipe parent
    // spans that are still active in concurrent runs.
  }

  patchOpenSpanAttributes(spanId: string, attrs: Record<string, string | number | boolean>): void {
    const span = this.openSpans.get(spanId);
    if (!span) {
      return;
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) {
        span.setAttribute(key, value);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.provider) {
      await this.provider.forceFlush();
    }
  }

  async dispose(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
    }
  }

  getTracerProvider(): BasicTracerProvider | null {
    return this.provider;
  }

  getSpanKindAttrName(): string {
    return SPAN_KIND_ATTR;
  }

  resolveParentContextFor(parentSpanId?: string): ReturnType<typeof context.active> {
    return this.resolveParentContext(parentSpanId);
  }

  getOpenSpan(spanId: string): Span | undefined {
    return this.openSpans.get(spanId);
  }

  registerOpenSpan(spanId: string, span: Span): void {
    this.openSpans.set(spanId, span);
  }

  unregisterOpenSpan(spanId: string): void {
    this.openSpans.delete(spanId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private mapSpanKind(type: string): SpanKind {
    switch (type) {
      case "entry":
      case "gateway":
        return SpanKind.SERVER;
      case "model":
        return SpanKind.CLIENT;
      case "tool":
        return SpanKind.INTERNAL;
      default:
        return SpanKind.INTERNAL;
    }
  }

  private mapGenAiSpanKind(type: string): string {
    switch (type) {
      case "step":
        return "STEP";
      case "model":
        return "LLM";
      case "tool":
        return "TOOL";
      case "agent":
        return "AGENT";
      case "entry":
        return "ENTRY";
      case "message":
        return "TASK";
      case "session":
      case "gateway":
        return "";
      default:
        return "";
    }
  }

  private flattenAttributes(
    attrs: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  private resolveParentContext(parentSpanId?: string): ReturnType<typeof context.active> {
    if (parentSpanId) {
      const parentSpan = this.openSpans.get(parentSpanId);
      if (parentSpan) {
        return trace.setSpan(context.active(), parentSpan);
      }
    }
    return context.active();
  }
}
