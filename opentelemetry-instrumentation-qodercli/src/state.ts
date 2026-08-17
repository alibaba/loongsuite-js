// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const STATE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opentelemetry.instrumentation.qodercli",
  "sessions",
);

export type HookEventType =
  | "session_start"
  | "user_prompt_submit"
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_use_failure"
  | "stop"
  | "subagent_start"
  | "subagent_stop"
  | "pre_compact"
  | "notification"
  | "session_end";

interface BaseEvent {
  type: HookEventType;
  timestampSec: number;
  raw?: Record<string, unknown>;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  source?: string;
  model?: string;
}

export interface UserPromptSubmitEvent extends BaseEvent {
  type: "user_prompt_submit";
  promptId?: string;
  prompt: string;
}

export interface PreToolUseEvent extends BaseEvent {
  type: "pre_tool_use";
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

export interface PostToolUseEvent extends BaseEvent {
  type: "post_tool_use";
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  toolResponse: unknown;
  isError?: boolean;
  errorMessage?: string;
}

export interface PostToolUseFailureEvent extends BaseEvent {
  type: "post_tool_use_failure";
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
  errorMessage: string;
  isInterrupt?: boolean;
}

export interface StopEvent extends BaseEvent {
  type: "stop";
}

export interface SubagentStartEvent extends BaseEvent {
  type: "subagent_start";
  agentId: string;
  agentType?: string;
  parentToolUseId?: string;
}

export interface SubagentStopEvent extends BaseEvent {
  type: "subagent_stop";
  agentId: string;
  agentType?: string;
}

export interface PreCompactEvent extends BaseEvent {
  type: "pre_compact";
  trigger?: "manual" | "auto" | string;
  customInstructions?: string;
}

export interface NotificationEvent extends BaseEvent {
  type: "notification";
  title?: string;
  message?: string;
  notificationType?: string;
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  reason?: string;
}

export type SessionEvent =
  | SessionStartEvent
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PostToolUseFailureEvent
  | StopEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | PreCompactEvent
  | NotificationEvent
  | SessionEndEvent;

export interface SessionState {
  sessionId: string;
  cwd: string;
  events: SessionEvent[];
  createdAt: number;
  lastActivityAt: number;
  /** Indices of turns in `splitIntoTurns()` output that have already been replayed/exported. */
  exportedTurnIndices: number[];
}

export interface Turn {
  /** Index in the SessionState event array where this turn started. */
  startIdx: number;
  /** Index of the user_prompt_submit event opening this turn. */
  userPromptIdx: number;
  promptId?: string;
  userPromptText: string;
  events: SessionEvent[];
  startedAt: number;
  endedAt: number | null;
  /** Whether the turn was closed by a stop / session_end event. */
  closed: boolean;
}

function ensureDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function statePath(sessionId: string): string {
  return path.join(STATE_DIR, `${sanitize(sessionId)}.json`);
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function loadState(sessionId: string): SessionState | null {
  try {
    const p = statePath(sessionId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed || typeof parsed !== "object") return null;
    parsed.events = Array.isArray(parsed.events) ? parsed.events : [];
    parsed.exportedTurnIndices = Array.isArray(parsed.exportedTurnIndices)
      ? parsed.exportedTurnIndices
      : [];
    return parsed;
  } catch {
    return null;
  }
}

export function saveStateAtomic(state: SessionState): void {
  ensureDir();
  const p = statePath(state.sessionId);
  const tmp = `${p}.${process.pid}.tmp`;
  state.lastActivityAt = nowSec();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 0), "utf-8");
  fs.renameSync(tmp, p);
}

export function clearState(sessionId: string): void {
  try {
    fs.unlinkSync(statePath(sessionId));
  } catch {
    /* ignore */
  }
}

export function newSessionState(sessionId: string, cwd: string): SessionState {
  const t = nowSec();
  return {
    sessionId,
    cwd,
    events: [],
    createdAt: t,
    lastActivityAt: t,
    exportedTurnIndices: [],
  };
}

export function appendEvent(state: SessionState, event: SessionEvent): void {
  state.events.push(event);
  state.lastActivityAt = event.timestampSec;
}

/**
 * Split a session's events into per-turn slices.
 *
 * Boundary rule:
 *   A turn opens at each `user_prompt_submit` event.
 *   A turn closes at the next `user_prompt_submit`, or at a `stop` / `session_end`.
 *   Events before the first user_prompt_submit are dropped (warmup noise).
 */
export function splitIntoTurns(state: SessionState): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (let i = 0; i < state.events.length; i++) {
    const ev = state.events[i]!;

    if (ev.type === "user_prompt_submit") {
      if (current) {
        current.endedAt = ev.timestampSec;
        current.closed = true;
        turns.push(current);
      }
      current = {
        startIdx: i,
        userPromptIdx: i,
        promptId: ev.promptId,
        userPromptText: ev.prompt,
        events: [ev],
        startedAt: ev.timestampSec,
        endedAt: null,
        closed: false,
      };
      continue;
    }

    if (!current) continue;

    current.events.push(ev);

    if (ev.type === "stop" || ev.type === "session_end") {
      current.endedAt = ev.timestampSec;
      current.closed = true;
      turns.push(current);
      current = null;
    }
  }

  if (current) {
    // Open turn — include it but mark as not closed; replay can still emit.
    turns.push(current);
  }

  return turns;
}

export function nowSec(): number {
  return Date.now() / 1000;
}

/**
 * Used by SubagentStop handling to read+delete the subagent's child state file
 * (kept under a separate id like `<parentSession>__<subagentId>`).
 */
export function readAndDeleteChildState(
  childKey: string,
): SessionState | null {
  const p = statePath(childKey);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as SessionState;
    fs.unlinkSync(p);
    return parsed;
  } catch {
    return null;
  }
}
