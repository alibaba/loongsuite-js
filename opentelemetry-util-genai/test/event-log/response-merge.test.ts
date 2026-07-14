import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mergeResponsesByResponseId } from "../../src/event-log/grouping.js";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import { EventName, type EventLogRecord } from "../../src/event-log/types.js";
import {
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SPAN_KIND,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  ORIGINAL_ENV.OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  ORIGINAL_ENV.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "SPAN_ONLY";
});
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("mergeResponsesByResponseId", () => {
  it("merges 2 responses with same response.id into 1 with concatenated parts", () => {
    const responses: EventLogRecord[] = [
      {
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.response.id": "msg-1",
        time_unix_nano: "1000000000000000",
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts: [{ type: "reasoning", content: "thinking" }], finish_reason: "stop" },
        ]),
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.response.model": "qwen-max",
      },
      {
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.response.id": "msg-1",
        time_unix_nano: "2000000000000000",
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts: [{ type: "text", content: "answer" }], finish_reason: "stop" },
        ]),
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": 50,
        "gen_ai.response.model": "unknown",
      },
    ];
    const merged = mergeResponsesByResponseId(responses);
    expect(merged).toHaveLength(1);

    const m = merged[0]!;
    const msgs = JSON.parse(m["gen_ai.output.messages"] as string);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].parts).toHaveLength(2);
    expect(msgs[0].parts[0].type).toBe("reasoning");
    expect(msgs[0].parts[1].type).toBe("text");
    expect(msgs[0].finish_reason).toBe("stop");

    // Token: first non-zero wins
    expect(m["gen_ai.usage.input_tokens"]).toBe(100);
    expect(m["gen_ai.usage.output_tokens"]).toBe(50);
    // Model: last non-"unknown" wins
    expect(m["gen_ai.response.model"]).toBe("qwen-max");
  });

  it("does NOT merge responses with different response.id", () => {
    const responses: EventLogRecord[] = [
      { "event.name": EventName.LLM_RESPONSE, "gen_ai.response.id": "msg-A", time_unix_nano: "1000000000000000" },
      { "event.name": EventName.LLM_RESPONSE, "gen_ai.response.id": "msg-B", time_unix_nano: "2000000000000000" },
    ];
    expect(mergeResponsesByResponseId(responses)).toHaveLength(2);
  });

  it("passes through responses without response.id unchanged", () => {
    const responses: EventLogRecord[] = [
      { "event.name": EventName.LLM_RESPONSE, time_unix_nano: "1000000000000000" },
      { "event.name": EventName.LLM_RESPONSE, time_unix_nano: "2000000000000000" },
    ];
    expect(mergeResponsesByResponseId(responses)).toHaveLength(2);
  });

  it("uses earliest time as start and stores latest time in _merged_end_time", () => {
    const responses: EventLogRecord[] = [
      { "event.name": EventName.LLM_RESPONSE, "gen_ai.response.id": "msg-X", time_unix_nano: "3000000000000000" },
      { "event.name": EventName.LLM_RESPONSE, "gen_ai.response.id": "msg-X", time_unix_nano: "1000000000000000" },
    ];
    const merged = mergeResponsesByResponseId(responses);
    expect(merged).toHaveLength(1);
    // Earliest
    expect(merged[0]!["time_unix_nano"]).toBe("1000000000000000");
    // Latest stored for endTime
    expect(merged[0]!["_merged_end_time_unix_nano"]).toBe("3000000000000000");
  });
});

describe("end-to-end: split thinking/text with same response.id → 1 LLM span", () => {
  it("1 request + 2 same-id responses → 1 LLM span with both parts + correct tokens", async () => {
    const records: EventLogRecord[] = [
      {
        time_unix_nano: "1780000001000000000",
        "event.id": "req1",
        "event.name": EventName.LLM_REQUEST,
        trace_id: "aabbccdd" + "11223344" + "55667788" + "99001122",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.request.model": "qwen-max",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "hi" }] },
        ]),
      },
      {
        time_unix_nano: "1780000002000000000",
        "event.id": "resp-think",
        "event.name": EventName.LLM_RESPONSE,
        trace_id: "aabbccdd" + "11223344" + "55667788" + "99001122",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.request.model": "qwen-max",
        "gen_ai.response.model": "qwen-max",
        "gen_ai.response.id": "msg-SAME",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts: [{ type: "reasoning", content: "thinking..." }], finish_reason: "stop" },
        ]),
      },
      {
        time_unix_nano: "1780000002500000000",
        "event.id": "resp-text",
        "event.name": EventName.LLM_RESPONSE,
        trace_id: "aabbccdd" + "11223344" + "55667788" + "99001122",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.response.model": "qwen-max",
        "gen_ai.response.id": "msg-SAME",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": 50,
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts: [{ type: "text", content: "answer" }], finish_reason: "stop" },
        ]),
      },
    ];

    const { spans, warnings } = await convertEventLogToReadableSpans(records);
    const llms = spans.filter((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM);

    expect(llms).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("Orphan"))).toHaveLength(0);

    const llm = llms[0]!;
    // Parts merged: reasoning + text
    const outMsgs = JSON.parse(llm.attributes[GEN_AI_OUTPUT_MESSAGES] as string);
    expect(outMsgs[0].parts).toHaveLength(2);
    expect(outMsgs[0].parts[0].type).toBe("reasoning");
    expect(outMsgs[0].parts[1].type).toBe("text");
    // Token: first non-zero
    expect(llm.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(llm.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(50);
    // Model present
    expect(llm.attributes[GEN_AI_REQUEST_MODEL]).toBe("qwen-max");
    // Duration > 0 (merged end time used)
    const durMs =
      (llm.endTime[0] * 1000 + Math.floor(llm.endTime[1] / 1e6)) -
      (llm.startTime[0] * 1000 + Math.floor(llm.startTime[1] / 1e6));
    expect(durMs).toBeGreaterThan(0);
  });
});

describe("end-to-end: response-only (no request) with response.model fallback", () => {
  it("orphan llm.response still gets model from response.model", async () => {
    const records: EventLogRecord[] = [
      {
        time_unix_nano: "1780000002000000000",
        "event.id": "r1",
        "event.name": EventName.LLM_RESPONSE,
        trace_id: "bbccddee" + "11223344" + "55667788" + "99001122",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "s:t1",
        "gen_ai.step.id": "s:t1:s1",
        "user.id": "u",
        "gen_ai.agent.type": "demo",
        "gen_ai.provider.name": "qwen",
        "gen_ai.response.model": "qwen-max",
        "gen_ai.response.id": "msg-only",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 10,
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts: [{ type: "text", content: "hello" }], finish_reason: "stop" },
        ]),
      },
    ];

    const { spans, warnings } = await convertEventLogToReadableSpans(records);
    const llm = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM)!;

    // Model falls back from response.model
    expect(llm.attributes[GEN_AI_REQUEST_MODEL]).toBe("qwen-max");
    expect(llm.attributes[GEN_AI_RESPONSE_MODEL]).toBe("qwen-max");
    // Span name includes model (not "chat unknown")
    expect(llm.name).toBe("chat qwen-max");
    // Orphan warning still present (expected)
    expect(warnings.some((w) => w.includes("Orphan llm.response"))).toBe(true);
  });
});
