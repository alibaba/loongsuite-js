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

import type { Span } from "@opentelemetry/api";
import type { GenAIError } from "./types.js";
import { ContentCapturingMode } from "./types.js";
import type {
  EmbeddingInvocation,
  CreateAgentInvocation,
  ExecuteToolInvocation,
  InvokeAgentInvocation,
  RetrievalInvocation,
  RetrievalDocument,
  RerankInvocation,
  EntryInvocation,
  ReactStepInvocation,
} from "./extended-types.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_SPAN_KIND,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_REQUEST_TOP_K,
  GEN_AI_REQUEST_FREQUENCY_PENALTY,
  GEN_AI_REQUEST_PRESENCE_PENALTY,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_SEED,
  GEN_AI_REQUEST_STOP_SEQUENCES,
  GEN_AI_REQUEST_ENCODING_FORMATS,
  GEN_AI_REQUEST_CHOICE_COUNT,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_OUTPUT_TYPE,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_AGENT_DESCRIPTION,
  GEN_AI_DATA_SOURCE_ID,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_DESCRIPTION,
  GEN_AI_TOOL_TYPE,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_SKILL_ID,
  GEN_AI_SKILL_NAME,
  GEN_AI_SKILL_VERSION,
  GEN_AI_SKILL_DESCRIPTION,
  GEN_AI_EMBEDDINGS_DIMENSION_COUNT,
  GEN_AI_RETRIEVAL_QUERY_TEXT,
  GEN_AI_RETRIEVAL_DOCUMENTS,
  GEN_AI_RERANK_DOCUMENTS_COUNT,
  GEN_AI_RERANK_SCORING_PROMPT,
  GEN_AI_RERANK_RETURN_DOCUMENTS,
  GEN_AI_RERANK_MAX_CHUNKS_PER_DOC,
  GEN_AI_RERANK_DEVICE,
  GEN_AI_RERANK_BATCH_SIZE,
  GEN_AI_RERANK_MAX_LENGTH,
  GEN_AI_RERANK_NORMALIZE,
  GEN_AI_RERANK_INPUT_DOCUMENTS,
  GEN_AI_RERANK_OUTPUT_DOCUMENTS,
  GEN_AI_SESSION_ID,
  GEN_AI_USER_ID,
  GEN_AI_REACT_FINISH_REASON,
  GEN_AI_REACT_ROUND,
  SERVER_ADDRESS,
  SERVER_PORT,
  ERROR_TYPE,
  GenAiSpanKindValues,
  GenAiOperationNameValues,
  GenAiExtendedOperationNameValues,
} from "./semconv/gen-ai-extended-attributes.js";
import {
  applyCommonGenAiAttributes,
  applyPassthroughAttributes,
  getLlmMessagesAttributesForSpan,
  getToolDefinitionsForSpan,
  type EventLogger,
} from "./span-utils.js";
import {
  isExperimentalMode,
  getContentCapturingMode,
  shouldEmitEvent,
  genAiJsonDumps,
  shouldCaptureContentInSpan,
} from "./utils.js";

// ==================== Embedding ====================

export function applyEmbeddingFinishAttributes(
  span: Span,
  invocation: EmbeddingInvocation,
): void {
  span.updateName(
    `${GenAiOperationNameValues.EMBEDDINGS} ${invocation.requestModel}`.trim(),
  );

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiOperationNameValues.EMBEDDINGS,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.EMBEDDING,
  };

  if (invocation.requestModel) {
    attrs[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
  }
  if (invocation.provider != null) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.serverPort != null) {
    attrs[SERVER_PORT] = invocation.serverPort;
  }
  if (invocation.dimensionCount != null) {
    attrs[GEN_AI_EMBEDDINGS_DIMENSION_COUNT] = invocation.dimensionCount;
  }
  if (invocation.encodingFormats != null) {
    attrs[GEN_AI_REQUEST_ENCODING_FORMATS] = invocation.encodingFormats;
  }
  if (invocation.inputTokens != null) {
    attrs[GEN_AI_USAGE_INPUT_TOKENS] = invocation.inputTokens;
    attrs[GEN_AI_USAGE_TOTAL_TOKENS] = invocation.inputTokens;
  }
  if (invocation.serverAddress != null) {
    attrs[SERVER_ADDRESS] = invocation.serverAddress;
  }
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

// ==================== Create Agent ====================

export function applyCreateAgentFinishAttributes(
  span: Span,
  invocation: CreateAgentInvocation,
): void {
  span.updateName(
    `${GenAiOperationNameValues.CREATE_AGENT} ${invocation.agentName ?? ""}`.trim(),
  );

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiOperationNameValues.CREATE_AGENT,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.AGENT,
  };

  if (invocation.provider) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.agentDescription != null) {
    attrs[GEN_AI_AGENT_DESCRIPTION] = invocation.agentDescription;
  }
  if (invocation.agentId != null) {
    attrs[GEN_AI_AGENT_ID] = invocation.agentId;
  }
  if (invocation.agentName != null) {
    attrs[GEN_AI_AGENT_NAME] = invocation.agentName;
  }
  if (invocation.requestModel != null) {
    attrs[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
  }
  if (invocation.serverPort != null) {
    attrs[SERVER_PORT] = invocation.serverPort;
  }
  if (invocation.serverAddress != null) {
    attrs[SERVER_ADDRESS] = invocation.serverAddress;
  }
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

// ==================== Execute Tool ====================

function getToolCallDataAttributes(
  toolCallArguments: unknown,
  toolCallResult: unknown,
): Record<string, unknown> {
  if (!isExperimentalMode() || !shouldCaptureContentInSpan()) return {};

  const attrs: Record<string, unknown> = {};
  if (toolCallArguments != null) {
    attrs[GEN_AI_TOOL_CALL_ARGUMENTS] =
      typeof toolCallArguments === "string"
        ? toolCallArguments
        : genAiJsonDumps(toolCallArguments);
  }
  if (toolCallResult != null) {
    attrs[GEN_AI_TOOL_CALL_RESULT] =
      typeof toolCallResult === "string"
        ? toolCallResult
        : genAiJsonDumps(toolCallResult);
  }
  return attrs;
}

export function applyExecuteToolFinishAttributes(
  span: Span,
  invocation: ExecuteToolInvocation,
): void {
  span.updateName(
    `${GenAiOperationNameValues.EXECUTE_TOOL} ${invocation.toolName}`.trim(),
  );

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiOperationNameValues.EXECUTE_TOOL,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.TOOL,
  };

  if (invocation.toolCallId != null) {
    attrs[GEN_AI_TOOL_CALL_ID] = invocation.toolCallId;
  }
  if (invocation.toolDescription != null) {
    attrs[GEN_AI_TOOL_DESCRIPTION] = invocation.toolDescription;
  }
  if (invocation.toolName) {
    attrs[GEN_AI_TOOL_NAME] = invocation.toolName;
  }
  if (invocation.toolType != null) {
    attrs[GEN_AI_TOOL_TYPE] = invocation.toolType;
  }
  if (invocation.skillId != null) {
    attrs[GEN_AI_SKILL_ID] = invocation.skillId;
  }
  if (invocation.skillName != null) {
    attrs[GEN_AI_SKILL_NAME] = invocation.skillName;
  }
  if (invocation.skillVersion != null) {
    attrs[GEN_AI_SKILL_VERSION] = invocation.skillVersion;
  }
  if (invocation.skillDescription != null) {
    attrs[GEN_AI_SKILL_DESCRIPTION] = invocation.skillDescription;
  }

  Object.assign(
    attrs,
    getToolCallDataAttributes(
      invocation.toolCallArguments,
      invocation.toolCallResult,
    ),
  );
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }
  applyPassthroughAttributes(attrs, invocation.passthroughAttributes);

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

// ==================== Invoke Agent ====================

function getInvokeAgentSpanName(invocation: InvokeAgentInvocation): string {
  if (invocation.agentName) {
    return `${GenAiOperationNameValues.INVOKE_AGENT} ${invocation.agentName}`.trim();
  }
  return GenAiOperationNameValues.INVOKE_AGENT;
}

export function applyInvokeAgentFinishAttributes(
  span: Span,
  invocation: InvokeAgentInvocation,
): void {
  span.updateName(getInvokeAgentSpanName(invocation));

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiOperationNameValues.INVOKE_AGENT,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.AGENT,
  };

  if (invocation.provider) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.agentDescription != null) {
    attrs[GEN_AI_AGENT_DESCRIPTION] = invocation.agentDescription;
  }
  if (invocation.agentId != null) {
    attrs[GEN_AI_AGENT_ID] = invocation.agentId;
  }
  if (invocation.agentName != null) {
    attrs[GEN_AI_AGENT_NAME] = invocation.agentName;
  }
  if (invocation.conversationId != null) {
    attrs[GEN_AI_CONVERSATION_ID] = invocation.conversationId;
  }
  if (invocation.dataSourceId != null) {
    attrs[GEN_AI_DATA_SOURCE_ID] = invocation.dataSourceId;
  }
  if (invocation.requestModel != null) {
    attrs[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
  }

  // Request attributes
  if (invocation.temperature != null) {
    attrs[GEN_AI_REQUEST_TEMPERATURE] = invocation.temperature;
  }
  if (invocation.topP != null) {
    attrs[GEN_AI_REQUEST_TOP_P] = invocation.topP;
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
  if (invocation.seed != null) {
    attrs[GEN_AI_REQUEST_SEED] = invocation.seed;
  }
  if (invocation.stopSequences != null) {
    attrs[GEN_AI_REQUEST_STOP_SEQUENCES] = invocation.stopSequences;
  }

  // Response attributes
  if (invocation.finishReasons != null) {
    attrs[GEN_AI_RESPONSE_FINISH_REASONS] = invocation.finishReasons;
  }
  if (invocation.responseId != null) {
    attrs[GEN_AI_RESPONSE_ID] = invocation.responseId;
  }
  if (invocation.responseModelName != null) {
    attrs[GEN_AI_RESPONSE_MODEL] = invocation.responseModelName;
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
    attrs[GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN] = Math.round(
      (invocation.monotonicFirstTokenS - invocation.monotonicStartS) * 1e9,
    );
  }

  // Additional span-specific attributes
  if (invocation.outputType != null) {
    attrs[GEN_AI_OUTPUT_TYPE] = invocation.outputType;
  }
  if (invocation.choiceCount != null && invocation.choiceCount !== 1) {
    attrs[GEN_AI_REQUEST_CHOICE_COUNT] = invocation.choiceCount;
  }
  if (invocation.serverPort != null) {
    attrs[SERVER_PORT] = invocation.serverPort;
  }
  if (invocation.serverAddress != null) {
    attrs[SERVER_ADDRESS] = invocation.serverAddress;
  }

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

export function maybeEmitInvokeAgentEvent(
  logger: EventLogger | null | undefined,
  span: Span,
  invocation: InvokeAgentInvocation,
  error?: GenAIError | null,
): void {
  if (!isExperimentalMode() || !shouldEmitEvent() || !logger) return;

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiOperationNameValues.INVOKE_AGENT,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.AGENT,
  };
  if (invocation.provider) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.agentName != null) {
    attrs[GEN_AI_AGENT_NAME] = invocation.agentName;
  }

  if (error) {
    attrs[ERROR_TYPE] = error.type;
  }

  logger.emit({
    name: "gen_ai.client.agent.invoke.operation.details",
    attributes: attrs,
  });
}

// ==================== Retrieval ====================

function getRetrievalDocumentsAttributes(
  documents: RetrievalDocument[] | undefined,
): Record<string, unknown> {
  if (!isExperimentalMode() || !documents?.length) return {};

  const mode = getContentCapturingMode();
  const shouldRecordFull =
    mode === ContentCapturingMode.SPAN_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT;

  const dicts = documents.map((doc) => {
    if (shouldRecordFull) {
      return { ...doc };
    }
    return { id: doc.id, score: doc.score };
  });

  return { [GEN_AI_RETRIEVAL_DOCUMENTS]: genAiJsonDumps(dicts) };
}

export function applyRetrievalFinishAttributes(
  span: Span,
  invocation: RetrievalInvocation,
): void {
  const opName = GenAiExtendedOperationNameValues.RETRIEVAL;
  const spanName = invocation.dataSourceId
    ? `${opName} ${invocation.dataSourceId}`.trim()
    : opName;
  span.updateName(spanName);

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: opName,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.RETRIEVER,
  };

  if (invocation.dataSourceId != null) {
    attrs[GEN_AI_DATA_SOURCE_ID] = invocation.dataSourceId;
  }
  if (invocation.provider != null) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.requestModel != null) {
    attrs[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
  }
  if (invocation.topK != null) {
    attrs[GEN_AI_REQUEST_TOP_K] = invocation.topK;
  }
  if (
    invocation.query != null &&
    isExperimentalMode() &&
    shouldCaptureContentInSpan()
  ) {
    attrs[GEN_AI_RETRIEVAL_QUERY_TEXT] = invocation.query;
  }
  if (invocation.serverAddress != null) {
    attrs[SERVER_ADDRESS] = invocation.serverAddress;
  }
  if (invocation.serverPort != null) {
    attrs[SERVER_PORT] = invocation.serverPort;
  }

  Object.assign(attrs, getRetrievalDocumentsAttributes(invocation.documents));
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

// ==================== Rerank ====================

function getRerankDocumentsAttributes(
  inputDocuments: unknown,
  outputDocuments: unknown,
): Record<string, unknown> {
  if (!isExperimentalMode() || !shouldCaptureContentInSpan()) return {};

  const attrs: Record<string, unknown> = {};
  if (inputDocuments != null) {
    attrs[GEN_AI_RERANK_INPUT_DOCUMENTS] =
      typeof inputDocuments === "string"
        ? inputDocuments
        : genAiJsonDumps(inputDocuments);
  }
  if (outputDocuments != null) {
    attrs[GEN_AI_RERANK_OUTPUT_DOCUMENTS] =
      typeof outputDocuments === "string"
        ? outputDocuments
        : genAiJsonDumps(outputDocuments);
  }
  return attrs;
}

export function applyRerankFinishAttributes(
  span: Span,
  invocation: RerankInvocation,
): void {
  span.updateName(
    `${GenAiExtendedOperationNameValues.RERANK_DOCUMENTS} ${invocation.requestModel ?? ""}`.trim(),
  );

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiExtendedOperationNameValues.RERANK_DOCUMENTS,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.RERANKER,
  };

  if (invocation.provider) {
    attrs[GEN_AI_PROVIDER_NAME] = invocation.provider;
  }
  if (invocation.requestModel != null) {
    attrs[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
  }
  if (invocation.topK != null) {
    attrs[GEN_AI_REQUEST_TOP_K] = invocation.topK;
  }
  if (invocation.documentsCount != null) {
    attrs[GEN_AI_RERANK_DOCUMENTS_COUNT] = invocation.documentsCount;
  }
  if (invocation.temperature != null) {
    attrs[GEN_AI_REQUEST_TEMPERATURE] = invocation.temperature;
  }
  if (invocation.maxTokens != null) {
    attrs[GEN_AI_REQUEST_MAX_TOKENS] = invocation.maxTokens;
  }
  if (invocation.scoringPrompt != null) {
    attrs[GEN_AI_RERANK_SCORING_PROMPT] = invocation.scoringPrompt;
  }
  if (invocation.returnDocuments != null) {
    attrs[GEN_AI_RERANK_RETURN_DOCUMENTS] = invocation.returnDocuments;
  }
  if (invocation.maxChunksPerDoc != null) {
    attrs[GEN_AI_RERANK_MAX_CHUNKS_PER_DOC] = invocation.maxChunksPerDoc;
  }
  if (invocation.device != null) {
    attrs[GEN_AI_RERANK_DEVICE] = invocation.device;
  }
  if (invocation.batchSize != null) {
    attrs[GEN_AI_RERANK_BATCH_SIZE] = invocation.batchSize;
  }
  if (invocation.maxLength != null) {
    attrs[GEN_AI_RERANK_MAX_LENGTH] = invocation.maxLength;
  }
  if (invocation.normalize != null) {
    attrs[GEN_AI_RERANK_NORMALIZE] = invocation.normalize;
  }

  Object.assign(
    attrs,
    getRerankDocumentsAttributes(
      invocation.inputDocuments,
      invocation.outputDocuments,
    ),
  );
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

// ==================== Entry ====================

export function applyEntryFinishAttributes(
  span: Span,
  invocation: EntryInvocation,
): void {
  span.updateName("enter_ai_application_system");

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiExtendedOperationNameValues.ENTER,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.ENTRY,
  };

  if (invocation.sessionId != null) {
    attrs[GEN_AI_SESSION_ID] = invocation.sessionId;
  }
  if (invocation.userId != null) {
    attrs[GEN_AI_USER_ID] = invocation.userId;
  }
  if (invocation.responseTimeToFirstToken != null) {
    attrs[GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN] =
      invocation.responseTimeToFirstToken;
  }

  Object.assign(
    attrs,
    getLlmMessagesAttributesForSpan(
      invocation.inputMessages ?? [],
      invocation.outputMessages ?? [],
    ),
  );
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }
  applyPassthroughAttributes(attrs, invocation.passthroughAttributes);

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

// ==================== ReAct Step ====================

export function applyReactStepFinishAttributes(
  span: Span,
  invocation: ReactStepInvocation,
): void {
  span.updateName("react step");

  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: GenAiExtendedOperationNameValues.REACT,
    [GEN_AI_SPAN_KIND]: GenAiSpanKindValues.STEP,
  };

  if (invocation.finishReason != null) {
    attrs[GEN_AI_REACT_FINISH_REASON] = invocation.finishReason;
  }
  if (invocation.round != null) {
    attrs[GEN_AI_REACT_ROUND] = invocation.round;
  }
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }
  applyPassthroughAttributes(attrs, invocation.passthroughAttributes);

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}
