import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import {
  GEN_AI_SPAN_KIND,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const IN_MSG =
  '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]';
const OUT_MSG =
  '[{"role":"assistant","parts":[{"type":"text","content":"ok"}],"finish_reason":"stop"}]';

/**
 * One turn, two steps. step_1 carries an LLM pair + a TOOL pair; step_2 carries
 * a second LLM pair. Custom fields are scattered so we can assert:
 *   - deployment.env  → present only on step_1 llm.request (turn-level broadcast)
 *   - sampling.temp   → 0.2 on step_1 req, 0.9 on step_2 req (LLM per-record)
 *   - region          → "turn-default" on step_1 req, "tool-local" on tool.call
 *                       (TOOL per-record overrides turn-level)
 *   - gen_ai.span.kind → "HACKED" on step_1 req (fill-only collision decoy)
 */
function buildRecords(): Record<string, unknown>[] {
  const base = {
    "user.id": "emp_001",
    trace_id: TRACE_ID,
    "gen_ai.session.id": "sess_alpha",
    "gen_ai.turn.id": "turn_001",
    "gen_ai.agent.type": "codex",
    "gen_ai.agent.name": "codex",
    "gen_ai.provider.name": "openai",
  };
  return [
    {
      ...base,
      time_unix_nano: 1779667200000000000,
      "event.id": "evt-001",
      "event.name": "llm.request",
      "gen_ai.step.id": "step_1",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.input.messages_delta": IN_MSG,
      "deployment.env": "prod",
      "sampling.temp": 0.2,
      region: "turn-default",
      "gen_ai.span.kind": "HACKED",
    },
    {
      ...base,
      time_unix_nano: 1779667200500000000,
      "event.id": "evt-002",
      "event.name": "llm.response",
      "gen_ai.step.id": "step_1",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.response.model": "gpt-5",
      "gen_ai.response.id": "resp-1",
      "gen_ai.response.finish_reasons": ["tool_calls"],
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.output.messages": OUT_MSG,
    },
    {
      ...base,
      time_unix_nano: 1779667200600000000,
      "event.id": "evt-003",
      "event.name": "tool.call",
      "gen_ai.step.id": "step_1",
      "gen_ai.tool.name": "bash",
      "gen_ai.tool.call.id": "call-001",
      "gen_ai.tool.call.arguments": { cmd: "ls" },
      region: "tool-local",
    },
    {
      ...base,
      time_unix_nano: 1779667201000000000,
      "event.id": "evt-004",
      "event.name": "tool.result",
      "gen_ai.step.id": "step_1",
      "gen_ai.tool.name": "bash",
      "gen_ai.tool.call.id": "call-001",
      "gen_ai.tool.call.result": { stdout: "file.txt\n" },
    },
    {
      ...base,
      time_unix_nano: 1779667202000000000,
      "event.id": "evt-005",
      "event.name": "llm.request",
      "gen_ai.step.id": "step_2",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.input.messages_delta": IN_MSG,
      "sampling.temp": 0.9,
    },
    {
      ...base,
      time_unix_nano: 1779667202500000000,
      "event.id": "evt-006",
      "event.name": "llm.response",
      "gen_ai.step.id": "step_2",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.response.model": "gpt-5",
      "gen_ai.response.id": "resp-2",
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 50,
      "gen_ai.usage.output_tokens": 10,
      "gen_ai.output.messages": OUT_MSG,
    },
  ];
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

describe("event-log → trace pass-through attributes", () => {
  it("turn-level field is broadcast to every span kind", async () => {
    const { spans } = await convertEventLogToReadableSpans(buildRecords(), {
      passthroughKeys: ["deployment.env"],
    });

    // ENTRY + AGENT + 2×STEP + 2×LLM + TOOL = 7
    expect(spans).toHaveLength(7);
    for (const s of spans) {
      expect(
        s.attributes["deployment.env"],
        `kind ${s.attributes[GEN_AI_SPAN_KIND]} should carry turn-level field`,
      ).toBe("prod");
    }
  });

  it("LLM spans read the per-record value off their own request", async () => {
    const { spans } = await convertEventLogToReadableSpans(buildRecords(), {
      passthroughKeys: ["sampling.temp"],
    });

    const llmTemps = spans
      .filter((s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM)
      .map((s) => s.attributes["sampling.temp"])
      .sort();
    expect(llmTemps).toEqual([0.2, 0.9]);

    // Non-LLM spans fall back to the turn-level value (first-seen = 0.2).
    const entry = spans.find(
      (s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY,
    );
    expect(entry!.attributes["sampling.temp"]).toBe(0.2);
  });

  it("TOOL per-record value overrides the turn-level value", async () => {
    const { spans } = await convertEventLogToReadableSpans(buildRecords(), {
      passthroughKeys: ["region"],
    });

    const tool = spans.find(
      (s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.TOOL,
    );
    expect(tool!.attributes.region).toBe("tool-local");

    // Everyone else keeps the turn-level value.
    const agent = spans.find(
      (s) => s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.AGENT,
    );
    expect(agent!.attributes.region).toBe("turn-default");
  });

  it("fill-only: pass-through cannot overwrite a converter-managed attribute", async () => {
    const { spans } = await convertEventLogToReadableSpans(buildRecords(), {
      passthroughKeys: ["gen_ai.span.kind"],
    });

    // Every span keeps its real, converter-assigned kind despite the "HACKED"
    // decoy present in the event log.
    for (const s of spans) {
      expect(s.attributes[GEN_AI_SPAN_KIND]).not.toBe("HACKED");
    }
    // Sanity: the managed kinds are still the real enum values.
    const kinds = spans.map((s) => s.attributes[GEN_AI_SPAN_KIND]);
    expect(kinds).toContain(GenAiSpanKindValues.LLM);
    expect(kinds).toContain(GenAiSpanKindValues.TOOL);
  });

  it("no passthroughKeys → no custom attributes written (backward compatible)", async () => {
    const { spans } = await convertEventLogToReadableSpans(buildRecords());

    for (const s of spans) {
      expect(s.attributes["deployment.env"]).toBeUndefined();
      expect(s.attributes["sampling.temp"]).toBeUndefined();
      expect(s.attributes.region).toBeUndefined();
    }
  });
});
