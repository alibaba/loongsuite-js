import type { Plugin, AuthHook } from "@opencode-ai/plugin"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import { genAiSpanAttrs, genAiSpanName, isTraceEnabled, setBoundedMap, startChildSpan, truncate } from "./util.ts"
import pkg from "../package.json" with { type: "json" }
import type {
  EventSessionCreated,
  EventSessionIdle,
  EventSessionError,
  EventSessionStatus,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventPermissionUpdated,
  EventPermissionReplied,
  EventSessionDiff,
  EventCommandExecuted,
} from "@opencode-ai/sdk"
import { LEVELS, type Level, type HandlerContext } from "./types.ts"
import { loadConfig, parseOtlpHeaders, resolveLogLevel } from "./config.ts"
import { probeEndpoint } from "./probe.ts"
import { setupOtel, createInstruments } from "./otel.ts"
import { handleSessionCreated, handleSessionIdle, handleSessionError, handleSessionStatus } from "./handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated } from "./handlers/message.ts"
import { handlePermissionUpdated, handlePermissionReplied } from "./handlers/permission.ts"
import { handleSessionDiff, handleCommandExecuted } from "./handlers/activity.ts"

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown"

/**
 * OpenCode plugin that exports session telemetry via OpenTelemetry (OTLP/gRPC).
 * Instruments metrics (sessions, tokens, cost, lines of code, commits, tool durations)
 * and structured log events. Instrumentation is enabled by OTEL exporter endpoint
 * env vars (legacy `OPENCODE_ENABLE_TELEMETRY` is still supported).
 */
export const OtelPlugin: Plugin = async ({ project, client }) => {
  const config = loadConfig()
  let minLevel: Level = "info"

  const log: HandlerContext["log"] = async (level, message, extra) => {
    if (LEVELS[level] < LEVELS[minLevel]) return
    await client.app.log({
      body: { service: "loongsuite/opentelemetry-instrumentation-opencode", level, message, extra },
    })
  }

  if (!config.enabled) {
    await log("info", "telemetry disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)")
    return {}
  }

  // Legacy: propagate OPENCODE_OTLP_HEADERS to the standard env var so the
  // OTel SDK's own header resolution also picks it up (e.g. for auto-instrumentation).
  if (!process.env["OTEL_EXPORTER_OTLP_HEADERS"] && process.env["OPENCODE_OTLP_HEADERS"]) {
    process.env["OTEL_EXPORTER_OTLP_HEADERS"] = process.env["OPENCODE_OTLP_HEADERS"]
  }

  await log("info", "starting up", {
    version: PLUGIN_VERSION,
    endpoint: config.endpoint,
    metricsInterval: config.metricsInterval,
    logsInterval: config.logsInterval,
    metricPrefix: config.metricPrefix,
  })

  await log("debug", "config loaded", {
    headersSet: !!config.otlpHeaders,
    resourceAttributesSet: !!config.resourceAttributes,
  })

  const probe = await probeEndpoint(config.endpoint)
  if (probe.ok) {
    await log("info", "OTLP endpoint reachable", { endpoint: config.endpoint, ms: probe.ms })
  } else {
    await log("warn", "OTLP endpoint unreachable — exports may fail", {
      endpoint: config.endpoint,
      error: probe.error,
    })
  }

  const parsedHeaders = parseOtlpHeaders(config.otlpHeaders)
  const { meterProvider, loggerProvider, tracerProvider } = setupOtel(
    config.endpoint,
    config.metricsInterval,
    config.logsInterval,
    PLUGIN_VERSION,
    config.tracesDisabled,
    config.logsDisabled,
    parsedHeaders,
  )
  await log("info", "OTel SDK initialized", { tracesEnabled: !config.tracesDisabled, logsEnabled: !config.logsDisabled })

  const instruments = createInstruments(config.metricPrefix, meterProvider)
  const noopLogger = { emit() {} } as unknown as import("@opentelemetry/api-logs").Logger
  const logger = loggerProvider ? loggerProvider.getLogger("com.opencode") : noopLogger
  const tracer = tracerProvider ? tracerProvider.getTracer("com.opencode") : null
  const pendingToolSpans = new Map()
  const pendingPermissions = new Map()
  const sessionTotals = new Map()
  const activeInvocations = new Map()
  const sessionInvocationSeq = new Map()
  const activeMessageSpans = new Map()
  const activeToolSpans = new Map()
  const activeStepSpans = new Map()
  const pendingUserPrompts = new Map()
  const sessionHistory = new Map()
  const pendingSystemPrompts = new Map()
  const sessionAgentMeta = new Map()
  const deferredMessageTextParts = new Map()
  const { disabledMetrics } = config
  const commonAttrs = { "project.id": project.id } as const

  if (disabledMetrics.size > 0) {
    await log("info", "metrics disabled", { disabled: [...disabledMetrics] })
  }
  if (config.tracesDisabled) {
    await log("info", "traces disabled (OTEL_TRACES_EXPORTER=none)")
  }
  if (config.logsDisabled) {
    await log("info", "logs disabled (set OTEL_LOGS_EXPORTER=otlp)")
  }

  const ctx: HandlerContext = {
    logger,
    log,
    instruments,
    commonAttrs,
    pendingToolSpans,
    pendingPermissions,
    sessionTotals,
    disabledMetrics,
    tracer,
    activeInvocations,
    sessionInvocationSeq,
    activeMessageSpans,
    activeToolSpans,
    activeStepSpans,
    tracesDisabled: config.tracesDisabled,
    maxContentSize: config.maxContentSize,
    pendingUserPrompts,
    sessionHistory,
    pendingSystemPrompts,
    sessionAgentMeta,
    deferredMessageTextParts,
    forceFlush: async () => {
      await Promise.allSettled([
        meterProvider.forceFlush(),
        ...(loggerProvider ? [loggerProvider.forceFlush()] : []),
        ...(tracerProvider ? [tracerProvider.forceFlush()] : []),
      ])
    },
  }

  async function shutdown() {
    // Flush first to ensure all ended spans are exported, then shut down.
    await Promise.allSettled([
      meterProvider.forceFlush(),
      ...(loggerProvider ? [loggerProvider.forceFlush()] : []),
      ...(tracerProvider ? [tracerProvider.forceFlush()] : []),
    ])
    await Promise.allSettled([
      meterProvider.shutdown(),
      ...(loggerProvider ? [loggerProvider.shutdown()] : []),
      ...(tracerProvider ? [tracerProvider.shutdown()] : []),
    ])
  }

  // Intercept process.exit() so we can flush remaining spans before the process
  // actually terminates. opencode's CLI calls `process.exit()` in a `finally`
  // block immediately after the command completes, which kills all pending I/O
  // including our fire-and-forget forceFlush. By replacing process.exit with a
  // version that awaits shutdown first, we guarantee the last batch of spans
  // (session span + final LLM span) gets exported.
  const originalExit = process.exit.bind(process)
  let exitIntercepted = false

  function interceptedExit(code?: number): never {
    if (exitIntercepted) return originalExit(code) as never
    exitIntercepted = true
    shutdown()
      .then(() => originalExit(code ?? 0))
      .catch(() => originalExit(code ?? 1))
    return undefined as never
  }

  process.exit = interceptedExit as typeof process.exit

  // For SIGTERM/SIGINT: use the same interceptedExit gate to prevent
  // concurrent races between the signal handlers and process.exit().
  process.on("SIGTERM", () => interceptedExit(0))
  process.on("SIGINT",  () => interceptedExit(0))

  // `beforeExit` fires when the event loop drains (no pending async work).
  // A lightweight flush attempt here covers the case where opencode exits
  // cleanly without calling process.exit() directly.
  process.on("beforeExit", () => { shutdown().catch(() => {}) })

  const safe = <T extends unknown[]>(
    name: string,
    fn: (...args: T) => Promise<void> | void,
  ): ((...args: T) => Promise<void>) =>
    async (...args: T) => {
      try {
        await fn(...args)
      } catch (err) {
        await log("error", `otel: unhandled error in ${name}`, {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
      }
    }

  return {
    config: async (cfg) => {
      if (cfg.logLevel) {
        const next = resolveLogLevel(cfg.logLevel, minLevel)
        if (next !== minLevel) {
          minLevel = next
          await log("info", `log level set to "${minLevel}"`)
        } else if (cfg.logLevel.toLowerCase() !== minLevel) {
          await log("warn", `unknown log level "${cfg.logLevel}", keeping "${minLevel}"`)
        }
      }
    },

    "experimental.chat.system.transform": safe("chat.system.transform", async (input, output) => {
      const sessionID = input.sessionID ?? "default"
      const systemText = output.system.join("\n")
      if (systemText) {
        const truncatedSystem = truncate(systemText, ctx.maxContentSize)
        setBoundedMap(ctx.pendingSystemPrompts, sessionID, truncatedSystem)
        await log("debug", "otel: system prompt captured", { sessionID, length: systemText.length })
      }
    }),

    "chat.message": safe("chat.message", async (input, output) => {
      const promptLength = output.parts.reduce(
        (acc, p) => (p.type === "text" ? acc + p.text.length : acc),
        0,
      )
      const promptText = output.parts
        .filter(p => p.type === "text")
        .map(p => (p as { type: "text"; text: string }).text)
        .join("\n")
      const truncatedPrompt = truncate(promptText, ctx.maxContentSize)
      setBoundedMap(ctx.pendingUserPrompts, input.sessionID, truncatedPrompt)
      const agentMeta = (() => {
        const rawAgent = input.agent as unknown
        if (typeof rawAgent === "string") {
          return { id: rawAgent, name: rawAgent, description: undefined }
        }
        if (rawAgent && typeof rawAgent === "object") {
          const obj = rawAgent as Record<string, unknown>
          const id = typeof obj.id === "string" ? obj.id : undefined
          const name = typeof obj.name === "string"
            ? obj.name
            : (typeof obj.agentName === "string" ? obj.agentName : undefined)
          const description = typeof obj.description === "string"
            ? obj.description
            : (typeof obj.prompt === "string" ? obj.prompt : undefined)
          return { id, name, description }
        }
        return { id: undefined, name: undefined, description: undefined }
      })()
      setBoundedMap(ctx.sessionAgentMeta, input.sessionID, agentMeta)
      if (isTraceEnabled(ctx) && ctx.tracer) {
        const previous = ctx.activeInvocations.get(input.sessionID)
        if (previous) {
          // Close any lingering step span from the previous invocation
          const prevStep = ctx.activeStepSpans.get(input.sessionID)
          if (prevStep) {
            prevStep.span.setStatus({ code: SpanStatusCode.OK })
            prevStep.span.end()
            ctx.activeStepSpans.delete(input.sessionID)
          }
          previous.agentSpan.setStatus({ code: SpanStatusCode.OK })
          previous.agentSpan.end()
          previous.entrySpan.setStatus({ code: SpanStatusCode.OK })
          previous.entrySpan.end()
          ctx.activeInvocations.delete(input.sessionID)
        }
        const nextSeq = (ctx.sessionInvocationSeq.get(input.sessionID) ?? 0) + 1
        ctx.sessionInvocationSeq.set(input.sessionID, nextSeq)
        const invocationID = `${input.sessionID}:${nextSeq}`
        const entrySpan = startChildSpan(
          ctx.tracer,
          genAiSpanName("enter"),
          genAiSpanAttrs("ENTRY", "enter", input.sessionID, ctx.commonAttrs),
        )
        const agentName = agentMeta.name ?? "opencode-agent"
        const agentAttrs: Record<string, string> = { "gen_ai.agent.name": agentName }
        if (agentMeta.id) agentAttrs["gen_ai.agent.id"] = agentMeta.id
        if (agentMeta.description) agentAttrs["gen_ai.agent.description"] = agentMeta.description
        const agentSpan = startChildSpan(
          ctx.tracer,
          genAiSpanName("invoke_agent", agentName),
          genAiSpanAttrs("AGENT", "invoke_agent", input.sessionID, ctx.commonAttrs, agentAttrs),
          entrySpan.spanContext(),
        )
        const inputMsg = JSON.stringify([{ role: "user", parts: [{ type: "text", content: truncatedPrompt }] }])
        entrySpan.setAttribute("gen_ai.input.messages", inputMsg)
        agentSpan.setAttribute("gen_ai.input.messages", inputMsg)
        setBoundedMap(ctx.activeInvocations, input.sessionID, {
          invocationID,
          sessionID: input.sessionID,
          requestSeq: nextSeq,
          entrySpan,
          entryContext: entrySpan.spanContext(),
          agentSpan,
          agentContext: agentSpan.spanContext(),
          nextStepRound: 1,
          inputSet: true,
          entryStartTime: Date.now(),
        })
        ctx.sessionHistory.set(input.sessionID, [])
      }
      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        timestamp: Date.now(),
        observedTimestamp: Date.now(),
        body: "user_prompt",
        attributes: {
          "event.name": "user_prompt",
          "session.id": input.sessionID,
          agent: input.agent ?? "unknown",
          prompt_length: promptLength,
          model: input.model
            ? `${input.model.providerID}/${input.model.modelID}`
            : "unknown",
          ...commonAttrs,
        },
      })
    }),

    event: safe("event", async ({ event }) => {
      switch (event.type) {
        case "session.created":
          await handleSessionCreated(event as EventSessionCreated, ctx)
          break
        case "session.idle":
          await handleSessionIdle(event as EventSessionIdle, ctx)
          break
        case "session.error":
          handleSessionError(event as EventSessionError, ctx)
          break
        case "session.status":
          handleSessionStatus(event as EventSessionStatus, ctx)
          break
        case "session.diff":
          handleSessionDiff(event as EventSessionDiff, ctx)
          break
        case "command.executed":
          handleCommandExecuted(event as EventCommandExecuted, ctx)
          break
        case "permission.updated":
          handlePermissionUpdated(event as EventPermissionUpdated, ctx)
          break
        case "permission.replied":
          handlePermissionReplied(event as EventPermissionReplied, ctx)
          break
        case "message.updated":
          await handleMessageUpdated(event as EventMessageUpdated, ctx)
          break
        case "message.part.updated":
          await handleMessagePartUpdated(event as EventMessagePartUpdated, ctx)
          break
      }
    }),
    // Stub: opencode TUI worker accesses plugin.auth without null-check
    auth: {
      provider: "loongsuite-opentelemetry",
      methods: [],
    } as AuthHook,
  }
}

/** PluginModule entry point — opencode looks for `server` export */
export const server = OtelPlugin

/** Module-level auth stub — opencode server loader accesses module.auth */
export const auth = {
  provider: "loongsuite-opentelemetry",
  methods: [],
} as AuthHook
