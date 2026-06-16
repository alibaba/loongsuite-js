// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const {
  convertSystemPrompt,
  convertInputMessages,
  convertOutputMessages,
  extractRequestParams,
  convertToolDefinitions,
  mapStopReason,
} = require("../src/message-converter");

// ---------------------------------------------------------------------------
// mapStopReason
// ---------------------------------------------------------------------------
describe("mapStopReason", () => {
  test("maps end_turn to stop", () => expect(mapStopReason("end_turn")).toBe("stop"));
  test("maps stop to stop", () => expect(mapStopReason("stop")).toBe("stop"));
  test("maps tool_use to tool_calls", () => expect(mapStopReason("tool_use")).toBe("tool_calls"));
  test("maps max_tokens to length", () => expect(mapStopReason("max_tokens")).toBe("length"));
  test("maps content_filter", () => expect(mapStopReason("content_filter")).toBe("content_filter"));
  test("passes unknown values through", () => expect(mapStopReason("custom_reason")).toBe("custom_reason"));
  test("null defaults to stop", () => expect(mapStopReason(null)).toBe("stop"));
  test("undefined defaults to stop", () => expect(mapStopReason(undefined)).toBe("stop"));
});

// ---------------------------------------------------------------------------
// convertSystemPrompt
// ---------------------------------------------------------------------------
describe("convertSystemPrompt", () => {
  test("null returns empty array", () => {
    expect(convertSystemPrompt(null, "anthropic")).toEqual([]);
  });

  test("undefined returns empty array", () => {
    expect(convertSystemPrompt(undefined, "anthropic")).toEqual([]);
  });

  test("string input returns single text part", () => {
    expect(convertSystemPrompt("You are helpful", "anthropic")).toEqual([
      { type: "text", content: "You are helpful" },
    ]);
  });

  test("empty string returns empty array", () => {
    expect(convertSystemPrompt("", "anthropic")).toEqual([]);
  });

  test("Anthropic array format with text blocks", () => {
    const input = [
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Be concise." },
    ];
    expect(convertSystemPrompt(input, "anthropic")).toEqual([
      { type: "text", content: "You are helpful." },
      { type: "text", content: "Be concise." },
    ]);
  });

  test("OpenAI Chat array format with role+content", () => {
    const input = [
      { role: "system", content: "You are a math tutor" },
      { role: "developer", content: "Be precise" },
    ];
    expect(convertSystemPrompt(input, "openai-chat")).toEqual([
      { type: "text", content: "You are a math tutor" },
      { type: "text", content: "Be precise" },
    ]);
  });

  test("OpenAI Responses string format", () => {
    expect(convertSystemPrompt("System instructions", "openai-responses")).toEqual([
      { type: "text", content: "System instructions" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// convertInputMessages — Anthropic
// ---------------------------------------------------------------------------
describe("convertInputMessages — Anthropic", () => {
  test("null returns empty array", () => {
    expect(convertInputMessages(null, "anthropic")).toEqual([]);
  });

  test("string content message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    expect(convertInputMessages(messages, "anthropic")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hello" }] },
    ]);
  });

  test("content block array with text", () => {
    const messages = [{
      role: "user",
      content: [{ type: "text", text: "What is 2+2?" }],
    }];
    expect(convertInputMessages(messages, "anthropic")).toEqual([
      { role: "user", parts: [{ type: "text", content: "What is 2+2?" }] },
    ]);
  });

  test("tool_use content block", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tool_1", name: "calculator", input: { a: 2, b: 2 } },
      ],
    }];
    const result = convertInputMessages(messages, "anthropic");
    expect(result).toEqual([{
      role: "assistant",
      parts: [
        { type: "text", content: "Let me check." },
        { type: "tool_call", id: "tool_1", name: "calculator", arguments: { a: 2, b: 2 } },
      ],
    }]);
  });

  test("tool_result content block", () => {
    const messages = [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "4" }],
    }];
    const result = convertInputMessages(messages, "anthropic");
    expect(result).toEqual([{
      role: "user",
      parts: [{ type: "tool_call_response", id: "tool_1", response: "4" }],
    }]);
  });

  test("thinking content block", () => {
    const messages = [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "I need to reason..." }],
    }];
    const result = convertInputMessages(messages, "anthropic");
    expect(result).toEqual([{
      role: "assistant",
      parts: [{ type: "reasoning", content: "I need to reason..." }],
    }]);
  });

  test("image content block converts to BlobPart", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ],
    }];
    const result = convertInputMessages(messages, "anthropic");
    expect(result).toEqual([{
      role: "user",
      parts: [
        { type: "text", content: "What is this?" },
        { type: "blob", mime_type: "image/png", modality: "image", content: "iVBORw0KGgo=" },
      ],
    }]);
  });
});

// ---------------------------------------------------------------------------
// convertInputMessages — OpenAI Chat
// ---------------------------------------------------------------------------
describe("convertInputMessages — OpenAI Chat", () => {
  test("simple user message", () => {
    const messages = [{ role: "user", content: "Hi" }];
    expect(convertInputMessages(messages, "openai-chat")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hi" }] },
    ]);
  });

  test("assistant with tool_calls", () => {
    const messages = [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      }],
    }];
    const result = convertInputMessages(messages, "openai-chat");
    expect(result).toEqual([{
      role: "assistant",
      parts: [{
        type: "tool_call",
        id: "call_1",
        name: "get_weather",
        arguments: '{"city":"SF"}',
      }],
    }]);
  });

  test("tool role message", () => {
    const messages = [{
      role: "tool",
      tool_call_id: "call_1",
      content: '{"temp":72}',
    }];
    const result = convertInputMessages(messages, "openai-chat");
    expect(result).toEqual([{
      role: "tool",
      parts: [{ type: "tool_call_response", id: "call_1", response: '{"temp":72}' }],
    }]);
  });

  test("image_url with base64 data converts to BlobPart", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ=" } },
      ],
    }];
    const result = convertInputMessages(messages, "openai-chat");
    expect(result).toEqual([{
      role: "user",
      parts: [
        { type: "text", content: "Describe this" },
        { type: "blob", mime_type: "image/jpeg", modality: "image", content: "/9j/4AAQ=" },
      ],
    }]);
  });

  test("image_url with URL converts to UriPart", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "https://example.com/photo.png" } },
      ],
    }];
    const result = convertInputMessages(messages, "openai-chat");
    expect(result).toEqual([{
      role: "user",
      parts: [
        { type: "uri", mime_type: "image/unknown", modality: "image", uri: "https://example.com/photo.png" },
      ],
    }]);
  });
});

// ---------------------------------------------------------------------------
// convertInputMessages — OpenAI Responses
// ---------------------------------------------------------------------------
describe("convertInputMessages — OpenAI Responses", () => {
  test("string input", () => {
    expect(convertInputMessages("Hello", "openai-responses")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hello" }] },
    ]);
  });

  test("array with role+content", () => {
    const messages = [{ role: "user", content: "Hi" }];
    expect(convertInputMessages(messages, "openai-responses")).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hi" }] },
    ]);
  });

  test("function_call_output item", () => {
    const messages = [{ type: "function_call_output", call_id: "fc_1", output: "result" }];
    const result = convertInputMessages(messages, "openai-responses");
    expect(result).toEqual([{
      role: "tool",
      parts: [{ type: "tool_call_response", id: "fc_1", response: "result" }],
    }]);
  });

  test("input_image with base64 data converts to BlobPart", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "input_text", text: "What is this?" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    }];
    const result = convertInputMessages(messages, "openai-responses");
    expect(result).toEqual([{
      role: "user",
      parts: [
        { type: "text", content: "What is this?" },
        { type: "blob", mime_type: "image/png", modality: "image", content: "iVBORw0KGgo=" },
      ],
    }]);
  });

  test("input_image with URL converts to UriPart", () => {
    const messages = [{
      role: "user",
      content: [{ type: "input_image", url: "https://example.com/img.jpg" }],
    }];
    const result = convertInputMessages(messages, "openai-responses");
    expect(result).toEqual([{
      role: "user",
      parts: [
        { type: "uri", mime_type: "image/unknown", modality: "image", uri: "https://example.com/img.jpg" },
      ],
    }]);
  });
});

// ---------------------------------------------------------------------------
// convertOutputMessages
// ---------------------------------------------------------------------------
describe("convertOutputMessages", () => {
  test("text output", () => {
    const blocks = [{ type: "text", text: "Hello!" }];
    const result = convertOutputMessages(blocks, "end_turn");
    expect(result).toEqual([{
      role: "assistant",
      parts: [{ type: "text", content: "Hello!" }],
      finishReason: "stop",
    }]);
  });

  test("tool_use output", () => {
    const blocks = [
      { type: "text", text: "Let me run that." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ];
    const result = convertOutputMessages(blocks, "tool_use");
    expect(result).toEqual([{
      role: "assistant",
      parts: [
        { type: "text", content: "Let me run that." },
        { type: "tool_call", id: "t1", name: "Bash", arguments: { command: "ls" } },
      ],
      finishReason: "tool_calls",
    }]);
  });

  test("thinking output", () => {
    const blocks = [{ type: "thinking", thinking: "Reasoning..." }];
    const result = convertOutputMessages(blocks, "stop");
    expect(result).toEqual([{
      role: "assistant",
      parts: [{ type: "reasoning", content: "Reasoning..." }],
      finishReason: "stop",
    }]);
  });

  test("null output returns empty parts", () => {
    const result = convertOutputMessages(null, "end_turn");
    expect(result).toEqual([{
      role: "assistant",
      parts: [],
      finishReason: "stop",
    }]);
  });

  test("empty array returns empty parts", () => {
    const result = convertOutputMessages([], "stop");
    expect(result).toEqual([{
      role: "assistant",
      parts: [],
      finishReason: "stop",
    }]);
  });
});

// ---------------------------------------------------------------------------
// extractRequestParams
// ---------------------------------------------------------------------------
describe("extractRequestParams", () => {
  test("extracts all params", () => {
    const body = {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 4096,
      stop_sequences: ["END"],
      seed: 42,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
    };
    expect(extractRequestParams(body)).toEqual({
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      maxTokens: 4096,
      stopSequences: ["END"],
      seed: 42,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    });
  });

  test("null body returns empty object", () => {
    expect(extractRequestParams(null)).toEqual({});
  });

  test("partial params", () => {
    expect(extractRequestParams({ temperature: 0.5 })).toEqual({ temperature: 0.5 });
  });

  test("OpenAI stop field maps to stopSequences", () => {
    expect(extractRequestParams({ stop: ["<|end|>"] })).toEqual({ stopSequences: ["<|end|>"] });
  });

  test("stop string wraps in array", () => {
    expect(extractRequestParams({ stop: "STOP" })).toEqual({ stopSequences: ["STOP"] });
  });
});

// ---------------------------------------------------------------------------
// convertToolDefinitions
// ---------------------------------------------------------------------------
describe("convertToolDefinitions", () => {
  test("Anthropic format", () => {
    const tools = [{
      name: "calculator",
      description: "Multiply numbers",
      input_schema: { type: "object", properties: { a: { type: "number" } } },
    }];
    expect(convertToolDefinitions(tools)).toEqual([{
      type: "function",
      name: "calculator",
      description: "Multiply numbers",
      parameters: { type: "object", properties: { a: { type: "number" } } },
    }]);
  });

  test("OpenAI format", () => {
    const tools = [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
      },
    }];
    expect(convertToolDefinitions(tools)).toEqual([{
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object" },
    }]);
  });

  test("null input returns empty array", () => {
    expect(convertToolDefinitions(null)).toEqual([]);
  });

  test("filters null entries", () => {
    expect(convertToolDefinitions([null, undefined])).toEqual([]);
  });
});
