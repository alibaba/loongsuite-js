import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ExtendedTelemetryHandler } from "@loongsuite/opentelemetry-util-genai";
import { loadState, saveState, splitIntoTurns } from "./state.js";
import type { SessionState } from "./state.js";
import { configureTelemetry, shutdownTelemetry } from "./telemetry.js";
import { replaySession, buildReactSteps } from "./replay.js";
import {
  CONFIG_PATH,
  getEndpoint,
  getHeaders,
  isDebug,
  isLogEnabled as configIsLogEnabled,
  getLogDir,
} from "./config.js";
import { parseTranscript } from "./transcript.js";
import { isLogEnabled, writeLogRecords } from "./logger.js";
import { generateTurnLogRecords } from "./log-records.js";
import { writeTrustedHashes, removeTrustBlock } from "./trust.js";

// --- GenAI default env ---
//
// `@loongsuite/opentelemetry-util-genai` 库要求两个环境变量同时存在,才会把
// `inputMessages` / `outputMessages` 写入 span 属性。普通 codex 用户不会主动
// 设置,导致 trace 里看不到 prompt/response 文本。
//
// 这里在 hook 进程启动时为这两个变量提供默认值(若用户未显式设置)。
// 若用户希望禁用,可显式 export 为 NO_CONTENT(或把 STABILITY_OPT_IN 设为
// 非 gen_ai_latest_experimental 的值)。
if (!process.env["OTEL_SEMCONV_STABILITY_OPT_IN"]) {
  process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] = "gen_ai_latest_experimental";
}
if (!process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"]) {
  process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "SPAN_ONLY";
}

// --- stdin reading ---

function readStdin(): Record<string, unknown> {
  try {
    const data = fs.readFileSync(0, "utf-8").trim();
    if (!data) return {};
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nowSec(): number {
  return Date.now() / 1000;
}

function maybeSaveTranscriptPath(
  state: SessionState,
  input: Record<string, unknown>,
): void {
  if (!state.transcript_path) {
    const tp = input["transcript_path"];
    if (typeof tp === "string" && tp) {
      state.transcript_path = tp;
    }
  }
}

// --- Hook command handlers ---

export function cmdSessionStart(): void {
  const input = readStdin();
  const sessionId = String(input["session_id"] || "unknown");
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  state.model = String(input["model"] || state.model || "unknown");
  state.start_time = nowSec();
  state.events.push({
    type: "session_start",
    timestamp: nowSec(),
    source: String(input["source"] || "startup"),
    model: state.model,
  });
  saveState(sessionId, state);
}

export function cmdUserPromptSubmit(): void {
  const input = readStdin();
  const sessionId = String(input["session_id"] || "unknown");
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  const model = String(input["model"] || state.model || "unknown");
  if (model !== "unknown") state.model = model;
  state.events.push({
    type: "user_prompt_submit",
    timestamp: nowSec(),
    prompt: String(input["prompt"] || ""),
    turn_id: String(input["turn_id"] || ""),
    model,
  });
  saveState(sessionId, state);
}

export function cmdPreToolUse(): void {
  const input = readStdin();
  const sessionId = String(input["session_id"] || "unknown");
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  state.events.push({
    type: "pre_tool_use",
    timestamp: nowSec(),
    turn_id: String(input["turn_id"] || ""),
    tool_name: String(input["tool_name"] || "unknown"),
    tool_input: input["tool_input"] ?? null,
    tool_use_id: String(input["tool_use_id"] || ""),
  });
  saveState(sessionId, state);
}

export function cmdPostToolUse(): void {
  const input = readStdin();
  const sessionId = String(input["session_id"] || "unknown");
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  state.events.push({
    type: "post_tool_use",
    timestamp: nowSec(),
    turn_id: String(input["turn_id"] || ""),
    tool_name: String(input["tool_name"] || "unknown"),
    tool_response: input["tool_response"] ?? null,
    tool_use_id: String(input["tool_use_id"] || ""),
  });
  saveState(sessionId, state);
}

export async function cmdStop(): Promise<void> {
  const input = readStdin();
  const sessionId = String(input["session_id"] || "unknown");
  const state = loadState(sessionId);
  maybeSaveTranscriptPath(state, input);
  const model = String(input["model"] || state.model || "unknown");
  if (model !== "unknown") state.model = model;
  state.events.push({
    type: "stop",
    timestamp: nowSec(),
    turn_id: String(input["turn_id"] || ""),
    last_assistant_message:
      input["last_assistant_message"] != null
        ? String(input["last_assistant_message"])
        : undefined,
    model,
  });
  saveState(sessionId, state);

  // Parse transcript incrementally — only read bytes added since last cmdStop.
  // codex transcript(rollout-*.jsonl)按 session 累加,每个 turn 都会再追加内容,
  // 这里靠 state.transcript_offset 做增量,避免每次都重读全文件 + 解决 token 错位 bug。
  const startOffset = state.transcript_offset || 0;
  const startLastUsage = state.transcript_last_token_usage ?? null;
  const transcriptData = state.transcript_path
    ? parseTranscript(state.transcript_path, startOffset, startLastUsage)
    : null;
  if (transcriptData) {
    if (state.model === "unknown" && transcriptData.model !== "unknown") {
      state.model = transcriptData.model;
    }
    process.stderr.write(
      `[otel-codex-hook] Parsed transcript: ${transcriptData.tokenEvents.length} LLM call(s)` +
      (transcriptData.totalUsage
        ? `, ${transcriptData.totalUsage.inputTokens} in / ${transcriptData.totalUsage.outputTokens} out`
        : "") +
      "\n",
    );
  }

  // Split turns for both OTLP export and JSONL logging
  const turns = splitIntoTurns(state);

  // --- OTLP trace export ---
  let traceIds: string[] = [];
  try {
    const provider = configureTelemetry();
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    traceIds = replaySession(handler, state, transcriptData);
    await shutdownTelemetry();
    if (traceIds.length > 0) {
      process.stderr.write(
        `[otel-codex-hook] Exported ${traceIds.length} trace(s): ${traceIds.join(", ")}\n`,
      );
    } else {
      process.stderr.write(
        `[otel-codex-hook] No traces generated (${state.events.length} events in session)\n`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[otel-codex-hook] Export failed: ${msg}\n`);
    if (msg.includes("NO TELEMETRY BACKEND")) {
      process.stderr.write(
        "[otel-codex-hook] Hint: configure OTLP endpoint in ~/.codex/otel-config.json\n",
      );
    }
  }

  // --- JSONL log output (independent of OTLP) ---
  if (isLogEnabled()) {
    try {
      const allRecords: Record<string, unknown>[] = [];
      // 扁平 fallback 队列:仅在 tokenEventsByTurn 没命中时使用(防御性兜底)
      const fallbackQueue = transcriptData?.tokenEvents
        ? [...transcriptData.tokenEvents]
        : [];
      const provider = transcriptData?.modelProvider || "openai";
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!;
        const stepCount = buildReactSteps(turn).length;
        // 主路径:按 turn_id 从分组里取本 turn 对应的 token 事件
        let turnTokenSlice = transcriptData?.tokenEventsByTurn?.get(turn.turn_id);
        if (!turnTokenSlice || turnTokenSlice.length === 0) {
          // Fallback:turn_id 未命中(理论上不会发生),从扁平队列尾部取
          turnTokenSlice = fallbackQueue.splice(-stepCount, stepCount);
        }
        const { records } = generateTurnLogRecords(
          turn,
          i,
          sessionId,
          state.model,
          provider,
          turnTokenSlice,
          traceIds[i] ?? null,
        );
        allRecords.push(...records);
      }
      writeLogRecords(allRecords);
      process.stderr.write(
        `[otel-codex-hook] Wrote ${allRecords.length} log records\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[otel-codex-hook] Log writing failed (non-fatal): ${msg}\n`,
      );
    }
  }

  // State 管理:不再 clearState 删整个 state 文件(参考 Claude Code 插件 Issue 7.5 修复)。
  // codex 的 Stop hook 按 turn 触发,而 transcript 是 session 维度持久累加的;
  // 删 state 会导致下个 turn 的 cmdStop 看不到历史 events,但 transcript 仍含全部 token,
  // 错位地从队头取本 turn token → token 字段在第二个 turn 起永远固定为 turn 1 的值。
  // 改为:清空 events + 固化 transcript_offset / lastEmittedUsage,保持 state 文件存活,
  // 下次只读增量,且能跨 cmdStop 识别心跳事件。
  if (transcriptData) {
    state.transcript_offset = transcriptData.nextOffset;
    if (transcriptData.lastEmittedUsage) {
      state.transcript_last_token_usage = transcriptData.lastEmittedUsage;
    }
  }
  state.events = [];
  saveState(sessionId, state);
}

// --- Install / Uninstall ---

function codexHome(): string {
  return process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
}

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

const EVENT_TO_SUBCOMMAND: Record<string, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};

function packageBinPath(): string {
  return path.resolve(__dirname, "..", "bin", "otel-codex-hook");
}

function hookEntryCacheDir(): string {
  return path.join(os.homedir(), ".cache", "opentelemetry.instrumentation.codex");
}

function generateHookEntry(): string {
  const binPath = packageBinPath();
  const cacheDir = hookEntryCacheDir();
  const entryPath = path.join(cacheDir, "hook-entry.sh");
  fs.mkdirSync(cacheDir, { recursive: true });

  const script = [
    "#!/usr/bin/env bash",
    "# Auto-generated by otel-codex-hook install",
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
    '  echo "[otel-codex-hook] node runtime not found" >&2',
    "  exit 0",
    "fi",
    "",
    `exec "$NODE_BIN" ${JSON.stringify(binPath)} "$@"`,
    "",
  ].join("\n");

  fs.writeFileSync(entryPath, script, { mode: 0o755 });
  return entryPath;
}

function buildHooksToml(entryPath: string): string {
  const lines: string[] = [];
  for (const event of HOOK_EVENTS) {
    const sub = EVENT_TO_SUBCOMMAND[event]!;
    lines.push(`[[hooks.${event}]]`);
    lines.push("");
    lines.push(`[[hooks.${event}.hooks]]`);
    lines.push(`type = "command"`);
    lines.push(`command = "bash ${entryPath} ${sub}"`);
    lines.push("");
  }
  return lines.join("\n");
}

function buildHooksJson(entryPath: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const sub = EVENT_TO_SUBCOMMAND[event]!;
    hooks[event] = [
      { hooks: [{ type: "command", command: `bash ${entryPath} ${sub}` }] },
    ];
  }
  return { hooks };
}

// Match `hooks = false` (or = "false") only directly under the [features] table,
// skipping nested tables like [features.something] or [hooks.state.xxx].
function findFeaturesHooksFalse(
  content: string,
): { lineStart: number; lineEnd: number; falseStart: number; falseEnd: number } | null {
  const lines = content.split("\n");
  let inFeatures = false;
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1; // +1 for the "\n" we split on

    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inFeatures = /^\[features\]\s*$/.test(trimmed);
      continue;
    }
    if (!inFeatures) continue;

    // Match `hooks = false` (with optional quotes/whitespace), but not e.g. `enable_hooks` or `plugin_hooks`.
    const m = line.match(/^(\s*hooks\s*=\s*)("?false"?)(\s*(?:#.*)?)$/);
    if (m) {
      const prefixLen = m[1]!.length;
      const valueLen = m[2]!.length;
      const falseStart = lineStart + prefixLen;
      const falseEnd = falseStart + valueLen;
      return { lineStart, lineEnd, falseStart, falseEnd };
    }
  }
  return null;
}

// New behavior: codex >= 2026-04-22 has `Feature::CodexHooks` Stable with
// default_enabled = true, so we don't need to write any feature flag in
// the common case. Only intervene when the user has explicitly disabled
// hooks globally (which would silently break our plugin), and inform the
// user about the change so they can decide whether to revert.
function maybeEnableHooksFeature(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  const content = fs.readFileSync(configPath, "utf-8");

  const found = findFeaturesHooksFalse(content);
  if (!found) return;

  const updated =
    content.slice(0, found.falseStart) + "true" + content.slice(found.falseEnd);
  fs.writeFileSync(configPath, updated, "utf-8");

  process.stderr.write(
    `\n[otel-codex-hook] WARNING: detected [features] hooks = false in ${configPath}\n` +
    `[otel-codex-hook]   Changed to hooks = true so otel-codex-hook can run.\n` +
    `[otel-codex-hook]   Note: this is a GLOBAL switch and also enables other hooks.\n` +
    `[otel-codex-hook]   To disable a specific hook, use [hooks.state."<key>"] enabled = false.\n` +
    `[otel-codex-hook]   Uninstalling otel-codex-hook will NOT revert this change automatically.\n\n`,
  );
}

function isLegacyHookLine(line: string): boolean {
  return (
    line.includes("otel-codex-hook") &&
    !line.includes("# BEGIN otel-codex-hook trust") &&
    !line.includes("# END otel-codex-hook trust")
  );
}

// Remove the marker-anchored legacy hook block, plus any stray
// otel-codex-hook lines outside it. Two shapes are recognized:
//
//   1. Old-old: marker line + 5x `[[hooks.X]] / type = "command" / command = "..."`
//      blocks where command refers to otel-codex-hook. We can find the end of
//      the block by locating the trailing `command = "otel-codex-hook stop"`.
//
//   2. Even older / partial: marker line + 5x `[[hooks.X]] / type = "command"`
//      with NO command field (this is what the yemo report contained).
//      The end is detected structurally: keep consuming `[[hooks.X]]` array
//      sections until the next non-`[[hooks.X]]` table header or EOF.
function removeLegacyTomlHooks(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  let content = fs.readFileSync(configPath, "utf-8");

  const marker = "# OpenTelemetry instrumentation hooks";
  const hasMarker = content.includes(marker);
  const hasOtelRef = content.includes("otel-codex-hook");
  if (!hasMarker && !hasOtelRef) return;

  if (hasMarker) {
    const lines = content.split("\n");
    const out: string[] = [];
    let i = 0;
    const hooksArrayHeader = /^\s*\[\[hooks\.[A-Za-z][A-Za-z0-9_]*\]\]\s*$/;
    const anyHeader = /^\s*\[/;

    while (i < lines.length) {
      if (lines[i]!.trim() === marker) {
        i++; // drop the marker comment itself
        // Drop any blank lines and consecutive [[hooks.X]] sections that follow.
        while (i < lines.length) {
          const line = lines[i]!;
          const trimmed = line.trim();
          if (trimmed === "") {
            i++;
            continue;
          }
          if (hooksArrayHeader.test(line)) {
            i++; // drop the header
            // Consume the section body up to the next table header or blank line.
            while (i < lines.length) {
              const t = lines[i]!.trim();
              if (t === "" || anyHeader.test(lines[i]!)) break;
              i++;
            }
            continue;
          }
          break; // hit something that's not part of the legacy block
        }
        continue;
      }
      // Catch stray otel-codex-hook lines that escaped the marker block.
      if (isLegacyHookLine(lines[i]!)) {
        i++;
        continue;
      }
      out.push(lines[i]!);
      i++;
    }
    content = out.join("\n");
  } else {
    content = content
      .split("\n")
      .filter((l) => !isLegacyHookLine(l))
      .join("\n");
  }

  content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  fs.writeFileSync(configPath, content, "utf-8");
}

export async function cmdInstall(opts: {
  quiet?: boolean;
}): Promise<void> {
  const home = codexHome();
  const hooksJsonPath = path.join(home, "hooks.json");
  const configPath = path.join(home, "config.toml");

  fs.mkdirSync(home, { recursive: true });

  const entryPath = generateHookEntry();

  if (fs.existsSync(hooksJsonPath)) {
    const existing = fs.readFileSync(hooksJsonPath, "utf-8");
    if (isOtelHookCommand(existing)) {
      removeHooksJsonEntries(hooksJsonPath);
    }
  }

  const hooksData = buildHooksJson(entryPath);

  if (fs.existsSync(hooksJsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      if (existing && typeof existing === "object" && existing.hooks) {
        for (const [event, handlers] of Object.entries(
          hooksData.hooks as Record<string, unknown[]>,
        )) {
          if (!existing.hooks[event]) {
            existing.hooks[event] = handlers;
          } else {
            (existing.hooks[event] as unknown[]).push(...handlers);
          }
        }
        hooksData.hooks = existing.hooks;
      }
    } catch {}
  }

  fs.writeFileSync(
    hooksJsonPath,
    JSON.stringify(hooksData, null, 2) + "\n",
    "utf-8",
  );

  // Clean up legacy TOML hooks before writing new trust state
  removeLegacyTomlHooks(configPath);
  maybeEnableHooksFeature(configPath);

  const absHooksJsonPath = path.resolve(hooksJsonPath);
  writeTrustedHashes(
    configPath,
    absHooksJsonPath,
    entryPath,
    HOOK_EVENTS,
    EVENT_TO_SUBCOMMAND,
  );

  if (!opts.quiet) {
    process.stderr.write(
      `[otel-codex-hook] Installed ${HOOK_EVENTS.length} hooks → ${home}/{hooks.json,config.toml}\n` +
        "[otel-codex-hook] Requires codex >= 2026-04-22 (Stable hooks)\n",
    );
  }
}

function isOtelHookCommand(cmd: string): boolean {
  return cmd.includes("otel-codex-hook") || cmd.includes("hook-entry.sh");
}

function removeHooksJsonEntries(hooksJsonPath: string): void {
  if (!fs.existsSync(hooksJsonPath)) return;
  const raw = fs.readFileSync(hooksJsonPath, "utf-8");
  if (!isOtelHookCommand(raw)) return;

  try {
    const data = JSON.parse(raw);
    if (!data?.hooks) return;

    for (const event of Object.keys(data.hooks)) {
      data.hooks[event] = (data.hooks[event] as unknown[]).filter(
        (group: any) => {
          if (!group.hooks) return true;
          group.hooks = group.hooks.filter(
            (h: any) =>
              !(typeof h.command === "string" && isOtelHookCommand(h.command)),
          );
          return group.hooks.length > 0;
        },
      );
      if (data.hooks[event].length === 0) delete data.hooks[event];
    }

    if (Object.keys(data.hooks).length === 0) {
      fs.unlinkSync(hooksJsonPath);
      process.stderr.write(
        "[otel-codex-hook] hooks.json removed (empty after cleanup).\n",
      );
    } else {
      fs.writeFileSync(
        hooksJsonPath,
        JSON.stringify(data, null, 2) + "\n",
        "utf-8",
      );
      process.stderr.write(
        "[otel-codex-hook] otel-codex-hook entries removed from hooks.json.\n",
      );
    }
  } catch {
    process.stderr.write(
      "[otel-codex-hook] Warning: failed to parse hooks.json.\n",
    );
  }
}

export function cmdUninstall(opts: {
  purge?: boolean;
}): void {
  const home = codexHome();
  const hooksJsonPath = path.join(home, "hooks.json");
  const configPath = path.join(home, "config.toml");

  removeHooksJsonEntries(hooksJsonPath);

  if (fs.existsSync(configPath)) {
    let content = fs.readFileSync(configPath, "utf-8");
    let changed = false;

    // Step 1: Remove hooks block (from marker to last otel-codex-hook line)
    const marker = "# OpenTelemetry instrumentation hooks";
    const markerIdx = content.indexOf(marker);
    if (markerIdx !== -1) {
      const endStr = 'command = "otel-codex-hook stop"';
      const endIdx = content.indexOf(endStr, markerIdx);
      if (endIdx !== -1) {
        let cutEnd = endIdx + endStr.length;
        // consume trailing whitespace/newlines after the last hook line
        while (cutEnd < content.length && (content[cutEnd] === "\n" || content[cutEnd] === "\r" || content[cutEnd] === " ")) {
          cutEnd++;
        }
        content = content.slice(0, markerIdx) + content.slice(cutEnd);
      } else {
        // end marker not found — fallback: remove lines containing otel-codex-hook
        const lines = content.split("\n");
        content = lines.filter((l) => !isLegacyHookLine(l)).join("\n");
      }
      changed = true;
    } else {
      // no marker comment — fallback: remove lines containing otel-codex-hook
      const lines = content.split("\n");
      const filtered = lines.filter((l) => !isLegacyHookLine(l));
      if (filtered.length !== lines.length) {
        content = filtered.join("\n");
        changed = true;
      }
    }

    // Step 2: Remove codex_hooks = true
    if (content.includes("codex_hooks")) {
      const lines = content.split("\n");
      const filtered = lines.filter((l) => !/^\s*codex_hooks\s*=/.test(l));
      // If [features] section is now empty, remove it too
      const cleaned: string[] = [];
      for (let i = 0; i < filtered.length; i++) {
        const line = filtered[i]!;
        if (/^\[features\]\s*$/.test(line)) {
          // check if next non-empty line is another section header or EOF
          let j = i + 1;
          while (j < filtered.length && filtered[j]!.trim() === "") j++;
          if (j >= filtered.length || /^\[/.test(filtered[j]!)) {
            // [features] is empty — skip it and any trailing blank lines
            i = j - 1;
            continue;
          }
        }
        cleaned.push(line);
      }
      if (cleaned.length !== lines.length) {
        content = cleaned.join("\n");
        changed = true;
      }
    }

    if (changed) {
      // clean up multiple consecutive blank lines
      content = content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      fs.writeFileSync(configPath, content, "utf-8");
      process.stderr.write("[otel-codex-hook] Hooks removed from config.toml.\n");
    } else {
      process.stderr.write("[otel-codex-hook] No hooks found to remove.\n");
    }
  }

  // Remove trusted_hash entries
  if (removeTrustBlock(configPath)) {
    process.stderr.write("[otel-codex-hook] Trust hashes removed from config.toml.\n");
  }

  if (opts.purge) {
    const cacheDir = path.join(
      os.homedir(),
      ".cache",
      "opentelemetry.instrumentation.codex",
    );
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      process.stderr.write(`[otel-codex-hook] Cache directory removed: ${cacheDir}\n`);
    }
  }
}

export function cmdShowConfig(): void {
  const entryPath = path.join(hookEntryCacheDir(), "hook-entry.sh");
  process.stdout.write("# TOML format (add to ~/.codex/config.toml):\n\n");
  process.stdout.write(buildHooksToml(entryPath));
  process.stdout.write("\n# JSON format (hooks.json):\n");
  process.stdout.write(JSON.stringify(buildHooksJson(entryPath), null, 2) + "\n");
}

export function cmdCheckEnv(): void {
  process.stdout.write(`Config file: ${CONFIG_PATH}\n`);

  const endpoint = getEndpoint();
  const debug = isDebug();
  const logEnabled = configIsLogEnabled();
  const logDir = getLogDir();

  if (endpoint) {
    process.stdout.write(`OTLP endpoint: ${endpoint}\n`);
    const headers = getHeaders();
    if (headers) {
      const keys = headers
        .split(",")
        .map((p) => p.split("=")[0]?.trim())
        .filter(Boolean);
      process.stdout.write(`OTLP headers: ${keys.join(", ")}\n`);
    }
    process.stdout.write("Status: READY\n");
  } else if (debug) {
    process.stdout.write("Mode: DEBUG (console output)\n");
    process.stdout.write("Status: READY\n");
  } else {
    process.stdout.write("Status: NOT CONFIGURED (OTLP)\n");
  }

  if (logEnabled) {
    process.stdout.write(`Log output: ENABLED\n`);
    if (logDir) {
      process.stdout.write(`Log dir: ${logDir}\n`);
    }
  }

  if (!endpoint && !debug && !logEnabled) {
    process.stdout.write(
      "\nNo telemetry backend or log output configured.\n" +
      "Configure in ~/.codex/otel-config.json\n",
    );
    process.exitCode = 1;
  }
}
