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

import type { Span, Context } from "@opentelemetry/api";
import { SpanStatusCode, propagation } from "@opentelemetry/api";
import type {
  LLMInvocation,
  GenAIError,
  InputMessage,
  OutputMessage,
  MessagePart,
  ToolDefinition,
  FunctionToolDefinition,
} from "./types.js";
import { ContentCapturingMode } from "./types.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_SPAN_KIND,
  GEN_AI_OUTPUT_TYPE,
  GEN_AI_REQUEST_CHOICE_COUNT,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_REQUEST_TOP_K,
  GEN_AI_REQUEST_FREQUENCY_PENALTY,
  GEN_AI_REQUEST_PRESENCE_PENALTY,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_STOP_SEQUENCES,
  GEN_AI_REQUEST_SEED,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_ID,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_SYSTEM_INSTRUCTIONS,
  GEN_AI_INPUT_MULTIMODAL_METADATA,
  GEN_AI_OUTPUT_MULTIMODAL_METADATA,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_AGENT_NAME,
  GEN_AI_USER_ID,
  GEN_AI_SESSION_ID,
  SERVER_ADDRESS,
  SERVER_PORT,
  ERROR_TYPE,
  GenAiSpanKindValues,
} from "./semconv/gen-ai-extended-attributes.js";
import {
  isExperimentalMode,
  getContentCapturingMode,
  shouldEmitEvent,
  genAiJsonDumps,
} from "./utils.js";

export function getLlmCommonAttributes(
  invocation: LLMInvocation,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: invocation.operationName ?? "chat",
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.LLM,
  };

  if (invocation.requestModel != null) {
    attrs[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
  }
  if (invocation.provider != null) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.conversationId != null) {
    attrs[GEN_AI_CONVERSATION_ID] = invocation.conversationId;
  }
  if (invocation.serverAddress != null) {
    attrs[SERVER_ADDRESS] = invocation.serverAddress;
  }
  if (invocation.serverPort != null) {
    attrs[SERVER_PORT] = invocation.serverPort;
  }
  return attrs;
}

export function getLlmSpanName(invocation: LLMInvocation): string {
  const op = invocation.operationName ?? "chat";
  const model = invocation.requestModel ?? "";
  return `${op} ${model}`.trim();
}

export function getLlmRequestAttributes(
  invocation: LLMInvocation,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  if (invocation.outputType != null) {
    attrs[GEN_AI_OUTPUT_TYPE] = invocation.outputType;
  }
  if (invocation.choiceCount != null && invocation.choiceCount !== 1) {
    attrs[GEN_AI_REQUEST_CHOICE_COUNT] = invocation.choiceCount;
  }
  if (invocation.temperature != null) {
    attrs[GEN_AI_REQUEST_TEMPERATURE] = invocation.temperature;
  }
  if (invocation.topP != null) {
    attrs[GEN_AI_REQUEST_TOP_P] = invocation.topP;
  }
  if (invocation.topK != null) {
    attrs[GEN_AI_REQUEST_TOP_K] = invocation.topK;
  }
  if (invocation.frequencyPenalty != null) {
    attrs[GEN_AI_REQUEST_FREQUENCY_PENALTY] = invocation.frequencyPenalty;
  }
  if (invocation.presencePenalty != null) {
    attrs[GEN_AI_REQUEST_PRESENCE_PENALTY] = invocation.presencePenalty;
  }
  if (invocation.maxTokens != null) {
    attrs[GEN_AI_REQUEST_MAX_TOKENS] = invocation.maxTokens;
  }
  if (invocation.stopSequences != null) {
    attrs[GEN_AI_REQUEST_STOP_SEQUENCES] = invocation.stopSequences;
  }
  if (invocation.seed != null) {
    attrs[GEN_AI_REQUEST_SEED] = invocation.seed;
  }
  return attrs;
}

export function getLlmResponseAttributes(
  invocation: LLMInvocation,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  let finishReasons: string[] | null = null;
  if (invocation.finishReasons != null) {
    finishReasons = invocation.finishReasons;
  } else if (invocation.outputMessages?.length) {
    finishReasons = invocation.outputMessages
      .map((m) => m.finishReason)
      .filter((r): r is string => !!r);
  }

  if (finishReasons?.length) {
    attrs[GEN_AI_RESPONSE_FINISH_REASONS] = [...new Set(finishReasons)].sort();
  }
  if (invocation.responseModelName != null) {
    attrs[GEN_AI_RESPONSE_MODEL] = invocation.responseModelName;
  }
  if (invocation.responseId != null) {
    attrs[GEN_AI_RESPONSE_ID] = invocation.responseId;
  }
  if (invocation.inputTokens != null) {
    attrs[GEN_AI_USAGE_INPUT_TOKENS] = invocation.inputTokens;
  }
  if (invocation.outputTokens != null) {
    attrs[GEN_AI_USAGE_OUTPUT_TOKENS] = invocation.outputTokens;
  }
  if (invocation.usageCacheCreationInputTokens != null) {
    attrs[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS] =
      invocation.usageCacheCreationInputTokens;
  }
  if (invocation.usageCacheReadInputTokens != null) {
    attrs[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] =
      invocation.usageCacheReadInputTokens;
  }

  // Prefer the upstream-reported total; only compute (input + output) when the
  // upstream did not provide a usable total.
  let totalTokens: number;
  if (invocation.totalTokens != null && invocation.totalTokens > 0) {
    totalTokens = invocation.totalTokens;
  } else {
    totalTokens = 0;
    if (invocation.inputTokens != null) totalTokens += invocation.inputTokens;
    if (invocation.outputTokens != null) totalTokens += invocation.outputTokens;
  }
  if (totalTokens > 0) {
    attrs[GEN_AI_USAGE_TOTAL_TOKENS] = totalTokens;
  }

  if (
    invocation.monotonicFirstTokenS != null &&
    invocation.monotonicStartS != null &&
    invocation.monotonicFirstTokenS >= invocation.monotonicStartS
  ) {
    const ttftNs = Math.round(
      (invocation.monotonicFirstTokenS - invocation.monotonicStartS) * 1e9,
    );
    attrs[GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN] = ttftNs;
  }

  return attrs;
}

function messagePartToDict(part: MessagePart): Record<string, unknown> {
  if (typeof part === "object" && part !== null) {
    const serialized = { ...part } as Record<string, unknown>;

    // Public TypeScript interfaces follow the JavaScript camelCase convention,
    // while the OpenTelemetry GenAI message JSON schemas use snake_case.
    // Normalize the schema-defined multimodal fields at the serialization
    // boundary without changing the public invocation API.
    if ("mimeType" in serialized) {
      serialized["mime_type"] = serialized["mimeType"];
      delete serialized["mimeType"];
    }
    if ("fileId" in serialized) {
      serialized["file_id"] = serialized["fileId"];
      delete serialized["fileId"];
    }

    return serialized;
  }
  return { value: part };
}

function inputMessageToDict(
  msg: InputMessage,
): Record<string, unknown> {
  return {
    role: msg.role,
    parts: msg.parts.map(messagePartToDict),
  };
}

function outputMessageToDict(
  msg: OutputMessage,
): Record<string, unknown> {
  return {
    role: msg.role,
    parts: msg.parts.map(messagePartToDict),
    finish_reason: msg.finishReason,
  };
}

function extractUriMetadata(
  messages: Array<InputMessage | OutputMessage>,
): Record<string, unknown>[] {
  const metadata: Record<string, unknown>[] = [];

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        typeof part !== "object" ||
        part === null ||
        part.type !== "uri" ||
        !("mimeType" in part) ||
        !("uri" in part) ||
        !("modality" in part)
      ) {
        continue;
      }

      metadata.push({
        type: "uri",
        mime_type: part.mimeType,
        uri: part.uri,
        modality: part.modality,
      });
    }
  }

  return metadata;
}

export function getLlmMessagesAttributesForSpan(
  inputMessages: InputMessage[],
  outputMessages: OutputMessage[],
  systemInstruction?: MessagePart[] | null,
): Record<string, unknown> {
  if (!isExperimentalMode()) return {};
  const mode = getContentCapturingMode();
  if (
    mode !== ContentCapturingMode.SPAN_ONLY &&
    mode !== ContentCapturingMode.SPAN_AND_EVENT
  ) {
    return {};
  }

  const attrs: Record<string, unknown> = {};
  if (inputMessages.length) {
    attrs[GEN_AI_INPUT_MESSAGES] = genAiJsonDumps(
      inputMessages.map(inputMessageToDict),
    );
    const inputMultimodalMetadata = extractUriMetadata(inputMessages);
    if (inputMultimodalMetadata.length) {
      attrs[GEN_AI_INPUT_MULTIMODAL_METADATA] = genAiJsonDumps(
        inputMultimodalMetadata,
      );
    }
  }
  if (outputMessages.length) {
    attrs[GEN_AI_OUTPUT_MESSAGES] = genAiJsonDumps(
      outputMessages.map(outputMessageToDict),
    );
    const outputMultimodalMetadata = extractUriMetadata(outputMessages);
    if (outputMultimodalMetadata.length) {
      attrs[GEN_AI_OUTPUT_MULTIMODAL_METADATA] = genAiJsonDumps(
        outputMultimodalMetadata,
      );
    }
  }
  if (systemInstruction?.length) {
    attrs[GEN_AI_SYSTEM_INSTRUCTIONS] = genAiJsonDumps(
      systemInstruction.map(messagePartToDict),
    );
  }
  return attrs;
}

function isFunctionToolDef(
  td: ToolDefinition,
): td is FunctionToolDefinition {
  return td.type === "function" && "description" in td;
}

export function getToolDefinitionsForSpan(
  toolDefinitions?: ToolDefinition[] | null,
): Record<string, unknown> {
  if (!isExperimentalMode() || !toolDefinitions?.length) return {};

  const mode = getContentCapturingMode();
  const shouldRecordFull =
    mode === ContentCapturingMode.SPAN_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT;

  const dicts = toolDefinitions.map((td) => {
    if (isFunctionToolDef(td) && !shouldRecordFull) {
      return { name: td.name, type: td.type };
    }
    return { ...td };
  });

  return { [GEN_AI_TOOL_DEFINITIONS]: genAiJsonDumps(dicts) };
}

export interface EventLogger {
  emit(record: {
    name: string;
    attributes: Record<string, unknown>;
  }): void;
}

export function maybeEmitLlmEvent(
  logger: EventLogger | null | undefined,
  span: Span,
  invocation: LLMInvocation,
  error?: GenAIError | null,
): void {
  if (!isExperimentalMode() || !shouldEmitEvent() || !logger) return;

  const attrs: Record<string, unknown> = {};
  Object.assign(attrs, getLlmCommonAttributes(invocation));
  Object.assign(attrs, getLlmRequestAttributes(invocation));
  Object.assign(attrs, getLlmResponseAttributes(invocation));

  const mode = getContentCapturingMode();
  if (
    mode === ContentCapturingMode.EVENT_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT
  ) {
    if (invocation.inputMessages?.length) {
      attrs[GEN_AI_INPUT_MESSAGES] = invocation.inputMessages.map(
        inputMessageToDict,
      );
    }
    if (invocation.outputMessages?.length) {
      attrs[GEN_AI_OUTPUT_MESSAGES] = invocation.outputMessages.map(
        outputMessageToDict,
      );
    }
    if (invocation.systemInstruction?.length) {
      attrs[GEN_AI_SYSTEM_INSTRUCTIONS] =
        invocation.systemInstruction.map(messagePartToDict);
    }
    if (invocation.toolDefinitions?.length) {
      attrs[GEN_AI_TOOL_DEFINITIONS] = invocation.toolDefinitions.map(
        (td) => ({ ...td }),
      );
    }
  }

  if (error) {
    attrs[ERROR_TYPE] = error.type;
  }

  logger.emit({
    name: "gen_ai.client.inference.operation.details",
    attributes: attrs,
  });
}

/**
 * Apply ARMS GenAI common attributes (gen_ai.agent.name / gen_ai.user.id /
 * gen_ai.session.id) into a flat attribute bag.
 *
 * These three keys are required as common attributes per ARMS GenAI semantic
 * conventions — every span (ENTRY/AGENT/STEP/LLM/TOOL/...) should carry them
 * when the values are available.
 */
export function applyCommonGenAiAttributes(
  attrs: Record<string, unknown>,
  invocation: {
    agentName?: string | null;
    userId?: string | null;
    sessionId?: string | null;
  },
): void {
  if (invocation.agentName != null) {
    attrs[GEN_AI_AGENT_NAME] = invocation.agentName;
  }
  if (invocation.userId != null) {
    attrs[GEN_AI_USER_ID] = invocation.userId;
  }
  if (invocation.sessionId != null) {
    attrs[GEN_AI_SESSION_ID] = invocation.sessionId;
  }
}

/**
 * Apply pass-through attributes with fill-only semantics: a key is written to
 * the attribute bag ONLY if it is not already present. This guarantees that
 * converter-produced attributes (usage totals, model, common attributes,
 * invocation.attributes overrides like TTFT, ...) are never clobbered by
 * user-supplied pass-through fields. Intended to be called last, after all
 * managed attributes have been written.
 */
export function applyPassthroughAttributes(
  attrs: Record<string, unknown>,
  passthrough?: Record<string, unknown> | null,
): void {
  if (!passthrough) return;
  for (const key of Object.keys(passthrough)) {
    const value = passthrough[key];
    if (value != null && !(key in attrs)) {
      attrs[key] = value;
    }
  }
}

/** Common attributes carried across GenAI spans via OTel Baggage. */
interface CommonGenAiAttrs {
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

/**
 * Write the ARMS GenAI common attributes (agent.name / user.id / session.id)
 * into the Baggage of a context, so that downstream GenAI spans created within
 * that context can inherit them automatically.
 *
 * Only non-null values are written; existing baggage entries are preserved.
 * Returns the context unchanged when there is nothing to write.
 */
export function setCommonBaggage(ctx: Context, attrs: CommonGenAiAttrs): Context {
  let baggage = propagation.getBaggage(ctx) ?? propagation.createBaggage();
  let changed = false;
  if (attrs.agentName != null) {
    baggage = baggage.setEntry(GEN_AI_AGENT_NAME, { value: String(attrs.agentName) });
    changed = true;
  }
  if (attrs.userId != null) {
    baggage = baggage.setEntry(GEN_AI_USER_ID, { value: String(attrs.userId) });
    changed = true;
  }
  if (attrs.sessionId != null) {
    baggage = baggage.setEntry(GEN_AI_SESSION_ID, { value: String(attrs.sessionId) });
    changed = true;
  }
  return changed ? propagation.setBaggage(ctx, baggage) : ctx;
}

/**
 * Backfill an invocation's common attributes from the Baggage of a context.
 *
 * Fill-only: a field is populated only when it is currently null/undefined, so
 * explicitly-set values always win. Used by handlers when starting GenAI child
 * spans so agent.name / user.id / session.id propagate from the enclosing
 * Entry/Agent span without manual wiring on every child.
 */
export function backfillCommonFromBaggage(
  invocation: CommonGenAiAttrs,
  ctx: Context,
): void {
  const baggage = propagation.getBaggage(ctx);
  if (!baggage) return;
  if (invocation.agentName == null) {
    const e = baggage.getEntry(GEN_AI_AGENT_NAME);
    if (e) invocation.agentName = e.value;
  }
  if (invocation.userId == null) {
    const e = baggage.getEntry(GEN_AI_USER_ID);
    if (e) invocation.userId = e.value;
  }
  if (invocation.sessionId == null) {
    const e = baggage.getEntry(GEN_AI_SESSION_ID);
    if (e) invocation.sessionId = e.value;
  }
}

export function applyLlmFinishAttributes(
  span: Span,
  invocation: LLMInvocation,
): void {
  span.updateName(getLlmSpanName(invocation));

  const attrs: Record<string, unknown> = {};
  Object.assign(attrs, getLlmCommonAttributes(invocation));
  Object.assign(attrs, getLlmRequestAttributes(invocation));
  Object.assign(attrs, getLlmResponseAttributes(invocation));
  Object.assign(
    attrs,
    getLlmMessagesAttributesForSpan(
      invocation.inputMessages ?? [],
      invocation.outputMessages ?? [],
      invocation.systemInstruction,
    ),
  );
  Object.assign(
    attrs,
    getToolDefinitionsForSpan(invocation.toolDefinitions),
  );
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }
  applyPassthroughAttributes(attrs, invocation.passthroughAttributes);

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

export function applyErrorAttributes(
  span: Span,
  error: GenAIError,
): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  if (span.isRecording()) {
    span.setAttribute(ERROR_TYPE, error.type);
  }
}
