import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import type { AssistantMessage, EventMessageUpdated, EventMessagePartUpdated, ReasoningPart, StepStartPart, StepFinishPart, ToolPart, TextPart } from "@opencode-ai/sdk"
import {
  accumulateSessionTotals,
  errorSummary,
  genAiSpanAttrs,
  genAiSpanName,
  isMetricEnabled,
  isTraceEnabled,
  setBoundedMap,
  startChildSpan,
  truncate,
  truncateMessages,
} from "../util.ts"
import type { ActiveInvocation, ActiveMessageSpan, HandlerContext } from "../types.ts"
import type { AttributeValue } from "@opentelemetry/api"
import { appendEvent } from "../log-writer.ts"
import * as crypto from "node:crypto"

/** Extracts trace context from a span for log event fields. Returns empty strings if unavailable. */
// function extractTraceContext(ctx: HandlerContext, sessionID: string): { trace_id: string; span_id: string; parent_span_id: string } {
//   const invocation = ctx.activeInvocations.get(sessionID)
//   const msgSpanKey = [...ctx.activeMessageSpans.entries()].find(([k]) => k.startsWith(sessionID + ":"))?.[1]
//   const span = msgSpanKey?.span
//   if (span) {
//     const sc = span.spanContext()
//     const parentSpanId = invocation?.agentSpan?.spanContext().spanId ?? ""
//     return { trace_id: sc.traceId, span_id: sc.spanId, parent_span_id: parentSpanId }
//   }
//   if (invocation) {
//     const sc = invocation.agentSpan.spanContext()
//     return { trace_id: sc.traceId, span_id: "", parent_span_id: sc.spanId }
//   }
//   return { trace_id: "", span_id: "", parent_span_id: "" }
// }

/** Computes SHA-256 hash (first 16 hex chars) of input messages for deduplication. */
function computeMessagesHash(messages: unknown[]): string {
  if (messages.length === 0) return ""
  const raw = JSON.stringify(messages)
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16)
}

/** Merges deferred text parts (no `time.start` yet) into a newly opened LLM span. */
function flushDeferredMessageText(sessionID: string, messageID: string, active: ActiveMessageSpan, ctx: HandlerContext) {
  const key = `${sessionID}:${messageID}`
  const deferred = ctx.deferredMessageTextParts.get(key)
  if (!deferred) return
  for (const [id, text] of deferred) active.textParts.set(id, text)
  ctx.deferredMessageTextParts.delete(key)
}

/**
 * Gets or creates an LLM span for the given message. Created on the first
 * `message.part.updated` so that tool spans can be parented correctly.
 * Returns `null` when tracing is disabled.
 */
function getOrCreateLLMSpan(
  sessionID: string,
  messageID: string,
  ctx: HandlerContext,
  startTime?: number,
): ActiveMessageSpan | null {
  const key = `${sessionID}:${messageID}`
  const existing = ctx.activeMessageSpans.get(key)
  if (existing) return existing

  if (!isTraceEnabled(ctx) || !ctx.tracer) return null

  const invocation = getOrCreateInvocation(sessionID, ctx, startTime)
  if (!invocation) return null
  const stepActive = ctx.activeStepSpans.get(sessionID)
  const stepRound = stepActive?.round ?? invocation.nextStepRound
  const parentCtx = stepActive?.context ?? invocation.agentContext
  const span = startChildSpan(
    ctx.tracer,
    genAiSpanName("chat"),
    genAiSpanAttrs("LLM", "chat", sessionID, ctx.commonAttrs, {
      "gen_ai.react.round": stepRound,
      "gen_ai.loop.id": invocation.invocationID,
      "gen_ai.loop.iteration": stepRound,
      "opencode.message.id": messageID,
    }),
    parentCtx,
    startTime,
  )

  const active: ActiveMessageSpan = {
    span,
    context: span.spanContext(),
    stepRound,
    invocationID: invocation.invocationID,
    sessionID,
    messageID,
    textParts: new Map(),
    toolCalls: [],
    toolResults: [],
    startTimeMs: startTime ?? Date.now(),
    reasoningTimeMs: 0,
  }
  setBoundedMap(ctx.activeMessageSpans, key, active)
  flushDeferredMessageText(sessionID, messageID, active, ctx)
  return active
}

function getOrCreateInvocation(
  sessionID: string,
  ctx: HandlerContext,
  startTime?: number,
): ActiveInvocation | null {
  const existing = ctx.activeInvocations.get(sessionID)
  if (existing) return existing
  if (!isTraceEnabled(ctx) || !ctx.tracer) return null
  const nextSeq = (ctx.sessionInvocationSeq.get(sessionID) ?? 0) + 1
  ctx.sessionInvocationSeq.set(sessionID, nextSeq)
  const invocationID = `${sessionID}:${nextSeq}`
  const entrySpan = startChildSpan(
    ctx.tracer,
    genAiSpanName("enter"),
    genAiSpanAttrs("ENTRY", "enter", sessionID, ctx.commonAttrs),
    undefined,
    startTime,
  )
  const agentMeta = ctx.sessionAgentMeta.get(sessionID)
  const agentName = agentMeta?.name ?? "opencode-agent"
  const agentAttrs: Record<string, AttributeValue> = { "gen_ai.agent.name": agentName }
  if (agentMeta?.id) agentAttrs["gen_ai.agent.id"] = agentMeta.id
  if (agentMeta?.description) agentAttrs["gen_ai.agent.description"] = agentMeta.description
  const agentSpan = startChildSpan(
    ctx.tracer,
    genAiSpanName("invoke_agent", agentName),
    genAiSpanAttrs("AGENT", "invoke_agent", sessionID, ctx.commonAttrs, agentAttrs),
    entrySpan.spanContext(),
    startTime,
  )
  const invocation: ActiveInvocation = {
    invocationID,
    sessionID,
    requestSeq: nextSeq,
    entrySpan,
    entryContext: entrySpan.spanContext(),
    agentSpan,
    agentContext: agentSpan.spanContext(),
    nextStepRound: 1,
    entryStartTime: startTime ?? Date.now(),
  }
  setBoundedMap(ctx.activeInvocations, sessionID, invocation)
  return invocation
}

/** Safely parses a JSON string into an object; returns the raw string on failure. */
function tryParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return s }
}

/**
 * Builds `gen_ai.input.messages`: user prompt + accumulated conversation history
 * (previous assistant outputs and tool results).
 *
 * Format uses `parts` arrays per the GenAI semantic conventions.
 */
function buildInputMessages(sessionID: string, ctx: HandlerContext): unknown[] {
  const msgs: unknown[] = []
  const systemPrompt = ctx.pendingSystemPrompts.get(sessionID)
  if (systemPrompt) {
    msgs.push({ role: "system", parts: [{ type: "text", content: systemPrompt }] })
  }
  const userPrompt = ctx.pendingUserPrompts.get(sessionID)
  if (userPrompt) {
    msgs.push({ role: "user", parts: [{ type: "text", content: userPrompt }] })
  }
  const history = ctx.sessionHistory.get(sessionID)
  if (history) {
    msgs.push(...history)
  }
  return msgs
}

/**
 * Appends the current LLM call's output (assistant message + tool results)
 * to the session's conversation history for use as input in subsequent calls.
 */
function appendToSessionHistory(sessionID: string, active: ActiveMessageSpan, ctx: HandlerContext) {
  const history = ctx.sessionHistory.get(sessionID) ?? []

  // Append assistant output: text parts + tool_call parts
  const parts: unknown[] = []
  const textContent = [...active.textParts.values()].join("")
  if (textContent) parts.push({ type: "text", content: textContent })
  for (const tc of active.toolCalls) {
    parts.push({ type: "tool_call", id: tc.callID, name: tc.name, arguments: tryParseJson(tc.arguments) })
  }
  if (parts.length > 0) {
    history.push({ role: "assistant", parts })
  }

  // Append tool results as separate role=tool messages
  for (const r of active.toolResults) {
    history.push({ role: "tool", parts: [{ type: "tool_call_response", id: r.callID, response: r.content }] })
  }

  ctx.sessionHistory.set(sessionID, history)
}

/**
 * Builds `gen_ai.output.messages`: assistant text parts + tool_call parts.
 */
function buildOutputMessages(active: ActiveMessageSpan): unknown[] {
  const parts: unknown[] = []
  const textContent = [...active.textParts.values()].join("")
  if (textContent) parts.push({ type: "text", content: textContent })
  for (const tc of active.toolCalls) {
    parts.push({ type: "tool_call", id: tc.callID, name: tc.name, arguments: tryParseJson(tc.arguments) })
  }
  if (parts.length === 0) return []
  return [{ role: "assistant", parts }]
}

/**
 * Handles a completed assistant message: increments token and cost counters and emits
 * either an `api_request` or `api_error` log event depending on whether the message errored.
 * Finalizes the LLM span (created earlier by part events) with model attributes and timing.
 */
export function handleMessageUpdated(e: EventMessageUpdated, ctx: HandlerContext) {
  const msg = e.properties.info
  if (msg.role !== "assistant") {
    // Discard any LLM span accidentally created by text parts for non-assistant messages.
    // Not calling span.end() ensures BatchSpanProcessor never exports the orphan.
    const msgInfo = msg as { sessionID: string; id: string }
    const orphanKey = `${msgInfo.sessionID}:${msgInfo.id}`
    ctx.activeMessageSpans.delete(orphanKey)
    return
  }
  const assistant = msg as AssistantMessage
  if (!assistant.time.completed) return

  const { sessionID, modelID, providerID } = assistant
  const duration = assistant.time.completed - assistant.time.created

  const totalTokens = assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning
    + assistant.tokens.cache.read + assistant.tokens.cache.write

  if (isMetricEnabled("token.usage", ctx)) {
    const { tokenCounter } = ctx.instruments
    tokenCounter.add(assistant.tokens.input, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "input" })
    tokenCounter.add(assistant.tokens.output, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "output" })
    tokenCounter.add(assistant.tokens.reasoning, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "reasoning" })
    tokenCounter.add(assistant.tokens.cache.read, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheRead" })
    tokenCounter.add(assistant.tokens.cache.write, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheCreation" })
  }

  if (isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(assistant.cost, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID })
  }

  if (isMetricEnabled("cache.count", ctx)) {
    if (assistant.tokens.cache.read > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheRead" })
    }
    if (assistant.tokens.cache.write > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, type: "cacheCreation" })
    }
  }

  if (isMetricEnabled("message.count", ctx)) {
    ctx.instruments.messageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID })
  }

  if (isMetricEnabled("model.usage", ctx)) {
    ctx.instruments.modelUsageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, provider: providerID })
  }

  accumulateSessionTotals(sessionID, totalTokens, assistant.tokens.input, assistant.tokens.output, assistant.tokens.cache.read, assistant.tokens.cache.write, assistant.cost, ctx)

  ctx.log("debug", "otel: token+cost counters incremented", {
    sessionID,
    model: modelID,
    input: assistant.tokens.input,
    output: assistant.tokens.output,
    reasoning: assistant.tokens.reasoning,
    cacheRead: assistant.tokens.cache.read,
    cacheWrite: assistant.tokens.cache.write,
    cost_usd: assistant.cost,
  })

  const hasError = assistant.error !== undefined

  // Finalize the LLM span (created by part events, or create now if no parts arrived)
  const msgKey = `${sessionID}:${assistant.id}`
  const active = ctx.activeMessageSpans.get(msgKey)
    ?? getOrCreateLLMSpan(sessionID, assistant.id, ctx, assistant.time.created)

  if (active) {
    const { span } = active
    span.updateName(genAiSpanName("chat", modelID))
    span.setAttribute("gen_ai.request.model", modelID)
    span.setAttribute("gen_ai.response.model", modelID)
    span.setAttribute("gen_ai.provider.name", providerID)
    span.setAttribute("gen_ai.usage.input_tokens", assistant.tokens.input)
    span.setAttribute("gen_ai.usage.output_tokens", assistant.tokens.output)
    span.setAttribute("gen_ai.usage.total_tokens", totalTokens)
    span.setAttribute("gen_ai.usage.cache_read.input_tokens", assistant.tokens.cache.read)
    span.setAttribute("gen_ai.usage.cache_creation.input_tokens", assistant.tokens.cache.write)
    span.setAttribute("gen_ai.output.type", "text")
    span.setAttribute("cost_usd", assistant.cost)
    span.setAttribute("duration_ms", duration)

    // LLM-level time-to-first-token (nanoseconds)
    if (active.firstTextTimeMs) {
      const ttftNs = (active.firstTextTimeMs - active.startTimeMs) * 1_000_000
      span.setAttribute("gen_ai.response.time_to_first_token", ttftNs)
    }

    // Reasoning time (milliseconds)
    if (active.reasoningTimeMs > 0) {
      span.setAttribute("gen_ai.response.reasoning_time", active.reasoningTimeMs)
    }

    // System instructions
    const systemPrompt = ctx.pendingSystemPrompts.get(sessionID)
    if (systemPrompt) {
      span.setAttribute("gen_ai.system_instructions", JSON.stringify([{ type: "text", content: systemPrompt }]))
    }

    const maxLen = ctx.maxContentSize
    const inputMsgs = truncateMessages(buildInputMessages(sessionID, ctx), maxLen)
    if (inputMsgs.length > 0) {
      span.setAttribute("gen_ai.input.messages", JSON.stringify(inputMsgs))
    }

    const outputMsgs = truncateMessages(buildOutputMessages(active), maxLen)
    const outputMsgsJson = outputMsgs.length > 0 ? JSON.stringify(outputMsgs) : undefined
    if (outputMsgsJson) {
      span.setAttribute("gen_ai.output.messages", outputMsgsJson)
    }

    // Append this round's assistant output + tool results to conversation history
    appendToSessionHistory(sessionID, active, ctx)

    if (hasError) {
      const finishReason = "error"
      span.setAttribute("gen_ai.response.finish_reasons", JSON.stringify([finishReason]))
      span.setAttribute("gen_ai.react.finish_reason", finishReason)
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(assistant.error) })
    } else {
      const finishReason = active.toolCalls.length > 0 ? "tool_calls" : "stop"
      span.setAttribute("gen_ai.response.finish_reasons", JSON.stringify([finishReason]))
      span.setAttribute("gen_ai.react.finish_reason", "success")
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end(assistant.time.completed)
    ctx.activeMessageSpans.delete(msgKey)

    // --- Event log: llm.request + llm.response (paired write at completion) ---
    const llmFinishReason = hasError ? "error" : (active.toolCalls.length > 0 ? "tool_calls" : "stop")
    const llmTraceCtx = { trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId, parent_span_id: "" }
    const invocationForLog = ctx.activeInvocations.get(sessionID)
    if (invocationForLog) {
      llmTraceCtx.parent_span_id = invocationForLog.agentSpan.spanContext().spanId
    }

    // Write llm.request (using startTimeMs as the request time)
    const logInputMsgs = truncateMessages(buildInputMessages(sessionID, ctx), ctx.maxContentSize)
    const userPrompt = ctx.pendingUserPrompts.get(sessionID)
    const inputDelta = userPrompt
      ? [{ role: "user", parts: [{ type: "text", content: userPrompt }] }]
      : undefined
    appendEvent({
      "time_unix_nano": String(active.startTimeMs * 1_000_000),
      "event.name": "llm.request",
      "gen_ai.session.id": sessionID,
      "gen_ai.provider.name": providerID,
      "gen_ai.request.model": modelID,
      "turn.id": active.invocationID,
      "step.id": String(active.stepRound),
      "message.role": "user",
      "gen_ai.input.messages": logInputMsgs.length > 0 ? logInputMsgs : undefined,
      "gen_ai.input.messages_delta": inputDelta,
      "gen_ai.input.messages_hash": logInputMsgs.length > 0 ? computeMessagesHash(logInputMsgs) : undefined,
      ...(llmTraceCtx.trace_id ? { trace_id: llmTraceCtx.trace_id } : {}),
      ...(llmTraceCtx.span_id ? { span_id: llmTraceCtx.span_id } : {}),
      ...(llmTraceCtx.parent_span_id ? { parent_span_id: llmTraceCtx.parent_span_id } : {}),
    })

    // Write llm.response
    appendEvent({
      "time_unix_nano": String(assistant.time.completed * 1_000_000),
      "event.name": "llm.response",
      "gen_ai.session.id": sessionID,
      "gen_ai.provider.name": providerID,
      "gen_ai.request.model": modelID,
      "gen_ai.response.model": modelID,
      "gen_ai.response.finish_reasons": [llmFinishReason],
      "gen_ai.usage.input_tokens": assistant.tokens.input,
      "gen_ai.usage.output_tokens": assistant.tokens.output,
      "gen_ai.usage.cache_read.input_tokens": assistant.tokens.cache.read,
      "gen_ai.usage.cache_creation.input_tokens": assistant.tokens.cache.write,
      "gen_ai.usage.total_tokens": totalTokens,
      "cost.total": assistant.cost,
      "gen_ai.output.messages": outputMsgsJson ? JSON.parse(outputMsgsJson) : undefined,
      "turn.id": active.invocationID,
      "step.id": String(active.stepRound),
      ...(hasError ? { "is_error": true, "error.message": errorSummary(assistant.error) } : {}),
      ...(llmTraceCtx.trace_id ? { trace_id: llmTraceCtx.trace_id } : {}),
      ...(llmTraceCtx.span_id ? { span_id: llmTraceCtx.span_id } : {}),
      ...(llmTraceCtx.parent_span_id ? { parent_span_id: llmTraceCtx.parent_span_id } : {}),
    })

    const invocation = ctx.activeInvocations.get(sessionID)
    if (invocation) {
      invocation.entrySpan.setAttribute("opencode.message.id", assistant.id)
      invocation.agentSpan.setAttribute("opencode.message.id", assistant.id)
      if (outputMsgsJson) {
        invocation.entrySpan.setAttribute("gen_ai.output.messages", outputMsgsJson)
        invocation.agentSpan.setAttribute("gen_ai.output.messages", outputMsgsJson)
      }
      // Update cumulative token totals on the AGENT span
      const totals = ctx.sessionTotals.get(sessionID)
      if (totals) {
        invocation.agentSpan.setAttribute("gen_ai.usage.input_tokens", totals.inputTokens)
        invocation.agentSpan.setAttribute("gen_ai.usage.output_tokens", totals.outputTokens)
        invocation.agentSpan.setAttribute("gen_ai.usage.total_tokens", totals.tokens)
        invocation.agentSpan.setAttribute("gen_ai.usage.cache_read.input_tokens", totals.cacheReadTokens)
        invocation.agentSpan.setAttribute("gen_ai.usage.cache_creation.input_tokens", totals.cacheWriteTokens)
      }
    }
  }

  if (hasError) {
    ctx.logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: assistant.time.created,
      observedTimestamp: Date.now(),
      body: "api_error",
      attributes: {
        "event.name": "api_error",
        "session.id": sessionID,
        model: modelID,
        provider: providerID,
        error: errorSummary(assistant.error),
        duration_ms: duration,
        ...ctx.commonAttrs,
      },
    })
    return ctx.log("error", "otel: api_error", {
      sessionID,
      model: modelID,
      error: errorSummary(assistant.error),
      duration_ms: duration,
    })
  }

  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: assistant.time.created,
    observedTimestamp: Date.now(),
    body: "api_request",
    attributes: {
      "event.name": "api_request",
      "session.id": sessionID,
      model: modelID,
      provider: providerID,
      cost_usd: assistant.cost,
      duration_ms: duration,
      input_tokens: assistant.tokens.input,
      output_tokens: assistant.tokens.output,
      reasoning_tokens: assistant.tokens.reasoning,
      cache_read_tokens: assistant.tokens.cache.read,
      cache_creation_tokens: assistant.tokens.cache.write,
      ...ctx.commonAttrs,
    },
  })
  return ctx.log("info", "otel: api_request", {
    sessionID,
    model: modelID,
    cost_usd: assistant.cost,
    duration_ms: duration,
    input_tokens: assistant.tokens.input,
    output_tokens: assistant.tokens.output,
  })
}

/**
 * Tracks tool execution time between `running` and `completed`/`error` part updates,
 * records a `tool.duration` histogram measurement, and emits a `tool_result` log event.
 * Also buffers text parts for the LLM span's output messages.
 */
export function handleMessagePartUpdated(e: EventMessagePartUpdated, ctx: HandlerContext) {
  const part = e.properties.part

  // Buffer text parts on the LLM span for gen_ai.output.messages
  if (part.type === "text") {
    const textPart = part as TextPart
    const key = `${textPart.sessionID}:${textPart.messageID}`
    // Record time-to-first-token on the ENTRY span (once per invocation)
    const invocation = ctx.activeInvocations.get(textPart.sessionID)
    if (invocation && !invocation.firstTokenSet) {
      const now = textPart.time?.start ?? Date.now()
      const ttftNs = (now - invocation.entryStartTime) * 1_000_000
      invocation.entrySpan.setAttribute("gen_ai.response.time_to_first_token", ttftNs)
      invocation.agentSpan.setAttribute("gen_ai.response.time_to_first_token", ttftNs)
      invocation.firstTokenSet = true
    }
    const existing = ctx.activeMessageSpans.get(key)
    if (existing) {
      existing.textParts.set(textPart.id, textPart.text)
      if (!existing.firstTextTimeMs) {
        existing.firstTextTimeMs = textPart.time?.start ?? Date.now()
      }
      return
    }
    const t0 = textPart.time?.start
    if (t0 === undefined) {
      let inner = ctx.deferredMessageTextParts.get(key)
      if (!inner) {
        inner = new Map()
        setBoundedMap(ctx.deferredMessageTextParts, key, inner)
      }
      inner.set(textPart.id, textPart.text)
      return
    }
    const active = getOrCreateLLMSpan(textPart.sessionID, textPart.messageID, ctx, t0)
    if (active) {
      active.textParts.set(textPart.id, textPart.text)
      if (!active.firstTextTimeMs) {
        active.firstTextTimeMs = t0
      }
    }
    return
  }

  if (part.type === "reasoning") {
    const rp = part as ReasoningPart
    const llmSpan = getOrCreateLLMSpan(rp.sessionID, rp.messageID, ctx, rp.time.start)
    if (llmSpan && rp.time.end) {
      llmSpan.reasoningTimeMs += rp.time.end - rp.time.start
    }
    return
  }

  // Handle ReAct step boundaries — create/end STEP spans
  if (part.type === "step-start") {
    if (!isTraceEnabled(ctx) || !ctx.tracer) return
    const sp = part as StepStartPart
    const invocation = getOrCreateInvocation(sp.sessionID, ctx)
    if (!invocation) return
    // Close previous step span if still open (shouldn't normally happen, but defensive)
    const prevStep = ctx.activeStepSpans.get(sp.sessionID)
    if (prevStep) {
      prevStep.span.setStatus({ code: SpanStatusCode.OK })
      prevStep.span.end()
    }
    const round = invocation.nextStepRound
    invocation.nextStepRound += 1
    const stepSpan = startChildSpan(
      ctx.tracer,
      genAiSpanName("react step"),
      genAiSpanAttrs("STEP", "react", sp.sessionID, ctx.commonAttrs, {
        "gen_ai.react.round": round,
        "gen_ai.loop.id": invocation.invocationID,
        "gen_ai.loop.iteration": round,
        "opencode.message.id": sp.messageID,
      }),
      invocation.agentContext,
    )
    setBoundedMap(ctx.activeStepSpans, sp.sessionID, {
      span: stepSpan,
      context: stepSpan.spanContext(),
      round,
      sessionID: sp.sessionID,
    })
    ctx.log("debug", "otel: step span started", { sessionID: sp.sessionID, round })
    return
  }

  if (part.type === "step-finish") {
    const sp = part as StepFinishPart
    const activeStep = ctx.activeStepSpans.get(sp.sessionID)
    if (activeStep) {
      activeStep.span.setAttribute("gen_ai.react.finish_reason", sp.reason)
      activeStep.span.setAttribute("gen_ai.usage.input_tokens", sp.tokens.input)
      activeStep.span.setAttribute("gen_ai.usage.output_tokens", sp.tokens.output)
      activeStep.span.setAttribute("cost_usd", sp.cost)
      activeStep.span.setStatus({ code: SpanStatusCode.OK })
      activeStep.span.end()
      ctx.activeStepSpans.delete(sp.sessionID)
      ctx.log("debug", "otel: step span ended", { sessionID: sp.sessionID, round: activeStep.round, reason: sp.reason })
    }
    return
  }

  if (part.type !== "tool") return

  const toolPart = part as ToolPart
  const key = `${toolPart.sessionID}:${toolPart.callID}`

  if (toolPart.state.status === "running") {
    setBoundedMap(ctx.pendingToolSpans, key, {
      tool: toolPart.tool,
      sessionID: toolPart.sessionID,
      startMs: toolPart.state.time.start,
    })
    if (isTraceEnabled(ctx) && ctx.tracer) {
      const llmSpan = getOrCreateLLMSpan(toolPart.sessionID, toolPart.messageID, ctx, toolPart.state.time.start)
      const stepActive = ctx.activeStepSpans.get(toolPart.sessionID)
      const parentCtx = stepActive?.context
        ?? ctx.activeInvocations.get(toolPart.sessionID)?.agentContext
      const rawInput = typeof toolPart.state.input === "string"
        ? toolPart.state.input
        : JSON.stringify(toolPart.state.input)
      const toolSpan = startChildSpan(
        ctx.tracer,
        genAiSpanName("execute_tool", toolPart.tool),
        genAiSpanAttrs("TOOL", "execute_tool", toolPart.sessionID, ctx.commonAttrs, {
          "gen_ai.tool.name": toolPart.tool,
          "gen_ai.tool.call.id": toolPart.callID,
          "gen_ai.tool.call.arguments": rawInput,
          "gen_ai.react.round": stepActive?.round ?? llmSpan?.stepRound ?? 0,
          "gen_ai.loop.id": ctx.activeInvocations.get(toolPart.sessionID)?.invocationID ?? "",
          "gen_ai.loop.iteration": stepActive?.round ?? llmSpan?.stepRound ?? 0,
          "opencode.message.id": toolPart.messageID,
        }),
        parentCtx,
        toolPart.state.time.start,
      )
      setBoundedMap(ctx.activeToolSpans, key, {
        span: toolSpan,
        tool: toolPart.tool,
        sessionID: toolPart.sessionID,
        startMs: toolPart.state.time.start,
      })
      // Record tool call on the LLM span for gen_ai.output.messages (deduplicate by callID)
      if (llmSpan && !llmSpan.toolCalls.some(tc => tc.callID === toolPart.callID)) {
        llmSpan.toolCalls.push({
          callID: toolPart.callID,
          name: toolPart.tool,
          arguments: rawInput,
        })
      }
    }
    ctx.log("debug", "otel: tool span started", { sessionID: toolPart.sessionID, tool: toolPart.tool, key })
    return
  }

  if (toolPart.state.status !== "completed" && toolPart.state.status !== "error") return

  const span = ctx.pendingToolSpans.get(key)
  ctx.pendingToolSpans.delete(key)
  const start = span?.startMs ?? toolPart.state.time.start
  const end = toolPart.state.time.end
  if (end === undefined) return
  const duration_ms = end - start
  const success = toolPart.state.status === "completed"

  if (isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(duration_ms, {
      ...ctx.commonAttrs,
      "session.id": toolPart.sessionID,
      tool_name: toolPart.tool,
      success,
    })
  }

  const sizeAttr = success
    ? { tool_result_size_bytes: Buffer.byteLength((toolPart.state as { output: string }).output, "utf8") }
    : { error: (toolPart.state as { error: string }).error }

  ctx.logger.emit({
    severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
    severityText: success ? "INFO" : "ERROR",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: "tool_result",
    attributes: {
      "event.name": "tool_result",
      "session.id": toolPart.sessionID,
      tool_name: toolPart.tool,
      success,
      duration_ms,
      ...sizeAttr,
      ...ctx.commonAttrs,
    },
  })

  const rawOutput = success ? (toolPart.state as { output: string }).output : ""
  const truncatedOutput = success ? truncate(rawOutput, ctx.maxContentSize) : ""

  const activeToolSpan = ctx.activeToolSpans.get(key)
  if (activeToolSpan) {
    ctx.activeToolSpans.delete(key)
    activeToolSpan.span.setAttribute("duration_ms", duration_ms)
    if (success) {
      activeToolSpan.span.setAttribute("gen_ai.tool.call.result", truncatedOutput)
      activeToolSpan.span.setStatus({ code: SpanStatusCode.OK })
    } else {
      const errStr = (toolPart.state as { error: string }).error
      activeToolSpan.span.setStatus({ code: SpanStatusCode.ERROR, message: errStr })
    }
    activeToolSpan.span.end(end)
  }

  // Record tool result on the LLM span for next round's gen_ai.input.messages
  if (success) {
    const msgKey = `${toolPart.sessionID}:${toolPart.messageID}`
    const llmSpan = ctx.activeMessageSpans.get(msgKey)
    if (llmSpan && !llmSpan.toolResults.some(tr => tr.callID === toolPart.callID)) {
      llmSpan.toolResults.push({
        callID: toolPart.callID,
        name: toolPart.tool,
        content: truncatedOutput,
      })
    }
  }

  ctx.log("debug", "otel: tool.duration histogram recorded", {
    sessionID: toolPart.sessionID,
    tool_name: toolPart.tool,
    duration_ms,
    success,
  })

  // --- Event log: tool.call + tool.result (paired write at completion) ---
  const toolInvocation = ctx.activeInvocations.get(toolPart.sessionID)
  const toolStep = ctx.activeStepSpans.get(toolPart.sessionID)
  const toolTraceSpan = activeToolSpan

  // Write tool.call (using cached startMs as the call time)
  const toolCallRawInput = span
    ? (typeof toolPart.state.input === "string" ? tryParseJson(toolPart.state.input) : toolPart.state.input)
    : undefined
  appendEvent({
    "time_unix_nano": String(start * 1_000_000),
    "event.name": "tool.call",
    "gen_ai.session.id": toolPart.sessionID,
    "gen_ai.tool.name": toolPart.tool,
    "gen_ai.tool.call.id": toolPart.callID,
    "gen_ai.tool.call.arguments": toolCallRawInput,
    "turn.id": toolInvocation?.invocationID ?? "",
    "step.id": String(toolStep?.round ?? toolInvocation?.nextStepRound ?? 1),
    ...(toolTraceSpan?.span ? { trace_id: toolTraceSpan.span.spanContext().traceId, span_id: toolTraceSpan.span.spanContext().spanId } : {}),
    ...(toolInvocation ? { parent_span_id: (toolStep?.span ?? toolInvocation.agentSpan).spanContext().spanId } : {}),
  })

  // Write tool.result
  appendEvent({
    "time_unix_nano": String(end * 1_000_000),
    "event.name": "tool.result",
    "gen_ai.session.id": toolPart.sessionID,
    "gen_ai.tool.name": toolPart.tool,
    "gen_ai.tool.call.id": toolPart.callID,
    "tool.exec.id": crypto.randomUUID(),
    "tool.result.status": success ? "success" : "error",
    "tool.result.duration_ms": duration_ms,
    "gen_ai.tool.call.result": success ? tryParseJson(truncatedOutput) : undefined,
    ...(success ? {} : { "is_error": true, "error.type": "_OTHER", "error.message": (toolPart.state as { error: string }).error }),
    "turn.id": toolInvocation?.invocationID ?? "",
    "step.id": String(toolStep?.round ?? toolInvocation?.nextStepRound ?? 1),
    ...(toolTraceSpan?.span ? { trace_id: toolTraceSpan.span.spanContext().traceId, span_id: toolTraceSpan.span.spanContext().spanId } : {}),
    ...(toolInvocation ? { parent_span_id: (toolStep?.span ?? toolInvocation.agentSpan).spanContext().spanId } : {}),
  })

  return ctx.log(success ? "info" : "error", "otel: tool_result", {
    sessionID: toolPart.sessionID,
    tool_name: toolPart.tool,
    success,
    duration_ms,
  })
}
