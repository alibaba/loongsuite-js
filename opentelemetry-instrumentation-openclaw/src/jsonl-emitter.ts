// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "./types.js";

const AGENT_TYPE = "openclaw";

export interface JsonlEmitterOptions {
  logDir: string;
  filenameFormat?: "hook";
  captureMessageContent?: boolean;
  logger: OpenClawPluginApi["logger"];
}

type EventName = "llm.request" | "llm.response" | "tool.call" | "tool.result";

export interface EventTRecord {
  time_unix_nano: string;
  "event.id": string;
  "event.name": EventName;
  "session.id": string;
  "user.id": string;
  "agent.type": "openclaw";
  "turn.id"?: string;
  "step.id"?: string;
  "gen_ai.provider.name"?: string;
  "gen_ai.request.model"?: string;
  "gen_ai.response.model"?: string;
  "gen_ai.usage.input_tokens"?: number;
  "gen_ai.usage.output_tokens"?: number;
  "gen_ai.usage.cache_read.input_tokens"?: number;
  "gen_ai.usage.total_tokens"?: number;
  "gen_ai.input.messages"?: unknown;
  "gen_ai.output.messages"?: unknown;
  "gen_ai.tool.name"?: string;
  "gen_ai.tool.call.id"?: string;
  "gen_ai.tool.call.arguments"?: unknown;
  "gen_ai.tool.call.result"?: unknown;
  "tool.result.duration"?: number;
  "tool.result.status"?: string;
  "error.type"?: string;
  "error.message"?: string;
  "response.finish_reasons"?: string;
}

export interface RecordBaseContext {
  sessionId: string;
  userId?: string;
  runId?: string;
  stepId?: string | number;
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function nowUnixNano(): string {
  return String(BigInt(Date.now()) * 1_000_000n);
}

function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fallbackUserId(): string {
  try {
    return os.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

function pruneUndefined<T extends object>(obj: T): T {
  const o = obj as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) {
      delete o[key];
    }
  }
  return obj;
}

function makeRecordBase(
  ctx: RecordBaseContext,
  eventName: EventName,
): EventTRecord {
  const rec: EventTRecord = {
    time_unix_nano: nowUnixNano(),
    "event.id": randomUUID(),
    "event.name": eventName,
    "session.id": ctx.sessionId || "",
    "user.id": ctx.userId || fallbackUserId(),
    "agent.type": AGENT_TYPE,
  };
  if (ctx.runId) rec["turn.id"] = ctx.runId;
  if (ctx.stepId !== undefined) rec["step.id"] = String(ctx.stepId);
  return rec;
}

export interface LlmRequestInput {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt?: string;
  historyMessages?: Array<{ role: string; content: unknown }>;
}

export function buildLlmRequestRecord(
  ctx: RecordBaseContext,
  input: LlmRequestInput,
  captureMessageContent: boolean,
): EventTRecord {
  const rec = makeRecordBase(ctx, "llm.request");
  if (input.provider) rec["gen_ai.provider.name"] = input.provider;
  if (input.model) rec["gen_ai.request.model"] = input.model;
  if (captureMessageContent) {
    const messages: unknown[] = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    if (Array.isArray(input.historyMessages)) {
      messages.push(...input.historyMessages);
    }
    if (input.prompt) {
      messages.push({ role: "user", content: input.prompt });
    }
    if (messages.length > 0) {
      rec["gen_ai.input.messages"] = messages;
    }
  }
  return pruneUndefined(rec);
}

export interface LlmResponseInput {
  provider?: string;
  model?: string;
  assistantTexts?: string[];
  assistantContent?: unknown;
  finishReason?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export function buildLlmResponseRecord(
  ctx: RecordBaseContext,
  input: LlmResponseInput,
  captureMessageContent: boolean,
): EventTRecord {
  const rec = makeRecordBase(ctx, "llm.response");
  if (input.provider) rec["gen_ai.provider.name"] = input.provider;
  if (input.model) rec["gen_ai.response.model"] = input.model;
  if (input.usage) {
    if (typeof input.usage.input === "number") {
      rec["gen_ai.usage.input_tokens"] = input.usage.input;
    }
    if (typeof input.usage.output === "number") {
      rec["gen_ai.usage.output_tokens"] = input.usage.output;
    }
    if (typeof input.usage.cacheRead === "number") {
      rec["gen_ai.usage.cache_read.input_tokens"] = input.usage.cacheRead;
    }
    if (typeof input.usage.total === "number") {
      rec["gen_ai.usage.total_tokens"] = input.usage.total;
    } else if (
      typeof input.usage.input === "number"
      && typeof input.usage.output === "number"
    ) {
      rec["gen_ai.usage.total_tokens"] = input.usage.input + input.usage.output;
    }
  }
  if (input.finishReason) rec["response.finish_reasons"] = input.finishReason;
  if (captureMessageContent) {
    const content =
      input.assistantContent !== undefined
        ? input.assistantContent
        : input.assistantTexts && input.assistantTexts.length > 0
          ? input.assistantTexts.map((t) => ({ role: "assistant", content: t }))
          : undefined;
    if (content !== undefined) {
      rec["gen_ai.output.messages"] = content;
    }
  }
  return pruneUndefined(rec);
}

export function buildToolCallRecord(
  ctx: RecordBaseContext,
  toolName: string,
  toolCallId: string,
  args: unknown,
): EventTRecord {
  const rec = makeRecordBase(ctx, "tool.call");
  rec["gen_ai.tool.name"] = toolName;
  rec["gen_ai.tool.call.id"] = toolCallId;
  if (args !== undefined) rec["gen_ai.tool.call.arguments"] = args;
  return pruneUndefined(rec);
}

export interface ToolResultInput {
  result?: unknown;
  durationMs?: number;
  error?: string;
}

export function buildToolResultRecord(
  ctx: RecordBaseContext,
  toolName: string,
  toolCallId: string,
  input: ToolResultInput,
): EventTRecord {
  const rec = makeRecordBase(ctx, "tool.result");
  rec["gen_ai.tool.name"] = toolName;
  rec["gen_ai.tool.call.id"] = toolCallId;
  if (input.error) {
    rec["error.type"] = "tool_error";
    rec["error.message"] = input.error;
    rec["tool.result.status"] = "error";
  } else {
    rec["tool.result.status"] = "ok";
    if (input.result !== undefined) {
      rec["gen_ai.tool.call.result"] = input.result;
    }
  }
  if (typeof input.durationMs === "number") {
    rec["tool.result.duration"] = input.durationMs;
  }
  return pruneUndefined(rec);
}

export class JsonlEmitter {
  private readonly logDir: string;
  private readonly filenameFormat: "hook";
  private readonly logger: OpenClawPluginApi["logger"];
  private warnedDirCreate = false;

  readonly captureMessageContent: boolean;

  constructor(opts: JsonlEmitterOptions) {
    this.logDir = expandHome(opts.logDir);
    this.filenameFormat = opts.filenameFormat || "hook";
    this.captureMessageContent = opts.captureMessageContent || false;
    this.logger = opts.logger;
  }

  private ensureDir(): boolean {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      return true;
    } catch (err) {
      if (!this.warnedDirCreate) {
        this.warnedDirCreate = true;
        this.logger.warn(
          `[ArmsTrace] JSONL emitter: failed to create log dir ${this.logDir}: ${String(err)}`,
        );
      }
      return false;
    }
  }

  private currentLogFile(): string {
    // filenameFormat 'hook' → <agent>-YYYY-MM-DD.jsonl, matches pilot BaseHookInput
    return path.join(this.logDir, `${AGENT_TYPE}-${todayDateString()}.jsonl`);
  }

  emit(record: EventTRecord): void {
    if (!this.ensureDir()) return;
    const filePath = this.currentLogFile();
    try {
      const line = JSON.stringify(record) + "\n";
      fs.appendFileSync(filePath, line, "utf-8");
    } catch (err) {
      this.logger.warn(
        `[ArmsTrace] JSONL emitter: write failed for ${filePath}: ${String(err)}`,
      );
    }
  }
}

/**
 * Read shared otel-config.json located at <homeDir>/.openclaw/otel-config.json.
 * Returns an object with possibly-set log_enabled / log_dir / log_filename_format /
 * captureMessageContent / debug. Missing file or parse errors return {}.
 */
export function readSharedOtelConfig(
  configPath: string,
): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(expandHome(configPath), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
