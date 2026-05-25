// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// ---------------------------------------------------------------------------
// Plugin API types (mirrors openclaw/plugin-sdk without a hard dependency)
// ---------------------------------------------------------------------------

export interface PluginHookContext {
  channelId?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  conversationId?: string;
  from?: string;
  to?: string;
  [key: string]: unknown;
}

export interface OpenClawPluginApi {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime?: {
    version?: string;
  };
  logger: {
    info(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    debug?(message: string): void;
  };
  on<T = unknown>(
    hookName: string,
    handler: (event: T, ctx: PluginHookContext) => Promise<void> | void,
    options?: { priority?: number },
  ): void;
}

export interface OpenClawPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  activate(api: OpenClawPluginApi): Promise<void> | void;
}

export interface ArmsTraceConfig {
  endpoint: string;
  headers: Record<string, string>;
  serviceName: string;
  debug: boolean;
  batchSize: number;
  flushIntervalMs: number;
  enabledHooks?: string[];
  enableTracePropagation?: boolean;
  propagationTargetUrls?: string[];
  resourceAttributes?: Record<string, string>;
  globalSpanAttributes?: Record<string, string | number | boolean>;
}

export type SpanType =
  | "entry"
  | "step"
  | "model"
  | "tool"
  | "agent"
  | "prompt"
  | "rag"
  | "message"
  | "session"
  | "gateway";

export interface SpanData {
  name: string;
  type: SpanType;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  input?: unknown;
  output?: unknown;
  parentSpanId?: string;
  traceId?: string;
  spanId?: string;
}

// ---------------------------------------------------------------------------
// Hook event types
// ---------------------------------------------------------------------------

export interface GatewayStartEvent {
  port: number;
}

export interface SessionStartEvent {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
}

export interface SessionEndEvent {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
}

export interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface MessageSendingEvent {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MessageSentEvent {
  to: string;
  content: string;
  success: boolean;
  error?: string;
}

export interface LlmInputEvent {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: Array<{ role: string; content: unknown }>;
  imagesCount: number;
}

export interface LlmOutputEvent {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: {
    usage?: { input?: number; output?: number };
  };
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface BeforeAgentStartEvent {
  prompt: string;
  messages?: unknown[];
}

export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}
