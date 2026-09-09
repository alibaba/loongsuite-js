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
  EventName,
  type EventLogRecord,
  type LlmPair,
  type StepGroup,
  type ToolPair,
  type TurnGroup,
} from "./types.js";
import { isValidTraceId, isValidSpanId } from "./parent-context.js";
import { readNanoMs } from "./field-mapping.js";

/**
 * Candidate predicate for "user-input hook" llm.request events.
 *
 * Rule: an llm.request that has neither gen_ai.step.id nor
 * gen_ai.request.model is a structural sign that the plugin is using
 * llm.request to mark user-prompt submission (not a real LLM API call).
 *
 * This is only the structural check; the converter must also verify the
 * event has no matching llm.response in the turn before routing it to ENTRY.
 */
export function isUserHookCandidate(record: EventLogRecord): boolean {
  return (
    record["event.name"] === EventName.LLM_REQUEST &&
    !record["gen_ai.step.id"] &&
    !record["gen_ai.request.model"]
  );
}

/**
 * Within a turn's records, identify which llm.request events should be
 * treated as user-hook prompts (merged into ENTRY) versus kept for normal
 * LLM-span generation.
 *
 * Rule: structural candidate (no step.id, no model) AND no peer llm.response
 * that could conceivably pair with it. A real LLM call always has step.id,
 * so its response also has step.id. A user-hook candidate (no step.id) can
 * only legitimately pair with a no-step llm.response — which never exists
 * in well-formed data. So we declare the candidate user-hook iff there is
 * no llm.response in the same turn that also lacks step.id.
 *
 * This avoids cross-step mispairing (where the time-ordered pairLlm could
 * otherwise greedy-match a candidate with a later step's response).
 */
export function partitionUserHookRequests(
  turnRecords: EventLogRecord[],
): { userHooks: EventLogRecord[]; remaining: EventLogRecord[] } {
  const candidates = turnRecords.filter(isUserHookCandidate);
  if (candidates.length === 0) {
    return { userHooks: [], remaining: turnRecords };
  }
  // Are there any llm.response events that could pair with no-step candidates?
  // A no-step response would be needed to legitimately pair with a no-step
  // candidate. In practice none exists; this guard keeps the rule strict.
  const noStepResponses = turnRecords.filter(
    (r) =>
      r["event.name"] === EventName.LLM_RESPONSE && !r["gen_ai.step.id"],
  );
  // Assign candidates to user-hooks in time order until we run out of
  // potential pair-mates. Remaining candidates are user-hooks.
  const sortedCandidates = [...candidates].sort(
    (a, b) => readNanoMs(a["time_unix_nano"]) - readNanoMs(b["time_unix_nano"]),
  );
  const userHookSet = new Set<EventLogRecord>(
    sortedCandidates.slice(noStepResponses.length), // skip the ones potentially paired
  );
  const userHooks: EventLogRecord[] = [];
  const remaining: EventLogRecord[] = [];
  for (const r of turnRecords) {
    if (userHookSet.has(r)) userHooks.push(r);
    else remaining.push(r);
  }
  return { userHooks, remaining };
}

function getStr(record: EventLogRecord, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function turnKey(record: EventLogRecord): string {
  const turnId = getStr(record, "gen_ai.turn.id");
  if (turnId) return `turn:${turnId}`;
  const sessionId = getStr(record, "gen_ai.session.id");
  if (sessionId) return `session:${sessionId}`;
  return "__no_turn__";
}

/**
 * Group records by turn. Insertion order of turns is preserved (matches order
 * the first record of each turn appears in the input).
 *
 * If multiple records within a turn carry different trace_id values the
 * first valid one wins and a warning is pushed.
 */
export function groupByTurn(
  records: EventLogRecord[],
  warnings: string[],
): TurnGroup[] {
  const map = new Map<string, TurnGroup>();
  // De-dup warning keys so a turn with N misaligned records emits 1 message
  // instead of N — real-world traffic with a buggy upstream can otherwise
  // flood diag logs.
  const seenWarnings = new Set<string>();
  for (const record of records) {
    const key = turnKey(record);
    let group = map.get(key);
    if (!group) {
      group = {
        turnId: getStr(record, "gen_ai.turn.id"),
        sessionId: getStr(record, "gen_ai.session.id"),
        traceId: undefined,
        parentSpanId: undefined,
        records: [],
      };
      map.set(key, group);
    }
    group.records.push(record);

    const candidate = record["trace_id"];
    if (isValidTraceId(candidate)) {
      if (group.traceId === undefined) {
        group.traceId = candidate;
      } else if (group.traceId !== candidate) {
        const wKey = `inconsistent:${key}:${group.traceId}:${candidate}`;
        if (!seenWarnings.has(wKey)) {
          seenWarnings.add(wKey);
          warnings.push(
            `Inconsistent trace_id within turn ${group.turnId ?? "(no turn.id)"}: kept ${group.traceId}, saw ${candidate}`,
          );
        }
      }
    } else if (candidate !== undefined && candidate !== null && candidate !== "") {
      const wKey = `invalid:${key}:${String(candidate)}`;
      if (!seenWarnings.has(wKey)) {
        seenWarnings.add(wKey);
        warnings.push(
          `Invalid trace_id "${String(candidate)}" in turn ${group.turnId ?? "(no turn.id)"}; SDK will allocate one`,
        );
      }
    }

    // parent_span_id: only read from event.name="agent.input" events. Other
    // event types (including generic "other", llm.request/response, and
    // tool.call/result) may carry unrelated parent pointers and must NOT be
    // treated as the turn-level upstream traceparent parent.
    if (record["event.name"] === EventName.AGENT_INPUT) {
      const spanCandidate = record["parent_span_id"];
      if (isValidSpanId(spanCandidate)) {
        if (group.parentSpanId === undefined) {
          group.parentSpanId = spanCandidate;
        } else if (group.parentSpanId !== spanCandidate) {
          const wKey = `inconsistent-parent:${key}:${group.parentSpanId}:${spanCandidate}`;
          if (!seenWarnings.has(wKey)) {
            seenWarnings.add(wKey);
            warnings.push(
              `Inconsistent parent_span_id within turn ${group.turnId ?? "(no turn.id)"}: kept ${group.parentSpanId}, saw ${spanCandidate}`,
            );
          }
        }
      } else if (spanCandidate !== undefined && spanCandidate !== null && spanCandidate !== "") {
        const wKey = `invalid-parent:${key}:${String(spanCandidate)}`;
        if (!seenWarnings.has(wKey)) {
          seenWarnings.add(wKey);
          warnings.push(
            `Invalid parent_span_id "${String(spanCandidate)}" in turn ${group.turnId ?? "(no turn.id)"}; ENTRY span will use synthetic parent`,
          );
        }
      }
    }
  }
  return [...map.values()];
}

/**
 * Group records within a turn by gen_ai.step.id. Records missing step.id are
 * placed into a synthetic "__no_step__" group, which still produces one STEP
 * span downstream.
 *
 * Insertion order is preserved.
 */
export function groupByStep(records: EventLogRecord[]): StepGroup[] {
  const map = new Map<string, StepGroup>();
  for (const record of records) {
    const key = getStr(record, "gen_ai.step.id") ?? "__no_step__";
    let group = map.get(key);
    if (!group) {
      group = {
        stepId: getStr(record, "gen_ai.step.id"),
        records: [],
      };
      map.set(key, group);
    }
    group.records.push(record);
  }
  return [...map.values()];
}

/**
 * Pair llm.request with the following llm.response within the same step.
 *
 * Matching rules (in order):
 *   1. If both records share a non-empty gen_ai.response.id, prefer ID match.
 *      (response.id appears on the response and sometimes is mirrored back to
 *      the request by the producer.)
 *   2. Otherwise pair each request with the next unpaired response in
 *      time_unix_nano order.
 *
/**
 * Merge multiple llm.response records that share the same
 * `gen_ai.response.id` into a single synthetic record. This handles the
 * common upstream pattern where thinking (reasoning) and text are emitted as
 * separate events for the same LLM call.
 *
 * Merge strategy (within each response.id group, sorted by time):
 *  - output.messages parts: concatenated in time order
 *  - token fields: take the first non-zero / non-null value
 *  - model / finish_reason / response.id: take the last non-empty value
 *  - time_unix_nano: earliest of the group (span start)
 *  - A synthetic `_merged_end_time_unix_nano` stores the latest (span end)
 *  - Records without response.id, or with a unique id, pass through unchanged
 */
export function mergeResponsesByResponseId(
  responses: EventLogRecord[],
): EventLogRecord[] {
  if (responses.length <= 1) return responses;

  const byId = new Map<string, EventLogRecord[]>();
  const noId: EventLogRecord[] = [];
  for (const r of responses) {
    const rid = getStr(r, "gen_ai.response.id");
    if (!rid) {
      noId.push(r);
      continue;
    }
    let list = byId.get(rid);
    if (!list) {
      list = [];
      byId.set(rid, list);
    }
    list.push(r);
  }

  const result: EventLogRecord[] = [...noId];
  for (const [, group] of byId) {
    if (group.length === 1) {
      result.push(group[0]!);
      continue;
    }
    // Sort by time within the group
    group.sort(
      (a, b) => readNanoMs(a["time_unix_nano"]) - readNanoMs(b["time_unix_nano"]),
    );
    // Merge into a single synthetic record
    const merged: EventLogRecord = { ...group[0]! };
    // Collect all output.messages parts
    const allParts: unknown[] = [];
    for (const r of group) {
      const raw = r["gen_ai.output.messages"];
      let msgs: unknown[] | undefined;
      if (typeof raw === "string") {
        try { msgs = JSON.parse(raw); } catch { /* skip */ }
      } else if (Array.isArray(raw)) {
        msgs = raw;
      }
      if (Array.isArray(msgs)) {
        for (const msg of msgs) {
          const m = msg as Record<string, unknown>;
          const parts = m.parts;
          if (Array.isArray(parts)) allParts.push(...parts);
        }
      }
    }
    if (allParts.length > 0) {
      // Take role and finish_reason from the last message that has them
      let lastRole = "assistant";
      let lastFinish = "stop";
      for (const r of group) {
        const raw = r["gen_ai.output.messages"];
        let msgs: unknown[] | undefined;
        if (typeof raw === "string") {
          try { msgs = JSON.parse(raw); } catch { /* skip */ }
        } else if (Array.isArray(raw)) {
          msgs = raw;
        }
        if (Array.isArray(msgs) && msgs.length > 0) {
          const m = msgs[msgs.length - 1] as Record<string, unknown>;
          if (m.role) lastRole = m.role as string;
          const fr = m.finish_reason ?? m.finishReason;
          if (fr) lastFinish = fr as string;
        }
      }
      merged["gen_ai.output.messages"] = JSON.stringify([
        { role: lastRole, parts: allParts, finish_reason: lastFinish },
      ]);
    }
    // Token: take first non-zero value per field
    for (const tk of [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cache_creation.input_tokens",
      "gen_ai.usage.total_tokens",
    ]) {
      let picked: unknown = null;
      for (const r of group) {
        const v = r[tk];
        if (typeof v === "number" && v > 0) { picked = v; break; }
      }
      if (picked != null) merged[tk] = picked;
    }
    // Model / finish_reasons / response.id: last non-empty
    for (const fk of [
      "gen_ai.request.model",
      "gen_ai.response.model",
      "gen_ai.response.id",
    ]) {
      for (const r of group) {
        const v = getStr(r, fk);
        if (v && v !== "unknown") merged[fk] = v;
      }
    }
    // finish_reasons: last non-empty
    for (const r of group) {
      const v = r["gen_ai.response.finish_reasons"];
      if (v) merged["gen_ai.response.finish_reasons"] = v;
    }
    // Time: earliest start, latest end
    let earliest = Infinity;
    let latest = 0;
    for (const r of group) {
      const t = readNanoMs(r["time_unix_nano"]);
      if (t > 0 && t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
    if (Number.isFinite(earliest)) {
      merged["time_unix_nano"] = String(BigInt(earliest) * 1_000_000n);
    }
    // Store the latest time for endTime calculation downstream
    if (latest > earliest) {
      merged["_merged_end_time_unix_nano"] = String(BigInt(latest) * 1_000_000n);
    }
    result.push(merged);
  }
  return result;
}

/**
 * Pair llm.request with the following llm.response within the same step.
 *
 * Before pairing, responses with the same `gen_ai.response.id` are merged
 * into a single synthetic record (see mergeResponsesByResponseId). This
 * handles the common upstream pattern of split thinking/text responses.
 *
 * Orphan request/response records are returned as pairs with the other side
 * undefined.
 */
export function pairLlm(
  records: EventLogRecord[],
  warnings: string[],
): LlmPair[] {
  const requests = records
    .filter((r) => r["event.name"] === EventName.LLM_REQUEST)
    .slice()
    .sort((a, b) => readNanoMs(a["time_unix_nano"]) - readNanoMs(b["time_unix_nano"]));
  const responses = mergeResponsesByResponseId(
    records.filter((r) => r["event.name"] === EventName.LLM_RESPONSE),
  ).sort((a, b) => readNanoMs(a["time_unix_nano"]) - readNanoMs(b["time_unix_nano"]));

  const pairs: LlmPair[] = [];
  const consumedResponses = new Set<EventLogRecord>();

  for (const req of requests) {
    const reqRespId = getStr(req, "gen_ai.response.id");
    let resp: EventLogRecord | undefined;

    if (reqRespId) {
      resp = responses.find(
        (r) => !consumedResponses.has(r) && getStr(r, "gen_ai.response.id") === reqRespId,
      );
    }
    if (!resp) {
      resp = responses.find((r) => !consumedResponses.has(r));
    }
    if (resp) {
      consumedResponses.add(resp);
      pairs.push({ request: req, response: resp });
    } else {
      warnings.push(
        `Orphan llm.request (event.id=${getStr(req, "event.id") ?? "?"}): no matching llm.response in step`,
      );
      pairs.push({ request: req });
    }
  }

  for (const resp of responses) {
    if (!consumedResponses.has(resp)) {
      warnings.push(
        `Orphan llm.response (event.id=${getStr(resp, "event.id") ?? "?"}): no preceding llm.request in step`,
      );
      pairs.push({ response: resp });
    }
  }

  return pairs;
}

/**
 * Pair tool.call with tool.result by gen_ai.tool.call.id. Orphans are
 * returned with the missing side undefined.
 */
export function pairTool(
  records: EventLogRecord[],
  warnings: string[],
): ToolPair[] {
  const calls = records.filter((r) => r["event.name"] === EventName.TOOL_CALL);
  const results = records.filter((r) => r["event.name"] === EventName.TOOL_RESULT);
  const consumedResults = new Set<EventLogRecord>();
  const pairs: ToolPair[] = [];

  for (const call of calls) {
    const callId = getStr(call, "gen_ai.tool.call.id");
    let result: EventLogRecord | undefined;
    if (callId) {
      result = results.find(
        (r) => !consumedResults.has(r) && getStr(r, "gen_ai.tool.call.id") === callId,
      );
    }
    if (!result) {
      // Fallback: first unconsumed result without id
      result = results.find((r) => !consumedResults.has(r));
    }
    if (result) {
      consumedResults.add(result);
      pairs.push({ call, result });
    } else {
      warnings.push(
        `Orphan tool.call (tool.call.id=${callId ?? "?"}): no matching tool.result in step`,
      );
      pairs.push({ call });
    }
  }

  for (const result of results) {
    if (!consumedResults.has(result)) {
      warnings.push(
        `Orphan tool.result (tool.call.id=${getStr(result, "gen_ai.tool.call.id") ?? "?"}): no preceding tool.call in step`,
      );
      pairs.push({ result });
    }
  }

  return pairs;
}
