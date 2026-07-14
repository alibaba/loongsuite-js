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

export enum ContentCapturingMode {
  NO_CONTENT = 0,
  SPAN_ONLY = 1,
  EVENT_ONLY = 2,
  SPAN_AND_EVENT = 3,
}

export interface ToolCall {
  type: "tool_call";
  arguments: unknown;
  name: string;
  id: string | null;
}

export interface ToolCallResponse {
  type: "tool_call_response";
  response: unknown;
  id: string | null;
}

export interface Text {
  type: "text";
  content: string;
}

export interface Reasoning {
  type: "reasoning";
  content: string;
}

export type Modality = "image" | "video" | "audio";

export interface Blob {
  type: "blob";
  mimeType: string | null;
  modality: Modality | string;
  content: Uint8Array;
}

export interface GenAIFile {
  type: "file";
  mimeType: string | null;
  modality: Modality | string;
  fileId: string;
}

export interface Uri {
  type: "uri";
  mimeType: string | null;
  modality: Modality | string;
  uri: string;
}

export interface Base64Blob {
  type: "base64_blob";
  mimeType: string | null;
  modality: Modality | string;
  content: string;
}

export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description: string | null;
  parameters: unknown;
}

export interface GenericToolDefinition {
  type: string;
  name: string;
}

export type ToolDefinition = FunctionToolDefinition | GenericToolDefinition;

export type MessagePart =
  | Text
  | ToolCall
  | ToolCallResponse
  | Blob
  | GenAIFile
  | Uri
  | Reasoning
  | Base64Blob
  | Record<string, unknown>;

export type FinishReason =
  | "content_filter"
  | "error"
  | "length"
  | "stop"
  | "tool_calls";

export interface InputMessage {
  role: string;
  parts: MessagePart[];
}

export interface OutputMessage {
  role: string;
  parts: MessagePart[];
  finishReason: string | FinishReason;
}

export interface GenAIError {
  message: string;
  type: string;
}

export interface GenAIInvocation {
  contextToken?: Context | null;
  span?: Span | null;
  attributes?: Record<string, unknown>;
}

export interface LLMInvocation extends GenAIInvocation {
  requestModel?: string | null;
  operationName?: string;
  inputMessages?: InputMessage[];
  outputMessages?: OutputMessage[];
  systemInstruction?: MessagePart[];
  toolDefinitions?: ToolDefinition[];
  provider?: string | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  agentName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  // Pass-through attributes written with fill-only semantics (never override
  // managed attributes). Optional.
  passthroughAttributes?: Record<string, unknown>;
  responseModelName?: string | null;
  responseId?: string | null;
  finishReasons?: string[] | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  // Upstream-reported total tokens. When set, it is written verbatim; otherwise
  // total is computed as inputTokens + outputTokens.
  totalTokens?: number | null;
  metricAttributes?: Record<string, unknown>;
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  maxTokens?: number | null;
  stopSequences?: string[] | null;
  seed?: number | null;
  serverAddress?: string | null;
  serverPort?: number | null;
  conversationId?: string | null;
  outputType?: string | null;
  choiceCount?: number | null;
  topK?: number | null;
  usageCacheCreationInputTokens?: number | null;
  usageCacheReadInputTokens?: number | null;
  monotonicStartS?: number | null;
  monotonicEndS?: number | null;
  monotonicFirstTokenS?: number | null;
}

export function createLLMInvocation(
  init?: Partial<LLMInvocation>,
): LLMInvocation {
  return {
    operationName: "chat",
    inputMessages: [],
    outputMessages: [],
    systemInstruction: [],
    toolDefinitions: [],
    attributes: {},
    metricAttributes: {},
    ...init,
  };
}
