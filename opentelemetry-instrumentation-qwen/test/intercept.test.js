// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

// intercept.js has side-effects (auto-installs interceptors), so we need
// to carefully require just the exported test helpers.
// We suppress the auto-install by preventing fetch patch from activating.

let intercept;
beforeAll(() => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  intercept = require("../src/intercept");
  globalThis.fetch = savedFetch;
});

describe("intercept.js parsing helpers", () => {
  describe("detectProtocol", () => {
    it("detects OpenAI chat completions path", () => {
      expect(intercept._detectProtocol("/v1/chat/completions")).toBe("openai-chat");
    });

    it("detects DashScope compatible-mode path", () => {
      expect(intercept._detectProtocol("/compatible-mode/v1/chat/completions")).toBe("openai-chat");
    });

    it("detects Anthropic messages path", () => {
      expect(intercept._detectProtocol("/v1/messages")).toBe("anthropic");
    });

    it("detects OpenAI responses path", () => {
      expect(intercept._detectProtocol("/v1/responses")).toBe("openai-responses");
    });

    it("returns null for non-API paths", () => {
      expect(intercept._detectProtocol("/api/health")).toBeNull();
    });
  });

  describe("extractRequestFields", () => {
    it("extracts OpenAI chat fields", () => {
      const body = JSON.stringify({
        model: "qwen-max",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      });
      const result = intercept._extractRequestFields(body, "openai-chat");
      expect(result.model).toBe("qwen-max");
      expect(result.system).toHaveLength(1);
      expect(result.system[0].content).toBe("You are helpful.");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Hello");
    });

    it("extracts Anthropic fields", () => {
      const body = JSON.stringify({
        model: "claude-3-5-sonnet",
        system: "Be helpful",
        messages: [{ role: "user", content: "Hi" }],
      });
      const result = intercept._extractRequestFields(body, "anthropic");
      expect(result.model).toBe("claude-3-5-sonnet");
      expect(result.system).toBe("Be helpful");
    });

    it("handles invalid JSON gracefully", () => {
      const result = intercept._extractRequestFields("not json", "openai-chat");
      expect(result.model).toBe("");
      expect(result.messages).toBeNull();
    });
  });

  describe("isInternalCall", () => {
    it("detects English title generation", () => {
      const result = intercept._isInternalCall({
        system: "Generate a concise, sentence-case title for this conversation",
      });
      expect(result).toBe(true);
    });

    it("detects Chinese title generation", () => {
      const result = intercept._isInternalCall({
        system: "请生成一个简洁的标题",
      });
      expect(result).toBe(true);
    });

    it("returns false for normal requests", () => {
      const result = intercept._isInternalCall({
        system: "You are a helpful assistant",
      });
      expect(result).toBe(false);
    });

    it("returns false when no system prompt", () => {
      expect(intercept._isInternalCall({ system: null })).toBe(false);
    });
  });

  describe("parseOpenAIChatJsonResponse", () => {
    it("parses a standard chat completion response", () => {
      const body = Buffer.from(JSON.stringify({
        id: "chatcmpl-123",
        model: "qwen-max",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }));

      const result = intercept._parseOpenAIChatJsonResponse(body);
      expect(result.id).toBe("chatcmpl-123");
      expect(result.model).toBe("qwen-max");
      expect(result.input_tokens).toBe(10);
      expect(result.output_tokens).toBe(5);
      expect(result.content_blocks).toHaveLength(1);
      expect(result.content_blocks[0].text).toBe("Hello!");
      expect(result.stop_reason).toBe("stop");
    });

    it("parses response with tool calls", () => {
      const body = Buffer.from(JSON.stringify({
        id: "chatcmpl-456",
        model: "qwen-max",
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"/test"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }));

      const result = intercept._parseOpenAIChatJsonResponse(body);
      expect(result.content_blocks).toHaveLength(1);
      expect(result.content_blocks[0].type).toBe("tool_use");
      expect(result.content_blocks[0].name).toBe("read_file");
      expect(result.content_blocks[0].input).toEqual({ path: "/test" });
    });
  });

  describe("parseOpenAIChatSseResponse", () => {
    it("parses SSE stream with text content", () => {
      const rawText = [
        'data: {"id":"chatcmpl-1","model":"qwen-max","choices":[{"delta":{"content":"Hello"}}]}',
        'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
        'data: {"id":"chatcmpl-1","usage":{"prompt_tokens":10,"completion_tokens":5}}',
        "data: [DONE]",
      ].join("\n");

      const result = intercept._parseOpenAIChatSseResponse(rawText);
      expect(result.model).toBe("qwen-max");
      expect(result.content_blocks[0].text).toBe("Hello world");
      expect(result.input_tokens).toBe(10);
      expect(result.output_tokens).toBe(5);
      expect(result.stop_reason).toBe("stop");
    });

    it("parses SSE stream with tool calls", () => {
      const rawText = [
        'data: {"id":"chatcmpl-2","model":"qwen-max","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"/test\\"}"}}]},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ].join("\n");

      const result = intercept._parseOpenAIChatSseResponse(rawText);
      expect(result.content_blocks).toHaveLength(1);
      expect(result.content_blocks[0].name).toBe("read");
      expect(result.content_blocks[0].input).toEqual({ path: "/test" });
    });
  });

  describe("buildEvent", () => {
    it("builds a complete event from JSON response", () => {
      const reqFields = {
        model: "qwen-max",
        messages: [{ role: "user", content: "Hi" }],
        system: null,
        request_body: { model: "qwen-max", messages: [{ role: "user", content: "Hi" }] },
      };
      const body = Buffer.from(JSON.stringify({
        id: "resp-1", model: "qwen-max",
        choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }));

      const event = intercept._buildEvent(
        1700000000, reqFields, 200, body,
        "application/json", "", "", "openai-chat"
      );

      expect(event.type).toBe("llm_call");
      expect(event.model).toBe("qwen-max");
      expect(event.input_tokens).toBe(5);
      expect(event.output_tokens).toBe(3);
      expect(event.is_error).toBe(false);
    });

    it("marks error for 4xx responses", () => {
      const reqFields = { model: "qwen-max", messages: null, system: null };
      const body = Buffer.from('{"error":"rate limited"}');

      const event = intercept._buildEvent(
        1700000000, reqFields, 429, body,
        "application/json", "", "", "openai-chat"
      );

      expect(event.is_error).toBe(true);
      expect(event.error_message).toContain("rate limited");
    });
  });

  describe("buildErrorEvent", () => {
    it("builds error event from exception", () => {
      const reqFields = { model: "qwen-max", messages: null, system: null };
      const event = intercept._buildErrorEvent(1700000000, reqFields, new Error("connection refused"));

      expect(event.is_error).toBe(true);
      expect(event.error_message).toBe("connection refused");
    });
  });
});
