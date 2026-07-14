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
import type { GenAIError } from "../types.js";
import { applyCommonGenAiAttributes } from "../span-utils.js";
import type { MemoryInvocation } from "./memory-types.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_SPAN_KIND,
  SERVER_ADDRESS,
  SERVER_PORT,
  ERROR_TYPE,
  GenAiSpanKindValues,
} from "../semconv/gen-ai-extended-attributes.js";
import {
  GEN_AI_MEMORY_OPERATION,
  GEN_AI_MEMORY_USER_ID,
  GEN_AI_MEMORY_AGENT_ID,
  GEN_AI_MEMORY_RUN_ID,
  GEN_AI_MEMORY_APP_ID,
  GEN_AI_MEMORY_ID,
  GEN_AI_MEMORY_LIMIT,
  GEN_AI_MEMORY_PAGE,
  GEN_AI_MEMORY_PAGE_SIZE,
  GEN_AI_MEMORY_TOP_K,
  GEN_AI_MEMORY_MEMORY_TYPE,
  GEN_AI_MEMORY_THRESHOLD,
  GEN_AI_MEMORY_RERANK,
  GEN_AI_MEMORY_INPUT_MESSAGES,
  GEN_AI_MEMORY_OUTPUT_MESSAGES,
} from "../semconv/gen-ai-memory-attributes.js";
import type { EventLogger } from "../span-utils.js";
import {
  isExperimentalMode,
  shouldEmitEvent,
  shouldCaptureContentInSpan,
  shouldCaptureContentInEvent,
  genAiJsonDumps,
} from "../utils.js";

function getMemoryCommonAttributes(
  invocation: MemoryInvocation,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    [GEN_AI_OPERATION_NAME]: "memory_operation",
    [GEN_AI_MEMORY_OPERATION]: invocation.operation,
  };

  if (invocation.userId != null) {
    attrs[GEN_AI_MEMORY_USER_ID] = invocation.userId;
  }
  if (invocation.agentId != null) {
    attrs[GEN_AI_MEMORY_AGENT_ID] = invocation.agentId;
  }
  if (invocation.runId != null) {
    attrs[GEN_AI_MEMORY_RUN_ID] = invocation.runId;
  }
  if (invocation.appId != null) {
    attrs[GEN_AI_MEMORY_APP_ID] = invocation.appId;
  }
  return attrs;
}

function getMemoryParameterAttributes(
  invocation: MemoryInvocation,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};

  if (invocation.memoryId != null) {
    attrs[GEN_AI_MEMORY_ID] = invocation.memoryId;
  }
  if (invocation.limit != null) {
    attrs[GEN_AI_MEMORY_LIMIT] = invocation.limit;
  }
  if (invocation.page != null) {
    attrs[GEN_AI_MEMORY_PAGE] = invocation.page;
  }
  if (invocation.pageSize != null) {
    attrs[GEN_AI_MEMORY_PAGE_SIZE] = invocation.pageSize;
  }
  if (invocation.topK != null) {
    attrs[GEN_AI_MEMORY_TOP_K] = invocation.topK;
  }
  if (invocation.memoryType != null) {
    attrs[GEN_AI_MEMORY_MEMORY_TYPE] = invocation.memoryType;
  }
  if (invocation.threshold != null) {
    attrs[GEN_AI_MEMORY_THRESHOLD] = invocation.threshold;
  }
  if (invocation.rerank != null) {
    attrs[GEN_AI_MEMORY_RERANK] = invocation.rerank;
  }
  return attrs;
}

function getMemoryContentAttributes(
  invocation: MemoryInvocation,
  forSpan: boolean,
): Record<string, unknown> {
  if (!isExperimentalMode()) return {};

  if (forSpan && !shouldCaptureContentInSpan()) return {};
  if (!forSpan && !shouldCaptureContentInEvent()) return {};

  const attrs: Record<string, unknown> = {};
  if (invocation.inputMessages != null) {
    attrs[GEN_AI_MEMORY_INPUT_MESSAGES] =
      typeof invocation.inputMessages === "string"
        ? invocation.inputMessages
        : genAiJsonDumps(invocation.inputMessages);
  }
  if (invocation.outputMessages != null) {
    attrs[GEN_AI_MEMORY_OUTPUT_MESSAGES] =
      typeof invocation.outputMessages === "string"
        ? invocation.outputMessages
        : genAiJsonDumps(invocation.outputMessages);
  }
  return attrs;
}

export function applyMemoryFinishAttributes(
  span: Span,
  invocation: MemoryInvocation,
): void {
  span.updateName(
    invocation.operation
      ? `memory_operation ${invocation.operation}`
      : "memory_operation",
  );
  span.setAttribute(GEN_AI_SPAN_KIND, GenAiSpanKindValues.MEMORY);

  const attrs: Record<string, unknown> = {};
  Object.assign(attrs, getMemoryCommonAttributes(invocation));
  Object.assign(attrs, getMemoryParameterAttributes(invocation));

  if (invocation.serverAddress != null) {
    attrs[SERVER_ADDRESS] = invocation.serverAddress;
  }
  if (invocation.serverPort != null) {
    attrs[SERVER_PORT] = invocation.serverPort;
  }
  Object.assign(attrs, getMemoryContentAttributes(invocation, true));
  applyCommonGenAiAttributes(attrs, invocation);
  if (invocation.attributes) {
    Object.assign(attrs, invocation.attributes);
  }

  span.setAttributes(attrs as Record<string, string | number | boolean>);
}

export function maybeEmitMemoryEvent(
  logger: EventLogger | null | undefined,
  span: Span,
  invocation: MemoryInvocation,
  error?: GenAIError | null,
): void {
  if (!isExperimentalMode() || !shouldEmitEvent() || !logger) return;

  const attrs: Record<string, unknown> = {};
  Object.assign(attrs, getMemoryCommonAttributes(invocation));
  Object.assign(attrs, getMemoryParameterAttributes(invocation));
  Object.assign(attrs, getMemoryContentAttributes(invocation, false));

  if (error) {
    attrs[ERROR_TYPE] = error.type;
  }

  logger.emit({
    name: "gen_ai.memory.operation.details",
    attributes: attrs,
  });
}
