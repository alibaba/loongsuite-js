// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import {
  JsonlEmitter,
  buildLlmRequestRecord,
  buildLlmResponseRecord,
  buildToolCallRecord,
  buildToolResultRecord,
} from "./jsonl-emitter.js";
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  LlmInputEvent,
  LlmOutputEvent,
  MessageReceivedEvent,
  OpenClawPluginApi,
  PluginHookContext,
} from "./types.js";

/**
 * Per-run state for JSONL emission.
 *  - userId is captured from message_received and reused across the turn.
 *  - stepCounter increments on each llm_input.
 *  - llmResponseEmittedSteps prevents duplicate llm.response when both
 *    llm_output and before_message_write fire.
 */
interface JsonlRunState {
  sessionId?: string;
  userId?: string;
  stepCounter: number;
  llmResponseEmittedSteps: Set<number>;
  lastUsage?: LlmOutputEvent["usage"];
  lastAssistantTexts?: string[];
}

function getStateForRun(
  store: Map<string, JsonlRunState>,
  runId: string,
): JsonlRunState {
  let s = store.get(runId);
  if (!s) {
    s = {
      stepCounter: 0,
      llmResponseEmittedSteps: new Set<number>(),
    };
    store.set(runId, s);
  }
  return s;
}

const STATE_TTL_MS = 30 * 60 * 1_000;
const STATE_SWEEP_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Register a self-contained set of hook listeners that emit event_t schema
 * JSONL records via the supplied JsonlEmitter. Independent of the OTLP
 * trace path: maintains its own minimal per-run state.
 *
 * Returns a dispose function that stops the periodic state sweeper.
 */
export function registerJsonlHooks(
  api: OpenClawPluginApi,
  emitter: JsonlEmitter,
  options: { enabledHooks?: string[]; debug?: boolean } = {},
): () => void {
  const enabled = (name: string) =>
    !options.enabledHooks || options.enabledHooks.includes(name);
  const captureMessageContent = emitter.captureMessageContent;

  const stateByRun = new Map<string, JsonlRunState>();
  // Record the most recent user (from message_received) so subsequent
  // llm_input on the same channel can pick up user.id.
  let lastUserId: string | undefined;
  let lastUserSessionId: string | undefined;
  const stateTouchedAt = new Map<string, number>();

  const touch = (runId: string) => {
    stateTouchedAt.set(runId, Date.now());
  };

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, ts] of stateTouchedAt) {
      if (now - ts > STATE_TTL_MS) {
        stateByRun.delete(runId);
        stateTouchedAt.delete(runId);
      }
    }
  }, STATE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  if (enabled("message_received")) {
    api.on(
      "message_received",
      (event: MessageReceivedEvent, _ctx: PluginHookContext) => {
        if (event.from && !event.from.startsWith("agent/")) {
          lastUserId = event.from;
        }
        // sessionId may not be on the event; ctx.sessionKey is fallback
        const ctxSessionKey = (_ctx.sessionKey as string | undefined)
          || (_ctx.channelId as string | undefined);
        if (ctxSessionKey) {
          lastUserSessionId = ctxSessionKey;
        }
      },
    );
  }

  if (enabled("llm_input")) {
    api.on(
      "llm_input",
      (event: LlmInputEvent, ctx: PluginHookContext) => {
        const runId = event.runId || `run-${Date.now()}`;
        const state = getStateForRun(stateByRun, runId);
        state.stepCounter += 1;
        state.sessionId = event.sessionId || state.sessionId
          || (ctx.sessionKey as string | undefined)
          || lastUserSessionId
          || "";
        if (!state.userId) state.userId = lastUserId;
        touch(runId);
        try {
          const rec = buildLlmRequestRecord(
            {
              sessionId: state.sessionId || "",
              userId: state.userId,
              runId,
              stepId: state.stepCounter,
            },
            {
              provider: event.provider,
              model: event.model,
              systemPrompt: event.systemPrompt,
              prompt: event.prompt,
              historyMessages: event.historyMessages,
            },
            captureMessageContent,
          );
          emitter.emit(rec);
        } catch (err) {
          if (options.debug) {
            api.logger.warn(
              `[ArmsTrace] JSONL llm_input emission failed: ${String(err)}`,
            );
          }
        }
      },
    );
  }

  if (enabled("llm_output")) {
    api.on(
      "llm_output",
      (event: LlmOutputEvent, _ctx: PluginHookContext) => {
        const runId = event.runId || "";
        if (!runId) return;
        const state = getStateForRun(stateByRun, runId);
        state.lastUsage = event.usage;
        state.lastAssistantTexts = event.assistantTexts;
        state.sessionId = event.sessionId || state.sessionId || "";
        if (state.llmResponseEmittedSteps.has(state.stepCounter)) {
          return;
        }
        state.llmResponseEmittedSteps.add(state.stepCounter);
        touch(runId);
        try {
          const rec = buildLlmResponseRecord(
            {
              sessionId: state.sessionId || "",
              userId: state.userId,
              runId,
              stepId: state.stepCounter,
            },
            {
              provider: event.provider,
              model: event.model,
              assistantTexts: event.assistantTexts,
              usage: event.usage,
            },
            captureMessageContent,
          );
          emitter.emit(rec);
        } catch (err) {
          if (options.debug) {
            api.logger.warn(
              `[ArmsTrace] JSONL llm_output emission failed: ${String(err)}`,
            );
          }
        }
      },
    );
  }

  if (enabled("before_tool_call")) {
    api.on(
      "before_tool_call",
      (event: BeforeToolCallEvent, _ctx: PluginHookContext) => {
        const runId = event.runId || "";
        const state = runId ? getStateForRun(stateByRun, runId) : null;
        if (state) touch(runId);
        const toolCallId = event.toolCallId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          const rec = buildToolCallRecord(
            {
              sessionId: state?.sessionId || "",
              userId: state?.userId,
              runId,
              stepId: state?.stepCounter,
            },
            event.toolName,
            toolCallId,
            event.params,
          );
          emitter.emit(rec);
        } catch (err) {
          if (options.debug) {
            api.logger.warn(
              `[ArmsTrace] JSONL before_tool_call emission failed: ${String(err)}`,
            );
          }
        }
      },
    );
  }

  if (enabled("after_tool_call")) {
    api.on(
      "after_tool_call",
      (event: AfterToolCallEvent, _ctx: PluginHookContext) => {
        const runId = event.runId || "";
        const state = runId ? getStateForRun(stateByRun, runId) : null;
        if (state) touch(runId);
        const toolCallId = event.toolCallId || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          const rec = buildToolResultRecord(
            {
              sessionId: state?.sessionId || "",
              userId: state?.userId,
              runId,
              stepId: state?.stepCounter,
            },
            event.toolName,
            toolCallId,
            {
              result: event.result,
              durationMs: event.durationMs,
              error: event.error,
            },
          );
          emitter.emit(rec);
        } catch (err) {
          if (options.debug) {
            api.logger.warn(
              `[ArmsTrace] JSONL after_tool_call emission failed: ${String(err)}`,
            );
          }
        }
      },
    );
  }

  if (enabled("agent_end")) {
    api.on("agent_end", (_event, _ctx: PluginHookContext) => {
      // No emission here; just clean up state. agent_end fires when a turn
      // wraps; runId state can be evicted to bound memory.
      // Defer slightly so any in-flight llm_output can still find state.
      setTimeout(() => {
        const cutoff = Date.now() - 5_000;
        for (const [runId, ts] of stateTouchedAt) {
          if (ts < cutoff) {
            stateByRun.delete(runId);
            stateTouchedAt.delete(runId);
          }
        }
      }, 1_000);
    });
  }

  return () => {
    clearInterval(sweepTimer);
    stateByRun.clear();
    stateTouchedAt.clear();
  };
}
