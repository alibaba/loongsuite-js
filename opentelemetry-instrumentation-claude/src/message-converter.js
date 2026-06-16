// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * message-converter.js — Convert intercept.js raw LLM event data
 * to ARMS semantic convention message formats compatible with
 * @loongsuite/opentelemetry-util-genai SDK types.
 *
 * Target schemas:
 *   InputMessage:  { role, parts: [TextPart | ToolCallPart | ToolCallResponsePart] }
 *   OutputMessage: { role, parts: [...], finishReason }
 *   SystemInstruction (MessagePart[]): [{ type: "text", content }]
 */

// ---------------------------------------------------------------------------
// Stop-reason mapping: protocol-native → SDK FinishReason
// ---------------------------------------------------------------------------
const STOP_REASON_MAP = {
  end_turn: "stop",
  stop: "stop",
  completed: "stop",
  tool_use: "tool_calls",
  tool_calls: "tool_calls",
  max_tokens: "length",
  length: "length",
  content_filter: "content_filter",
  error: "error",
};

function mapStopReason(raw) {
  if (!raw) return "stop";
  return STOP_REASON_MAP[raw] || raw;
}

// ---------------------------------------------------------------------------
// convertSystemPrompt(systemPrompt, protocol) → MessagePart[]
// ---------------------------------------------------------------------------
function convertSystemPrompt(systemPrompt, protocol) {
  if (systemPrompt == null) return [];

  if (typeof systemPrompt === "string") {
    return systemPrompt ? [{ type: "text", content: systemPrompt }] : [];
  }

  if (!Array.isArray(systemPrompt)) return [];

  const parts = [];
  for (const item of systemPrompt) {
    if (typeof item === "string") {
      if (item) parts.push({ type: "text", content: item });
    } else if (item && typeof item === "object") {
      if (protocol === "openai-chat") {
        const text = item.content || "";
        if (text) parts.push({ type: "text", content: text });
      } else {
        const text = item.text || item.content || "";
        if (text) parts.push({ type: "text", content: text });
      }
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// convertAnthropicContentBlock(block) → MessagePart
// ---------------------------------------------------------------------------
function convertAnthropicContentBlock(block) {
  if (!block || typeof block !== "object") return null;
  switch (block.type) {
    case "text":
      return { type: "text", content: block.text || "" };
    case "tool_use":
      return {
        type: "tool_call",
        id: block.id || null,
        name: block.name || "",
        arguments: block.input ?? null,
      };
    case "tool_result":
      return {
        type: "tool_call_response",
        id: block.tool_use_id || null,
        response: block.content ?? null,
      };
    case "image": {
      const src = block.source || {};
      const mimeType = src.media_type || "image/unknown";
      const data = src.data || "";
      return { type: "blob", mime_type: mimeType, modality: "image", content: data };
    }
    case "thinking":
      return { type: "reasoning", content: block.thinking || "" };
    default:
      if (block.text != null) return { type: "text", content: block.text };
      return { type: block.type || "unknown" };
  }
}

// ---------------------------------------------------------------------------
// convertInputMessages(messages, protocol) → InputMessage[]
// ---------------------------------------------------------------------------
function convertInputMessages(messages, protocol) {
  if (!messages) return [];
  if (typeof messages === "string") {
    return messages ? [{ role: "user", parts: [{ type: "text", content: messages }] }] : [];
  }
  if (!Array.isArray(messages)) return [];

  const result = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    if (protocol === "openai-chat") {
      result.push(convertOpenAIChatMessage(msg));
    } else if (protocol === "openai-responses") {
      const converted = convertOpenAIResponsesItem(msg);
      if (converted) result.push(converted);
    } else {
      result.push(convertAnthropicMessage(msg));
    }
  }

  return result;
}

function convertAnthropicMessage(msg) {
  const role = msg.role || "user";
  const content = msg.content;

  if (typeof content === "string") {
    return { role, parts: [{ type: "text", content }] };
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      const part = convertAnthropicContentBlock(block);
      if (part) parts.push(part);
    }
    return { role, parts };
  }

  return { role, parts: content != null ? [{ type: "text", content: String(content) }] : [] };
}

function convertOpenAIChatMessage(msg) {
  const role = msg.role || "user";
  const parts = [];

  if (role === "tool" && msg.tool_call_id) {
    parts.push({
      type: "tool_call_response",
      id: msg.tool_call_id,
      response: msg.content ?? null,
    });
    return { role: "tool", parts };
  }

  if (msg.content != null) {
    if (typeof msg.content === "string") {
      if (msg.content) parts.push({ type: "text", content: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "string") {
          parts.push({ type: "text", content: block });
        } else if (block && block.type === "text") {
          parts.push({ type: "text", content: block.text || "" });
        } else if (block && block.type === "image_url" && block.image_url) {
          const url = typeof block.image_url === "string" ? block.image_url : block.image_url.url || "";
          const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
          if (dataMatch) {
            parts.push({ type: "blob", mime_type: dataMatch[1], modality: "image", content: dataMatch[2] });
          } else {
            parts.push({ type: "uri", mime_type: "image/unknown", modality: "image", uri: url });
          }
        }
      }
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push({
        type: "tool_call",
        id: tc.id || null,
        name: tc.function?.name || "",
        arguments: tc.function?.arguments ?? null,
      });
    }
  }

  return { role, parts };
}

function convertOpenAIResponsesItem(item) {
  if (!item || typeof item !== "object") return null;

  if (typeof item === "string") {
    return { role: "user", parts: [{ type: "text", content: item }] };
  }

  if (item.type === "function_call_output") {
    return {
      role: "tool",
      parts: [{
        type: "tool_call_response",
        id: item.call_id || null,
        response: item.output ?? null,
      }],
    };
  }

  const role = item.role || "user";
  const content = item.content;
  if (typeof content === "string") {
    return { role, parts: [{ type: "text", content }] };
  }
  if (Array.isArray(content)) {
    const parts = content.map(c => {
      if (typeof c === "string") return { type: "text", content: c };
      if (c && c.type === "input_text") return { type: "text", content: c.text || "" };
      if (c && c.type === "text") return { type: "text", content: c.text || "" };
      if (c && c.type === "input_image") {
        const url = c.image_url || c.url || "";
        const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataMatch) {
          return { type: "blob", mime_type: dataMatch[1], modality: "image", content: dataMatch[2] };
        }
        return { type: "uri", mime_type: "image/unknown", modality: "image", uri: url };
      }
      return { type: c?.type || "unknown" };
    });
    return { role, parts };
  }

  return { role, parts: [] };
}

// ---------------------------------------------------------------------------
// convertOutputMessages(outputContent, stopReason) → OutputMessage[]
// ---------------------------------------------------------------------------
function convertOutputMessages(outputContent, stopReason) {
  if (!outputContent || !Array.isArray(outputContent) || outputContent.length === 0) {
    return [{
      role: "assistant",
      parts: [],
      finishReason: mapStopReason(stopReason),
    }];
  }

  const parts = [];
  for (const block of outputContent) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push({ type: "text", content: block.text || "" });
        break;
      case "tool_use":
        parts.push({
          type: "tool_call",
          id: block.id || null,
          name: block.name || "",
          arguments: block.input ?? null,
        });
        break;
      case "thinking":
        parts.push({ type: "reasoning", content: block.thinking || "" });
        break;
      default:
        if (block.text != null) {
          parts.push({ type: "text", content: block.text });
        }
        break;
    }
  }

  return [{
    role: "assistant",
    parts,
    finishReason: mapStopReason(stopReason),
  }];
}

// ---------------------------------------------------------------------------
// extractRequestParams(requestBody) → object
// ---------------------------------------------------------------------------
function extractRequestParams(requestBody) {
  if (!requestBody || typeof requestBody !== "object") return {};
  const result = {};
  if (requestBody.temperature != null) result.temperature = requestBody.temperature;
  if (requestBody.top_p != null) result.topP = requestBody.top_p;
  if (requestBody.top_k != null) result.topK = requestBody.top_k;
  if (requestBody.max_tokens != null) result.maxTokens = requestBody.max_tokens;
  if (requestBody.stop_sequences != null) result.stopSequences = requestBody.stop_sequences;
  if (requestBody.stop != null && result.stopSequences == null) {
    result.stopSequences = Array.isArray(requestBody.stop) ? requestBody.stop : [requestBody.stop];
  }
  if (requestBody.seed != null) result.seed = requestBody.seed;
  if (requestBody.frequency_penalty != null) result.frequencyPenalty = requestBody.frequency_penalty;
  if (requestBody.presence_penalty != null) result.presencePenalty = requestBody.presence_penalty;
  return result;
}

// ---------------------------------------------------------------------------
// convertToolDefinitions(tools) → ToolDefinition[]
// ---------------------------------------------------------------------------
function convertToolDefinitions(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => {
    if (!tool || typeof tool !== "object") return null;
    // OpenAI format: { type: "function", function: { name, description, parameters } }
    if (tool.type === "function" && tool.function) {
      return {
        type: "function",
        name: tool.function.name || "",
        description: tool.function.description || null,
        parameters: tool.function.parameters || null,
      };
    }
    // Anthropic format: { name, description, input_schema }
    if (tool.name) {
      return {
        type: "function",
        name: tool.name,
        description: tool.description || null,
        parameters: tool.input_schema || null,
      };
    }
    return null;
  }).filter(Boolean);
}

module.exports = {
  convertSystemPrompt,
  convertInputMessages,
  convertOutputMessages,
  extractRequestParams,
  convertToolDefinitions,
  mapStopReason,
};
