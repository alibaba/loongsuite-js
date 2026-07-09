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

export interface MemoryInvocation {
  operation: string;
  contextToken?: Context | null;
  span?: Span | null;
  attributes?: Record<string, unknown>;
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  appId?: string | null;
  memoryId?: string | null;
  limit?: number | null;
  page?: number | null;
  pageSize?: number | null;
  topK?: number | null;
  memoryType?: string | null;
  threshold?: number | null;
  rerank?: boolean | null;
  inputMessages?: unknown;
  outputMessages?: unknown;
  serverAddress?: string | null;
  serverPort?: number | null;
  monotonicStartS?: number | null;
  // ARMS GenAI common attributes (apply to all spans). All optional.
  // userId already declared above; only agentName/sessionId are new.
  agentName?: string | null;
  sessionId?: string | null;
}

export function createMemoryInvocation(
  operation: string,
  init?: Partial<MemoryInvocation>,
): MemoryInvocation {
  return { operation, attributes: {}, ...init };
}
