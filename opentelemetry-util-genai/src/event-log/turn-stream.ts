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

import { type Context } from "@opentelemetry/api";
import {
  getExtendedTelemetryHandler,
  type ExtendedTelemetryHandler,
} from "../extended-handler.js";
import type { InputMessage } from "../types.js";
import type { EntryInvocation, InvokeAgentInvocation } from "../extended-types.js";
import { EventLogConversionError, EventName, type EventLogRecord } from "./types.js";
import { convertStep, minTime, maxTime } from "./converter.js";
import { groupByStep, isUserHookCandidate } from "./grouping.js";
import { createTraceParentContext, isValidSpanId, isValidTraceId } from "./parent-context.js";
import {
  accumulateResponseUsage,
  buildEntryInvocation,
  buildInvokeAgentInvocation,
  collectPassthrough,
  newResponseUsageAcc,
  parseInputMessages,
  parseOutputMessages,
  readTurnSystemInstruction,
  readTurnToolDefinitions,
  resolveTurnAgentName,
  resolveTurnSessionId,
  resolveTurnUserId,
  usageFieldsFromAcc,
  type ResponseUsageAcc,
  type TurnCommon,
} from "./field-mapping.js";

export interface TurnStreamOptions {
  handler?: ExtendedTelemetryHandler;
  passthroughKeys?: string[];
  /** When true, end() throws EventLogConversionError if any warnings occurred. */
  strict?: boolean;
  /**
   * Look-back window (in step groups) before a step is finalized: a step is
   * finalized only once `graceSteps` newer step.ids have appeared after it
   * (or at end()). This tolerates upstream out-of-order emission where a
   * step's trailing records (e.g. a late tool.result sharing the next step's
   * millisecond) arrive after the next step has started — see
   * EVENT_LOG_TO_TRACE_SPEC.md §2.5. Default 2. Records arriving for a step
   * that has already been finalized (interleaving beyond this window) are
   * dropped and counted in `lateDroppedRecordCount`.
   */
  graceSteps?: number;
}

export interface TurnStreamResult {
  traceId?: string;
  spanCount: number;
  /** Records dropped because they arrived after their step was finalized. */
  lateDroppedRecordCount: number;
  warnings: string[];
}

/** True if a record is a subagent child (nested under a parent tool call). */
function subagentParentCallId(r: EventLogRecord): string | undefined {
  if (r["gen_ai.agent.scope"] !== "subagent") return undefined;
  const id = r["gen_ai.subagent.parent_tool_call.id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** True if a record is a user-input event (feeds ENTRY, not its own span). */
function isUserInputEvent(r: EventLogRecord): boolean {
  if (r["event.name"] === EventName.OTHER) {
    return !!(r["gen_ai.input.messages_delta"] || r["gen_ai.input.messages"]);
  }
  return isUserHookCandidate(r);
}

/**
 * Stateful streaming conversion of a single turn's event log into OTel spans.
 *
 * ENTRY/AGENT are started on the first push and held OPEN; every complete STEP
 * (a react iteration — proven done once a later step.id arrives, or at end())
 * is converted via the shared `convertStep` and its child spans end + export
 * immediately; ENTRY/AGENT are closed at end() carrying turn-level aggregates.
 *
 * Memory decouples from the number of *simultaneously live* spans: at any time
 * only ENTRY/AGENT plus at most one in-flight STEP are open. It is NOT constant
 * per turn — `finalizedStepIds` is O(step count) and `accumMessages` is
 * O(total input size) (see STREAMING_CONVERSION_DESIGN.md §7).
 *
 * The caller (e.g. loongsuite-pilot) owns the lifecycle and MUST call push/end
 * serially — the session holds mutable state and is not re-entrant.
 */
export class TurnStreamSession {
  readonly warnings: string[] = [];

  private readonly handler: ExtendedTelemetryHandler;
  private readonly passthroughKeys?: string[];
  private readonly strict: boolean;
  private readonly graceSteps: number;
  private lateDroppedRecordCount = 0;

  private started = false;
  private ended = false;
  private common: TurnCommon | null = null;
  private entryInv: EntryInvocation | null = null;
  private agentInv: InvokeAgentInvocation | null = null;
  private agentCtx: Context | undefined;
  private _traceId: string | undefined;
  private parentSpanId: string | undefined;
  private turnId: string | undefined;
  private turnSysInstr: ReturnType<typeof readTurnSystemInstruction> = [];
  private turnToolDefs: ReturnType<typeof readTurnToolDefinitions> = [];

  private readonly parentPending: EventLogRecord[] = [];
  private readonly userInputEvents: EventLogRecord[] = [];
  private readonly childRecordsByCallId = new Map<string, EventLogRecord[]>();
  private readonly finalizedStepIds = new Set<string>();
  private readonly seenWarnings = new Set<string>();
  private userHookCount = 0;

  // Turn-level aggregates written back to ENTRY/AGENT at end().
  private readonly usageAcc: ResponseUsageAcc = newResponseUsageAcc();
  private lastResponseRecord: EventLogRecord | null = null;
  private readonly accumMessages: InputMessage[] = []; // running delta accumulation
  private earliestMs = Number.POSITIVE_INFINITY; // min time over ALL records seen
  private maxEndMs = 0;
  private _spanCount = 0;

  constructor(options?: TurnStreamOptions) {
    this.handler = options?.handler ?? getExtendedTelemetryHandler();
    this.passthroughKeys = options?.passthroughKeys;
    this.strict = options?.strict ?? false;
    this.graceSteps = Math.max(0, options?.graceSteps ?? 2);
  }

  get traceId(): string | undefined {
    return this._traceId;
  }
  get spanCount(): number {
    return this._spanCount;
  }
  get open(): boolean {
    return this.started && !this.ended;
  }
  /** Records currently buffered (not yet finalized) — bounded by the grace window. */
  get pendingRecordCount(): number {
    return this.parentPending.length;
  }

  push(records: EventLogRecord[]): void {
    if (this.ended) throw new Error("TurnStreamSession.push called after end()");
    if (records.length === 0) return;

    for (const r of records) {
      this.resolveTurnContext(r); // trace_id + parent_span_id + turn.id (all events)

      const childOf = subagentParentCallId(r);
      if (childOf) {
        const list = this.childRecordsByCallId.get(childOf) ?? [];
        list.push(r);
        this.childRecordsByCallId.set(childOf, list);
        continue;
      }
      if (r["event.name"] === EventName.OTHER) {
        if (isUserInputEvent(r)) this.userInputEvents.push(r);
        // "other" without messages is discarded (matches convertTurn), but its
        // parent_span_id/trace_id were already captured by resolveTurnContext.
        continue;
      }
      if (isUserHookCandidate(r)) {
        this.userInputEvents.push(r);
        this.userHookCount += 1;
        continue;
      }
      this.parentPending.push(r);
    }

    const mn = minTime(records);
    if (mn > 0) this.earliestMs = Math.min(this.earliestMs, mn);
    this.maxEndMs = Math.max(this.maxEndMs, maxTime(records));

    if (!this.started && this.parentPending.length > 0) this.start();
    if (!this.started) return; // still only subagent/user-input records seen

    // Finalize older step groups, keeping the last (1 + graceSteps) groups
    // open. A step is only finalized once `graceSteps` newer step.ids have
    // appeared, tolerating bounded out-of-order emission (a step's trailing
    // records arriving after the next step started). See graceSteps docs.
    const steps = groupByStep(this.parentPending);
    const keepCount = 1 + this.graceSteps;
    if (steps.length <= keepCount) return;
    const finalizeUpto = steps.length - keepCount;
    const kept: EventLogRecord[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (i < finalizeUpto) this.finalizeStep(steps[i]!.records);
      else kept.push(...steps[i]!.records);
    }
    this.parentPending.length = 0;
    this.parentPending.push(...kept);
  }

  end(endTimeMs?: number): TurnStreamResult {
    if (this.ended) return this.result();

    // Deprecation notice for 做法 B user-hook prompts (matches convertTurn).
    if (this.userHookCount > 0) {
      this.warnings.push(
        `Treated ${this.userHookCount} llm.request event(s) as user-hook prompt(s), merged into ENTRY (turn ${this.turnId ?? "(no turn.id)"}). Consider migrating to event.name="other" (做法 A).`,
      );
    }

    if (this.started) {
      for (const step of groupByStep(this.parentPending)) {
        this.finalizeStep(step.records);
      }
      this.parentPending.length = 0;

      const endMs = endTimeMs ?? this.maxEndMs;
      const outputMessages = this.lastResponseRecord
        ? parseOutputMessages(this.lastResponseRecord["gen_ai.output.messages"]) ?? []
        : [];
      const usage = usageFieldsFromAcc(this.usageAcc);

      if (this.agentInv) {
        this.agentInv.outputMessages = outputMessages;
        this.agentInv.responseModelName = usage.responseModelName;
        this.agentInv.responseId = usage.responseId;
        this.agentInv.inputTokens = usage.inputTokens;
        this.agentInv.outputTokens = usage.outputTokens;
        this.agentInv.totalTokens = usage.totalTokens;
        this.agentInv.usageCacheCreationInputTokens = usage.usageCacheCreationInputTokens;
        this.agentInv.usageCacheReadInputTokens = usage.usageCacheReadInputTokens;
        this.handler.stopInvokeAgent(this.agentInv, endMs);
      }
      if (this.entryInv) {
        this.entryInv.outputMessages = outputMessages;
        this.handler.stopEntry(this.entryInv, endMs);
      }
    }
    this.ended = true;

    if (this.strict && this.warnings.length > 0) {
      throw new EventLogConversionError(
        `Conversion failed in strict mode: ${this.warnings.length} issue(s). First: ${this.warnings[0]}`,
      );
    }
    return this.result();
  }

  // --- internal ---

  /**
   * Resolve turn-level trace_id / parent_span_id / turn.id from a record,
   * mirroring groupByTurn: trace_id from any event (first valid wins);
   * parent_span_id only from event.name="other" (做法 A upstream marker), never
   * from llm/tool events (those carry intra-trace parent pointers).
   */
  private resolveTurnContext(r: EventLogRecord): void {
    if (this.turnId === undefined) {
      const t = r["gen_ai.turn.id"];
      if (typeof t === "string" && t.length > 0) this.turnId = t;
    }
    const label = this.turnId ?? "(no turn.id)";

    const traceCand = r["trace_id"];
    if (isValidTraceId(traceCand)) {
      if (this._traceId === undefined) this._traceId = traceCand as string;
      else if (this._traceId !== traceCand) {
        this.warnOnce(
          `Inconsistent trace_id within turn ${label}: kept ${this._traceId}, saw ${String(traceCand)}`,
        );
      }
    } else if (traceCand !== undefined && traceCand !== null && traceCand !== "") {
      this.warnOnce(
        `Invalid trace_id "${String(traceCand)}" in turn ${label}; SDK will allocate one`,
      );
    }

    if (r["event.name"] === EventName.OTHER) {
      const spanCand = r["parent_span_id"];
      if (isValidSpanId(spanCand)) {
        if (this.parentSpanId === undefined) this.parentSpanId = spanCand as string;
        else if (this.parentSpanId !== spanCand) {
          this.warnOnce(
            `Inconsistent parent_span_id within turn ${label}: kept ${this.parentSpanId}, saw ${String(spanCand)}`,
          );
        }
      } else if (spanCand !== undefined && spanCand !== null && spanCand !== "") {
        this.warnOnce(
          `Invalid parent_span_id "${String(spanCand)}" in turn ${label}; ENTRY span will use synthetic parent`,
        );
      }
    }
  }

  private warnOnce(message: string): void {
    if (this.seenWarnings.has(message)) return;
    this.seenWarnings.add(message);
    this.warnings.push(message);
  }

  private start(): void {
    this.started = true;
    this.common = {
      agentName: resolveTurnAgentName(this.parentPending, this.userInputEvents) ?? null,
      userId: resolveTurnUserId(this.parentPending, this.userInputEvents) ?? null,
      sessionId: resolveTurnSessionId(this.parentPending, this.userInputEvents) ?? null,
      passthroughKeys: this.passthroughKeys,
      passthroughTurn: collectPassthrough(
        this.passthroughKeys,
        ...this.parentPending,
        ...this.userInputEvents,
      ),
    };

    let parentContext: Context | undefined;
    if (this._traceId) {
      parentContext = createTraceParentContext(this._traceId, this.parentSpanId);
    }

    this.turnSysInstr = readTurnSystemInstruction(this.parentPending);
    this.turnToolDefs = readTurnToolDefinitions(this.parentPending);

    this.entryInv = buildEntryInvocation(this.parentPending, this.userInputEvents, this.common);
    this.agentInv = buildInvokeAgentInvocation(this.parentPending, this.userInputEvents, this.common);

    const startMs = this.earliestMs === Number.POSITIVE_INFINITY ? 0 : this.earliestMs;
    this.handler.startEntry(this.entryInv, parentContext, startMs);
    const entryCtx = this.entryInv.contextToken ?? undefined;
    this.handler.startInvokeAgent(this.agentInv, entryCtx, startMs);
    this.agentCtx = this.agentInv.contextToken ?? undefined;
    this._spanCount += 2; // ENTRY + AGENT

    // Capture SDK-allocated trace_id when none was supplied.
    if (!this._traceId) {
      const allocated = this.entryInv.span?.spanContext().traceId;
      if (allocated && isValidTraceId(allocated)) this._traceId = allocated;
    }
  }

  private finalizeStep(stepRecords: EventLogRecord[]): void {
    if (stepRecords.length === 0) return;
    const stepId = stepRecords[0]?.["gen_ai.step.id"] as string | undefined;
    const stepKey = stepId ?? "__no_step__";
    if (this.finalizedStepIds.has(stepKey)) {
      // Interleaving exceeded graceSteps: these records can no longer be
      // attached (their step span was already exported). Count + warn so the
      // caller (pilot) can raise an alarm rather than silently losing data.
      this.lateDroppedRecordCount += stepRecords.length;
      this.warnOnce(
        `LATE_STEP_DROP: dropped ${stepRecords.length} record(s) for already-finalized step ${stepKey} (interleaving exceeded graceSteps=${this.graceSteps})`,
      );
      return;
    }
    this.finalizedStepIds.add(stepKey);

    const accumulatedMap = this.buildStepAccumulatedMessages(stepRecords);

    this._spanCount += convertStep(
      { stepId, records: stepRecords },
      this.handler,
      this.agentCtx,
      this.turnSysInstr,
      this.turnToolDefs,
      accumulatedMap,
      this.common!,
      this.warnings,
      this.strict,
      this.childRecordsByCallId,
    );

    // Fold this step's responses into the running turn-level aggregate.
    for (const r of stepRecords) {
      if (r["event.name"] === EventName.LLM_RESPONSE) {
        accumulateResponseUsage(this.usageAcc, r);
        this.lastResponseRecord = r;
      }
    }
  }

  /**
   * Build the accumulated input.messages for this step's llm.request records,
   * maintaining a single running list (delta mode) instead of the batch
   * converter's O(n^2) per-request snapshots. Mirrors
   * buildAccumulatedInputMessages: full messages win; otherwise deltas of all
   * prior + current requests concatenate.
   */
  private buildStepAccumulatedMessages(
    stepRecords: EventLogRecord[],
  ): Map<EventLogRecord, InputMessage[]> {
    const map = new Map<EventLogRecord, InputMessage[]>();
    for (const r of stepRecords) {
      if (r["event.name"] !== EventName.LLM_REQUEST) continue;
      const full = parseInputMessages(r["gen_ai.input.messages"]);
      const delta = parseInputMessages(r["gen_ai.input.messages_delta"]);
      if (delta) this.accumMessages.push(...delta);
      map.set(r, full ?? [...this.accumMessages]);
    }
    return map;
  }

  private result(): TurnStreamResult {
    return {
      traceId: this._traceId,
      spanCount: this._spanCount,
      lateDroppedRecordCount: this.lateDroppedRecordCount,
      warnings: this.warnings,
    };
  }
}

export function createTurnStreamSession(options?: TurnStreamOptions): TurnStreamSession {
  return new TurnStreamSession(options);
}
