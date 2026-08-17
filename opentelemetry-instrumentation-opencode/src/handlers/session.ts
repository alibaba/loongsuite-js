import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import type { EventSessionCreated, EventSessionIdle, EventSessionError, EventSessionStatus } from "@opencode-ai/sdk"
import { errorSummary, isMetricEnabled, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/** Increments the session counter, records start time, and emits a `session.created` log event. */
export function handleSessionCreated(e: EventSessionCreated, ctx: HandlerContext) {
  const sessionID = e.properties.info.id
  const createdAt = e.properties.info.time.created
  if (isMetricEnabled("session.count", ctx)) {
    ctx.instruments.sessionCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
  }
  setBoundedMap(ctx.sessionTotals, sessionID, { startMs: createdAt, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, messages: 0 })

  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: createdAt,
    observedTimestamp: Date.now(),
    body: "session.created",
    attributes: { "event.name": "session.created", "session.id": sessionID, ...ctx.commonAttrs },
  })
  return ctx.log("info", "otel: session.created", { sessionID, createdAt })
}

function sweepSession(sessionID: string, ctx: HandlerContext, error?: boolean, errorMessage?: string) {
  for (const [id, perm] of ctx.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.pendingPermissions.delete(id)
  }
  for (const [key, span] of ctx.pendingToolSpans) {
    if (span.sessionID === sessionID) ctx.pendingToolSpans.delete(key)
  }
  for (const [key, active] of ctx.activeToolSpans) {
    if (active.sessionID === sessionID) {
      if (error) {
        active.span.setStatus({ code: SpanStatusCode.ERROR, message: "session ended" })
      } else {
        active.span.setStatus({ code: SpanStatusCode.OK })
      }
      active.span.end()
      ctx.activeToolSpans.delete(key)
    }
  }
  for (const [key, active] of ctx.activeMessageSpans) {
    if (active.sessionID === sessionID) {
      if (error) {
        active.span.setStatus({ code: SpanStatusCode.ERROR, message: "session ended" })
      } else {
        active.span.setStatus({ code: SpanStatusCode.OK })
      }
      active.span.end()
      ctx.activeMessageSpans.delete(key)
    }
  }
  // Clean up active step span for this session
  const activeStep = ctx.activeStepSpans.get(sessionID)
  if (activeStep) {
    if (error) {
      activeStep.span.setStatus({ code: SpanStatusCode.ERROR, message: "session ended" })
    } else {
      activeStep.span.setStatus({ code: SpanStatusCode.OK })
    }
    activeStep.span.end()
    ctx.activeStepSpans.delete(sessionID)
  }
  const activeInvocation = ctx.activeInvocations.get(sessionID)
  if (activeInvocation) {
    const errMsg = errorMessage ?? "session ended"
    if (error) {
      activeInvocation.agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: errMsg })
      activeInvocation.agentSpan.addEvent("session.error", { error: errMsg })
      activeInvocation.entrySpan.setStatus({ code: SpanStatusCode.ERROR, message: errMsg })
      activeInvocation.entrySpan.addEvent("session.error", { error: errMsg })
    } else {
      activeInvocation.agentSpan.setStatus({ code: SpanStatusCode.OK })
      activeInvocation.entrySpan.setStatus({ code: SpanStatusCode.OK })
    }
    activeInvocation.agentSpan.end()
    activeInvocation.entrySpan.end()
    ctx.activeInvocations.delete(sessionID)
  }
  ctx.pendingUserPrompts.delete(sessionID)
  ctx.pendingSystemPrompts.delete(sessionID)
  ctx.sessionHistory.delete(sessionID)
  ctx.sessionAgentMeta.delete(sessionID)
  const prefix = `${sessionID}:`
  for (const key of ctx.deferredMessageTextParts.keys()) {
    if (key.startsWith(prefix)) ctx.deferredMessageTextParts.delete(key)
  }
}

/** Emits a `session.idle` log event, records duration and session total histograms, and clears pending state. */
export async function handleSessionIdle(e: EventSessionIdle, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const totals = ctx.sessionTotals.get(sessionID)
  ctx.sessionTotals.delete(sessionID)
  sweepSession(sessionID, ctx)

  const attrs = { ...ctx.commonAttrs, "session.id": sessionID }
  let duration_ms: number | undefined

  if (totals) {
    duration_ms = Date.now() - totals.startMs
    if (isMetricEnabled("session.duration", ctx)) {
      ctx.instruments.sessionDurationHistogram.record(duration_ms, attrs)
    }
    if (isMetricEnabled("session.token.total", ctx)) {
      ctx.instruments.sessionTokenGauge.record(totals.tokens, attrs)
    }
    if (isMetricEnabled("session.cost.total", ctx)) {
      ctx.instruments.sessionCostGauge.record(totals.cost, attrs)
    }
  }

  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.idle",
    attributes: {
      "event.name": "session.idle",
      "session.id": sessionID,
      total_tokens: totals?.tokens ?? 0,
      total_cost_usd: totals?.cost ?? 0,
      total_messages: totals?.messages ?? 0,
      ...ctx.commonAttrs,
    },
  })
  ctx.log("debug", "otel: session.idle", {
    sessionID,
    ...(totals ? { duration_ms, total_tokens: totals.tokens, total_cost_usd: totals.cost, total_messages: totals.messages } : {}),
  })

  // Force-flush all OTel providers to ensure data is exported before process exit
  // (critical for `opencode-ai run` which exits immediately after session.idle)
  await ctx.forceFlush()
}

/** Emits a `session.error` log event and clears any pending tool spans and permissions for the session. */
export function handleSessionError(e: EventSessionError, ctx: HandlerContext) {
  const rawID = e.properties.sessionID
  const sessionID = rawID ?? "unknown"
  const error = errorSummary(e.properties.error)
  if (rawID) ctx.sessionTotals.delete(rawID)
  // sweepSession handles activeInvocations, activeToolSpans, activeMessageSpans etc.
  // Pass errorMessage so it sets the correct status/event on invocation spans.
  sweepSession(sessionID, ctx, true, error)
  ctx.logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.error",
    attributes: {
      "event.name": "session.error",
      "session.id": sessionID,
      error,
      ...ctx.commonAttrs,
    },
  })
  ctx.log("error", "otel: session.error", { sessionID, error })
}

/** Increments the retry counter when the session enters a retry state. */
export function handleSessionStatus(e: EventSessionStatus, ctx: HandlerContext) {
  if (e.properties.status.type !== "retry") return
  const { sessionID, status } = e.properties
  const { attempt, message: retryMessage } = status
  if (isMetricEnabled("retry.count", ctx)) {
    ctx.instruments.retryCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    ctx.log("debug", "otel: retry counter incremented", { sessionID, attempt, retryMessage })
  }
}
