import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import {
  GEN_AI_SPAN_KIND,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const IN_MSG = '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]';
const OUT_MSG =
  '[{"role":"assistant","parts":[{"type":"text","content":"ok"}],"finish_reason":"stop"}]';

const BASE = {
  "user.id": "emp_001",
  trace_id: TRACE_ID,
  "gen_ai.session.id": "sess_alpha",
  "gen_ai.turn.id": "turn_001",
  "gen_ai.agent.type": "codex",
  "gen_ai.agent.name": "codex",
  "gen_ai.provider.name": "anthropic",
};

/** A single-step turn with one LLM pair. `extra` is merged into the response. */
function oneStepTurn(extra: Record<string, unknown>): Record<string, unknown>[] {
  return [
    {
      ...BASE,
      time_unix_nano: 1779667200000000000,
      "event.id": "req-1",
      "event.name": "llm.request",
      "gen_ai.step.id": "step_1",
      "gen_ai.request.model": "claude-x",
      "gen_ai.input.messages_delta": IN_MSG,
    },
    {
      ...BASE,
      time_unix_nano: 1779667200500000000,
      "event.id": "resp-1",
      "event.name": "llm.response",
      "gen_ai.step.id": "step_1",
      "gen_ai.request.model": "claude-x",
      "gen_ai.response.model": "claude-x",
      "gen_ai.response.id": "r1",
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.output.messages": OUT_MSG,
      ...extra,
    },
  ];
}

function llmSpan(spans: readonly { attributes: Record<string, unknown> }[]) {
  return spans.find(
    (s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM,
  );
}
function agentSpan(spans: readonly { attributes: Record<string, unknown> }[]) {
  return spans.find(
    (s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.AGENT,
  );
}

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

describe("total_tokens: prefer upstream-reported, else compute input+output", () => {
  it("LLM span honors the upstream-reported total (even when != input+output)", async () => {
    // Anthropic-style: cache tokens make the real total larger than input+output.
    const { spans } = await convertEventLogToReadableSpans(
      oneStepTurn({ "gen_ai.usage.total_tokens": 350 }),
    );
    expect(llmSpan(spans)!.attributes[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(350);
  });

  it("LLM span falls back to input+output when no total reported", async () => {
    const { spans } = await convertEventLogToReadableSpans(oneStepTurn({}));
    expect(llmSpan(spans)!.attributes[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(120);
  });

  it("LLM span falls back when reported total is 0 but input/output are non-zero", async () => {
    const { spans } = await convertEventLogToReadableSpans(
      oneStepTurn({ "gen_ai.usage.total_tokens": 0 }),
    );
    expect(llmSpan(spans)!.attributes[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(120);
  });

  it("AGENT span sums reported totals when every response reports one", async () => {
    const records = [
      ...oneStepTurn({ "gen_ai.usage.total_tokens": 350 }),
      // second step, second response, also reports a total
      {
        ...BASE,
        time_unix_nano: 1779667201000000000,
        "event.id": "req-2",
        "event.name": "llm.request",
        "gen_ai.step.id": "step_2",
        "gen_ai.request.model": "claude-x",
        "gen_ai.input.messages_delta": IN_MSG,
      },
      {
        ...BASE,
        time_unix_nano: 1779667201500000000,
        "event.id": "resp-2",
        "event.name": "llm.response",
        "gen_ai.step.id": "step_2",
        "gen_ai.response.model": "claude-x",
        "gen_ai.response.id": "r2",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 50,
        "gen_ai.usage.output_tokens": 10,
        "gen_ai.usage.total_tokens": 200,
        "gen_ai.output.messages": OUT_MSG,
      },
    ];
    const { spans } = await convertEventLogToReadableSpans(records);
    expect(agentSpan(spans)!.attributes[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(550);
  });

  it("AGENT span falls back to summed input+output when a response lacks total", async () => {
    const records = [
      ...oneStepTurn({ "gen_ai.usage.total_tokens": 350 }), // step_1 reports
      {
        ...BASE,
        time_unix_nano: 1779667201000000000,
        "event.id": "req-2",
        "event.name": "llm.request",
        "gen_ai.step.id": "step_2",
        "gen_ai.request.model": "claude-x",
        "gen_ai.input.messages_delta": IN_MSG,
      },
      {
        ...BASE,
        time_unix_nano: 1779667201500000000,
        "event.id": "resp-2",
        "event.name": "llm.response",
        "gen_ai.step.id": "step_2",
        "gen_ai.response.model": "claude-x",
        "gen_ai.response.id": "r2",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 50,
        "gen_ai.usage.output_tokens": 10,
        // no total reported here → whole AGENT falls back
        "gen_ai.output.messages": OUT_MSG,
      },
    ];
    const { spans } = await convertEventLogToReadableSpans(records);
    // fallback = (100+20) + (50+10) = 180
    expect(agentSpan(spans)!.attributes[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(180);
  });

  it("AGENT span falls back when one response reports total=0 with non-zero tokens", async () => {
    const records = [
      ...oneStepTurn({ "gen_ai.usage.total_tokens": 350 }), // step_1 reports 350
      {
        ...BASE,
        time_unix_nano: 1779667201000000000,
        "event.id": "req-2",
        "event.name": "llm.request",
        "gen_ai.step.id": "step_2",
        "gen_ai.request.model": "claude-x",
        "gen_ai.input.messages_delta": IN_MSG,
      },
      {
        ...BASE,
        time_unix_nano: 1779667201500000000,
        "event.id": "resp-2",
        "event.name": "llm.response",
        "gen_ai.step.id": "step_2",
        "gen_ai.response.model": "claude-x",
        "gen_ai.response.id": "r2",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 50,
        "gen_ai.usage.output_tokens": 10,
        "gen_ai.usage.total_tokens": 0, // degenerate → whole AGENT falls back
        "gen_ai.output.messages": OUT_MSG,
      },
    ];
    const { spans } = await convertEventLogToReadableSpans(records);
    // fallback = (100+20) + (50+10) = 180, NOT 350 + 0
    expect(agentSpan(spans)!.attributes[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(180);
  });
});
