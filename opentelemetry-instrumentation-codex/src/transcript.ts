import * as fs from "node:fs";
import type { MessagePart, ToolDefinition } from "@loongsuite/opentelemetry-util-genai";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface TranscriptData {
  model: string;
  modelProvider: string;
  // 扁平视图(按 transcript 顺序),保留兼容 + fallback 用途
  tokenEvents: TokenUsage[];
  // 按 turn_id 分组(主消费路径)
  // turn_id 由 codex transcript 中的 task_started / turn_context 事件提供
  tokenEventsByTurn: Map<string, TokenUsage[]>;
  totalUsage: TokenUsage | null;
  // gen_ai.system_instructions 数据源:
  //   - session_meta.payload.base_instructions.text(主 system prompt)
  //   - turn_context.payload.developer_instructions(每 turn 可更新,取最后一次)
  systemInstruction?: MessagePart[];
  // gen_ai.tool.definitions 数据源:
  //   - session_meta.payload.dynamic_tools[](codex 动态注册工具,如 automation_update;
  //     不含 shell/apply_patch 等内嵌在 system prompt 里的"伪工具")
  toolDefinitions?: ToolDefinition[];
  // 增量读取的下一个字节偏移(供下次 cmdStop 使用)
  nextOffset: number;
  // 本次解析中最后一条采纳的 last_token_usage(供下次 cmdStop 跨调用心跳去重)
  lastEmittedUsage: TokenUsage | null;
}

interface DynamicToolEntry {
  namespace?: string;
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

function mapDynamicTool(t: DynamicToolEntry): ToolDefinition | null {
  const rawName = typeof t.name === "string" ? t.name : "";
  if (!rawName) return null;
  const ns = typeof t.namespace === "string" ? t.namespace : "";
  return {
    type: "function",
    name: ns ? `${ns}/${rawName}` : rawName,
    description: typeof t.description === "string" ? t.description : null,
    parameters: t.inputSchema ?? {},
  };
}

function parseTokenUsage(raw: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: Number(raw["input_tokens"] || 0),
    outputTokens: Number(raw["output_tokens"] || 0),
    cachedInputTokens: Number(raw["cached_input_tokens"] || 0),
    reasoningOutputTokens: Number(raw["reasoning_output_tokens"] || 0),
    totalTokens: Number(raw["total_tokens"] || 0),
  };
}

// 判断两个 TokenUsage 在"内容"上是否相等(用于跨 turn 心跳去重)。
// codex 在 turn 间隙会重发与上一次相同的 last_token_usage 心跳事件,
// 只看四个数值字段就能识别。
function tokenUsageEqual(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens &&
    a.totalTokens === b.totalTokens
  );
}

/**
 * 解析 codex transcript(rollout-*.jsonl)。
 *
 * @param transcriptPath transcript 文件绝对路径
 * @param byteOffset     起始字节偏移(>0 时增量读取,跳过前面已消费过的内容)
 *
 * 返回结构含两个 token 视图:
 *  - tokenEvents:扁平有序列表(兼容老调用方)
 *  - tokenEventsByTurn:按 turn_id 分组(消费方应优先使用)
 *
 * 增量读取约定:
 *  - 调用方持久化 `nextOffset`,下次调用传入即可只读到新增字节。
 *  - byteOffset >= 文件大小时返回空数据 + 不变的 nextOffset。
 */
export function parseTranscript(
  transcriptPath: string,
  byteOffset: number = 0,
  initialLastUsage: TokenUsage | null = null,
): TranscriptData | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let content: string;
  let fileSize: number;
  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    if (byteOffset >= fileSize) {
      return {
        model: "unknown",
        modelProvider: "openai",
        tokenEvents: [],
        tokenEventsByTurn: new Map(),
        totalUsage: null,
        nextOffset: byteOffset,
        lastEmittedUsage: initialLastUsage,
      };
    }

    const readFrom = Math.max(byteOffset, 0);
    if (readFrom > 0) {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const readLen = fileSize - readFrom;
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readFrom);
        content = buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(transcriptPath, "utf-8");
    }
  } catch {
    return null;
  }

  let model = "unknown";
  let modelProvider = "openai";
  const tokenEvents: TokenUsage[] = [];
  const tokenEventsByTurn = new Map<string, TokenUsage[]>();
  let lastTotalUsage: TokenUsage | null = null;
  let baseInstructionsText = "";
  let lastDeveloperInstructions = "";
  const toolDefs: ToolDefinition[] = [];

  // 当前正在处理的 turn_id:
  //   - 由 event_msg.task_started / turn_context 事件设置
  //   - 后续遇到的 token_count 事件归入此 turn,直到下一个 task_started 重置
  let currentTurnId: string | null = null;

  // 用于跨 turn 心跳去重的"上一条已采纳的 last_token_usage"。
  // codex 在 turn 间会重发与上一次相同的 last_token_usage 心跳,
  // 这些心跳无论落在哪个 turn 桶里,值都与全局上一条相同 → 直接跳过。
  // 增量读取时,初始值由调用方从 state.transcript_last_token_usage 传入,
  // 确保跨 cmdStop 边界也能识别心跳。
  let lastEmittedUsage: TokenUsage | null = initialLastUsage;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = entry["type"] as string | undefined;
    const payload = entry["payload"] as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (entryType === "session_meta") {
      const mp = payload["model_provider"];
      if (typeof mp === "string" && mp) modelProvider = mp;

      const bi = payload["base_instructions"];
      if (bi && typeof bi === "object") {
        const text = (bi as Record<string, unknown>)["text"];
        if (typeof text === "string" && text) baseInstructionsText = text;
      } else if (typeof bi === "string" && bi) {
        baseInstructionsText = bi;
      }

      const dynamicTools = payload["dynamic_tools"];
      if (Array.isArray(dynamicTools)) {
        for (const t of dynamicTools) {
          if (!t || typeof t !== "object") continue;
          const mapped = mapDynamicTool(t as DynamicToolEntry);
          if (mapped) toolDefs.push(mapped);
        }
      }
    } else if (entryType === "turn_context") {
      const m = payload["model"];
      if (typeof m === "string" && m) model = m;

      const di = payload["developer_instructions"];
      if (typeof di === "string" && di) lastDeveloperInstructions = di;

      const tid = payload["turn_id"];
      if (typeof tid === "string" && tid) currentTurnId = tid;
    } else if (entryType === "event_msg") {
      const payloadType = payload["type"] as string | undefined;

      if (payloadType === "task_started") {
        const tid = payload["turn_id"];
        if (typeof tid === "string" && tid) currentTurnId = tid;
        continue;
      }

      if (payloadType === "token_count") {
        const info = payload["info"] as Record<string, unknown> | null;
        if (!info) continue;

        const lastUsage = info["last_token_usage"] as Record<string, unknown> | undefined;
        if (lastUsage) {
          const usage = parseTokenUsage(lastUsage);
          // 跨 turn 全局去重:与上一条已采纳的 last_token_usage 相同 → 心跳事件,跳过
          if (lastEmittedUsage && tokenUsageEqual(lastEmittedUsage, usage)) {
            // skip heartbeat
          } else {
            // turn_id 缺失时归入特殊桶 ""(理论上不会发生;防御性处理)
            const tid = currentTurnId ?? "";
            tokenEvents.push(usage);
            const list = tokenEventsByTurn.get(tid);
            if (list) {
              list.push(usage);
            } else {
              tokenEventsByTurn.set(tid, [usage]);
            }
            lastEmittedUsage = usage;
          }
        }

        const totalUsage = info["total_token_usage"] as Record<string, unknown> | undefined;
        if (totalUsage) {
          lastTotalUsage = parseTokenUsage(totalUsage);
        }
      }
    }
  }

  const systemInstruction: MessagePart[] = [];
  if (baseInstructionsText) {
    systemInstruction.push({ type: "text", content: baseInstructionsText });
  }
  if (lastDeveloperInstructions) {
    systemInstruction.push({ type: "text", content: lastDeveloperInstructions });
  }

  const hasContent =
    tokenEvents.length > 0 ||
    !!lastTotalUsage ||
    systemInstruction.length > 0 ||
    toolDefs.length > 0;
  if (!hasContent) {
    // 没有任何业务内容时仍返回 nextOffset,以便调用方推进偏移
    return {
      model,
      modelProvider,
      tokenEvents: [],
      tokenEventsByTurn: new Map(),
      totalUsage: null,
      nextOffset: fileSize,
      lastEmittedUsage,
    };
  }

  return {
    model,
    modelProvider,
    tokenEvents,
    tokenEventsByTurn,
    totalUsage: lastTotalUsage,
    systemInstruction: systemInstruction.length > 0 ? systemInstruction : undefined,
    toolDefinitions: toolDefs.length > 0 ? toolDefs : undefined,
    nextOffset: fileSize,
    lastEmittedUsage,
  };
}
