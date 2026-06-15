// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { ArmsExporter } from "./arms-exporter.js";
import type {
  AfterToolCallEvent,
  AgentEndEvent,
  ArmsTraceConfig,
  BeforeAgentStartEvent,
  BeforeToolCallEvent,
  GatewayStartEvent,
  LlmInputEvent,
  LlmOutputEvent,
  MessageReceivedEvent,
  MessageSendingEvent,
  MessageSentEvent,
  OpenClawPlugin,
  OpenClawPluginApi,
  PluginHookContext,
  SessionEndEvent,
  SessionStartEvent,
  SpanData,
} from "./types.js";
import { PLUGIN_VERSION } from "./version.js";
import {
  buildLlmInvocation,
  buildToolInvocation,
  buildEntryInvocation,
  buildAgentInvocation,
  buildStepInvocation,
  type OpenclawContext,
} from "./invocation-builder.js";
import type { ReactStepInvocation, InvokeAgentInvocation, EntryInvocation } from "@loongsuite/opentelemetry-util-genai";
import {
  compatSerializeMessages,
  compatFinishReasons,
  compatSpanKindDialect,
} from "./invocation-compat.js";
import { ExtendedTelemetryHandler } from "@loongsuite/opentelemetry-util-genai";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  getRemoteParentContext,
  updatePropagationStore,
  installPropagation,
  uninstallPropagation,
  extractOtelFromContent,
} from "./trace-propagation.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_SESSION_ID,
  GEN_AI_REACT_ROUND,
  GEN_AI_REACT_FINISH_REASON,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_TYPE,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  ERROR_TYPE,
} from "@loongsuite/opentelemetry-util-genai";
import { JsonlEmitter, readSharedOtelConfig } from "./jsonl-emitter.js";
import { registerJsonlHooks } from "./jsonl-hooks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum age (ms) for the lastUserTraceContext fallback when linking an
 * agent-channel hook back to the originating user context.  If the gap
 * between message_received and before_agent_start exceeds this window the
 * plugin creates a new trace instead of joining the existing one.
 */
const CONTEXT_LINK_TIMEOUT_MS = 3_000;

/** Stale context entries older than this (ms) are removed periodically. */
const CONTEXT_MAX_AGE_MS = 20 * 60 * 1_000; // 20 minutes

/** How often (ms) the stale-context sweeper runs. */
const CONTEXT_SWEEP_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes
const TEMP_RUN_ID_PREFIX = "run-";
const PENDING_ASSISTANT_TTL_MS = 15_000;
const CANONICAL_PLUGIN_ID = "opentelemetry-instrumentation-openclaw";
const LEGACY_PLUGIN_ID = "openclaw-cms-plugin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseKeyValueEnv(envName: string): Record<string, string> | undefined {
  const raw = process.env[envName];
  if (!raw) return undefined;
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      result[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function generateId(length = 16): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function safeClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

const MAX_ATTR_LENGTH = 3_200_000;

function truncateAttr(value: string): string {
  return value.length > MAX_ATTR_LENGTH
    ? value.substring(0, MAX_ATTR_LENGTH)
    : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getPluginEntryConfig(apiConfig: Record<string, unknown>, pluginId: string): Record<string, unknown> | undefined {
  const plugins = asRecord(apiConfig.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.[pluginId]);
  return asRecord(entry?.config);
}

function mergeDefinedValues(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function formatOutputMessages(assistantTexts: string[], finishReason = "stop"): string {
  return truncateAttr(
    JSON.stringify(
      assistantTexts.map((text) => ({
        role: "assistant",
        parts: [{ type: "text", content: text }],
        finish_reason: finishReason,
      })),
    ),
  );
}

function normalizeChannelId(input: string | undefined): string {
  if (!input || input === "unknown") return "system/unknown";
  if (input.includes("/")) return input;
  if (/^agent[_:]/.test(input)) return `agent/${input.slice(6)}`;
  return `system/${input}`;
}

function resolveChannelId(
  ctx: PluginHookContext,
  eventFrom?: string,
): string {
  const raw =
    (ctx.sessionKey as string)
    || ctx.channelId
    || ctx.conversationId
    || eventFrom
    || "unknown";
  return normalizeChannelId(raw);
}

type PendingToolCall = {
  runId?: string;
  toolName: string;
  toolCallId: string;
  toolSpanId: string;
  toolStartTime: number;
  toolInput: unknown;
  traceContext: TraceContext;
  channelId: string;
  createdAt: number;
};

type AssistantToolCall = {
  id: string;
  name?: string;
};

type LlmUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type BeforeMessageWriteEvent = {
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
    stopReason?: string;
    usage?: LlmUsage;
  };
};

function resolveOptionalRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveOptionalToolCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildPendingToolCallKey(toolCallId: string, runId?: string): string {
  return runId ? `${runId}:${toolCallId}` : toolCallId;
}

function extractAssistantToolCalls(content: unknown): AssistantToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: AssistantToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (
      (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall")
      && typeof rec.id === "string"
      && rec.id
    ) {
      calls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return calls;
}

function extractAssistantTexts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; text?: unknown; content?: unknown };
    if (rec.type === "text") {
      if (typeof rec.text === "string" && rec.text) {
        texts.push(rec.text);
      } else if (typeof rec.content === "string" && rec.content) {
        texts.push(rec.content);
      }
    }
  }
  return texts;
}

function countToolCallsFromMessages(messages: unknown[] | undefined): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }
  let total = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const rec = msg as { role?: unknown; content?: unknown };
    if (rec.role !== "assistant" || !Array.isArray(rec.content)) {
      continue;
    }
    for (const block of rec.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const typed = block as { type?: unknown };
      if (
        typed.type === "toolCall"
        || typed.type === "toolUse"
        || typed.type === "functionCall"
      ) {
        total += 1;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Per-session trace context
// ---------------------------------------------------------------------------

interface TraceContext {
  traceId: string;
  rootSpanId: string;
  runId: string;
  turnId: string;
  channelId: string;
  originalChannelId?: string;
  sessionId?: string;

  createdAt: number;

  userInput?: unknown;
  lastOutput?: unknown;
  rootSpanStartTime?: number;
  entryInvocation?: EntryInvocation;

  llmProvider?: string;
  llmModel?: string;
  llmPendingStartTime?: number;
  llmPendingSpanId?: string;
  llmPendingRawSystemPrompt?: string;
  llmPendingRawInputHistory?: Array<{ role: string; content: unknown }>;
  llmPendingRawUserPrompt?: string;
  llmLastRawInputHistory?: Array<{ role: string; content: unknown }>;
  llmLastRawUserPrompt?: string;
  llmLastAssistantContent?: unknown;
  llmPendingToolResultsForNextInput: Array<{ role: string; content: unknown }>;
  llmPendingToolCallIds: Set<string>;
  llmPendingToolCallCountFallback: number;
  llmSegmentCount: number;
  lastLlmUsage?: LlmUsage;
  lastLlmEndTime?: number;
  stepSpanId?: string;
  stepStartTime?: number;
  stepInvocation?: ReactStepInvocation;
  stepRoundCounter: number;
  stepCurrentRound?: number;
  stepAwaitingToolResults: boolean;

  customAttributes?: Record<string, string | number | boolean>;

  agentStartTime?: number;
  agentSpanId?: string;
  agentInvocation?: InvokeAgentInvocation;
  hasSeenLlmInput?: boolean;
  isClosing?: boolean;
}

type PendingAssistantMessage = {
  message: NonNullable<BeforeMessageWriteEvent["message"]>;
  createdAt: number;
};

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

const armsTracePlugin: OpenClawPlugin = {
  id: CANONICAL_PLUGIN_ID,
  name: "OpenClaw CMS Plugin",
  version: PLUGIN_VERSION,
  description:
    "Report OpenClaw AI agent execution traces to Alibaba Cloud CMS via OpenTelemetry",

  activate(api: OpenClawPluginApi) {
    const pluginConfig = asRecord(api.pluginConfig) || {};
    const legacyConfig = getPluginEntryConfig(api.config, LEGACY_PLUGIN_ID);
    // Shared otel-config.json is the pilot integration contract: pilot installer
    // writes log_dir/log_enabled there; users may also place their own settings.
    // Priority: pluginConfig (openclaw.json plugins.entries) > otel-config.json > env > default.
    const sharedOtelConfig = readSharedOtelConfig("~/.openclaw/otel-config.json");
    const resolvedConfig = mergeDefinedValues(
      mergeDefinedValues(legacyConfig || {}, sharedOtelConfig),
      pluginConfig,
    );
    const endpoint = pluginConfig.endpoint as string | undefined;
    const endpointResolved = resolvedConfig.endpoint as string | undefined;

    // Build headers: config file takes priority, fall back to env vars
    const configHeaders = resolvedConfig.headers as Record<string, string> | undefined;
    const headers: Record<string, string> = configHeaders ? { ...configHeaders } : {};
    if (!headers["x-arms-license-key"] && process.env.ARMS_LICENSE_KEY) {
      headers["x-arms-license-key"] = process.env.ARMS_LICENSE_KEY;
    }
    if (!headers["x-arms-project"] && process.env.ARMS_PROJECT) {
      headers["x-arms-project"] = process.env.ARMS_PROJECT;
    }
    if (!headers["x-cms-workspace"] && process.env.ARMS_CMS_WORKSPACE) {
      headers["x-cms-workspace"] = process.env.ARMS_CMS_WORKSPACE;
    }

    // Resolve endpoint: config > env > undefined
    const finalEndpoint = endpointResolved || process.env.ARMS_OTLP_ENDPOINT || "";

    if (!endpoint && finalEndpoint && legacyConfig) {
      api.logger.warn(
        `[ArmsTrace] Using legacy '${LEGACY_PLUGIN_ID}' configuration fallback. Please migrate to '${CANONICAL_PLUGIN_ID}'.`,
      );
    }

    // Resolve JSONL emission settings (independent of OTLP).
    const finalLogEnabled =
      (resolvedConfig.log_enabled as boolean | undefined) ??
      (process.env.OPENCLAW_LOG_ENABLED === "true"
        || process.env.OPENCLAW_LOG_ENABLED === "1"
        || false);
    const finalLogDir =
      (resolvedConfig.log_dir as string | undefined)
      || process.env.OPENCLAW_LOG_DIR
      || "";
    const finalLogFilenameFormat =
      ((resolvedConfig.log_filename_format as string | undefined) === "hook"
        ? "hook"
        : "hook") as "hook";
    const finalCaptureMessageContent =
      (resolvedConfig.captureMessageContent as boolean | undefined)
      || process.env.OPENCLAW_CAPTURE_MESSAGE_CONTENT === "true"
      || process.env.OPENCLAW_CAPTURE_MESSAGE_CONTENT === "1"
      || false;

    if (!finalEndpoint && !finalLogEnabled) {
      api.logger.error(
        "[ArmsTrace] Missing required configuration: at least one of 'endpoint' (OTLP) or 'log_enabled' (JSONL for pilot) must be provided",
      );
      return;
    }

    // JSONL-only mode: register JSONL hook listeners and skip OTLP setup.
    if (!finalEndpoint && finalLogEnabled) {
      if (!finalLogDir) {
        api.logger.error(
          "[ArmsTrace] log_enabled=true but 'log_dir' is missing (config or OPENCLAW_LOG_DIR env)",
        );
        return;
      }
      const finalDebugJsonlOnly =
        (resolvedConfig.debug as boolean | undefined)
        || process.env.OPENCLAW_TELEMETRY_DEBUG === "true"
        || process.env.OPENCLAW_TELEMETRY_DEBUG === "1"
        || false;
      const jsonlOnlyEmitter = new JsonlEmitter({
        logDir: finalLogDir,
        filenameFormat: finalLogFilenameFormat,
        captureMessageContent: finalCaptureMessageContent,
        logger: api.logger,
      });
      const enabledHooksList = resolvedConfig.enabledHooks as string[] | undefined;
      const disposeJsonlHooks = registerJsonlHooks(api, jsonlOnlyEmitter, {
        enabledHooks: enabledHooksList,
        debug: finalDebugJsonlOnly,
      });
      api.on("gateway_stop", () => {
        try { disposeJsonlHooks(); } catch { /* ignore */ }
      });
      api.logger.info(
        `[ArmsTrace] Plugin activated in JSONL-only mode (log_dir: ${finalLogDir})`,
      );
      return;
    }

    // Resolve remaining fields: config > env > default
    const finalServiceName =
      (resolvedConfig.serviceName as string) ||
      process.env.ARMS_SERVICE_NAME ||
      process.env.OTEL_SERVICE_NAME ||
      "openclaw-agent";
    const finalDebug =
      (resolvedConfig.debug as boolean) ||
      process.env.ARMS_TRACE_DEBUG === "true" ||
      process.env.ARMS_TRACE_DEBUG === "1" ||
      false;
    const finalEnablePropagation =
      (resolvedConfig.enableTracePropagation as boolean) ||
      process.env.ARMS_ENABLE_TRACE_PROPAGATION === "true" ||
      process.env.ARMS_ENABLE_TRACE_PROPAGATION === "1" ||
      false;

    const envResourceAttrs = parseKeyValueEnv("OTEL_RESOURCE_ATTRIBUTES");
    const configResourceAttrs = resolvedConfig.resourceAttributes as Record<string, string> | undefined;
    const finalResourceAttributes =
      envResourceAttrs || configResourceAttrs
        ? { ...envResourceAttrs, ...configResourceAttrs }
        : undefined;

    const envSpanAttrs = parseKeyValueEnv("OTEL_SPAN_ATTRIBUTES");
    const configSpanAttrs = resolvedConfig.globalSpanAttributes as Record<string, string | number | boolean> | undefined;
    const finalGlobalSpanAttributes =
      envSpanAttrs || configSpanAttrs
        ? { ...envSpanAttrs, ...configSpanAttrs }
        : undefined;

    const config: ArmsTraceConfig = {
      endpoint: finalEndpoint,
      headers,
      serviceName: finalServiceName,
      debug: finalDebug,
      batchSize: (resolvedConfig.batchSize as number) || 10,
      flushIntervalMs: (resolvedConfig.flushIntervalMs as number) || 5000,
      enabledHooks: resolvedConfig.enabledHooks as string[] | undefined,
      enableTracePropagation: finalEnablePropagation,
      propagationTargetUrls: resolvedConfig.propagationTargetUrls as string[] | undefined,
      resourceAttributes: finalResourceAttributes,
      globalSpanAttributes: finalGlobalSpanAttributes,
    };

    const exporter = new ArmsExporter(api, config);

    // Dual-mode: when log_enabled is true alongside OTLP, register a parallel
    // JSONL hook-listener set so pilot can ingest event-level JSONL while
    // OTLP traces go to the configured backend.
    let disposeJsonlInDualMode: (() => void) | null = null;
    if (finalLogEnabled) {
      if (finalLogDir) {
        const dualModeEmitter = new JsonlEmitter({
          logDir: finalLogDir,
          filenameFormat: finalLogFilenameFormat,
          captureMessageContent: finalCaptureMessageContent,
          logger: api.logger,
        });
        disposeJsonlInDualMode = registerJsonlHooks(api, dualModeEmitter, {
          enabledHooks: config.enabledHooks,
          debug: config.debug,
        });
        api.logger.info(
          `[ArmsTrace] JSONL emission enabled (log_dir: ${finalLogDir})`,
        );
      } else {
        api.logger.warn(
          "[ArmsTrace] log_enabled=true but log_dir is missing; JSONL emission disabled",
        );
      }
    }

    if (config.enableTracePropagation) {
      installPropagation({
        targetUrls: config.propagationTargetUrls,
        excludeUrl: config.endpoint,
      });
    }

    let handler: ExtendedTelemetryHandler | null = null;
    const ensureHandler = async (): Promise<ExtendedTelemetryHandler> => {
      if (handler) return handler;
      await exporter.ensureInitialized();
      const tracerProvider = exporter.getTracerProvider();
      handler = new ExtendedTelemetryHandler({
        tracerProvider: tracerProvider || undefined,
        instrumentationName: "opentelemetry-instrumentation-openclaw",
        instrumentationVersion: PLUGIN_VERSION,
      });
      return handler;
    };

    // -- Trace context management -------------------------------------------

    const contextByChannelId = new Map<string, TraceContext>();
    const contextByRunId = new Map<string, TraceContext>();
    const contextsByChannelId = new Map<string, Set<TraceContext>>();
    const activeContextByAgentChannel = new Map<string, TraceContext>();
    const pendingToolCalls = new Map<string, PendingToolCall>();
    const traceTaskQueueByTraceId = new Map<string, Promise<void>>();
    const pendingAssistantByTraceId = new Map<string, PendingAssistantMessage>();

    let lastUserChannelId: string | undefined;
    let lastUserTraceContext: TraceContext | undefined;
    let lastUserContextSetAt: number | undefined;
    const openclawVersion: string = api.runtime?.version || "unknown";

    const sweepStaleContexts = () => {
      const now = Date.now();
      for (const [key, ctx] of contextByChannelId) {
        if (now - ctx.createdAt > CONTEXT_MAX_AGE_MS) {
          contextByChannelId.delete(key);
          contextByRunId.delete(ctx.runId);
        }
      }
      for (const [key, pending] of pendingToolCalls) {
        if (now - pending.createdAt > CONTEXT_MAX_AGE_MS) {
          pendingToolCalls.delete(key);
        }
      }
      for (const [traceId, pending] of pendingAssistantByTraceId) {
        if (now - pending.createdAt > PENDING_ASSISTANT_TTL_MS) {
          pendingAssistantByTraceId.delete(traceId);
          if (config.debug) {
            api.logger.warn(
              `[ArmsTrace] Dropped stale pending assistant message: traceId=${traceId}`,
            );
          }
        }
      }
    };
    const contextSweepTimer = setInterval(sweepStaleContexts, CONTEXT_SWEEP_INTERVAL_MS);
    contextSweepTimer.unref();

    const shouldHookEnabled = (hookName: string): boolean => {
      if (!config.enabledHooks) return true;
      return config.enabledHooks.includes(hookName);
    };

    const cleanupPendingToolCallsForRun = (runId: string | undefined) => {
      if (!runId) {
        return;
      }
      const prefix = `${runId}:`;
      for (const key of pendingToolCalls.keys()) {
        if (key.startsWith(prefix)) {
          pendingToolCalls.delete(key);
        }
      }
    };

    const isTemporaryRunId = (runId: string): boolean => runId.startsWith(TEMP_RUN_ID_PREFIX);

    const movePendingToolCallsRunBinding = (fromRunId: string, toRunId: string) => {
      for (const [key, pending] of pendingToolCalls) {
        if (pending.runId !== fromRunId) {
          continue;
        }
        pendingToolCalls.delete(key);
        pending.runId = toRunId;
        pendingToolCalls.set(buildPendingToolCallKey(pending.toolCallId, toRunId), pending);
      }
    };

    const bindRealRunId = (ctx: TraceContext, runId: string, hookName: string) => {
      const realRunId = resolveOptionalRunId(runId);
      if (!realRunId || ctx.runId === realRunId) {
        return;
      }
      const existing = contextByRunId.get(realRunId);
      if (existing && existing !== ctx) {
        if (config.debug) {
          api.logger.warn(
            `[ArmsTrace] Skip runId rebind due to existing mapping: hook=${hookName}, oldRunId=${ctx.runId}, realRunId=${realRunId}`,
          );
        }
        return;
      }
      const oldRunId = ctx.runId;
      if (!isTemporaryRunId(oldRunId)) {
        if (config.debug) {
          api.logger.warn(
            `[ArmsTrace] Skip runId rebind because current runId is already stable: hook=${hookName}, runId=${oldRunId}, incoming=${realRunId}`,
          );
        }
        return;
      }
      if (contextByRunId.get(oldRunId) === ctx) {
        contextByRunId.delete(oldRunId);
      }
      ctx.runId = realRunId;
      ctx.turnId = realRunId;
      contextByRunId.set(realRunId, ctx);
      movePendingToolCallsRunBinding(oldRunId, realRunId);
      const rebindAttrs = {
        "openclaw.run.id": realRunId,
        "openclaw.turn.id": realRunId,
      };
      exporter.patchOpenSpanAttributes(ctx.rootSpanId, rebindAttrs);
      // Sync invocation.attributes for handler-managed spans to prevent
      // applyXxxFinishAttributes from overwriting realRunId back to the
      // temporary value when the span is stopped.
      if (ctx.entryInvocation) {
        if (!ctx.entryInvocation.attributes) ctx.entryInvocation.attributes = {};
        Object.assign(ctx.entryInvocation.attributes, rebindAttrs);
      }
      if (ctx.agentSpanId) {
        exporter.patchOpenSpanAttributes(ctx.agentSpanId, rebindAttrs);
        if (ctx.agentInvocation) {
          if (!ctx.agentInvocation.attributes) ctx.agentInvocation.attributes = {};
          Object.assign(ctx.agentInvocation.attributes, rebindAttrs);
        }
      }
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Rebound temporary runId: hook=${hookName}, oldRunId=${oldRunId}, realRunId=${realRunId}`,
        );
      }
    };

    const enqueueTraceTask = (
      traceId: string,
      task: () => Promise<void>,
    ): Promise<void> => {
      const prev = traceTaskQueueByTraceId.get(traceId) || Promise.resolve();
      const next = prev.catch(() => undefined).then(task);
      let tracked: Promise<void>;
      tracked = next.finally(() => {
        if (traceTaskQueueByTraceId.get(traceId) === tracked) {
          traceTaskQueueByTraceId.delete(traceId);
        }
      });
      traceTaskQueueByTraceId.set(traceId, tracked);
      return tracked;
    };

    const clearPendingAssistantForTrace = (traceId: string | undefined) => {
      if (!traceId) {
        return;
      }
      pendingAssistantByTraceId.delete(traceId);
    };

    const drainTraceTasks = async (traceId: string | undefined): Promise<void> => {
      if (!traceId) {
        return;
      }
      const pending = traceTaskQueueByTraceId.get(traceId);
      if (!pending) {
        return;
      }
      try {
        await pending;
      } catch {
        // already logged at task site
      }
    };

    const consumePendingToolCall = (event: AfterToolCallEvent): PendingToolCall | undefined => {
      const eventRunId = resolveOptionalRunId(event.runId);
      const eventToolCallId = resolveOptionalToolCallId(event.toolCallId);

      if (eventToolCallId) {
        const directKeys = [
          buildPendingToolCallKey(eventToolCallId, eventRunId),
          buildPendingToolCallKey(eventToolCallId, undefined),
        ];
        for (const key of directKeys) {
          const direct = pendingToolCalls.get(key);
          if (direct) {
            pendingToolCalls.delete(key);
            return direct;
          }
        }
      }

      let fallbackKey: string | undefined;
      let fallback: PendingToolCall | undefined;
      for (const [key, pending] of pendingToolCalls) {
        if (pending.toolName !== event.toolName) {
          continue;
        }
        if (eventRunId && pending.runId && pending.runId !== eventRunId) {
          continue;
        }
        if (!fallback || pending.toolStartTime > fallback.toolStartTime) {
          fallback = pending;
          fallbackKey = key;
        }
      }
      if (fallback && fallbackKey) {
        pendingToolCalls.delete(fallbackKey);
        if (config.debug) {
          api.logger.warn(
            `[ArmsTrace] Tool call fallback match used: tool=${event.toolName}, runId=${eventRunId || "-"}, eventToolCallId=${eventToolCallId || "-"}`,
          );
        }
      }
      return fallback;
    };

    const registerChannelContext = (channelId: string, ctx: TraceContext) => {
      let set = contextsByChannelId.get(channelId);
      if (!set) {
        set = new Set<TraceContext>();
        contextsByChannelId.set(channelId, set);
      }
      set.add(ctx);
    };

    const unregisterChannelContext = (channelId: string, ctx: TraceContext) => {
      const set = contextsByChannelId.get(channelId);
      if (!set) {
        return;
      }
      set.delete(ctx);
      if (set.size === 0) {
        contextsByChannelId.delete(channelId);
      }
    };

    const mapContextToChannel = (channelId: string, ctx: TraceContext) => {
      contextByChannelId.set(channelId, ctx);
      registerChannelContext(channelId, ctx);
    };

    const unmapContextFromChannelIfMatches = (channelId: string, ctx: TraceContext) => {
      if (contextByChannelId.get(channelId) === ctx) {
        contextByChannelId.delete(channelId);
      }
      unregisterChannelContext(channelId, ctx);
    };

    const cleanupContextIdentity = (ctx: TraceContext) => {
      if (contextByRunId.get(ctx.runId) === ctx) {
        contextByRunId.delete(ctx.runId);
      }
      for (const [channelId, mapped] of contextByChannelId) {
        if (mapped === ctx) {
          contextByChannelId.delete(channelId);
        }
      }
      for (const [channelId, set] of contextsByChannelId) {
        if (set.has(ctx)) {
          set.delete(ctx);
          if (set.size === 0) {
            contextsByChannelId.delete(channelId);
          }
        }
      }
      for (const [agentChannelId, mapped] of activeContextByAgentChannel) {
        if (mapped === ctx) {
          activeContextByAgentChannel.delete(agentChannelId);
        }
      }
      clearPendingAssistantForTrace(ctx.traceId);
    };

    const getContextByChannel = (channelId: string) =>
      contextByChannelId.get(channelId);

    const getContextByRun = (runId: string) => contextByRunId.get(runId);

    const getOriginalChannelId = (runId: string) => {
      const ctx = contextByRunId.get(runId);
      return ctx?.originalChannelId || ctx?.channelId;
    };

    const startTurn = (
      runId: string,
      channelId: string,
      originalChannelId?: string,
    ): TraceContext => {
      const traceId = generateId(32);
      const ctx: TraceContext = {
        traceId,
        rootSpanId: generateId(16),
        runId,
        turnId: runId,
        channelId,
        originalChannelId: originalChannelId || channelId,
        createdAt: Date.now(),
        llmPendingToolCallIds: new Set<string>(),
        llmPendingToolResultsForNextInput: [],
        llmPendingToolCallCountFallback: 0,
        llmSegmentCount: 0,
        stepRoundCounter: 0,
        stepAwaitingToolResults: false,
      };
      mapContextToChannel(channelId, ctx);
      contextByRunId.set(runId, ctx);
      return ctx;
    };

    const endTurn = (channelId: string) => {
      const ctx = contextByChannelId.get(channelId);
      if (ctx) {
        unmapContextFromChannelIfMatches(channelId, ctx);
        if (contextByRunId.get(ctx.runId) === ctx) {
          contextByRunId.delete(ctx.runId);
        }
      }
    };

    const pickAgentEndContext = (channelId: string, fallback?: TraceContext): TraceContext | undefined => {
      const set = contextsByChannelId.get(channelId);
      if (!set || set.size === 0) {
        return fallback;
      }
      const candidates = Array.from(set).filter((ctx) => ctx.agentSpanId && !ctx.isClosing);
      if (candidates.length === 0) {
        return fallback || Array.from(set)[0];
      }
      candidates.sort((a, b) => (a.agentStartTime || a.createdAt) - (b.agentStartTime || b.createdAt));
      return candidates[0];
    };

    const getOrCreateContext = (
      rawChannelId: string,
      runId: string | undefined,
      hookName: string,
    ): { ctx: TraceContext; channelId: string; isNew: boolean } => {
      let channelId = rawChannelId;
      const agentChannelKey = rawChannelId.startsWith("agent/") ? rawChannelId : undefined;
      let activeCtx = agentChannelKey
        ? activeContextByAgentChannel.get(agentChannelKey) || getContextByChannel(rawChannelId)
        : getContextByChannel(rawChannelId);
      const resolvedIncomingRunId = resolveOptionalRunId(runId);
      let effectiveRunId = resolvedIncomingRunId || activeCtx?.runId || `run-${Date.now()}`;
      const canLinkRecentUserContext = () =>
        rawChannelId.startsWith("agent/")
        && Boolean(lastUserTraceContext)
        && Boolean(lastUserContextSetAt)
        && (Date.now() - (lastUserContextSetAt || 0)) < CONTEXT_LINK_TIMEOUT_MS;

      const linkRecentUserContext = () => {
        if (!lastUserTraceContext) {
          return undefined;
        }
        const linked = lastUserTraceContext;
        if (
          resolvedIncomingRunId
          && linked.runId !== resolvedIncomingRunId
          && !isTemporaryRunId(linked.runId)
        ) {
          // Incoming event already has a stable run id. Do not re-link to a
          // different stable user context, otherwise run attribution drifts.
          return undefined;
        }
        channelId = lastUserChannelId || channelId;
        mapContextToChannel(rawChannelId, linked);
        contextByRunId.set(effectiveRunId, linked);
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] LINKING agent to user context: hook=${hookName}, agentChannel=${rawChannelId}, userChannel=${channelId}, traceId=${linked.traceId}`,
          );
        }
        return linked;
      };

      if (rawChannelId.startsWith("agent/") && effectiveRunId) {
        const originalChannelId = getOriginalChannelId(effectiveRunId);
        if (originalChannelId) {
          channelId = originalChannelId;
          activeCtx =
            getContextByChannel(originalChannelId) || activeCtx;
        }
      }

      if (!activeCtx) {
        activeCtx = getContextByRun(effectiveRunId);
      }

      if (hookName === "agent_end" && !resolvedIncomingRunId) {
        activeCtx = pickAgentEndContext(channelId, activeCtx);
      }

      if (!activeCtx && canLinkRecentUserContext()) {
        activeCtx = linkRecentUserContext();
      }

      if (
        hookName === "message_received"
        && !rawChannelId.startsWith("agent/")
        && activeCtx
        && (activeCtx.agentSpanId || activeCtx.hasSeenLlmInput || activeCtx.isClosing)
      ) {
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] Rotating user context for new message: channelId=${channelId}, previousRunId=${activeCtx.runId}`,
          );
        }
        activeCtx = undefined;
        // Force a fresh temporary run id for the new turn. Without this reset
        // the newly created context may inherit the previous stable run id.
        if (!resolvedIncomingRunId) {
          effectiveRunId = `run-${Date.now()}`;
        }
      }

      if (
        activeCtx &&
        resolvedIncomingRunId &&
        activeCtx.runId !== resolvedIncomingRunId &&
        !isTemporaryRunId(activeCtx.runId)
      ) {
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] New stable run detected on active channel; creating fresh context: hook=${hookName}, channelId=${channelId}, oldRunId=${activeCtx.runId}, newRunId=${resolvedIncomingRunId}`,
          );
        }
        activeCtx = undefined;
        effectiveRunId = resolvedIncomingRunId;
      }

      if (
        activeCtx &&
        resolvedIncomingRunId &&
        isTemporaryRunId(activeCtx.runId)
      ) {
        const existingReal = contextByRunId.get(resolvedIncomingRunId);
        if (existingReal && existingReal !== activeCtx) {
          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] Switching temporary context to existing real run context: hook=${hookName}, channelId=${channelId}, tempRunId=${activeCtx.runId}, realRunId=${resolvedIncomingRunId}`,
            );
          }
          activeCtx = existingReal;
          mapContextToChannel(channelId, activeCtx);
        }
      }

      if (!activeCtx && canLinkRecentUserContext()) {
        activeCtx = linkRecentUserContext();
      }

      let isNew = false;
      if (!activeCtx) {
        activeCtx = startTurn(
          effectiveRunId,
          channelId,
          rawChannelId !== channelId ? rawChannelId : undefined,
        );
        isNew = true;
        if (config.debug) {
          api.logger.info(
            `[ArmsTrace] NEW TraceContext: hook=${hookName}, channelId=${channelId}, runId=${effectiveRunId}, traceId=${activeCtx.traceId}`,
          );
        }
      } else if (config.debug) {
        api.logger.info(
          `[ArmsTrace] REUSING TraceContext: hook=${hookName}, channelId=${channelId}, traceId=${activeCtx.traceId}`,
        );
      }
      if (agentChannelKey && activeCtx && !activeCtx.isClosing) {
        activeContextByAgentChannel.set(agentChannelKey, activeCtx);
      }
      if (activeCtx && runId) {
        bindRealRunId(activeCtx, runId, hookName);
      }
      return { ctx: activeCtx, channelId, isNew };
    };

    const createSpan = (
      ctx: TraceContext,
      channelId: string,
      name: string,
      type: SpanData["type"],
      startTime: number,
      endTime: number,
      attributes: Record<string, string | number | boolean> = {},
      input?: unknown,
      output?: unknown,
      parentSpanId?: string,
    ): SpanData => ({
      name,
      type,
      startTime,
      endTime,
      attributes: {
        ...attributes,
        ...config.globalSpanAttributes,
        ...ctx.customAttributes,
        "openclaw.version": openclawVersion,
        "openclaw.session.id": ctx.sessionId || channelId,
        [GEN_AI_SESSION_ID]: ctx.sessionId || channelId,
        "openclaw.run.id": ctx.runId,
        "openclaw.turn.id": ctx.turnId,
      },
      input,
      output,
      traceId: ctx.traceId,
      spanId: generateId(16),
      parentSpanId: parentSpanId || ctx.rootSpanId,
    });

    const resolveAgentFirstParentSpanId = (ctx: TraceContext): string =>
      ctx.agentSpanId || ctx.rootSpanId;

    const resolveStepFirstParentSpanId = (ctx: TraceContext): string =>
      ctx.stepSpanId || ctx.agentSpanId || ctx.rootSpanId;

    const makeOpenclawContext = (ctx: TraceContext, channelId: string): OpenclawContext => ({
      openclawVersion,
      sessionId: ctx.sessionId,
      channelId,
      runId: ctx.runId,
      turnId: ctx.turnId,
    });

    const exportPendingLlmSpan = async (
      ctx: TraceContext,
      channelId: string,
      params: {
        endTime: number;
        outputTexts: string[];
        outputContent?: unknown;
        stopReason?: string;
        usage?: LlmUsage;
      },
    ): Promise<void> => {
      const now = params.endTime || Date.now();
      const startTime = ctx.llmPendingStartTime || now;
      const safeEndTime = now < startTime ? startTime : now;
      if (safeEndTime !== now && config.debug) {
        api.logger.warn(
          `[ArmsTrace] Corrected negative LLM span duration: runId=${ctx.runId}, traceId=${ctx.traceId}, start=${startTime}, end=${now}`,
        );
      }
      const provider = ctx.llmProvider || "unknown";
      const model = ctx.llmModel || "unknown";
      const stopReason = params.stopReason || "stop";

      const inputTokens = params.usage?.input ?? 0;
      const outputTokens = params.usage?.output ?? 0;
      const cacheReadTokens = params.usage?.cacheRead ?? 0;
      const cacheCreationTokens = params.usage?.cacheWrite ?? 0;
      const totalTokens =
        params.usage?.total ?? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

      const effectiveHistory = ctx.llmPendingRawInputHistory ?? ctx.llmLastRawInputHistory ?? [];
      const effectiveUserPrompt = ctx.llmPendingRawUserPrompt ?? ctx.llmLastRawUserPrompt;

      const octx = makeOpenclawContext(ctx, channelId);
      const inv = buildLlmInvocation(octx, {
        provider,
        model,
        systemPrompt: ctx.llmPendingRawSystemPrompt,
        historyMessages: effectiveHistory,
        prompt: effectiveUserPrompt,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens,
        outputContent: params.outputContent,
        outputTexts: params.outputTexts,
        stopReason,
      });

      const msgAttrs = compatSerializeMessages(inv);
      for (const [key, value] of Object.entries(msgAttrs)) {
        if (value && inv.attributes) inv.attributes[key] = value;
      }

      const finishAttrs: Record<string, unknown> = {
        [GEN_AI_RESPONSE_FINISH_REASONS]: inv.finishReasons || [stopReason],
      };
      compatFinishReasons(finishAttrs);
      if (inv.attributes) {
        inv.attributes[GEN_AI_RESPONSE_FINISH_REASONS] = finishAttrs[GEN_AI_RESPONSE_FINISH_REASONS];
        inv.attributes[GEN_AI_USAGE_TOTAL_TOKENS] = totalTokens;
        inv.attributes["openclaw.version"] = openclawVersion;
        inv.attributes["openclaw.session.id"] = ctx.sessionId || channelId;
        inv.attributes[GEN_AI_SESSION_ID] = ctx.sessionId || channelId;
        inv.attributes["openclaw.run.id"] = ctx.runId;
        inv.attributes["openclaw.turn.id"] = ctx.turnId;
        if (config.globalSpanAttributes) {
          Object.assign(inv.attributes, config.globalSpanAttributes);
        }
        if (ctx.customAttributes) {
          Object.assign(inv.attributes, ctx.customAttributes);
        }
      }

      compatSpanKindDialect(inv, exporter.getSpanKindAttrName(), "LLM");

      const h = await ensureHandler();
      const parentCtx = exporter.resolveParentContextFor(resolveStepFirstParentSpanId(ctx));
      h.startLlm(inv, parentCtx, startTime);
      h.stopLlm(inv, safeEndTime);

      ctx.lastLlmEndTime =
        ctx.lastLlmEndTime && ctx.lastLlmEndTime > safeEndTime
          ? ctx.lastLlmEndTime
          : safeEndTime;
      ctx.llmPendingStartTime = undefined;
      ctx.llmPendingSpanId = undefined;
      ctx.llmPendingRawSystemPrompt = undefined;
      ctx.llmPendingRawInputHistory = undefined;
      ctx.llmPendingRawUserPrompt = undefined;
      ctx.llmSegmentCount += 1;

      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Exported segmented LLM span: ${provider}/${model}, duration=${safeEndTime - startTime}ms, reason=${stopReason}`,
        );
      }
    };

    const processAssistantMessageForContext = async (
      ctx: TraceContext,
      channelId: string,
      message: NonNullable<BeforeMessageWriteEvent["message"]>,
    ) => {
      const messageTs =
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? message.timestamp
          : Date.now();
      // Use hook processing time as the end boundary to avoid under-reporting
      // when message.timestamp is written earlier in the pipeline.
      const hookNow = Date.now();
      const llmEndTime = hookNow > messageTs ? hookNow : messageTs;
      const toolCalls = extractAssistantToolCalls(message.content);
      const outputTexts = extractAssistantTexts(message.content);
      const stopReason =
        typeof message.stopReason === "string"
          ? message.stopReason
          : (toolCalls.length > 0 ? "toolUse" : "stop");

      if (!ctx.llmPendingStartTime) {
        ctx.llmPendingStartTime = messageTs;
        ctx.llmPendingSpanId = generateId(16);
      }

      await exportPendingLlmSpan(ctx, channelId, {
        endTime: llmEndTime,
        outputTexts,
        outputContent: message.content,
        stopReason,
        usage: message.usage,
      });

      if (outputTexts.length > 0) {
        ctx.lastOutput = outputTexts.join("\n");
      }

      ctx.llmPendingToolCallIds.clear();
      ctx.llmPendingToolResultsForNextInput = [];
      ctx.llmLastAssistantContent = message.content;
      for (const call of toolCalls) {
        ctx.llmPendingToolCallIds.add(call.id);
      }
      ctx.llmPendingToolCallCountFallback =
        ctx.llmPendingToolCallIds.size > 0 ? 0 : toolCalls.length;
      ctx.stepAwaitingToolResults = toolCalls.length > 0;

      if (toolCalls.length === 0) {
        endStepSpan(ctx, messageTs, stopReason, channelId);
      }

      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Processed assistant message for segmented LLM: runId=${ctx.runId}, toolCalls=${toolCalls.length}, stopReason=${stopReason}`,
        );
      }
    };

    const ensureEntrySpan = async (
      ctx: TraceContext,
      channelId: string,
      options: { userId?: string; role?: string; from?: string } = {},
    ) => {
      if (ctx.rootSpanStartTime) return;
      const now = Date.now();
      ctx.rootSpanStartTime = now;
      const octx = makeOpenclawContext(ctx, channelId);
      const entryInv = buildEntryInvocation(octx, options);
      compatSpanKindDialect(entryInv, exporter.getSpanKindAttrName(), "ENTRY");

      const h = await ensureHandler();
      const remoteParentCtx = config.enableTracePropagation
        ? getRemoteParentContext()
        : undefined;
      h.startEntry(entryInv, remoteParentCtx, now);

      if (entryInv.span) {
        exporter.registerOpenSpan(ctx.rootSpanId, entryInv.span as import("@opentelemetry/api").Span);
        if (config.enableTracePropagation) {
          const actualTraceId = (entryInv.span as import("@opentelemetry/api").Span).spanContext().traceId;
          if (actualTraceId !== ctx.traceId) {
            const oldId = ctx.traceId;
            ctx.traceId = actualTraceId;
            const queued = traceTaskQueueByTraceId.get(oldId);
            if (queued) { traceTaskQueueByTraceId.delete(oldId); traceTaskQueueByTraceId.set(actualTraceId, queued); }
            const pendingAsst = pendingAssistantByTraceId.get(oldId);
            if (pendingAsst) { pendingAssistantByTraceId.delete(oldId); pendingAssistantByTraceId.set(actualTraceId, pendingAsst); }
          }
        }
      }
      ctx.entryInvocation = entryInv;
      if (config.globalSpanAttributes && entryInv.attributes) {
        Object.assign(entryInv.attributes, config.globalSpanAttributes);
      }
      if (ctx.customAttributes && entryInv.attributes) {
        Object.assign(entryInv.attributes, ctx.customAttributes);
      }

      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Started root span: traceId=${ctx.traceId}, spanId=${ctx.rootSpanId}`,
        );
      }
    };

    const ensureAgentSpan = async (
      ctx: TraceContext,
      channelId: string,
      agentId: string,
    ) => {
      if (ctx.agentSpanId) {
        return;
      }
      const now = Date.now();
      ctx.agentStartTime = now;
      ctx.agentSpanId = generateId(16);

      const octx = makeOpenclawContext(ctx, channelId);
      const agentInv = buildAgentInvocation(octx, agentId);
      compatSpanKindDialect(agentInv, exporter.getSpanKindAttrName(), "AGENT");

      const h = await ensureHandler();
      const parentCtx = exporter.resolveParentContextFor(ctx.rootSpanId);
      h.startInvokeAgent(agentInv, parentCtx, now);

      if (agentInv.span) {
        exporter.registerOpenSpan(ctx.agentSpanId, agentInv.span as import("@opentelemetry/api").Span);
      }
      ctx.agentInvocation = agentInv;
      if (config.globalSpanAttributes && agentInv.attributes) {
        Object.assign(agentInv.attributes, config.globalSpanAttributes);
      }
      if (ctx.customAttributes && agentInv.attributes) {
        Object.assign(agentInv.attributes, ctx.customAttributes);
      }
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Started agent span: ${agentId}, spanId=${ctx.agentSpanId}`,
        );
      }
    };

    const ensureStepSpan = async (
      ctx: TraceContext,
      channelId: string,
      startTime: number,
    ) => {
      if (ctx.stepSpanId) {
        return;
      }
      const round = ctx.stepRoundCounter + 1;
      const spanId = generateId(16);
      const octx = makeOpenclawContext(ctx, channelId);
      const stepInv = buildStepInvocation(octx, round);
      compatSpanKindDialect(stepInv, exporter.getSpanKindAttrName(), "STEP");

      const h = await ensureHandler();
      const parentCtx = exporter.resolveParentContextFor(resolveAgentFirstParentSpanId(ctx));
      h.startReactStep(stepInv, parentCtx, startTime);

      if (stepInv.span) {
        exporter.registerOpenSpan(spanId, stepInv.span as import("@opentelemetry/api").Span);
      }

      ctx.stepSpanId = spanId;
      ctx.stepStartTime = startTime;
      ctx.stepInvocation = stepInv;
      ctx.stepRoundCounter = round;
      ctx.stepCurrentRound = round;
      ctx.stepAwaitingToolResults = false;
      if (config.globalSpanAttributes && stepInv.attributes) {
        Object.assign(stepInv.attributes, config.globalSpanAttributes);
      }
      if (ctx.customAttributes && stepInv.attributes) {
        Object.assign(stepInv.attributes, ctx.customAttributes);
      }
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Started step span: round=${round}, spanId=${spanId}, runId=${ctx.runId}`,
        );
      }
    };

    const endStepSpan = (
      ctx: TraceContext,
      endTime: number,
      finishReason: string,
      _channelId: string,
    ) => {
      if (!ctx.stepSpanId) {
        return;
      }
      const stepSpanId = ctx.stepSpanId;
      const stepInv = ctx.stepInvocation;
      const stepRound = ctx.stepCurrentRound || ctx.stepRoundCounter || 1;
      // Guarantee step.endTime >= last child LLM.endTime so parent-child
      // timing constraints are preserved even when agent_end races with
      // the final before_message_write.
      const safeEndTime =
        ctx.lastLlmEndTime && ctx.lastLlmEndTime > endTime
          ? ctx.lastLlmEndTime
          : endTime;

      if (stepInv && handler) {
        stepInv.finishReason = finishReason || "stop";
        stepInv.round = stepRound;
        handler.stopReactStep(stepInv, safeEndTime);
      } else {
        const stepAttrs: Record<string, string | number | boolean> = {
          [GEN_AI_REACT_ROUND]: stepRound,
          [GEN_AI_REACT_FINISH_REASON]: finishReason || "stop",
          "openclaw.session.id": ctx.sessionId || _channelId,
          [GEN_AI_SESSION_ID]: ctx.sessionId || _channelId,
        };
        exporter.endSpanById(stepSpanId, safeEndTime, stepAttrs);
      }

      exporter.unregisterOpenSpan(stepSpanId);
      ctx.stepSpanId = undefined;
      ctx.stepStartTime = undefined;
      ctx.stepInvocation = undefined;
      ctx.stepCurrentRound = undefined;
      ctx.stepAwaitingToolResults = false;
      if (config.debug) {
        api.logger.info(
          `[ArmsTrace] Ended step span: round=${stepRound}, reason=${finishReason}, spanId=${stepSpanId}`,
        );
      }
    };

    // -- Hook: gateway_stop -------------------------------------------------

    api.on("gateway_stop", async () => {
      clearInterval(contextSweepTimer);
      if (config.enableTracePropagation) {
        uninstallPropagation();
      }
      const queuedTasks = Array.from(traceTaskQueueByTraceId.values());
      if (queuedTasks.length > 0) {
        await Promise.allSettled(queuedTasks);
      }
      pendingToolCalls.clear();
      pendingAssistantByTraceId.clear();
      if (disposeJsonlInDualMode) {
        try { disposeJsonlInDualMode(); } catch { /* ignore */ }
      }
      await exporter.dispose();
    });

    // -- Hook: gateway_start ------------------------------------------------

    if (shouldHookEnabled("gateway_start")) {
      api.on("gateway_start", async (event: GatewayStartEvent) => {
        const now = Date.now();
        const { ctx, channelId } = getOrCreateContext(
          "system/gateway",
          undefined,
          "gateway_start",
        );
        const span = createSpan(
          ctx,
          channelId,
          "gateway_start",
          "gateway",
          now,
          now,
          {
              "gateway.port": event.port,
          },
        );
        delete (span.attributes as Record<string, unknown>)["openclaw.session.id"];
        delete (span.attributes as Record<string, unknown>)[GEN_AI_SESSION_ID];
        await exporter.export(span);
      });
    }

    // -- Hook: session_start ------------------------------------------------

    if (shouldHookEnabled("session_start")) {
      api.on(
        "session_start",
        async (event: SessionStartEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "session_start",
          );
          const now = Date.now();
          const span = createSpan(
            ctx,
            channelId,
            "session_start",
            "session",
            now,
            now,
            { "event.type": "session_start" },
          );
          delete (span.attributes as Record<string, unknown>)[GEN_AI_SESSION_ID];
          if (event.sessionId) {
            span.attributes["openclaw.session.id"] = event.sessionId;
          }
          await exporter.export(span);
        },
      );
    }

    // -- Hook: session_end --------------------------------------------------

    if (shouldHookEnabled("session_end")) {
      api.on(
        "session_end",
        async (event: SessionEndEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx, event.sessionId);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "session_end",
          );
          const now = Date.now();
          const span = createSpan(
            ctx,
            channelId,
            "session_end",
            "session",
            now,
            now,
            {
              "session.duration_ms": event.durationMs || 0,
              "session.message_count": event.messageCount || 0,
              "session.total_tokens": ctx.lastLlmUsage?.total || 0,
            },
            undefined,
            {
              messageCount: event.messageCount,
              totalTokens: ctx.lastLlmUsage?.total,
            },
          );
          delete (span.attributes as Record<string, unknown>)[GEN_AI_SESSION_ID];
          if (event.sessionId) {
            span.attributes["openclaw.session.id"] = event.sessionId;
          }
          await exporter.export(span);
          endTurn(channelId);
        },
      );
    }

    // -- Hook: message_received ---------------------------------------------

    if (shouldHookEnabled("message_received")) {
      api.on(
        "message_received",
        async (
          event: MessageReceivedEvent,
          hookCtx: PluginHookContext,
        ) => {
          const rawChannelId = resolveChannelId(
            hookCtx,
            event.from || ((event.metadata as { senderId?: string } | undefined)?.senderId),
          );
          const { ctx, channelId, isNew } = getOrCreateContext(
            rawChannelId,
            undefined,
            "message_received",
          );
          const now = Date.now();
          const role = "user";

          // Extract trace context and custom attributes from message content
          // for both user messages and agent-channel WebSocket messages.
          // Content may embed <!--otel:{JSON}--> with traceparent and custom attrs.
          ctx.userInput = event.content;
          if (config.enableTracePropagation) {
            const otelPayload = extractOtelFromContent(event.content);
            if (otelPayload) {
              if (otelPayload.spanContext) {
                updatePropagationStore({
                  remoteParentContext: trace.setSpanContext(ROOT_CONTEXT, otelPayload.spanContext),
                });
              }
              if (otelPayload.customAttributes) {
                ctx.customAttributes = otelPayload.customAttributes;
              }
              ctx.userInput = otelPayload.cleanContent;
            }
          }

          const isUserMessage = !rawChannelId.startsWith("agent/");
          if (isUserMessage) {
            lastUserChannelId = channelId;
            lastUserTraceContext = ctx;
            lastUserContextSetAt = Date.now();
          }

          await ensureEntrySpan(ctx, channelId, {
            userId: event.from || ((event.metadata as { senderId?: string } | undefined)?.senderId),
            role,
            from: event.from,
          });

        },
      );
    }

    // -- Hook: message_sending ----------------------------------------------

    if (shouldHookEnabled("message_sending")) {
      api.on(
        "message_sending",
        async (event: MessageSendingEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx, event.to);
          const { ctx } = getOrCreateContext(
            rawChannelId,
            undefined,
            "message_sending",
          );
          ctx.lastOutput = event.content;
        },
      );
    }

    // -- Hook: message_sent -------------------------------------------------

    if (shouldHookEnabled("message_sent")) {
      api.on(
        "message_sent",
        async (event: MessageSentEvent, hookCtx: PluginHookContext) => {
          if (event.content && event.success) {
            const rawChannelId = resolveChannelId(hookCtx, event.to);
            const { ctx } = getOrCreateContext(
              rawChannelId,
              undefined,
              "message_sent",
            );
            ctx.lastOutput = event.content;
          }
        },
      );
    }

    // -- Hook: llm_input ----------------------------------------------------

    if (shouldHookEnabled("llm_input")) {
      api.on(
        "llm_input",
        async (event: LlmInputEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            event.runId,
            "llm_input",
          );
          // Record LLM segment start as early as possible in this hook to
          // reduce timing skew from later async awaits.
          const llmInputStartedAt = Date.now();
          ctx.llmPendingStartTime = llmInputStartedAt;
          ctx.llmPendingSpanId = generateId(16);

          if (event.sessionId) {
            ctx.sessionId = event.sessionId;
          }

          if (!ctx.userInput && event.prompt) {
            ctx.userInput = event.prompt;
          }

          // In concurrent/reordered hook delivery, llm_input may arrive before
          // before_agent_start for this run. Ensure parent spans exist so
          // segmented LLM/TOOL spans never become orphan traces.
          await ensureEntrySpan(ctx, channelId, {
            userId: (hookCtx.trigger as string) || "system",
            role: (hookCtx.trigger as string) || "system",
            from: hookCtx.agentId || "openclaw",
          });
          await ensureAgentSpan(ctx, channelId, hookCtx.agentId || "openclaw");

          ctx.llmProvider = event.provider;
          ctx.llmModel = event.model;
          ctx.hasSeenLlmInput = true;
          ctx.isClosing = false;
          if (rawChannelId.startsWith("agent/")) {
            activeContextByAgentChannel.set(rawChannelId, ctx);
          }
          await ensureStepSpan(ctx, channelId, llmInputStartedAt);
          // Expose the Step span context for outbound traceparent injection
          if (config.enableTracePropagation && ctx.stepSpanId) {
            const stepSpan = exporter.getOpenSpan(ctx.stepSpanId);
            if (stepSpan) {
              updatePropagationStore({ outboundSpanContext: stepSpan.spanContext() });
            }
          }
          ctx.llmPendingToolCallIds.clear();
          ctx.llmPendingToolCallCountFallback = 0;

          ctx.llmPendingRawSystemPrompt = event.systemPrompt || undefined;

          const historyMsgs = event.historyMessages?.length
            ? event.historyMessages.map((msg) => safeClone(msg))
            : [];
          ctx.llmPendingRawInputHistory = historyMsgs;
          ctx.llmPendingRawUserPrompt = event.prompt;
          ctx.llmLastRawInputHistory = historyMsgs;
          ctx.llmLastRawUserPrompt = event.prompt;

          const pendingAssistant = pendingAssistantByTraceId.get(ctx.traceId);
          if (pendingAssistant) {
            pendingAssistantByTraceId.delete(ctx.traceId);
            void enqueueTraceTask(ctx.traceId, async () => {
              await processAssistantMessageForContext(ctx, channelId, pendingAssistant.message);
            }).catch((err) => {
              api.logger.warn(`[ArmsTrace] replay pending assistant failed: ${String(err)}`);
            });
          }

          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] LLM input started: ${event.provider}/${event.model}, runId=${event.runId}`,
            );
          }
        },
      );
    }

    // -- Hook: llm_output ---------------------------------------------------

    if (shouldHookEnabled("llm_output")) {
      api.on(
        "llm_output",
        async (event: LlmOutputEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            event.runId,
            "llm_output",
          );

          if (event.sessionId) {
            ctx.sessionId = event.sessionId;
          }

          if (event.assistantTexts?.length) {
            const outputText = event.assistantTexts.join("\n");
            ctx.lastOutput = outputText;
          }
          if (event.usage) {
            ctx.lastLlmUsage = {
              input: event.usage.input,
              output: event.usage.output,
              cacheRead: event.usage.cacheRead,
              cacheWrite: event.usage.cacheWrite,
              total: event.usage.total,
            };
          }
          // Keep llm_output only as a compatibility fallback.
          // Normal segmented exports happen in before_message_write.
          if (ctx.llmSegmentCount === 0 && ctx.llmPendingStartTime) {
            const endTime = Date.now();
            const lastAssistantObj = event.lastAssistant as Record<string, unknown> | undefined;
            const stopReason = typeof lastAssistantObj?.stopReason === "string"
              ? lastAssistantObj.stopReason
              : undefined;
            await exportPendingLlmSpan(ctx, channelId, {
              endTime,
              outputTexts: event.assistantTexts || [],
              stopReason,
              usage: event.usage,
            });
            endStepSpan(ctx, endTime, stopReason || "stop", channelId);
          }
        },
      );
    }

    // -- Hook: before_message_write -----------------------------------------

    if (shouldHookEnabled("before_message_write")) {
      api.on(
        "before_message_write",
        (event: BeforeMessageWriteEvent, hookCtx: PluginHookContext) => {
          const message = event.message;
          if (!message || message.role !== "assistant") {
            return;
          }
          const rawChannelId = resolveChannelId(hookCtx);
          const anchoredCtx =
            rawChannelId.startsWith("agent/")
              ? activeContextByAgentChannel.get(rawChannelId)
              : undefined;
          if (rawChannelId.startsWith("agent/") && !anchoredCtx) {
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Skip assistant message without active agent context: channelId=${rawChannelId}`,
              );
            }
            return;
          }
          const { ctx, channelId } = anchoredCtx
            ? { ctx: anchoredCtx, channelId: anchoredCtx.channelId }
            : getOrCreateContext(
              rawChannelId,
              undefined,
              "before_message_write",
            );

          if (!ctx.hasSeenLlmInput) {
            pendingAssistantByTraceId.set(ctx.traceId, {
              message,
              createdAt: Date.now(),
            });
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Buffered assistant message waiting for llm_input: traceId=${ctx.traceId}, runId=${ctx.runId}`,
              );
            }
            return;
          }

          void enqueueTraceTask(ctx.traceId, async () => {
            await processAssistantMessageForContext(ctx, channelId, message);
          }).catch((err) => {
            api.logger.warn(`[ArmsTrace] before_message_write segmented export failed: ${String(err)}`);
          });
        },
      );
    }

    // -- Hook: before_tool_call ---------------------------------------------

    if (shouldHookEnabled("before_tool_call")) {
      api.on(
        "before_tool_call",
        async (
          event: BeforeToolCallEvent,
          hookCtx: PluginHookContext,
        ) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const anchoredCtx =
            rawChannelId.startsWith("agent/")
              ? activeContextByAgentChannel.get(rawChannelId)
              : undefined;
          if (rawChannelId.startsWith("agent/") && !anchoredCtx) {
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Skip tool span without active agent context: tool=${event.toolName}, channelId=${rawChannelId}`,
              );
            }
            return;
          }
          const { ctx, channelId } = anchoredCtx
            ? { ctx: anchoredCtx, channelId: anchoredCtx.channelId }
            : getOrCreateContext(
              rawChannelId,
              resolveOptionalRunId(event.runId),
              "before_tool_call",
            );
          if (!ctx.hasSeenLlmInput) {
            if (config.debug) {
              api.logger.warn(
                `[ArmsTrace] Skip tool span before llm_input binding: tool=${event.toolName}, channelId=${channelId}, runId=${ctx.runId}`,
              );
            }
            return;
          }
          const runId = resolveOptionalRunId(event.runId) || ctx.runId;
          const toolCallId = resolveOptionalToolCallId(event.toolCallId) || `call_${generateId(12)}`;
          const pendingToolCall: PendingToolCall = {
            runId,
            toolName: event.toolName,
            toolCallId,
            toolSpanId: generateId(16),
            toolStartTime: Date.now(),
            toolInput: event.params,
            traceContext: ctx,
            channelId,
            createdAt: Date.now(),
          };
          pendingToolCalls.set(buildPendingToolCallKey(toolCallId, runId), pendingToolCall);
          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] Tool call started: ${event.toolName}, toolCallId=${toolCallId}, runId=${runId}, spanId=${pendingToolCall.toolSpanId}`,
            );
          }
        },
      );
    }

    // -- Hook: after_tool_call ----------------------------------------------

    if (shouldHookEnabled("after_tool_call")) {
      api.on(
        "after_tool_call",
        async (
          event: AfterToolCallEvent,
          _hookCtx: PluginHookContext,
        ) => {
          const pendingToolCall = consumePendingToolCall(event);
          if (!pendingToolCall) {
            return;
          }

          const {
            toolName,
            toolCallId,
            toolSpanId,
            toolStartTime,
            toolInput,
            traceContext,
            channelId,
          } = pendingToolCall;
          const now = Date.now();

          const octx = makeOpenclawContext(traceContext, channelId);
          const toolInv = buildToolInvocation(toolName, toolCallId, toolInput, octx);
          compatSpanKindDialect(toolInv, exporter.getSpanKindAttrName(), "TOOL");

          if (toolInv.attributes) {
            toolInv.attributes["tool.duration_ms"] = event.durationMs || now - toolStartTime;
            if (toolInput !== undefined) {
              toolInv.attributes[GEN_AI_TOOL_CALL_ARGUMENTS] = truncateAttr(
                typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput),
              );
            }
            if (event.error) {
              toolInv.attributes[ERROR_TYPE] = event.error;
            } else if (event.result !== undefined) {
              toolInv.attributes[GEN_AI_TOOL_CALL_RESULT] = truncateAttr(
                typeof event.result === "string" ? event.result : JSON.stringify(event.result),
              );
            }
            if (config.globalSpanAttributes) {
              Object.assign(toolInv.attributes, config.globalSpanAttributes);
            }
            if (traceContext.customAttributes) {
              Object.assign(toolInv.attributes, traceContext.customAttributes);
            }
          }

          const h = await ensureHandler();
          const parentCtx = exporter.resolveParentContextFor(resolveStepFirstParentSpanId(traceContext));
          h.startExecuteTool(toolInv, parentCtx, toolStartTime);
          h.stopExecuteTool(toolInv, now);

          const toolResultPayload =
            event.error
              ? [{ type: "toolResult", toolCallId, toolName, isError: true, content: event.error }]
              : [{ type: "toolResult", toolCallId, toolName, content: event.result }];
          traceContext.llmPendingToolResultsForNextInput.push({
            role: "toolResult",
            content: toolResultPayload,
          });

          const hadWaitingTools =
            traceContext.llmPendingToolCallIds.size > 0
            || traceContext.llmPendingToolCallCountFallback > 0;
          if (hadWaitingTools) {
            if (traceContext.llmPendingToolCallIds.size > 0) {
              if (traceContext.llmPendingToolCallIds.has(toolCallId)) {
                traceContext.llmPendingToolCallIds.delete(toolCallId);
              } else if (!resolveOptionalToolCallId(event.toolCallId)) {
                const firstPendingId = traceContext.llmPendingToolCallIds.values().next().value;
                if (firstPendingId) {
                  traceContext.llmPendingToolCallIds.delete(firstPendingId);
                }
              }
            } else if (traceContext.llmPendingToolCallCountFallback > 0) {
              traceContext.llmPendingToolCallCountFallback -= 1;
            }

            const toolBatchFinished =
              traceContext.llmPendingToolCallIds.size === 0
              && traceContext.llmPendingToolCallCountFallback === 0;
            if (toolBatchFinished) {
              const nextInputHistory: Array<{ role: string; content: unknown }> = [];
              if (traceContext.llmLastAssistantContent !== undefined) {
                nextInputHistory.push({
                  role: "assistant",
                  content: traceContext.llmLastAssistantContent,
                });
              }
              if (traceContext.llmPendingToolResultsForNextInput.length > 0) {
                nextInputHistory.push(...traceContext.llmPendingToolResultsForNextInput);
              }
              endStepSpan(traceContext, now, "toolUse", channelId);
              traceContext.llmPendingStartTime = now;
              traceContext.llmPendingSpanId = generateId(16);
              await ensureStepSpan(traceContext, channelId, now);
              traceContext.llmPendingRawSystemPrompt = undefined;
              traceContext.llmPendingRawInputHistory =
                nextInputHistory.length > 0 ? nextInputHistory : undefined;
              traceContext.llmPendingRawUserPrompt = undefined;
              traceContext.llmLastRawInputHistory = traceContext.llmPendingRawInputHistory;
              traceContext.llmLastRawUserPrompt = undefined;
              traceContext.llmPendingToolResultsForNextInput = [];
              if (config.debug) {
                api.logger.info(
                  `[ArmsTrace] Prepared next segmented LLM start after tools: runId=${traceContext.runId}, tool=${toolName}, toolCallId=${toolCallId}`,
                );
              }
            }
          }

          if (config.debug) {
            api.logger.info(
              `[ArmsTrace] Exported tool span: ${toolName}, toolCallId=${toolCallId}, duration=${now - toolStartTime}ms`,
            );
          }
        },
      );
    }

    // -- Hook: before_agent_start -------------------------------------------

    if (shouldHookEnabled("before_agent_start")) {
      api.on(
        "before_agent_start",
        async (
          event: BeforeAgentStartEvent,
          hookCtx: PluginHookContext,
        ) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const agentId =
            hookCtx.agentId || "openclaw";
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "before_agent_start",
          );

          // Ensure ENTRY span exists (idempotent: skips if message_received already created one)
          await ensureEntrySpan(ctx, channelId, {
            userId: (hookCtx.trigger as string) || "system",
            role: (hookCtx.trigger as string) || "system",
            from: agentId,
          });
          await ensureAgentSpan(ctx, channelId, agentId);
        },
      );
    }

    // -- Hook: agent_end ----------------------------------------------------

    if (shouldHookEnabled("agent_end")) {
      api.on(
        "agent_end",
        async (event: AgentEndEvent, hookCtx: PluginHookContext) => {
          const rawChannelId = resolveChannelId(hookCtx);
          const { ctx, channelId } = getOrCreateContext(
            rawChannelId,
            undefined,
            "agent_end",
          );
          await drainTraceTasks(ctx.traceId);

          // If a final LLM segment is still in-flight (waiting for
          // before_message_write), wait briefly for it to finish so that
          // the Step span we are about to close does not end before its
          // child LLM span. Capped at 5s to bound agent_end latency.
          if (ctx.llmPendingStartTime) {
            const waitDeadline = Date.now() + 5000;
            while (ctx.llmPendingStartTime && Date.now() < waitDeadline) {
              await new Promise<void>((r) => setTimeout(r, 50));
            }
          }

          ctx.isClosing = true;
          const now = Date.now();
          // Capture step-related state synchronously; defer the actual
          // endStepSpan call into the setTimeout(100) callback so that
          // any in-flight before_message_write for the final LLM can
          // complete first and the Step span's endTime is >= its child
          // LLM span's endTime.
          const deferredStepFinishReason = ctx.stepAwaitingToolResults
            ? "agent_end"
            : "stop";
          const hasPendingStep = !!ctx.stepSpanId;

          const pendingAgentSpanId = ctx.agentSpanId;
          const pendingAgentInv = ctx.agentInvocation;
          const agentEndTime = now;
          let agentEndAttrs: Record<string, string | number | boolean> | undefined;
          if (pendingAgentSpanId) {
            const agentMessageCount = Array.isArray(event.messages) ? event.messages.length : 0;
            const agentToolCallCount = countToolCallsFromMessages(event.messages);
            agentEndAttrs = {
              "agent.duration_ms": event.durationMs || 0,
              "agent.message_count": agentMessageCount,
              "agent.tool_call_count": agentToolCallCount,
              [GEN_AI_USAGE_INPUT_TOKENS]: ctx.lastLlmUsage?.input || 0,
              [GEN_AI_USAGE_OUTPUT_TOKENS]: ctx.lastLlmUsage?.output || 0,
              [GEN_AI_USAGE_TOTAL_TOKENS]: ctx.lastLlmUsage?.total || 0,
            };
            if (ctx.sessionId) {
              agentEndAttrs["openclaw.session.id"] = ctx.sessionId || channelId;
              agentEndAttrs[GEN_AI_SESSION_ID] = ctx.sessionId || channelId;
            }
            const agentInput = ctx.userInput;
            if (agentInput) {
              agentEndAttrs[GEN_AI_INPUT_MESSAGES] = truncateAttr(
                JSON.stringify([{ role: "user", parts: [{ type: "text", content: String(agentInput) }] }]),
              );
            }
            ctx.agentSpanId = undefined;
            ctx.agentStartTime = undefined;
            ctx.agentInvocation = undefined;
          }

          const rootCtx = ctx;

          // Pre-capture endTime for ENTRY and Step spans synchronously,
          // so that OpenClaw's post-agent_end internal processing (session
          // cleanup, context engine maintenance, message delivery) does not
          // inflate span durations when the setTimeout callback fires late.
          const entryEndTime = now;
          const stepEndTime = now;

          if (rootCtx.rootSpanStartTime || pendingAgentSpanId) {
            const rootSpanId = rootCtx.rootSpanId;
            const rootSpanStartTime = rootCtx.rootSpanStartTime;
            const userInput = rootCtx.userInput;
            const traceId = rootCtx.traceId;
            const resolvedSessionId = ctx.sessionId || rootCtx.sessionId;

            setTimeout(async () => {
              // By now llm_output / message_sending / message_sent should
              // have executed and written lastOutput onto the context.
              const finalOutput =
                ctx.lastOutput || rootCtx.lastOutput;

              // Close the pending Step span here (deferred from agent_end),
              // so that any late before_message_write for the final LLM
              // has exported its span first. endStepSpan internally uses
              // max(endTime, ctx.lastLlmEndTime) for monotonicity.
              if (hasPendingStep && ctx.stepSpanId) {
                endStepSpan(
                  ctx,
                  stepEndTime,
                  deferredStepFinishReason,
                  channelId,
                );
              }

              if (pendingAgentSpanId && agentEndAttrs) {
                if (finalOutput) {
                  agentEndAttrs[GEN_AI_OUTPUT_MESSAGES] = formatOutputMessages(
                    [typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput)],
                  );
                }
                if (pendingAgentInv && handler) {
                  if (!pendingAgentInv.attributes) pendingAgentInv.attributes = {};
                  Object.assign(pendingAgentInv.attributes, agentEndAttrs);
                  handler.stopInvokeAgent(pendingAgentInv, agentEndTime);
                } else {
                  exporter.endSpanById(pendingAgentSpanId, agentEndTime, agentEndAttrs);
                }
                exporter.unregisterOpenSpan(pendingAgentSpanId);
                if (config.debug) {
                  api.logger.info(
                    `[ArmsTrace] Ended agent span: spanId=${pendingAgentSpanId}, duration=${event.durationMs}ms`,
                  );
                }
              }

              if (rootSpanStartTime) {
                const rootEndAttrs: Record<string, string | number | boolean> = {
                  "request.duration_ms": entryEndTime - rootSpanStartTime,
                };
                if (resolvedSessionId) {
                  rootEndAttrs["openclaw.session.id"] = resolvedSessionId;
                  rootEndAttrs[GEN_AI_SESSION_ID] = resolvedSessionId;
                }
                if (userInput) {
                  rootEndAttrs[GEN_AI_INPUT_MESSAGES] = truncateAttr(
                    JSON.stringify([{ role: "user", parts: [{ type: "text", content: String(userInput) }] }]),
                  );
                }
                if (finalOutput) {
                  rootEndAttrs[GEN_AI_OUTPUT_MESSAGES] = formatOutputMessages(
                    [typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput)],
                  );
                }
                const pendingEntryInv = rootCtx.entryInvocation;
                if (pendingEntryInv && handler) {
                  if (!pendingEntryInv.attributes) pendingEntryInv.attributes = {};
                  Object.assign(pendingEntryInv.attributes, rootEndAttrs);
                  handler.stopEntry(pendingEntryInv, entryEndTime);
                } else {
                  exporter.endSpanById(
                    rootSpanId,
                    entryEndTime,
                    rootEndAttrs,
                    finalOutput,
                    userInput,
                  );
                }
                exporter.unregisterOpenSpan(rootSpanId);
                if (config.debug) {
                  api.logger.info(
                    `[ArmsTrace] Ended root span: spanId=${rootSpanId}, duration=${entryEndTime - rootSpanStartTime}ms, traceId=${traceId}`,
                  );
                }
              }

              // Clean up Map entries AFTER spans are closed so that
              // late-arriving hooks (llm_output) don't create stale entries.
              cleanupPendingToolCallsForRun(rootCtx.runId || ctx.runId);
              cleanupContextIdentity(rootCtx);

              await exporter.flush();
              exporter.endTrace();
            }, 100);
          } else {
            cleanupPendingToolCallsForRun(rootCtx.runId || ctx.runId);
            cleanupContextIdentity(rootCtx);
            await exporter.flush();
            exporter.endTrace();
          }
        },
      );
    }

    api.logger.info(
      `[ArmsTrace] Plugin activated (endpoint: ${config.endpoint}, service: ${config.serviceName})`,
    );
  },
};

export default armsTracePlugin;
