import { trace, context, type Span, type SpanContext, type Tracer, type AttributeValue } from "@opentelemetry/api"
import { MAX_PENDING } from "./types.ts"
import type { HandlerContext } from "./types.ts"

// Auto-detect ALIBABA_GROUP semconv dialect:
//   LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP  → gen_ai.span_kind_name
//   endpoint contains "sunfire"                    → gen_ai.span_kind_name
//   otherwise                                      → gen_ai.span.kind (OTel default)
const _endpoint =
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
  process.env["OPENCODE_OTLP_ENDPOINT"] ?? ""
const _sunfireDetected = _endpoint.includes("sunfire")
export const SPAN_KIND_ATTR =
  process.env["LOONGSUITE_SEMCONV_DIALECT_NAME"] === "ALIBABA_GROUP" || _sunfireDetected
    ? "gen_ai.span_kind_name"
    : "gen_ai.span.kind"

/** Returns a human-readable summary string from an opencode error object. */
export function errorSummary(err: { name: string; data?: unknown } | undefined): string {
  if (!err) return "unknown"
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    return `${err.name}: ${(err.data as { message: string }).message}`
  }
  return err.name
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= MAX_PENDING) {
    const [firstKey] = map.keys()
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

/**
 * Returns `true` if the metric name (without prefix) is not in the disabled set.
 * The `name` should be the suffix after the metric prefix, e.g. `"session.count"`.
 */
export function isMetricEnabled(name: string, ctx: { disabledMetrics: Set<string> }): boolean {
  return !ctx.disabledMetrics.has(name)
}

/** Returns `true` when tracing is enabled in the handler context. */
export function isTraceEnabled(ctx: { tracesDisabled: boolean }): boolean {
  return !ctx.tracesDisabled
}

/** Creates a span as a child of `parentContext`, or a root span if `parentContext` is undefined. */
export function startChildSpan(
  tracer: Tracer,
  name: string,
  attributes: Record<string, AttributeValue>,
  parentContext?: SpanContext,
  startTime?: number,
): Span {
  const parentCtx = parentContext
    ? trace.setSpanContext(context.active(), parentContext)
    : context.active()
  return tracer.startSpan(name, { attributes, startTime }, parentCtx)
}

export function genAiSpanName(operation: string, target?: string): string {
  return target ? `${operation} ${target}` : operation
}

export function genAiSpanAttrs(
  spanKind: string,
  operation: string,
  sessionID: string,
  commonAttrs: Record<string, AttributeValue>,
  extra: Record<string, AttributeValue> = {},
): Record<string, AttributeValue> {
  return {
    [SPAN_KIND_ATTR]: spanKind,
    "gen_ai.operation.name": operation,
    "gen_ai.session.id": sessionID,
    "gen_ai.conversation.id": sessionID,
    "gen_ai.user.id": sessionID,
    "gen_ai.framework": "opencode",
    ...commonAttrs,
    ...extra,
  }
}

/**
 * Truncates a string to `maxLen` characters, appending `...[truncated]` if it exceeds the limit.
 * Returns the original string when `maxLen` is 0 (unlimited) or the string is within bounds.
 */
export function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0 || s.length <= maxLen) return s
  return s.slice(0, maxLen) + "...[truncated]"
}

/**
 * Walks a message array (gen_ai.input/output.messages format) and truncates all
 * string content fields (`content`, `response`, `arguments`) per the configured limit.
 * Returns a new array — the original is not mutated.
 */
export function truncateMessages(msgs: unknown[], maxLen: number): unknown[] {
  if (maxLen <= 0) return msgs
  return msgs.map(msg => truncateMessageParts(msg, maxLen))
}

function truncateMessageParts(msg: unknown, maxLen: number): unknown {
  if (!msg || typeof msg !== "object") return msg
  const obj = msg as Record<string, unknown>
  const result = { ...obj }

  // Truncate top-level content (for simple {role, content} messages)
  if (typeof result["content"] === "string") {
    result["content"] = truncate(result["content"] as string, maxLen)
  }
  if (typeof result["response"] === "string") {
    result["response"] = truncate(result["response"] as string, maxLen)
  }

  // Truncate parts array
  if (Array.isArray(result["parts"])) {
    result["parts"] = (result["parts"] as unknown[]).map(part => {
      if (!part || typeof part !== "object") return part
      const p = { ...part as Record<string, unknown> }
      if (typeof p["content"] === "string") {
        p["content"] = truncate(p["content"] as string, maxLen)
      }
      if (typeof p["response"] === "string") {
        p["response"] = truncate(p["response"] as string, maxLen)
      }
      if (typeof p["arguments"] === "string") {
        p["arguments"] = truncate(p["arguments"] as string, maxLen)
      }
      return p
    })
  }
  return result
}

/**
 * Accumulates token and cost totals for a session, and increments the message count.
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place.
 * No-ops silently if the session was not previously registered via `handleSessionCreated`.
 */
export function accumulateSessionTotals(
  sessionID: string,
  tokens: number,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  cost: number,
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID)
  if (!existing) return
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens + tokens,
    inputTokens: existing.inputTokens + inputTokens,
    outputTokens: existing.outputTokens + outputTokens,
    cacheReadTokens: existing.cacheReadTokens + cacheReadTokens,
    cacheWriteTokens: existing.cacheWriteTokens + cacheWriteTokens,
    cost: existing.cost + cost,
    messages: existing.messages + 1,
  })
}
