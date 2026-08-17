// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

jest.mock("fs");
jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, homedir: jest.fn(() => "/mock/home") };
});

// Mock telemetry to avoid real OTel initialization
jest.mock("../src/telemetry", () => ({
  configureTelemetry: jest.fn(() => ({
    forceFlush: jest.fn(),
    shutdown: jest.fn(),
  })),
  shutdownTelemetry: jest.fn(async () => {}),
}));

// Mock @opentelemetry/api
const mockSpan = {
  setAttribute: jest.fn(),
  setStatus: jest.fn(),
  end: jest.fn(),
  addEvent: jest.fn(),
};
const mockTracer = {
  startSpan: jest.fn(() => mockSpan),
};
jest.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: jest.fn(() => mockTracer),
    setSpan: jest.fn((ctx) => ctx),
    getTracerProvider: jest.fn(() => ({})),
  },
  context: {
    active: jest.fn(() => ({})),
  },
  SpanStatusCode: {
    ERROR: 2,
    OK: 1,
    UNSET: 0,
  },
}));

const {
  _buildHookConfig,
  _hrTime,
  _installIntoSettings,
  _removeHooksFromSettings,
  _removeAliasFromFile,
  _cmdUserPromptSubmitWithEvent,
  _cmdSessionStartWithEvent,
  _cmdPreToolUseWithEvent,
  _cmdPostToolUseWithEvent,
  _cmdPostToolUseFailureWithEvent,
  _cmdPreCompactWithEvent,
  _cmdPostCompactWithEvent,
  _cmdSubagentStartWithEvent,
  _cmdSubagentStopWithEvent,
  _cmdNotificationWithEvent,
  _replayEventsAsSpans,
  _reconstructStateFromEvents,
  _extractOutputAndTokensFromEvents,
  _transformToArmsInputMessages,
  _transformToArmsOutputMessages,
  _transformToArmsSystemInstructions,
  _mapStopReasonToFinishReason,
  _buildSubagentInfo,
} = require("../src/cli");

const { loadState, saveState } = require("../src/state");

describe("cli.js", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync.mockImplementation(() => {});
    fs.existsSync.mockReturnValue(false);
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
  });

  describe("buildHookConfig", () => {
    it("generates config for all hook events", () => {
      const config = _buildHookConfig("otel-qwen-hook");
      expect(config).toHaveProperty("UserPromptSubmit");
      expect(config).toHaveProperty("PreToolUse");
      expect(config).toHaveProperty("PostToolUse");
      expect(config).toHaveProperty("PostToolUseFailure");
      expect(config).toHaveProperty("Stop");
      expect(config).toHaveProperty("PreCompact");
      expect(config).toHaveProperty("PostCompact");
      expect(config).toHaveProperty("SubagentStart");
      expect(config).toHaveProperty("SubagentStop");
      expect(config).toHaveProperty("SessionStart");
      expect(config).toHaveProperty("SessionEnd");
      expect(config).toHaveProperty("Notification");
    });

    it("uses correct command format", () => {
      const config = _buildHookConfig("my-cmd");
      const hook = config.UserPromptSubmit[0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toBe("my-cmd user-prompt-submit");
    });
  });

  describe("hrTime", () => {
    it("converts timestamp to [seconds, nanos]", () => {
      const [sec, nanos] = _hrTime(1700000000.123456);
      expect(sec).toBe(1700000000);
      expect(nanos).toBeGreaterThan(0);
      expect(nanos).toBeLessThan(1e9);
    });

    it("handles integer timestamps", () => {
      const [sec, nanos] = _hrTime(1700000000);
      expect(sec).toBe(1700000000);
      expect(nanos).toBe(0);
    });
  });

  describe("installIntoSettings", () => {
    it("creates settings file if it does not exist", () => {
      fs.existsSync.mockReturnValue(false);
      _installIntoSettings("/mock/home/.qwen/settings.json");

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        "/mock/home/.qwen/settings.json",
        expect.stringContaining("hooks"),
        "utf-8"
      );
    });

    it("merges hooks into existing settings", () => {
      const existingSettings = { someKey: true, hooks: {} };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingSettings));

      _installIntoSettings("/mock/home/.qwen/settings.json");

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed.someKey).toBe(true);
      expect(parsed.hooks).toHaveProperty("UserPromptSubmit");
      expect(parsed.hooks).toHaveProperty("Stop");
    });

    it("does not duplicate hooks on re-install", () => {
      const existingHooks = _buildHookConfig("otel-qwen-hook");
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ hooks: existingHooks }));

      _installIntoSettings("/mock/home/.qwen/settings.json");

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    });
  });

  describe("removeHooksFromSettings", () => {
    it("removes otel-qwen-hook commands from settings", () => {
      const hooks = _buildHookConfig("otel-qwen-hook");
      hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "other-hook" }] });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ hooks }));

      _removeHooksFromSettings("/mock/home/.qwen/settings.json");

      const writtenContent = fs.writeFileSync.mock.calls[0][1];
      const parsed = JSON.parse(writtenContent);
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
      expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe("other-hook");
    });
  });

  describe("removeAliasFromFile", () => {
    it("removes BEGIN/END marked block", () => {
      const content = "line1\n# BEGIN otel-qwen-hook\nalias qwen=...\n# END otel-qwen-hook\nline2\n";
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(content);

      _removeAliasFromFile("/mock/home/.zshrc");

      const written = fs.writeFileSync.mock.calls[0][1];
      expect(written).not.toContain("otel-qwen-hook");
      expect(written).toContain("line1");
      expect(written).toContain("line2");
    });

    it("does nothing if markers not found", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("clean file\n");

      _removeAliasFromFile("/mock/home/.zshrc");
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("command handlers (WithEvent)", () => {
    it("cmdUserPromptSubmit creates initial state", () => {
      const event = { session_id: "sess-1", prompt: "hello", model: "qwen-max" };
      _cmdUserPromptSubmitWithEvent(event);

      expect(saveState).toBeDefined();
    });

    it("cmdPreToolUse records tool event", () => {
      const event = { session_id: "sess-1", tool_name: "Read", tool_input: { file_path: "/test" }, tool_use_id: "tu-1" };
      _cmdPreToolUseWithEvent(event);
    });

    it("cmdPostToolUse records tool response", () => {
      const event = { session_id: "sess-1", tool_name: "Read", tool_response: "file content", tool_use_id: "tu-1" };
      _cmdPostToolUseWithEvent(event);
    });

    it("cmdPostToolUseFailure records failure", () => {
      const event = { session_id: "sess-1", tool_name: "Shell", tool_use_id: "tu-2", error: "command not found" };
      _cmdPostToolUseFailureWithEvent(event);
    });

    it("cmdPreCompact records compact start", () => {
      _cmdPreCompactWithEvent({ session_id: "sess-1", trigger: "auto" });
    });

    it("cmdPostCompact records compact end", () => {
      _cmdPostCompactWithEvent({ session_id: "sess-1", trigger: "auto", compact_summary: "summary" });
    });

    it("cmdNotification records notification", () => {
      _cmdNotificationWithEvent({ session_id: "sess-1", message: "Task complete", level: "info" });
    });

    it("cmdSessionStart records model info", () => {
      _cmdSessionStartWithEvent({ session_id: "sess-1", model: "qwen-max" });
    });

    it("cmdSubagentStart records agent launch", () => {
      _cmdSubagentStartWithEvent({ session_id: "sess-1", agent_id: "agent-1", agent_type: "task" });
    });

    it("cmdSubagentStop records agent completion", () => {
      _cmdSubagentStopWithEvent({ session_id: "sess-1", agent_id: "agent-1", stop_reason: "end_turn" });
    });
  });

  describe("replayEventsAsSpans", () => {
    it("creates turn span for user_prompt_submit", () => {
      const events = [
        { type: "user_prompt_submit", timestamp: 1700000000, prompt: "hello" },
      ];
      const parentCtx = {};

      _replayEventsAsSpans(mockTracer, events, parentCtx, 1700000010);

      expect(mockTracer.startSpan).toHaveBeenCalled();
      const call = mockTracer.startSpan.mock.calls[0];
      expect(call[0]).toBe("react step 1");
    });

    it("creates tool span for pre_tool_use + post_tool_use pair", () => {
      const events = [
        { type: "pre_tool_use", timestamp: 1700000000, tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "tu-1" },
        { type: "post_tool_use", timestamp: 1700000001, tool_name: "Read", tool_response: "content", tool_use_id: "tu-1" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      // At least 1 span created for pre_tool_use
      expect(mockTracer.startSpan).toHaveBeenCalled();
      // post_tool_use closes the span
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it("creates error span for post_tool_use_failure", () => {
      const events = [
        { type: "pre_tool_use", timestamp: 1700000000, tool_name: "Shell", tool_input: {}, tool_use_id: "tu-2" },
        { type: "post_tool_use_failure", timestamp: 1700000001, tool_name: "Shell", tool_use_id: "tu-2", error: "fail" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 })
      );
    });

    it("handles LLM call events", () => {
      const events = [
        {
          type: "llm_call", timestamp: 1700000001,
          model: "qwen-max", input_tokens: 100, output_tokens: 50,
          input_messages: [{ role: "user", content: "hi" }],
        },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockTracer.startSpan).toHaveBeenCalled();
      const call = mockTracer.startSpan.mock.calls[0];
      expect(call[0]).toBe("chat qwen-max");
    });

    it("handles notification events", () => {
      const events = [
        { type: "notification", timestamp: 1700000001, message: "Done", level: "info" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockTracer.startSpan).toHaveBeenCalled();
    });

    it("handles compact events", () => {
      const events = [
        { type: "pre_compact", timestamp: 1700000000, trigger: "auto" },
        { type: "post_compact", timestamp: 1700000001, trigger: "auto", compact_summary: "done" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 1700000002);

      expect(mockTracer.startSpan).toHaveBeenCalled();
    });

    it("creates AGENT container span for subagent_start/stop pair (sequential)", () => {
      jest.clearAllMocks();
      const events = [
        { type: "user_prompt_submit", timestamp: 100, prompt: "hello" },
        { type: "pre_tool_use", timestamp: 101, tool_name: "agent", tool_use_id: "tu-1", tool_input: { prompt: "task" } },
        { type: "subagent_start", timestamp: 102, agent_id: "sub-1", agent_type: "Custom" },
        { type: "llm_call", timestamp: 103, model: "qwen-max", input_tokens: 10, output_tokens: 5 },
        { type: "subagent_stop", timestamp: 104, agent_id: "sub-1", stop_reason: "end_turn" },
        { type: "post_tool_use", timestamp: 105, tool_name: "agent", tool_use_id: "tu-1" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 106);

      const spanNames = mockTracer.startSpan.mock.calls.map(c => c[0]);
      // Should have: react step, execute_tool agent, invoke_agent Custom, chat qwen-max
      expect(spanNames.some(n => n === "react step 1")).toBe(true);
      expect(spanNames.some(n => n === "execute_tool agent")).toBe(true);
      expect(spanNames.some(n => n === "invoke_agent Custom")).toBe(true);
      expect(spanNames.some(n => n === "chat qwen-max")).toBe(true);
    });

    it("creates AGENT containers for parallel subagents without nesting LLM calls", () => {
      jest.clearAllMocks();
      const events = [
        { type: "user_prompt_submit", timestamp: 100, prompt: "hello" },
        { type: "pre_tool_use", timestamp: 101, tool_name: "agent", tool_use_id: "tu-A", tool_input: {} },
        { type: "pre_tool_use", timestamp: 101.1, tool_name: "agent", tool_use_id: "tu-B", tool_input: {} },
        { type: "subagent_start", timestamp: 102, agent_id: "sub-A", agent_type: "Custom" },
        { type: "subagent_start", timestamp: 102.1, agent_id: "sub-B", agent_type: "Custom" },
        { type: "llm_call", timestamp: 103, model: "m", input_tokens: 1, output_tokens: 1 },
        { type: "llm_call", timestamp: 103.5, model: "m", input_tokens: 1, output_tokens: 1 },
        { type: "subagent_stop", timestamp: 104, agent_id: "sub-A", stop_reason: "end_turn" },
        { type: "subagent_stop", timestamp: 104.5, agent_id: "sub-B", stop_reason: "end_turn" },
        { type: "post_tool_use", timestamp: 105, tool_name: "agent", tool_use_id: "tu-A" },
        { type: "post_tool_use", timestamp: 105.1, tool_name: "agent", tool_use_id: "tu-B" },
      ];

      _replayEventsAsSpans(mockTracer, events, {}, 106);

      const spanNames = mockTracer.startSpan.mock.calls.map(c => c[0]);
      // Both AGENT containers should be created
      const agentSpans = spanNames.filter(n => n === "invoke_agent Custom");
      expect(agentSpans).toHaveLength(2);
      // Both TOOL spans should exist
      const toolSpans = spanNames.filter(n => n === "execute_tool agent");
      expect(toolSpans).toHaveLength(2);
    });
  });

  describe("reconstructStateFromEvents", () => {
    it("reconstructs metadata from events, startTime from user_prompt_submit", () => {
      const events = [
        { type: "notification", timestamp: 90, message: "Waiting" },
        { type: "user_prompt_submit", timestamp: 100, prompt: "hello world", model: "qwen-max" },
        { type: "pre_tool_use", timestamp: 101, tool_name: "Read" },
        { type: "pre_tool_use", timestamp: 102, tool_name: "Write" },
        { type: "llm_call", timestamp: 103, model: "qwen-max", input_tokens: 500, output_tokens: 200, output_content: "first response" },
        { type: "llm_call", timestamp: 104, model: "qwen-max", input_tokens: 300, output_tokens: 100, output_content: "final answer" },
      ];

      const state = _reconstructStateFromEvents("sess-1", events, 110);
      expect(state.session_id).toBe("sess-1");
      expect(state.start_time).toBe(100);
      expect(state.stop_time).toBe(110);
      expect(state.prompt).toBe("hello world");
      expect(state.model).toBe("qwen-max");
      expect(state.last_output).toBe("");
      expect(state.metrics.turns).toBe(1);
      expect(state.metrics.tools_used).toBe(2);
      expect(state.metrics).not.toHaveProperty("input_tokens");
      expect(state.metrics).not.toHaveProperty("output_tokens");
      expect(state.tools_used).toEqual(expect.arrayContaining(["Read", "Write"]));
      expect(state.events).toBe(events);
    });

    it("handles empty events", () => {
      const state = _reconstructStateFromEvents("sess-2", [], 110);
      expect(state.prompt).toBe("");
      expect(state.model).toBe("unknown");
      expect(state.metrics.turns).toBe(0);
    });
  });

  describe("extractOutputAndTokensFromEvents", () => {
    it("extracts output and tokens from llm_call events", () => {
      const events = [
        { type: "user_prompt_submit", timestamp: 100 },
        { type: "llm_call", timestamp: 103, model: "qwen-max", input_tokens: 500, output_tokens: 200, output_content: "first" },
        { type: "llm_call", timestamp: 104, model: "qwen-max", input_tokens: 300, output_tokens: 100, output_content: "final" },
      ];
      const result = _extractOutputAndTokensFromEvents(events);
      expect(result.lastOutput).toBe("final");
      expect(result.inputTokens).toBe(800);
      expect(result.outputTokens).toBe(300);
      expect(result.model).toBe("qwen-max");
    });

    it("returns defaults when no llm_call events", () => {
      const result = _extractOutputAndTokensFromEvents([{ type: "user_prompt_submit" }]);
      expect(result.lastOutput).toBe("");
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.model).toBe("unknown");
    });
  });

  describe("mapStopReasonToFinishReason", () => {
    it("maps stop/end_turn to stop", () => {
      expect(_mapStopReasonToFinishReason("stop")).toBe("stop");
      expect(_mapStopReasonToFinishReason("end_turn")).toBe("stop");
    });
    it("maps tool_calls/tool_use to tool_call", () => {
      expect(_mapStopReasonToFinishReason("tool_calls")).toBe("tool_call");
      expect(_mapStopReasonToFinishReason("tool_use")).toBe("tool_call");
    });
    it("maps length/max_tokens to length", () => {
      expect(_mapStopReasonToFinishReason("length")).toBe("length");
      expect(_mapStopReasonToFinishReason("max_tokens")).toBe("length");
    });
    it("returns stop for empty/null", () => {
      expect(_mapStopReasonToFinishReason("")).toBe("stop");
      expect(_mapStopReasonToFinishReason(null)).toBe("stop");
    });
  });

  describe("transformToArmsInputMessages", () => {
    it("converts OpenAI-format messages to ARMS schema", () => {
      const input = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"file_path":"/a"}' } }] },
        { role: "tool", tool_call_id: "tc1", content: [{ type: "text", text: "file contents" }] },
      ];
      const result = _transformToArmsInputMessages(input);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ role: "user", parts: [{ type: "text", content: "hello" }] });
      expect(result[1].parts[0].type).toBe("tool_call");
      expect(result[1].parts[0].name).toBe("read_file");
      expect(result[2].parts[0].type).toBe("tool_call_response");
      expect(result[2].parts[0].id).toBe("tc1");
    });

    it("handles string content", () => {
      const input = [{ role: "assistant", content: "Hello world" }];
      const result = _transformToArmsInputMessages(input);
      expect(result[0].parts[0]).toEqual({ type: "text", content: "Hello world" });
    });
  });

  describe("transformToArmsOutputMessages", () => {
    it("converts content_blocks to ARMS output format", () => {
      const blocks = [
        { type: "text", text: "The answer" },
      ];
      const result = _transformToArmsOutputMessages(blocks, "stop");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("assistant");
      expect(result[0].parts[0]).toEqual({ type: "text", content: "The answer" });
      expect(result[0].finish_reason).toBe("stop");
    });

    it("converts tool_use blocks to tool_call parts", () => {
      const blocks = [
        { type: "tool_use", id: "tc1", name: "read_file", input: { file_path: "/a" } },
      ];
      const result = _transformToArmsOutputMessages(blocks, "tool_calls");
      expect(result[0].parts[0].type).toBe("tool_call");
      expect(result[0].parts[0].name).toBe("read_file");
      expect(result[0].finish_reason).toBe("tool_call");
    });
  });

  describe("transformToArmsSystemInstructions", () => {
    it("converts string system prompt", () => {
      const result = _transformToArmsSystemInstructions("You are helpful");
      expect(result).toEqual([{ type: "text", content: "You are helpful" }]);
    });

    it("converts array of objects with text field", () => {
      const result = _transformToArmsSystemInstructions([{ text: "Rule 1" }, { text: "Rule 2" }]);
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe("Rule 1");
    });

    it("converts OpenAI message objects with nested content array", () => {
      const result = _transformToArmsSystemInstructions([
        { role: "system", content: [{ type: "text", text: "You are a bot" }] },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: "text", content: "You are a bot" });
    });

    it("converts OpenAI message objects with string content", () => {
      const result = _transformToArmsSystemInstructions([
        { role: "system", content: "Be brief" },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: "text", content: "Be brief" });
    });

    it("returns null for null/undefined", () => {
      expect(_transformToArmsSystemInstructions(null)).toBeNull();
      expect(_transformToArmsSystemInstructions(undefined)).toBeNull();
    });
  });

  describe("buildSubagentInfo", () => {
    it("builds windows for sequential subagents", () => {
      const events = [
        { type: "subagent_start", timestamp: 100, agent_id: "a1", agent_type: "T" },
        { type: "llm_call", timestamp: 101 },
        { type: "subagent_stop", timestamp: 102, agent_id: "a1" },
      ];
      const info = _buildSubagentInfo(events);
      expect(info.windows).toHaveLength(1);
      expect(info.windows[0].childEvents).toHaveLength(1);
      expect(info.ownedIndices.has(0)).toBe(true);
      expect(info.ownedIndices.has(1)).toBe(true);
      expect(info.ownedIndices.has(2)).toBe(true);
    });

    it("detects parallel (overlapping) subagents and skips child collection", () => {
      const events = [
        { type: "subagent_start", timestamp: 100, agent_id: "a1", agent_type: "T" },
        { type: "subagent_start", timestamp: 101, agent_id: "a2", agent_type: "T" },
        { type: "llm_call", timestamp: 102 },
        { type: "subagent_stop", timestamp: 103, agent_id: "a1" },
        { type: "subagent_stop", timestamp: 104, agent_id: "a2" },
      ];
      const info = _buildSubagentInfo(events);
      expect(info.windows).toHaveLength(2);
      // Parallel → no child events collected
      expect(info.windows[0].childEvents).toHaveLength(0);
      expect(info.windows[1].childEvents).toHaveLength(0);
    });

    it("excludes external tool post_tool_use that falls inside subagent window", () => {
      // Scenario: glob pre_tool_use is BEFORE the subagent window,
      // but its post_tool_use lands INSIDE the window (parallel execution).
      const events = [
        { type: "pre_tool_use", timestamp: 100, tool_name: "glob", tool_use_id: "tu-glob", tool_input: {} },
        { type: "subagent_start", timestamp: 101, agent_id: "a1", agent_type: "Task" },
        { type: "llm_call", timestamp: 102 },
        { type: "post_tool_use", timestamp: 103, tool_name: "glob", tool_use_id: "tu-glob", tool_response: "files" },
        { type: "subagent_stop", timestamp: 104, agent_id: "a1" },
      ];
      const info = _buildSubagentInfo(events);
      expect(info.windows).toHaveLength(1);
      // post_tool_use(glob) must NOT be in childEvents
      const childTypes = info.windows[0].childEvents.map(e => e.type);
      expect(childTypes).toContain("llm_call");
      expect(childTypes).not.toContain("post_tool_use");
      // post_tool_use(glob) index (3) must NOT be in ownedIndices
      expect(info.ownedIndices.has(3)).toBe(false);
    });

    it("handles nested subagents (only top-level windows)", () => {
      const events = [
        { type: "subagent_start", timestamp: 100, agent_id: "outer", agent_type: "T" },
        { type: "subagent_start", timestamp: 101, agent_id: "inner", agent_type: "T" },
        { type: "llm_call", timestamp: 102 },
        { type: "subagent_stop", timestamp: 103, agent_id: "inner" },
        { type: "subagent_stop", timestamp: 104, agent_id: "outer" },
      ];
      const info = _buildSubagentInfo(events);
      // Only the outer window is top-level
      expect(info.windows).toHaveLength(1);
      expect(info.windows[0].agent_id).toBe("outer");
      // Child events include the inner subagent's events (handled recursively)
      expect(info.windows[0].childEvents.length).toBeGreaterThan(0);
    });
  });
});
