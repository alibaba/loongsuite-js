import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import { EventName, type EventLogRecord } from "../../src/event-log/types.js";
import {
  GEN_AI_INPUT_MULTIMODAL_METADATA,
  GEN_AI_OUTPUT_MULTIMODAL_METADATA,
  GEN_AI_SPAN_KIND,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  ORIGINAL_ENV.OTEL_SEMCONV_STABILITY_OPT_IN =
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  ORIGINAL_ENV.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN =
    "gen_ai_latest_experimental";
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    "SPAN_ONLY";
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("event-log multimodal metadata", () => {
  it("derives input and output metadata from schema snake_case URI parts", async () => {
    const base = {
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      "gen_ai.turn.id": "turn-1",
      "gen_ai.session.id": "session-1",
      "gen_ai.agent.name": "multimodal-agent",
      "gen_ai.provider.name": "openai",
      "gen_ai.step.id": "step-1",
    };
    const records: EventLogRecord[] = [
      {
        ...base,
        time_unix_nano: "1785196800000000000",
        "event.id": "request-1",
        "event.name": EventName.LLM_REQUEST,
        "gen_ai.request.model": "vision-model",
        "gen_ai.input.messages_delta": JSON.stringify([
          {
            role: "user",
            parts: [
              {
                type: "uri",
                mime_type: "image/png",
                modality: "image",
                uri: "https://example.com/input.png",
              },
            ],
          },
        ]),
      },
      {
        ...base,
        time_unix_nano: "1785196801000000000",
        "event.id": "response-1",
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.request.model": "vision-model",
        "gen_ai.response.model": "vision-model",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [
              {
                type: "uri",
                mime_type: "image/webp",
                modality: "image",
                uri: "https://example.com/output.webp",
              },
            ],
            finish_reason: "stop",
          },
        ]),
      },
    ];

    const { spans, warnings } =
      await convertEventLogToReadableSpans(records);

    expect(warnings).toEqual([]);
    const messageSpans = spans.filter((span) =>
      [
        GenAiSpanKindValues.ENTRY,
        GenAiSpanKindValues.AGENT,
        GenAiSpanKindValues.LLM,
      ].includes(
        span.attributes[GEN_AI_SPAN_KIND] as GenAiSpanKindValues,
      ),
    );
    expect(messageSpans).toHaveLength(3);

    for (const span of messageSpans) {
      expect(
        JSON.parse(
          span.attributes[
            GEN_AI_INPUT_MULTIMODAL_METADATA
          ] as string,
        ),
      ).toEqual([
        {
          type: "uri",
          mime_type: "image/png",
          uri: "https://example.com/input.png",
          modality: "image",
        },
      ]);
      expect(
        JSON.parse(
          span.attributes[
            GEN_AI_OUTPUT_MULTIMODAL_METADATA
          ] as string,
        ),
      ).toEqual([
        {
          type: "uri",
          mime_type: "image/webp",
          uri: "https://example.com/output.webp",
          modality: "image",
        },
      ]);
    }
  });
});
