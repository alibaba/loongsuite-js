// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * cli.js — Hook CLI commands (commander-based).
 * Full port of Python's settings_hooks.py, including _replay_events_as_spans.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { trace, context } = require("@opentelemetry/api");
const { loadState, saveState, clearState, readAndDeleteChildState, STATE_DIR } = require("./state");
const { configureTelemetry, shutdownTelemetry } = require("./telemetry");
const { createToolTitle, createEventData, addResponseToEventData, extractToolResult, extractToolError, MAX_CONTENT_LENGTH } = require("./hooks");
const {
  ExtendedTelemetryHandler,
  createEntryInvocation, createInvokeAgentInvocation,
  createReactStepInvocation, createExecuteToolInvocation, createLLMInvocation,
} = require("@loongsuite/opentelemetry-util-genai");
const {
  convertSystemPrompt, convertInputMessages, convertOutputMessages,
  extractRequestParams, convertToolDefinitions,
} = require("./message-converter");
const {
  isLogEnabled, writeLogRecords, computeHash, INITIAL_HASH,
  shouldLogFullMessages,
} = require("./logger");
const config = require("./config");

// ---------------------------------------------------------------------------
// Semantic convention dialect
// LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP → gen_ai.span_kind_name
// default (ALIBABA_CLOUD or unset)             → gen_ai.span.kind
// Auto-detect: endpoint containing "sunfire" implies ALIBABA_GROUP
// ---------------------------------------------------------------------------
const _dialect = config.getSemconvDialect();
const _endpoint = config.getEndpoint();
const _sunfireDetected = _endpoint.includes("sunfire");
const SPAN_KIND_ATTR =
  _dialect === "ALIBABA_GROUP" || _sunfireDetected
    ? "gen_ai.span_kind_name"
    : "gen_ai.span.kind";
const NEEDS_DIALECT_ATTR = _dialect === "ALIBABA_GROUP" || _sunfireDetected;

function generateTraceId() {
  return crypto.randomBytes(16).toString("hex");
}
function generateSpanId() {
  return crypto.randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// 语言检测 / Language detection
// ---------------------------------------------------------------------------

/**
 * Lightweight detection using only environment variables.
 * Called at module load for every hook subprocess — must not spawn processes.
 */
function detectLang() {
  const vars = [
    process.env.OTEL_CLAUDE_LANG,
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

/**
 * Full detection for install-time commands (cmdInstall).
 * Runs only once during installation; subprocess latency is acceptable.
 * Falls back to detectLang() if system commands are unavailable.
 */
function detectLangFull() {
  const fast = detectLang();
  if (fast === "zh") return "zh";
  // macOS: check system language preference
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("child_process");
      const langs = execSync("defaults read -g AppleLanguages 2>/dev/null", { encoding: "utf-8", timeout: 2000 });
      if (/zh/i.test(langs)) return "zh";
      const locale = execSync("defaults read -g AppleLocale 2>/dev/null", { encoding: "utf-8", timeout: 2000 }).trim();
      if (/zh/i.test(locale)) return "zh";
    } catch {}
  }
  // Windows: check registry locale
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

/** Lightweight debug helper — only logs when OTEL_CLAUDE_DEBUG=1 */
function debug(msg) {
  if (process.env.OTEL_CLAUDE_DEBUG) console.error("[otel-claude-hook]", msg);
}

function msg(zh, en) {
  return LANG_MODE === "zh" ? zh : en;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOOK_CMD_ENV_VAR = "OTEL_CLAUDE_HOOK_CMD";
const HOOK_CMD_DEFAULT = "otel-claude-hook";

function getHookCmd() {
  return process.env[HOOK_CMD_ENV_VAR] || HOOK_CMD_DEFAULT;
}

function packageBinPath() {
  return path.resolve(__dirname, "..", "bin", "otel-claude-hook");
}

function hookEntryCacheDir() {
  return path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.claude");
}

function generateHookEntry() {
  const binPath = packageBinPath();
  const cacheDir = hookEntryCacheDir();
  const entryPath = path.join(cacheDir, "hook-entry.sh");
  fs.mkdirSync(cacheDir, { recursive: true });

  const script = [
    "#!/usr/bin/env bash",
    "# Auto-generated by otel-claude-hook install",
    "set -euo pipefail",
    "",
    'NODE_BIN=""',
    "if command -v node >/dev/null 2>&1; then",
    '  NODE_BIN="node"',
    "else",
    "  for candidate in \\",
    '    "$HOME/.nvm/versions/node"/*/bin/node \\',
    "    /usr/local/bin/node \\",
    "    /opt/homebrew/bin/node \\",
    '    "$HOME/.local/bin/node" \\',
    '    "$HOME/.volta/bin/node" \\',
    '    "$HOME/.fnm/aliases/default/bin/node"; do',
    '    if [[ -x "$candidate" ]]; then',
    '      NODE_BIN="$candidate"',
    "      break",
    "    fi",
    "  done",
    "fi",
    "",
    'if [[ -z "$NODE_BIN" ]]; then',
    '  echo "[otel-claude-hook] node runtime not found" >&2',
    "  exit 0",
    "fi",
    "",
    "# Prevent legacy NODE_OPTIONS --require intercept.js from breaking hook subprocesses",
    "unset NODE_OPTIONS 2>/dev/null || true",
    "",
    "# Resolve bin path: prefer relative (portable), fall back to install-time absolute",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'BIN_PATH="$SCRIPT_DIR/package/bin/otel-claude-hook"',
    `if [[ ! -f "$BIN_PATH" ]]; then BIN_PATH=${JSON.stringify(binPath)}; fi`,
    'if [[ ! -f "$BIN_PATH" ]]; then',
    '  echo "[otel-claude-hook] bin not found — please reinstall: curl -fsSL <install-url> | bash" >&2',
    '  exit 0',
    'fi',
    "",
    'exec "$NODE_BIN" "$BIN_PATH" "$@"',
    "",
  ].join("\n");

  fs.writeFileSync(entryPath, script, { mode: 0o755 });
  return entryPath;
}

function isOtelHookCommand(cmd) {
  return cmd.includes("otel-claude-hook") || cmd.includes("hook-entry.sh");
}

function buildHookConfig(entryPath) {
  const subcommands = [
    ["UserPromptSubmit", "user-prompt-submit"],
    ["PreToolUse", "pre-tool-use"],
    ["PostToolUse", "post-tool-use"],
    ["Stop", "stop"],
    ["PreCompact", "pre-compact"],
    ["SubagentStart", "subagent-start"],
    ["SubagentStop", "subagent-stop"],
    ["Notification", "notification"],
  ];
  const config = {};
  for (const [event, sub] of subcommands) {
    config[event] = [{ matcher: "*", hooks: [{ type: "command", command: `bash ${entryPath} ${sub}` }] }];
  }
  return config;
}

// ---------------------------------------------------------------------------
// Proxy event reading (intercept.js JSONL logs)
// ---------------------------------------------------------------------------

const PROXY_EVENTS_DIR = STATE_DIR;

/**
 * Resolve the PID of the claude process that launched this hook subprocess.
 *
 * Hook invocation chain (Claude Code uses shell=true):
 *   claude (PID=X)  →  sh (PID=Y)  →  otel-claude-hook (PID=Z)
 *
 * Inside otel-claude-hook: process.ppid = Y (shell), not X (claude).
 * intercept.js runs inside claude, so its process.pid = X.
 * We need X to locate the correct proxy_events_<X>.jsonl file.
 *
 * Strategy:
 *   1. Linux  — read /proc/<shellPid>/status for grandparent PID
 *   2. macOS  — run `ps -o ppid= -p <shellPid>` for grandparent PID
 *   3. Fallback — try process.ppid directly (works if Claude Code uses shell=false)
 *
 * If the resolved file doesn't exist on disk, we fall back to process.ppid
 * (handles the rare shell=false case) or return null (no targeted lookup).
 *
 * @returns {number|null}
 */
function resolveClaudePid() {
  const shellPid = process.ppid;
  if (!shellPid) return null;

  const candidates = [];

  // Windows: process tree walking is not supported.
  // Return null so readProxyEvents() falls back to time-window scan (without
  // deleting files, to avoid cross-session data loss).
  if (process.platform === "win32") {
    debug("resolveClaudePid: Windows not supported, returning null (time-window fallback)");
    return null;
  }

  // Strategy 1 & 2: walk up one level in the process tree to find the
  // grandparent PID (the actual claude process, not the intermediate shell).
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
    debug(`resolveClaudePid: process tree walk failed (${err.message}), falling back to direct ppid`);
  }

  // Strategy 3: direct ppid — handles the rare case where Claude Code
  // invokes hooks without an intermediate shell (shell=false).
  if (shellPid > 1) candidates.push(shellPid);

  // Return the first candidate whose proxy_events file actually exists on disk
  for (const pid of candidates) {
    const candidate = path.join(PROXY_EVENTS_DIR, `proxy_events_${pid}.jsonl`);
    if (fs.existsSync(candidate)) return pid;
  }

  // No matching file — the claude process is likely dead (Stop hook runs
  // after exit).  Return null so readProxyEvents() falls back to scanning
  // ALL proxy files and filtering by the session time window.
  debug("resolveClaudePid: no proxy file matched candidates, returning null (time-window fallback)");
  return null;
}

function readProxyEvents(startTime, stopTime, deleteAfterRead = false, pid = null) {
  if (!fs.existsSync(PROXY_EVENTS_DIR)) return [];

  const bufferedStart = startTime - 5.0;
  const bufferedStop = stopTime + 5.0;
  const events = [];

  // If pid is specified, only read that pid's file (safe for concurrent sessions).
  // If pid is null (claude process already dead), fall back to time-window scan
  // across ALL files — do NOT delete to avoid data loss for concurrent sessions.
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
// OTel helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Unix timestamp (seconds, float) to OTel HrTime [seconds, nanos].
 * OTel Node.js SDK treats plain numbers as milliseconds, so we must use
 * the [seconds, nanos] tuple format to avoid 1e6x precision loss.
 */
function hrTime(timestampSec) {
  const sec = Math.floor(timestampSec);
  const nanos = Math.round((timestampSec - sec) * 1e9);
  return [sec, nanos];
}

/** Convert a Unix timestamp (seconds, float) to integer nanoseconds. */
function tsNs(sec) {
  return Math.round(sec * 1e9);
}

// ---------------------------------------------------------------------------
// _replayEventsAsSpans — replay recorded events into OTel spans using
// the @loongsuite/opentelemetry-util-genai SDK for standardized span creation.
// Conforms to ARMS semantic conventions: ENTRY → AGENT → STEP → TOOL/LLM
// ---------------------------------------------------------------------------

function dialectAttrs(spanKindValue) {
  return NEEDS_DIALECT_ATTR ? { "gen_ai.span_kind_name": spanKindValue } : {};
}

function sessionAttrs(sessionId, spanKindValue) {
  return {
    ...dialectAttrs(spanKindValue),
    "gen_ai.session.id": sessionId,
  };
}

function splitEventsByTurn(events) {
  const turns = [];
  let current = null;

  for (const ev of events) {
    if (ev.type === "user_prompt_submit") {
      if (current) {
        current.endTime = ev.timestamp || current.startTime;
      }
      current = {
        prompt: ev.prompt || "",
        startTime: ev.timestamp || Date.now() / 1000,
        endTime: null,
        events: [],
      };
      turns.push(current);
    } else if (current) {
      current.events.push(ev);
    }
  }

  return turns;
}

function enrichChildStateWithTranscript(childState) {
  if (!childState || childState._transcript_enriched) return;
  childState._transcript_enriched = true;

  if (!childState.transcript_path || !Array.isArray(childState.events)) return;

  try {
    const { parseClaudeTranscript, alignWithHookEvents } = require("./transcript");
    const startTime = childState.start_time || 0;
    const stopTime = childState.stop_time || Date.now() / 1000;
    const llmEvents = parseClaudeTranscript(childState.transcript_path, startTime, stopTime);
    if (llmEvents.length > 0) {
      alignWithHookEvents(llmEvents, childState.events, stopTime);
      const validLlmEvents = llmEvents.filter(e => !e._discarded);
      if (validLlmEvents.length > 0) {
        const getSortKey = (e) => {
          if (e.type === "llm_call" && e.request_start_time) return e.request_start_time;
          return e.timestamp || 0;
        };
        childState.events = [...childState.events, ...validLlmEvents].sort(
          (a, b) => getSortKey(a) - getSortKey(b)
        );
      }
    }
  } catch (err) {
    debug(`subagent transcript parse failed: ${err?.message || String(err)}`);
  }
}

function replayEventsAsSpans(handler, tracer, events, parentCtx, stopTime, sessionId) {
  const subagentSpanStack = [];
  const openAgentToolInvs = [];
  const openSubagentsByAgentId = {};
  let currentStepInv = null;
  let stepRound = 0;
  let prevStepEndTime = stopTime;

  const sAttrs = (kind) => sessionId ? sessionAttrs(sessionId, kind) : dialectAttrs(kind);

  function resolveParentContext(eventTs, endTs) {
    if (eventTs !== undefined) {
      const active = [];
      for (const [agentId, win] of Object.entries(subagentWindowMap)) {
        const startInWindow = eventTs >= win.startTs && eventTs <= win.stopTs;
        const endInWindow = endTs === undefined || (endTs >= win.startTs && endTs <= win.stopTs);
        if (startInWindow && endInWindow) {
          const entry = openSubagentCtxByAgentId[agentId];
          if (entry) active.push({ startTs: win.startTs, stopTs: win.stopTs, ctx: entry.ctx });
        }
      }
      if (active.length === 1) return active[0].ctx;
      if (active.length > 1) {
        const midPoint = endTs !== undefined ? (eventTs + endTs) / 2 : eventTs;
        active.sort((a, b) => {
          const centerA = (a.startTs + a.stopTs) / 2;
          const centerB = (b.startTs + b.stopTs) / 2;
          return Math.abs(centerA - midPoint) - Math.abs(centerB - midPoint);
        });
        return active[0].ctx;
      }
    }
    if (currentStepInv && currentStepInv.contextToken) return currentStepInv.contextToken;
    return parentCtx;
  }

  // Pre-scan 1: build preToolUseMap and compute orphan end times
  const preToolUseMap = {};
  const consumedToolUseIds = new Set();
  const orphanContextMap = {};
  const orphanEndTimeMap = {};
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "pre_tool_use" && ev.tool_use_id) {
      preToolUseMap[ev.tool_use_id] = ev;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].timestamp) {
          orphanEndTimeMap[ev.tool_use_id] = events[j].timestamp;
          break;
        }
      }
    }
  }

  // Pre-scan 2: compute subagent time windows
  const subagentWindowMap = {};
  {
    const pendingStarts = [];
    for (const ev of events) {
      if (ev.type === "subagent_start" && ev.agent_id) {
        pendingStarts.push({ agentId: ev.agent_id, startTs: ev.timestamp || 0 });
      } else if (ev.type === "subagent_stop" && pendingStarts.length > 0) {
        const entry = pendingStarts.shift();
        subagentWindowMap[entry.agentId] = { startTs: entry.startTs, stopTs: ev.timestamp || stopTime };
      }
    }
    for (const entry of pendingStarts) {
      subagentWindowMap[entry.agentId] = { startTs: entry.startTs, stopTs: stopTime };
    }
  }

  const openSubagentCtxByAgentId = {};

  for (const ev of events) {
    const evType = ev.type || "";
    const evTs = ev.timestamp || stopTime;

    if (evType === "llm_call") {
      // STEP = one LLM reasoning cycle + resulting tool calls
      // Close previous STEP before starting a new one
      if (currentStepInv) {
        handler.stopReactStep(currentStepInv, hrTime(prevStepEndTime));
        currentStepInv = null;
      }

      const model = ev.model || "unknown";
      const requestStart = ev.request_start_time || evTs;
      const protocol = ev.protocol || "anthropic";

      stepRound++;
      currentStepInv = createReactStepInvocation({
        round: stepRound,
        attributes: sAttrs("STEP"),
      });
      handler.startReactStep(currentStepInv, parentCtx, hrTime(requestStart));

      const reqParams = extractRequestParams(ev.request_body);
      const llmInv = createLLMInvocation({
        operationName: "chat",
        requestModel: model,
        responseModelName: model,
        provider: "anthropic",
        responseId: ev.response_id || null,
        inputTokens: (ev.input_tokens || 0) + (ev.cache_read_input_tokens || 0) + (ev.cache_creation_input_tokens || 0),
        outputTokens: ev.output_tokens || 0,
        usageCacheReadInputTokens: ev.cache_read_input_tokens || 0,
        usageCacheCreationInputTokens: ev.cache_creation_input_tokens || 0,
        finishReasons: ev.stop_reason ? [ev.stop_reason] : null,
        inputMessages: convertInputMessages(ev.input_messages, protocol),
        outputMessages: convertOutputMessages(ev.output_content, ev.stop_reason),
        systemInstruction: convertSystemPrompt(ev.system_prompt, protocol),
        ...reqParams,
        attributes: sAttrs("LLM"),
      });

      if (ev.request_body && ev.request_body.tools) {
        llmInv.toolDefinitions = convertToolDefinitions(ev.request_body.tools);
      }

      handler.startLlm(llmInv, currentStepInv.contextToken, hrTime(requestStart));
      ev._otel_span_id = llmInv.span?.spanContext().spanId || null;
      ev._otel_step_span_id = currentStepInv?.span?.spanContext().spanId || null;

      if (ev.is_error) {
        handler.failLlm(llmInv, {
          message: ev.error_message || "unknown error",
          type: "LLMError",
        }, hrTime(evTs));
      } else {
        handler.stopLlm(llmInv, hrTime(evTs));
      }
      prevStepEndTime = evTs;

    } else if (evType === "pre_tool_use") {
      const toolName = ev.tool_name || "unknown";
      const toolInput = ev.tool_input || {};
      const toolUseId = ev.tool_use_id || "";

      if (toolUseId && toolName !== "Agent" && toolName !== "agent") {
        orphanContextMap[toolUseId] = currentStepInv?.contextToken || parentCtx;
      }

      if (toolName === "Agent" || toolName === "agent") {
        const toolInv = createExecuteToolInvocation(toolName, {
          toolCallId: toolUseId,
          toolCallArguments: toolInput,
          attributes: sAttrs("TOOL"),
        });
        handler.startExecuteTool(toolInv, resolveParentContext(evTs), hrTime(evTs));
        openAgentToolInvs.push({
          inv: toolInv,
          toolUseId,
          subagentType: toolInput.subagent_type || "",
          matched: false,
        });
      }

    } else if (evType === "post_tool_use") {
      const toolUseId = ev.tool_use_id || "";
      if (toolUseId) consumedToolUseIds.add(toolUseId);
      const toolName = ev.tool_name || "unknown";
      const toolResponse = ev.tool_response;
      const postAgentId = (toolResponse && (toolResponse.agentId || toolResponse.agent_id)) || "";

      if (toolName === "Agent" || toolName === "agent") {
        const preIdx = openAgentToolInvs.findIndex(e => e.toolUseId === toolUseId);
        if (preIdx !== -1) {
          const { inv: toolInv } = openAgentToolInvs.splice(preIdx, 1)[0];
          toolInv.toolCallResult = extractToolResult(toolResponse);
          if (postAgentId && openSubagentsByAgentId[postAgentId]) {
            const subEntry = openSubagentsByAgentId[postAgentId];
            if (subEntry.childState && Array.isArray(subEntry.childState.events) && subEntry.childState.events.length > 0) {
              replayEventsAsSpans(handler, tracer, subEntry.childState.events,
                subEntry.agentInv.contextToken, subEntry.childState.stop_time || evTs, sessionId);
            }
            handler.stopInvokeAgent(subEntry.agentInv, hrTime(subEntry.stopTs || evTs));
            delete openSubagentsByAgentId[postAgentId];
            delete openSubagentCtxByAgentId[postAgentId];
            const idx = subagentSpanStack.findIndex(e => e.agentId === postAgentId);
            if (idx !== -1) subagentSpanStack.splice(idx, 1);
          }
          const toolErr = extractToolError(toolResponse);
          if (toolErr) handler.failExecuteTool(toolInv, toolErr, hrTime(evTs));
          else handler.stopExecuteTool(toolInv, hrTime(evTs));
        } else {
          const subEntry = postAgentId ? openSubagentsByAgentId[postAgentId] : null;
          if (subEntry && subEntry.agentInv) {
            if (subEntry.childState && Array.isArray(subEntry.childState.events) && subEntry.childState.events.length > 0) {
              replayEventsAsSpans(handler, tracer, subEntry.childState.events,
                subEntry.agentInv.contextToken, subEntry.childState.stop_time || evTs, sessionId);
            }
            handler.stopInvokeAgent(subEntry.agentInv, hrTime(subEntry.stopTs || evTs));
            if (subEntry.syntheticToolInv) {
              handler.stopExecuteTool(subEntry.syntheticToolInv, hrTime(evTs));
            }
            delete openSubagentsByAgentId[postAgentId];
            delete openSubagentCtxByAgentId[postAgentId];
            const idx = subagentSpanStack.findIndex(e => e.agentId === postAgentId);
            if (idx !== -1) subagentSpanStack.splice(idx, 1);
          }
        }
      } else {
        // Regular tool: create combined span from pre+post
        const preEv = preToolUseMap[toolUseId] || {};
        const effectiveName = preEv.tool_name || toolName;
        const effectiveInput = preEv.tool_input || {};
        const startTs = preEv.timestamp || evTs;

        const toolInv = createExecuteToolInvocation(effectiveName, {
          toolCallId: toolUseId,
          toolCallArguments: effectiveInput,
          toolCallResult: extractToolResult(toolResponse),
          attributes: sAttrs("TOOL"),
        });
        handler.startExecuteTool(toolInv, resolveParentContext(evTs), hrTime(startTs));
        ev._otel_span_id = toolInv.span?.spanContext().spanId || null;
        ev._otel_step_span_id = currentStepInv?.span?.spanContext().spanId || null;
        const toolErr = extractToolError(toolResponse);
        if (toolErr) handler.failExecuteTool(toolInv, toolErr, hrTime(evTs));
        else handler.stopExecuteTool(toolInv, hrTime(evTs));
      }
      prevStepEndTime = evTs;

    } else if (evType === "pre_compact") {
      const span = tracer.startSpan("compact", {
        startTime: hrTime(evTs),
        attributes: {
          "gen_ai.operation.name": "compact",
          [SPAN_KIND_ATTR]: "TASK",
          ...(sessionId ? { "gen_ai.session.id": sessionId } : {}),
          "compact.trigger": ev.trigger || "unknown",
          "compact.has_custom_instructions": !!ev.has_custom_instructions,
        },
      }, parentCtx);
      span.end(hrTime(evTs));

    } else if (evType === "notification") {
      const msg = ev.message || "";
      const span = tracer.startSpan(
        msg ? `notification ${msg.slice(0, 60)}` : "notification",
        {
          startTime: hrTime(evTs),
          attributes: {
            "gen_ai.operation.name": "notification",
            [SPAN_KIND_ATTR]: "TASK",
            ...(sessionId ? { "gen_ai.session.id": sessionId } : {}),
            "notification.message": msg,
            "notification.level": ev.level || "info",
            "notification.title": ev.title || "",
          },
        },
        parentCtx
      );
      span.end(hrTime(evTs));

    } else if (evType === "subagent_start") {
      const agentId = ev.agent_id || "";
      const agentName = ev.agent_type || "";

      let agentParentCtx = currentStepInv?.contextToken || parentCtx;
      let syntheticToolInv = null;
      const matchedPreIdx = openAgentToolInvs.findIndex(e =>
        !e.matched && (!e.subagentType || e.subagentType === agentName)
      );
      if (matchedPreIdx !== -1) {
        openAgentToolInvs[matchedPreIdx].matched = true;
        agentParentCtx = openAgentToolInvs[matchedPreIdx].inv.contextToken;
      } else {
        syntheticToolInv = createExecuteToolInvocation("Agent", {
          toolCallArguments: { subagent_type: agentName },
          attributes: { ...sAttrs("TOOL"), "gen_ai.agent.name": agentName },
        });
        handler.startExecuteTool(syntheticToolInv, currentStepInv?.contextToken || parentCtx, hrTime(evTs));
        agentParentCtx = syntheticToolInv.contextToken;
      }

      const subAgentInv = createInvokeAgentInvocation("anthropic", {
        agentName,
        agentId,
        attributes: {
          ...sAttrs("AGENT"),
          "subagent.session_id": ev.subagent_session_id || "",
        },
      });
      handler.startInvokeAgent(subAgentInv, agentParentCtx, hrTime(evTs));
      openSubagentCtxByAgentId[agentId] = { inv: subAgentInv, ctx: subAgentInv.contextToken };
      openSubagentsByAgentId[agentId] = {
        agentId,
        agentName,
        startTs: evTs,
        stopTs: undefined,
        childState: null,
        agentInv: subAgentInv,
        syntheticToolInv,
      };
      subagentSpanStack.push({ agentId, startTs: evTs });

    } else if (evType === "subagent_stop") {
      const childState = ev._child_state;
      if (subagentSpanStack.length > 0) {
        const { agentId } = subagentSpanStack.shift();
        if (agentId && openSubagentsByAgentId[agentId]) {
          const entry = openSubagentsByAgentId[agentId];
          entry.stopTs = evTs;
          entry.agentInv.inputTokens = (ev.input_tokens || 0) + (ev.cache_read_input_tokens || 0) + (ev.cache_creation_input_tokens || 0);
          entry.agentInv.outputTokens = ev.output_tokens || 0;
          entry.agentInv.usageCacheReadInputTokens = ev.cache_read_input_tokens || 0;
          entry.agentInv.usageCacheCreationInputTokens = ev.cache_creation_input_tokens || 0;
          entry.agentInv.finishReasons = [ev.stop_reason || "end_turn"];
          if (childState) {
            enrichChildStateWithTranscript(childState);
            entry.childState = childState;
            if (childState.model) entry.agentInv.requestModel = childState.model;
          }
        }
      }
      // Fallback: orphan subagent_stop with child_state
      if (childState && !childState._transcript_enriched) {
        enrichChildStateWithTranscript(childState);
      }
      if (subagentSpanStack.length === 0 && !Object.keys(openSubagentsByAgentId).length &&
          childState && Array.isArray(childState.events) && childState.events.length > 0) {
        const childStart = childState.start_time || evTs;
        const childStop = childState.stop_time || evTs;
        const childMetrics = childState.metrics || {};
        const containerInv = createInvokeAgentInvocation("anthropic", {
          agentName: "subagent",
          inputTokens: (childMetrics.input_tokens || ev.input_tokens || 0)
            + (childMetrics.cache_read_input_tokens || ev.cache_read_input_tokens || 0)
            + (childMetrics.cache_creation_input_tokens || ev.cache_creation_input_tokens || 0),
          outputTokens: childMetrics.output_tokens || ev.output_tokens || 0,
          usageCacheReadInputTokens: childMetrics.cache_read_input_tokens || ev.cache_read_input_tokens || 0,
          usageCacheCreationInputTokens: childMetrics.cache_creation_input_tokens || ev.cache_creation_input_tokens || 0,
          finishReasons: [ev.stop_reason || "end_turn"],
          requestModel: childState.model || "unknown",
          attributes: {
            ...sAttrs("AGENT"),
            "subagent.session_id": ev.subagent_session_id || "unknown",
          },
        });
        handler.startInvokeAgent(containerInv, resolveParentContext(evTs), hrTime(childStart));
        replayEventsAsSpans(handler, tracer, childState.events, containerInv.contextToken, childStop, sessionId);
        handler.stopInvokeAgent(containerInv, hrTime(childStop));
      }
    }
  }

  // Close any subagents that never got a post_tool_use
  for (const [agentId, subEntry] of Object.entries(openSubagentsByAgentId)) {
    if (subEntry.childState && Array.isArray(subEntry.childState.events) && subEntry.childState.events.length > 0) {
      replayEventsAsSpans(handler, tracer, subEntry.childState.events,
        subEntry.agentInv.contextToken, subEntry.childState.stop_time || stopTime, sessionId);
    }
    const inv = subEntry.agentInv;
    if (!inv.inputTokens && !inv.outputTokens) {
      const childStart = subEntry.startTs;
      const childStop = subEntry.stopTs || stopTime;
      for (const ce of events) {
        if (ce.type !== "llm_call") continue;
        const ceTs = ce.timestamp || 0;
        if (ceTs >= childStart && ceTs <= childStop) {
          inv.inputTokens = (inv.inputTokens || 0) + (ce.input_tokens || 0) + (ce.cache_read_input_tokens || 0) + (ce.cache_creation_input_tokens || 0);
          inv.outputTokens = (inv.outputTokens || 0) + (ce.output_tokens || 0);
          inv.usageCacheReadInputTokens = (inv.usageCacheReadInputTokens || 0) + (ce.cache_read_input_tokens || 0);
          inv.usageCacheCreationInputTokens = (inv.usageCacheCreationInputTokens || 0) + (ce.cache_creation_input_tokens || 0);
          if (!inv.requestModel && ce.model) inv.requestModel = ce.model;
        }
      }
    }
    handler.stopInvokeAgent(subEntry.agentInv, hrTime(subEntry.stopTs || stopTime));
    if (subEntry.syntheticToolInv) {
      handler.stopExecuteTool(subEntry.syntheticToolInv, hrTime(subEntry.stopTs || stopTime));
    }
  }
  // Close unclosed Agent tool invocations
  for (const { inv } of openAgentToolInvs) {
    handler.stopExecuteTool(inv, hrTime(stopTime));
  }

  // Recover orphaned pre_tool_use events (Claude Code drops ~30% of PostToolUse hooks)
  for (const [toolUseId, preEv] of Object.entries(preToolUseMap)) {
    if (consumedToolUseIds.has(toolUseId)) continue;
    const toolName = preEv.tool_name || "unknown";
    if (toolName === "Agent" || toolName === "agent") continue;
    const toolInput = preEv.tool_input || {};
    const startTs = preEv.timestamp || stopTime;
    const toolInv = createExecuteToolInvocation(toolName, {
      toolCallId: toolUseId,
      toolCallArguments: toolInput,
      attributes: { ...sAttrs("TOOL"), "tool.orphaned": true },
    });
    const orphanParent = orphanContextMap[toolUseId] || currentStepInv?.contextToken || parentCtx;
    const endTs = orphanEndTimeMap[toolUseId] || stopTime;
    handler.startExecuteTool(toolInv, orphanParent, hrTime(startTs));
    preEv._otel_span_id = toolInv.span?.spanContext().spanId || null;
    preEv._otel_step_span_id = currentStepInv?.span?.spanContext().spanId || null;
    handler.stopExecuteTool(toolInv, hrTime(endTs));
  }

  if (currentStepInv) {
    handler.stopReactStep(currentStepInv, hrTime(stopTime));
  }
}

// ---------------------------------------------------------------------------
// generateTurnLogRecords — JSONL log records for a single turn
// ---------------------------------------------------------------------------

function generateTurnLogRecords(turn, turnIndex, sessionId, model, prevHash, spanCtx) {
  if (!spanCtx || typeof spanCtx === "string") {
    spanCtx = { traceId: spanCtx || generateTraceId(), entrySpanId: generateSpanId(), agentSpanId: generateSpanId() };
  }
  const records = [];
  const turnId = `${sessionId}:t${turnIndex + 1}`;
  let stepRound = 0;
  let currentStepId = null;
  let currentStepSpanId = null;
  let runningHash = prevHash;
  let prevInputMsgs = [];

  let userId;
  try { userId = os.userInfo().username; } catch { userId = ""; }

  const base = {
    trace_id: spanCtx.traceId || null,
    "session.id": sessionId,
    "turn.id": turnId,
    "user.id": userId,
    "agent.type": "claude-code",
  };

  if (turn.prompt) {
    records.push({
      time_unix_nano: Math.round(turn.startTime * 1e9),
      "event.id": crypto.randomUUID(),
      "event.name": "llm.request",
      ...base,
      span_id: spanCtx.agentSpanId || null,
      parent_span_id: spanCtx.entrySpanId || null,
      "message.role": "user",
      "input.messages_delta": JSON.stringify(
        [{ role: "user", parts: [{ type: "text", content: turn.prompt }] }]
      ),
    });
  }

  const preToolUseMap = {};
  for (const ev of turn.events) {
    if (ev.type === "pre_tool_use" && ev.tool_use_id) {
      preToolUseMap[ev.tool_use_id] = ev;
    }
  }

  for (const ev of turn.events) {
    const evTs = ev.timestamp || turn.endTime;

    if (ev.type === "llm_call") {
      stepRound++;
      currentStepId = `${turnId}:s${stepRound}`;
      currentStepSpanId = ev._otel_step_span_id || generateSpanId();
      const llmSpanId = ev._otel_span_id || generateSpanId();
      const responseId = ev.response_id || `${currentStepId}:r`;
      const protocol = ev.protocol || "anthropic";

      const inputMsgs = convertInputMessages(ev.input_messages, protocol);
      let currentFullHash, delta, logFull;
      if (ev._input_is_delta) {
        delta = inputMsgs;
        currentFullHash = computeHash(runningHash, delta);
        logFull = false;
      } else {
        currentFullHash = computeHash(INITIAL_HASH, inputMsgs);
        delta = inputMsgs.slice(prevInputMsgs.length);
        logFull = shouldLogFullMessages(runningHash, delta, currentFullHash);
      }

      const requestRecord = {
        time_unix_nano: Math.round((ev.request_start_time || evTs) * 1e9),
        "event.id": crypto.randomUUID(),
        "event.name": "llm.request",
        ...base,
        span_id: llmSpanId,
        parent_span_id: currentStepSpanId,
        "step.id": currentStepId,
        "response.id": responseId,
        "agent.id": sessionId,
        "message.role": "assistant",
        "provider.name": "anthropic",
        "request.model": ev.model || model,
        "input.messages_hash": currentFullHash,
        "input.messages_delta": JSON.stringify(delta),
      };

      if (logFull) {
        requestRecord["input.messages"] = JSON.stringify(inputMsgs);
      }

      records.push(requestRecord);

      const apiInputTokens = ev.input_tokens || 0;
      const cacheRead = ev.cache_read_input_tokens || 0;
      const cacheCreation = ev.cache_creation_input_tokens || 0;
      const inputTokens = apiInputTokens + cacheRead + cacheCreation;
      const outputTokens = ev.output_tokens || 0;
      const responseRecord = {
        time_unix_nano: Math.round(evTs * 1e9),
        "event.id": crypto.randomUUID(),
        "event.name": "llm.response",
        ...base,
        span_id: llmSpanId,
        parent_span_id: currentStepSpanId,
        "step.id": currentStepId,
        "response.id": responseId,
        "message.role": "assistant",
        "provider.name": "anthropic",
        "request.model": ev.model || model,
        "response.model": ev.model || model,
        "response.finish_reasons": ev.stop_reason || "stop",
        "usage.input_tokens": inputTokens,
        "usage.output_tokens": outputTokens,
        "usage.cache_write_tokens": cacheCreation,
        "usage.cache_read_tokens": cacheRead,
        "usage.total_tokens": inputTokens + outputTokens,
        "output.messages": JSON.stringify(
          convertOutputMessages(ev.output_content, ev.stop_reason)
        ),
      };

      if (ev.is_error) {
        responseRecord["is_error"] = true;
        responseRecord["error.type"] = "LLMError";
        responseRecord["error.message"] = ev.error_message || "unknown error";
      }

      records.push(responseRecord);
      runningHash = currentFullHash;
      prevInputMsgs = ev._input_is_delta ? [] : inputMsgs;

    } else if (ev.type === "post_tool_use") {
      const toolName = ev.tool_name || "unknown";
      if (toolName === "Agent" || toolName === "agent") continue;

      const preEv = preToolUseMap[ev.tool_use_id] || {};
      const effectiveName = preEv.tool_name || toolName;
      const effectiveInput = preEv.tool_input || {};
      const toolSpanId = ev._otel_span_id || generateSpanId();
      const parentStepSpanId = ev._otel_step_span_id || currentStepSpanId;

      records.push({
        time_unix_nano: Math.round((preEv.timestamp || evTs) * 1e9),
        "event.id": crypto.randomUUID(),
        "event.name": "tool.call",
        ...base,
        span_id: toolSpanId,
        parent_span_id: parentStepSpanId,
        "step.id": currentStepId || turnId,
        "message.role": "tool",
        "tool.name": effectiveName,
        "tool.call.id": ev.tool_use_id || "",
        "tool.arguments": JSON.stringify(effectiveInput),
      });

      const toolErr = extractToolError(ev.tool_response);
      const durationMs = preEv.timestamp ? (evTs - preEv.timestamp) * 1000 : undefined;
      const resultRecord = {
        time_unix_nano: Math.round(evTs * 1e9),
        "event.id": crypto.randomUUID(),
        "event.name": "tool.result",
        ...base,
        span_id: toolSpanId,
        parent_span_id: parentStepSpanId,
        "step.id": currentStepId || turnId,
        "message.role": "tool",
        "tool.name": effectiveName,
        "tool.call.id": ev.tool_use_id || "",
        "tool.result": JSON.stringify(extractToolResult(ev.tool_response)),
        "tool.result.status": toolErr ? "error" : "success",
      };

      if (durationMs !== undefined) {
        resultRecord["tool.result.duration_ms"] = durationMs;
      }

      if (toolErr) {
        resultRecord["is_error"] = true;
        resultRecord["error.type"] = toolErr.type || "ToolError";
        resultRecord["error.message"] = toolErr.message || "unknown error";
      }

      records.push(resultRecord);
    }
  }

  const consumedIds = new Set(
    turn.events.filter(e => e.type === "post_tool_use" && e.tool_use_id).map(e => e.tool_use_id)
  );
  for (const [toolUseId, preEv] of Object.entries(preToolUseMap)) {
    if (consumedIds.has(toolUseId)) continue;
    const toolName = preEv.tool_name || "unknown";
    if (toolName === "Agent" || toolName === "agent") continue;
    const orphanSpanId = preEv._otel_span_id || generateSpanId();
    const orphanParentSpanId = preEv._otel_step_span_id || currentStepSpanId || spanCtx.agentSpanId;
    records.push({
      time_unix_nano: Math.round((preEv.timestamp || turn.endTime) * 1e9),
      "event.id": crypto.randomUUID(),
      "event.name": "tool.call",
      ...base,
      "step.id": currentStepId || turnId,
      span_id: orphanSpanId,
      parent_span_id: orphanParentSpanId,
      "message.role": "tool",
      "tool.name": toolName,
      "tool.call.id": toolUseId,
      "tool.arguments": JSON.stringify(preEv.tool_input || {}),
    });
  }

  return { records, hash: runningHash };
}

// ---------------------------------------------------------------------------
// export_session_trace — per-turn independent traces with ENTRY → AGENT → STEP → LLM/TOOL
// ---------------------------------------------------------------------------

async function exportSessionTrace(state, stopReason = "end_turn") {
  const logOnly = isLogEnabled() && !config.getEndpoint() && !config.isDebug();

  let provider = null;
  if (!logOnly) {
    provider = configureTelemetry();
  }

  if (!state || typeof state !== "object") {
    throw new Error("exportSessionTrace: invalid state object");
  }

  const sessionId = state.session_id || "unknown";
  const startTime = typeof state.start_time === "number" ? state.start_time : Date.now() / 1000;
  const stopTime = typeof state.stop_time === "number" ? state.stop_time : Date.now() / 1000;

  // Merge LLM call data from transcript (primary) or proxy events (fallback)
  let allEvents = Array.isArray(state.events) ? [...state.events] : [];
  let llmEvents = [];

  // Primary: parse Claude Code transcript (incremental — only new data since last Stop)
  if (state.transcript_path) {
    try {
      const { parseClaudeTranscript, alignWithHookEvents } = require("./transcript");
      llmEvents = parseClaudeTranscript(
        state.transcript_path, startTime, stopTime,
        state.transcript_offset || 0
      );
      if (typeof llmEvents.nextOffset === "number") {
        state._next_transcript_offset = llmEvents.nextOffset;
      }
      if (llmEvents.length > 0) {
        alignWithHookEvents(llmEvents, allEvents, stopTime);
      }
    } catch (err) {
      debug(`transcript parse failed: ${err?.message || String(err)}`);
    }
  }

  // Fallback: intercept.js proxy events (for older Claude Code versions)
  if (llmEvents.length === 0) {
    try {
      const claudePid = resolveClaudePid();
      llmEvents = readProxyEvents(startTime, stopTime, true, claudePid);
    } catch {}
  }

  if (llmEvents.length > 0) {
    const validLlmEvents = llmEvents.filter(e => !e._discarded);
    if (validLlmEvents.length > 0) {
      const getSortKey = (e) => {
        if (e.type === "llm_call" && e.request_start_time) return e.request_start_time;
        return e.timestamp || 0;
      };
      allEvents = [...allEvents, ...validLlmEvents].sort((a, b) => getSortKey(a) - getSortKey(b));
    }
  }

  // Split into per-turn groups
  const turns = splitEventsByTurn(allEvents);
  if (turns.length === 0) return;

  // Set endTime for last turn
  turns[turns.length - 1].endTime = stopTime;

  // Export each turn as an independent trace (skip in log-only mode)
  const entryInvs = [];
  const agentInvs = [];
  if (!logOnly) {
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    const tracer = trace.getTracer("opentelemetry-instrumentation-claude");

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const isLast = i === turns.length - 1;
      const turnStopReason = isLast ? stopReason : "end_turn";

      // Aggregate per-turn tokens from llm_call events
      let turnInputTokens = 0, turnOutputTokens = 0;
      let turnCacheRead = 0, turnCacheCreate = 0;
      let turnModel = state.model || "unknown";
      const llmEvents = turn.events.filter(e => e.type === "llm_call");
      for (const lev of llmEvents) {
        const apiIn = lev.input_tokens || 0;
        const cR = lev.cache_read_input_tokens || 0;
        const cC = lev.cache_creation_input_tokens || 0;
        turnInputTokens += apiIn + cR + cC;
        turnOutputTokens += lev.output_tokens || 0;
        turnCacheRead += cR;
        turnCacheCreate += cC;
        if (lev.model) turnModel = lev.model;
      }

      // Determine turn output (last llm_call's output_content)
      const lastLlm = llmEvents.length > 0 ? llmEvents[llmEvents.length - 1] : null;
      const turnOutputMessages = lastLlm
        ? convertOutputMessages(lastLlm.output_content, lastLlm.stop_reason)
        : [];

      // ENTRY span — no parent → new traceId
      const entryInv = createEntryInvocation({
        sessionId,
        inputMessages: turn.prompt
          ? [{ role: "user", parts: [{ type: "text", content: turn.prompt }] }]
          : [],
        outputMessages: turnOutputMessages,
        attributes: sessionAttrs(sessionId, "ENTRY"),
      });
      handler.startEntry(entryInv, undefined, hrTime(turn.startTime));
      entryInvs.push(entryInv);

      // AGENT span
      const agentInv = createInvokeAgentInvocation("anthropic", {
        agentName: "claude-code",
        agentId: sessionId,
        conversationId: sessionId,
        requestModel: turnModel,
        responseModelName: turnModel,
        inputTokens: turnInputTokens,
        outputTokens: turnOutputTokens,
        usageCacheReadInputTokens: turnCacheRead,
        usageCacheCreationInputTokens: turnCacheCreate,
        finishReasons: [turnStopReason],
        inputMessages: turn.prompt
          ? [{ role: "user", parts: [{ type: "text", content: turn.prompt }] }]
          : [],
        outputMessages: turnOutputMessages,
        attributes: sessionAttrs(sessionId, "AGENT"),
      });
      handler.startInvokeAgent(agentInv, entryInv.contextToken, hrTime(turn.startTime));
      agentInvs.push(agentInv);

      // Replay this turn's events as child spans
      replayEventsAsSpans(handler, tracer, turn.events, agentInv.contextToken, turn.endTime, sessionId);

      // Close spans
      handler.stopInvokeAgent(agentInv, hrTime(turn.endTime));
      handler.stopEntry(entryInv, hrTime(turn.endTime));
    }
  }

  // Write JSONL logs (independent of trace export — failure doesn't block traces)
  if (isLogEnabled()) {
    try {
      const allLogRecords = [];
      let logHash = INITIAL_HASH;

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        let spanCtx;
        if (!logOnly && entryInvs[i]) {
          try {
            const entrySpan = trace.getSpan(entryInvs[i].contextToken);
            spanCtx = {
              traceId: entrySpan?.spanContext().traceId || generateTraceId(),
              entrySpanId: entrySpan?.spanContext().spanId || generateSpanId(),
              agentSpanId: agentInvs[i]?.span?.spanContext().spanId || generateSpanId(),
            };
          } catch {
            spanCtx = { traceId: generateTraceId(), entrySpanId: generateSpanId(), agentSpanId: generateSpanId() };
          }
        } else {
          spanCtx = { traceId: generateTraceId(), entrySpanId: generateSpanId(), agentSpanId: generateSpanId() };
        }

        const { records, hash } = generateTurnLogRecords(
          turn, i, sessionId, state.model || "unknown", logHash, spanCtx
        );
        allLogRecords.push(...records);
        logHash = hash;
      }

      writeLogRecords(allLogRecords);
    } catch (err) {
      console.error("[otel-claude-hook] log writing failed (non-fatal):", err?.message || String(err));
    }
  }

  if (!logOnly) {
    await shutdownTelemetry();
  }

  const totalIn = turns.reduce((s, t) =>
    s + t.events.filter(e => e.type === "llm_call").reduce((a, e) =>
      a + (e.input_tokens || 0) + (e.cache_read_input_tokens || 0) + (e.cache_creation_input_tokens || 0), 0), 0);
  const totalOut = turns.reduce((s, t) =>
    s + t.events.filter(e => e.type === "llm_call").reduce((a, e) => a + (e.output_tokens || 0), 0), 0);
  console.error(
    `✅ Session ${logOnly ? "logged" : "traced"} | ${turns.length} turn(s) | ` +
    `${totalIn} in, ${totalOut} out | ` +
    `${(stopTime - startTime).toFixed(1)}s`
  );
}

// ---------------------------------------------------------------------------
// stdin helper
// ---------------------------------------------------------------------------

function isCursorCaller(event) {
  return !!event.cursor_version;
}

function readStdinJson() {
  try {
    // Read stdin synchronously. Claude Code sends hook data as JSON on stdin.
    // We use a 4KB buffer loop to handle large payloads reliably across platforms.
    const chunks = [];
    const buf = Buffer.alloc(4096);
    let fd;
    try {
      fd = fs.openSync("/dev/stdin", "rs");
    } catch {
      // Fallback: read from fd 0 directly
      fd = 0;
    }
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      chunks.push(buf.slice(0, bytes));
    }
    if (fd !== 0) try { fs.closeSync(fd); } catch {}
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
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
  const destDir = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.claude");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "intercept.js");
  fs.copyFileSync(src, dest);
  console.error(`✅ intercept.js installed to ${dest}`);
  return dest;
}

function removeOtelHooksFromSettings(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object") return;
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    settings.hooks[event] = matchers
      .map((matcher) => {
        if (!Array.isArray(matcher.hooks)) return matcher;
        const newHooks = matcher.hooks.filter(
          (h) => !h.command || !isOtelHookCommand(h.command)
        );
        if (newHooks.length === matcher.hooks.length) return matcher;
        return newHooks.length > 0 ? { ...matcher, hooks: newHooks } : null;
      })
      .filter(Boolean)
      .filter((m) => m && Array.isArray(m.hooks) && m.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

function installIntoSettings(settingsPath, entryPath) {
  settingsPath = path.resolve(settingsPath);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch {}
  }

  removeOtelHooksFromSettings(settings);

  if (!settings.hooks) settings.hooks = {};
  const hookConfig = buildHookConfig(entryPath);

  for (const [eventName, matchers] of Object.entries(hookConfig)) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
    settings.hooks[eventName].push(...matchers);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Command handlers (called from bin/otel-claude-hook)
// ---------------------------------------------------------------------------

function maybeSaveTranscriptPath(state, event) {
  if (!state.transcript_path && event.transcript_path) {
    state.transcript_path = event.transcript_path;
  }
}

function cmdUserPromptSubmit() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();
  const prompt = event.prompt || "";

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.start_time = Date.now() / 1000;
  if (!state.prompt) state.prompt = prompt;
  state.metrics.turns = (state.metrics.turns || 0) + 1;
  if (event.model) state.model = event.model;

  state.events.push({
    type: "user_prompt_submit",
    timestamp: Date.now() / 1000,
    prompt,
  });
  saveState(sessionId, state);
}

function cmdPreToolUse() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();
  const toolName = event.tool_name || "unknown";
  const toolInput = event.tool_input || {};
  // Use event-provided tool_use_id only. Falling back to a random UUID would
  // create an id that cmdPostToolUse can never match (it also falls back to
  // null), leaving the span open forever. When absent, replayEventsAsSpans
  // closes the pre-span immediately (the `if (toolUseId)` guard).
  const toolUseId = event.tool_use_id || null;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.metrics.tools_used = (state.metrics.tools_used || 0) + 1;
  if (!state.tools_used.includes(toolName)) state.tools_used.push(toolName);

  state.events.push({
    type: "pre_tool_use",
    timestamp: Date.now() / 1000,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
  saveState(sessionId, state);
}

function cmdPostToolUse() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  const toolName = event.tool_name || "unknown";
  state.events.push({
    type: "post_tool_use",
    timestamp: Date.now() / 1000,
    tool_name: toolName,
    tool_response: event.tool_response,
    tool_use_id: event.tool_use_id || null,
  });
  saveState(sessionId, state);
}

function cmdPreCompact() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.events.push({
    type: "pre_compact",
    timestamp: Date.now() / 1000,
    trigger: event.trigger || "unknown",
    has_custom_instructions: event.custom_instructions !== null && event.custom_instructions !== undefined,
  });
  saveState(sessionId, state);
}

function cmdSubagentStart() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.events.push({
    type: "subagent_start",
    timestamp: Date.now() / 1000,
    subagent_session_id: event.subagent_session_id || "",
    agent_id: event.agent_id || "",
    agent_type: event.agent_type || "",
  });
  saveState(sessionId, state);
}

function cmdSubagentStop() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();
  const stopReason = event.stop_reason || "end_turn";

  const usage = event.usage || {};
  const inputTokens = usage.input_tokens || event.input_tokens || 0;
  const outputTokens = usage.output_tokens || event.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || event.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || event.cache_creation_input_tokens || 0;

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);

  const childSid = event.subagent_session_id || "unknown";
  let childStateSnapshot = null;
  if (childSid && childSid !== "unknown" && childSid !== sessionId) {
    childStateSnapshot = readAndDeleteChildState(childSid);
  }

  const evData = {
    type: "subagent_stop",
    timestamp: Date.now() / 1000,
    subagent_session_id: childSid,
    stop_reason: stopReason,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
  if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
    evData._child_state = childStateSnapshot;
  }

  state.events.push(evData);
  saveState(sessionId, state);
}

function cmdNotification() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.events.push({
    type: "notification",
    timestamp: Date.now() / 1000,
    message: event.message || "",
    title: event.title || "",
    level: event.level || "info",
  });
  saveState(sessionId, state);
}

async function cmdStop() {
  const event = readStdinJson();
  if (isCursorCaller(event)) return;
  const sessionId = event.session_id || require("crypto").randomUUID();
  const stopReason = event.stop_reason || "end_turn";

  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, event);
  state.stop_time = Date.now() / 1000;
  saveState(sessionId, state);

  // Telemetry export failures must NOT crash the process (exit code 0),
  // otherwise Claude Code may treat the hook as broken.
  try {
    await exportSessionTrace(state, stopReason);
    // Clear exported events so subsequent Stop calls (which fire after every
    // turn, not just session end) don't re-export old turns as duplicates.
    if (typeof state._next_transcript_offset === "number") {
      state.transcript_offset = state._next_transcript_offset;
      delete state._next_transcript_offset;
    }
    state.events = [];
    state.stop_time = null;
    saveState(sessionId, state);
  } catch (err) {
    console.error(
      "[otel-claude-hook] telemetry export failed (agent unaffected):",
      err?.message || String(err)
    );
  }
}

async function cmdInstall(opts = {}) {
  const quiet = !!opts.quiet;

  // Helper: print unless quiet mode
  const log = (...args) => { if (!quiet) console.error(...args); };

  // Use full language detection (with system commands) for install output.
  // This runs only once; subprocess latency is acceptable here.
  const installLang = quiet ? LANG_MODE : detectLangFull();
  const installMsg = (zh, en) => installLang === "zh" ? zh : en;

  try {
    const targets = [];
    if (opts.settingsPath) {
      targets.push(opts.settingsPath);
    } else {
      if (opts.user !== false) {
        const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
        targets.push(path.join(configDir, "settings.json"));
      }
      if (opts.project) {
        targets.push(path.join(process.cwd(), ".claude", "settings.json"));
      }
    }
    if (targets.length === 0 && !quiet) {
      console.error(installMsg("未指定目标 - 请使用 --user 或 --project。", "No target specified - use --user or --project."));
      process.exit(1);
    }

    // 1. Generate hook-entry.sh wrapper and register hooks in settings.json
    const entryPath = generateHookEntry();
    log(installMsg(`✅ Hook entry: ${entryPath}`, `✅ Hook entry: ${entryPath}`));
    for (const settingsPath of targets) {
      installIntoSettings(settingsPath, entryPath);
      log(installMsg(`✅ Hook 已安装到 ${settingsPath}`, `✅ Hooks installed in ${settingsPath}`));
    }

    // 2. Set up shell alias via setup-alias.sh (if bash is available)
    if (opts.alias !== false) {
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
    }

    // 3. Print usage hints (non-quiet only)
    log(
      installMsg(
        "\n请配置遥测后端：\n" +
        "  export OTEL_EXPORTER_OTLP_ENDPOINT='https://xxx:4318'\n" +
        "  export OTEL_RESOURCE_ATTRIBUTES='service.name=claude-agents'\n" +
        "\nLLM 追踪数据通过 Claude Code 的 transcript 文件自动获取，无需额外配置。\n",
        "\nRemember to configure your telemetry backend:\n" +
        "  export OTEL_EXPORTER_OTLP_ENDPOINT='https://xxx:4318'\n" +
        "  export OTEL_RESOURCE_ATTRIBUTES='service.name=claude-agents'\n" +
        "\nLLM trace data is automatically obtained from Claude Code's transcript files — no additional setup required.\n"
      )
    );
  } catch (err) {
    if (quiet) {
      // In quiet/postinstall mode: warn but don't fail npm install
      console.error(`[otel-claude-hook] postinstall warning: ${err?.message || String(err)}`);
    } else {
      throw err;
    }
  }
}

function cmdShowConfig() {
  const entryPath = path.join(hookEntryCacheDir(), "hook-entry.sh");
  const snippet = { hooks: buildHookConfig(entryPath) };
  console.log(JSON.stringify(snippet, null, 2));
}

function cmdCheckEnv() {
  const endpoint = config.getEndpoint();
  const debugMode = config.isDebug();

  // Show config file status
  const cfgFile = config.loadConfigFile();
  const hasCfgFile = Object.keys(cfgFile).length > 0;
  if (hasCfgFile) {
    console.error(msg(`📄 配置文件: ${config.CONFIG_PATH}`, `📄 Config file: ${config.CONFIG_PATH}`));
    const cfgKeys = Object.keys(cfgFile).filter(k => cfgFile[k] !== null && cfgFile[k] !== undefined && cfgFile[k] !== "");
    if (cfgKeys.length > 0) {
      console.error(msg(`   已配置项: ${cfgKeys.join(", ")}`, `   Configured keys: ${cfgKeys.join(", ")}`));
    }
  }

  if (endpoint) {
    console.error(msg(`📊 OTEL 端点: ${endpoint}`, `📊 OTEL endpoint: ${endpoint}`));
    const headers = config.getHeaders();
    if (headers) {
      console.error(msg("   请求头: ***已配置***", "   Headers: ***configured***"));
    }
  } else if (debugMode) {
    console.error(msg("🔍 调试模式已启用（仅控制台输出）", "🔍 Debug mode active (console output only)"));
  } else {
    console.error(
      msg(
        `❌ 未配置遥测后端。\n设置 OTEL_EXPORTER_OTLP_ENDPOINT 或配置文件 ${config.CONFIG_PATH}`,
        `❌ No telemetry backend configured.\nSet OTEL_EXPORTER_OTLP_ENDPOINT or config file ${config.CONFIG_PATH}`
      )
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// cmdUninstall
// ---------------------------------------------------------------------------

function uninstallFromSettings(settingsPath) {
  settingsPath = path.resolve(settingsPath);
  if (!fs.existsSync(settingsPath)) return;

  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")); }
  catch { return; }

  const before = JSON.stringify(settings);
  removeOtelHooksFromSettings(settings);
  const changed = JSON.stringify(settings) !== before;

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    console.error(msg(`    ✅ hooks 配置已从 ${settingsPath} 中清理`, `    ✅ Hooks config cleaned up from ${settingsPath}`));
  } else {
    console.error(msg(`    ℹ️  ${settingsPath}: 未找到 otel-claude-hook 相关配置`, `    ℹ️  ${settingsPath}: No otel-claude-hook config found`));
  }
}

function removeAliasFromFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  if (!content.includes("# BEGIN otel-claude-hook")) return;
  const newContent = content.replace(
    /\n?# BEGIN otel-claude-hook\n[\s\S]*?# END otel-claude-hook\n?/g,
    "\n"
  );
  fs.writeFileSync(filePath, newContent, "utf-8");
  console.error(msg(`    ✅ 已从 ${filePath} 删除别名`, `    ✅ Removed alias from ${filePath}`));
}

function cmdUninstall(opts = {}) {
  console.error("============================");
  console.error(msg(" otel-claude-hook — 卸载", " otel-claude-hook — Uninstall"));
  console.error("============================");
  console.error("");

  // 1. Clean settings.json
  console.error(msg("==> 清理 hooks 配置...", "==> Cleaning up hooks config..."));
  const targets = [];
  if (opts.project) targets.push(path.join(process.cwd(), ".claude", "settings.json"));
  if (opts.user !== false) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    targets.push(path.join(configDir, "settings.json"));
  }
  for (const t of targets) uninstallFromSettings(t);
  console.error("");

  // 2. Clean cache directory (intercept.js + session state)
  const cacheDir = path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.claude");
  if (opts.purge) {
    console.error(msg("==> --purge: 正在删除整个缓存目录...", "==> --purge: Removing entire cache directory..."));
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.error(msg(`    ✅ 已删除 ${cacheDir}`, `    ✅ Deleted ${cacheDir}`));
    } else {
      console.error(msg(`    ℹ️  ${cacheDir} 不存在，跳过`, `    ℹ️  ${cacheDir} not found, skipping`));
    }
  } else {
    // Clean up legacy intercept.js if present
    const interceptFile = path.join(cacheDir, "intercept.js");
    if (fs.existsSync(interceptFile)) {
      try { fs.unlinkSync(interceptFile); } catch {}
    }
  }
  console.error("");

  // 3. Remove alias from shell profiles
  console.error(msg("==> 正在清理 shell 别名...", "==> Cleaning up shell alias..."));
  removeAliasFromFile(path.join(os.homedir(), ".bashrc"));
  removeAliasFromFile(path.join(os.homedir(), ".zshrc"));
  removeAliasFromFile(path.join(os.homedir(), ".bash_profile"));
  console.error("");

  // 4. Done
  console.error("============================");
  console.error(msg(" ✅ 卸载完成", " ✅ Uninstall complete!"));
  console.error("============================");
  console.error("");
  if (!opts.purge) {
    console.error(msg(`  - Session 数据仍保留在: ${cacheDir}/sessions/`, `  - Session data retained at: ${cacheDir}/sessions/`));
    console.error(msg("  - 完全删除缓存：otel-claude-hook uninstall --purge", "  - To fully remove cache: otel-claude-hook uninstall --purge"));
  }
  console.error(msg("  - 重新加载 Shell 使别名失效：source ~/.bashrc", "  - Reload shell to deactivate alias: source ~/.bashrc"));
  console.error("");
}

module.exports = {
  cmdUserPromptSubmit,
  cmdPreToolUse,
  cmdPostToolUse,
  cmdPreCompact,
  cmdSubagentStart,
  cmdSubagentStop,
  cmdNotification,
  cmdStop,
  cmdInstall,
  cmdUninstall,
  cmdShowConfig,
  cmdCheckEnv,
  // Internal exports for testing
  _buildHookConfig: buildHookConfig,
  _hrTime: hrTime,
  _tsNs: tsNs,
  _readProxyEvents: readProxyEvents,
  _installIntoSettings: installIntoSettings,
  // Event-driven variants (bypass stdin, accept event object directly)
  _cmdUserPromptSubmitWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const prompt = event.prompt || "";
    const state = loadState(sessionId);
    state.start_time = Date.now() / 1000;
    if (!state.prompt) state.prompt = prompt;
    state.metrics.turns = (state.metrics.turns || 0) + 1;
    if (event.model) state.model = event.model;
    state.events.push({ type: "user_prompt_submit", timestamp: Date.now() / 1000, prompt });
    saveState(sessionId, state);
  },
  _cmdPreToolUseWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const toolName = event.tool_name || "unknown";
    const toolInput = event.tool_input || {};
    const toolUseId = event.tool_use_id || null;
    const state = loadState(sessionId);
    state.metrics.tools_used = (state.metrics.tools_used || 0) + 1;
    if (!state.tools_used.includes(toolName)) state.tools_used.push(toolName);
    state.events.push({ type: "pre_tool_use", timestamp: Date.now() / 1000, tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId });
    saveState(sessionId, state);
  },
  _cmdPostToolUseWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({ type: "post_tool_use", timestamp: Date.now() / 1000, tool_name: event.tool_name || "unknown", tool_response: event.tool_response, tool_use_id: event.tool_use_id || null });
    saveState(sessionId, state);
  },
  _cmdPreCompactWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({ type: "pre_compact", timestamp: Date.now() / 1000, trigger: event.trigger || "unknown", has_custom_instructions: event.custom_instructions != null });
    saveState(sessionId, state);
  },
  _cmdNotificationWithEvent: function(event) {
    const { loadState, saveState } = require("./state");
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({ type: "notification", timestamp: Date.now() / 1000, message: event.message || "", title: event.title || "", level: event.level || "info" });
    saveState(sessionId, state);
  },
  _resolveClaudePid: typeof resolveClaudePid !== "undefined" ? resolveClaudePid : null,
  _replayEventsAsSpans: replayEventsAsSpans,
  _splitEventsByTurn: splitEventsByTurn,
  _exportSessionTrace: exportSessionTrace,
  _generateTurnLogRecords: generateTurnLogRecords,
  _installIntercept: installIntercept,
  _removeAliasFromFile: removeAliasFromFile,
  _maybeSaveTranscriptPath: maybeSaveTranscriptPath,
  _cmdSubagentStartWithEvent: function(event) {
    const sessionId = event.session_id || require("crypto").randomUUID();
    const state = loadState(sessionId);
    state.events.push({
      type: "subagent_start",
      timestamp: Date.now() / 1000,
      subagent_session_id: event.subagent_session_id || "",
      agent_id: event.agent_id || "",
      agent_type: event.agent_type || "",
    });
    saveState(sessionId, state);
  },
  _cmdSubagentStopWithEvent: function(event) {
    const sessionId = event.session_id || require("crypto").randomUUID();
    const stopReason = event.stop_reason || "end_turn";
    const usage = event.usage || {};
    const inputTokens = usage.input_tokens || event.input_tokens || 0;
    const outputTokens = usage.output_tokens || event.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || event.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || event.cache_creation_input_tokens || 0;
    const childSid = event.subagent_session_id || "unknown";
    let childStateSnapshot = null;
    if (childSid && childSid !== "unknown" && childSid !== sessionId) {
      childStateSnapshot = readAndDeleteChildState(childSid);
    }
    const evData = {
      type: "subagent_stop",
      timestamp: Date.now() / 1000,
      subagent_session_id: childSid,
      stop_reason: stopReason,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    };
    if (childStateSnapshot && Array.isArray(childStateSnapshot.events) && childStateSnapshot.events.length > 0) {
      evData._child_state = childStateSnapshot;
    }
    const state = loadState(sessionId);
    state.events.push(evData);
    saveState(sessionId, state);
  },
};
