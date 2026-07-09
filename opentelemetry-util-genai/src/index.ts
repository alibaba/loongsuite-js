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

// Version
export { VERSION } from "./version.js";

// Types
export type {
  GenAIInvocation,
  LLMInvocation,
  GenAIError,
  InputMessage,
  OutputMessage,
  MessagePart,
  Text,
  Reasoning,
  ToolCall,
  ToolCallResponse,
  Blob,
  GenAIFile,
  Uri,
  Base64Blob,
  FunctionToolDefinition,
  GenericToolDefinition,
  ToolDefinition,
  Modality,
  FinishReason,
} from "./types.js";
export { ContentCapturingMode, createLLMInvocation } from "./types.js";

// Extended Types
export type {
  RetrievalDocument,
  EmbeddingInvocation,
  ExecuteToolInvocation,
  CreateAgentInvocation,
  InvokeAgentInvocation,
  RetrievalInvocation,
  RerankInvocation,
  EntryInvocation,
  ReactStepInvocation,
} from "./extended-types.js";
export {
  createEmbeddingInvocation,
  createExecuteToolInvocation,
  createCreateAgentInvocation,
  createInvokeAgentInvocation,
  createRetrievalInvocation,
  createRerankInvocation,
  createEntryInvocation,
  createReactStepInvocation,
} from "./extended-types.js";

// Memory Types
export type { MemoryInvocation } from "./memory/memory-types.js";
export { createMemoryInvocation } from "./memory/memory-types.js";

// Handlers
export {
  TelemetryHandler,
  getTelemetryHandler,
  type TelemetryHandlerOptions,
} from "./handler.js";
export {
  ExtendedTelemetryHandler,
  getExtendedTelemetryHandler,
} from "./extended-handler.js";

// Utilities
export {
  isExperimentalMode,
  getContentCapturingMode,
  shouldEmitEvent,
  shouldCaptureContentInSpan,
  shouldCaptureContentInEvent,
  genAiJsonDumps,
} from "./utils.js";

// Instruments
export {
  createDurationHistogram,
  createTokenHistogram,
} from "./instruments.js";

// Metrics
export { InvocationMetricsRecorder } from "./metrics.js";
export { ExtendedInvocationMetricsRecorder } from "./extended-metrics.js";

// Span Utils
export {
  applyCommonGenAiAttributes,
  applyPassthroughAttributes,
  getLlmCommonAttributes,
  getLlmSpanName,
  getLlmRequestAttributes,
  getLlmResponseAttributes,
  getLlmMessagesAttributesForSpan,
  getToolDefinitionsForSpan,
  applyLlmFinishAttributes,
  applyErrorAttributes,
  maybeEmitLlmEvent,
  type EventLogger,
} from "./span-utils.js";

// Extended Span Utils
export {
  applyEmbeddingFinishAttributes,
  applyCreateAgentFinishAttributes,
  applyExecuteToolFinishAttributes,
  applyInvokeAgentFinishAttributes,
  maybeEmitInvokeAgentEvent,
  applyRetrievalFinishAttributes,
  applyRerankFinishAttributes,
  applyEntryFinishAttributes,
  applyReactStepFinishAttributes,
} from "./extended-span-utils.js";

// Memory Utils
export {
  applyMemoryFinishAttributes,
  maybeEmitMemoryEvent,
} from "./memory/memory-utils.js";

// Semantic Conventions
export * from "./semconv/gen-ai-extended-attributes.js";
export * from "./semconv/gen-ai-memory-attributes.js";

// Environment Variables
export * from "./environment-variables.js";
export * from "./extended-environment-variables.js";

// Event Log → Trace conversion
export * from "./event-log/index.js";
