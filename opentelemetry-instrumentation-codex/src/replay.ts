import {
  ExtendedTelemetryHandler,
  createEntryInvocation,
  createInvokeAgentInvocation,
  createReactStepInvocation,
  createExecuteToolInvocation,
  createLLMInvocation,
  GEN_AI_FRAMEWORK,
  type InputMessage,
  type OutputMessage,
} from "@loongsuite/opentelemetry-util-genai";
import type {
  SessionState,
  Turn,
  SessionEvent,
  PreToolUseEvent,
  PostToolUseEvent,
} from "./state.js";
import { splitIntoTurns } from "./state.js";
import type { TranscriptData, TokenUsage } from "./transcript.js";

// --- Internal models ---

export interface ToolRecord {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
  tool_response: unknown;
  start_time: number;
  end_time: number;
}

export interface ReActStep {
  round: number;
  start_time: number;
  end_time: number;
  llm_start_time: number;
  llm_end_time: number;
  llm_input_messages: InputMessage[];
  llm_output_messages: OutputMessage[];
  tools: ToolRecord[];
}

// --- Time conversion ---

// SessionState/Turn/Step/Tool 内部的 timestamp 字段单位是"秒"(Date.now() / 1000)。
// OTel JS SDK 的 tracer.startSpan({ startTime: number }) 把 number 解释为"毫秒",
// 所以传给 handler 的所有时间值必须先 *1000。否则上报的 nano 时间戳会少 3 位
// (cms2.0 平台会把它当成微秒导致查不到数据)。
function toMs(epochSec: number): number {
  return epochSec * 1000;
}

// --- Public API ---

export function replaySession(
  handler: ExtendedTelemetryHandler,
  state: SessionState,
  transcriptData?: TranscriptData | null,
): string[] {
  const turns = splitIntoTurns(state);
  const traceIds: string[] = [];

  // Fallback 队列:仅在 turn_id 未命中 tokenEventsByTurn 时使用
  const fallbackQueue = transcriptData?.tokenEvents
    ? [...transcriptData.tokenEvents]
    : [];

  for (const turn of turns) {
    const traceId = replayTurn(
      handler,
      turn,
      state.session_id,
      transcriptData ?? null,
      fallbackQueue,
    );
    if (traceId) traceIds.push(traceId);
  }
  return traceIds;
}

// --- Per-turn trace replay ---

function replayTurn(
  handler: ExtendedTelemetryHandler,
  turn: Turn,
  sessionId: string,
  transcriptData: TranscriptData | null,
  fallbackQueue: TokenUsage[],
): string | null {
  const provider = transcriptData?.modelProvider || "openai";
  const model = turn.model !== "unknown" && turn.model
    ? turn.model
    : transcriptData?.model || "unknown";

  // Session 级 system_instructions / tool.definitions(整个 session 共享,
  // 同时贴在 AGENT span 与每个 LLM span 上,符合 ARMS GenAI 语义规范)。
  const systemInstruction = transcriptData?.systemInstruction;
  const toolDefinitions = transcriptData?.toolDefinitions;

  const turnInputMessages: InputMessage[] = [
    { role: "user", parts: [{ type: "text" as const, content: turn.prompt }] },
  ];
  const turnOutputMessages: OutputMessage[] = turn.last_assistant_message
    ? [
        {
          role: "assistant",
          parts: [{ type: "text" as const, content: turn.last_assistant_message }],
          finishReason: "stop",
        },
      ]
    : [];

  // ENTRY span
  const entryInv = createEntryInvocation({ sessionId });
  entryInv.inputMessages = turnInputMessages;
  entryInv.outputMessages = turnOutputMessages;
  handler.startEntry(entryInv, undefined, toMs(turn.start_time));

  const traceId = entryInv.span?.spanContext().traceId ?? null;

  // Build steps first to know how many LLM spans we'll create
  const steps = buildReactSteps(turn);
  const llmCount = steps.length;

  // 主路径:按 turn_id 从分组里取本 turn 的 token 事件;
  // Fallback:turn_id 未命中时(理论不会),从扁平队列头部消费。
  const byTurn = transcriptData?.tokenEventsByTurn?.get(turn.turn_id);
  const turnTokens: (TokenUsage | null)[] = [];
  if (byTurn && byTurn.length > 0) {
    for (let i = 0; i < llmCount; i++) {
      turnTokens.push(byTurn[i] ?? null);
    }
  } else {
    for (let i = 0; i < llmCount; i++) {
      turnTokens.push(fallbackQueue.length > 0 ? fallbackQueue.shift()! : null);
    }
  }

  // Aggregate token totals for AGENT span
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  for (const t of turnTokens) {
    if (t) {
      totalInputTokens += t.inputTokens;
      totalOutputTokens += t.outputTokens;
      totalCachedInputTokens += t.cachedInputTokens;
    }
  }

  // AGENT span
  const agentInv = createInvokeAgentInvocation(provider, {
    agentName: "codex",
    requestModel: model,
    responseModelName: model,
    conversationId: sessionId,
    inputTokens: totalInputTokens || undefined,
    outputTokens: totalOutputTokens || undefined,
    usageCacheReadInputTokens: totalCachedInputTokens || undefined,
    systemInstruction,
    toolDefinitions,
    attributes: { [GEN_AI_FRAMEWORK]: "codex" },
  });
  agentInv.inputMessages = turnInputMessages;
  agentInv.outputMessages = turnOutputMessages;
  handler.startInvokeAgent(agentInv, entryInv.contextToken ?? undefined, toMs(turn.start_time));

  // Replay STEP spans
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]!;
    const tokenEvent = turnTokens[si] ?? null;
    const isLastStep = si === steps.length - 1;

    const stepInv = createReactStepInvocation({ round: step.round });
    handler.startReactStep(
      stepInv,
      agentInv.contextToken ?? undefined,
      toMs(step.start_time),
    );

    // LLM span within the step
    const finishReasons: string[] = step.tools.length > 0
      ? ["tool_calls"]
      : (isLastStep && turn.last_assistant_message ? ["stop"] : []);

    const llmInv = createLLMInvocation({
      operationName: "chat",
      requestModel: model,
      provider,
      responseModelName: model,
      conversationId: sessionId,
      inputTokens: tokenEvent?.inputTokens,
      outputTokens: tokenEvent?.outputTokens,
      usageCacheReadInputTokens: tokenEvent?.cachedInputTokens || undefined,
      finishReasons: finishReasons.length > 0 ? finishReasons : undefined,
      systemInstruction,
      toolDefinitions,
    });
    llmInv.inputMessages = step.llm_input_messages;
    llmInv.outputMessages = step.llm_output_messages;
    handler.startLlm(llmInv, stepInv.contextToken ?? undefined, toMs(step.llm_start_time));
    handler.stopLlm(llmInv, toMs(step.llm_end_time));

    // TOOL spans within the step
    for (const tool of step.tools) {
      const toolInv = createExecuteToolInvocation(tool.tool_name, {
        toolCallId: tool.tool_use_id,
        toolType: "function",
        toolCallArguments: tool.tool_input,
        toolCallResult: tool.tool_response,
      });
      handler.startExecuteTool(
        toolInv,
        stepInv.contextToken ?? undefined,
        toMs(tool.start_time),
      );
      handler.stopExecuteTool(toolInv, toMs(tool.end_time));
    }

    handler.stopReactStep(stepInv, toMs(step.end_time));
  }

  handler.stopInvokeAgent(agentInv, toMs(turn.end_time));
  handler.stopEntry(entryInv, toMs(turn.end_time));

  return traceId;
}

// --- ReAct step construction ---

export function buildReactSteps(turn: Turn): ReActStep[] {
  const events = turn.events;
  const steps: ReActStep[] = [];

  // pre/post tool pairing
  const preToolMap = new Map<
    string,
    { timestamp: number; tool_name: string; tool_input: unknown }
  >();

  // State tracking
  let llmStartTime = turn.start_time;
  let currentTools: ToolRecord[] = [];
  let pendingToolIds = new Set<string>();
  let round = 0;
  let previousToolResults: ToolRecord[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    if (event.type === "pre_tool_use") {
      const pre = event as PreToolUseEvent;

      if (pendingToolIds.size === 0 && currentTools.length > 0) {
        const llmEndTime = llmStartTime;
        steps.push(
          finalizeStep(
            ++round,
            turn,
            llmStartTime,
            llmEndTime,
            previousToolResults,
            currentTools,
          ),
        );
        previousToolResults = [...currentTools];
        currentTools = [];
        llmStartTime = steps[steps.length - 1]!.end_time;
      }

      preToolMap.set(pre.tool_use_id, {
        timestamp: pre.timestamp,
        tool_name: pre.tool_name,
        tool_input: pre.tool_input,
      });
      pendingToolIds.add(pre.tool_use_id);
    } else if (event.type === "post_tool_use") {
      const post = event as PostToolUseEvent;
      const pre = preToolMap.get(post.tool_use_id);

      currentTools.push({
        tool_name: pre?.tool_name ?? post.tool_name,
        tool_use_id: post.tool_use_id,
        tool_input: pre?.tool_input ?? null,
        tool_response: post.tool_response,
        start_time: pre?.timestamp ?? post.timestamp,
        end_time: post.timestamp,
      });

      pendingToolIds.delete(post.tool_use_id);
      preToolMap.delete(post.tool_use_id);
    }
  }

  // Finalize remaining step(s)
  if (currentTools.length > 0) {
    steps.push(
      finalizeStep(++round, turn, llmStartTime, 0, previousToolResults, currentTools),
    );
    previousToolResults = [...currentTools];
    currentTools = [];

    if (turn.last_assistant_message) {
      const lastToolEnd = steps[steps.length - 1]!.end_time;
      steps.push(
        finalizeFinalStep(++round, turn, lastToolEnd, previousToolResults),
      );
    }
  } else {
    steps.push(
      finalizeFinalStep(++round, turn, turn.start_time, previousToolResults),
    );
  }

  return steps;
}

function finalizeStep(
  round: number,
  turn: Turn,
  llmStartTime: number,
  _llmEndTimeHint: number,
  previousTools: ToolRecord[],
  tools: ToolRecord[],
): ReActStep {
  const firstToolStart = tools.length > 0 ? tools[0]!.start_time : turn.end_time;
  const lastToolEnd =
    tools.length > 0 ? Math.max(...tools.map((t) => t.end_time)) : turn.end_time;

  const llmEndTime = firstToolStart;

  const llmInputMessages = buildLlmInputMessages(
    round === 1 ? turn.prompt : null,
    previousTools,
  );

  const llmOutputMessages = buildLlmOutputMessagesWithTools(tools);

  return {
    round,
    start_time: llmStartTime,
    end_time: lastToolEnd,
    llm_start_time: llmStartTime,
    llm_end_time: llmEndTime,
    llm_input_messages: llmInputMessages,
    llm_output_messages: llmOutputMessages,
    tools,
  };
}

function finalizeFinalStep(
  round: number,
  turn: Turn,
  llmStartTime: number,
  previousTools: ToolRecord[],
): ReActStep {
  const llmInputMessages = buildLlmInputMessages(
    round === 1 ? turn.prompt : null,
    previousTools,
  );

  const llmOutputMessages: OutputMessage[] = turn.last_assistant_message
    ? [
        {
          role: "assistant",
          parts: [{ type: "text" as const, content: turn.last_assistant_message }],
          finishReason: "stop",
        },
      ]
    : [];

  return {
    round,
    start_time: llmStartTime,
    end_time: turn.end_time,
    llm_start_time: llmStartTime,
    llm_end_time: turn.end_time,
    llm_input_messages: llmInputMessages,
    llm_output_messages: llmOutputMessages,
    tools: [],
  };
}

// --- Message construction helpers ---

function buildLlmInputMessages(
  userPrompt: string | null,
  previousTools: ToolRecord[],
): InputMessage[] {
  if (userPrompt) {
    return [
      { role: "user", parts: [{ type: "text" as const, content: userPrompt }] },
    ];
  }

  if (previousTools.length > 0) {
    return [
      {
        role: "tool",
        parts: previousTools.map((t) => ({
          type: "tool_call_response" as const,
          id: t.tool_use_id,
          response: t.tool_response,
        })),
      },
    ];
  }

  return [];
}

function buildLlmOutputMessagesWithTools(tools: ToolRecord[]): OutputMessage[] {
  if (tools.length === 0) return [];

  return [
    {
      role: "assistant",
      parts: tools.map((t) => ({
        type: "tool_call" as const,
        id: t.tool_use_id,
        name: t.tool_name,
        arguments: t.tool_input,
      })),
      finishReason: "tool_calls",
    },
  ];
}
