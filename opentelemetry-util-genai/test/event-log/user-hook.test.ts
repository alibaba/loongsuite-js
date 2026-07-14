import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  isUserHookCandidate,
  partitionUserHookRequests,
} from "../../src/event-log/grouping.js";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import { EventName, type EventLogRecord } from "../../src/event-log/types.js";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_SPAN_KIND,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const T = (overrides: Partial<EventLogRecord>): EventLogRecord => ({
  time_unix_nano: 1779667200000000000,
  "event.id": "e",
  "event.name": EventName.LLM_REQUEST,
  "user.id": "u",
  ...overrides,
});

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

describe("isUserHookCandidate (structural check)", () => {
  it("returns true for llm.request missing both step.id and model", () => {
    expect(isUserHookCandidate(T({}))).toBe(true);
  });

  it("returns false when step.id is present", () => {
    expect(isUserHookCandidate(T({ "gen_ai.step.id": "s1" }))).toBe(false);
  });

  it("returns false when request.model is present", () => {
    expect(isUserHookCandidate(T({ "gen_ai.request.model": "gpt-5" }))).toBe(false);
  });

  it("returns false for non llm.request event.name", () => {
    expect(isUserHookCandidate(T({ "event.name": EventName.LLM_RESPONSE }))).toBe(false);
    expect(isUserHookCandidate(T({ "event.name": EventName.TOOL_CALL }))).toBe(false);
  });
});

describe("partitionUserHookRequests (combined rule with orphan check)", () => {
  it("classifies orphan candidate as user-hook", () => {
    const userHook = T({
      "event.name": EventName.LLM_REQUEST,
      "gen_ai.input.messages_delta": JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "你是谁" }] },
      ]),
    });
    const real = T({
      "time_unix_nano": 1779667200100000000,
      "event.name": EventName.LLM_REQUEST,
      "gen_ai.step.id": "s1",
      "gen_ai.request.model": "gpt-5",
    });
    const resp = T({
      "time_unix_nano": 1779667200200000000,
      "event.name": EventName.LLM_RESPONSE,
      "gen_ai.step.id": "s1",
    });
    const { userHooks, remaining } = partitionUserHookRequests([userHook, real, resp]);
    expect(userHooks).toEqual([userHook]);
    expect(remaining).toEqual([real, resp]);
  });

  it("does NOT classify candidate when it can pair with a response", () => {
    // Edge case: structural candidate but turn has spare llm.response that
    // pairs with it. Per the strict rule (orphan required), it stays as a
    // regular LLM.
    const candidate = T({ "event.name": EventName.LLM_REQUEST });
    const resp = T({
      "time_unix_nano": 1779667200100000000,
      "event.name": EventName.LLM_RESPONSE,
    });
    const { userHooks, remaining } = partitionUserHookRequests([candidate, resp]);
    expect(userHooks).toEqual([]);
    expect(remaining).toEqual([candidate, resp]);
  });

  it("returns empty userHooks when no candidate exists", () => {
    const a = T({
      "event.name": EventName.LLM_REQUEST,
      "gen_ai.step.id": "s1",
      "gen_ai.request.model": "gpt-5",
    });
    const { userHooks, remaining } = partitionUserHookRequests([a]);
    expect(userHooks).toEqual([]);
    expect(remaining).toEqual([a]);
  });
});

describe("converter: user-hook events merged into ENTRY", () => {
  it("does NOT generate a phantom LLM span for user-hook events; their messages flow into ENTRY input", async () => {
    const records: EventLogRecord[] = [
      // user-hook (orphan llm.request, no step, no model)
      {
        time_unix_nano: 1779667200000000000,
        "event.id": "user-hook",
        "event.name": EventName.LLM_REQUEST,
        "user.id": "u",
        trace_id: "11111111111111111111111111111111",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.agent.type": "claude-code",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "你是谁" }] },
        ]),
      },
      // real llm.request (has step.id and model)
      {
        time_unix_nano: 1779667200100000000,
        "event.id": "real-req",
        "event.name": EventName.LLM_REQUEST,
        "user.id": "u",
        trace_id: "11111111111111111111111111111111",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.step.id": "s1",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "你是谁" }] },
        ]),
      },
      // matching response
      {
        time_unix_nano: 1779667200200000000,
        "event.id": "real-resp",
        "event.name": EventName.LLM_RESPONSE,
        "user.id": "u",
        trace_id: "11111111111111111111111111111111",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.step.id": "s1",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [{ type: "text", content: "我是 Claude" }],
            finish_reason: "stop",
          },
        ]),
      },
    ];

    const { spans, warnings } = await convertEventLogToReadableSpans(records);

    // span 数：ENTRY + AGENT + STEP + LLM = 4（user-hook 不再生成独立 LLM span）
    expect(spans).toHaveLength(4);
    const kinds = spans.map((s) => s.attributes[GEN_AI_SPAN_KIND]).sort();
    expect(kinds).toEqual(
      [
        GenAiSpanKindValues.ENTRY,
        GenAiSpanKindValues.AGENT,
        GenAiSpanKindValues.STEP,
        GenAiSpanKindValues.LLM,
      ].sort(),
    );

    // ENTRY 的 input.messages 来自 user-hook event
    const entry = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY)!;
    const entryMsgs = JSON.parse(entry.attributes[GEN_AI_INPUT_MESSAGES] as string);
    expect(entryMsgs).toEqual([
      { role: "user", parts: [{ type: "text", content: "你是谁" }] },
    ]);

    // info-level warning 提示
    const userHookWarn = warnings.find((w) => w.includes("user-hook prompt"));
    expect(userHookWarn).toBeDefined();
    expect(userHookWarn).toContain("Treated 1");
  });

  it("when no user-hook event exists, ENTRY falls back to first llm.request (regression guard)", async () => {
    const records: EventLogRecord[] = [
      {
        time_unix_nano: 1779667200000000000,
        "event.id": "r",
        "event.name": EventName.LLM_REQUEST,
        "user.id": "u",
        trace_id: "22222222222222222222222222222222",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t2",
        "gen_ai.step.id": "s1",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "hello" }] },
        ]),
      },
      {
        time_unix_nano: 1779667200100000000,
        "event.id": "p",
        "event.name": EventName.LLM_RESPONSE,
        "user.id": "u",
        trace_id: "22222222222222222222222222222222",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t2",
        "gen_ai.step.id": "s1",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.output_tokens": 1,
      },
    ];
    const { spans, warnings } = await convertEventLogToReadableSpans(records);
    expect(spans).toHaveLength(4);
    expect(warnings.filter((w) => w.includes("user-hook"))).toHaveLength(0);
    const entry = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY)!;
    const entryMsgs = JSON.parse(entry.attributes[GEN_AI_INPUT_MESSAGES] as string);
    expect(entryMsgs[0].parts[0].content).toBe("hello");
  });
});

describe("converter: event.name=other as user-input source (做法 A)", () => {
  it("extracts input.messages from 'other' event into ENTRY span, does NOT generate any LLM span for it", async () => {
    const records: EventLogRecord[] = [
      // 做法 A: event.name = "other" carrying user prompt
      {
        time_unix_nano: 1779667200000000000,
        "event.id": "other-prompt",
        "event.name": "other" as any,
        "user.id": "u",
        trace_id: "33333333333333333333333333333333",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.agent.type": "claude-code",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "做法A用户输入" }] },
        ]),
      },
      // Real LLM call (has step.id + model)
      {
        time_unix_nano: 1779667200100000000,
        "event.id": "real-req",
        "event.name": EventName.LLM_REQUEST,
        "user.id": "u",
        trace_id: "33333333333333333333333333333333",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.step.id": "t1:s1",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "做法A用户输入" }] },
        ]),
      },
      {
        time_unix_nano: 1779667200200000000,
        "event.id": "real-resp",
        "event.name": EventName.LLM_RESPONSE,
        "user.id": "u",
        trace_id: "33333333333333333333333333333333",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.step.id": "t1:s1",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "gen_ai.output.messages": JSON.stringify([
          { role: "assistant", parts: [{ type: "text", content: "回答" }], finish_reason: "stop" },
        ]),
      },
    ];

    const { spans, warnings } = await convertEventLogToReadableSpans(records);

    // 4 spans: ENTRY + AGENT + STEP + LLM (no span for "other" event)
    expect(spans).toHaveLength(4);
    const kinds = spans.map((s) => s.attributes[GEN_AI_SPAN_KIND]).sort();
    expect(kinds).toEqual(
      [GenAiSpanKindValues.ENTRY, GenAiSpanKindValues.AGENT, GenAiSpanKindValues.STEP, GenAiSpanKindValues.LLM].sort(),
    );

    // ENTRY input comes from the "other" event
    const entry = spans.find((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY)!;
    const entryMsgs = JSON.parse(entry.attributes[GEN_AI_INPUT_MESSAGES] as string);
    expect(entryMsgs[0].parts[0].content).toBe("做法A用户输入");

    // No user-hook warning (做法 A doesn't trigger it)
    expect(warnings.filter((w) => w.includes("user-hook"))).toHaveLength(0);
  });

  it("'other' events without input.messages are ignored (no side effect)", async () => {
    const records: EventLogRecord[] = [
      // "other" without messages — should be silently ignored
      {
        time_unix_nano: 1779667200000000000,
        "event.id": "stop-signal",
        "event.name": "other" as any,
        "user.id": "u",
        trace_id: "44444444444444444444444444444444",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.agent.type": "cursor",
        "agent.cursor.hook_event_name": "stop",
      },
      {
        time_unix_nano: 1779667200100000000,
        "event.id": "req",
        "event.name": EventName.LLM_REQUEST,
        "user.id": "u",
        trace_id: "44444444444444444444444444444444",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.step.id": "t1:s1",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.input.messages_delta": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "hi" }] }]),
      },
      {
        time_unix_nano: 1779667200200000000,
        "event.id": "resp",
        "event.name": EventName.LLM_RESPONSE,
        "user.id": "u",
        trace_id: "44444444444444444444444444444444",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t1",
        "gen_ai.step.id": "t1:s1",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.output_tokens": 1,
      },
    ];

    const { spans } = await convertEventLogToReadableSpans(records);
    // 4 spans: ENTRY + AGENT + STEP + LLM (the "other" without messages is ignored)
    expect(spans).toHaveLength(4);
  });
});
