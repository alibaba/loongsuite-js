import type { HandlerContext, Instruments } from "../src/types.ts"
import type { Logger as OtelLogger, LogRecord } from "@opentelemetry/api-logs"
import type { Counter, Histogram, Span, SpanContext, Tracer, SpanStatus, Attributes, TimeInput } from "@opentelemetry/api"
import { SpanStatusCode, TraceFlags } from "@opentelemetry/api"

export type SpyCounter = {
  calls: Array<{ value: number; attrs: Record<string, unknown> }>
  add(value: number, attrs?: Record<string, unknown>): void
}

export type SpyHistogram = {
  calls: Array<{ value: number; attrs: Record<string, unknown> }>
  record(value: number, attrs?: Record<string, unknown>): void
}

export type SpyLogger = {
  records: LogRecord[]
  emit(record: LogRecord): void
}

export type SpyPluginLog = {
  calls: Array<{ level: string; message: string; extra?: Record<string, unknown> }>
  fn: HandlerContext["log"]
}

function makeCounter(): SpyCounter {
  const spy: SpyCounter = { calls: [], add(v, a = {}) { spy.calls.push({ value: v, attrs: a }) } }
  return spy
}

function makeHistogram(): SpyHistogram {
  const spy: SpyHistogram = { calls: [], record(v, a = {}) { spy.calls.push({ value: v, attrs: a }) } }
  return spy
}

function makeLogger(): SpyLogger {
  const spy: SpyLogger = { records: [], emit(r) { spy.records.push(r) } }
  return spy
}

function makePluginLog(): SpyPluginLog {
  const spy: SpyPluginLog = {
    calls: [],
    fn: async (level, message, extra) => { spy.calls.push({ level, message, extra }) },
  }
  return spy
}

export type SpySpan = {
  name: string
  attributes: Record<string, unknown>
  startTime?: TimeInput
  status: SpanStatus
  events: Array<{ name: string; attributes?: Record<string, unknown> }>
  ended: boolean
  endTime?: TimeInput
  _context: SpanContext
  spanContext(): SpanContext
  setAttribute(key: string, value: unknown): SpySpan
  setStatus(status: SpanStatus): SpySpan
  addEvent(name: string, attributes?: Record<string, unknown>): SpySpan
  end(endTime?: TimeInput): void
  isRecording(): boolean
  recordException(): SpySpan
  updateName(name: string): SpySpan
  setAttributes(attrs: Attributes): SpySpan
}

export type SpyTracer = {
  spans: SpySpan[]
  startSpan(name: string, options?: { attributes?: Attributes; startTime?: TimeInput }, context?: unknown): SpySpan
}

let spanIdCounter = 0

function makeSpySpan(name: string, attributes: Record<string, unknown> = {}, startTime?: TimeInput): SpySpan {
  const id = String(++spanIdCounter).padStart(16, "0")
  const ctx: SpanContext = { traceId: "00000000000000000000000000000001", spanId: id, traceFlags: TraceFlags.SAMPLED }
  const spy: SpySpan = {
    name,
    attributes: { ...attributes },
    startTime,
    status: { code: SpanStatusCode.UNSET },
    events: [],
    ended: false,
    endTime: undefined,
    _context: ctx,
    spanContext() { return ctx },
    setAttribute(k, v) { spy.attributes[k] = v; return spy },
    setStatus(s) { spy.status = s; return spy },
    addEvent(n, a) { spy.events.push({ name: n, attributes: a }); return spy },
    end(t) { spy.ended = true; spy.endTime = t },
    isRecording() { return !spy.ended },
    recordException() { return spy },
    updateName(n) { spy.name = n; return spy },
    setAttributes(a) { Object.assign(spy.attributes, a); return spy },
  }
  return spy
}

function makeSpyTracer(): SpyTracer {
  const spy: SpyTracer = {
    spans: [],
    startSpan(name, options) {
      const s = makeSpySpan(
        name,
        (options?.attributes ?? {}) as Record<string, unknown>,
        options?.startTime,
      )
      spy.spans.push(s)
      return s
    },
  }
  return spy
}

export type MockContext = {
  ctx: HandlerContext
  counters: {
    session: SpyCounter
    token: SpyCounter
    cost: SpyCounter
    lines: SpyCounter
    commit: SpyCounter
    cache: SpyCounter
    message: SpyCounter
    modelUsage: SpyCounter
    retry: SpyCounter
  }
  histograms: {
    tool: SpyHistogram
    sessionDuration: SpyHistogram
  }
  gauges: {
    sessionToken: SpyHistogram
    sessionCost: SpyHistogram
  }
  logger: SpyLogger
  pluginLog: SpyPluginLog
  spyTracer: SpyTracer | null
}

export function makeCtx(projectID = "proj_test", disabledMetrics: string[] = [], opts?: { tracesEnabled?: boolean }): MockContext {
  const session = makeCounter()
  const token = makeCounter()
  const cost = makeCounter()
  const lines = makeCounter()
  const commit = makeCounter()
  const cache = makeCounter()
  const message = makeCounter()
  const modelUsage = makeCounter()
  const retry = makeCounter()
  const toolHistogram = makeHistogram()
  const sessionDurationHistogram = makeHistogram()
  const sessionTokenGauge = makeHistogram()
  const sessionCostGauge = makeHistogram()
  const logger = makeLogger()
  const pluginLog = makePluginLog()

  const instruments: Instruments = {
    sessionCounter: session as unknown as Counter,
    tokenCounter: token as unknown as Counter,
    costCounter: cost as unknown as Counter,
    linesCounter: lines as unknown as Counter,
    commitCounter: commit as unknown as Counter,
    toolDurationHistogram: toolHistogram as unknown as Histogram,
    cacheCounter: cache as unknown as Counter,
    sessionDurationHistogram: sessionDurationHistogram as unknown as Histogram,
    messageCounter: message as unknown as Counter,
    sessionTokenGauge: sessionTokenGauge as unknown as Histogram,
    sessionCostGauge: sessionCostGauge as unknown as Histogram,

    modelUsageCounter: modelUsage as unknown as Counter,
    retryCounter: retry as unknown as Counter,
  }

  const tracesEnabled = opts?.tracesEnabled ?? false
  const spyTracer = tracesEnabled ? makeSpyTracer() : null

  const ctx: HandlerContext = {
    logger: logger as unknown as OtelLogger,
    log: pluginLog.fn,
    instruments,
    commonAttrs: { "project.id": projectID },
    pendingToolSpans: new Map(),
    pendingPermissions: new Map(),
    sessionTotals: new Map(),
    disabledMetrics: new Set(disabledMetrics),
    tracer: spyTracer as unknown as Tracer | null,
    activeInvocations: new Map(),
    sessionInvocationSeq: new Map(),
    activeMessageSpans: new Map(),
    activeToolSpans: new Map(),
    activeStepSpans: new Map(),
    tracesDisabled: !tracesEnabled,
    maxContentSize: 0,
    pendingUserPrompts: new Map(),
    sessionHistory: new Map(),
    pendingSystemPrompts: new Map(),
    sessionAgentMeta: new Map(),
    deferredMessageTextParts: new Map(),
    forceFlush: async () => {},
  }

  return {
    ctx,
    counters: { session, token, cost, lines, commit, cache, message, modelUsage, retry },
    histograms: { tool: toolHistogram, sessionDuration: sessionDurationHistogram },
    gauges: { sessionToken: sessionTokenGauge, sessionCost: sessionCostGauge },
    logger,
    pluginLog,
    spyTracer,
  }
}
