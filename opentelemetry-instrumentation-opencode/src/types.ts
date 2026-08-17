import type { Counter, Histogram, Span, SpanContext, Tracer } from "@opentelemetry/api"
import type { Logger as OtelLogger } from "@opentelemetry/api-logs"

/** Numeric priority map for log levels; higher value = higher severity. */
export const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const

/** Union of supported log level names. */
export type Level = keyof typeof LEVELS

/** Maximum number of entries kept in `pendingToolSpans` and `pendingPermissions` maps. */
export const MAX_PENDING = 500

/** Structured logger forwarded to the opencode `client.app.log` API. */
export type PluginLogger = (
  level: Level,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

/** OTel resource attributes common to every emitted log and metric. */
export type CommonAttrs = { readonly "project.id": string }

/** In-flight tool execution tracked between `running` and `completed`/`error` part updates. */
export type PendingToolSpan = {
  tool: string
  sessionID: string
  startMs: number
}

/** Permission prompt tracked between `permission.updated` and `permission.replied`. */
export type PendingPermission = {
  type: string
  title: string
  sessionID: string
  callID?: string
}

/** OTel metric instruments created once at plugin startup and shared via `HandlerContext`. */
export type Instruments = {
  sessionCounter: Counter
  tokenCounter: Counter
  costCounter: Counter
  linesCounter: Counter
  commitCounter: Counter
  toolDurationHistogram: Histogram
  cacheCounter: Counter
  sessionDurationHistogram: Histogram
  messageCounter: Counter
  sessionTokenGauge: Histogram
  sessionCostGauge: Histogram
  modelUsageCounter: Counter
  retryCounter: Counter
}

/** Accumulated per-session totals used for gauge snapshots on session.idle. */
export type SessionTotals = {
  startMs: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  messages: number
}

/** Info about a tool call made by the assistant, recorded on the LLM span. */
export type ToolCallInfo = {
  callID: string
  name: string
  arguments: string
}

/** Info about a completed tool result, used as input context for the next LLM call. */
export type ToolResultInfo = {
  callID: string
  name: string
  content: string
}

/** Active LLM call span created on first part arrival, ended on message.updated. */
export type ActiveMessageSpan = {
  span: Span
  context: SpanContext
  stepRound: number
  invocationID: string
  sessionID: string
  messageID: string
  /** Accumulated text content per part ID (latest text for each part). */
  textParts: Map<string, string>
  /** Tool calls issued by the assistant during this LLM call. */
  toolCalls: ToolCallInfo[]
  /** Tool results collected during this LLM call (become next call's input). */
  toolResults: ToolResultInfo[]
  /** Epoch ms when the LLM span was created (used for TTFT calculation). */
  startTimeMs: number
  /** Epoch ms of the first text part arrival (undefined until first text). */
  firstTextTimeMs?: number
  /** Accumulated reasoning duration in ms across all reasoning parts. */
  reasoningTimeMs: number
}

/** Active tool trace span tracked between tool running and completed/error. */
export type ActiveToolSpan = {
  span: Span
  tool: string
  sessionID: string
  startMs: number
}

/** Active ReAct step span tracked between step-start and step-finish part events. */
export type ActiveStepSpan = {
  span: Span
  context: SpanContext
  round: number
  sessionID: string
}

export type ActiveInvocation = {
  invocationID: string
  sessionID: string
  requestSeq: number
  entrySpan: Span
  entryContext: SpanContext
  agentSpan: Span
  agentContext: SpanContext
  nextStepRound: number
  inputSet?: boolean
  entryStartTime: number
  firstTokenSet?: boolean
}

export type SessionAgentMeta = {
  id?: string
  name?: string
  description?: string
}

/** Shared context threaded through every event handler. */
export type HandlerContext = {
  logger: OtelLogger
  log: PluginLogger
  instruments: Instruments
  commonAttrs: CommonAttrs
  pendingToolSpans: Map<string, PendingToolSpan>
  pendingPermissions: Map<string, PendingPermission>
  sessionTotals: Map<string, SessionTotals>
  disabledMetrics: Set<string>
  tracer: Tracer | null
  activeInvocations: Map<string, ActiveInvocation>
  sessionInvocationSeq: Map<string, number>
  activeMessageSpans: Map<string, ActiveMessageSpan>
  activeToolSpans: Map<string, ActiveToolSpan>
  /** Active ReAct step spans keyed by sessionID, one per session at most. */
  activeStepSpans: Map<string, ActiveStepSpan>
  tracesDisabled: boolean
  /** Max characters per role content in gen_ai.input/output.messages (0 = unlimited). */
  maxContentSize: number
  /** Latest user prompt text per session, buffered from chat.message for LLM span input. */
  pendingUserPrompts: Map<string, string>
  /** Accumulated conversation history per session (assistant outputs + tool results), used for gen_ai.input.messages. */
  sessionHistory: Map<string, unknown[]>
  /** Latest system prompt per session, captured from experimental.chat.system.transform. */
  pendingSystemPrompts: Map<string, string>
  /** Best-effort agent metadata captured from chat.message input. */
  sessionAgentMeta: Map<string, SessionAgentMeta>
  /**
   * Text parts without `time.start` are buffered here until an LLM span is opened with a
   * server-authoritative start time (tool running, timed text/reasoning, or message.updated).
   * Key: `sessionID:messageID`.
   */
  deferredMessageTextParts: Map<string, Map<string, string>>
  /** Force-flushes all OTel providers (metrics, logs, traces). Called on session idle to ensure data export before process exit. */
  forceFlush: () => Promise<void>
}
