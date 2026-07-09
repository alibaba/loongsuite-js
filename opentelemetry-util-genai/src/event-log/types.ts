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

import type { ExtendedTelemetryHandler } from "../extended-handler.js";

/**
 * Event log record as defined by loongsuite-pilot/docs/ai_event_schema.md.
 *
 * Intentionally typed as a loose key/value map so that schema evolution (new
 * fields, removed fields) does not break TypeScript compilation of the
 * converter. Field access is centralized in field-mapping.ts.
 */
export type EventLogRecord = Record<string, unknown>;

/** Enum of supported event.name values (subset of pilot schema we handle). */
export const EventName = {
  LLM_REQUEST: "llm.request",
  LLM_RESPONSE: "llm.response",
  TOOL_CALL: "tool.call",
  TOOL_RESULT: "tool.result",
  SKILL_USE: "skill.use",
  TOOL_APPROVE: "tool.approve",
  OTHER: "other",
} as const;

export type EventNameValue = (typeof EventName)[keyof typeof EventName];

/** Options accepted by convertEventLogToTrace. */
export interface ConvertOptions {
  /**
   * Handler used to create spans. If omitted the default singleton from
   * getExtendedTelemetryHandler() is used.
   */
  handler?: ExtendedTelemetryHandler;
  /**
   * When true any conversion problem (orphan events, malformed JSON, invalid
   * timestamps) throws EventLogConversionError instead of being collected as
   * a warning. Default false.
   */
  strict?: boolean;
  /**
   * Allowlist of event-log field names to pass through verbatim onto the
   * generated spans (field name == span attribute name, no rename).
   *
   * Granularity:
   *   - Turn-level: fields resolved once per turn are broadcast to every span
   *     of that turn (ENTRY/AGENT/STEP/LLM/TOOL).
   *   - Per-record: LLM and TOOL spans additionally read the field off their
   *     own source records, overriding the turn-level value on collision.
   *
   * Fill-only semantics: a pass-through field is only written when the span
   * does not already carry that attribute, so converter-managed attributes
   * (token usage, model, common attributes, ...) are never overwritten.
   *
   * Omit or leave empty to disable (behavior unchanged).
   */
  passthroughKeys?: string[];
}

/** Result of a conversion. */
export interface ConvertResult {
  /** trace_id per turn (in input order). */
  traceIds: string[];
  /** Total number of spans created (ENTRY+AGENT+STEP+LLM+TOOL). */
  spanCount: number;
  /** Non-fatal issues encountered when strict=false. */
  warnings: string[];
}

/** Thrown in strict mode when conversion cannot proceed. */
export class EventLogConversionError extends Error {
  constructor(
    message: string,
    public readonly eventId?: string,
    public readonly eventName?: string,
  ) {
    super(message);
    this.name = "EventLogConversionError";
  }
}

/**
 * Internal grouping result: records grouped by turn.
 *
 * traceId is the value read from records (validated 32-hex). May be undefined
 * if no record in the turn carried a valid trace_id — in that case the SDK
 * will allocate one.
 */
export interface TurnGroup {
  turnId: string | undefined;
  sessionId: string | undefined;
  traceId: string | undefined;
  parentSpanId: string | undefined;
  records: EventLogRecord[];
}

/** Internal grouping result: records within one step of a turn. */
export interface StepGroup {
  stepId: string | undefined;
  records: EventLogRecord[];
}

/** A matched llm.request + llm.response pair (either side may be missing). */
export interface LlmPair {
  request?: EventLogRecord;
  response?: EventLogRecord;
}

/** A matched tool.call + tool.result pair (either side may be missing). */
export interface ToolPair {
  call?: EventLogRecord;
  result?: EventLogRecord;
}
