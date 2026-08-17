// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * cli.js — Hook CLI commands (commander-based).
 * Implements session state accumulation, span replay, and install/uninstall
 * for Qwen Code OpenTelemetry instrumentation.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { trace, context, SpanStatusCode } = require("@opentelemetry/api");
const { loadState, saveState, clearState, readAndDeleteChildState, appendEvent, loadEvents, deleteEvents, STATE_DIR } = require("./state");
const { configureTelemetry, shutdownTelemetry } = require("./telemetry");
const { createToolTitle, createEventData, addResponseToEventData, MAX_CONTENT_LENGTH } = require("./hooks");

// ---------------------------------------------------------------------------
// Semantic convention dialect
// ---------------------------------------------------------------------------
const _sunfireDetected = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").includes("sunfire");
const SPAN_KIND_ATTR =
  process.env.LOONGSUITE_SEMCONV_DIALECT_NAME === "ALIBABA_GROUP" || _sunfireDetected
    ? "gen_ai.span_kind_name"
    : "gen_ai.span.kind";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------
function detectLang() {
  const vars = [
    process.env.OTEL_QWEN_LANG,
    process.env.LANGUAGE,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];
  for (const v of vars) {
    if (v && /zh/i.test(v)) return "zh";
  }
  return "en";
}

function detectLangFull() {
  const fast = detectLang();
  if (fast === "zh") return "zh";
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("child_process");
      const langs = execSync("defaults read -g AppleLanguages 2>/dev/null", { encoding: "utf-8", timeout: 2000 });
      if (/zh/i.test(langs)) return "zh";
      const locale = execSync("defaults read -g AppleLocale 2>/dev/null", { encoding: "utf-8", timeout: 2000 }).trim();
      if (/zh/i.test(locale)) return "zh";
    } catch {}
  }
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const locale = execSync(
        'reg query "HKCU\\Control Panel\\International" /v LocaleName',
        { encoding: "utf-8", timeout: 2000, windowsHide: true }
      );
      if (/zh/i.test(locale)) return "zh";
    } catch {}
  }
  return "en";
}
const LANG_MODE = detectLang();

function debug(msg) {
  if (process.env.OTEL_QWEN_DEBUG) console.error("[otel-qwen-hook]", msg);
}

function msg(zh, en) {
  return LANG_MODE === "zh" ? zh : en;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HOOK_CMD_ENV_VAR = "OTEL_QWEN_HOOK_CMD";
const HOOK_CMD_DEFAULT = "otel-qwen-hook";

function getHookCmd() {
  return process.env[HOOK_CMD_ENV_VAR] || HOOK_CMD_DEFAULT;
}

function buildHookConfig(cmd) {
  const subcommands = [
    ["UserPromptSubmit", "user-prompt-submit"],
    ["SessionStart", "session-start"],
    ["PreToolUse", "pre-tool-use"],
    ["PostToolUse", "post-tool-use"],
    ["PostToolUseFailure", "post-tool-use-failure"],
    ["Stop", "stop"],
    ["PreCompact", "pre-compact"],
    ["PostCompact", "post-compact"],
    ["SubagentStart", "subagent-start"],
    ["SubagentStop", "subagent-stop"],
    ["SessionEnd", "session-end"],
    ["Notification", "notification"],
  ];
  const config = {};
  for (const [event, sub] of subcommands) {
    config[event] = [{ hooks: [{ type: "command", command: `${cmd} ${sub}` }] }];
  }
  return config;
}

// ---------------------------------------------------------------------------
// Proxy event reading (intercept.js JSONL logs)
// ---------------------------------------------------------------------------
const PROXY_EVENTS_DIR = STATE_DIR;

/**
 * Resolve the PID of the qwen-code process that launched this hook subprocess.
 *
 * Hook invocation chain (qwen-code uses shell=true):
 *   qwen (PID=X)  →  sh (PID=Y)  →  otel-qwen-hook (PID=Z)
 *
 * We need X to locate the correct proxy_events_<X>.jsonl file.
 */
function resolveQwenPid() {
  const shellPid = process.ppid;
  if (!shellPid) return null;

  if (process.platform === "win32") {
    debug("resolveQwenPid: Windows not supported, returning null (time-window fallback)");
    return null;
  }

  const candidates = [];

  try {
    let grandparentPid = null;
    if (process.platform === "linux") {
      const status = fs.readFileSync(`/proc/${shellPid}/status`, "utf-8");
      const m = status.match(/^PPid:\s+(\d+)/m);
      if (m) grandparentPid = parseInt(m[1], 10);
    } else if (process.platform === "darwin") {
      const { execSync } = require("child_process");
      const out = execSync(`ps -o ppid= -p ${shellPid}`, { encoding: "utf-8", timeout: 2000 }).trim();
      if (/^\d+$/.test(out)) grandparentPid = parseInt(out, 10);
    }
    if (grandparentPid && grandparentPid > 1) candidates.push(grandparentPid);
  } catch (err) {
    debug(`resolveQwenPid: process tree walk failed (${err.message}), falling back to direct ppid`);
  }

  if (shellPid > 1) candidates.push(shellPid);

  for (const pid of candidates) {
    const candidate = path.join(PROXY_EVENTS_DIR, `proxy_events_${pid}.jsonl`);
    if (fs.existsSync(candidate)) return pid;
  }

  return candidates[0] || null;
}

function readProxyEvents(startTime, stopTime, deleteAfterRead = false, pid = null) {
  if (!fs.existsSync(PROXY_EVENTS_DIR)) return [];

  const bufferedStart = startTime - 5.0;
  const bufferedStop = stopTime + 5.0;
  const events = [];

  let fileNames = fs.readdirSync(PROXY_EVENTS_DIR)
    .filter((f) => f.startsWith("proxy_events_") && f.endsWith(".jsonl"));
  if (pid !== null) {
    fileNames = fileNames.filter((f) => f === `proxy_events_${pid}.jsonl`);
  } else {
    deleteAfterRead = false;
  }
  const files = fileNames.map((f) => path.join(PROXY_EVENTS_DIR, f)).sort();

  for (const logFile of files) {
    try {
      const lines = fs.readFileSync(logFile, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          const ts = parseFloat(evt.timestamp);
          if (!isNaN(ts) && ts >= bufferedStart && ts <= bufferedStop) {
            events.push(evt);
          }
        } catch {}
      }
    } catch {}
  }

  events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  if (deleteAfterRead) {
    for (const logFile of files) {
      try { fs.unlinkSync(logFile); } catch {}
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// ARMS Message Schema transform helpers
// ---------------------------------------------------------------------------

/**
 * Transform OpenAI-compatible input messages to ARMS gen_ai.input.messages schema.
 * ARMS expects: [{role, parts: [{type:"text", content:"..."}, ...]}]
 */
function transformToArmsInputMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return rawMessages;
  const result = [];
  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role || "user";
    const parts = [];

    const content = msg.content;
    if (typeof content === "string") {
      if (content) parts.push({ type: "text", content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text") {
          parts.push({ type: "text", content: item.text || item.content || "" });
        } else {
          parts.push(item);
        }
      }
    }

    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        let args = fn.arguments || fn["arguments"];
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch {}
        }
        parts.push({ type: "tool_call", id: tc.id || null, name: fn.name || "", arguments: args || null });
      }
    }

    if (role === "tool") {
      const toolCallId = msg.tool_call_id || null;
      if (parts.length > 0) {
        const responseText = parts.map(p => p.content || "").join("\n");
        result.push({ role, parts: [{ type: "tool_call_response", id: toolCallId, response: responseText }] });
        continue;
      }
    }

    if (parts.length > 0) {
      result.push({ role, parts });
    }
  }
  return result;
}

/**
 * Transform content_blocks from intercept.js to ARMS gen_ai.output.messages schema.
 * ARMS expects: [{role:"assistant", parts:[...], finish_reason:"stop"}]
 */
function transformToArmsOutputMessages(contentBlocks, stopReason) {
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return contentBlocks;
  const parts = [];
  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push({ type: "text", content: block.text || block.content || "" });
    } else if (block.type === "tool_use") {
      parts.push({ type: "tool_call", id: block.id || null, name: block.name || "", arguments: block.input || null });
    } else if (block.type === "thinking") {
      parts.push({ type: "thinking", content: block.thinking || "" });
    } else {
      parts.push(block);
    }
  }
  const finishReason = mapStopReasonToFinishReason(stopReason);
  return [{ role: "assistant", parts, finish_reason: finishReason }];
}

/**
 * Transform system prompt to ARMS gen_ai.system_instructions schema.
 * ARMS expects: [{"type":"text", "content":"..."}]
 */
function transformToArmsSystemInstructions(systemPrompt) {
  if (systemPrompt === null || systemPrompt === undefined) return null;
  if (typeof systemPrompt === "string") {
    return [{ type: "text", content: systemPrompt }];
  }
  if (!Array.isArray(systemPrompt)) {
    return [{ type: "text", content: String(systemPrompt) }];
  }
  const parts = [];
  for (const item of systemPrompt) {
    if (typeof item === "string") {
      parts.push({ type: "text", content: item });
    } else if (item && typeof item === "object") {
      const c = item.content;
      if (typeof c === "string") {
        parts.push({ type: "text", content: c });
      } else if (Array.isArray(c)) {
        for (const sub of c) {
          if (typeof sub === "string") {
            parts.push({ type: "text", content: sub });
          } else if (sub && typeof sub === "object") {
            parts.push({ type: "text", content: sub.text || sub.content || "" });
          }
        }
      } else if (item.text) {
        parts.push({ type: "text", content: item.text });
      } else {
        parts.push({ type: "text", content: String(c || "") });
      }
    }
  }
  return parts.length > 0 ? parts : null;
}

// ---------------------------------------------------------------------------
// OTel helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Unix timestamp (seconds, float) to OTel HrTime [seconds, nanos].
 */
function hrTime(timestampSec) {
  const sec = Math.floor(timestampSec);
  const nanos = Math.round((timestampSec - sec) * 1e9);
  return [sec, nanos];
}

function tsNs(sec) {
  return Math.round(sec * 1e9);
}

// ---------------------------------------------------------------------------
// Debug logging (enabled via OTEL_QWEN_HOOK_DEBUG=1)
// ---------------------------------------------------------------------------
const DEBUG_LOG_PATH = path.join(os.tmpdir(), "otel-qwen-hook-debug.log");
const _hookDebug = process.env.OTEL_QWEN_HOOK_DEBUG === "1";
function debugLog(obj) {
  if (!_hookDebug) return;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------
// stdin helper
// ---------------------------------------------------------------------------
function readStdinJson() {
  let raw = "";
  try {
    const chunks = [];
    const buf = Buffer.alloc(65536);
    let fd;
    try {
      fd = fs.openSync("/dev/stdin", "rs");
    } catch {
      fd = 0;
    }
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const copy = Buffer.alloc(bytes);
      buf.copy(copy, 0, 0, bytes);
      chunks.push(copy);
    }
    if (fd !== 0) try { fs.closeSync(fd); } catch {}
    raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    debugLog({ error: "readStdinJson_failed", message: String(err), raw_length: raw.length, raw_head: raw.slice(0, 200) });
    return {};
  }
}

// ---------------------------------------------------------------------------
// Reconstruct session state from events (replaces loadState for export)
// ---------------------------------------------------------------------------
function reconstructStateFromEvents(sessionId, events, stopTime) {
  let startTime = stopTime;
  let firstPromptTime = null;
  let prompt = "";
  let model = "unknown";
  let toolsUsedCount = 0;
  let turns = 0;
  const toolSet = new Set();

  for (const ev of events) {
    if (ev.timestamp && ev.timestamp < startTime) startTime = ev.timestamp;
    switch (ev.type) {
      case "user_prompt_submit":
        if (!prompt) prompt = ev.prompt || "";
        if (ev.model) model = ev.model;
        if (firstPromptTime === null) firstPromptTime = ev.timestamp || null;
        turns++;
        break;
      case "session_start":
        if (ev.model) model = ev.model;
        break;
      case "pre_tool_use":
        toolsUsedCount++;
        if (ev.tool_name) toolSet.add(ev.tool_name);
        break;
      case "llm_call":
        if (ev.model && model === "unknown") model = ev.model;
        break;
    }
  }

  if (firstPromptTime !== null) startTime = firstPromptTime;

  return {
    session_id: sessionId,
    start_time: startTime,
    stop_time: stopTime,
    prompt,
    model,
    last_output: "",
    metrics: { tools_used: toolsUsedCount, turns },
    tools_used: [...toolSet],
    events,
  };
}

function extractOutputAndTokensFromEvents(events) {
  let lastOutput = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let model = "unknown";
  for (const ev of events) {
    if (ev.type !== "llm_call") continue;
    inputTokens += ev.input_tokens || 0;
    outputTokens += ev.output_tokens || 0;
    if (ev.model) model = ev.model;
    if (ev.output_content) {
      const raw = ev.output_content;
      lastOutput = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (lastOutput.length > MAX_CONTENT_LENGTH) lastOutput = lastOutput.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
    }
  }
  return { lastOutput, inputTokens, outputTokens, model };
}

// ---------------------------------------------------------------------------
// Subagent pre-scan helpers
// ---------------------------------------------------------------------------

/**
 * Build subagent windows from start/stop pairs, determine which events
 * they own, and match them to parent TOOL spans.
 */
function buildSubagentInfo(events) {
  const startMap = {};
  const windows = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "subagent_start") {
      const agentId = ev.agent_id || "";
      if (agentId) {
        startMap[agentId] = { startIdx: i, startTime: ev.timestamp, agent_type: ev.agent_type || "" };
      }
    } else if (ev.type === "subagent_stop") {
      const agentId = ev.agent_id || ev.subagent_session_id || "";
      const start = startMap[agentId];
      if (start) {
        windows.push({
          agent_id: agentId,
          agent_type: start.agent_type,
          startTime: start.startTime,
          stopTime: ev.timestamp,
          startIdx: start.startIdx,
          stopIdx: i,
          childEvents: [],
        });
        delete startMap[agentId];
      }
    }
  }

  // Filter to top-level windows only (not fully nested inside another)
  const topLevel = windows.filter((w, idx) =>
    !windows.some((other, j) => idx !== j && other.startIdx < w.startIdx && other.stopIdx > w.stopIdx)
  );

  // Determine child events per window; skip if window overlaps with a sibling
  const ownedIndices = new Set();
  const stopIdxToWindow = {};

  for (const win of topLevel) {
    ownedIndices.add(win.startIdx);
    ownedIndices.add(win.stopIdx);

    const overlaps = topLevel.some(
      (other) => other !== win && win.startIdx < other.stopIdx && other.startIdx < win.stopIdx
    );

    if (!overlaps) {
      // Collect tool_use_ids whose pre_tool_use is OUTSIDE this window;
      // their post_tool_use may land inside the window when a parallel
      // tool completes during subagent execution — exclude those.
      const externalToolIds = new Set();
      for (let j = 0; j < events.length; j++) {
        if (j >= win.startIdx && j <= win.stopIdx) continue;
        if (events[j].type === "pre_tool_use" && events[j].tool_use_id) {
          externalToolIds.add(events[j].tool_use_id);
        }
      }

      win.childEvents = [];
      for (let j = win.startIdx + 1; j < win.stopIdx; j++) {
        const ev = events[j];
        const isExternalPost =
          (ev.type === "post_tool_use" || ev.type === "post_tool_use_failure") &&
          ev.tool_use_id && externalToolIds.has(ev.tool_use_id);
        if (isExternalPost) continue;
        win.childEvents.push(ev);
        ownedIndices.add(j);
      }
    }

    stopIdxToWindow[win.stopIdx] = win;
  }

  // Match subagent windows → parent TOOL spans by time containment
  const subagentToToolUseId = matchSubagentsToTools(events, topLevel, ownedIndices);

  return { windows: topLevel, ownedIndices, stopIdxToWindow, subagentToToolUseId };
}

/**
 * For each subagent window, find the tightest pre_tool_use/post_tool_use pair
 * that fully contains it (the "agent" TOOL span wrapping the subagent).
 */
function matchSubagentsToTools(events, subagentWindows, ownedIndices) {
  const preToolTmp = {};
  const toolPairs = [];

  for (let i = 0; i < events.length; i++) {
    if (ownedIndices.has(i)) continue;
    const ev = events[i];
    if (ev.type === "pre_tool_use" && ev.tool_use_id) {
      preToolTmp[ev.tool_use_id] = { preTime: ev.timestamp };
    } else if ((ev.type === "post_tool_use" || ev.type === "post_tool_use_failure") && ev.tool_use_id && preToolTmp[ev.tool_use_id]) {
      toolPairs.push({ toolUseId: ev.tool_use_id, preTime: preToolTmp[ev.tool_use_id].preTime, postTime: ev.timestamp });
    }
  }

  const result = {};
  const used = new Set();

  for (const win of subagentWindows) {
    let bestId = null;
    let bestDur = Infinity;
    for (const pair of toolPairs) {
      if (used.has(pair.toolUseId)) continue;
      if (pair.preTime <= win.startTime && pair.postTime >= win.stopTime) {
        const dur = pair.postTime - pair.preTime;
        if (dur < bestDur) { bestDur = dur; bestId = pair.toolUseId; }
      }
    }
    if (bestId) { result[win.agent_id] = bestId; used.add(bestId); }
  }
  return result;
}

// ---------------------------------------------------------------------------
// replayEventsAsSpans
// ---------------------------------------------------------------------------
function mapStopReasonToFinishReason(stopReason) {
  if (!stopReason) return "stop";
  const sr = stopReason.toLowerCase();
  if (sr === "stop" || sr === "end_turn") return "stop";
  if (sr === "tool_calls" || sr === "tool_use") return "tool_call";
  if (sr === "length" || sr === "max_tokens") return "length";
  if (sr === "content_filter") return "content_filter";
  if (sr === "error") return "error";
  return stopReason;
}

function replayEventsAsSpans(tracer, events, parentCtx, stopTime) {
  const { ownedIndices, stopIdxToWindow, subagentToToolUseId } = buildSubagentInfo(events);

  const openTools = {};
  let currentTurnSpan = null;
  let currentTurnCtx = null;
  let turnIdx = 0;
  let lastCompactSpan = null;
  let lastLlmStopReason = "";

  function parentContext() {
    return currentTurnCtx !== null ? currentTurnCtx : parentCtx;
  }

  for (let i = 0; i < events.length; i++) {
    if (ownedIndices.has(i) && events[i].type !== "subagent_stop") continue;

    const ev = events[i];
    const evType = ev.type || "";
    const evTs = ev.timestamp || stopTime;

    if (evType === "user_prompt_submit") {
      if (currentTurnSpan !== null) {
        currentTurnSpan.setAttribute("gen_ai.react.finish_reason", mapStopReasonToFinishReason(lastLlmStopReason));
        currentTurnSpan.end(hrTime(evTs));
        currentTurnSpan = null;
        currentTurnCtx = null;
      }
      lastLlmStopReason = "";

      turnIdx++;
      currentTurnSpan = tracer.startSpan(
        `react step ${turnIdx}`,
        {
          startTime: hrTime(evTs),
          attributes: {
            "turn.index": turnIdx,
            "gen_ai.operation.name": "react",
            "gen_ai.react.round": turnIdx,
            [SPAN_KIND_ATTR]: "STEP",
          },
        },
        parentCtx
      );
      currentTurnCtx = trace.setSpan(context.active(), currentTurnSpan);

    } else if (evType === "session_start") {
      // No span — metadata only

    } else if (evType === "pre_tool_use") {
      const toolName = ev.tool_name || "unknown";
      const toolInput = ev.tool_input || {};
      const toolUseId = ev.tool_use_id || "";
      const toolTitle = createToolTitle(toolName, toolInput);
      const eventData = createEventData(toolName, toolInput);

      const attrs = {
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": toolUseId,
        "gen_ai.operation.name": "execute_tool",
        [SPAN_KIND_ATTR]: "TOOL",
      };
      for (const [k, v] of Object.entries(eventData)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") attrs[k] = v;
      }

      const toolSpan = tracer.startSpan(
        `execute_tool ${toolName}`,
        { startTime: hrTime(evTs), attributes: attrs },
        parentContext()
      );
      if (toolUseId) {
        openTools[toolUseId] = toolSpan;
      } else {
        toolSpan.end(hrTime(evTs));
      }

    } else if (evType === "post_tool_use") {
      const toolUseId = ev.tool_use_id || "";
      const toolName = ev.tool_name || "unknown";
      const toolResponse = ev.tool_response;

      const toolSpan = openTools[toolUseId];
      if (toolSpan) {
        delete openTools[toolUseId];
        const eventData = { "gen_ai.tool.name": toolName };
        addResponseToEventData(eventData, toolResponse);
        for (const [k, v] of Object.entries(eventData)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") toolSpan.setAttribute(k, v);
        }
        toolSpan.end(hrTime(evTs));
      }

    } else if (evType === "post_tool_use_failure") {
      const toolUseId = ev.tool_use_id || "";
      const toolName = ev.tool_name || "unknown";
      const errorMsg = ev.error || "Unknown error";

      const toolSpan = openTools[toolUseId];
      if (toolSpan) {
        delete openTools[toolUseId];
        toolSpan.setAttribute("gen_ai.tool.name", toolName);
        toolSpan.setAttribute("error", true);
        toolSpan.setAttribute("error.type", ev.error_type || "tool_failure");
        toolSpan.setAttribute("error.message", errorMsg);
        toolSpan.setAttribute("status", "error");
        if (ev.is_interrupt) toolSpan.setAttribute("is_interrupt", true);
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        toolSpan.end(hrTime(evTs));
      } else {
        const failSpan = tracer.startSpan(
          `execute_tool ${toolName}`,
          {
            startTime: hrTime(evTs),
            attributes: {
              "gen_ai.tool.name": toolName,
              "gen_ai.tool.call.id": toolUseId,
              "error": true,
              "error.type": ev.error_type || "tool_failure",
              "error.message": errorMsg,
              "status": "error",
              [SPAN_KIND_ATTR]: "TOOL",
            },
          },
          parentContext()
        );
        failSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
        failSpan.end(hrTime(evTs));
      }

    } else if (evType === "pre_compact") {
      lastCompactSpan = tracer.startSpan(
        "run_task context_compaction",
        {
          startTime: hrTime(evTs),
          attributes: {
            "gen_ai.operation.name": "run_task",
            "compact.trigger": ev.trigger || "unknown",
            "compact.has_custom_instructions": !!ev.has_custom_instructions,
            [SPAN_KIND_ATTR]: "TASK",
          },
        },
        parentCtx
      );

    } else if (evType === "post_compact") {
      if (lastCompactSpan) {
        if (ev.compact_summary) lastCompactSpan.setAttribute("compact.summary", ev.compact_summary);
        if (ev.trigger) lastCompactSpan.setAttribute("compact.trigger", ev.trigger);
        lastCompactSpan.end(hrTime(evTs));
        lastCompactSpan = null;
      } else {
        const span = tracer.startSpan(
          "run_task context_compaction",
          {
            startTime: hrTime(evTs),
            attributes: { "gen_ai.operation.name": "run_task", "compact.trigger": ev.trigger || "unknown", "compact.summary": ev.compact_summary || "", [SPAN_KIND_ATTR]: "TASK" },
          },
          parentCtx
        );
        span.end(hrTime(evTs));
      }

    } else if (evType === "notification") {
      const notifMsg = ev.message || "";
      const span = tracer.startSpan(
        "run_task notification",
        {
          startTime: hrTime(evTs),
          attributes: {
            "gen_ai.operation.name": "run_task",
            "notification.message": notifMsg,
            "notification.level": ev.level || "info",
            "notification.title": ev.title || "",
            [SPAN_KIND_ATTR]: "TASK",
          },
        },
        parentCtx
      );
      span.end(hrTime(evTs));

    } else if (evType === "subagent_start") {
      // Unmatched start (no stop) — create marker span
      const agentId = ev.agent_id || "";
      const agentName = ev.agent_type || agentId || "unknown";
      const span = tracer.startSpan(
        `invoke_agent ${agentName}`,
        {
          startTime: hrTime(evTs),
          attributes: {
            "gen_ai.agent.id": agentId,
            "gen_ai.agent.name": ev.agent_type || "",
            "gen_ai.operation.name": "invoke_agent",
            "qwen_code.hook.type": evType,
            [SPAN_KIND_ATTR]: "AGENT",
          },
        },
        parentContext()
      );
      span.end(hrTime(evTs));

    } else if (evType === "subagent_stop") {
      const win = stopIdxToWindow[i];
      if (win) {
        // Determine parent: prefer nesting under the matching TOOL span
        let agentParentCtx = parentContext();
        const parentToolUseId = subagentToToolUseId[win.agent_id];
        if (parentToolUseId && openTools[parentToolUseId]) {
          agentParentCtx = trace.setSpan(context.active(), openTools[parentToolUseId]);
        }

        const agentName = win.agent_type || win.agent_id || "unknown";
        const containerSpan = tracer.startSpan(
          `invoke_agent ${agentName}`,
          {
            startTime: hrTime(win.startTime),
            attributes: {
              "gen_ai.agent.id": win.agent_id,
              "gen_ai.agent.name": win.agent_type || win.agent_id || "",
              "gen_ai.operation.name": "invoke_agent",
              "subagent.stop_reason": ev.stop_reason || "end_turn",
              [SPAN_KIND_ATTR]: "AGENT",
            },
          },
          agentParentCtx
        );

        if (win.childEvents.length > 0) {
          const containerCtx = trace.setSpan(context.active(), containerSpan);
          replayEventsAsSpans(tracer, win.childEvents, containerCtx, win.stopTime);
        }
        containerSpan.end(hrTime(win.stopTime));
      } else {
        // Unmatched stop — create marker span
        const childSid = ev.agent_id || ev.subagent_session_id || "unknown";
        const span = tracer.startSpan(
          `invoke_agent ${childSid}`,
          {
            startTime: hrTime(evTs),
            attributes: {
              "gen_ai.agent.id": childSid,
              "gen_ai.agent.name": childSid,
              "subagent.stop_reason": ev.stop_reason || "end_turn",
              "gen_ai.operation.name": "invoke_agent",
              "qwen_code.hook.type": evType,
              [SPAN_KIND_ATTR]: "AGENT",
            },
          },
          parentContext()
        );
        span.end(hrTime(evTs));
      }

    } else if (evType === "llm_call") {
      const model = ev.model || "unknown";
      const requestStart = ev.request_start_time || evTs;
      const llmSpan = tracer.startSpan(
        `chat ${model}`,
        {
          startTime: hrTime(requestStart),
          attributes: {
            "gen_ai.system": "qwen",
            "gen_ai.provider.name": "dashscope",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.response.model": model,
            "gen_ai.usage.input_tokens": ev.input_tokens || 0,
            "gen_ai.usage.output_tokens": ev.output_tokens || 0,
            "gen_ai.usage.total_tokens": (ev.input_tokens || 0) + (ev.output_tokens || 0),
            "gen_ai.usage.cache_read.input_tokens": ev.cache_read_input_tokens || 0,
            "gen_ai.usage.cache_creation.input_tokens": ev.cache_creation_input_tokens || 0,
            "qwen_code.hook.type": "llm_call",
            [SPAN_KIND_ATTR]: "LLM",
          },
        },
        parentContext()
      );

      if (ev.stop_reason) {
        const fr = mapStopReasonToFinishReason(ev.stop_reason);
        llmSpan.setAttribute("gen_ai.response.finish_reasons", JSON.stringify([fr]));
      }

      try {
        const systemPrompt = ev.system_prompt;
        if (systemPrompt !== null && systemPrompt !== undefined) {
          const sysInstructions = transformToArmsSystemInstructions(systemPrompt);
          if (sysInstructions) {
            let serialized = JSON.stringify(sysInstructions);
            if (serialized.length > MAX_CONTENT_LENGTH) serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
            llmSpan.setAttribute("gen_ai.system_instructions", serialized);
          }
        }
        const rawInput = ev.input_messages || [];
        if (rawInput && (Array.isArray(rawInput) ? rawInput.length > 0 : true)) {
          const armsInput = Array.isArray(rawInput) ? transformToArmsInputMessages(rawInput) : rawInput;
          let serialized = typeof armsInput === "string" ? armsInput : JSON.stringify(armsInput);
          if (serialized.length > MAX_CONTENT_LENGTH) serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
          llmSpan.setAttribute("gen_ai.input.messages", serialized);
        }
      } catch {}

      try {
        const rawOutput = ev.output_content;
        if (rawOutput !== null && rawOutput !== undefined) {
          const armsOutput = Array.isArray(rawOutput) ? transformToArmsOutputMessages(rawOutput, ev.stop_reason || "") : rawOutput;
          let serialized = typeof armsOutput === "string" ? armsOutput : JSON.stringify(armsOutput);
          if (serialized.length > MAX_CONTENT_LENGTH) serialized = serialized.slice(0, MAX_CONTENT_LENGTH) + "...(truncated)";
          llmSpan.setAttribute("gen_ai.output.messages", serialized);
        }
      } catch {}

      if (ev.stop_reason) lastLlmStopReason = ev.stop_reason;

      if (ev.is_error) {
        llmSpan.setAttribute("error", true);
        llmSpan.setAttribute("error.message", ev.error_message || "");
      }
      llmSpan.end(hrTime(evTs));

    } else if (evType === "session_end") {
      // No span
    }
  }

  for (const orphan of Object.values(openTools)) orphan.end(hrTime(stopTime));
  if (lastCompactSpan) lastCompactSpan.end(hrTime(stopTime));
  if (currentTurnSpan !== null) {
    currentTurnSpan.setAttribute("gen_ai.react.finish_reason", mapStopReasonToFinishReason(lastLlmStopReason));
    currentTurnSpan.end(hrTime(stopTime));
  }
}

// ---------------------------------------------------------------------------
// exportSessionTrace
// ---------------------------------------------------------------------------
async function exportSessionTrace(state, stopReason = "end_turn") {
  configureTelemetry();

  if (!state || typeof state !== "object") {
    throw new Error("exportSessionTrace: invalid state object");
  }

  const sessionId = state.session_id || "unknown";
  const prompt = state.prompt || "";
  const metrics = state.metrics || {};
  let events = Array.isArray(state.events) ? state.events : [];
  const startTime = typeof state.start_time === "number" ? state.start_time : Date.now() / 1000;
  const stopTime = typeof state.stop_time === "number" ? state.stop_time : Date.now() / 1000;

  const promptPreview = prompt.length > 60 ? prompt.slice(0, 60) + "..." : prompt;
  const spanTitle = prompt ? `run_task ${promptPreview}` : "run_task qwen-code-session";

  const tracer = trace.getTracer("opentelemetry-instrumentation-qwen");

  // Merge proxy events from intercept.js
  try {
    const qwenPid = resolveQwenPid();
    const proxyEvents = readProxyEvents(startTime, stopTime, true, qwenPid);
    if (proxyEvents.length > 0) {
      events = [...events, ...proxyEvents].sort(
        (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
      );
    }
  } catch {}

  const extracted = extractOutputAndTokensFromEvents(events);
  const lastOutput = extracted.lastOutput;
  const resolvedModel = (state.model && state.model !== "unknown") ? state.model : extracted.model;

  const sessionSpan = tracer.startSpan(spanTitle, {
    startTime: hrTime(startTime),
    attributes: {
      "input.value": prompt,
      "input.mime_type": "text/plain",
      "output.value": lastOutput,
      "output.mime_type": "text/plain",
      "gen_ai.operation.name": "run_task",
      "gen_ai.session.id": sessionId,
      "gen_ai.conversation.id": sessionId,
      "gen_ai.system": "qwen",
      "gen_ai.framework": "qwen-code",
      "gen_ai.request.model": resolvedModel,
      "gen_ai.response.model": resolvedModel,
      tools_used: metrics.tools_used || 0,
      tool_names: (state.tools_used || []).join(","),
      turns: metrics.turns || 0,
      stop_reason: stopReason,
      [SPAN_KIND_ATTR]: "TASK",
    },
  });
  const sessionCtx = trace.setSpan(context.active(), sessionSpan);

  replayEventsAsSpans(tracer, events, sessionCtx, stopTime);
  sessionSpan.end(hrTime(stopTime));

  await shutdownTelemetry();

  const duration = stopTime - startTime;
  console.error(
    `✅ Session traced | ` +
    `${metrics.input_tokens || 0} in, ` +
    `${metrics.output_tokens || 0} out | ` +
    `${metrics.tools_used || 0} tools | ` +
    `${duration.toFixed(1)}s`
  );
}

// ---------------------------------------------------------------------------
// install helpers
// ---------------------------------------------------------------------------
function installIntercept() {
  const src = path.join(__dirname, "intercept.js");
  if (!fs.existsSync(src)) {
    console.error("⚠️  intercept.js not found in package, skipping.");
    return null;
  }
  const destDir = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.qwen");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "intercept.js");
  fs.copyFileSync(src, dest);
  console.error(`✅ intercept.js installed to ${dest}`);
  return dest;
}

function installIntoSettings(settingsPath) {
  settingsPath = path.resolve(settingsPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
  }

  if (!settings.hooks) settings.hooks = {};
  const hookConfig = buildHookConfig(getHookCmd());

  for (const [eventName, matchers] of Object.entries(hookConfig)) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
    const existing = settings.hooks[eventName];
    const hookCmd = matchers[0].hooks[0].command;

    const alreadyPresent = existing.some((matcher) =>
      (matcher.hooks || []).some((h) => h.command === hookCmd)
    );
    if (!alreadyPresent) {
      existing.push(...matchers);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function removeHooksFromSettings(settingsPath) {
  settingsPath = path.resolve(settingsPath);
  if (!fs.existsSync(settingsPath)) return;

  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch { return; }
  if (!settings.hooks) return;

  const hookCmd = getHookCmd();
  let changed = false;

  for (const eventName of Object.keys(settings.hooks)) {
    const matchers = settings.hooks[eventName];
    if (!Array.isArray(matchers)) continue;

    const filtered = matchers.filter((matcher) => {
      const hooks = matcher.hooks || [];
      return !hooks.some((h) => h.command && h.command.includes(hookCmd));
    });

    if (filtered.length !== matchers.length) {
      settings.hooks[eventName] = filtered;
      changed = true;
    }

    if (settings.hooks[eventName].length === 0) {
      delete settings.hooks[eventName];
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }
}

function removeAliasFromFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  const beginMarker = "# BEGIN otel-qwen-hook";
  const endMarker = "# END otel-qwen-hook";
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);
  if (beginIdx === -1 || endIdx === -1) return;
  const before = content.slice(0, beginIdx);
  const after = content.slice(endIdx + endMarker.length);
  const cleaned = (before + after).replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(filePath, cleaned, "utf-8");
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
function cmdUserPromptSubmit() {
  const event = readStdinJson();
  debugLog({ hook: "UserPromptSubmit", session_id: event.session_id || "MISSING", prompt_len: (event.prompt || "").length });
  return cmdUserPromptSubmitWithEvent(event);
}

function cmdUserPromptSubmitWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "user_prompt_submit",
    timestamp: Date.now() / 1000,
    prompt: event.prompt || event.user_prompt || "",
    model: event.model || "",
  });
}

function cmdSessionStart() {
  const event = readStdinJson();
  return cmdSessionStartWithEvent(event);
}

function cmdSessionStartWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "session_start",
    timestamp: Date.now() / 1000,
    model: event.model || "",
    source: event.source || "",
    permission_mode: event.permission_mode || "",
  });
}

function cmdPreToolUse() {
  const event = readStdinJson();
  debugLog({ hook: "PreToolUse", session_id: event.session_id || "MISSING", tool_name: event.tool_name, tool_use_id: event.tool_use_id, stdin_keys: Object.keys(event) });
  return cmdPreToolUseWithEvent(event);
}

function cmdPreToolUseWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  if (!event.session_id) debugLog({ warn: "missing_session_id", type: "pre_tool_use", generated_id: sessionId, tool_name: event.tool_name });
  appendEvent(sessionId, {
    type: "pre_tool_use",
    timestamp: Date.now() / 1000,
    tool_name: event.tool_name || "unknown",
    tool_input: event.tool_input || {},
    tool_use_id: event.tool_use_id || null,
  });
}

function cmdPostToolUse() {
  const event = readStdinJson();
  debugLog({ hook: "PostToolUse", session_id: event.session_id || "MISSING", tool_name: event.tool_name, tool_use_id: event.tool_use_id, has_tool_response: event.tool_response !== undefined, stdin_keys: Object.keys(event) });
  return cmdPostToolUseWithEvent(event);
}

function cmdPostToolUseWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  if (!event.session_id) debugLog({ warn: "missing_session_id", type: "post_tool_use", generated_id: sessionId, tool_name: event.tool_name });
  appendEvent(sessionId, {
    type: "post_tool_use",
    timestamp: Date.now() / 1000,
    tool_name: event.tool_name || "unknown",
    tool_response: event.tool_response,
    tool_use_id: event.tool_use_id || null,
  });
}

function cmdPostToolUseFailure() {
  const event = readStdinJson();
  debugLog({ hook: "PostToolUseFailure", session_id: event.session_id || "MISSING", tool_name: event.tool_name, tool_use_id: event.tool_use_id, stdin_keys: Object.keys(event) });
  return cmdPostToolUseFailureWithEvent(event);
}

function cmdPostToolUseFailureWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  if (!event.session_id) debugLog({ warn: "missing_session_id", type: "post_tool_use_failure", generated_id: sessionId, tool_name: event.tool_name });
  appendEvent(sessionId, {
    type: "post_tool_use_failure",
    timestamp: Date.now() / 1000,
    tool_name: event.tool_name || "unknown",
    tool_input: event.tool_input || {},
    tool_use_id: event.tool_use_id || null,
    error: event.error || "Unknown error",
    error_type: event.error_type || "tool_failure",
    is_interrupt: !!event.is_interrupt,
  });
}

function cmdPreCompact() {
  const event = readStdinJson();
  return cmdPreCompactWithEvent(event);
}

function cmdPreCompactWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "pre_compact",
    timestamp: Date.now() / 1000,
    trigger: event.trigger || "unknown",
    has_custom_instructions: event.custom_instructions !== null && event.custom_instructions !== undefined,
  });
}

function cmdPostCompact() {
  const event = readStdinJson();
  return cmdPostCompactWithEvent(event);
}

function cmdPostCompactWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "post_compact",
    timestamp: Date.now() / 1000,
    trigger: event.trigger || "unknown",
    compact_summary: event.compact_summary || "",
  });
}

function cmdSubagentStart() {
  const event = readStdinJson();
  return cmdSubagentStartWithEvent(event);
}

function cmdSubagentStartWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "subagent_start",
    timestamp: Date.now() / 1000,
    agent_id: event.agent_id || "",
    agent_type: event.agent_type || "",
    subagent_session_id: event.subagent_session_id || "",
  });
}

function cmdSubagentStop() {
  const event = readStdinJson();
  return cmdSubagentStopWithEvent(event);
}

function cmdSubagentStopWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  const usage = event.usage || {};
  appendEvent(sessionId, {
    type: "subagent_stop",
    timestamp: Date.now() / 1000,
    agent_id: event.agent_id || event.subagent_session_id || "unknown",
    subagent_session_id: event.agent_id || event.subagent_session_id || "unknown",
    stop_reason: event.stop_reason || "end_turn",
    input_tokens: usage.input_tokens || event.input_tokens || 0,
    output_tokens: usage.output_tokens || event.output_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || event.cache_read_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || event.cache_creation_input_tokens || 0,
  });
}

function cmdSessionEnd() {
  const event = readStdinJson();
  return cmdSessionEndWithEvent(event);
}

function cmdSessionEndWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "session_end",
    timestamp: Date.now() / 1000,
    reason: event.reason || "",
  });
}

function cmdNotification() {
  const event = readStdinJson();
  return cmdNotificationWithEvent(event);
}

function cmdNotificationWithEvent(event) {
  const sessionId = event.session_id || require("crypto").randomUUID();
  appendEvent(sessionId, {
    type: "notification",
    timestamp: Date.now() / 1000,
    message: event.message || "",
    title: event.title || "",
    level: event.level || "info",
  });
}

async function cmdStop() {
  const event = readStdinJson();
  const sessionId = event.session_id || require("crypto").randomUUID();
  const stopReason = event.stop_reason || event.reason || "end_turn";
  const stopTime = Date.now() / 1000;

  let events = loadEvents(sessionId);
  debugLog({ hook: "Stop", session_id: event.session_id || "MISSING", event_count: events.length, event_types: events.map(e => e.type) });

  // Fallback: try legacy JSON state if JSONL is empty
  if (events.length === 0) {
    const legacyState = loadState(sessionId);
    if (legacyState && Array.isArray(legacyState.events) && legacyState.events.length > 0) {
      events = legacyState.events;
    }
  }

  const state = reconstructStateFromEvents(sessionId, events, stopTime);

  try {
    await exportSessionTrace(state, stopReason);
  } catch (err) {
    console.error(
      "[otel-qwen-hook] telemetry export failed (agent unaffected):",
      err?.message || String(err)
    );
  }

  deleteEvents(sessionId);
  clearState(sessionId);
}

async function cmdInstall(opts = {}) {
  const quiet = !!opts.quiet;
  const log = (...args) => { if (!quiet) console.error(...args); };
  const installLang = quiet ? LANG_MODE : detectLangFull();
  const installMsg = (zh, en) => installLang === "zh" ? zh : en;

  try {
    const targets = [];
    if (opts.user !== false) {
      targets.push(path.join(os.homedir(), ".qwen", "settings.json"));
    }
    if (opts.project) {
      targets.push(path.join(process.cwd(), ".qwen", "settings.json"));
    }
    if (targets.length === 0 && !quiet) {
      console.error(installMsg("未指定目标 - 请使用 --user 或 --project。", "No target specified - use --user or --project."));
      process.exit(1);
    }

    for (const settingsPath of targets) {
      installIntoSettings(settingsPath);
      log(installMsg(`✅ Hook 已安装到 ${settingsPath}`, `✅ Hooks installed in ${settingsPath}`));
    }

    const interceptPath = installIntercept();

    const setupAliasScript = path.join(__dirname, "..", "scripts", "setup-alias.sh");
    if (fs.existsSync(setupAliasScript)) {
      try {
        const { execSync } = require("child_process");
        execSync(`bash "${setupAliasScript}"`, { stdio: quiet ? "ignore" : "inherit" });
      } catch (err) {
        if (!quiet) {
          console.error(installMsg(
            `⚠️  alias 设置失败（非致命）: ${err.message}`,
            `⚠️  alias setup failed (non-fatal): ${err.message}`
          ));
        }
      }
    }

    log(
      installMsg(
        "\n请配置遥测后端：\n" +
        "  export OTEL_EXPORTER_OTLP_ENDPOINT='https://xxx:4318'\n" +
        "  export OTEL_RESOURCE_ATTRIBUTES='service.name=qwen-agents'\n",
        "\nRemember to configure your telemetry backend:\n" +
        "  export OTEL_EXPORTER_OTLP_ENDPOINT='https://xxx:4318'\n" +
        "  export OTEL_RESOURCE_ATTRIBUTES='service.name=qwen-agents'\n"
      )
    );
    if (interceptPath) {
      log(
        installMsg(
          "启用 LLM 输入输出追踪，请使用以下方式启动 Qwen Code：\n" +
          `  NODE_OPTIONS="--require ${interceptPath}" qwen\n`,
          "To enable LLM call tracing, launch Qwen Code with:\n" +
          `  NODE_OPTIONS="--require ${interceptPath}" qwen\n`
        )
      );
    }
  } catch (err) {
    if (quiet) {
      console.error(`[otel-qwen-hook] install warning: ${err.message}`);
    } else {
      throw err;
    }
  }
}

function cmdUninstall(opts = {}) {
  if (opts.user !== false) {
    const userSettings = path.join(os.homedir(), ".qwen", "settings.json");
    removeHooksFromSettings(userSettings);
    console.error(`✅ Hooks removed from ${userSettings}`);
  }
  if (opts.project) {
    const projectSettings = path.join(process.cwd(), ".qwen", "settings.json");
    removeHooksFromSettings(projectSettings);
    console.error(`✅ Hooks removed from ${projectSettings}`);
  }

  // Remove shell aliases
  const rcFiles = [
    path.join(os.homedir(), ".bashrc"),
    path.join(os.homedir(), ".zshrc"),
    path.join(os.homedir(), ".bash_profile"),
  ];
  for (const rc of rcFiles) {
    removeAliasFromFile(rc);
  }

  // Remove intercept.js
  const interceptDest = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.qwen", "intercept.js");
  if (fs.existsSync(interceptDest)) {
    try { fs.unlinkSync(interceptDest); } catch {}
    console.error(`✅ intercept.js removed from ${interceptDest}`);
  }

  if (opts.purge) {
    const cacheDir = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.qwen");
    if (fs.existsSync(cacheDir)) {
      try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
      console.error(`✅ Cache directory purged: ${cacheDir}`);
    }
  }
}

function cmdShowConfig() {
  const config = { hooks: buildHookConfig(getHookCmd()) };
  console.log(JSON.stringify(config, null, 2));
}

function cmdCheckEnv() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const debugMode = process.env.QWEN_TELEMETRY_DEBUG;

  if (!endpoint && !debugMode) {
    console.error("❌ No telemetry backend configured.");
    console.error("   Set OTEL_EXPORTER_OTLP_ENDPOINT or QWEN_TELEMETRY_DEBUG=1");
    process.exit(1);
  }

  if (endpoint) {
    console.error(`✅ OTLP endpoint: ${endpoint}`);
  }
  if (debugMode) {
    console.error("✅ Debug mode enabled (console output)");
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || "";
  if (serviceName) {
    console.error(`✅ Service name: ${serviceName}`);
  }
}

// ---------------------------------------------------------------------------
// Exports (public API + test-only internals prefixed with _)
// ---------------------------------------------------------------------------
module.exports = {
  // Public
  cmdUserPromptSubmit,
  cmdPreToolUse,
  cmdPostToolUse,
  cmdPostToolUseFailure,
  cmdPreCompact,
  cmdPostCompact,
  cmdSubagentStart,
  cmdSubagentStop,
  cmdNotification,
  cmdSessionStart,
  cmdSessionEnd,
  cmdStop,
  cmdInstall,
  cmdUninstall,
  cmdShowConfig,
  cmdCheckEnv,

  // Test-only (exposed for unit tests)
  _buildHookConfig: buildHookConfig,
  _hrTime: hrTime,
  _tsNs: tsNs,
  _readProxyEvents: readProxyEvents,
  _resolveQwenPid: resolveQwenPid,
  _replayEventsAsSpans: replayEventsAsSpans,
  _exportSessionTrace: exportSessionTrace,
  _installIntoSettings: installIntoSettings,
  _installIntercept: installIntercept,
  _removeAliasFromFile: removeAliasFromFile,
  _removeHooksFromSettings: removeHooksFromSettings,
  _reconstructStateFromEvents: reconstructStateFromEvents,
  _extractOutputAndTokensFromEvents: extractOutputAndTokensFromEvents,
  _transformToArmsInputMessages: transformToArmsInputMessages,
  _transformToArmsOutputMessages: transformToArmsOutputMessages,
  _transformToArmsSystemInstructions: transformToArmsSystemInstructions,
  _mapStopReasonToFinishReason: mapStopReasonToFinishReason,
  _buildSubagentInfo: buildSubagentInfo,
  _matchSubagentsToTools: matchSubagentsToTools,

  // WithEvent variants for testing without stdin
  _cmdUserPromptSubmitWithEvent: cmdUserPromptSubmitWithEvent,
  _cmdSessionStartWithEvent: cmdSessionStartWithEvent,
  _cmdPreToolUseWithEvent: cmdPreToolUseWithEvent,
  _cmdPostToolUseWithEvent: cmdPostToolUseWithEvent,
  _cmdPostToolUseFailureWithEvent: cmdPostToolUseFailureWithEvent,
  _cmdPreCompactWithEvent: cmdPreCompactWithEvent,
  _cmdPostCompactWithEvent: cmdPostCompactWithEvent,
  _cmdSubagentStartWithEvent: cmdSubagentStartWithEvent,
  _cmdSubagentStopWithEvent: cmdSubagentStopWithEvent,
  _cmdSessionEndWithEvent: cmdSessionEndWithEvent,
  _cmdNotificationWithEvent: cmdNotificationWithEvent,
};
