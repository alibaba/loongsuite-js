// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import {
  context,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
  type Context,
} from "@opentelemetry/api";
import {
  applyEntryFinishAttributes,
  applyExecuteToolFinishAttributes,
  applyInvokeAgentFinishAttributes,
  applyLlmFinishAttributes,
  applyReactStepFinishAttributes,
  createEntryInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createLLMInvocation,
  createReactStepInvocation,
} from "@loongsuite/opentelemetry-util-genai";
import type {
  InputMessage,
  OutputMessage,
} from "@loongsuite/opentelemetry-util-genai";

import type { SessionEvent, Turn } from "./state.js";
import type { TokenEvent, TranscriptData } from "./transcript.js";
import { createToolTitle } from "./hooks.js";

/** Constitution C2: SDK interprets `startTime: number` as milliseconds. */
export function toMs(epochSec: number): number {
  if (!Number.isFinite(epochSec) || epochSec < 0) return Date.now();
  // If caller already passed ms, accept it (heuristic: > 1e12).
  if (epochSec > 1e12) return Math.round(epochSec);
  return Math.round(epochSec * 1000);
}

interface ReactStep {
  round: number;
  llm: TokenEvent | null;
  /** When the LLM call was *issued* (request sent). */
  llmStartMs: number;
  /** When the LLM response finished landing — the assistant chunks' shared timestamp. */
  llmEndMs: number;
  tools: Array<{
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    toolResponse: unknown;
    isError: boolean;
    requestedAtMs: number;
    completedAtMs: number | null;
  }>;
  /** Step boundary = LLM start. */
  startMs: number;
  /** Step boundary = max(LLM end, last tool completion). */
  endMs: number;
}

/**
 * Build ReAct steps for a single turn.
 *
 * Strategy:
 *   - The transcript's tokenEvents are time-ordered LLM responses; their `timestampMs`
 *     marks when the response *finished* landing (qodercli writes all chunks of a
 *     response at once, so all chunks of a given message.id share that timestamp).
 *   - Therefore each LLM's *end* time is `tokenEvent.timestampMs`. Its *start* time
 *     is approximated by:
 *       - first LLM in the turn  → `turn.startedAt` (when the user submitted the prompt)
 *       - subsequent LLMs        → end of the previous step's last tool, or, if the
 *                                  previous step had no tools, the previous LLM's end
 *   - Each STEP starts at its LLM start and ends at max(LLM end, last tool completion).
 *   - If a turn has no LLM calls (corner case), produce one synthetic STEP.
 */
export function buildReactSteps(
  turn: Turn,
  transcript: TranscriptData,
): ReactStep[] {
  const turnStartMs = toMs(turn.startedAt);
  const turnEndMs = turn.endedAt != null ? toMs(turn.endedAt) : Date.now();

  const eligibleLlms = transcript.tokenEvents.filter(
    (e) => e.timestampMs >= turnStartMs - 5 && e.timestampMs <= turnEndMs + 5,
  );

  const toolMap = new Map<string, (typeof transcript.toolCalls)[number]>();
  for (const t of transcript.toolCalls) toolMap.set(t.toolUseId, t);

  const steps: ReactStep[] = [];
  let prevStepEndMs = turnStartMs;

  for (let i = 0; i < eligibleLlms.length; i++) {
    const llm = eligibleLlms[i]!;
    const tools = llm.toolUses
      .map((u) => toolMap.get(u.id))
      .filter(
        (v): v is (typeof transcript.toolCalls)[number] => v !== undefined,
      );

    const llmEndMs = llm.timestampMs;
    // LLM start = when the request was issued. Approximated by the prior step boundary
    // (turn start for the first LLM, previous tool's completion for subsequent ones).
    let llmStartMs = prevStepEndMs;
    // Defensive clamps: a clock skew or write-out-of-order should not produce a
    // negative-duration span. Keep at least 1 ms even when our approximation is wrong.
    if (llmStartMs > llmEndMs) llmStartMs = Math.max(llmEndMs - 1, turnStartMs);
    if (llmStartMs >= llmEndMs) llmStartMs = llmEndMs - 1;

    const lastToolEndMs = tools.reduce(
      (acc, t) => Math.max(acc, t.completedAtMs ?? t.requestedAtMs),
      llmEndMs,
    );
    const stepEndMs = Math.max(lastToolEndMs, llmEndMs);

    steps.push({
      round: i + 1,
      llm,
      llmStartMs,
      llmEndMs,
      tools,
      startMs: llmStartMs,
      endMs: stepEndMs,
    });

    prevStepEndMs = stepEndMs;
  }

  if (steps.length === 0) {
    steps.push({
      round: 1,
      llm: null,
      llmStartMs: turnStartMs,
      llmEndMs: turnEndMs,
      tools: [],
      startMs: turnStartMs,
      endMs: turnEndMs,
    });
  }

  return steps;
}

/** Recognized MCP-style tool prefix → toolType "extension". */
function classifyToolType(name: string): string {
  return name.startsWith("mcp__") ? "extension" : "function";
}

function turnInputMessages(turn: Turn): InputMessage[] {
  return [
    {
      role: "user",
      parts: [{ type: "text", content: turn.userPromptText }],
    },
  ];
}

function turnOutputMessages(
  transcript: TranscriptData,
  steps: ReactStep[],
): OutputMessage[] {
  // Prefer the last step's LLM output; fall back to transcript's final assistant message.
  for (let i = steps.length - 1; i >= 0; i--) {
    const llm = steps[i]!.llm;
    if (llm && llm.outputMessages.length > 0) {
      return llm.outputMessages;
    }
  }
  if (transcript.finalAssistantMessage) {
    return [transcript.finalAssistantMessage];
  }
  return [];
}

function aggregateTurnUsage(steps: ReactStep[]): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  for (const s of steps) {
    if (!s.llm) continue;
    if (s.llm.inputTokens) inputTokens += s.llm.inputTokens;
    if (s.llm.outputTokens) outputTokens += s.llm.outputTokens;
    if (s.llm.cacheCreationInputTokens)
      cacheCreationInputTokens += s.llm.cacheCreationInputTokens;
    if (s.llm.cacheReadInputTokens)
      cacheReadInputTokens += s.llm.cacheReadInputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

export interface ReplayTurnArgs {
  turn: Turn;
  transcript: TranscriptData;
  tracer: Tracer;
  /** Session ID (carried through to ENTRY span as `gen_ai.session.id`). */
  sessionId: string;
  /** Turn index (0-based) within the session — used for span name disambiguation. */
  turnIndex: number;
  /** Subagent results to render as nested AGENT spans (resolved from SubagentStop events). */
  subagentReplays?: ReplayTurnArgs[];
}

/**
 * Replay a single turn into an OTel span tree:
 *
 *   ENTRY (one trace per turn)
 *     └── AGENT (qodercli)
 *           ├── STEP #1
 *           │     ├── LLM (chat <model>)
 *           │     └── TOOL ...
 *           └── STEP #N
 */
export function replayTurn(args: ReplayTurnArgs): void {
  const { turn, transcript, tracer, sessionId, turnIndex } = args;
  const turnStartMs = toMs(turn.startedAt);
  const turnEndMs = turn.endedAt != null ? toMs(turn.endedAt) : Date.now();
  const steps = buildReactSteps(turn, transcript);

  const inputMessages = turnInputMessages(turn);
  const outputMessages = turnOutputMessages(transcript, steps);
  const usage = aggregateTurnUsage(steps);

  // ─── ENTRY ────────────────────────────────────────────────────────────────
  const entrySpan = tracer.startSpan(
    "enter_ai_application_system",
    { startTime: turnStartMs },
  );
  const entryCtx = trace.setSpan(context.active(), entrySpan);

  const entryInvocation = createEntryInvocation({
    sessionId,
    inputMessages,
    outputMessages,
  });
  entryInvocation.attributes = {
    ...(entryInvocation.attributes ?? {}),
    "qodercli.turn_index": turnIndex,
  };
  applyEntryFinishAttributes(entrySpan, entryInvocation);

  try {
    // ─── AGENT ─────────────────────────────────────────────────────────────
    const agentSpan = tracer.startSpan(
      "invoke_agent qodercli",
      { startTime: turnStartMs },
      entryCtx,
    );
    const agentCtx = trace.setSpan(entryCtx, agentSpan);

    const agentInvocation = createInvokeAgentInvocation(
      transcript.modelProvider || "unknown",
      {
        agentName: "qodercli",
        inputMessages,
        outputMessages,
        systemInstruction: transcript.systemInstruction,
        toolDefinitions: transcript.toolDefinitions,
        requestModel: transcript.model || null,
        responseModelName: transcript.model || null,
        inputTokens: usage.inputTokens || null,
        outputTokens: usage.outputTokens || null,
        usageCacheCreationInputTokens: usage.cacheCreationInputTokens || null,
        usageCacheReadInputTokens: usage.cacheReadInputTokens || null,
      },
    );
    applyInvokeAgentFinishAttributes(agentSpan, agentInvocation);

    try {
      for (const step of steps) {
        renderStep(step, tracer, agentCtx, transcript);
      }

      // Subagent nested AGENT spans, attached as children of the AGENT span.
      if (args.subagentReplays) {
        for (const sub of args.subagentReplays) {
          replayTurn({ ...sub, tracer, turnIndex: 0 });
        }
      }

      agentSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      agentSpan.recordException(err as Error);
      agentSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error)?.message,
      });
    } finally {
      agentSpan.end(turnEndMs);
    }
    entrySpan.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    entrySpan.recordException(err as Error);
    entrySpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: (err as Error)?.message,
    });
  } finally {
    entrySpan.end(turnEndMs);
  }
}

function renderStep(
  step: ReactStep,
  tracer: Tracer,
  parentCtx: Context,
  transcript: TranscriptData,
): void {
  const stepSpan = tracer.startSpan(
    "react step",
    { startTime: step.startMs },
    parentCtx,
  );
  const stepCtx = trace.setSpan(parentCtx, stepSpan);

  const stepInvocation = createReactStepInvocation({
    round: step.round,
    finishReason: step.llm?.finishReasons[0] ?? null,
  });
  applyReactStepFinishAttributes(stepSpan, stepInvocation);

  try {
    if (step.llm) {
      renderLlm(step.llm, step.llmStartMs, step.llmEndMs, tracer, stepCtx, transcript);
    }
    for (const t of step.tools) {
      renderTool(t, tracer, stepCtx);
    }
  } finally {
    stepSpan.end(step.endMs);
  }
}

function renderLlm(
  llm: TokenEvent,
  startMs: number,
  endMs: number,
  tracer: Tracer,
  parentCtx: Context,
  transcript: TranscriptData,
): void {
  const llmSpan = tracer.startSpan(
    `chat ${llm.model || "model"}`.trim(),
    { startTime: startMs },
    parentCtx,
  );
  try {
    const inv = createLLMInvocation({
      requestModel: llm.model || null,
      responseModelName: llm.model || null,
      provider: llm.providerName,
      finishReasons: llm.finishReasons,
      inputTokens: llm.inputTokens,
      outputTokens: llm.outputTokens,
      usageCacheCreationInputTokens: llm.cacheCreationInputTokens,
      usageCacheReadInputTokens: llm.cacheReadInputTokens,
      inputMessages: llm.inputMessages,
      outputMessages: llm.outputMessages,
      systemInstruction: transcript.systemInstruction,
      toolDefinitions: transcript.toolDefinitions,
    });
    applyLlmFinishAttributes(llmSpan, inv);
    llmSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    llmSpan.recordException(err as Error);
    llmSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: (err as Error)?.message,
    });
  } finally {
    llmSpan.end(endMs);
  }
}

function renderTool(
  t: {
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    toolResponse: unknown;
    isError: boolean;
    requestedAtMs: number;
    completedAtMs: number | null;
  },
  tracer: Tracer,
  parentCtx: Context,
): void {
  const startMs = t.requestedAtMs;
  const endMs = t.completedAtMs ?? startMs + 1;
  const toolSpan = tracer.startSpan(
    createToolTitle(t.toolName, t.toolInput),
    { startTime: startMs },
    parentCtx,
  );
  try {
    const inv = createExecuteToolInvocation(t.toolName || "tool", {
      toolCallId: t.toolUseId,
      toolType: classifyToolType(t.toolName),
      toolCallArguments: t.toolInput,
      toolCallResult: t.toolResponse,
    });
    applyExecuteToolFinishAttributes(toolSpan, inv);
    if (t.isError) {
      toolSpan.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      toolSpan.setStatus({ code: SpanStatusCode.OK });
    }
  } catch (err) {
    toolSpan.recordException(err as Error);
    toolSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: (err as Error)?.message,
    });
  } finally {
    toolSpan.end(endMs);
  }
}

/**
 * Optionally annotate the active ENTRY span with notification / pre-compact events
 * (they don't warrant their own spans, but the user might want to see them in trace UI).
 */
export function attachOutOfBandEventsToSpan(
  span: Span,
  events: SessionEvent[],
): void {
  for (const ev of events) {
    if (ev.type === "notification") {
      span.addEvent(
        `notification: ${ev.title ?? ""}`,
        { message: ev.message ?? "" },
        toMs(ev.timestampSec),
      );
    } else if (ev.type === "pre_compact") {
      span.addEvent(
        `pre_compact: ${ev.trigger ?? ""}`,
        {},
        toMs(ev.timestampSec),
      );
    }
  }
}
