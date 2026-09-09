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
  createEntryInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createReactStepInvocation,
  type EntryInvocation,
  type ExecuteToolInvocation,
  type InvokeAgentInvocation,
  type ReactStepInvocation,
} from "../extended-types.js";
import {
  createLLMInvocation,
  type InputMessage,
  type LLMInvocation,
  type MessagePart,
  type OutputMessage,
  type ToolDefinition,
} from "../types.js";
import {
  EventName,
  type EventLogRecord,
  type LlmPair,
  type SkillDetectionConfig,
} from "./types.js";
import { resolveSkill } from "./skill.js";

/* -------------------------- primitive accessors -------------------------- */

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/* ---------------------- turn-level common attributes --------------------- */

/**
 * Resolve the "agent name" identifier for a turn — used to set the ARMS
 * common attribute `gen_ai.agent.name` on every span of the turn.
 *
 * Fallback chain: gen_ai.agent.name → gen_ai.agent.type → undefined.
 * (event log convention: gen_ai.agent.type is the product identifier
 * like `codex`/`claude-code`, which matches ARMS gen_ai.agent.name semantics.)
 */
export function resolveTurnAgentName(
  turnRecords: EventLogRecord[],
  inputEventRecords: EventLogRecord[] = [],
): string | undefined {
  for (const r of [...turnRecords, ...inputEventRecords]) {
    const v =
      asString(r["gen_ai.agent.name"]) ?? asString(r["gen_ai.agent.type"]);
    if (v) return v;
  }
  return undefined;
}

/** Resolve the user.id for a turn (first non-empty `user.id` field). */
export function resolveTurnUserId(
  turnRecords: EventLogRecord[],
  inputEventRecords: EventLogRecord[] = [],
): string | undefined {
  for (const r of [...turnRecords, ...inputEventRecords]) {
    const v = asString(r["user.id"]);
    if (v) return v;
  }
  return undefined;
}

/** Resolve the session.id for a turn (first non-empty `gen_ai.session.id`). */
export function resolveTurnSessionId(
  turnRecords: EventLogRecord[],
  inputEventRecords: EventLogRecord[] = [],
): string | undefined {
  for (const r of [...turnRecords, ...inputEventRecords]) {
    const v = asString(r["gen_ai.session.id"]);
    if (v) return v;
  }
  return undefined;
}

/** Bundle of common attributes resolved once per turn. */
export interface TurnCommon {
  agentName: string | null;
  userId: string | null;
  sessionId: string | null;
  /** Allowlist of event fields to pass through (for per-record reads). */
  passthroughKeys?: string[];
  /** Turn-level pass-through values, resolved once from all turn records. */
  passthroughTurn?: Record<string, unknown>;
  /** Skill detection configuration shared by batch, stream and subagents. */
  skillDetection?: SkillDetectionConfig;
}

/**
 * Collect pass-through attributes from the given records against an allowlist.
 *
 * Scans records in order; the first non-null value found for each key wins.
 * Returns undefined when nothing matched so callers can skip assignment.
 */
export function collectPassthrough(
  keys: string[] | undefined,
  ...records: (EventLogRecord | undefined)[]
): Record<string, unknown> | undefined {
  if (!keys || keys.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const r of records) {
    if (!r) continue;
    for (const k of keys) {
      if (out[k] == null && r[k] != null) {
        out[k] = r[k];
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge turn-level pass-through with per-record pass-through. Per-record values
 * override turn-level ones on key collision. Returns undefined when both empty.
 */
function mergePassthrough(
  common: TurnCommon | undefined,
  ...records: (EventLogRecord | undefined)[]
): Record<string, unknown> | undefined {
  const perRecord = collectPassthrough(common?.passthroughKeys, ...records);
  const turn = common?.passthroughTurn;
  if (!turn && !perRecord) return undefined;
  return { ...(turn ?? {}), ...(perRecord ?? {}) };
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.filter((v): v is string => typeof v === "string" && v.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return undefined;
}

/**
 * Read a uint64-nanosecond timestamp and return its millisecond value as
 * understood by OTel JS SDK (which interprets startTime: number as ms).
 *
 * Accepts number, string (decimal), or bigint. Out-of-range values yield 0
 * which lets the caller decide whether to warn or fall back.
 */
export function readNanoMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value / 1_000_000);
  }
  if (typeof value === "bigint" && value >= 0n) {
    return Number(value / 1_000_000n);
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const b = BigInt(value);
      if (b >= 0n) return Number(b / 1_000_000n);
    } catch {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n / 1_000_000);
    }
  }
  return 0;
}

/* ----------------------------- JSON parsing ------------------------------ */

function parseJsonField(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Parse messages as InputMessage[]. Accepts string (JSON) or parsed array. */
export function parseInputMessages(raw: unknown): InputMessage[] | undefined {
  const parsed = parseJsonField(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: InputMessage[] = [];
  for (const m of parsed) {
    if (m && typeof m === "object" && typeof (m as Record<string, unknown>).role === "string") {
      const rec = m as Record<string, unknown>;
      const parts = Array.isArray(rec.parts) ? (rec.parts as MessagePart[]) : [];
      out.push({ role: rec.role as string, parts });
    }
  }
  return out.length > 0 ? out : undefined;
}

export function parseOutputMessages(raw: unknown): OutputMessage[] | undefined {
  const parsed = parseJsonField(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: OutputMessage[] = [];
  for (const m of parsed) {
    if (m && typeof m === "object" && typeof (m as Record<string, unknown>).role === "string") {
      const rec = m as Record<string, unknown>;
      const parts = Array.isArray(rec.parts) ? (rec.parts as MessagePart[]) : [];
      const fr = rec.finish_reason ?? rec.finishReason;
      out.push({
        role: rec.role as string,
        parts,
        finishReason: typeof fr === "string" ? fr : "stop",
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseSystemInstructions(raw: unknown): MessagePart[] | undefined {
  const parsed = parseJsonField(raw);
  if (Array.isArray(parsed)) {
    return parsed as MessagePart[];
  }
  if (typeof parsed === "string") {
    return [{ type: "text", content: parsed }];
  }
  return undefined;
}

function parseToolDefinitions(raw: unknown): ToolDefinition[] | undefined {
  const parsed = parseJsonField(raw);
  if (!Array.isArray(parsed)) return undefined;
  const out: ToolDefinition[] = [];
  for (const td of parsed) {
    if (td && typeof td === "object" && typeof (td as Record<string, unknown>).name === "string") {
      out.push({ ...(td as Record<string, unknown>) } as unknown as ToolDefinition);
    }
  }
  return out.length > 0 ? out : undefined;
}

/* ----------------------- message-delta accumulator ----------------------- */

/**
 * Build complete input messages for an LLM invocation by walking the turn's
 * LLM pairs in order.
 *
 * Priority:
 *   1. If the matching llm.request has gen_ai.input.messages (full), use it.
 *   2. Else accumulate gen_ai.input.messages_delta from all prior llm.request
 *      records in the same turn (plus the current one).
 */
export function buildAccumulatedInputMessages(
  pairs: LlmPair[],
  targetPairIndex: number,
): InputMessage[] {
  const target = pairs[targetPairIndex]?.request;
  if (!target) return [];

  // Full messages on the target wins.
  const full = parseInputMessages(target["gen_ai.input.messages"]);
  if (full) return full;

  // Otherwise concat deltas of all prior + current requests.
  const out: InputMessage[] = [];
  for (let i = 0; i <= targetPairIndex; i++) {
    const req = pairs[i]?.request;
    if (!req) continue;
    const delta = parseInputMessages(req["gen_ai.input.messages_delta"]);
    if (delta) out.push(...delta);
  }
  return out;
}

/* --------------------------- invocation builders ------------------------- */

/** Default provider when missing from the event log. */
const DEFAULT_PROVIDER = "unknown";

/**
 * Collect messages from dedicated agent.input events or the legacy user-hook
 * fallback. Returns them in time order for ENTRY/AGENT builders.
 */
function collectInputEventMessages(
  inputEventRecords: EventLogRecord[],
): InputMessage[] {
  if (inputEventRecords.length === 0) return [];
  const sorted = [...inputEventRecords].sort(
    (a, b) => readNanoMs(a["time_unix_nano"]) - readNanoMs(b["time_unix_nano"]),
  );
  const out: InputMessage[] = [];
  for (const hook of sorted) {
    const msgs =
      parseInputMessages(hook["gen_ai.input.messages_delta"]) ??
      parseInputMessages(hook["gen_ai.input.messages"]);
    if (msgs) out.push(...msgs);
  }
  return out;
}

/**
 * Build an EntryInvocation from a turn's records.
 *
 * @param turnRecords records remaining after non-span input events are removed
 * @param inputEventRecords dedicated agent.input events, or legacy user-hook
 *                          fallback records when no agent.input exists. If
 *                          empty, uses the first real llm.request.
 */
export function buildEntryInvocation(
  turnRecords: EventLogRecord[],
  inputEventRecords: EventLogRecord[] = [],
  common?: TurnCommon,
): EntryInvocation {
  const first = turnRecords[0] ?? inputEventRecords[0];
  const sessionId =
    common?.sessionId ?? (first ? asString(first["gen_ai.session.id"]) : undefined);
  const userId =
    common?.userId ?? (first ? asString(first["user.id"]) : undefined);

  // Prefer explicit input events; fall back to the first llm.request's
  // messages_delta only when no input event exists.
  let inputMessages = collectInputEventMessages(inputEventRecords);
  if (inputMessages.length === 0) {
    const llmReq = turnRecords.find((r) => r["event.name"] === EventName.LLM_REQUEST);
    if (llmReq) {
      inputMessages = parseInputMessages(llmReq["gen_ai.input.messages_delta"]) ?? [];
    }
  }

  const llmResp = [...turnRecords]
    .reverse()
    .find((r) => r["event.name"] === EventName.LLM_RESPONSE);
  const outputMessages =
    (llmResp && parseOutputMessages(llmResp["gen_ai.output.messages"])) ?? [];

  return createEntryInvocation({
    sessionId: sessionId ?? null,
    userId: userId ?? null,
    agentName: common?.agentName ?? null,
    inputMessages,
    outputMessages,
    ...(common?.passthroughTurn
      ? { passthroughAttributes: common.passthroughTurn }
      : {}),
  });
}

/**
 * Running accumulator of llm.response token usage. Shared by the batch
 * converter (buildInvokeAgentInvocation) and the streaming session so both
 * produce identical AGENT-level aggregates.
 */
export interface ResponseUsageAcc {
  totalInput: number;
  totalOutput: number;
  totalCacheCreate: number;
  totalCacheRead: number;
  totalReported: number;
  allReportedTotal: boolean;
  sawAny: boolean;
  responseModel: string | null;
  lastResponseId: string | null;
}

export function newResponseUsageAcc(): ResponseUsageAcc {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheCreate: 0,
    totalCacheRead: 0,
    totalReported: 0,
    allReportedTotal: true,
    sawAny: false,
    responseModel: null,
    lastResponseId: null,
  };
}

/** Fold one record into the accumulator; no-op for non-llm.response records. */
export function accumulateResponseUsage(acc: ResponseUsageAcc, r: EventLogRecord): void {
  if (r["event.name"] !== EventName.LLM_RESPONSE) return;
  const inT = asNumber(r["gen_ai.usage.input_tokens"]);
  const outT = asNumber(r["gen_ai.usage.output_tokens"]);
  const ccT = asNumber(r["gen_ai.usage.cache_creation.input_tokens"]);
  const crT = asNumber(r["gen_ai.usage.cache_read.input_tokens"]);
  const tT = asNumber(r["gen_ai.usage.total_tokens"]);
  if (inT != null) {
    acc.totalInput += inT;
    acc.sawAny = true;
  }
  if (outT != null) {
    acc.totalOutput += outT;
    acc.sawAny = true;
  }
  if (inT != null || outT != null) {
    // A reported total of 0 on a token-bearing response is degenerate; treat
    // it as "not reported" so the whole AGENT falls back to summed
    // input+output (mirrors the LLM span's `> 0` guard).
    if (tT != null && tT > 0) acc.totalReported += tT;
    else acc.allReportedTotal = false;
  }
  if (ccT != null) acc.totalCacheCreate += ccT;
  if (crT != null) acc.totalCacheRead += crT;
  acc.responseModel = asString(r["gen_ai.response.model"]) ?? acc.responseModel;
  acc.lastResponseId = asString(r["gen_ai.response.id"]) ?? acc.lastResponseId;
}

/** Derive AGENT invocation usage fields from an accumulator. */
export function usageFieldsFromAcc(acc: ResponseUsageAcc): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageCacheCreationInputTokens: number | null;
  usageCacheReadInputTokens: number | null;
  responseModelName: string | null;
  responseId: string | null;
} {
  return {
    inputTokens: acc.sawAny ? acc.totalInput : null,
    outputTokens: acc.sawAny ? acc.totalOutput : null,
    totalTokens: acc.sawAny && acc.allReportedTotal && acc.totalReported > 0 ? acc.totalReported : null,
    usageCacheCreationInputTokens: acc.totalCacheCreate > 0 ? acc.totalCacheCreate : null,
    usageCacheReadInputTokens: acc.totalCacheRead > 0 ? acc.totalCacheRead : null,
    responseModelName: acc.responseModel,
    responseId: acc.lastResponseId,
  };
}

/** Build an InvokeAgentInvocation by aggregating turn-level metadata. */
export function buildInvokeAgentInvocation(
  turnRecords: EventLogRecord[],
  inputEventRecords: EventLogRecord[] = [],
  common?: TurnCommon,
): InvokeAgentInvocation {
  const first = turnRecords[0] ?? inputEventRecords[0] ?? {};

  const provider = asString(first["gen_ai.provider.name"]) ?? DEFAULT_PROVIDER;
  const requestModel =
    asString(first["gen_ai.request.model"]) ??
    turnRecords
      .map((r) => asString(r["gen_ai.request.model"]))
      .find((v): v is string => !!v) ??
    null;

  // Aggregate token usage from llm.response events (shared with streaming path).
  const usageAcc = newResponseUsageAcc();
  for (const r of turnRecords) accumulateResponseUsage(usageAcc, r);
  const usage = usageFieldsFromAcc(usageAcc);

  const llmReq = turnRecords.find((r) => r["event.name"] === EventName.LLM_REQUEST);
  const llmResp = [...turnRecords]
    .reverse()
    .find((r) => r["event.name"] === EventName.LLM_RESPONSE);

  // Prefer explicit input events for input.messages (same rule as ENTRY).
  let inputMessages = collectInputEventMessages(inputEventRecords);
  if (inputMessages.length === 0) {
    inputMessages =
      (llmReq && parseInputMessages(llmReq["gen_ai.input.messages_delta"])) ?? [];
  }
  const outputMessages =
    (llmResp && parseOutputMessages(llmResp["gen_ai.output.messages"])) ?? [];

  // system_instructions / tool_definitions: optimistically read from first
  // record that carries them (schema upgrade in progress).
  const sysRec = turnRecords.find((r) => r["gen_ai.system_instructions"] != null);
  const toolDefsRec = turnRecords.find((r) => r["gen_ai.tool.definitions"] != null);

  return createInvokeAgentInvocation(provider, {
    agentName:
      common?.agentName ??
      asString(first["gen_ai.agent.name"]) ??
      asString(first["gen_ai.agent.type"]) ??
      null,
    agentId: asString(first["gen_ai.agent.id"]) ?? null,
    conversationId: asString(first["gen_ai.session.id"]) ?? null,
    userId: common?.userId ?? null,
    sessionId: common?.sessionId ?? null,
    requestModel,
    responseModelName: usage.responseModelName,
    responseId: usage.responseId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    usageCacheCreationInputTokens: usage.usageCacheCreationInputTokens,
    usageCacheReadInputTokens: usage.usageCacheReadInputTokens,
    inputMessages,
    outputMessages,
    systemInstruction: sysRec ? parseSystemInstructions(sysRec["gen_ai.system_instructions"]) ?? [] : [],
    toolDefinitions: toolDefsRec ? parseToolDefinitions(toolDefsRec["gen_ai.tool.definitions"]) ?? [] : [],
    ...(common?.passthroughTurn
      ? { passthroughAttributes: common.passthroughTurn }
      : {}),
  });
}

/** Build a ReactStepInvocation from a step's records. */
export function buildReactStepInvocation(
  stepRecords: EventLogRecord[],
  common?: TurnCommon,
): ReactStepInvocation {
  const first = stepRecords[0] ?? {};
  // Round may be carried explicitly (gen_ai.react.round) or derivable from
  // step.id suffix like "step_3" or "...:s3".
  let round: number | null = null;
  const explicitRound = asNumber(first["gen_ai.react.round"]);
  if (explicitRound != null) {
    round = explicitRound;
  } else {
    const stepId = asString(first["gen_ai.step.id"]);
    if (stepId) {
      const m = stepId.match(/(?:^|[_:s])(\d+)$/);
      if (m) round = Number(m[1]);
    }
  }

  // finishReason may be carried explicitly (gen_ai.react.finish_reason) or
  // derived from the last llm.response in the step.
  let finishReason: string | null =
    asString(first["gen_ai.react.finish_reason"]) ?? null;
  if (!finishReason) {
    const lastResp = [...stepRecords]
      .reverse()
      .find((r) => r["event.name"] === EventName.LLM_RESPONSE);
    if (lastResp) {
      const reasons = asStringArray(lastResp["gen_ai.response.finish_reasons"]);
      if (reasons?.length) finishReason = reasons[0]!;
    }
  }

  return createReactStepInvocation({
    round,
    finishReason,
    agentName: common?.agentName ?? null,
    userId: common?.userId ?? null,
    sessionId: common?.sessionId ?? null,
    ...(common?.passthroughTurn
      ? { passthroughAttributes: common.passthroughTurn }
      : {}),
  });
}

/**
 * Build an LLMInvocation from a paired llm.request + llm.response.
 *
 * Either side may be undefined (orphan event). The accumulator parameters let
 * the caller supply complete input messages reconstructed across the turn's
 * deltas; passing undefined falls back to reading messages off the request
 * record alone.
 */
export function buildLlmInvocation(
  pair: LlmPair,
  accumulatedInputMessages: InputMessage[] | undefined,
  turnSystemInstruction: MessagePart[] | undefined,
  turnToolDefinitions: ToolDefinition[] | undefined,
  common?: TurnCommon,
): LLMInvocation {
  const req = pair.request;
  const resp = pair.response;
  const source = req ?? resp ?? {};

  const provider = asString(source["gen_ai.provider.name"]) ?? DEFAULT_PROVIDER;
  // request.model fallback chain: req → resp request.model → resp response.model
  const requestModel =
    asString(source["gen_ai.request.model"]) ??
    asString(req?.["gen_ai.request.model"]) ??
    asString(resp?.["gen_ai.request.model"]) ??
    asString(resp?.["gen_ai.response.model"]) ??
    null;

  const inputMessages =
    accumulatedInputMessages ??
    (req ? parseInputMessages(req["gen_ai.input.messages"]) : undefined) ??
    [];

  const outputMessages =
    (resp ? parseOutputMessages(resp["gen_ai.output.messages"]) : undefined) ?? [];

  const finishReasons =
    (resp ? asStringArray(resp["gen_ai.response.finish_reasons"]) : undefined) ?? null;

  const inputTokens = resp ? asNumber(resp["gen_ai.usage.input_tokens"]) ?? null : null;
  const outputTokens = resp ? asNumber(resp["gen_ai.usage.output_tokens"]) ?? null : null;
  const totalTokens = resp ? asNumber(resp["gen_ai.usage.total_tokens"]) ?? null : null;
  const cacheCreate = resp ? asNumber(resp["gen_ai.usage.cache_creation.input_tokens"]) ?? null : null;
  const cacheRead = resp ? asNumber(resp["gen_ai.usage.cache_read.input_tokens"]) ?? null : null;

  // TTFT: read gen_ai.response.time_to_first_token (nanoseconds) from the
  // response record. We inject it via invocation.attributes so it gets
  // written to the span directly — bypassing the monotonic timestamp
  // calculation in applyLlmFinishAttributes (which doesn't work here
  // because handler.startLlm overwrites monotonicStartS).
  const ttftNs = resp ? asNumber(resp["gen_ai.response.time_to_first_token"]) ?? null : null;

  const passthrough = mergePassthrough(common, req, resp);

  return createLLMInvocation({
    operationName: "chat",
    provider,
    requestModel,
    responseModelName:
      (resp ? asString(resp["gen_ai.response.model"]) : undefined) ?? requestModel,
    responseId: (resp ? asString(resp["gen_ai.response.id"]) : undefined) ?? null,
    conversationId: asString(source["gen_ai.session.id"]) ?? null,
    finishReasons,
    inputTokens,
    outputTokens,
    totalTokens,
    usageCacheCreationInputTokens: cacheCreate,
    usageCacheReadInputTokens: cacheRead,
    inputMessages,
    outputMessages,
    systemInstruction: turnSystemInstruction ?? [],
    toolDefinitions: turnToolDefinitions ?? [],
    agentName: common?.agentName ?? null,
    userId: common?.userId ?? null,
    sessionId: common?.sessionId ?? null,
    ...(ttftNs != null && ttftNs >= 0 ? {
      attributes: { "gen_ai.response.time_to_first_token": ttftNs },
    } : {}),
    ...(passthrough ? { passthroughAttributes: passthrough } : {}),
  });
}

/** Build an ExecuteToolInvocation from a tool.call + tool.result pair. */
export function buildExecuteToolInvocation(
  pair: { call?: EventLogRecord; result?: EventLogRecord },
  common?: TurnCommon,
): ExecuteToolInvocation {
  const source = pair.call ?? pair.result ?? {};
  const toolName = asString(source["gen_ai.tool.name"]) ?? "unknown";
  const passthrough = mergePassthrough(common, pair.call, pair.result);
  const skill = resolveSkill(
    pair.call,
    pair.result,
    common?.skillDetection,
  );
  return createExecuteToolInvocation(toolName, {
    toolCallId: asString(source["gen_ai.tool.call.id"]) ?? null,
    toolType: asString(source["gen_ai.tool.type"]) ?? "function",
    toolDescription: asString(source["gen_ai.tool.description"]) ?? null,
    toolCallArguments: pair.call?.["gen_ai.tool.call.arguments"] ?? null,
    toolCallResult: pair.result?.["gen_ai.tool.call.result"] ?? null,
    skillName: skill?.name ?? null,
    skillId: skill?.id ?? null,
    skillVersion: skill?.version ?? null,
    skillDescription: skill?.description ?? null,
    agentName: common?.agentName ?? null,
    userId: common?.userId ?? null,
    sessionId: common?.sessionId ?? null,
    ...(passthrough ? { passthroughAttributes: passthrough } : {}),
  });
}

/* -------- helpers exposed for converter to read turn-level fields -------- */

/** Pull system_instructions for a turn (first record carrying them). */
export function readTurnSystemInstruction(
  turnRecords: EventLogRecord[],
): MessagePart[] | undefined {
  const rec = turnRecords.find((r) => r["gen_ai.system_instructions"] != null);
  if (!rec) return undefined;
  return parseSystemInstructions(rec["gen_ai.system_instructions"]);
}

/** Pull tool_definitions for a turn (first record carrying them). */
export function readTurnToolDefinitions(
  turnRecords: EventLogRecord[],
): ToolDefinition[] | undefined {
  const rec = turnRecords.find((r) => r["gen_ai.tool.definitions"] != null);
  if (!rec) return undefined;
  return parseToolDefinitions(rec["gen_ai.tool.definitions"]);
}
