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

import {
  ROOT_CONTEXT,
  TraceFlags,
  trace,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";

const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;
const ALL_ZERO_TRACE_ID = "0".repeat(32);
const SPAN_ID_REGEX = /^[0-9a-f]{16}$/;
const ALL_ZERO_SPAN_ID = "0".repeat(16);
const SYNTHETIC_PARENT_SPAN_ID = "0".repeat(15) + "1";

/** True if value is a valid lowercase 32-hex trace_id and not all zeros. */
export function isValidTraceId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!TRACE_ID_REGEX.test(value)) return false;
  if (value === ALL_ZERO_TRACE_ID) return false;
  return true;
}

/** True if value is a valid lowercase 16-hex span_id and not all zeros. */
export function isValidSpanId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!SPAN_ID_REGEX.test(value)) return false;
  if (value === ALL_ZERO_SPAN_ID) return false;
  return true;
}

/**
 * Build a non-recording parent Context that carries the given trace_id so any
 * child span created with this context inherits the same trace_id.
 *
 * If `parentSpanId` (valid 16-hex, non-zero) is provided, it is used as the
 * parent SpanContext's spanId so the resulting ENTRY span's parentSpanId
 * points to a real upstream span — enabling true parent-child linkage in
 * trace UIs (ARMS / Jaeger / Tempo).
 *
 * If `parentSpanId` is omitted or invalid, the legacy synthetic spanId
 * (`"0000000000000001"`) is used. This preserves backward compatibility.
 *
 * `isRemote=true` always marks the parent as external, which is the correct
 * semantic when reconstructing spans from out-of-band events.
 */
export function createTraceParentContext(
  traceId: string,
  parentSpanId?: string,
): Context {
  const spanContext: SpanContext = {
    traceId,
    spanId: isValidSpanId(parentSpanId) ? parentSpanId : SYNTHETIC_PARENT_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}
