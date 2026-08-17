// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import type {
  HookEventType,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
  SessionEvent,
  UserPromptSubmitEvent,
} from "./state.js";
import { nowSec } from "./state.js";

export const MAX_CONTENT_LENGTH = 1_048_576; // 1 MB

const TRUNC_MARKER = "...[truncated]";

export function truncate(s: string, max: number = MAX_CONTENT_LENGTH): string {
  if (s.length <= max) return s;
  return s.slice(0, max - TRUNC_MARKER.length) + TRUNC_MARKER;
}

/** Build a short, human-readable title for a TOOL span. */
export function createToolTitle(
  toolName: string,
  toolInput: unknown,
): string {
  if (!toolName) return "tool";

  if (
    toolInput &&
    typeof toolInput === "object" &&
    !Array.isArray(toolInput)
  ) {
    const input = toolInput as Record<string, unknown>;
    const fields = ["command", "file_path", "path", "pattern", "url", "query"];
    for (const f of fields) {
      const v = input[f];
      if (typeof v === "string" && v.trim().length > 0) {
        const short = v.length > 80 ? v.slice(0, 77) + "..." : v;
        return `${toolName}: ${short}`;
      }
    }
  }

  return toolName;
}

/**
 * Normalize a raw hook stdin JSON payload into a SessionEvent.
 *
 * The qoder-cli docs (./qoder-cli/钩子.md) define each event's stdin shape;
 * we map it onto our internal discriminated union.
 */
export function createEventData(
  hookEventName: string,
  raw: Record<string, unknown>,
): SessionEvent | null {
  const ts = nowSec();

  // qoder-cli sends `hook_event_name` as a CamelCase event name.
  switch (hookEventName) {
    case "SessionStart":
      return {
        type: "session_start",
        timestampSec: ts,
        source: typeof raw.source === "string" ? raw.source : undefined,
        model: typeof raw.model === "string" ? raw.model : undefined,
        raw,
      };

    case "UserPromptSubmit": {
      const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
      const event: UserPromptSubmitEvent = {
        type: "user_prompt_submit",
        timestampSec: ts,
        prompt: truncate(prompt),
        raw,
      };
      if (typeof raw.prompt_id === "string") {
        event.promptId = raw.prompt_id;
      }
      return event;
    }

    case "PreToolUse": {
      const event: PreToolUseEvent = {
        type: "pre_tool_use",
        timestampSec: ts,
        toolName: typeof raw.tool_name === "string" ? raw.tool_name : "",
        toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : "",
        toolInput: raw.tool_input ?? {},
        raw,
      };
      return event;
    }

    case "PostToolUse": {
      const event: PostToolUseEvent = {
        type: "post_tool_use",
        timestampSec: ts,
        toolName: typeof raw.tool_name === "string" ? raw.tool_name : "",
        toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : "",
        toolInput: raw.tool_input ?? {},
        toolResponse: raw.tool_response ?? null,
        raw,
      };
      return event;
    }

    case "PostToolUseFailure": {
      const event: PostToolUseFailureEvent = {
        type: "post_tool_use_failure",
        timestampSec: ts,
        toolName: typeof raw.tool_name === "string" ? raw.tool_name : "",
        toolUseId: typeof raw.tool_use_id === "string" ? raw.tool_use_id : "",
        toolInput: raw.tool_input ?? {},
        errorMessage:
          typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error),
        isInterrupt: raw.is_interrupt === true,
        raw,
      };
      return event;
    }

    case "Stop":
      return { type: "stop", timestampSec: ts, raw };

    case "SubagentStart":
      return {
        type: "subagent_start",
        timestampSec: ts,
        agentId: typeof raw.agent_id === "string" ? raw.agent_id : "",
        agentType:
          typeof raw.agent_type === "string" ? raw.agent_type : undefined,
        raw,
      };

    case "SubagentStop":
      return {
        type: "subagent_stop",
        timestampSec: ts,
        agentId: typeof raw.agent_id === "string" ? raw.agent_id : "",
        agentType:
          typeof raw.agent_type === "string" ? raw.agent_type : undefined,
        raw,
      };

    case "PreCompact":
      return {
        type: "pre_compact",
        timestampSec: ts,
        trigger:
          typeof raw.trigger === "string"
            ? (raw.trigger as "manual" | "auto")
            : undefined,
        customInstructions:
          typeof raw.custom_instructions === "string"
            ? raw.custom_instructions
            : undefined,
        raw,
      };

    case "Notification":
      return {
        type: "notification",
        timestampSec: ts,
        title: typeof raw.title === "string" ? raw.title : undefined,
        message: typeof raw.message === "string" ? raw.message : undefined,
        notificationType:
          typeof raw.notification_type === "string"
            ? raw.notification_type
            : undefined,
        raw,
      };

    case "SessionEnd":
      return {
        type: "session_end",
        timestampSec: ts,
        reason: typeof raw.reason === "string" ? raw.reason : undefined,
        raw,
      };

    default:
      return null;
  }
}

/** Patch an existing pre_tool_use event with the post_tool_use response. */
export function addResponseToEventData(
  preEvent: PreToolUseEvent,
  toolResponse: unknown,
  isError = false,
  errorMessage?: string,
): PostToolUseEvent {
  return {
    type: "post_tool_use",
    timestampSec: preEvent.timestampSec,
    toolName: preEvent.toolName,
    toolUseId: preEvent.toolUseId,
    toolInput: preEvent.toolInput,
    toolResponse,
    isError,
    errorMessage,
  };
}

export function readStdinJson(): Record<string, unknown> {
  try {
    const raw = require("fs").readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Hook events recognized — list also drives `cmdInstall`. */
export const HOOK_EVENT_NAMES: ReadonlyArray<{
  event: string;
  subcommand: string;
  internal: HookEventType;
}> = [
  { event: "SessionStart", subcommand: "session-start", internal: "session_start" },
  { event: "UserPromptSubmit", subcommand: "user-prompt-submit", internal: "user_prompt_submit" },
  { event: "PreToolUse", subcommand: "pre-tool-use", internal: "pre_tool_use" },
  { event: "PostToolUse", subcommand: "post-tool-use", internal: "post_tool_use" },
  { event: "PostToolUseFailure", subcommand: "post-tool-use-failure", internal: "post_tool_use_failure" },
  { event: "Stop", subcommand: "stop", internal: "stop" },
  { event: "SubagentStart", subcommand: "subagent-start", internal: "subagent_start" },
  { event: "SubagentStop", subcommand: "subagent-stop", internal: "subagent_stop" },
  { event: "PreCompact", subcommand: "pre-compact", internal: "pre_compact" },
  { event: "Notification", subcommand: "notification", internal: "notification" },
  { event: "SessionEnd", subcommand: "session-end", internal: "session_end" },
];
