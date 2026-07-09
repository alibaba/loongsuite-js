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
import { getExtendedTelemetryHandler, type ExtendedTelemetryHandler } from "../extended-handler.js";
import type { InputMessage } from "../types.js";
import {
  EventLogConversionError,
  EventName,
  type ConvertOptions,
  type ConvertResult,
  type EventLogRecord,
  type LlmPair,
  type StepGroup,
  type ToolPair,
  type TurnGroup,
} from "./types.js";
import { createTraceParentContext, isValidTraceId } from "./parent-context.js";
import {
  groupByStep,
  groupByTurn,
  pairLlm,
  pairTool,
  partitionUserHookRequests,
} from "./grouping.js";
import {
  buildAccumulatedInputMessages,
  collectPassthrough,
  buildEntryInvocation,
  buildExecuteToolInvocation,
  buildInvokeAgentInvocation,
  buildLlmInvocation,
  buildReactStepInvocation,
  readNanoMs,
  readTurnSystemInstruction,
  readTurnToolDefinitions,
  resolveTurnAgentName,
  resolveTurnSessionId,
  resolveTurnUserId,
  type TurnCommon,
} from "./field-mapping.js";


/**
 * Convert a flat event log into OTel spans using the supplied handler.
 *
 * Span hierarchy produced per turn (matches ARMS GenAI semantic conventions):
 *
 *   ENTRY
 *    └── AGENT
 *         └── STEP (one per gen_ai.step.id)
 *              ├── LLM (one per llm.request+llm.response pair)
 *              └── TOOL (one per tool.call+tool.result pair)
 *
 * trace_id from the event log is honored — all spans of a turn inherit it via
 * a synthetic parent SpanContext. If trace_id is missing or invalid, the SDK
 * allocates a fresh one.
 */
export function convertEventLogToTrace(
  records: EventLogRecord[],
  options?: ConvertOptions,
): ConvertResult {
  const strict = options?.strict === true;
  const handler = options?.handler ?? getExtendedTelemetryHandler();
  const warnings: string[] = [];
  const traceIds: string[] = [];
  let spanCount = 0;

  if (!records || records.length === 0) {
    return { traceIds, spanCount, warnings };
  }

  const turns = groupByTurn(records, warnings);

  for (const turn of turns) {
    const turnSpanCount = convertTurn(turn, handler, warnings, strict, options?.passthroughKeys);
    spanCount += turnSpanCount;
    if (turn.traceId) {
      traceIds.push(turn.traceId);
    }
  }

  if (strict && warnings.length > 0) {
    throw new EventLogConversionError(
      `Conversion failed in strict mode: ${warnings.length} issue(s). First: ${warnings[0]}`,
    );
  }

  return { traceIds, spanCount, warnings };
}

function convertTurn(
  turn: TurnGroup,
  handler: ExtendedTelemetryHandler,
  warnings: string[],
  strict: boolean,
  passthroughKeys?: string[],
): number {
  const allRecords = turn.records;
  if (allRecords.length === 0) return 0;

  // Time bounds use ALL records (including user-hook events) so ENTRY/AGENT
  // span timestamps still cover the full turn even though user-hook events
  // are removed from pairing/grouping.
  const turnStartMs = minTime(allRecords);
  const turnEndMs = maxTime(allRecords);

  // Extract user-input events that feed ENTRY span's input.messages but do
  // NOT generate their own LLM/TOOL spans. Two sources:
  //
  // 1. event.name = "other" events carrying gen_ai.input.messages or _delta
  //    (做法 A — recommended, per EVENT_LOG_TO_TRACE_SPEC.md §5)
  // 2. Legacy "user-hook" llm.request events (做法 B — deprecated):
  //    rule: no step.id, no model, no matching llm.response in turn
  // All "other" events are removed from pairing/grouping: those with input
  // messages feed ENTRY, those without are silently discarded.
  const otherWithMessages = allRecords.filter(
    (r) => r["event.name"] === EventName.OTHER && (r["gen_ai.input.messages_delta"] || r["gen_ai.input.messages"]),
  );
  const afterOther = allRecords.filter((r) => r["event.name"] !== EventName.OTHER);

  const { userHooks, remaining } = partitionUserHookRequests(afterOther);
  const records = remaining;

  // Combine both sources as user-input events (other events take priority)
  const allUserInputEvents = [...otherWithMessages, ...userHooks];

  if (userHooks.length > 0) {
    warnings.push(
      `Treated ${userHooks.length} llm.request event(s) as user-hook prompt(s), merged into ENTRY (turn ${turn.turnId ?? "(no turn.id)"}). Consider migrating to event.name="other" (做法 A).`,
    );
  }

  // Construct virtual parent context to honor the trace_id.
  let parentContext: Context | undefined;
  if (turn.traceId && isValidTraceId(turn.traceId)) {
    parentContext = createTraceParentContext(turn.traceId, turn.parentSpanId);
  } else if (turn.traceId !== undefined) {
    warnings.push(
      `Invalid trace_id "${turn.traceId}" for turn ${turn.turnId ?? "(no turn.id)"}; SDK will allocate one`,
    );
  }

  // Separate subagent child records from parent records. Child records are
  // grouped by gen_ai.subagent.parent_tool_call.id and will be nested under
  // the matching TOOL span downstream. Parent records drive the turn-level
  // ENTRY/AGENT and must not include child session data (token pollution etc).
  const parentRecords: EventLogRecord[] = [];
  const childRecordsByCallId = new Map<string, EventLogRecord[]>();
  for (const r of records) {
    if (r["gen_ai.agent.scope"] === "subagent") {
      const callId = r["gen_ai.subagent.parent_tool_call.id"];
      if (typeof callId === "string" && callId.length > 0) {
        let list = childRecordsByCallId.get(callId);
        if (!list) {
          list = [];
          childRecordsByCallId.set(callId, list);
        }
        list.push(r);
        continue;
      }
    }
    parentRecords.push(r);
  }

  // Resolve ARMS GenAI common attributes once per turn (agent.name / user.id /
  // session.id). These propagate to every span created from this turn.
  const common: TurnCommon = {
    agentName: resolveTurnAgentName(parentRecords, allUserInputEvents) ?? null,
    userId: resolveTurnUserId(parentRecords, allUserInputEvents) ?? null,
    sessionId: resolveTurnSessionId(parentRecords, allUserInputEvents) ?? null,
    passthroughKeys,
    passthroughTurn: collectPassthrough(
      passthroughKeys,
      ...parentRecords,
      ...allUserInputEvents,
    ),
  };

  // Build invocations (ENTRY/AGENT prefer user-input events as input source).
  const entryInv = buildEntryInvocation(parentRecords, allUserInputEvents, common);
  const agentInv = buildInvokeAgentInvocation(parentRecords, allUserInputEvents, common);

  handler.startEntry(entryInv, parentContext, turnStartMs);
  const entryCtx = entryInv.contextToken ?? undefined;
  handler.startInvokeAgent(agentInv, entryCtx, turnStartMs);
  const agentCtx = agentInv.contextToken ?? undefined;
  let spanCount = 2; // ENTRY + AGENT

  // Cache turn-level system/tool fields (shared across all LLM spans).
  const turnSysInstr = readTurnSystemInstruction(parentRecords);
  const turnToolDefs = readTurnToolDefinitions(parentRecords);

  // Pre-compute accumulated input messages for every LLM pair within the turn.
  // messages_delta accumulation crosses step boundaries (it's a turn-level
  // concept), so we collect all LLM pairs of the turn in time order first,
  // then build a Map<request_record, InputMessage[]> for downstream lookup.
  const accumulatedMap = buildTurnAccumulatedMessages(parentRecords);

  const steps = groupByStep(parentRecords);
  for (const step of steps) {
    spanCount += convertStep(
      step,
      handler,
      agentCtx,
      turnSysInstr,
      turnToolDefs,
      accumulatedMap,
      common,
      warnings,
      strict,
      childRecordsByCallId,
    );
  }

  handler.stopInvokeAgent(agentInv, turnEndMs);
  handler.stopEntry(entryInv, turnEndMs);

  // Capture the actual trace_id used (SDK may have allocated one).
  if (!turn.traceId) {
    const allocated = entryInv.span?.spanContext().traceId;
    if (allocated && isValidTraceId(allocated)) {
      turn.traceId = allocated;
    }
  }

  return spanCount;
}

function convertStep(
  step: StepGroup,
  handler: ExtendedTelemetryHandler,
  agentCtx: Context | undefined,
  turnSysInstr: Parameters<typeof buildLlmInvocation>[2],
  turnToolDefs: Parameters<typeof buildLlmInvocation>[3],
  accumulatedMap: Map<EventLogRecord, InputMessage[]>,
  common: TurnCommon,
  warnings: string[],
  _strict: boolean,
  childRecordsByCallId?: Map<string, EventLogRecord[]>,
): number {
  const stepRecords = step.records;
  if (stepRecords.length === 0) return 0;

  // Prefer LLM event times for STEP startTime — defends against upstream
  // mis-tagged tool.call events whose timestamps predate the actual LLM call
  // in this step (see BUG_STEP_MIN_TIME.md).
  const llmRecords = stepRecords.filter(
    (r) => r["event.name"] === "llm.request" || r["event.name"] === "llm.response",
  );
  const stepStart = llmRecords.length > 0 ? minTime(llmRecords) : minTime(stepRecords);
  const stepEnd = maxTime(stepRecords);

  const stepInv = buildReactStepInvocation(stepRecords, common);
  handler.startReactStep(stepInv, agentCtx, stepStart);
  const stepCtx = stepInv.contextToken ?? undefined;
  let spanCount = 1; // STEP

  const llmPairs = pairLlm(stepRecords, warnings);
  for (const pair of llmPairs) {
    spanCount += convertLlmPair(pair, handler, stepCtx, turnSysInstr, turnToolDefs, accumulatedMap, common);
  }

  const toolPairs = pairTool(stepRecords, warnings);
  for (const pair of toolPairs) {
    spanCount += convertToolPair(pair, handler, stepCtx, common, childRecordsByCallId, warnings);
  }

  handler.stopReactStep(stepInv, stepEnd);
  return spanCount;
}

function convertLlmPair(
  pair: LlmPair,
  handler: ExtendedTelemetryHandler,
  parentCtx: Context | undefined,
  turnSysInstr: Parameters<typeof buildLlmInvocation>[2],
  turnToolDefs: Parameters<typeof buildLlmInvocation>[3],
  accumulatedMap: Map<EventLogRecord, InputMessage[]>,
  common: TurnCommon,
): number {
  // Skip degenerate pair with nothing.
  if (!pair.request && !pair.response) return 0;

  const startMs = pair.request
    ? readNanoMs(pair.request["time_unix_nano"])
    : readNanoMs(pair.response!["time_unix_nano"]);
  // For merged responses, use _merged_end_time_unix_nano as the true end time
  // (it holds the timestamp of the last merged record).
  let endMs = pair.response
    ? readNanoMs(pair.response["_merged_end_time_unix_nano"] ?? pair.response["time_unix_nano"])
    : startMs;
  if (endMs < startMs) endMs = startMs;

  const accumulated = pair.request ? accumulatedMap.get(pair.request) : undefined;
  const llmInv = buildLlmInvocation(pair, accumulated, turnSysInstr, turnToolDefs, common);
  handler.startLlm(llmInv, parentCtx, startMs);
  handler.stopLlm(llmInv, endMs);
  return 1;
}

/**
 * Collect LLM pairs across all steps of a turn (in time order) and pre-compute
 * the accumulated inputMessages for each pair's request record.
 *
 * messages_delta accumulation is a turn-level concept — a later step's LLM
 * request implicitly inherits all messages from prior steps. Pre-computing
 * here keeps convertStep unaware of the cross-step relationship.
 */
function buildTurnAccumulatedMessages(
  turnRecords: EventLogRecord[],
): Map<EventLogRecord, InputMessage[]> {
  const pairs = pairLlm(turnRecords, []);
  // Sort by request time so cross-step order is monotonic. pairLlm already
  // sorts within each side, but the input to it (turnRecords) is in arrival
  // order, not strictly time order, when records have shuffled timestamps.
  pairs.sort((a, b) => {
    const ta = a.request ? readNanoMs(a.request["time_unix_nano"]) : 0;
    const tb = b.request ? readNanoMs(b.request["time_unix_nano"]) : 0;
    return ta - tb;
  });
  const map = new Map<EventLogRecord, InputMessage[]>();
  for (let i = 0; i < pairs.length; i++) {
    const req = pairs[i]?.request;
    if (!req) continue;
    map.set(req, buildAccumulatedInputMessages(pairs, i));
  }
  return map;
}

function convertToolPair(
  pair: ToolPair,
  handler: ExtendedTelemetryHandler,
  parentCtx: Context | undefined,
  common: TurnCommon,
  childRecordsByCallId?: Map<string, EventLogRecord[]>,
  warnings?: string[],
): number {
  if (!pair.call && !pair.result) return 0;

  let startMs = pair.call
    ? readNanoMs(pair.call["time_unix_nano"])
    : readNanoMs(pair.result!["time_unix_nano"]);
  let endMs = pair.result
    ? readNanoMs(pair.result["time_unix_nano"])
    : startMs;
  if (endMs < startMs) endMs = startMs;

  const toolInv = buildExecuteToolInvocation(pair, common);

  // Subagent nesting: if this tool has child session records, create a
  // nested AGENT → STEP → LLM/TOOL hierarchy under the TOOL span.
  const toolCallId = typeof pair.call?.["gen_ai.tool.call.id"] === "string"
    ? pair.call["gen_ai.tool.call.id"] as string
    : undefined;
  const childRecords = toolCallId ? childRecordsByCallId?.get(toolCallId) : undefined;
  let nestedSpanCount = 0;

  // Guard: if child records start earlier than TOOL, pull TOOL start forward
  if (childRecords && childRecords.length > 0) {
    const childMinMs = minTime(childRecords);
    if (childMinMs > 0 && childMinMs < startMs) startMs = childMinMs;
  }

  handler.startExecuteTool(toolInv, parentCtx, startMs);

  if (childRecords && childRecords.length > 0) {
    const toolCtx = toolInv.contextToken ?? undefined;
    const childCommon: TurnCommon = {
      agentName: resolveTurnAgentName(childRecords, []) ?? common.agentName,
      userId: common.userId,
      sessionId: common.sessionId,
      passthroughKeys: common.passthroughKeys,
      passthroughTurn: collectPassthrough(common.passthroughKeys, ...childRecords),
    };
    const childAgentInv = buildInvokeAgentInvocation(childRecords, [], childCommon);
    const childStartMs = minTime(childRecords);
    const childEndMs = maxTime(childRecords);

    handler.startInvokeAgent(childAgentInv, toolCtx, childStartMs);
    const childAgentCtx = childAgentInv.contextToken ?? undefined;
    nestedSpanCount += 1; // child AGENT

    const childAccumulatedMap = buildTurnAccumulatedMessages(childRecords);
    const childSteps = groupByStep(childRecords);
    for (const step of childSteps) {
      // No childRecordsByCallId passed — single-level nesting only
      nestedSpanCount += convertStep(
        step, handler, childAgentCtx, undefined, undefined,
        childAccumulatedMap, childCommon, warnings ?? [], false,
      );
    }

    handler.stopInvokeAgent(childAgentInv, childEndMs);
    if (childEndMs > endMs) endMs = childEndMs;
  }

  handler.stopExecuteTool(toolInv, endMs);
  return 1 + nestedSpanCount;
}

/* ------------------------------ time helpers ----------------------------- */

function minTime(records: EventLogRecord[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const r of records) {
    const ms = readNanoMs(r["time_unix_nano"]);
    if (ms > 0 && ms < min) min = ms;
  }
  return Number.isFinite(min) ? min : 0;
}

function maxTime(records: EventLogRecord[]): number {
  let max = 0;
  for (const r of records) {
    const ms = readNanoMs(r["time_unix_nano"]);
    if (ms > max) max = ms;
  }
  return max;
}
