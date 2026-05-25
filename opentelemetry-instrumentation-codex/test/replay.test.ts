import { describe, test, expect } from "vitest";
import * as path from "node:path";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ExtendedTelemetryHandler } from "@loongsuite/opentelemetry-util-genai";

import { parseTranscript } from "../src/transcript.js";
import { replaySession } from "../src/replay.js";
import type { SessionState } from "../src/state.js";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const THREE_TURNS = path.join(FIXTURES_DIR, "transcript-three-turns.jsonl");

const TURN_1 = "019e5e3f-9984-7663-8637-0940a4bbeb4f";
const TURN_2 = "019e5e46-0d03-7b91-9084-cde6caab321c";
const TURN_3 = "019e5e46-333e-7d41-b168-89e806098d9c";

// 在 fixture 数据基础上构造一份"三个 turn 都有完整 hook 事件"的 SessionState,
// 让 replaySession 能正常出 ENTRY/AGENT/STEP/LLM span 树。
function buildState(transcriptPath: string): SessionState {
  const t0 = 1700000000;
  return {
    session_id: "replay-test-session",
    model: "gpt-5.5",
    start_time: t0,
    transcript_path: transcriptPath,
    events: [
      { type: "session_start", timestamp: t0, source: "test", model: "gpt-5.5" },
      { type: "user_prompt_submit", timestamp: t0 + 1, prompt: "Q1", turn_id: TURN_1, model: "gpt-5.5" },
      { type: "stop", timestamp: t0 + 2, turn_id: TURN_1, last_assistant_message: "A1", model: "gpt-5.5" },
      { type: "user_prompt_submit", timestamp: t0 + 10, prompt: "Q2", turn_id: TURN_2, model: "gpt-5.5" },
      { type: "stop", timestamp: t0 + 11, turn_id: TURN_2, last_assistant_message: "A2", model: "gpt-5.5" },
      { type: "user_prompt_submit", timestamp: t0 + 20, prompt: "Q3", turn_id: TURN_3, model: "gpt-5.5" },
      { type: "stop", timestamp: t0 + 21, turn_id: TURN_3, last_assistant_message: "A3", model: "gpt-5.5" },
    ],
  };
}

function findLLMSpansForTurn(spans: ReadableSpan[], turnIndex: number): ReadableSpan[] {
  // 三个 turn 各产生一条 trace,traceId 不同。按 traceId 分组,
  // turnIndex 0/1/2 对应 traceIds[0]/[1]/[2](按调用顺序排列)。
  const traceOrder: string[] = [];
  for (const s of spans) {
    const tid = s.spanContext().traceId;
    if (!traceOrder.includes(tid)) traceOrder.push(tid);
  }
  const targetTraceId = traceOrder[turnIndex];
  return spans.filter(
    (s) =>
      s.spanContext().traceId === targetTraceId &&
      // LLM span 的 name 是 chat <model> 或者类似,简单按属性筛
      typeof s.attributes["gen_ai.usage.input_tokens"] === "number",
  );
}

describe("replaySession - OTLP path token allocation", () => {
  test("三个 turn 的 LLM span 分别拿到 18391/18640/18904", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });

    const transcriptData = parseTranscript(THREE_TURNS);
    expect(transcriptData).not.toBeNull();
    const state = buildState(THREE_TURNS);

    const traceIds = replaySession(handler, state, transcriptData);
    expect(traceIds).toHaveLength(3);

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    // Turn 1 的 LLM span
    const llm1 = findLLMSpansForTurn(spans, 0);
    expect(llm1.length).toBeGreaterThan(0);
    expect(llm1[0].attributes["gen_ai.usage.input_tokens"]).toBe(18391);
    expect(llm1[0].attributes["gen_ai.usage.output_tokens"]).toBe(238);

    // Turn 2 的 LLM span — 关键回归
    const llm2 = findLLMSpansForTurn(spans, 1);
    expect(llm2.length).toBeGreaterThan(0);
    expect(llm2[0].attributes["gen_ai.usage.input_tokens"]).toBe(18640);
    expect(llm2[0].attributes["gen_ai.usage.output_tokens"]).toBe(253);

    // Turn 3 的 LLM span
    const llm3 = findLLMSpansForTurn(spans, 2);
    expect(llm3.length).toBeGreaterThan(0);
    expect(llm3[0].attributes["gen_ai.usage.input_tokens"]).toBe(18904);
    expect(llm3[0].attributes["gen_ai.usage.output_tokens"]).toBe(229);

    // AGENT span:简单的 turn,每个 turn 只 1 个 LLM step,
    // AGENT 的汇总 token 应等于该 turn 唯一 LLM step 的 token
    const agent2Spans = spans.filter((s) => {
      const tid = s.spanContext().traceId;
      const traceOrder: string[] = [];
      for (const sp of spans) {
        const id = sp.spanContext().traceId;
        if (!traceOrder.includes(id)) traceOrder.push(id);
      }
      return tid === traceOrder[1] && s.name.toLowerCase().includes("invoke_agent");
    });
    if (agent2Spans.length > 0) {
      expect(agent2Spans[0].attributes["gen_ai.usage.input_tokens"]).toBe(18640);
    }
  });
});
