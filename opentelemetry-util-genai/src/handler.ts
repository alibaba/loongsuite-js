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
  diag,
  SpanKind,
  type Tracer,
  type Meter,
  type Span,
  type TracerProvider,
  type MeterProvider,
  type Context,
} from "@opentelemetry/api";
import { InvocationMetricsRecorder } from "./metrics.js";
import {
  applyLlmFinishAttributes,
  applyErrorAttributes,
  maybeEmitLlmEvent,
  type EventLogger,
} from "./span-utils.js";
import type { LLMInvocation, GenAIError } from "./types.js";
import { createLLMInvocation } from "./types.js";
import { VERSION } from "./version.js";

const INSTRUMENTATION_NAME = "@loongsuite/otel-util-genai";

export interface TelemetryHandlerOptions {
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  loggerProvider?: unknown;
  instrumentationName?: string;
  instrumentationVersion?: string;
}

export class TelemetryHandler {
  protected _tracer: Tracer;
  protected _metricsRecorder: InvocationMetricsRecorder;
  protected _logger: EventLogger | null;

  constructor(options: TelemetryHandlerOptions = {}) {
    const scopeName = options.instrumentationName ?? INSTRUMENTATION_NAME;
    const scopeVersion = options.instrumentationVersion ?? VERSION;
    this._tracer = (options.tracerProvider ?? trace).getTracer(
      scopeName,
      scopeVersion,
    );
    const meter: Meter = (options.meterProvider ?? metrics).getMeter(
      scopeName,
      scopeVersion,
    );
    this._metricsRecorder = new InvocationMetricsRecorder(meter);

    // EventLogger from LoggerProvider (OTel Logs API)
    this._logger = resolveEventLogger(options.loggerProvider, scopeName, scopeVersion);
  }

  startLlm(
    invocation: LLMInvocation,
    parentContext?: Context,
    startTime?: number,
  ): LLMInvocation {
    const spanName =
      `${invocation.operationName ?? "chat"} ${invocation.requestModel ?? ""}`.trim();
    const span = this._tracer.startSpan(
      spanName,
      { kind: SpanKind.CLIENT, startTime },
      parentContext,
    );
    invocation.monotonicStartS = performance.now() / 1000;
    invocation.span = span;
    invocation.contextToken = trace.setSpan(
      parentContext ?? context.active(),
      span,
    );
    context.with(invocation.contextToken, () => {});
    return invocation;
  }

  stopLlm(invocation: LLMInvocation, endTime?: number): LLMInvocation {
    if (!invocation.span) return invocation;

    const span = invocation.span;
    applyLlmFinishAttributes(span, invocation);
    this._metricsRecorder.record(span, invocation);
    maybeEmitLlmEvent(this._logger, span, invocation);
    span.end(endTime);
    return invocation;
  }

  failLlm(invocation: LLMInvocation, error: GenAIError, endTime?: number): LLMInvocation {
    if (!invocation.span) return invocation;

    const span = invocation.span;
    applyLlmFinishAttributes(span, invocation);
    applyErrorAttributes(span, error);
    this._metricsRecorder.record(span, invocation, {
      errorType: error.type,
    });
    maybeEmitLlmEvent(this._logger, span, invocation, error);
    span.end(endTime);
    return invocation;
  }

  llm<T>(
    invocationOrFn?: LLMInvocation | null,
    fn?: (inv: LLMInvocation) => T,
  ): T extends Promise<unknown> ? Promise<LLMInvocation> : LLMInvocation {
    const invocation = invocationOrFn ?? createLLMInvocation();
    this.startLlm(invocation);

    if (!fn) {
      // Return invocation for manual start/stop pattern when no callback
      return invocation as T extends Promise<unknown>
        ? Promise<LLMInvocation>
        : LLMInvocation;
    }

    try {
      const result = fn(invocation);
      if (result instanceof Promise) {
        return result
          .then(() => {
            this.stopLlm(invocation);
            return invocation;
          })
          .catch((err: unknown) => {
            const genErr: GenAIError = {
              message: String(err),
              type:
                err instanceof Error
                  ? err.constructor.name
                  : "Error",
            };
            this.failLlm(invocation, genErr);
            throw err;
          }) as T extends Promise<unknown>
          ? Promise<LLMInvocation>
          : LLMInvocation;
      }

      this.stopLlm(invocation);
      return invocation as T extends Promise<unknown>
        ? Promise<LLMInvocation>
        : LLMInvocation;
    } catch (err) {
      const genErr: GenAIError = {
        message: String(err),
        type:
          err instanceof Error ? err.constructor.name : "Error",
      };
      this.failLlm(invocation, genErr);
      throw err;
    }
  }
}

function resolveEventLogger(
  loggerProvider: unknown,
  scopeName: string = INSTRUMENTATION_NAME,
  scopeVersion: string = VERSION,
): EventLogger | null {
  if (!loggerProvider) return null;
  if (
    typeof loggerProvider === "object" &&
    loggerProvider !== null &&
    "getLogger" in loggerProvider
  ) {
    try {
      const lp = loggerProvider as {
        getLogger: (name: string, version?: string) => EventLogger;
      };
      return lp.getLogger(scopeName, scopeVersion);
    } catch {
      diag.debug("Failed to get event logger from LoggerProvider");
    }
  }
  return null;
}

let _defaultHandler: TelemetryHandler | null = null;

export function getTelemetryHandler(
  options?: TelemetryHandlerOptions,
): TelemetryHandler {
  if (!_defaultHandler) {
    _defaultHandler = new TelemetryHandler(options);
  }
  return _defaultHandler;
}
