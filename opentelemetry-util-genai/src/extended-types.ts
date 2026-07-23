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
import type {
  InputMessage,
  MessagePart,
  OutputMessage,
  ToolDefinition,
} from "./types.js";

export interface RetrievalDocument {
  id: string | null;
  score: number | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EmbeddingInvocation {
  requestModel: string;
  contextToken?: Context | null;
  span?: Span | null;
  provider?: string | null;
  responseModelName?: string | null;
  responseId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  attributes?: Record<string, unknown>;
  dimensionCount?: number | null;
  encodingFormats?: string[] | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

export function createEmbeddingInvocation(
  requestModel: string,
  init?: Partial<EmbeddingInvocation>,
): EmbeddingInvocation {
  return { requestModel, attributes: {}, ...init };
}

export interface ExecuteToolInvocation {
  toolName: string;
  contextToken?: Context | null;
  span?: Span | null;
  provider?: string | null;
  attributes?: Record<string, unknown>;
  toolCallId?: string | null;
  toolDescription?: string | null;
  toolType?: string | null;
  toolCallArguments?: unknown;
  toolCallResult?: unknown;
  skillId?: string | null;
  skillName?: string | null;
  skillVersion?: string | null;
  skillDescription?: string | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  passthroughAttributes?: Record<string, unknown>;
}

export function createExecuteToolInvocation(
  toolName: string,
  init?: Partial<ExecuteToolInvocation>,
): ExecuteToolInvocation {
  return { toolName, attributes: {}, ...init };
}

export interface CreateAgentInvocation {
  provider: string;
  contextToken?: Context | null;
  span?: Span | null;
  agentName?: string | null;
  attributes?: Record<string, unknown>;
  agentId?: string | null;
  agentDescription?: string | null;
  requestModel?: string | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  // agentName already declared above; only userId/sessionId are new.
  userId?: string | null;
  sessionId?: string | null;
}

export function createCreateAgentInvocation(
  provider: string,
  init?: Partial<CreateAgentInvocation>,
): CreateAgentInvocation {
  return { provider, attributes: {}, ...init };
}

export interface InvokeAgentInvocation {
  provider: string;
  contextToken?: Context | null;
  span?: Span | null;
  agentName?: string | null;
  inputMessages?: InputMessage[];
  outputMessages?: OutputMessage[];
  toolDefinitions?: ToolDefinition[];
  systemInstruction?: MessagePart[];
  attributes?: Record<string, unknown>;
  agentId?: string | null;
  agentDescription?: string | null;
  conversationId?: string | null;
  dataSourceId?: string | null;
  requestModel?: string | null;
  responseModelName?: string | null;
  responseId?: string | null;
  finishReasons?: string[] | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  // Upstream-reported total tokens. When set, it is written verbatim; otherwise
  // total is computed as inputTokens + outputTokens.
  totalTokens?: number | null;
  usageCacheCreationInputTokens?: number | null;
  usageCacheReadInputTokens?: number | null;
  outputType?: string | null;
  choiceCount?: number | null;
  seed?: number | null;
  frequencyPenalty?: number | null;
  maxTokens?: number | null;
  presencePenalty?: number | null;
  stopSequences?: string[] | null;
  temperature?: number | null;
  topP?: number | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  monotonicStartS?: number | null;
  monotonicEndS?: number | null;
  monotonicFirstTokenS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  // agentName already declared above; only userId/sessionId are new.
  userId?: string | null;
  sessionId?: string | null;
  passthroughAttributes?: Record<string, unknown>;
}

export function createInvokeAgentInvocation(
  provider: string,
  init?: Partial<InvokeAgentInvocation>,
): InvokeAgentInvocation {
  return {
    provider,
    inputMessages: [],
    outputMessages: [],
    toolDefinitions: [],
    systemInstruction: [],
    attributes: {},
    ...init,
  };
}

export interface RetrievalInvocation {
  contextToken?: Context | null;
  span?: Span | null;
  attributes?: Record<string, unknown>;
  query?: string | null;
  documents?: RetrievalDocument[];
  dataSourceId?: string | null;
  provider?: string | null;
  requestModel?: string | null;
  topK?: number | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

export function createRetrievalInvocation(
  init?: Partial<RetrievalInvocation>,
): RetrievalInvocation {
  return { documents: [], attributes: {}, ...init };
}

export interface RerankInvocation {
  provider: string;
  contextToken?: Context | null;
  span?: Span | null;
  requestModel?: string | null;
  attributes?: Record<string, unknown>;
  topK?: number | null;
  documentsCount?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  scoringPrompt?: string | null;
  returnDocuments?: boolean | null;
  maxChunksPerDoc?: number | null;
  device?: string | null;
  batchSize?: number | null;
  maxLength?: number | null;
  normalize?: boolean | null;
  inputDocuments?: unknown;
  outputDocuments?: unknown;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

export function createRerankInvocation(
  provider: string,
  init?: Partial<RerankInvocation>,
): RerankInvocation {
  return { provider, attributes: {}, ...init };
}

export interface EntryInvocation {
  contextToken?: Context | null;
  span?: Span | null;
  attributes?: Record<string, unknown>;
  sessionId?: string | null;
  userId?: string | null;
  inputMessages?: InputMessage[];
  outputMessages?: OutputMessage[];
  responseTimeToFirstToken?: number | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  // sessionId/userId already declared above; only agentName is new.
  agentName?: string | null;
  passthroughAttributes?: Record<string, unknown>;
}

export function createEntryInvocation(
  init?: Partial<EntryInvocation>,
): EntryInvocation {
  return { inputMessages: [], outputMessages: [], attributes: {}, ...init };
}

export interface ReactStepInvocation {
  contextToken?: Context | null;
  span?: Span | null;
  attributes?: Record<string, unknown>;
  finishReason?: string | null;
  round?: number | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  passthroughAttributes?: Record<string, unknown>;
}

export function createReactStepInvocation(
  init?: Partial<ReactStepInvocation>,
): ReactStepInvocation {
  return { attributes: {}, ...init };
}
