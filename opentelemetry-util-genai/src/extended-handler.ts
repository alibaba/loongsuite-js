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

import {
  trace,
  metrics,
  context,
  SpanKind,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { TelemetryHandler, type TelemetryHandlerOptions } from "./handler.js";
import {
  applyErrorAttributes,
  backfillCommonFromBaggage,
  setCommonBaggage,
} from "./span-utils.js";
import type { GenAIError } from "./types.js";
import type {
  CreateAgentInvocation,
  EmbeddingInvocation,
  ExecuteToolInvocation,
  InvokeAgentInvocation,
  RetrievalInvocation,
  RerankInvocation,
  EntryInvocation,
  ReactStepInvocation,
} from "./extended-types.js";
import {
  createCreateAgentInvocation,
  createEmbeddingInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createRetrievalInvocation,
  createRerankInvocation,
  createEntryInvocation,
  createReactStepInvocation,
} from "./extended-types.js";
import type { MemoryInvocation } from "./memory/memory-types.js";
import { createMemoryInvocation } from "./memory/memory-types.js";
import {
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
import {
  applyMemoryFinishAttributes,
  maybeEmitMemoryEvent,
} from "./memory/memory-utils.js";
import { ExtendedInvocationMetricsRecorder } from "./extended-metrics.js";
import {
  GenAiOperationNameValues,
  GenAiExtendedOperationNameValues,
} from "./semconv/gen-ai-extended-attributes.js";
import { VERSION } from "./version.js";

const INSTRUMENTATION_NAME = "@loongsuite/otel-util-genai";

type AnyExtendedInvocation = {
  contextToken?: Context | null;
  span?: Span | null;
  monotonicStartS?: number | null;
};

function makeGenAIError(err: unknown): GenAIError {
  return {
    message: String(err),
    type: err instanceof Error ? err.constructor.name : "Error",
  };
}

export class ExtendedTelemetryHandler extends TelemetryHandler {
  private _extMetricsRecorder: ExtendedInvocationMetricsRecorder;

  constructor(options: TelemetryHandlerOptions = {}) {
    super(options);
    const scopeName = options.instrumentationName ?? INSTRUMENTATION_NAME;
    const scopeVersion = options.instrumentationVersion ?? VERSION;
    const meter = (options.meterProvider ?? metrics).getMeter(
      scopeName,
      scopeVersion,
    );
    this._extMetricsRecorder = new ExtendedInvocationMetricsRecorder(meter);
  }

  // ==================== Generic Helpers ====================

  private _startSpan<T extends AnyExtendedInvocation>(
    invocation: T,
    spanName: string,
    kind: SpanKind = SpanKind.CLIENT,
    parentContext?: Context,
    startTime?: number,
  ): T {
    const parent = parentContext ?? context.active();
    // Inherit ARMS GenAI common attributes (agent.name / user.id / session.id)
    // from the enclosing Entry/Agent span via baggage, unless already set.
    backfillCommonFromBaggage(
      invocation as {
        agentName?: string | null;
        userId?: string | null;
        sessionId?: string | null;
      },
      parent,
    );
    const span = this._tracer.startSpan(spanName, { kind, startTime }, parentContext);
    invocation.monotonicStartS = performance.now() / 1000;
    invocation.span = span;
    invocation.contextToken = trace.setSpan(parent, span);
    return invocation;
  }

  private _endSpan(inv: AnyExtendedInvocation, endTime?: number): void {
    inv.span?.end(endTime);
  }

  // ==================== Create Agent ====================

  startCreateAgent(
    invocation: CreateAgentInvocation,
    parentContext?: Context,
    startTime?: number,
  ): CreateAgentInvocation {
    const name = invocation.agentName
      ? `${GenAiOperationNameValues.CREATE_AGENT} ${invocation.agentName}`
      : GenAiOperationNameValues.CREATE_AGENT;
    this._startSpan(invocation, name, SpanKind.CLIENT, parentContext, startTime);
    if (invocation.contextToken) {
      invocation.contextToken = setCommonBaggage(invocation.contextToken, invocation);
    }
    return invocation;
  }

  stopCreateAgent(invocation: CreateAgentInvocation, endTime?: number): CreateAgentInvocation {
    if (!invocation.span) return invocation;
    applyCreateAgentFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failCreateAgent(
    invocation: CreateAgentInvocation,
    error: GenAIError,
    endTime?: number,
  ): CreateAgentInvocation {
    if (!invocation.span) return invocation;
    applyCreateAgentFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  createAgent<T>(
    invocationOrFn?: CreateAgentInvocation | null,
    fn?: (inv: CreateAgentInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<CreateAgentInvocation>
    : CreateAgentInvocation {
    return this._withInvocation(
      invocationOrFn ?? createCreateAgentInvocation(""),
      fn,
      (inv, ctx) => this.startCreateAgent(inv, ctx),
      (inv) => this.stopCreateAgent(inv),
      (inv, err) => this.failCreateAgent(inv, err),
    );
  }

  // ==================== Embedding ====================

  startEmbedding(
    invocation: EmbeddingInvocation,
    parentContext?: Context,
    startTime?: number,
  ): EmbeddingInvocation {
    return this._startSpan(
      invocation,
      `${GenAiOperationNameValues.EMBEDDINGS} ${invocation.requestModel}`,
      SpanKind.CLIENT,
      parentContext,
      startTime,
    );
  }

  stopEmbedding(invocation: EmbeddingInvocation, endTime?: number): EmbeddingInvocation {
    if (!invocation.span) return invocation;
    applyEmbeddingFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failEmbedding(
    invocation: EmbeddingInvocation,
    error: GenAIError,
    endTime?: number,
  ): EmbeddingInvocation {
    if (!invocation.span) return invocation;
    applyEmbeddingFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  embedding<T>(
    invocationOrFn?: EmbeddingInvocation | null,
    fn?: (inv: EmbeddingInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<EmbeddingInvocation>
    : EmbeddingInvocation {
    return this._withInvocation(
      invocationOrFn ?? createEmbeddingInvocation(""),
      fn,
      (inv, ctx) => this.startEmbedding(inv, ctx),
      (inv) => this.stopEmbedding(inv),
      (inv, err) => this.failEmbedding(inv, err),
    );
  }

  // ==================== Execute Tool ====================

  startExecuteTool(
    invocation: ExecuteToolInvocation,
    parentContext?: Context,
    startTime?: number,
  ): ExecuteToolInvocation {
    return this._startSpan(
      invocation,
      `${GenAiOperationNameValues.EXECUTE_TOOL} ${invocation.toolName}`,
      SpanKind.INTERNAL,
      parentContext,
      startTime,
    );
  }

  stopExecuteTool(invocation: ExecuteToolInvocation, endTime?: number): ExecuteToolInvocation {
    if (!invocation.span) return invocation;
    applyExecuteToolFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failExecuteTool(
    invocation: ExecuteToolInvocation,
    error: GenAIError,
    endTime?: number,
  ): ExecuteToolInvocation {
    if (!invocation.span) return invocation;
    applyExecuteToolFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  executeTool<T>(
    invocationOrFn?: ExecuteToolInvocation | null,
    fn?: (inv: ExecuteToolInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<ExecuteToolInvocation>
    : ExecuteToolInvocation {
    return this._withInvocation(
      invocationOrFn ?? createExecuteToolInvocation(""),
      fn,
      (inv, ctx) => this.startExecuteTool(inv, ctx),
      (inv) => this.stopExecuteTool(inv),
      (inv, err) => this.failExecuteTool(inv, err),
    );
  }

  // ==================== Invoke Agent ====================

  startInvokeAgent(
    invocation: InvokeAgentInvocation,
    parentContext?: Context,
    startTime?: number,
  ): InvokeAgentInvocation {
    const name = invocation.agentName
      ? `${GenAiOperationNameValues.INVOKE_AGENT} ${invocation.agentName}`
      : GenAiOperationNameValues.INVOKE_AGENT;
    this._startSpan(invocation, name, SpanKind.CLIENT, parentContext, startTime);
    // Publish common attributes to baggage so downstream GenAI spans inherit.
    if (invocation.contextToken) {
      invocation.contextToken = setCommonBaggage(invocation.contextToken, invocation);
    }
    return invocation;
  }

  stopInvokeAgent(invocation: InvokeAgentInvocation, endTime?: number): InvokeAgentInvocation {
    if (!invocation.span) return invocation;
    applyInvokeAgentFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    maybeEmitInvokeAgentEvent(this._logger, invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failInvokeAgent(
    invocation: InvokeAgentInvocation,
    error: GenAIError,
    endTime?: number,
  ): InvokeAgentInvocation {
    if (!invocation.span) return invocation;
    applyInvokeAgentFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    maybeEmitInvokeAgentEvent(
      this._logger,
      invocation.span,
      invocation,
      error,
    );
    this._endSpan(invocation, endTime);
    return invocation;
  }

  invokeAgent<T>(
    invocationOrFn?: InvokeAgentInvocation | null,
    fn?: (inv: InvokeAgentInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<InvokeAgentInvocation>
    : InvokeAgentInvocation {
    return this._withInvocation(
      invocationOrFn ?? createInvokeAgentInvocation(""),
      fn,
      (inv, ctx) => this.startInvokeAgent(inv, ctx),
      (inv) => this.stopInvokeAgent(inv),
      (inv, err) => this.failInvokeAgent(inv, err),
    );
  }

  // ==================== Retrieval ====================

  startRetrieval(
    invocation: RetrievalInvocation,
    parentContext?: Context,
    startTime?: number,
  ): RetrievalInvocation {
    const dsId = invocation.dataSourceId ?? "";
    return this._startSpan(
      invocation,
      `${GenAiExtendedOperationNameValues.RETRIEVAL} ${dsId}`.trim(),
      SpanKind.CLIENT,
      parentContext,
      startTime,
    );
  }

  stopRetrieval(invocation: RetrievalInvocation, endTime?: number): RetrievalInvocation {
    if (!invocation.span) return invocation;
    applyRetrievalFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failRetrieval(
    invocation: RetrievalInvocation,
    error: GenAIError,
    endTime?: number,
  ): RetrievalInvocation {
    if (!invocation.span) return invocation;
    applyRetrievalFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  retrieval<T>(
    invocationOrFn?: RetrievalInvocation | null,
    fn?: (inv: RetrievalInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<RetrievalInvocation>
    : RetrievalInvocation {
    return this._withInvocation(
      invocationOrFn ?? createRetrievalInvocation(),
      fn,
      (inv, ctx) => this.startRetrieval(inv, ctx),
      (inv) => this.stopRetrieval(inv),
      (inv, err) => this.failRetrieval(inv, err),
    );
  }

  // ==================== Rerank ====================

  startRerank(
    invocation: RerankInvocation,
    parentContext?: Context,
    startTime?: number,
  ): RerankInvocation {
    return this._startSpan(
      invocation,
      `${GenAiExtendedOperationNameValues.RERANK_DOCUMENTS} ${invocation.requestModel ?? ""}`.trim(),
      SpanKind.CLIENT,
      parentContext,
      startTime,
    );
  }

  stopRerank(invocation: RerankInvocation, endTime?: number): RerankInvocation {
    if (!invocation.span) return invocation;
    applyRerankFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failRerank(
    invocation: RerankInvocation,
    error: GenAIError,
    endTime?: number,
  ): RerankInvocation {
    if (!invocation.span) return invocation;
    applyRerankFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  rerank<T>(
    invocationOrFn?: RerankInvocation | null,
    fn?: (inv: RerankInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<RerankInvocation>
    : RerankInvocation {
    return this._withInvocation(
      invocationOrFn ?? createRerankInvocation(""),
      fn,
      (inv, ctx) => this.startRerank(inv, ctx),
      (inv) => this.stopRerank(inv),
      (inv, err) => this.failRerank(inv, err),
    );
  }

  // ==================== Memory ====================

  startMemory(
    invocation: MemoryInvocation,
    parentContext?: Context,
    startTime?: number,
  ): MemoryInvocation {
    const spanName = invocation.operation
      ? `memory_operation ${invocation.operation}`
      : "memory_operation";
    return this._startSpan(
      invocation,
      spanName,
      SpanKind.CLIENT,
      parentContext,
      startTime,
    );
  }

  stopMemory(invocation: MemoryInvocation, endTime?: number): MemoryInvocation {
    if (!invocation.span) return invocation;
    applyMemoryFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    maybeEmitMemoryEvent(this._logger, invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failMemory(
    invocation: MemoryInvocation,
    error: GenAIError,
    endTime?: number,
  ): MemoryInvocation {
    if (!invocation.span) return invocation;
    applyMemoryFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    maybeEmitMemoryEvent(this._logger, invocation.span, invocation, error);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  memory<T>(
    invocationOrFn?: MemoryInvocation | null,
    fn?: (inv: MemoryInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<MemoryInvocation>
    : MemoryInvocation {
    return this._withInvocation(
      invocationOrFn ?? createMemoryInvocation(""),
      fn,
      (inv, ctx) => this.startMemory(inv, ctx),
      (inv) => this.stopMemory(inv),
      (inv, err) => this.failMemory(inv, err),
    );
  }

  // ==================== Entry ====================

  startEntry(
    invocation: EntryInvocation,
    parentContext?: Context,
    startTime?: number,
  ): EntryInvocation {
    this._startSpan(
      invocation,
      "enter_ai_application_system",
      SpanKind.SERVER,
      parentContext,
      startTime,
    );
    // Publish common attributes to baggage so downstream GenAI spans inherit.
    if (invocation.contextToken) {
      invocation.contextToken = setCommonBaggage(invocation.contextToken, invocation);
    }
    return invocation;
  }

  stopEntry(invocation: EntryInvocation, endTime?: number): EntryInvocation {
    if (!invocation.span) return invocation;
    applyEntryFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failEntry(invocation: EntryInvocation, error: GenAIError, endTime?: number): EntryInvocation {
    if (!invocation.span) return invocation;
    applyEntryFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  entry<T>(
    invocationOrFn?: EntryInvocation | null,
    fn?: (inv: EntryInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<EntryInvocation>
    : EntryInvocation {
    return this._withInvocation(
      invocationOrFn ?? createEntryInvocation(),
      fn,
      (inv, ctx) => this.startEntry(inv, ctx),
      (inv) => this.stopEntry(inv),
      (inv, err) => this.failEntry(inv, err),
    );
  }

  // ==================== ReAct Step ====================

  startReactStep(
    invocation: ReactStepInvocation,
    parentContext?: Context,
    startTime?: number,
  ): ReactStepInvocation {
    return this._startSpan(
      invocation,
      "react step",
      SpanKind.INTERNAL,
      parentContext,
      startTime,
    );
  }

  stopReactStep(invocation: ReactStepInvocation, endTime?: number): ReactStepInvocation {
    if (!invocation.span) return invocation;
    applyReactStepFinishAttributes(invocation.span, invocation);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation);
    this._endSpan(invocation, endTime);
    return invocation;
  }

  failReactStep(
    invocation: ReactStepInvocation,
    error: GenAIError,
    endTime?: number,
  ): ReactStepInvocation {
    if (!invocation.span) return invocation;
    applyReactStepFinishAttributes(invocation.span, invocation);
    applyErrorAttributes(invocation.span, error);
    this._extMetricsRecorder.recordExtended(invocation.span, invocation, {
      errorType: error.type,
    });
    this._endSpan(invocation, endTime);
    return invocation;
  }

  reactStep<T>(
    invocationOrFn?: ReactStepInvocation | null,
    fn?: (inv: ReactStepInvocation) => T,
  ): T extends Promise<unknown>
    ? Promise<ReactStepInvocation>
    : ReactStepInvocation {
    return this._withInvocation(
      invocationOrFn ?? createReactStepInvocation(),
      fn,
      (inv, ctx) => this.startReactStep(inv, ctx),
      (inv) => this.stopReactStep(inv),
      (inv, err) => this.failReactStep(inv, err),
    );
  }

  // ==================== Generic Callback Pattern ====================

  private _withInvocation<I extends AnyExtendedInvocation, T>(
    invocation: I,
    fn: ((inv: I) => T) | undefined,
    start: (inv: I, ctx?: Context) => I,
    stop: (inv: I) => I,
    fail: (inv: I, err: GenAIError) => I,
  ): // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any {
    start(invocation);

    if (!fn) {
      return invocation;
    }

    try {
      const result = fn(invocation);
      if (result instanceof Promise) {
        return result
          .then(() => {
            stop(invocation);
            return invocation;
          })
          .catch((err: unknown) => {
            fail(invocation, makeGenAIError(err));
            throw err;
          });
      }
      stop(invocation);
      return invocation;
    } catch (err) {
      fail(invocation, makeGenAIError(err));
      throw err;
    }
  }
}

let _defaultExtendedHandler: ExtendedTelemetryHandler | null = null;

export function getExtendedTelemetryHandler(
  options?: TelemetryHandlerOptions,
): ExtendedTelemetryHandler {
  if (!_defaultExtendedHandler) {
    _defaultExtendedHandler = new ExtendedTelemetryHandler(options);
  }
  return _defaultExtendedHandler;
}
