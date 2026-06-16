/**
 * intercept.js — 进程内 Claude API 请求拦截与上报
 *
 * 支持 Node.js 和 Bun 运行时，按以下优先级选择拦截策略:
 *
 *   Bun 运行时
 *     └─ 策略C: monkey-patch globalThis.fetch（唯一支持的方式）
 *
 *   Node.js 运行时
 *     ├─ 策略A: undici Dispatcher 拦截（优先，适用于 npx @anthropic-ai/claude-code）
 *     │         外部 undici 可用时启用；setGlobalDispatcher 覆盖全局 HTTP 客户端。
 *     │         若策略A成功，直接返回，不安装 B/C。
 *     ├─ 策略B: patch Node.js https/http.request（bundled claude binary 专用）
 *     │         bundled binary 内部打包了 undici，外部 setGlobalDispatcher 无效；
 *     │         patch 原生模块层可绕过此限制。策略A失败时安装。
 *     └─ 策略C: monkey-patch globalThis.fetch（双重保险）
 *               与策略B同时安装，覆盖 Node.js >= 18 内置 fetch 路径。
 *
 * 用法:
 *   # Node.js (npx @anthropic-ai/claude-code)
 *   NODE_OPTIONS="--require /absolute/path/to/intercept.js" npx @anthropic-ai/claude-code ...
 *
 *   # Bun (编译后的 claude 二进制)
 *   BUN_PRELOAD=/absolute/path/to/intercept.js claude ...
 *   # 或在项目 bunfig.toml 中配置:
 *   #   [run]
 *   #   preload = ["/absolute/path/to/intercept.js"]
 *
 * 效果等同于 proxy.py，但无需启动独立代理服务器。
 * 写入相同格式的 JSONL 日志，与现有 telemetry 导出流程完全兼容。
 */

// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const PROXY_EVENTS_DIR = path.join(
  os.homedir(),
  ".cache",
  "opentelemetry.instrumentation.claude",
  "sessions",
);

// 每个进程（即每个 Claude session）使用独立的 JSONL 文件，避免单文件过大
const INSTANCE_ID = process.pid.toString();
const PROXY_LOG = path.join(
  PROXY_EVENTS_DIR,
  `proxy_events_${INSTANCE_ID}.jsonl`
);

// 匹配 Anthropic / OpenAI API 路径
const API_PATH_RE = /\/(v1\/messages|v1\/chat\/completions|v1\/responses)\b/;

function detectProtocol(urlPath) {
  if (/\/v1\/messages\b/.test(urlPath)) return "anthropic";
  if (/\/v1\/chat\/completions\b/.test(urlPath)) return "openai-chat";
  if (/\/v1\/responses\b/.test(urlPath)) return "openai-responses";
  return null;
}

const DEBUG = !!process.env.OTEL_CLAUDE_DEBUG;

function debug(/** @type {string} */ msg) {
  if (DEBUG) console.error("[intercept]", msg);
}

// ---------------------------------------------------------------------------
// JSONL 事件写入
// ---------------------------------------------------------------------------

function appendProxyEvent(event) {
  try {
    const dir = path.dirname(PROXY_LOG);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(PROXY_LOG, line, "utf-8");
  } catch (err) {
    debug("failed to append event: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// SSE 解析 — 与 proxy.py 的 parse_sse_response 对齐
// ---------------------------------------------------------------------------

function parseSseResponse(rawText) {
  const result = {
    id: "",
    request_id: "",
    model: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    content_blocks: [],
    stop_reason: "",
    stop_sequence: null,
  };

  const blocks = [];
  let currentBlock = null;
  let currentEvent = null;
  let currentDataLines = [];

  function processEvent(eventType, dataStr) {
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }

    if (eventType === "message_start") {
      const message = data.message || {};
      result.model = message.model || "";
      result.id = message.id || "";
      result.request_id = message.request_id || "";
      const usage = message.usage || {};
      result.input_tokens = usage.input_tokens || 0;
      result.cache_read_input_tokens = usage.cache_read_input_tokens || 0;
      result.cache_creation_input_tokens =
        usage.cache_creation_input_tokens || 0;
    } else if (eventType === "content_block_start") {
      const cb = data.content_block || {};
      const blockType = cb.type || "text";
      currentBlock = { type: blockType };
      if (blockType === "text") {
        currentBlock.text = cb.text || "";
      } else if (blockType === "tool_use") {
        currentBlock.id = cb.id || "";
        currentBlock.name = cb.name || "";
        currentBlock._partial_json = "";
      } else if (blockType === "thinking") {
        currentBlock.thinking = cb.thinking || "";
      }
    } else if (eventType === "content_block_delta") {
      const delta = data.delta || {};
      if (currentBlock) {
        const deltaType = delta.type || "";
        if (deltaType === "text_delta") {
          currentBlock.text = (currentBlock.text || "") + (delta.text || "");
        } else if (deltaType === "input_json_delta") {
          currentBlock._partial_json =
            (currentBlock._partial_json || "") + (delta.partial_json || "");
        } else if (deltaType === "thinking_delta") {
          currentBlock.thinking =
            (currentBlock.thinking || "") + (delta.thinking || "");
        }
      }
    } else if (eventType === "content_block_stop") {
      if (currentBlock) {
        if (currentBlock.type === "tool_use") {
          const rawJson = currentBlock._partial_json || "";
          delete currentBlock._partial_json;
          try {
            currentBlock.input = rawJson ? JSON.parse(rawJson) : {};
          } catch {
            currentBlock.input = rawJson;
          }
        }
        blocks.push(currentBlock);
        currentBlock = null;
      }
    } else if (eventType === "message_delta") {
      const delta = data.delta || {};
      if (delta.stop_reason) {
        result.stop_reason = delta.stop_reason;
      }
      if (delta.stop_sequence !== undefined) {
        result.stop_sequence = delta.stop_sequence;
      }
      const usage = data.usage || {};
      if (usage.output_tokens !== undefined) {
        result.output_tokens = usage.output_tokens;
      }
    }
  }

  const lines = rawText.split("\n");
  for (const line of lines) {
    if (line.startsWith("event:")) {
      if (currentEvent !== null && currentDataLines.length > 0) {
        processEvent(currentEvent, currentDataLines.join("\n"));
        currentDataLines = [];
      }
      currentEvent = line.slice(6).trim();
      currentDataLines = [];
    } else if (line.startsWith("data:")) {
      currentDataLines.push(line.slice(5).trim());
    } else if (line.trim() === "") {
      if (currentEvent !== null && currentDataLines.length > 0) {
        processEvent(currentEvent, currentDataLines.join("\n"));
        currentDataLines = [];
      }
      currentEvent = null;
    }
  }

  if (currentEvent !== null && currentDataLines.length > 0) {
    processEvent(currentEvent, currentDataLines.join("\n"));
  }

  result.content_blocks = blocks;
  return result;
}

// ---------------------------------------------------------------------------
// JSON (非流式) 解析
// ---------------------------------------------------------------------------

function parseJsonResponse(body) {
  const result = {
    id: "",
    request_id: "",
    model: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    content_blocks: [],
    stop_reason: "",
  };

  let data;
  try {
    if (body[0] === 0x1f && body[1] === 0x8b) {
      body = zlib.gunzipSync(body);
    }
    data = JSON.parse(body.toString("utf-8"));
  } catch {
    return result;
  }

  result.id = data.id || "";
  result.request_id = data.request_id || "";
  result.model = data.model || "";
  result.stop_reason = data.stop_reason || "";

  const usage = data.usage || {};
  result.input_tokens = usage.input_tokens || 0;
  result.output_tokens = usage.output_tokens || 0;
  result.cache_read_input_tokens = usage.cache_read_input_tokens || 0;
  result.cache_creation_input_tokens = usage.cache_creation_input_tokens || 0;

  for (const block of data.content || []) {
    const blockType = block.type || "text";
    const entry = { type: blockType };
    if (blockType === "text") {
      entry.text = block.text || "";
    } else if (blockType === "tool_use") {
      entry.id = block.id || "";
      entry.name = block.name || "";
      entry.input = block.input || {};
    } else if (blockType === "thinking") {
      entry.thinking = block.thinking || "";
    } else {
      Object.assign(entry, block);
    }
    result.content_blocks.push(entry);
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions — JSON (非流式) 解析
// ---------------------------------------------------------------------------

function parseOpenAIChatJsonResponse(body) {
  const result = {
    id: "", request_id: "", model: "",
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    content_blocks: [], stop_reason: "",
  };

  let data;
  try {
    if (body[0] === 0x1f && body[1] === 0x8b) {
      body = zlib.gunzipSync(body);
    }
    data = JSON.parse(body.toString("utf-8"));
  } catch {
    return result;
  }

  result.id = data.id || "";
  result.model = data.model || "";

  const usage = data.usage || {};
  result.input_tokens = usage.prompt_tokens || 0;
  result.output_tokens = usage.completion_tokens || 0;
  // OpenAI cached tokens
  const promptDetails = usage.prompt_tokens_details || {};
  result.cache_read_input_tokens = promptDetails.cached_tokens || 0;

  const choices = data.choices || [];
  if (choices.length > 0) {
    const choice = choices[0];
    result.stop_reason = choice.finish_reason || "";
    const message = choice.message || {};

    if (message.content) {
      result.content_blocks.push({ type: "text", text: message.content });
    }

    for (const tc of message.tool_calls || []) {
      let args = tc.function?.["arguments"] || "{}";
      try { args = JSON.parse(args); } catch {}
      result.content_blocks.push({
        type: "tool_use",
        id: tc.id || "",
        name: tc.function?.name || "",
        input: args,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions — SSE (流式) 解析
// ---------------------------------------------------------------------------

function parseOpenAIChatSseResponse(rawText) {
  const result = {
    id: "", request_id: "", model: "",
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    content_blocks: [], stop_reason: "",
    created: 0, system_fingerprint: "",
    completion_tokens_details: null,
  };

  let textContent = "";
  // tool_calls 按 index 累积
  const toolCallBuffers = {};

  const lines = rawText.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (dataStr === "[DONE]") break;

    let data;
    try { data = JSON.parse(dataStr); } catch { continue; }

    if (!result.id && data.id) result.id = data.id;
    if (!result.model && data.model) result.model = data.model;
    if (!result.created && data.created) result.created = data.created;
    if (!result.system_fingerprint && data.system_fingerprint) result.system_fingerprint = data.system_fingerprint;

    // usage (stream_options: {include_usage: true} 时最后一个 chunk 带 usage)
    if (data.usage) {
      result.input_tokens = data.usage.prompt_tokens || 0;
      result.output_tokens = data.usage.completion_tokens || 0;
      const promptDetails = data.usage.prompt_tokens_details || {};
      result.cache_read_input_tokens = promptDetails.cached_tokens || 0;
      if (data.usage.completion_tokens_details) {
        result.completion_tokens_details = data.usage.completion_tokens_details;
      }
    }

    const choices = data.choices || [];
    for (const choice of choices) {
      if (choice.finish_reason) {
        result.stop_reason = choice.finish_reason;
      }
      const delta = choice.delta || {};
      if (delta.content) {
        textContent += delta.content;
      }
      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? Object.keys(toolCallBuffers).length;
        if (!toolCallBuffers[idx]) {
          toolCallBuffers[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
        }
        if (tc.function?.["arguments"]) {
          toolCallBuffers[idx]["arguments"] += tc.function["arguments"];
        }
      }
    }
  }

  if (textContent) {
    result.content_blocks.push({ type: "text", text: textContent });
  }
  for (const idx of Object.keys(toolCallBuffers).sort((a, b) => a - b)) {
    const buf = toolCallBuffers[idx];
    let args = buf["arguments"];
    try { args = JSON.parse(args); } catch {}
    result.content_blocks.push({
      type: "tool_use", id: buf.id, name: buf.name, input: args,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API — JSON (非流式) 解析
// ---------------------------------------------------------------------------

function parseOpenAIResponsesJsonResponse(body) {
  const result = {
    id: "", request_id: "", model: "",
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    content_blocks: [], stop_reason: "",
  };

  let data;
  try {
    if (body[0] === 0x1f && body[1] === 0x8b) {
      body = zlib.gunzipSync(body);
    }
    data = JSON.parse(body.toString("utf-8"));
  } catch {
    return result;
  }

  result.id = data.id || "";
  result.model = data.model || "";
  result.stop_reason = data.status || "";

  const usage = data.usage || {};
  result.input_tokens = usage.input_tokens || 0;
  result.output_tokens = usage.output_tokens || 0;
  const inputDetails = usage.input_tokens_details || {};
  result.cache_read_input_tokens = inputDetails.cached_tokens || 0;

  for (const item of data.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") {
          result.content_blocks.push({ type: "text", text: part.text || "" });
        }
      }
    } else if (item.type === "function_call") {
      let args = item["arguments"] || "{}";
      try { args = JSON.parse(args); } catch {}
      result.content_blocks.push({
        type: "tool_use",
        id: item.call_id || item.id || "",
        name: item.name || "",
        input: args,
      });
    } else if (item.type === "reasoning") {
      const summaryTexts = (item.summary || [])
        .map((s) => (typeof s === "string" ? s : s.text || ""))
        .filter(Boolean);
      if (summaryTexts.length > 0) {
        result.content_blocks.push({ type: "thinking", thinking: summaryTexts.join("\n") });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API — SSE (流式) 解析
// ---------------------------------------------------------------------------

function parseOpenAIResponsesSseResponse(rawText) {
  const result = {
    id: "", request_id: "", model: "",
    input_tokens: 0, output_tokens: 0,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    content_blocks: [], stop_reason: "",
    created_at: 0, output_tokens_details: null,
  };

  let textContent = "";
  const toolCallBuffers = {}; // keyed by item_id or call_id
  // reasoning summary 按 item_id 累积
  const reasoningBuffers = {}; // keyed by item_id, value: { parts: [{ text }] }
  let currentReasoningItemId = null;
  let currentEvent = null;

  const lines = rawText.split("\n");
  for (const line of lines) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trim();
    if (!dataStr) continue;

    let data;
    try { data = JSON.parse(dataStr); } catch { continue; }

    if (currentEvent === "response.created" || currentEvent === "response.in_progress") {
      const resp = data.response || data;
      if (resp.id) result.id = resp.id;
      if (resp.model) result.model = resp.model;
      if (resp.created_at) result.created_at = resp.created_at;
    } else if (currentEvent === "response.output_text.delta") {
      textContent += data.delta || "";
    } else if (currentEvent === "response.function_call_arguments.delta") {
      const key = data.item_id || data.output_index || "0";
      if (!toolCallBuffers[key]) {
        toolCallBuffers[key] = { id: data.call_id || key, name: data.name || "", arguments: "" };
      }
      toolCallBuffers[key]["arguments"] += data.delta || "";
    } else if (currentEvent === "response.function_call_arguments.done") {
      const key = data.item_id || data.output_index || "0";
      if (!toolCallBuffers[key]) {
        toolCallBuffers[key] = { id: data.call_id || key, name: data.name || "", "arguments": data["arguments"] || "" };
      } else {
        toolCallBuffers[key]["arguments"] = data["arguments"] || toolCallBuffers[key]["arguments"];
      }
      if (data.name) toolCallBuffers[key].name = data.name;
    } else if (currentEvent === "response.output_item.added") {
      const item = data.item || {};
      if (item.type === "function_call") {
        const key = item.id || data.output_index || "0";
        toolCallBuffers[key] = { id: item.call_id || item.id || key, name: item.name || "", arguments: "" };
      } else if (item.type === "reasoning") {
        currentReasoningItemId = item.id || data.output_index || "reasoning";
        reasoningBuffers[currentReasoningItemId] = { parts: [] };
      }
    } else if (currentEvent === "response.reasoning_summary_part.added") {
      // 新增一个 summary part
      const key = data.item_id || currentReasoningItemId || "reasoning";
      if (!reasoningBuffers[key]) {
        reasoningBuffers[key] = { parts: [] };
      }
      reasoningBuffers[key].parts.push({ text: "" });
    } else if (currentEvent === "response.reasoning_summary_text.delta") {
      const key = data.item_id || currentReasoningItemId || "reasoning";
      if (!reasoningBuffers[key]) {
        reasoningBuffers[key] = { parts: [{ text: "" }] };
      }
      const parts = reasoningBuffers[key].parts;
      if (parts.length === 0) parts.push({ text: "" });
      parts[parts.length - 1].text += data.delta || "";
    } else if (currentEvent === "response.reasoning_summary_text.done") {
      const key = data.item_id || currentReasoningItemId || "reasoning";
      if (reasoningBuffers[key]) {
        const parts = reasoningBuffers[key].parts;
        if (parts.length > 0 && data.text !== undefined) {
          parts[parts.length - 1].text = data.text;
        }
      }
    } else if (currentEvent === "response.completed") {
      const resp = data.response || data;
      result.stop_reason = resp.status || "completed";
      if (resp.created_at) result.created_at = resp.created_at;
      const usage = resp.usage || {};
      result.input_tokens = usage.input_tokens || 0;
      result.output_tokens = usage.output_tokens || 0;
      const inputDetails = usage.input_tokens_details || {};
      result.cache_read_input_tokens = inputDetails.cached_tokens || 0;
      if (usage.output_tokens_details) {
        result.output_tokens_details = usage.output_tokens_details;
      }
    }

    currentEvent = null;
  }

  // 先添加 reasoning blocks
  for (const key of Object.keys(reasoningBuffers)) {
    const buf = reasoningBuffers[key];
    const summaryTexts = buf.parts.map(p => p.text).filter(Boolean);
    if (summaryTexts.length > 0) {
      result.content_blocks.push({
        type: "thinking",
        thinking: summaryTexts.join("\n"),
        _reasoning_parts: buf.parts,
      });
    }
  }

  if (textContent) {
    result.content_blocks.push({ type: "text", text: textContent });
  }
  for (const key of Object.keys(toolCallBuffers)) {
    const buf = toolCallBuffers[key];
    let args = buf["arguments"];
    try { args = JSON.parse(args); } catch {}
    result.content_blocks.push({
      type: "tool_use", id: buf.id, name: buf.name, input: args,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 解压缩
// ---------------------------------------------------------------------------

function decompressBody(body, encoding) {
  if (!encoding || encoding === "identity") return body;
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return zlib.gunzipSync(body);
    }
    if (encoding === "deflate") {
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    }
    if (encoding === "br") {
      return zlib.brotliDecompressSync(body);
    }
  } catch {
    // 解压失败，返回原始数据
  }
  return body;
}

// ---------------------------------------------------------------------------
// 从请求 body 提取字段
// ---------------------------------------------------------------------------

function extractRequestFields(bodyStr, protocol) {
  try {
    const reqJson = JSON.parse(bodyStr);
    let messages = null;
    let system = null;

    if (protocol === "openai-chat") {
      // OpenAI Chat: system prompt 是 messages 中 role=system/developer 的消息
      const allMessages = reqJson.messages || [];
      const systemMsgs = allMessages.filter(
        (m) => m.role === "system" || m.role === "developer"
      );
      const nonSystemMsgs = allMessages.filter(
        (m) => m.role !== "system" && m.role !== "developer"
      );
      messages = nonSystemMsgs.length > 0 ? nonSystemMsgs : null;
      system = systemMsgs.length > 0 ? systemMsgs : null;
    } else if (protocol === "openai-responses") {
      // OpenAI Responses API: input 是消息, instructions 是 system prompt
      messages = reqJson.input || null;
      system = reqJson.instructions || null;
    } else {
      // Anthropic
      messages = reqJson.messages || null;
      system = reqJson.system || null;
    }

    return {
      messages,
      model: reqJson.model || "",
      system,
      request_body: reqJson,
    };
  } catch {
    return { messages: null, model: "", system: null, request_body: bodyStr || null };
  }
}

/**
 * 检测是否为 Claude Code 内部的 title 生成请求（非用户对话）。
 * 这类请求的 system prompt 包含 "Generate a concise, sentence-case title"。
 */
function isInternalCall(reqFields) {
  const system = reqFields.system;
  if (!system) return false;
  const texts = Array.isArray(system) ? system : [system];
  for (const item of texts) {
    const text = typeof item === "string" ? item : (item && item.text) || "";
    if (text.includes("Generate a concise, sentence-case title")) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 解析响应并生成事件
// ---------------------------------------------------------------------------

function buildEvent(requestStartTime, reqFields, responseStatus, rawBody, contentType, contentEncoding, vendorTraceId, protocol) {
  let parsedResult;
  const isSse = contentType.includes("text/event-stream");

  // 根据协议选择对应的解析器
  const parsers = {
    "anthropic":         { sse: parseSseResponse,                json: parseJsonResponse },
    "openai-chat":       { sse: parseOpenAIChatSseResponse,      json: parseOpenAIChatJsonResponse },
    "openai-responses":  { sse: parseOpenAIResponsesSseResponse, json: parseOpenAIResponsesJsonResponse },
  };
  const parser = parsers[protocol] || parsers["anthropic"];

  if (isSse) {
    const decompressed = contentEncoding
      ? decompressBody(rawBody, contentEncoding)
      : rawBody;
    parsedResult = parser.sse(decompressed.toString("utf-8"));
  } else if (responseStatus >= 200 && responseStatus < 300) {
    const decompressed = contentEncoding
      ? decompressBody(rawBody, contentEncoding)
      : rawBody;
    parsedResult = parser.json(decompressed);
  } else {
    parsedResult = {
      model: "", input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      content_blocks: [], stop_reason: "",
    };
  }

  let errorBody = null;
  if (responseStatus >= 400) {
    try {
      const decompressed = contentEncoding
        ? decompressBody(rawBody, contentEncoding)
        : rawBody;
      errorBody = decompressed.toString("utf-8");
    } catch {
      errorBody = rawBody.slice(0, 500).toString("utf-8");
    }
  }

  // 提取完整的 response body
  let responseBody = null;
  try {
    if (isSse) {
      // SSE 流式响应，从解析结果重构为与非流式一致的 JSON 响应格式
      if (protocol === "openai-chat") {
        // OpenAI Chat Completions 格式
        const message = { role: "assistant" };
        const textBlocks = (parsedResult.content_blocks || []).filter(b => b.type === "text");
        const toolBlocks = (parsedResult.content_blocks || []).filter(b => b.type === "tool_use");
        message.content = textBlocks.length > 0 ? textBlocks.map(b => b.text).join("") : null;
        if (toolBlocks.length > 0) {
          message.tool_calls = toolBlocks.map((b, i) => ({
            id: b.id || "",
            type: "function",
            index: i,
            function: {
              name: b.name || "",
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
            },
          }));
        }
        responseBody = {
          id: parsedResult.id || "",
          object: "chat.completion",
          created: parsedResult.created || 0,
          model: parsedResult.model || "",
          system_fingerprint: parsedResult.system_fingerprint || "",
          choices: [{
            index: 0,
            message,
            finish_reason: parsedResult.stop_reason || "",
          }],
          usage: {
            prompt_tokens: parsedResult.input_tokens || 0,
            completion_tokens: parsedResult.output_tokens || 0,
            total_tokens: (parsedResult.input_tokens || 0) + (parsedResult.output_tokens || 0),
            prompt_tokens_details: {
              cached_tokens: parsedResult.cache_read_input_tokens || 0,
            },
            completion_tokens_details: parsedResult.completion_tokens_details || null,
          },
        };
      } else if (protocol === "openai-responses") {
        // OpenAI Responses API 格式
        const output = [];
        const textBlocks = (parsedResult.content_blocks || []).filter(b => b.type === "text");
        const toolBlocks = (parsedResult.content_blocks || []).filter(b => b.type === "tool_use");
        const thinkingBlocks = (parsedResult.content_blocks || []).filter(b => b.type === "thinking");
        if (thinkingBlocks.length > 0) {
          for (const b of thinkingBlocks) {
            // 优先使用 _reasoning_parts（SSE 解析保留的原始 part 结构）
            const summary = b._reasoning_parts
              ? b._reasoning_parts.map(p => ({ type: "summary_text", text: p.text || "" }))
              : [{ type: "summary_text", text: b.thinking || "" }];
            output.push({ type: "reasoning", summary });
          }
        }
        if (textBlocks.length > 0) {
          output.push({
            type: "message",
            role: "assistant",
            content: textBlocks.map(b => ({ type: "output_text", text: b.text || "" })),
          });
        }
        for (const b of toolBlocks) {
          output.push({
            type: "function_call",
            id: b.id || "",
            call_id: b.id || "",
            name: b.name || "",
            arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input || {}),
          });
        }
        responseBody = {
          id: parsedResult.id || "",
          object: "response",
          created_at: parsedResult.created_at || 0,
          model: parsedResult.model || "",
          status: parsedResult.stop_reason || "completed",
          output,
          usage: {
            input_tokens: parsedResult.input_tokens || 0,
            output_tokens: parsedResult.output_tokens || 0,
            total_tokens: (parsedResult.input_tokens || 0) + (parsedResult.output_tokens || 0),
            input_tokens_details: {
              cached_tokens: parsedResult.cache_read_input_tokens || 0,
            },
            output_tokens_details: parsedResult.output_tokens_details || null,
          },
        };
      } else {
        // Anthropic Messages API 格式
        responseBody = {
          id: parsedResult.id || "",
          type: "message",
          role: "assistant",
          content: parsedResult.content_blocks || [],
          model: parsedResult.model || "",
          stop_reason: parsedResult.stop_reason || "",
          stop_sequence: parsedResult.stop_sequence || null,
          usage: {
            input_tokens: parsedResult.input_tokens || 0,
            output_tokens: parsedResult.output_tokens || 0,
            cache_read_input_tokens: parsedResult.cache_read_input_tokens || 0,
            cache_creation_input_tokens: parsedResult.cache_creation_input_tokens || 0,
          },
        };
      }
    } else {
      // JSON 响应，尝试解析为对象
      const decompressed = contentEncoding
        ? decompressBody(rawBody, contentEncoding)
        : rawBody;
      const bodyText = decompressed.toString("utf-8");
      try {
        responseBody = JSON.parse(bodyText);
      } catch {
        responseBody = bodyText;
      }
    }
  } catch {
    responseBody = null;
  }

  return {
    type: "llm_call",
    protocol: protocol || "anthropic",
    timestamp: Date.now() / 1000,
    request_start_time: requestStartTime,
    response_id: parsedResult.id || "",
    request_id: parsedResult.request_id || "",
    model: parsedResult.model || reqFields.model,
    input_messages: reqFields.messages,
    system_prompt: reqFields.system,
    output_content: parsedResult.content_blocks || [],
    stop_reason: parsedResult.stop_reason || "",
    input_tokens: parsedResult.input_tokens || 0,
    output_tokens: parsedResult.output_tokens || 0,
    cache_read_input_tokens: parsedResult.cache_read_input_tokens || 0,
    cache_creation_input_tokens: parsedResult.cache_creation_input_tokens || 0,
    is_error: responseStatus >= 400,
    error_message: errorBody,
    vendor_trace_id: vendorTraceId || "",
    request_body: reqFields.request_body || null,
    response_body: responseBody,
  };
}

function buildErrorEvent(requestStartTime, reqFields, error) {
  return {
    type: "llm_call",
    timestamp: Date.now() / 1000,
    request_start_time: requestStartTime,
    model: reqFields.model,
    input_messages: reqFields.messages,
    system_prompt: reqFields.system,
    output_content: [],
    stop_reason: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    is_error: true,
    error_message: error?.message || String(error),
    request_body: reqFields.request_body || null,
  };
}

// ===========================================================================
// 策略 A: undici Dispatcher 拦截器 (Node.js 专用)
// ===========================================================================

function tryInstallUndici() {
  let undici;
  try {
    undici = require("undici");
  } catch {
    return false;
  }

  const { Agent, setGlobalDispatcher, DecoratorHandler } = undici;
  if (!Agent || !setGlobalDispatcher || !DecoratorHandler) return false;

  // 检查 compose 方法是否可用
  const testAgent = new Agent();
  if (typeof testAgent.compose !== "function") {
    try { testAgent.close(); } catch {}
    return false;
  }
  try { testAgent.close(); } catch {}

  function createInterceptor(dispatch) {
    return async (opts, handler) => {
      const reqPath = opts.path || "";
      const method = (opts.method || "GET").toUpperCase();

      const protocol = detectProtocol(reqPath);
      if (method !== "POST" || !protocol) {
        return dispatch(opts, handler);
      }

      const requestStartTime = Date.now() / 1000;

      // 提取请求体
      let reqFields = { messages: null, model: "", system: null };

      if (opts.body) {
        try {
          let bodyStr = null;
          if (typeof opts.body === "string") {
            bodyStr = opts.body;
          } else if (Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array) {
            bodyStr = Buffer.from(opts.body).toString("utf-8");
          } else if (typeof opts.body[Symbol.asyncIterator] === "function") {
            const chunks = [];
            for await (const chunk of opts.body) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const fullBody = Buffer.concat(chunks);
            bodyStr = fullBody.toString("utf-8");
            opts.body = fullBody;
          }
          if (bodyStr) reqFields = extractRequestFields(bodyStr, protocol);
        } catch {}
      }

      // 跳过 Claude Code 内部调用（如 title 生成，仅 anthropic 协议）
      if (protocol === "anthropic" && isInternalCall(reqFields)) {
        debug("skipping internal call (title generation)");
        return dispatch(opts, handler);
      }

      // 包装 handler 以捕获响应
      const responseChunks = [];
      let responseStatus = 0;
      let contentType = "";
      let contentEncoding = "";
      let vendorTraceId = "";

      const wrappedHandler = new DecoratorHandler(handler);

      wrappedHandler.onResponseStart = (controller, statusCode, headers, statusMessage) => {
        responseStatus = statusCode;
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          for (const [key, val] of Object.entries(headers)) {
            const low = key.toLowerCase();
            if (low === "content-type") contentType = String(val);
            if (low === "content-encoding") contentEncoding = String(val).trim().toLowerCase();
            if (low === "eagleeye-traceid") vendorTraceId = String(val);
          }
        }
        return handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      };

      wrappedHandler.onResponseData = (controller, chunk) => {
        responseChunks.push(Buffer.from(chunk));
        return handler.onResponseData?.(controller, chunk);
      };

      wrappedHandler.onResponseEnd = (controller, trailers) => {
        try {
          const rawBody = Buffer.concat(responseChunks);
          appendProxyEvent(buildEvent(requestStartTime, reqFields, responseStatus, rawBody, contentType, contentEncoding, vendorTraceId, protocol));
        } catch (err) {
          debug("error processing response: " + err.message);
        }
        return handler.onResponseEnd?.(controller, trailers);
      };

      wrappedHandler.onResponseError = (controller, err) => {
        try { appendProxyEvent(buildErrorEvent(requestStartTime, reqFields, err)); } catch {}
        return handler.onResponseError?.(controller, err);
      };

      return dispatch(opts, wrappedHandler);
    };
  }

  try {
    const agent = new Agent().compose(createInterceptor);
    setGlobalDispatcher(agent);
    debug("undici interceptor installed, logging to: " + PROXY_LOG);
    return true;
  } catch (err) {
    debug("undici install failed: " + err.message);
    return false;
  }
}

// ===========================================================================
// 策略 B: patch Node.js https.request / http.request
// 适用于 bundled claude binary（其内部 undici 与 require('undici') 是不同实例）
// ===========================================================================

function installHttpsPatch() {
  const https = require("https");
  const http = require("http");
  const originalHttpsRequest = https.request.bind(https);
  const originalHttpRequest = http.request.bind(http);

  function makeInterceptedRequest(originalFn) {
    return function interceptedRequest(options, callback) {
      // 解析路径用于协议检测
      let urlPath = "";
      if (typeof options === "string") {
        try { urlPath = new URL(options).pathname; } catch { urlPath = options; }
      } else if (options instanceof URL) {
        urlPath = options.pathname;
      } else {
        urlPath = options?.path || "";
      }

      const method = (typeof options === "object" ? options?.method : "GET") || "GET";
      const protocol = detectProtocol(urlPath);

      // 非 API 请求直接透传
      if (method.toUpperCase() !== "POST" || !protocol) {
        return originalFn(options, callback);
      }

      const requestStartTime = Date.now() / 1000;
      const reqBodyChunks = [];

      // 调用原始 request，注入 response listener
      const req = originalFn(options, (res) => {
        const resBodyChunks = [];

        res.on("data", (chunk) => {
          resBodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });

        res.on("end", () => {
          try {
            const reqBody = Buffer.concat(reqBodyChunks).toString("utf-8");
            const rawResBody = Buffer.concat(resBodyChunks);

            let reqFields = { messages: null, model: "", system: null, request_body: null };
            try { reqFields = extractRequestFields(reqBody, protocol); } catch {}

            if (protocol === "anthropic" && isInternalCall(reqFields)) {
              debug("https.request: skipping internal call");
              return;
            }

            const contentType = res.headers["content-type"] || "";
            const contentEncoding = (res.headers["content-encoding"] || "").trim().toLowerCase();
            const statusCode = res.statusCode || 200;

            const event = buildEvent(
              requestStartTime,
              reqFields,
              statusCode,
              rawResBody,
              contentType,
              contentEncoding,
              res.headers["eagleeye-traceid"] || "",
              protocol
            );
            appendProxyEvent(event);
            debug(`https.request intercepted → ${event.model} in=${event.input_tokens} out=${event.output_tokens}`);
          } catch (err) {
            debug("https.request parse error: " + err.message);
          }
        });

        if (callback) callback(res);
      });

      // 拦截写入请求体（write + end）
      const origWrite = req.write.bind(req);
      req.write = function(chunk, encoding, cb) {
        if (chunk) {
          reqBodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf-8") : chunk);
        }
        return origWrite(chunk, encoding, cb);
      };

      const origEnd = req.end.bind(req);
      req.end = function(chunk, encoding, cb) {
        if (chunk) {
          reqBodyChunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf-8") : chunk);
        }
        return origEnd(chunk, encoding, cb);
      };

      return req;
    };
  }

  https.request = makeInterceptedRequest(originalHttpsRequest);
  http.request = makeInterceptedRequest(originalHttpRequest);
  debug("https/http.request patch installed, logging to: " + PROXY_LOG);
  return true;
}

// ===========================================================================
// 策略 C: monkey-patch globalThis.fetch (Bun & Node.js fallback)
// ===========================================================================

function installFetchPatch() {
  const originalFetch = globalThis.fetch;
  if (!originalFetch) {
    debug("globalThis.fetch not available, cannot patch");
    return false;
  }

  globalThis.fetch = async function interceptedFetch(input, init) {
    // 判断是否是目标请求
    let url;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      url = String(input);
    }

    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    const protocol = detectProtocol(url);
    if (method !== "POST" || !protocol) {
      return originalFetch.call(this, input, init);
    }

    const requestStartTime = Date.now() / 1000;

    // 提取请求体
    let reqFields = { messages: null, model: "", system: null };
    let bodyForForward = init?.body ?? (input instanceof Request ? input.body : undefined);

    try {
      let bodyStr = null;

      if (init?.body) {
        if (typeof init.body === "string") {
          bodyStr = init.body;
        } else if (init.body instanceof ArrayBuffer) {
          bodyStr = Buffer.from(init.body).toString("utf-8");
        } else if (ArrayBuffer.isView(init.body)) {
          bodyStr = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength).toString("utf-8");
        } else if (typeof init.body.getReader === "function") {
          // ReadableStream — tee 一份用于解析，原始流继续转发
          const [s1, s2] = init.body.tee();
          bodyForForward = s1;
          const reader = s2.getReader();
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            merged.set(c, offset);
            offset += c.byteLength;
          }
          bodyStr = Buffer.from(merged).toString("utf-8");
        }
      } else if (input instanceof Request) {
        // body 在 Request 对象上
        try {
          const cloned = input.clone();
          bodyStr = await cloned.text();
        } catch {}
      }

      if (bodyStr) reqFields = extractRequestFields(bodyStr, protocol);
    } catch {}

    // 跳过 Claude Code 内部调用（如 title 生成，仅 anthropic 协议）
    if (protocol === "anthropic" && isInternalCall(reqFields)) {
      debug("skipping internal call (title generation)");
      return originalFetch.call(this, input, init);
    }

    // 构造转发参数 — 如果 body 被 tee 过，替换为新的流
    let forwardInit = init;
    if (bodyForForward !== (init?.body ?? undefined)) {
      forwardInit = { ...init, body: bodyForForward };
    }

    // 调用原始 fetch
    let response;
    try {
      response = await originalFetch.call(this, input, forwardInit);
    } catch (err) {
      // 网络错误
      try { appendProxyEvent(buildErrorEvent(requestStartTime, reqFields, err)); } catch {}
      throw err;
    }

    // 克隆响应以读取 body 进行解析（不影响调用方消费）
    const responseStatus = response.status;
    const contentType = response.headers.get("content-type") || "";
    const contentEncoding = (response.headers.get("content-encoding") || "").trim().toLowerCase();
    const vendorTraceId = response.headers.get("eagleeye-traceid") || "";
    // 对 SSE 流式响应: 使用 tee 分流，一份给调用方，一份给解析
    if (contentType.includes("text/event-stream") && response.body) {
      const [forCaller, forCapture] = response.body.tee();

      // 异步消费 capture 流，不阻塞调用方
      consumeStreamAndLog(forCapture, requestStartTime, reqFields, responseStatus, contentType, contentEncoding, vendorTraceId, protocol);

      // 返回使用 forCaller 流的新 Response
      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // 非流式: clone 后读取
    try {
      const cloned = response.clone();
      // 异步处理不阻塞返回
      cloned.arrayBuffer().then((ab) => {
        try {
          const rawBody = Buffer.from(ab);
          appendProxyEvent(buildEvent(requestStartTime, reqFields, responseStatus, rawBody, contentType, contentEncoding, vendorTraceId, protocol));
        } catch (err) {
          debug("error processing response: " + err.message);
        }
      }).catch((err) => {
        debug("error reading response clone: " + err.message);
      });
    } catch (err) {
      debug("error cloning response: " + err.message);
    }

    return response;
  };

  debug("fetch monkey-patch installed, logging to: " + PROXY_LOG);
  return true;
}

async function consumeStreamAndLog(stream, requestStartTime, reqFields, responseStatus, contentType, contentEncoding, vendorTraceId, protocol) {
  try {
    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const rawBody = Buffer.concat(chunks);
    appendProxyEvent(buildEvent(requestStartTime, reqFields, responseStatus, rawBody, contentType, contentEncoding, vendorTraceId, protocol));
  } catch (err) {
    debug("error consuming SSE stream for capture: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Export parsing helpers for testing
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    _parseSseResponse: parseSseResponse,
    _parseJsonResponse: parseJsonResponse,
    _parseOpenAIChatJsonResponse: parseOpenAIChatJsonResponse,
    _parseOpenAIChatSseResponse: parseOpenAIChatSseResponse,
    _parseOpenAIResponsesJsonResponse: parseOpenAIResponsesJsonResponse,
    _parseOpenAIResponsesSseResponse: parseOpenAIResponsesSseResponse,
    _extractRequestFields: extractRequestFields,
    _isInternalCall: isInternalCall,
    _buildEvent: buildEvent,
    _buildErrorEvent: buildErrorEvent,
  };
}

// ===========================================================================
// 自动选择策略并安装
// ===========================================================================

(function install() {
  const isBun = typeof globalThis.Bun !== "undefined";

  if (isBun) {
    // Bun 运行时: 只用 fetch patch
    debug("Bun runtime detected, using fetch monkey-patch strategy");
    installFetchPatch();
    return;
  }

  // 策略A: undici Dispatcher (外部 undici 可用时最优，适用于 npx 版本)
  if (tryInstallUndici()) {
    debug("undici dispatcher installed");
    return;
  }

  // 策略B: https/http.request patch (最可靠，适用于 bundled claude binary)
  // bundled claude 内部打包了 undici，require('undici') 返回的是不同实例，
  // setGlobalDispatcher 对其无效。patch Node.js 原生模块层可绕过此限制。
  installHttpsPatch();

  // 策略C: 同时 patch fetch 作为双重保险 (Node.js >= 18 内置 fetch)
  installFetchPatch();
})();