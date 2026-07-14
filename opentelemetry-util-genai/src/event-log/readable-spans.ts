// Copyright The OpenTelemetry Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ExtendedTelemetryHandler } from "../extended-handler.js";
import { convertEventLogToTrace } from "./converter.js";
import type { ConvertOptions, EventLogRecord } from "./types.js";

export interface ReadableSpansResult {
  /** Finished spans ready to feed into OTLPTraceExporter.export(). */
  spans: ReadableSpan[];
  /** trace_id per turn (in input order). */
  traceIds: string[];
  /** Non-fatal issues collected during conversion (always returned, never thrown unless strict). */
  warnings: string[];
}

/**
 * High-level helper that converts an event log into a flat list of
 * {@link ReadableSpan}s ready to be fed into an OTLPTraceExporter.
 *
 * Internally this wires a private BasicTracerProvider + InMemorySpanExporter,
 * runs {@link convertEventLogToTrace}, flushes, and returns the captured
 * spans. The provider is **never** registered globally — it lives only for
 * the duration of this call.
 *
 * Use this when:
 *   - You want a pure function-style API that yields ReadableSpan[] data,
 *     e.g. inside a pilot/exporter that owns its own OTLPTraceExporter.
 *   - You don't have an existing handler / TracerProvider to share.
 *
 * Use {@link convertEventLogToTrace} directly instead when:
 *   - You already have a long-lived ExtendedTelemetryHandler bound to a
 *     real production TracerProvider (e.g. inside a plugin's hook process).
 *   - You want the spans to flow through BatchSpanProcessor → OTLP exporter
 *     in the standard plugin pattern.
 *
 * @requires `@opentelemetry/sdk-trace-base` must be available at runtime in
 *           the consumer's `node_modules` (it is loaded via dynamic import).
 *           This package declares it as an optional peer dep.
 */
export async function convertEventLogToReadableSpans(
  records: EventLogRecord[],
  options?: Omit<ConvertOptions, "handler">,
): Promise<ReadableSpansResult> {
  if (!records || records.length === 0) {
    return { spans: [], traceIds: [], warnings: [] };
  }

  let mod: typeof import("@opentelemetry/sdk-trace-base");
  try {
    mod = await import("@opentelemetry/sdk-trace-base");
  } catch {
    throw new Error(
      "convertEventLogToReadableSpans requires @opentelemetry/sdk-trace-base. " +
        "Install it in the consumer package (npm install @opentelemetry/sdk-trace-base).",
    );
  }

  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = mod;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

  try {
    const result = convertEventLogToTrace(records, { ...options, handler });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    return {
      spans,
      traceIds: result.traceIds,
      warnings: result.warnings,
    };
  } finally {
    // Best-effort cleanup; ignore shutdown errors to avoid masking real failures.
    await provider.shutdown().catch(() => undefined);
  }
}
