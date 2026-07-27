import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  getLlmCommonAttributes,
  getLlmSpanName,
  getLlmRequestAttributes,
  getLlmResponseAttributes,
  getLlmMessagesAttributesForSpan,
  getToolDefinitionsForSpan,
  applyLlmFinishAttributes,
  applyErrorAttributes,
  maybeEmitLlmEvent,
} from "../src/span-utils.js";
import type { LLMInvocation, GenAIError } from "../src/types.js";
import { createLLMInvocation } from "../src/types.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_SPAN_KIND,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_INPUT_MULTIMODAL_METADATA,
  GEN_AI_OUTPUT_MULTIMODAL_METADATA,
} from "../src/semconv/gen-ai-extended-attributes.js";

describe("span-utils", () => {
  describe("getLlmSpanName", () => {
    it("returns operation + model", () => {
      const inv = createLLMInvocation({
        operationName: "chat",
        requestModel: "gpt-4",
      });
      expect(getLlmSpanName(inv)).toBe("chat gpt-4");
    });

    it("returns just operation when no model", () => {
      const inv = createLLMInvocation({ operationName: "chat" });
      expect(getLlmSpanName(inv)).toBe("chat");
    });
  });

  describe("getLlmCommonAttributes", () => {
    it("includes operation_name and span_kind", () => {
      const inv = createLLMInvocation({
        operationName: "chat",
        requestModel: "gpt-4",
        provider: "openai",
      });
      const attrs = getLlmCommonAttributes(inv);
      expect(attrs[GEN_AI_OPERATION_NAME]).toBe("chat");
      expect(attrs[GEN_AI_SPAN_KIND]).toBe("LLM");
      expect(attrs[GEN_AI_REQUEST_MODEL]).toBe("gpt-4");
    });
  });

  describe("getLlmRequestAttributes", () => {
    it("includes temperature and other request attrs", () => {
      const inv = createLLMInvocation({
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 100,
        seed: 42,
      });
      const attrs = getLlmRequestAttributes(inv);
      expect(attrs["gen_ai.request.temperature"]).toBe(0.7);
      expect(attrs["gen_ai.request.top_p"]).toBe(0.9);
      expect(attrs["gen_ai.request.max_tokens"]).toBe(100);
      expect(attrs["gen_ai.request.seed"]).toBe(42);
    });

    it("omits choiceCount when 1", () => {
      const inv = createLLMInvocation({ choiceCount: 1 });
      const attrs = getLlmRequestAttributes(inv);
      expect(attrs["gen_ai.request.choice.count"]).toBeUndefined();
    });
  });

  describe("getLlmResponseAttributes", () => {
    it("calculates total tokens", () => {
      const inv = createLLMInvocation({
        inputTokens: 10,
        outputTokens: 20,
      });
      const attrs = getLlmResponseAttributes(inv);
      expect(attrs[GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
      expect(attrs[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(20);
      expect(attrs[GEN_AI_USAGE_TOTAL_TOKENS]).toBe(30);
    });

    it("extracts finish reasons from output messages", () => {
      const inv = createLLMInvocation({
        outputMessages: [
          {
            role: "assistant",
            parts: [{ type: "text", content: "hi" }],
            finishReason: "stop",
          },
        ],
      });
      const attrs = getLlmResponseAttributes(inv);
      expect(attrs[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
    });

    it("deduplicates finish reasons", () => {
      const inv = createLLMInvocation({
        outputMessages: [
          {
            role: "assistant",
            parts: [{ type: "text", content: "a" }],
            finishReason: "stop",
          },
          {
            role: "assistant",
            parts: [{ type: "text", content: "b" }],
            finishReason: "stop",
          },
        ],
      });
      const attrs = getLlmResponseAttributes(inv);
      expect(attrs[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
    });

    it("computes TTFT", () => {
      const inv = createLLMInvocation({
        monotonicStartS: 100.0,
        monotonicFirstTokenS: 100.5,
      });
      const attrs = getLlmResponseAttributes(inv);
      expect(attrs[GEN_AI_RESPONSE_TIME_TO_FIRST_TOKEN]).toBe(500000000);
    });
  });

  describe("getLlmMessagesAttributesForSpan", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      saved["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      saved["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"];
    });
    afterEach(() => {
      for (const [key, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    });

    it("returns empty when not experimental", () => {
      delete process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      const attrs = getLlmMessagesAttributesForSpan(
        [{ role: "user", parts: [{ type: "text", content: "hi" }] }],
        [],
      );
      expect(attrs).toEqual({});
    });

    it("returns messages when in SPAN_ONLY", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";
      const attrs = getLlmMessagesAttributesForSpan(
        [{ role: "user", parts: [{ type: "text", content: "hello" }] }],
        [],
      );
      expect(attrs[GEN_AI_INPUT_MESSAGES]).toBeDefined();
      expect(typeof attrs[GEN_AI_INPUT_MESSAGES]).toBe("string");
    });

    it("serializes multimodal part fields with schema-compliant names", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";
      const attrs = getLlmMessagesAttributesForSpan(
        [
          {
            role: "user",
            parts: [
              {
                type: "uri",
                mimeType: "audio/wav",
                modality: "audio",
                uri: "https://example.com/input.wav",
              },
              {
                type: "file",
                mimeType: "image/png",
                modality: "image",
                fileId: "file-1",
              },
            ],
          },
        ],
        [],
      );

      const messages = JSON.parse(attrs[GEN_AI_INPUT_MESSAGES] as string);
      expect(messages[0].parts).toEqual([
        {
          type: "uri",
          mime_type: "audio/wav",
          modality: "audio",
          uri: "https://example.com/input.wav",
        },
        {
          type: "file",
          mime_type: "image/png",
          modality: "image",
          file_id: "file-1",
        },
      ]);
      expect(
        JSON.parse(
          attrs[GEN_AI_INPUT_MULTIMODAL_METADATA] as string,
        ),
      ).toEqual([
        {
          type: "uri",
          mime_type: "audio/wav",
          uri: "https://example.com/input.wav",
          modality: "audio",
        },
      ]);
    });

    it("extracts input and output URI metadata only", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";
      const attrs = getLlmMessagesAttributesForSpan(
        [
          {
            role: "user",
            parts: [
              { type: "text", content: "describe the media" },
              {
                type: "uri",
                mimeType: "image/png",
                modality: "image",
                uri: "https://example.com/input.png",
              },
              {
                type: "file",
                mimeType: "application/pdf",
                modality: "document",
                fileId: "file-1",
              },
              {
                type: "base64_blob",
                mimeType: "audio/wav",
                modality: "audio",
                content: "ZGF0YQ==",
              },
              {
                type: "uri",
              },
            ],
          },
        ],
        [
          {
            role: "assistant",
            parts: [
              { type: "text", content: "generated video" },
              {
                type: "uri",
                mimeType: "video/mp4",
                modality: "video",
                uri: "https://example.com/output.mp4",
              },
              {
                type: "uri",
                mimeType: "audio/mpeg",
                modality: "audio",
                uri: "https://example.com/output.mp3",
              },
            ],
            finishReason: "stop",
          },
        ],
      );

      expect(typeof attrs[GEN_AI_INPUT_MESSAGES]).toBe("string");
      expect(typeof attrs[GEN_AI_OUTPUT_MESSAGES]).toBe("string");
      expect(
        JSON.parse(
          attrs[GEN_AI_INPUT_MULTIMODAL_METADATA] as string,
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
          attrs[GEN_AI_OUTPUT_MULTIMODAL_METADATA] as string,
        ),
      ).toEqual([
        {
          type: "uri",
          mime_type: "video/mp4",
          uri: "https://example.com/output.mp4",
          modality: "video",
        },
        {
          type: "uri",
          mime_type: "audio/mpeg",
          uri: "https://example.com/output.mp3",
          modality: "audio",
        },
      ]);
    });

    it.each(["NO_CONTENT", "EVENT_ONLY"])(
      "does not add span multimodal metadata in %s mode",
      (mode) => {
        process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
          "gen_ai_latest_experimental";
        process.env[
          "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"
        ] = mode;

        const attrs = getLlmMessagesAttributesForSpan(
          [
            {
              role: "user",
              parts: [
                {
                  type: "uri",
                  mimeType: "image/jpeg",
                  modality: "image",
                  uri: "https://example.com/input.jpg",
                },
              ],
            },
          ],
          [],
        );

        expect(attrs).toEqual({});
      },
    );

    it("adds span multimodal metadata in SPAN_AND_EVENT mode", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_AND_EVENT";

      const attrs = getLlmMessagesAttributesForSpan(
        [
          {
            role: "user",
            parts: [
              {
                type: "uri",
                mimeType: "image/jpeg",
                modality: "image",
                uri: "https://example.com/input.jpg",
              },
            ],
          },
        ],
        [],
      );

      expect(
        JSON.parse(
          attrs[GEN_AI_INPUT_MULTIMODAL_METADATA] as string,
        ),
      ).toHaveLength(1);
    });

    it("does not derive metadata from system instructions", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";

      const attrs = getLlmMessagesAttributesForSpan([], [], [
        {
          type: "uri",
          mimeType: "image/jpeg",
          modality: "image",
          uri: "https://example.com/system.jpg",
        },
      ]);

      expect(attrs[GEN_AI_INPUT_MULTIMODAL_METADATA]).toBeUndefined();
      expect(attrs[GEN_AI_OUTPUT_MULTIMODAL_METADATA]).toBeUndefined();
    });
  });

  describe("applyLlmFinishAttributes", () => {
    it("updates span name and sets attributes", () => {
      const mockSpan = {
        updateName: vi.fn(),
        setAttributes: vi.fn(),
        setAttribute: vi.fn(),
        isRecording: vi.fn().mockReturnValue(true),
        setStatus: vi.fn(),
      };
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        provider: "openai",
        inputTokens: 10,
        outputTokens: 20,
      });
      applyLlmFinishAttributes(mockSpan as any, inv);

      expect(mockSpan.updateName).toHaveBeenCalledWith("chat gpt-4");
      expect(mockSpan.setAttributes).toHaveBeenCalled();
    });

    it("allows explicit attributes to override derived multimodal metadata", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] =
        "SPAN_ONLY";
      const mockSpan = {
        updateName: vi.fn(),
        setAttributes: vi.fn(),
        setAttribute: vi.fn(),
        isRecording: vi.fn().mockReturnValue(true),
        setStatus: vi.fn(),
      };
      const override = JSON.stringify([
        {
          type: "uri",
          mime_type: "image/webp",
          uri: "sls://project/logstore/object",
          modality: "image",
        },
      ]);
      const inv = createLLMInvocation({
        requestModel: "gpt-4",
        inputMessages: [
          {
            role: "user",
            parts: [
              {
                type: "uri",
                mimeType: "image/jpeg",
                modality: "image",
                uri: "https://example.com/input.jpg",
              },
            ],
          },
        ],
        attributes: {
          [GEN_AI_INPUT_MULTIMODAL_METADATA]: override,
        },
      });

      applyLlmFinishAttributes(mockSpan as any, inv);

      const applied = mockSpan.setAttributes.mock.calls[0][0];
      expect(applied[GEN_AI_INPUT_MULTIMODAL_METADATA]).toBe(
        override,
      );
    });
  });

  describe("applyErrorAttributes", () => {
    it("sets error status and error type", () => {
      const mockSpan = {
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
        isRecording: vi.fn().mockReturnValue(true),
      };
      const error: GenAIError = { message: "test error", type: "TestError" };
      applyErrorAttributes(mockSpan as any, error);

      expect(mockSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "test error",
      });
      expect(mockSpan.setAttribute).toHaveBeenCalledWith(
        "error.type",
        "TestError",
      );
    });
  });

  describe("maybeEmitLlmEvent", () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      saved["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        process.env["OTEL_SEMCONV_STABILITY_OPT_IN"];
      saved["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] =
        process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"];
    });
    afterEach(() => {
      for (const [key, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    });

    it("does nothing when logger is null", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] = "true";
      const mockSpan = {} as any;
      const inv = createLLMInvocation();
      maybeEmitLlmEvent(null, mockSpan, inv);
    });

    it("emits event when experimental and emit enabled", () => {
      process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] =
        "gen_ai_latest_experimental";
      process.env["OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT"] = "true";
      const logger = { emit: vi.fn() };
      const mockSpan = {} as any;
      const inv = createLLMInvocation({ requestModel: "gpt-4" });
      maybeEmitLlmEvent(logger, mockSpan, inv);
      expect(logger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "gen_ai.client.inference.operation.details",
        }),
      );
    });
  });
});
