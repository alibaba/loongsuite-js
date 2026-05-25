import * as os from "node:os";
import * as crypto from "node:crypto";
import type { Turn } from "./state.js";
import type { TokenUsage } from "./transcript.js";
import { buildReactSteps } from "./replay.js";
import { INITIAL_HASH, computeHash, shouldLogFullMessages } from "./logger.js";

export function generateTurnLogRecords(
  turn: Turn,
  turnIndex: number,
  sessionId: string,
  model: string,
  provider: string,
  tokenForThisTurn: TokenUsage[],
  traceId: string | null,
): { records: Record<string, unknown>[]; hash: string } {
  const records: Record<string, unknown>[] = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let stepRound = 0;
  let runningHash = INITIAL_HASH;

  let userId: string;
  try {
    userId = os.userInfo().username;
  } catch {
    userId = "";
  }

  const base: Record<string, unknown> = {
    trace_id: traceId || null,
    "session.id": sessionId,
    "turn.id": turnId,
    "user.id": userId,
    "agent.type": "codex",
  };

  if (turn.prompt) {
    records.push({
      time_unix_nano: String(Math.round(turn.start_time * 1e9)),
      "event.id": crypto.randomUUID(),
      "event.name": "llm.request",
      ...base,
      "message.role": "user",
      "input.messages_delta": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: turn.prompt }] },
      ]),
    });
  }

  const steps = buildReactSteps(turn);
  const tokenQueue = [...tokenForThisTurn];

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]!;
    const tokenEvent = tokenQueue.shift() ?? null;
    const isLastStep = si === steps.length - 1;
    stepRound++;
    const currentStepId = `${turnId}:s${stepRound}`;

    const inputMsgs = step.llm_input_messages;
    const currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
    const logFull = shouldLogFullMessages(runningHash, inputMsgs, currentFullHash);

    const requestRecord: Record<string, unknown> = {
      time_unix_nano: String(Math.round(step.llm_start_time * 1e9)),
      "event.id": crypto.randomUUID(),
      "event.name": "llm.request",
      ...base,
      "step.id": currentStepId,
      "message.role": "assistant",
      "provider.name": provider,
      "request.model": model,
      "input.messages_hash": currentFullHash,
      "input.messages_delta": JSON.stringify(inputMsgs),
    };
    if (logFull) {
      requestRecord["input.messages"] = JSON.stringify(inputMsgs);
    }
    records.push(requestRecord);

    const finishReasons =
      step.tools.length > 0
        ? "tool_calls"
        : isLastStep && turn.last_assistant_message
          ? "stop"
          : "";
    const inputTokens = tokenEvent?.inputTokens ?? 0;
    const outputTokens = tokenEvent?.outputTokens ?? 0;
    // total_tokens 优先用 transcript 上报的源值(语义更稳,未来若计入 reasoning_output 不会失真);
    // 仅在源值缺失/为 0 时回退到 input+output 的派生公式。
    const totalTokens =
      tokenEvent?.totalTokens && tokenEvent.totalTokens > 0
        ? tokenEvent.totalTokens
        : inputTokens + outputTokens;
    const reasoningOutputTokens = tokenEvent?.reasoningOutputTokens ?? 0;

    records.push({
      time_unix_nano: String(Math.round(step.llm_end_time * 1e9)),
      "event.id": crypto.randomUUID(),
      "event.name": "llm.response",
      ...base,
      "step.id": currentStepId,
      "message.role": "assistant",
      "provider.name": provider,
      "request.model": model,
      "response.model": model,
      "response.finish_reasons": finishReasons,
      "usage.input_tokens": inputTokens,
      "usage.output_tokens": outputTokens,
      "usage.cache_read_tokens": tokenEvent?.cachedInputTokens ?? 0,
      "usage.reasoning_output_tokens": reasoningOutputTokens,
      "usage.total_tokens": totalTokens,
      "output.messages": JSON.stringify(step.llm_output_messages),
    });

    runningHash = currentFullHash;

    for (const tool of step.tools) {
      records.push({
        time_unix_nano: String(Math.round(tool.start_time * 1e9)),
        "event.id": crypto.randomUUID(),
        "event.name": "tool.call",
        ...base,
        "step.id": currentStepId,
        "message.role": "tool",
        "tool.name": tool.tool_name,
        "tool.call.id": tool.tool_use_id,
        "tool.arguments": JSON.stringify(tool.tool_input),
      });

      const durationMs = (tool.end_time - tool.start_time) * 1000;
      records.push({
        time_unix_nano: String(Math.round(tool.end_time * 1e9)),
        "event.id": crypto.randomUUID(),
        "event.name": "tool.result",
        ...base,
        "step.id": currentStepId,
        "message.role": "tool",
        "tool.name": tool.tool_name,
        "tool.call.id": tool.tool_use_id,
        "tool.result": JSON.stringify(tool.tool_response),
        "tool.result.status": "success",
        "tool.result.duration_ms": durationMs > 0 ? durationMs : undefined,
      });
    }
  }

  return { records, hash: runningHash };
}
