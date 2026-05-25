// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import type {
  LLMInvocation,
  InputMessage,
  OutputMessage,
  MessagePart,
  EntryInvocation,
  InvokeAgentInvocation,
  ReactStepInvocation,
  ExecuteToolInvocation,
} from "@loongsuite/opentelemetry-util-genai";
import {
  createLLMInvocation,
  createEntryInvocation,
  createInvokeAgentInvocation,
  createReactStepInvocation,
  createExecuteToolInvocation,
} from "@loongsuite/opentelemetry-util-genai";

// ---------------------------------------------------------------------------
// Message part conversion
// ---------------------------------------------------------------------------

export function toSpecParts(content: unknown): MessagePart[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return [{ type: "text", content }];
  if (Array.isArray(content)) {
    return content.map((item): MessagePart => {
      if (typeof item === "string") return { type: "text", content: item };
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "toolCall" || obj.type === "tool_call" || obj.type === "function_call") {
          return {
            type: "tool_call",
            id: (obj.id || obj.toolCallId || null) as string | null,
            name: String(obj.name || obj.toolName || ""),
            arguments: obj.arguments || obj.input || obj.params || null,
          };
        }
        if (obj.type === "toolResult" || obj.type === "tool_result" || obj.type === "tool_call_response") {
          const resp = obj.response ?? obj.result ?? obj.content ?? "";
          return {
            type: "tool_call_response",
            id: (obj.id || obj.toolCallId || null) as string | null,
            response: typeof resp === "string" ? resp : JSON.stringify(resp),
          };
        }
        if (obj.type === "text") {
          return { type: "text", content: String(obj.content ?? obj.text ?? "") };
        }
        if (obj.type === "thinking" || obj.type === "reasoning") {
          return { type: "reasoning", content: String(obj.content ?? obj.thinking ?? "") };
        }
        if (obj.type) return obj as MessagePart;
        return { type: "text", content: JSON.stringify(item) };
      }
      return { type: "text", content: String(item) };
    });
  }
  return [{ type: "text", content: JSON.stringify(content) }];
}

// ---------------------------------------------------------------------------
// Message formatting helpers
// ---------------------------------------------------------------------------

const ROLE_MAP: Record<string, string> = {
  toolResult: "tool",
  tool_result: "tool",
  function: "tool",
};

export function toInputMessages(
  historyMessages: Array<{ role: string; content: unknown }>,
  userPrompt?: string,
): InputMessage[] {
  const result: InputMessage[] = [];
  for (const msg of historyMessages) {
    const role = ROLE_MAP[msg.role] || msg.role;
    result.push({ role, parts: toSpecParts(msg.content) });
  }
  if (userPrompt) {
    result.push({ role: "user", parts: [{ type: "text", content: userPrompt }] });
  }
  return result;
}

export function toOutputMessages(
  assistantContent: unknown,
  fallbackTexts: string[] = [],
  finishReason = "stop",
): OutputMessage[] {
  const parts = toSpecParts(assistantContent);
  if (parts.length > 0) {
    return [{ role: "assistant", parts, finishReason }];
  }
  return fallbackTexts.map((text) => ({
    role: "assistant",
    parts: [{ type: "text" as const, content: text }],
    finishReason,
  }));
}

export function toSystemInstruction(systemPrompt: string): MessagePart[] {
  return [{ type: "text", content: systemPrompt }];
}

// ---------------------------------------------------------------------------
// Invocation builders
// ---------------------------------------------------------------------------

export interface LlmBuildParams {
  provider: string;
  model: string;
  systemPrompt?: string;
  historyMessages?: Array<{ role: string; content: unknown }>;
  prompt?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  finishReasons?: string[];
  outputContent?: unknown;
  outputTexts?: string[];
  stopReason?: string;
}

export interface OpenclawContext {
  openclawVersion: string;
  sessionId?: string;
  channelId: string;
  runId: string;
  turnId: string;
}

export function buildLlmInvocation(
  octx: OpenclawContext,
  params: LlmBuildParams,
): LLMInvocation {
  const inputMessages = params.historyMessages
    ? toInputMessages(params.historyMessages, params.prompt)
    : params.prompt
      ? toInputMessages([], params.prompt)
      : [];

  const outputMessages = (params.outputContent !== undefined || (params.outputTexts && params.outputTexts.length > 0))
    ? toOutputMessages(params.outputContent, params.outputTexts, params.stopReason || "stop")
    : [];

  const systemInstruction = params.systemPrompt
    ? toSystemInstruction(params.systemPrompt)
    : [];

  const totalTokens = params.totalTokens ??
    (params.inputTokens ?? 0) + (params.outputTokens ?? 0) +
    (params.cacheReadTokens ?? 0) + (params.cacheCreationTokens ?? 0);

  return createLLMInvocation({
    operationName: "chat",
    provider: params.provider,
    requestModel: params.model,
    responseModelName: params.model,
    inputMessages,
    outputMessages,
    systemInstruction,
    inputTokens: params.inputTokens ?? 0,
    outputTokens: params.outputTokens ?? 0,
    usageCacheReadInputTokens: params.cacheReadTokens ?? 0,
    usageCacheCreationInputTokens: params.cacheCreationTokens ?? 0,
    finishReasons: params.finishReasons ?? [params.stopReason || "stop"],
    attributes: {
      "gen_ai.usage.total_tokens": totalTokens,
      "openclaw.version": octx.openclawVersion,
      "openclaw.session.id": octx.sessionId || octx.channelId,
      "gen_ai.session.id": octx.sessionId || octx.channelId,
      "openclaw.run.id": octx.runId,
      "openclaw.turn.id": octx.turnId,
    },
  });
}

export function buildEntryInvocation(
  octx: OpenclawContext,
  options: { userId?: string; role?: string; from?: string } = {},
): EntryInvocation {
  return createEntryInvocation({
    sessionId: octx.sessionId || octx.channelId,
    userId: options.userId || "unknown",
    attributes: {
      "gen_ai.operation.name": "enter",
      "gen_ai.user.id": options.userId || "unknown",
      "openclaw.session.id": octx.sessionId || octx.channelId,
      "gen_ai.session.id": octx.sessionId || octx.channelId,
      "openclaw.run.id": octx.runId,
      "openclaw.turn.id": octx.turnId,
      "openclaw.message.role": options.role || "unknown",
      "openclaw.message.from": options.from || "unknown",
      "openclaw.version": octx.openclawVersion,
    },
  });
}

export function buildAgentInvocation(
  octx: OpenclawContext,
  agentId: string,
): InvokeAgentInvocation {
  return createInvokeAgentInvocation("openclaw", {
    agentId,
    agentName: agentId,
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "openclaw",
      "gen_ai.agent.id": agentId,
      "gen_ai.agent.name": agentId,
      "openclaw.session.id": octx.sessionId || octx.channelId,
      "gen_ai.session.id": octx.sessionId || octx.channelId,
      "openclaw.run.id": octx.runId,
      "openclaw.turn.id": octx.turnId,
      "openclaw.version": octx.openclawVersion,
    },
  });
}

export function buildStepInvocation(
  octx: OpenclawContext,
  round: number,
): ReactStepInvocation {
  return createReactStepInvocation({
    round,
    attributes: {
      "gen_ai.operation.name": "react",
      "gen_ai.react.round": round,
      "openclaw.session.id": octx.sessionId || octx.channelId,
      "gen_ai.session.id": octx.sessionId || octx.channelId,
      "openclaw.run.id": octx.runId,
      "openclaw.turn.id": octx.turnId,
      "openclaw.version": octx.openclawVersion,
    },
  });
}

export function buildToolInvocation(
  toolName: string,
  toolCallId: string,
  toolInput: unknown,
  octx: OpenclawContext,
): ExecuteToolInvocation {
  const MAX_ATTR_LENGTH = 3_200_000;
  const truncate = (v: string) => v.length > MAX_ATTR_LENGTH ? v.substring(0, MAX_ATTR_LENGTH) : v;

  const attrs: Record<string, unknown> = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.id": toolCallId,
    "gen_ai.tool.type": "function",
    "openclaw.version": octx.openclawVersion,
    "openclaw.session.id": octx.sessionId || octx.channelId,
    "gen_ai.session.id": octx.sessionId || octx.channelId,
    "openclaw.run.id": octx.runId,
    "openclaw.turn.id": octx.turnId,
  };

  return createExecuteToolInvocation(toolName, {
    toolCallId,
    toolType: "function",
    toolCallArguments: toolInput,
    attributes: attrs,
  });
}
