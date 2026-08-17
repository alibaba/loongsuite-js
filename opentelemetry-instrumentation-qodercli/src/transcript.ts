// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  FunctionToolDefinition,
  InputMessage,
  MessagePart,
  OutputMessage,
  ToolDefinition,
} from "@loongsuite/opentelemetry-util-genai";

/**
 * One LLM response (possibly composed from multiple JSONL chunks that share message.id).
 * `outputMessages` is what the assistant produced; `inputMessages` is the prompt history
 * up to and including the user message that triggered this assistant response.
 */
export interface TokenEvent {
  messageId: string;
  model: string;
  providerName: string;
  timestampMs: number;
  finishReasons: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalTokens: number | null;
  inputMessages: InputMessage[];
  outputMessages: OutputMessage[];
  /** Tool calls emitted by this assistant response (id → name + args). */
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  /** Whether this response has a stop_reason set (i.e. is finalized). */
  finalized: boolean;
}

export interface TranscriptData {
  sessionId: string;
  model: string;
  modelProvider: string;
  totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    totalTokens: number;
  };
  /**
   * Token events ordered by timestamp ascending.
   * Multiple chunks of the same message.id are pre-merged.
   */
  tokenEvents: TokenEvent[];
  /** Best-effort extraction from initial system / meta-user records. */
  systemInstruction?: MessagePart[];
  /** Tool definitions inferred from observed tool_use names (default capture: type+name). */
  toolDefinitions?: ToolDefinition[];
  /** Tool calls + results paired by tool_use_id, in chronological order. */
  toolCalls: Array<{
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    toolResponse: unknown;
    isError: boolean;
    requestedAtMs: number;
    completedAtMs: number | null;
  }>;
  /** Final assistant message of the session, if any (for ENTRY span output). */
  finalAssistantMessage?: OutputMessage;
}

interface RawRecord {
  type: "user" | "system" | "assistant" | string;
  uuid?: string;
  timestamp?: string;
  parentUuid?: string;
  sessionId?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    stop_reason?: string;
    usage?: Record<string, unknown>;
    content?: unknown;
  };
  toolUseResult?: unknown;
  promptId?: string;
}

/** Convert a cwd into qoder-cli's slugified directory key. */
export function slugifyCwd(cwd: string): string {
  // qoder-cli replaces path separators with `-` and prefixes with `-` (matching observed transcript path).
  return cwd.replace(/[/\\]/g, "-");
}

export function getTranscriptPath(sessionId: string, cwd: string): string {
  return path.join(
    os.homedir(),
    ".qoder",
    "projects",
    slugifyCwd(cwd),
    `${sessionId}.jsonl`,
  );
}

export function getSubagentTranscriptPath(
  sessionId: string,
  cwd: string,
  subagentId: string,
): string {
  return path.join(
    os.homedir(),
    ".qoder",
    "projects",
    slugifyCwd(cwd),
    sessionId,
    "subagents",
    `${subagentId}.jsonl`,
  );
}

function parseTimestampMs(s: string | undefined): number {
  if (!s) return Date.now();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Date.now();
}

function inferProvider(model: string, toolUseIds: string[]): string {
  const m = (model || "").toLowerCase();
  if (m.includes("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) {
    return "openai";
  }
  if (m.includes("qwen") || m.includes("dashscope")) return "dashscope";
  if (toolUseIds.some((id) => id.startsWith("toolu_"))) return "anthropic";
  return "unknown";
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function pushPart(
  parts: MessagePart[],
  part: MessagePart | null | undefined,
): void {
  if (!part) return;
  parts.push(part);
}

function mapAssistantContentPart(p: unknown): MessagePart | null {
  if (!p || typeof p !== "object") return null;
  const obj = p as Record<string, unknown>;
  switch (obj.type) {
    case "text":
      return {
        type: "text",
        content: typeof obj.text === "string" ? obj.text : "",
      };
    case "thinking":
      return {
        type: "reasoning",
        content: typeof obj.thinking === "string" ? obj.thinking : "",
      };
    case "redacted_thinking":
      // Cannot decode the encrypted blob; record the marker so downstream knows it existed.
      return { type: "reasoning", content: "[redacted_thinking]" };
    case "tool_use":
      return {
        type: "tool_call",
        id: typeof obj.id === "string" ? obj.id : null,
        name: typeof obj.name === "string" ? obj.name : "",
        arguments: obj.input ?? {},
      };
    default:
      return null;
  }
}

function mapUserContent(content: unknown): MessagePart[] {
  const out: MessagePart[] = [];
  if (typeof content === "string") {
    out.push({ type: "text", content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    switch (obj.type) {
      case "text":
        pushPart(out, {
          type: "text",
          content: typeof obj.text === "string" ? obj.text : "",
        });
        break;
      case "tool_result": {
        let resultText: unknown = obj.content;
        if (typeof resultText !== "string") {
          try {
            resultText = JSON.stringify(resultText);
          } catch {
            resultText = String(resultText ?? "");
          }
        }
        pushPart(out, {
          type: "tool_call_response",
          id: typeof obj.tool_use_id === "string" ? obj.tool_use_id : null,
          response: resultText,
        });
        break;
      }
      default:
        // Skip unknown parts.
        break;
    }
  }
  return out;
}

function isAssistantToolUseRecord(rec: RawRecord): boolean {
  if (rec.type !== "assistant") return false;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (p): p is { type: string } =>
      !!p &&
      typeof p === "object" &&
      (p as Record<string, unknown>).type === "tool_use",
  );
}

interface MergedAssistantResponse {
  messageId: string;
  model: string;
  parts: MessagePart[];
  rawToolUses: Array<{ id: string; name: string; input: unknown }>;
  usage?: Record<string, unknown>;
  stopReason?: string;
  timestampMs: number;
}

function mergeAssistantChunks(records: RawRecord[]): MergedAssistantResponse[] {
  const byId = new Map<string, MergedAssistantResponse>();
  const order: string[] = [];

  for (const rec of records) {
    if (rec.type !== "assistant" || !rec.message?.id) continue;
    const id = rec.message.id;
    let merged = byId.get(id);
    if (!merged) {
      merged = {
        messageId: id,
        model: rec.message.model ?? "",
        parts: [],
        rawToolUses: [],
        timestampMs: parseTimestampMs(rec.timestamp),
      };
      byId.set(id, merged);
      order.push(id);
    }
    // Track latest model / usage / stop_reason across chunks.
    if (rec.message.model && !merged.model) merged.model = rec.message.model;
    if (rec.message.usage) merged.usage = rec.message.usage;
    if (rec.message.stop_reason) merged.stopReason = rec.message.stop_reason;

    if (Array.isArray(rec.message.content)) {
      for (const p of rec.message.content) {
        const part = mapAssistantContentPart(p);
        if (part) merged.parts.push(part);
        if (
          p &&
          typeof p === "object" &&
          (p as Record<string, unknown>).type === "tool_use"
        ) {
          const obj = p as Record<string, unknown>;
          merged.rawToolUses.push({
            id: typeof obj.id === "string" ? obj.id : "",
            name: typeof obj.name === "string" ? obj.name : "",
            input: obj.input ?? {},
          });
        }
      }
    }
  }
  return order.map((id) => byId.get(id)!);
}

function buildInputMessages(
  recordsBeforeAssistant: RawRecord[],
): InputMessage[] {
  // Keep "user" + "system" rolled into the prompt history; skip meta caveats.
  const out: InputMessage[] = [];
  for (const rec of recordsBeforeAssistant) {
    if (rec.type === "system") continue; // System "Skill conflict detected" etc. are meta noise.
    if (rec.type === "user") {
      const role = rec.message?.role ?? "user";
      const parts = mapUserContent(rec.message?.content);
      if (parts.length > 0) {
        out.push({ role, parts });
      }
    }
  }
  return out;
}

function buildOutputMessage(merged: MergedAssistantResponse): OutputMessage {
  return {
    role: "assistant",
    parts: merged.parts,
    finishReason: merged.stopReason ?? "stop",
  };
}

function extractSystemInstruction(
  records: RawRecord[],
): MessagePart[] | undefined {
  // Long-form interactive sessions: skill / agent prompts arrive as isMeta=true
  // with very large content. Use the first such record verbatim.
  for (const rec of records) {
    if (rec.type !== "user" || !rec.isMeta) continue;
    const content = rec.message?.content;
    if (typeof content === "string" && content.length > 200) {
      return [{ type: "text", content }];
    }
  }
  // Short-form (`qodercli -p ...`) sessions: the first user record carries a
  // `<hook_context>` block synthesized by qodercli. Capture it as system context.
  for (const rec of records) {
    if (rec.type !== "user") continue;
    const content = rec.message?.content;
    if (typeof content === "string" && content.includes("<hook_context>")) {
      return [{ type: "text", content }];
    }
    break; // Only inspect the very first user record.
  }
  // Final fallback: a synthetic identifier so the AGENT span always carries
  // gen_ai.system_instructions per the ARMS GenAI semconv.
  return [
    {
      type: "text",
      content:
        "qodercli — system prompt is owned by the agent runtime and is not exposed in the transcript",
    },
  ];
}

function extractToolDefinitions(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): ToolDefinition[] {
  const seen = new Map<string, FunctionToolDefinition>();
  for (const t of toolUses) {
    if (!t.name || seen.has(t.name)) continue;
    seen.set(t.name, {
      type: "function",
      name: t.name,
      description: null,
      parameters: null,
    });
  }
  return Array.from(seen.values());
}

export function parseTranscript(filePath: string): TranscriptData {
  const empty: TranscriptData = {
    sessionId: "",
    model: "",
    modelProvider: "unknown",
    totalUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    },
    tokenEvents: [],
    toolCalls: [],
  };

  if (!filePath || !fs.existsSync(filePath)) return empty;

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return empty;
  }

  const records: RawRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawRecord);
    } catch {
      // skip malformed line (transcript may be mid-write)
    }
  }
  if (records.length === 0) return empty;

  // Group assistant chunks by message.id, in order seen.
  const merged = mergeAssistantChunks(records);

  // Build per-LLM-call TokenEvents with the input history "up to" each assistant response.
  const tokenEvents: TokenEvent[] = [];
  const allToolUses: Array<{ id: string; name: string; input: unknown }> = [];

  let runningInput: RawRecord[] = [];
  let nextMergedIdx = 0;
  // Walk records; whenever we hit an assistant record, ensure we've emitted
  // a TokenEvent for the corresponding merged response (once per messageId).
  const seenMergedIds = new Set<string>();
  for (const rec of records) {
    if (rec.type === "assistant") {
      const id = rec.message?.id;
      if (!id || seenMergedIds.has(id)) continue;
      // Find the merged response for this id.
      const m = merged.find((x) => x.messageId === id);
      if (!m) continue;
      seenMergedIds.add(id);

      const inputMessages = buildInputMessages(runningInput);
      const outputMessage = buildOutputMessage(m);
      const toolUseIds = m.rawToolUses.map((t) => t.id);
      const usage = m.usage ?? {};

      const inputTokens = asNumber(usage["input_tokens"]);
      const outputTokens = asNumber(usage["output_tokens"]);
      const cacheCreationInputTokens =
        asNumber(usage["cache_creation_input_tokens"]) ?? null;
      const cacheReadInputTokens =
        asNumber(usage["cache_read_input_tokens"]) ?? null;
      const total =
        inputTokens != null && outputTokens != null
          ? inputTokens + outputTokens
          : null;

      tokenEvents.push({
        messageId: id,
        model: m.model || "",
        providerName: inferProvider(m.model || "", toolUseIds),
        timestampMs: m.timestampMs,
        finishReasons: m.stopReason ? [m.stopReason] : [],
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        totalTokens: total,
        inputMessages,
        outputMessages: [outputMessage],
        toolUses: m.rawToolUses,
        finalized: !!m.stopReason,
      });

      for (const t of m.rawToolUses) allToolUses.push(t);
      nextMergedIdx++;
    }
    // Always feed user / system / assistant records into the running history
    // so the *next* assistant response can see prior turns.
    runningInput.push(rec);
  }

  // Pair tool_use → tool_result by tool_use_id from user records.
  const toolCallMap = new Map<
    string,
    {
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      toolResponse: unknown;
      isError: boolean;
      requestedAtMs: number;
      completedAtMs: number | null;
    }
  >();
  // First pass: register tool uses (assistant side).
  for (const rec of records) {
    if (rec.type !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (
        p &&
        typeof p === "object" &&
        (p as Record<string, unknown>).type === "tool_use"
      ) {
        const obj = p as Record<string, unknown>;
        const id = typeof obj.id === "string" ? obj.id : "";
        if (!id) continue;
        if (toolCallMap.has(id)) continue;
        toolCallMap.set(id, {
          toolUseId: id,
          toolName: typeof obj.name === "string" ? obj.name : "",
          toolInput: obj.input ?? {},
          toolResponse: null,
          isError: false,
          requestedAtMs: parseTimestampMs(rec.timestamp),
          completedAtMs: null,
        });
      }
    }
  }
  // Second pass: attach tool_result (user side).
  for (const rec of records) {
    if (rec.type !== "user") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (
        !p ||
        typeof p !== "object" ||
        (p as Record<string, unknown>).type !== "tool_result"
      ) {
        continue;
      }
      const obj = p as Record<string, unknown>;
      const id = typeof obj.tool_use_id === "string" ? obj.tool_use_id : "";
      if (!id) continue;
      const existing = toolCallMap.get(id);
      if (!existing) continue;
      existing.toolResponse = obj.content ?? null;
      existing.isError = obj.is_error === true;
      existing.completedAtMs = parseTimestampMs(rec.timestamp);
    }
  }

  // Aggregate totals.
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
  };
  for (const ev of tokenEvents) {
    if (ev.inputTokens != null) totals.inputTokens += ev.inputTokens;
    if (ev.outputTokens != null) totals.outputTokens += ev.outputTokens;
    if (ev.cacheCreationInputTokens != null)
      totals.cacheCreationInputTokens += ev.cacheCreationInputTokens;
    if (ev.cacheReadInputTokens != null)
      totals.cacheReadInputTokens += ev.cacheReadInputTokens;
    if (ev.totalTokens != null) totals.totalTokens += ev.totalTokens;
  }

  // Last assistant message (for ENTRY output_messages).
  let finalAssistantMessage: OutputMessage | undefined;
  for (let i = tokenEvents.length - 1; i >= 0; i--) {
    if (tokenEvents[i]!.outputMessages.length > 0) {
      finalAssistantMessage = tokenEvents[i]!.outputMessages[0];
      break;
    }
  }

  const lastModel = tokenEvents[tokenEvents.length - 1]?.model ?? "";
  // Prefer the first concrete provider we inferred — the final assistant
  // response often has no tool_use so its provider falls back to "unknown",
  // but earlier calls may have correctly identified the provider.
  const aggregatedProvider =
    tokenEvents.find(
      (e) => e.providerName && e.providerName !== "unknown",
    )?.providerName ??
    tokenEvents[tokenEvents.length - 1]?.providerName ??
    "unknown";

  return {
    sessionId: records[0]?.sessionId ?? "",
    model: lastModel,
    modelProvider: aggregatedProvider,
    totalUsage: totals,
    tokenEvents,
    systemInstruction: extractSystemInstruction(records),
    toolDefinitions: extractToolDefinitions(allToolUses),
    toolCalls: Array.from(toolCallMap.values()).sort(
      (a, b) => a.requestedAtMs - b.requestedAtMs,
    ),
    finalAssistantMessage,
  };
}
