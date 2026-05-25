import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const STATE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opentelemetry.instrumentation.codex",
  "sessions",
);

// --- Event types ---

export interface SessionStartEvent {
  type: "session_start";
  timestamp: number;
  source: string;
  model: string;
}

export interface UserPromptSubmitEvent {
  type: "user_prompt_submit";
  timestamp: number;
  prompt: string;
  turn_id: string;
  model: string;
}

export interface PreToolUseEvent {
  type: "pre_tool_use";
  timestamp: number;
  turn_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

export interface PostToolUseEvent {
  type: "post_tool_use";
  timestamp: number;
  turn_id: string;
  tool_name: string;
  tool_response: unknown;
  tool_use_id: string;
}

export interface StopEvent {
  type: "stop";
  timestamp: number;
  turn_id: string;
  last_assistant_message?: string;
  model: string;
}

export type SessionEvent =
  | SessionStartEvent
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | StopEvent;

// --- Session state ---

export interface SessionState {
  session_id: string;
  model: string;
  start_time: number;
  events: SessionEvent[];
  transcript_path?: string;
  // codex transcript 已消费字节偏移(跨 turn 持久化)。
  // 每次 cmdStop 后固化为下次 parseTranscript 的起始位置。
  transcript_offset?: number;
  // 上一次已采纳的 last_token_usage(跨 turn 持久化)。
  // 用于增量读取下识别 codex 心跳事件(跨 turn 重发同一份 last_token_usage)。
  transcript_last_token_usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
  };
}

// --- Turn (per-turn grouping for replay) ---

export interface Turn {
  turn_id: string;
  prompt: string;
  model: string;
  start_time: number;
  end_time: number;
  last_assistant_message?: string;
  events: SessionEvent[];
}

// --- File helpers ---

function sanitizeSessionId(sessionId: string): string {
  const base = path.basename(String(sessionId));
  return base.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function ensureStateDir(): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

function stateFile(sessionId: string): string {
  return path.join(ensureStateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

export function loadState(sessionId: string): SessionState {
  const sf = stateFile(sessionId);
  if (fs.existsSync(sf)) {
    try {
      return JSON.parse(fs.readFileSync(sf, "utf-8")) as SessionState;
    } catch {
      // corrupted — start fresh
    }
  }
  return {
    session_id: sessionId,
    model: "unknown",
    start_time: Date.now() / 1000,
    events: [],
  };
}

export function saveState(sessionId: string, state: SessionState): void {
  const dest = stateFile(sessionId);
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${sanitizeSessionId(sessionId)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function clearState(sessionId: string): void {
  const sf = stateFile(sessionId);
  try { fs.unlinkSync(sf); } catch {}
}

// --- Turn splitting ---

export function splitIntoTurns(state: SessionState): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const stopEvent = state.events.find((e) => e.type === "stop") as StopEvent | undefined;

  for (const event of state.events) {
    if (event.type === "session_start") continue;

    if (event.type === "user_prompt_submit") {
      if (current) {
        current.end_time = event.timestamp;
        turns.push(current);
      }
      current = {
        turn_id: event.turn_id,
        prompt: event.prompt,
        model: event.model,
        start_time: event.timestamp,
        end_time: event.timestamp,
        events: [],
      };
      continue;
    }

    if (event.type === "stop") {
      if (current) {
        current.end_time = event.timestamp;
        current.last_assistant_message = event.last_assistant_message;
        if (event.model) current.model = event.model;
      }
      continue;
    }

    if (current) {
      current.events.push(event);
      current.end_time = event.timestamp;
    }
  }

  if (current) {
    if (stopEvent) {
      current.end_time = stopEvent.timestamp;
      current.last_assistant_message = stopEvent.last_assistant_message;
    }
    turns.push(current);
  }

  return turns;
}
