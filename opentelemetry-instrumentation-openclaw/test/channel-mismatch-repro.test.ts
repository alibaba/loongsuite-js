// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
//
// Reproduction test for the multi-session channel mismatch issue:
// When llm_input resolves to a "system/" channel (sessionKey = session UUID)
// and before_tool_call resolves to an "agent/" channel (channelId = "agent_xxx"),
// the tool span is silently skipped because activeContextByAgentChannel has no entry.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class MockOTLPTraceExporter {},
}));
vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));
vi.mock("@opentelemetry/sdk-trace-base", () => {
  class MockBasicTracerProvider {
    getTracer() {
      return {
        startSpan: vi.fn().mockReturnValue({
          setAttribute: vi.fn(),
          setAttributes: vi.fn(),
          setStatus: vi.fn(),
          updateName: vi.fn(),
          end: vi.fn(),
          isRecording: vi.fn().mockReturnValue(true),
          spanContext: vi.fn().mockReturnValue({ traceId: "t1", spanId: "s1" }),
        }),
      };
    }
    addSpanProcessor() {}
    forceFlush() { return Promise.resolve(); }
    shutdown() { return Promise.resolve(); }
  }
  return {
    BasicTracerProvider: MockBasicTracerProvider,
    BatchSpanProcessor: class MockBatchSpanProcessor {},
  };
});
vi.mock("@opentelemetry/api", () => {
  const makeContext = () => {
    const store = new Map();
    const ctx: Record<string, unknown> = {
      getValue: (k: unknown) => store.get(k),
      setValue: (k: unknown, v: unknown) => { const c = makeContext(); (c as any).__store = new Map(store); (c as any).__store.set(k, v); (c.getValue as any) = (kk: unknown) => (c as any).__store.get(kk); return c; },
      deleteValue: (k: unknown) => { const c = makeContext(); (c as any).__store = new Map(store); (c as any).__store.delete(k); (c.getValue as any) = (kk: unknown) => (c as any).__store.get(kk); return c; },
    };
    return ctx;
  };
  return {
    trace: { setSpan: vi.fn().mockImplementation((_ctx: unknown) => makeContext()), setSpanContext: vi.fn().mockImplementation((_ctx: unknown) => makeContext()) },
    context: { active: vi.fn().mockImplementation(() => makeContext()) },
    ROOT_CONTEXT: {},
    SpanKind: { SERVER: 0, CLIENT: 1, INTERNAL: 2 },
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    metrics: { getMeter: vi.fn().mockReturnValue({ createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }) }) },
    diag: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn() },
  };
});
vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

const { default: armsTracePlugin } = await import("../src/index.js");

// ---------------------------------------------------------------------------
// Helper: create a mock API that captures hook registrations
// ---------------------------------------------------------------------------

function makeApi(pluginConfig: Record<string, unknown> = {}): OpenClawPluginApi & {
  handlers: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  return {
    config: {},
    pluginConfig: {
      endpoint: "https://otlp-test.example.com:4318",
      headers: { "x-arms-license-key": "test-key" },
      serviceName: "test-svc",
      debug: true,
      ...pluginConfig,
    },
    runtime: { version: "2026.4.23" },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(hookName, handler);
    }),
    handlers,
  };
}

function getHandler(api: ReturnType<typeof makeApi>, hookName: string) {
  return api.handlers.get(hookName);
}

// ---------------------------------------------------------------------------
// Reproduction tests
// ---------------------------------------------------------------------------

describe("Channel mismatch: llm_input=system/ vs before_tool_call=agent/", () => {
  it("FIX VERIFIED: tool span recovered via runId fallback when agent/ anchor mismatches", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input")!;
    const beforeToolCall = getHandler(api, "before_tool_call")!;
    const afterToolCall = getHandler(api, "after_tool_call")!;
    const beforeMessageWrite = getHandler(api, "before_message_write")!;

    const sessionUUID = "c06c15b8-abcd-4e69-832f-fd4787bb18a5";
    const runId = sessionUUID;

    // Step 1: llm_input fires with sessionKey = session UUID
    // resolveChannelId → "system/c06c15b8-..." (not agent/ prefix)
    await llmInput(
      {
        runId,
        sessionId: sessionUUID,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        systemPrompt: "You are a helpful assistant",
        prompt: "Help me with a task",
        historyMessages: [],
        imagesCount: 0,
        tools: [{ name: "Bash", type: "function", description: "Run a command" }],
      },
      {
        sessionKey: sessionUUID,
        agentId: "xukai7",
      },
    );

    // Verify llm_input processed
    const llmInputLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("LLM input started"));
    expect(llmInputLogs.length).toBe(1);

    // Step 2: before_message_write
    await beforeMessageWrite(
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me run that command." },
            { type: "toolCall", id: "call_001", name: "Bash", arguments: { command: "ls" } },
          ],
          timestamp: Date.now(),
          stopReason: "toolUse",
          usage: { input: 690, output: 50 },
        },
      },
      {
        sessionKey: sessionUUID,
        agentId: "xukai7",
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Step 3: before_tool_call with DIFFERENT channel (agent/) but SAME runId
    // After fix: anchor fails → runId fallback finds context → tool span created!
    await beforeToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId: runId, // ← runId available for fallback
        toolCallId: "call_001",
      },
      {
        sessionKey: "agent_xukai7", // resolves to "agent/xukai7" — different from llm_input
        agentId: "xukai7",
        runId: runId,
      },
    );

    // After fix: tool span should NOT be skipped
    const skipLogs = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Skip tool span without active agent context"));
    expect(skipLogs.length).toBe(0); // ← Fixed: no longer skipped!

    // Tool call was registered via runId fallback
    const toolStartLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Tool call started"));
    expect(toolStartLogs.length).toBe(1); // ← Tool span created!

    // Verify runId fallback log
    const fallbackLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("runId fallback"));
    expect(fallbackLogs.length).toBe(1);

    // Step 4: after_tool_call completes the tool span
    await afterToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId: runId,
        toolCallId: "call_001",
        result: "file1.txt\nfile2.txt",
        durationMs: 100,
      },
      {
        sessionKey: "agent_xukai7",
        agentId: "xukai7",
        runId: runId,
      },
    );

    const toolExportLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Exported tool span"));
    expect(toolExportLogs.length).toBe(1); // ← Tool span exported!
  });

  it("GUARD PRESERVED: tool span still skipped when no runId available and anchor fails", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input")!;
    const beforeToolCall = getHandler(api, "before_tool_call")!;

    const sessionUUID = "c06c15b8-abcd-4e69-832f-fd4787bb18a5";

    await llmInput(
      {
        runId: sessionUUID,
        sessionId: sessionUUID,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        prompt: "Help me",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: sessionUUID, agentId: "xukai7" },
    );

    // before_tool_call with different channel AND no runId — should still skip
    await beforeToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId: undefined, // no runId!
        toolCallId: "call_001",
      },
      {
        sessionKey: "agent_xukai7",
        agentId: "xukai7",
        // no runId in hookCtx either
      },
    );

    const skipLogs = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Skip tool span without active agent context"));
    expect(skipLogs.length).toBe(1); // ← Still skipped when no fallback available
  });

  it("CONTROL: tool span succeeds when all hooks use consistent channel", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input")!;
    const beforeToolCall = getHandler(api, "before_tool_call")!;
    const afterToolCall = getHandler(api, "after_tool_call")!;
    const beforeMessageWrite = getHandler(api, "before_message_write")!;

    // Normal trace scenario: all hooks use the same agent-style sessionKey
    const sessionId = "17bb3877-5cae-44cf-abb2-ee5b57f766b3";
    const runId = "ad2423c7-309b-476e-b755-a6895d49feb3";
    const agentSessionKey = "agent_xukai7";

    // Step 1: llm_input with agent-style sessionKey
    // resolveChannelId → "agent/xukai7" → writes activeContextByAgentChannel
    await llmInput(
      {
        runId,
        sessionId,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        systemPrompt: "You are a helpful assistant",
        prompt: "Help me with a task",
        historyMessages: [],
        imagesCount: 0,
        tools: [{ name: "Bash", type: "function", description: "Run a command" }],
      },
      {
        sessionKey: agentSessionKey,
        agentId: "xukai7",
      },
    );

    // Step 2: before_message_write with same sessionKey
    await beforeMessageWrite(
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me run that command." },
            { type: "toolCall", id: "call_001", name: "Bash", arguments: { command: "ls" } },
          ],
          timestamp: Date.now(),
          stopReason: "toolUse",
          usage: { input: 690, output: 50 },
        },
      },
      {
        sessionKey: agentSessionKey,
        agentId: "xukai7",
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Step 3: before_tool_call with SAME sessionKey → channel matches!
    await beforeToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId,
        toolCallId: "call_001",
      },
      {
        sessionKey: agentSessionKey,
        agentId: "xukai7",
      },
    );

    // Tool call should NOT be skipped
    const skipLogs = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Skip tool span"));
    expect(skipLogs.length).toBe(0); // ← No skip!

    // Tool call was registered
    const toolStartLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Tool call started"));
    expect(toolStartLogs.length).toBe(1);

    // Step 4: after_tool_call completes the tool span
    await afterToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId,
        toolCallId: "call_001",
        result: "file1.txt\nfile2.txt",
        durationMs: 100,
      },
      {
        sessionKey: agentSessionKey,
        agentId: "xukai7",
      },
    );

    const toolExportLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Exported tool span"));
    expect(toolExportLogs.length).toBe(1); // ← Tool span exported!
  });

  it("REPRODUCES BUG: concurrent sessions with same agent name cause anchor overwrite", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input")!;
    const beforeToolCall = getHandler(api, "before_tool_call")!;

    // Both sessions use the same agent-style sessionKey (same agent name)
    const agentSessionKey = "agent_xukai7";

    // Session A: llm_input → sets activeContextByAgentChannel["agent/xukai7"] = ctxA
    await llmInput(
      {
        runId: "run-session-A",
        sessionId: "session-A",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        prompt: "Task A",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: agentSessionKey, agentId: "xukai7" },
    );

    const llmInputLogsA = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("LLM input started"));
    expect(llmInputLogsA.length).toBe(1);

    // Session B: llm_input → OVERWRITES activeContextByAgentChannel["agent/xukai7"] = ctxB
    await llmInput(
      {
        runId: "run-session-B",
        sessionId: "session-B",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        prompt: "Task B",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: agentSessionKey, agentId: "xukai7" },
    );

    // Session A: before_tool_call → looks up "agent/xukai7" → gets ctxB (WRONG!)
    await beforeToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId: "run-session-A",
        toolCallId: "call_A_001",
      },
      { sessionKey: agentSessionKey, agentId: "xukai7" },
    );

    // The tool was registered, but against the WRONG context (Session B's)
    const toolStartLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Tool call started"));

    // Tool call started (not skipped), but it's anchored to Session B's context
    // This means Session A's trace will be missing tool spans,
    // and Session B's trace may get extra/wrong tool spans
    expect(toolStartLogs.length).toBe(1);

    // Check that the tool was registered with run-session-A as runId
    // but the traceContext belongs to Session B
    const toolLog = toolStartLogs[0];
    expect(toolLog).toContain("toolCallId=call_A_001");
    // The tool is registered under Session B's context — cross-contamination!
  });

  it("GUARD SCOPED: runId==sessionId still recovers tool span when context is live", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input")!;
    const beforeToolCall = getHandler(api, "before_tool_call")!;

    const sessionUUID = "9f1e2d3c-0000-4a5b-8c7d-000000000001";
    // openclaw derives runId as `opts.runId || sessionId`, so runId === sessionId
    const runId = sessionUUID;

    await llmInput(
      {
        runId,
        sessionId: sessionUUID,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        prompt: "Help me",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: sessionUUID, agentId: "xukai7" }, // → system/<uuid>, no anchor
    );

    // agent/ channel with no anchor, runId === sessionId in hookCtx.
    // Context is live (not closing) → guard must allow recovery.
    await beforeToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId,
        toolCallId: "call_live_001",
      },
      {
        sessionKey: "agent_xukai7",
        agentId: "xukai7",
        runId,
        sessionId: sessionUUID,
      },
    );

    const skipLogs = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Skip tool span without active agent context"));
    expect(skipLogs.length).toBe(0); // live context → recovered

    const toolStartLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Tool call started"));
    expect(toolStartLogs.length).toBe(1);
  });

  it("GUARD FIRES: runId==sessionId skips tool span when found context is closing", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input")!;
    const llmOutput = getHandler(api, "llm_output")!;
    const agentEnd = getHandler(api, "agent_end")!;
    const beforeToolCall = getHandler(api, "before_tool_call")!;

    const sessionUUID = "9f1e2d3c-0000-4a5b-8c7d-000000000002";
    const runId = sessionUUID; // runId === sessionId

    await llmInput(
      {
        runId,
        sessionId: sessionUUID,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        prompt: "Help me",
        historyMessages: [],
        imagesCount: 0,
      },
      { sessionKey: sessionUUID, agentId: "xukai7" },
    );

    // Clear the pending LLM span so agent_end does not wait on it.
    await llmOutput(
      {
        runId,
        sessionId: sessionUUID,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        assistantTexts: ["done"],
        usage: { input: 10, output: 5 },
      },
      { sessionKey: sessionUUID, agentId: "xukai7" },
    );

    // End the turn → ctx.isClosing = true (map cleanup deferred ~100ms).
    await agentEnd(
      { messages: [], success: true, durationMs: 100 },
      { sessionKey: sessionUUID, agentId: "xukai7" },
    );

    // A tool call for a new turn arrives on the agent/ channel with the same
    // runId (== sessionId). Because runId cannot discriminate turns here and
    // the found context is closing, the guard must skip rather than attach to
    // the previous turn's trace.
    await beforeToolCall(
      {
        toolName: "Bash",
        params: { command: "ls" },
        runId,
        toolCallId: "call_closing_001",
      },
      {
        sessionKey: "agent_xukai7",
        agentId: "xukai7",
        runId,
        sessionId: sessionUUID,
      },
    );

    const skipLogs = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Skip tool span without active agent context"));
    expect(skipLogs.length).toBe(1); // guard fired due to closing context

    const toolStartLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .map(([msg]: [string]) => msg)
      .filter((msg: string) => msg.includes("Tool call started"));
    expect(toolStartLogs.length).toBe(0);
  });
});
