// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
//
// Regression baseline test suite for trace compatibility.
// Captures the exact span structure, attributes and timing produced by the
// plugin so that refactoring to util-genai preserves observable behaviour.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawPluginApi, PluginHookContext, SpanData } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock OTel SDK — record every span created by ArmsExporter
// ---------------------------------------------------------------------------

type MockSpanRecord = {
  name: string;
  kind: number;
  startTime?: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  parentSpanId?: string;
  traceId?: string;
  spanId?: string;
  status?: { code: number };
};

let capturedSpans: MockSpanRecord[] = [];
const openSpanMap = new Map<string, MockSpanRecord>();
let spanIdCounter = 0;
let __spanKey: symbol | null = null;

function makeMockSpan(name: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  const uniqueSpanId = `mock-span-${++spanIdCounter}`;
  const record: MockSpanRecord = {
    name,
    kind: (opts.kind as number) ?? 2,
    startTime: opts.startTime as number | undefined,
    attributes: { ...(opts.attributes as Record<string, unknown> || {}) },
    status: undefined,
    spanId: uniqueSpanId,
  };

  return {
    setAttribute: vi.fn((key: string, value: unknown) => {
      record.attributes[key] = value;
    }),
    setAttributes: vi.fn((attrs: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) {
          record.attributes[key] = value;
        }
      }
    }),
    setStatus: vi.fn((s: { code: number }) => {
      record.status = s;
    }),
    updateName: vi.fn((newName: string) => {
      record.name = newName;
    }),
    isRecording: vi.fn(() => true),
    end: vi.fn((endTime?: number) => {
      record.endTime = endTime;
    }),
    spanContext: vi.fn(() => ({
      traceId: record.traceId || "mock-trace",
      spanId: uniqueSpanId,
    })),
    _record: record,
  };
}

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => {
  class MockOTLPTraceExporter {}
  return { OTLPTraceExporter: MockOTLPTraceExporter };
});

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => {
  class MockBatchSpanProcessor {}
  class MockBasicTracerProvider {
    getTracer() {
      return {
        startSpan(name: string, opts: Record<string, unknown> = {}, parentCtx?: unknown) {
          const mock = makeMockSpan(name, opts);
          const record = (mock as { _record: MockSpanRecord })._record;
          if (parentCtx && __spanKey) {
            const getVal = (parentCtx as Record<string, unknown>)?.getValue;
            if (typeof getVal === "function") {
              const parentSpan = (getVal as (k: symbol) => unknown).call(parentCtx, __spanKey);
              if (parentSpan && typeof (parentSpan as Record<string, unknown>).spanContext === "function") {
                record.parentSpanId = ((parentSpan as Record<string, unknown>).spanContext as () => { spanId: string })().spanId;
              }
            }
          }
          capturedSpans.push(record);
          return mock;
        },
      };
    }
    async forceFlush() {}
    async shutdown() {}
  }
  return {
    BasicTracerProvider: MockBasicTracerProvider,
    BatchSpanProcessor: MockBatchSpanProcessor,
  };
});

vi.mock("@opentelemetry/api", () => {
  const SPAN_KEY = Symbol("otel.span_key");
  __spanKey = SPAN_KEY;

  function createContext(data: Map<symbol, unknown> = new Map()): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      getValue(key: symbol) { return data.get(key); },
      setValue(key: symbol, value: unknown) {
        const next = new Map(data);
        next.set(key, value);
        return createContext(next);
      },
      deleteValue(key: symbol) {
        const next = new Map(data);
        next.delete(key);
        return createContext(next);
      },
    };
    return ctx;
  }

  const ROOT_CONTEXT = createContext();

  const noopMeter = {
    createHistogram: () => ({ record: () => {} }),
    createCounter: () => ({ add: () => {} }),
    createUpDownCounter: () => ({ add: () => {} }),
    createObservableGauge: () => ({ addCallback: () => {} }),
  };

  return {
    trace: {
      setSpan(ctx: Record<string, unknown>, span: unknown) {
        const setVal = ctx?.setValue as ((k: symbol, v: unknown) => Record<string, unknown>) | undefined;
        if (typeof setVal === "function") {
          return setVal.call(ctx, SPAN_KEY, span);
        }
        return createContext(new Map([[SPAN_KEY, span]]));
      },
      getSpan(ctx: Record<string, unknown>) {
        const getVal = ctx?.getValue as ((k: symbol) => unknown) | undefined;
        if (typeof getVal === "function") {
          return getVal.call(ctx, SPAN_KEY);
        }
        return undefined;
      },
    },
    context: {
      active() {
        return ROOT_CONTEXT;
      },
      with(ctx: unknown, fn: () => unknown) {
        return fn();
      },
    },
    metrics: {
      getMeter() {
        return noopMeter;
      },
    },
    diag: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    SpanKind: { SERVER: 0, CLIENT: 1, INTERNAL: 2 },
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
  };
});

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

// ---------------------------------------------------------------------------
// Import plugin after mocks are in place
// ---------------------------------------------------------------------------

const { default: armsTracePlugin } = await import("../src/index.js");

// ---------------------------------------------------------------------------
// Helper: create a fresh api with hook capture
// ---------------------------------------------------------------------------

type HookHandler = (event: unknown, ctx: PluginHookContext) => Promise<void> | void;

function makeApi(overrides: Record<string, unknown> = {}): OpenClawPluginApi & {
  handlers: Map<string, HookHandler>;
  fire: (hookName: string, event: unknown, ctx?: Partial<PluginHookContext>) => Promise<void>;
} {
  const handlers = new Map<string, HookHandler>();
  const api: OpenClawPluginApi & {
    handlers: Map<string, HookHandler>;
    fire: (hookName: string, event: unknown, ctx?: Partial<PluginHookContext>) => Promise<void>;
  } = {
    config: {},
    pluginConfig: {
      endpoint: "https://otlp-test.example.com:4318",
      headers: { "x-arms-license-key": "test-key" },
      serviceName: "test-svc",
      debug: false,
      ...overrides,
    },
    runtime: { version: "1.0.0" },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: HookHandler) => {
      handlers.set(hookName, handler);
    }),
    handlers,
    fire: async (hookName: string, event: unknown, ctx?: Partial<PluginHookContext>) => {
      const h = handlers.get(hookName);
      if (!h) throw new Error(`No handler registered for hook: ${hookName}`);
      await h(event, { sessionKey: "test/user1", agentId: "main", ...ctx } as PluginHookContext);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function spansByName(name: string | RegExp): MockSpanRecord[] {
  return capturedSpans.filter((s) =>
    typeof name === "string" ? s.name === name : name.test(s.name),
  );
}

function assertL1Structure(
  expectedSpans: Array<{ name: string | RegExp; count: number }>,
) {
  for (const { name, count } of expectedSpans) {
    const found = spansByName(name);
    expect(found.length, `L1: expected ${count} span(s) matching "${name}", got ${found.length}`).toBe(count);
  }
}

function assertL2CoreAttributes(span: MockSpanRecord, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(span.attributes[key], `L2: attribute "${key}" on span "${span.name}"`).toEqual(value);
  }
}

function assertL3WhitelistEquivalent(span: MockSpanRecord, key: string, expectedJsonValue: unknown) {
  const actual = span.attributes[key];
  if (actual === undefined && expectedJsonValue === undefined) return;
  const actualParsed = typeof actual === "string" ? JSON.parse(actual) : actual;
  const expectedParsed = typeof expectedJsonValue === "string" ? JSON.parse(expectedJsonValue as string) : expectedJsonValue;
  expect(actualParsed, `L3: JSON-equivalent check for "${key}" on span "${span.name}"`).toEqual(expectedParsed);
}

/**
 * L4: timestamp and parent-chain hard assertions.
 * - Verifies startTime/endTime are defined numbers.
 * - Verifies parent-child span relationships match the expected hierarchy.
 */
function assertL4Timestamp(span: MockSpanRecord, opts: { startDefined?: boolean; endDefined?: boolean } = {}) {
  if (opts.startDefined !== false) {
    expect(span.startTime, `L4: startTime should be a number on "${span.name}"`).toBeTypeOf("number");
  }
  if (opts.endDefined !== false) {
    expect(span.endTime, `L4: endTime should be a number on "${span.name}"`).toBeTypeOf("number");
  }
}

function assertL4Parent(
  span: MockSpanRecord,
  expectedParentName: string | RegExp | null,
) {
  if (expectedParentName === null) {
    expect(
      span.parentSpanId,
      `L4: "${span.name}" should have no parent (root span)`,
    ).toBeUndefined();
    return;
  }
  expect(span.parentSpanId, `L4: "${span.name}" should have a parentSpanId`).toBeDefined();
  const parent = capturedSpans.find((s) => s.spanId === span.parentSpanId);
  expect(parent, `L4: parent span for "${span.name}" (parentSpanId=${span.parentSpanId}) not found`).toBeDefined();
  if (typeof expectedParentName === "string") {
    expect(parent!.name, `L4: parent of "${span.name}" should be "${expectedParentName}"`).toBe(expectedParentName);
  } else {
    expect(parent!.name, `L4: parent of "${span.name}" should match ${expectedParentName}`).toMatch(expectedParentName);
  }
}

function assertL4TimestampOrder(parent: MockSpanRecord, child: MockSpanRecord) {
  if (parent.startTime !== undefined && child.startTime !== undefined) {
    expect(
      parent.startTime <= child.startTime,
      `L4: parent "${parent.name}" startTime (${parent.startTime}) should be <= child "${child.name}" startTime (${child.startTime})`,
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("trace-compat: regression baseline", () => {
  beforeEach(() => {
    capturedSpans = [];
    openSpanMap.clear();
    spanIdCounter = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Flow 1: Single turn, no tool call
  // =========================================================================
  describe("Flow 1: single turn, no tool", () => {
    it("produces correct span structure and attributes", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // message_received
      await api.fire("message_received", {
        from: "user-1",
        content: "Hello",
        timestamp: baseTime,
      });

      // before_agent_start
      await api.fire("before_agent_start", {
        prompt: "Hello",
        messages: [],
      });

      // llm_input
      await api.fire("llm_input", {
        runId: "run-abc-001",
        sessionId: "sess-001",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "You are a helpful assistant.",
        prompt: "Hello",
        historyMessages: [],
        imagesCount: 0,
      });

      // before_message_write (text reply)
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Hi there!",
          timestamp: baseTime + 500,
          stopReason: "stop",
          usage: { input: 10, output: 5 },
        },
      });

      // Allow enqueued trace tasks + TTFB wait timeout to run
      await vi.advanceTimersByTimeAsync(250);

      // agent_end
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
        success: true,
        durationMs: 600,
      });

      // Wait for the setTimeout(100) inside agent_end
      await vi.advanceTimersByTimeAsync(250);

      // -- L1: Structure --
      assertL1Structure([
        { name: "enter_ai_application_system", count: 1 },
        { name: /^invoke_agent/, count: 1 },
        { name: "react step", count: 1 },
        { name: /^chat /, count: 1 },
      ]);
      expect(capturedSpans.length).toBeGreaterThanOrEqual(4);

      // -- L2: Core attributes on LLM span --
      const llmSpan = spansByName(/^chat /)[0];
      assertL2CoreAttributes(llmSpan, {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.response.model": "gpt-4o",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      });

      // -- L2: Core attributes on step span --
      const stepSpan = spansByName("react step")[0];
      assertL2CoreAttributes(stepSpan, {
        "gen_ai.operation.name": "react",
        "gen_ai.react.round": 1,
      });

      // -- L2: Core attributes on agent span --
      const agentSpan = spansByName(/^invoke_agent/)[0];
      assertL2CoreAttributes(agentSpan, {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "openclaw",
      });

      // -- L2: Core attributes on entry span --
      const entrySpan = spansByName("enter_ai_application_system")[0];
      assertL2CoreAttributes(entrySpan, {
        "gen_ai.operation.name": "enter",
      });

      // -- L2: openclaw attributes --
      expect(llmSpan.attributes["openclaw.version"]).toBe("1.0.0");
      expect(llmSpan.attributes["openclaw.run.id"]).toBeDefined();
      expect(llmSpan.attributes["gen_ai.session.id"]).toBeDefined();

      // -- L3: finish_reasons is JSON string --
      assertL3WhitelistEquivalent(llmSpan, "gen_ai.response.finish_reasons", '["stop"]');

      // -- L3: system_instructions --
      assertL3WhitelistEquivalent(
        llmSpan,
        "gen_ai.system_instructions",
        JSON.stringify([{ type: "text", content: "You are a helpful assistant." }]),
      );

      // -- L4: Timestamps --
      assertL4Timestamp(entrySpan);
      assertL4Timestamp(agentSpan);
      assertL4Timestamp(stepSpan);
      assertL4Timestamp(llmSpan);

      // -- L4: Parent-child chain: Entry -> Agent -> Step -> LLM --
      assertL4Parent(entrySpan, null);
      assertL4Parent(agentSpan, "enter_ai_application_system");
      assertL4Parent(stepSpan, /^invoke_agent/);
      assertL4Parent(llmSpan, "react step");

      // -- L4: Timestamp ordering --
      assertL4TimestampOrder(entrySpan, agentSpan);
      assertL4TimestampOrder(agentSpan, stepSpan);
      assertL4TimestampOrder(stepSpan, llmSpan);
    });
  });

  // =========================================================================
  // Flow 2: Multi-segment LLM with tool call
  // =========================================================================
  describe("Flow 2: tool call with multi-segment LLM", () => {
    it("produces correct span structure for tool call flow", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // message_received
      await api.fire("message_received", {
        from: "user-1",
        content: "What's the weather?",
        timestamp: baseTime,
      });

      // before_agent_start
      await api.fire("before_agent_start", { prompt: "What's the weather?", messages: [] });

      // llm_input (first LLM call — will produce tool_call)
      await api.fire("llm_input", {
        runId: "run-tool-001",
        sessionId: "sess-002",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "You are a weather assistant.",
        prompt: "What's the weather?",
        historyMessages: [],
        imagesCount: 0,
      });

      // before_message_write (tool_call response)
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_001", name: "get_weather", arguments: '{"city":"Beijing"}' },
          ],
          timestamp: baseTime + 300,
          stopReason: "toolUse",
          usage: { input: 15, output: 8 },
        },
      });
      await vi.advanceTimersByTimeAsync(250);

      // before_tool_call
      await api.fire("before_tool_call", {
        toolName: "get_weather",
        params: { city: "Beijing" },
        runId: "run-tool-001",
        toolCallId: "call_001",
      });

      // after_tool_call
      await api.fire("after_tool_call", {
        toolName: "get_weather",
        params: { city: "Beijing" },
        runId: "run-tool-001",
        toolCallId: "call_001",
        result: '{"temp": 25}',
        durationMs: 200,
      });

      // llm_input (second LLM call — uses tool result)
      await api.fire("llm_input", {
        runId: "run-tool-001",
        sessionId: "sess-002",
        provider: "openai",
        model: "gpt-4o",
        prompt: "What's the weather?",
        historyMessages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call_001", name: "get_weather" }] },
          { role: "toolResult", content: [{ type: "toolResult", toolCallId: "call_001", content: '{"temp": 25}' }] },
        ],
        imagesCount: 0,
      });

      // before_message_write (final text reply)
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "The temperature in Beijing is 25°C.",
          timestamp: baseTime + 800,
          stopReason: "stop",
          usage: { input: 30, output: 12 },
        },
      });
      await vi.advanceTimersByTimeAsync(250);

      // agent_end
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "What's the weather?" },
          { role: "assistant", content: [{ type: "toolCall", id: "call_001", name: "get_weather" }] },
          { role: "tool", content: '{"temp": 25}' },
          { role: "assistant", content: "The temperature in Beijing is 25°C." },
        ],
        success: true,
        durationMs: 900,
      });

      await vi.advanceTimersByTimeAsync(200);

      // -- L1: Structure --
      assertL1Structure([
        { name: "enter_ai_application_system", count: 1 },
        { name: /^invoke_agent/, count: 1 },
        { name: "react step", count: 2 },  // 2 steps: pre-tool + post-tool
        { name: /^chat /, count: 2 },       // 2 LLM segments
        { name: /^execute_tool/, count: 1 },
      ]);

      // -- L2: Tool span attributes --
      const toolSpan = spansByName(/^execute_tool/)[0];
      assertL2CoreAttributes(toolSpan, {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "get_weather",
        "gen_ai.tool.call.id": "call_001",
        "gen_ai.tool.type": "function",
      });
      expect(toolSpan.attributes["gen_ai.tool.call.result"]).toBeDefined();

      // -- L2: First LLM segment should have toolUse finish reason --
      const llmSpans = spansByName(/^chat /);
      assertL3WhitelistEquivalent(llmSpans[0], "gen_ai.response.finish_reasons", '["toolUse"]');
      assertL3WhitelistEquivalent(llmSpans[1], "gen_ai.response.finish_reasons", '["stop"]');

      // -- L2: Step spans should have incrementing rounds --
      const stepSpans = spansByName("react step");
      expect(stepSpans[0].attributes["gen_ai.react.round"]).toBe(1);
      expect(stepSpans[1].attributes["gen_ai.react.round"]).toBe(2);

      // -- L4: Timestamps --
      const entrySpan = spansByName("enter_ai_application_system")[0];
      const agentSpan = spansByName(/^invoke_agent/)[0];
      assertL4Timestamp(entrySpan);
      assertL4Timestamp(agentSpan);
      for (const s of stepSpans) assertL4Timestamp(s);
      for (const s of llmSpans) assertL4Timestamp(s);
      assertL4Timestamp(toolSpan);

      // -- L4: Parent-child chain --
      assertL4Parent(entrySpan, null);
      assertL4Parent(agentSpan, "enter_ai_application_system");
      assertL4Parent(stepSpans[0], /^invoke_agent/);
      assertL4Parent(stepSpans[1], /^invoke_agent/);
      assertL4Parent(llmSpans[0], "react step");
      assertL4Parent(llmSpans[1], "react step");
      assertL4Parent(toolSpan, "react step");

      // -- L4: Timestamp ordering --
      assertL4TimestampOrder(entrySpan, agentSpan);
      assertL4TimestampOrder(agentSpan, stepSpans[0]);
    });
  });

  // =========================================================================
  // Flow 3: Out-of-order — before_message_write before llm_input
  // =========================================================================
  describe("Flow 3: out-of-order (before_message_write before llm_input)", () => {
    it("buffers assistant message and replays after llm_input", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // message_received (creates context but hasSeenLlmInput=false)
      await api.fire("message_received", {
        from: "user-1",
        content: "Order pizza",
        timestamp: baseTime,
      });

      // before_message_write arrives BEFORE llm_input — should be buffered
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Sure, ordering pizza now.",
          timestamp: baseTime + 400,
          stopReason: "stop",
          usage: { input: 8, output: 6 },
        },
      });
      await vi.advanceTimersByTimeAsync(50);

      // No LLM span should have been produced yet
      const llmBefore = spansByName(/^chat /);
      expect(llmBefore.length).toBe(0);

      // before_agent_start
      await api.fire("before_agent_start", { prompt: "Order pizza", messages: [] });

      // llm_input — should trigger replay of the buffered assistant message
      await api.fire("llm_input", {
        runId: "run-ooo-001",
        sessionId: "sess-003",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        prompt: "Order pizza",
        historyMessages: [],
        imagesCount: 0,
      });
      // 200ms+ to cover the TTFB wait timeout inside exportPendingLlmSpan
      await vi.advanceTimersByTimeAsync(250);

      // Now there should be an LLM span
      const llmAfter = spansByName(/^chat /);
      expect(llmAfter.length).toBe(1);
      assertL2CoreAttributes(llmAfter[0], {
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-3-5-sonnet",
      });

      // agent_end
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Order pizza" },
          { role: "assistant", content: "Sure, ordering pizza now." },
        ],
        success: true,
        durationMs: 500,
      });
      await vi.advanceTimersByTimeAsync(200);

      assertL1Structure([
        { name: "enter_ai_application_system", count: 1 },
        { name: /^invoke_agent/, count: 1 },
        { name: "react step", count: 1 },
        { name: /^chat /, count: 1 },
      ]);

      // -- L4: Timestamps and parent chain --
      const entrySpan = spansByName("enter_ai_application_system")[0];
      const agentSpan = spansByName(/^invoke_agent/)[0];
      const stepSpan = spansByName("react step")[0];
      const llmSpan = spansByName(/^chat /)[0];

      assertL4Timestamp(entrySpan);
      assertL4Timestamp(agentSpan);
      assertL4Timestamp(stepSpan);
      assertL4Timestamp(llmSpan);

      assertL4Parent(entrySpan, null);
      assertL4Parent(agentSpan, "enter_ai_application_system");
      assertL4Parent(stepSpan, /^invoke_agent/);
      assertL4Parent(llmSpan, "react step");

      assertL4TimestampOrder(entrySpan, agentSpan);
      assertL4TimestampOrder(agentSpan, stepSpan);
      assertL4TimestampOrder(stepSpan, llmSpan);
    });
  });

  // =========================================================================
  // Flow 4: runId rebind (temporary -> real)
  // =========================================================================
  describe("Flow 4: runId rebind", () => {
    it("patches open span attributes when runId rebinds", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // message_received with no runId (temporary runId created internally)
      await api.fire("message_received", {
        from: "user-1",
        content: "Translate this",
        timestamp: baseTime,
      });

      // before_agent_start — still no real runId
      await api.fire("before_agent_start", { prompt: "Translate this", messages: [] });

      // llm_input carries the real runId — triggers rebind
      await api.fire("llm_input", {
        runId: "real-run-123",
        sessionId: "sess-004",
        provider: "openai",
        model: "gpt-4o-mini",
        prompt: "Translate this",
        historyMessages: [],
        imagesCount: 0,
      });

      // before_message_write
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Translation result here.",
          timestamp: baseTime + 300,
          stopReason: "stop",
          usage: { input: 10, output: 8 },
        },
      });
      await vi.advanceTimersByTimeAsync(250);

      // agent_end
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Translate this" },
          { role: "assistant", content: "Translation result here." },
        ],
        success: true,
        durationMs: 400,
      });
      await vi.advanceTimersByTimeAsync(250);

      // Verify the LLM span carries the rebound runId
      const llmSpan = spansByName(/^chat /)[0];
      expect(llmSpan.attributes["openclaw.run.id"]).toBe("real-run-123");

      // Regression guard: Entry and Agent spans must also carry the real
      // runId after rebind. Previously the handler-managed Entry/Agent
      // spans were overwritten back to the temporary runId at stop time
      // via applyXxxFinishAttributes re-applying stale invocation.attributes.
      const entrySpanForRunId = spansByName("enter_ai_application_system")[0];
      const agentSpanForRunId = spansByName(/^invoke_agent/)[0];
      expect(entrySpanForRunId.attributes["openclaw.run.id"]).toBe("real-run-123");
      expect(entrySpanForRunId.attributes["openclaw.turn.id"]).toBe("real-run-123");
      expect(agentSpanForRunId.attributes["openclaw.run.id"]).toBe("real-run-123");
      expect(agentSpanForRunId.attributes["openclaw.turn.id"]).toBe("real-run-123");

      assertL1Structure([
        { name: "enter_ai_application_system", count: 1 },
        { name: /^invoke_agent/, count: 1 },
        { name: "react step", count: 1 },
        { name: /^chat /, count: 1 },
      ]);

      // -- L4: Timestamps and parent chain --
      const entrySpan = spansByName("enter_ai_application_system")[0];
      const agentSpan = spansByName(/^invoke_agent/)[0];
      const stepSpan = spansByName("react step")[0];

      assertL4Timestamp(entrySpan);
      assertL4Timestamp(agentSpan);
      assertL4Timestamp(stepSpan);
      assertL4Timestamp(llmSpan);

      assertL4Parent(entrySpan, null);
      assertL4Parent(agentSpan, "enter_ai_application_system");
      assertL4Parent(stepSpan, /^invoke_agent/);
      assertL4Parent(llmSpan, "react step");
    });
  });

  // =========================================================================
  // Flow 5: agent_end delayed close (setTimeout timing)
  // =========================================================================
  describe("Flow 5: agent_end delayed span close", () => {
    it("closes entry and agent spans after setTimeout delay", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // Minimal flow to set up spans
      await api.fire("message_received", {
        from: "user-1",
        content: "Hi",
        timestamp: baseTime,
      });
      await api.fire("before_agent_start", { prompt: "Hi", messages: [] });
      await api.fire("llm_input", {
        runId: "run-delay-001",
        sessionId: "sess-005",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Hi",
        historyMessages: [],
        imagesCount: 0,
      });
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Hello!",
          timestamp: baseTime + 200,
          stopReason: "stop",
          usage: { input: 5, output: 3 },
        },
      });
      await vi.advanceTimersByTimeAsync(250);

      const spansBeforeAgentEnd = capturedSpans.length;

      // agent_end
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
        ],
        success: true,
        durationMs: 300,
      });

      // Before setTimeout fires: entry and agent end attributes not yet applied
      // (They are applied inside the setTimeout callback in agent_end)
      const spansAfterAgentEndSync = capturedSpans.length;

      // Advance past the 100ms setTimeout + TTFB wait
      await vi.advanceTimersByTimeAsync(250);

      // After setTimeout: span count should have increased
      // (entry span start counted, agent span start counted, both now ended)
      // Entry and agent spans are "started" via startSpan but ended via endSpanById
      // which calls span.end() — captured in our mock

      // Verify that we have the expected full set of spans
      assertL1Structure([
        { name: "enter_ai_application_system", count: 1 },
        { name: /^invoke_agent/, count: 1 },
        { name: "react step", count: 1 },
        { name: /^chat /, count: 1 },
      ]);

      // Verify entry span has output messages (set in the setTimeout callback)
      const entrySpan = spansByName("enter_ai_application_system")[0];
      expect(entrySpan.attributes["gen_ai.output.messages"]).toBeDefined();

      // Verify agent span has duration
      const agentSpan = spansByName(/^invoke_agent/)[0];
      expect(agentSpan.attributes["agent.duration_ms"]).toBeDefined();

      // -- L4: Timestamps --
      const stepSpan = spansByName("react step")[0];
      const llmSpan = spansByName(/^chat /)[0];

      assertL4Timestamp(entrySpan);
      assertL4Timestamp(agentSpan);
      assertL4Timestamp(stepSpan);
      assertL4Timestamp(llmSpan);

      // -- L4: Parent-child chain --
      assertL4Parent(entrySpan, null);
      assertL4Parent(agentSpan, "enter_ai_application_system");
      assertL4Parent(stepSpan, /^invoke_agent/);
      assertL4Parent(llmSpan, "react step");

      // -- L4: Timestamp ordering --
      assertL4TimestampOrder(entrySpan, agentSpan);
      assertL4TimestampOrder(agentSpan, stepSpan);
      assertL4TimestampOrder(stepSpan, llmSpan);
    });
  });

  // =========================================================================
  // Flow 6: agent_end fires BEFORE final before_message_write (race condition)
  // =========================================================================
  describe("Flow 6: agent_end races with pending final LLM", () => {
    it("Step.endTime >= child LLM.endTime even when final before_message_write is late", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      await api.fire("message_received", {
        from: "user-1",
        content: "Summarize",
        timestamp: baseTime,
      });
      await api.fire("before_agent_start", { prompt: "Summarize", messages: [] });

      // llm_input sets llmPendingStartTime; final LLM is in-flight.
      await api.fire("llm_input", {
        runId: "run-race-001",
        sessionId: "sess-006",
        provider: "openai",
        model: "gpt-4o",
        prompt: "Summarize",
        historyMessages: [],
        imagesCount: 0,
      });

      // agent_end fires BEFORE before_message_write. It should wait up to 5s
      // for the pending LLM. Schedule the final before_message_write to fire
      // 300ms later to simulate real-world late flushing of the final reply.
      const firePromise = api.fire("agent_end", {
        messages: [
          { role: "user", content: "Summarize" },
          { role: "assistant", content: "Done." },
        ],
        success: true,
        durationMs: 300,
      });

      // Schedule the late before_message_write at 300ms after agent_end starts
      await vi.advanceTimersByTimeAsync(300);
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Done.",
          timestamp: baseTime + 300,
          stopReason: "stop",
          usage: { input: 5, output: 2 },
        },
      });

      // Allow TTFB wait timeout + agent_end polling loop to detect LLM completion
      await vi.advanceTimersByTimeAsync(250);
      await firePromise;

      // Drain agent_end's setTimeout(100) closing Entry/Agent
      await vi.advanceTimersByTimeAsync(250);

      const entrySpan = spansByName("enter_ai_application_system")[0];
      const agentSpan = spansByName(/^invoke_agent/)[0];
      const stepSpan = spansByName("react step")[0];
      const llmSpan = spansByName(/^chat /)[0];

      expect(entrySpan).toBeDefined();
      expect(agentSpan).toBeDefined();
      expect(stepSpan).toBeDefined();
      expect(llmSpan).toBeDefined();

      // The key regression guard: Step.endTime must be >= LLM.endTime
      // Prior to the fix, agent_end closed Step before the final
      // before_message_write fired, resulting in Step ending before its
      // child LLM.
      const stepEnd = (stepSpan.startTime ?? 0) + (stepSpan.endTime != null
        ? stepSpan.endTime - (stepSpan.startTime ?? 0)
        : 0);
      // Since our mock records endTime directly, compare raw endTimes
      expect(stepSpan.endTime, "Step.endTime must be defined").toBeTypeOf("number");
      expect(llmSpan.endTime, "LLM.endTime must be defined").toBeTypeOf("number");
      expect(
        (stepSpan.endTime ?? 0) >= (llmSpan.endTime ?? 0),
        `Step.endTime (${stepSpan.endTime}) must be >= LLM.endTime (${llmSpan.endTime})`,
      ).toBe(true);

      // Parent-child monotonicity for the whole chain
      expect((agentSpan.endTime ?? 0) >= (stepSpan.endTime ?? 0)).toBe(true);
      expect((entrySpan.endTime ?? 0) >= (agentSpan.endTime ?? 0)).toBe(true);
    });
  });

  // =========================================================================
  // Flow 7: tool definitions and time_to_first_token
  // =========================================================================
  describe("Flow 7: tool definitions and time_to_first_token", () => {
    it("LLM span contains gen_ai.tool.definitions and gen_ai.response.time_to_first_token", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      await api.fire("message_received", {
        from: "user-1",
        content: "Check weather",
        timestamp: baseTime,
      });
      await api.fire("before_agent_start", { prompt: "Check weather", messages: [] });

      const tools = [
        {
          name: "get_weather",
          type: "function",
          description: "Get current weather",
          parameters: { type: "object", properties: { location: { type: "string" } } },
        },
        {
          name: "search",
          type: "function",
          description: "Search the web",
          parameters: { type: "object" },
        },
      ];
      await api.fire("llm_input", {
        runId: "run-tool-def-001",
        sessionId: "sess-td-001",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "You are helpful",
        prompt: "Check weather",
        historyMessages: [],
        imagesCount: 0,
        tools,
      });

      // Simulate model_call_ended with TTFB
      await api.fire("model_call_ended", {
        runId: "run-tool-def-001",
        callId: "run-tool-def-001:model:1",
        provider: "openai",
        model: "gpt-4o",
        durationMs: 800,
        outcome: "completed",
        timeToFirstByteMs: 150,
      });

      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "The weather is sunny.",
          timestamp: baseTime + 800,
          stopReason: "stop",
          usage: { input: 50, output: 10 },
        },
      });

      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Check weather" },
          { role: "assistant", content: "The weather is sunny." },
        ],
        success: true,
        durationMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(200);

      // -- Assertions --

      const llmSpan = spansByName(/^chat /)[0];
      expect(llmSpan, "LLM span should exist").toBeDefined();

      // Tool definitions should be serialized as JSON string containing tool names
      const toolDefs = llmSpan.attributes["gen_ai.tool.definitions"];
      expect(toolDefs, "gen_ai.tool.definitions should be set").toBeDefined();
      expect(typeof toolDefs).toBe("string");
      const parsed = JSON.parse(toolDefs as string);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("get_weather");
      expect(parsed[0].type).toBe("function");
      expect(parsed[0].description).toBe("Get current weather");
      expect(parsed[0].parameters).toBeDefined();
      expect(parsed[1].name).toBe("search");

      // TTFB: 150ms = 150_000_000 nanoseconds
      const ttft = llmSpan.attributes["gen_ai.response.time_to_first_token"];
      expect(ttft, "gen_ai.response.time_to_first_token should be set").toBeDefined();
      expect(ttft).toBe(150_000_000);
    });
  });

  // =========================================================================
  // Flow 8: graceful degradation without tools and model_call_ended
  // =========================================================================
  describe("Flow 8: graceful degradation on older OpenClaw versions", () => {
    it("LLM span omits tool.definitions and time_to_first_token when unavailable", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      await api.fire("message_received", {
        from: "user-1",
        content: "Hi",
        timestamp: baseTime,
      });
      await api.fire("before_agent_start", { prompt: "Hi", messages: [] });

      // llm_input without tools field (old OpenClaw)
      await api.fire("llm_input", {
        runId: "run-old-001",
        sessionId: "sess-old-001",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "Help",
        prompt: "Hi",
        historyMessages: [],
        imagesCount: 0,
      });

      // No model_call_ended hook fired (old OpenClaw version)

      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Hello!",
          timestamp: baseTime + 300,
          stopReason: "stop",
          usage: { input: 5, output: 2 },
        },
      });

      await vi.advanceTimersByTimeAsync(250);
      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello!" },
        ],
        success: true,
        durationMs: 500,
      });
      await vi.advanceTimersByTimeAsync(250);

      const llmSpan = spansByName(/^chat /)[0];
      expect(llmSpan, "LLM span should exist").toBeDefined();

      // These attributes should NOT be set
      expect(llmSpan.attributes["gen_ai.tool.definitions"]).toBeUndefined();
      expect(llmSpan.attributes["gen_ai.response.time_to_first_token"]).toBeUndefined();
    });
  });

  // =========================================================================
  // Flow 9: gen_ai.agent.name on all GenAI spans + otel.scope.name
  // =========================================================================
  describe("Flow 9: gen_ai.agent.name propagation and otel.scope.name", () => {
    it("all GenAI spans carry gen_ai.agent.name from hookCtx.agentId", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // message_received does NOT have agentId in its PluginHookMessageContext
      await api.fire("message_received", {
        from: "user-1",
        content: "What's the weather?",
        timestamp: baseTime,
      }, { agentId: undefined });

      await api.fire("before_agent_start", {
        prompt: "What's the weather?",
        messages: [],
      }, { agentId: "my-agent" });

      await api.fire("llm_input", {
        runId: "run-an-001",
        sessionId: "sess-an-001",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "You are helpful.",
        prompt: "What's the weather?",
        historyMessages: [],
        imagesCount: 0,
      }, { agentId: "my-agent" });

      // Tool call via before_message_write
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_an1", name: "get_weather", arguments: '{"city":"Beijing"}' },
          ],
          timestamp: baseTime + 200,
          stopReason: "toolUse",
          usage: { input: 10, output: 5 },
        },
      }, { agentId: "my-agent" });
      await vi.advanceTimersByTimeAsync(250);

      await api.fire("before_tool_call", {
        toolName: "get_weather",
        params: { city: "Beijing" },
        runId: "run-an-001",
        toolCallId: "call_an1",
      }, { agentId: "my-agent" });

      await api.fire("after_tool_call", {
        toolName: "get_weather",
        params: { city: "Beijing" },
        runId: "run-an-001",
        toolCallId: "call_an1",
        result: '{"temp": 25}',
        durationMs: 100,
      }, { agentId: "my-agent" });

      // Second LLM call
      await api.fire("llm_input", {
        runId: "run-an-001",
        sessionId: "sess-an-001",
        provider: "openai",
        model: "gpt-4o",
        prompt: "What's the weather?",
        historyMessages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call_an1", name: "get_weather" }] },
          { role: "toolResult", content: [{ type: "toolResult", toolCallId: "call_an1", content: '{"temp": 25}' }] },
        ],
        imagesCount: 0,
      }, { agentId: "my-agent" });

      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "It's 25°C in Beijing.",
          timestamp: baseTime + 500,
          stopReason: "stop",
          usage: { input: 20, output: 8 },
        },
      }, { agentId: "my-agent" });

      await vi.advanceTimersByTimeAsync(250);

      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "What's the weather?" },
          { role: "assistant", content: "It's 25°C in Beijing." },
        ],
        success: true,
        durationMs: 600,
      }, { agentId: "my-agent" });

      await vi.advanceTimersByTimeAsync(200);

      const entrySpan = spansByName("enter_ai_application_system")[0];
      const agentSpan = spansByName(/^invoke_agent/)[0];
      const stepSpans = spansByName("react step");
      const llmSpans = spansByName(/^chat /);
      const toolSpan = spansByName(/^execute_tool/)[0];

      expect(entrySpan, "ENTRY span should exist").toBeDefined();
      expect(agentSpan, "AGENT span should exist").toBeDefined();
      expect(stepSpans.length, "STEP spans should exist").toBeGreaterThanOrEqual(1);
      expect(llmSpans.length, "LLM spans should exist").toBeGreaterThanOrEqual(1);
      expect(toolSpan, "TOOL span should exist").toBeDefined();

      const allSpans: Array<[string, MockSpanRecord]> = [
        ["ENTRY", entrySpan],
        ["AGENT", agentSpan],
        ...stepSpans.map((s, i): [string, MockSpanRecord] => [`STEP[${i}]`, s]),
        ...llmSpans.map((s, i): [string, MockSpanRecord] => [`LLM[${i}]`, s]),
        ["TOOL", toolSpan],
      ];

      for (const [label, span] of allSpans) {
        expect(
          span.attributes["gen_ai.agent.name"],
          `${label} span should have gen_ai.agent.name = "my-agent"`,
        ).toBe("my-agent");
      }
    });
  });

  // =========================================================================
  // Flow 10: each LLM span gets its own TTFB
  // =========================================================================
  describe("Flow 10: per-LLM-span time_to_first_token", () => {
    it("each LLM span carries its own TTFB, including the first one", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      await api.fire("message_received", {
        from: "user-1",
        content: "Multi-turn test",
        timestamp: baseTime,
      });
      await api.fire("before_agent_start", { prompt: "Multi-turn test", messages: [] });

      // --- 1st LLM call ---
      await api.fire("llm_input", {
        runId: "run-ttfb-multi",
        sessionId: "sess-ttfb-multi",
        provider: "anthropic",
        model: "sonnet-4.6",
        systemPrompt: "You are helpful",
        prompt: "Multi-turn test",
        historyMessages: [],
        imagesCount: 0,
      });

      // model_call_ended arrives (1st call TTFB = 120ms)
      await api.fire("model_call_ended", {
        runId: "run-ttfb-multi",
        callId: "run-ttfb-multi:model:1",
        provider: "anthropic",
        model: "sonnet-4.6",
        durationMs: 500,
        outcome: "completed",
        timeToFirstByteMs: 120,
      });

      // before_message_write with tool call
      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_t1", name: "search", arguments: '{"q":"test"}' },
          ],
          timestamp: baseTime + 500,
          stopReason: "toolUse",
          usage: { input: 30, output: 8 },
        },
      });
      await vi.advanceTimersByTimeAsync(100);

      // Tool execution
      await api.fire("before_tool_call", {
        toolName: "search",
        params: { q: "test" },
        runId: "run-ttfb-multi",
        toolCallId: "call_t1",
      });
      await api.fire("after_tool_call", {
        toolName: "search",
        params: { q: "test" },
        runId: "run-ttfb-multi",
        toolCallId: "call_t1",
        result: '{"results": []}',
        durationMs: 200,
      });

      // --- 2nd LLM call ---
      await api.fire("llm_input", {
        runId: "run-ttfb-multi",
        sessionId: "sess-ttfb-multi",
        provider: "anthropic",
        model: "sonnet-4.6",
        prompt: "Multi-turn test",
        historyMessages: [
          { role: "assistant", content: [{ type: "toolCall", id: "call_t1", name: "search" }] },
          { role: "toolResult", content: [{ type: "toolResult", toolCallId: "call_t1", content: '{"results": []}' }] },
        ],
        imagesCount: 0,
      });

      // model_call_ended arrives (2nd call TTFB = 250ms)
      await api.fire("model_call_ended", {
        runId: "run-ttfb-multi",
        callId: "run-ttfb-multi:model:2",
        provider: "anthropic",
        model: "sonnet-4.6",
        durationMs: 700,
        outcome: "completed",
        timeToFirstByteMs: 250,
      });

      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Here are the results.",
          timestamp: baseTime + 1400,
          stopReason: "stop",
          usage: { input: 50, output: 12 },
        },
      });
      await vi.advanceTimersByTimeAsync(100);

      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "Multi-turn test" },
          { role: "assistant", content: "Here are the results." },
        ],
        success: true,
        durationMs: 1500,
      });
      await vi.advanceTimersByTimeAsync(200);

      // -- Assertions --
      const llmSpans = spansByName(/^chat /);
      expect(llmSpans.length, "should have 2 LLM spans").toBe(2);

      // 1st LLM span: TTFB = 120ms = 120_000_000 ns
      const ttfb1 = llmSpans[0].attributes["gen_ai.response.time_to_first_token"];
      expect(ttfb1, "1st LLM span should have TTFB").toBeDefined();
      expect(ttfb1).toBe(120_000_000);

      // 2nd LLM span: TTFB = 250ms = 250_000_000 ns
      const ttfb2 = llmSpans[1].attributes["gen_ai.response.time_to_first_token"];
      expect(ttfb2, "2nd LLM span should have TTFB").toBeDefined();
      expect(ttfb2).toBe(250_000_000);
    });

    it("LLM span without model_call_ended omits TTFB gracefully", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      await api.fire("message_received", {
        from: "user-1",
        content: "No TTFB test",
        timestamp: baseTime,
      });
      await api.fire("before_agent_start", { prompt: "No TTFB test", messages: [] });

      await api.fire("llm_input", {
        runId: "run-no-ttfb",
        sessionId: "sess-no-ttfb",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "You are helpful",
        prompt: "No TTFB test",
        historyMessages: [],
        imagesCount: 0,
      });

      // No model_call_ended fired (old OpenClaw version)

      await api.fire("before_message_write", {
        message: {
          role: "assistant",
          content: "Done.",
          timestamp: baseTime + 300,
          stopReason: "stop",
          usage: { input: 10, output: 3 },
        },
      });
      await vi.advanceTimersByTimeAsync(250);

      await api.fire("agent_end", {
        messages: [
          { role: "user", content: "No TTFB test" },
          { role: "assistant", content: "Done." },
        ],
        success: true,
        durationMs: 400,
      });
      await vi.advanceTimersByTimeAsync(250);

      const llmSpan = spansByName(/^chat /)[0];
      expect(llmSpan, "LLM span should exist").toBeDefined();
      expect(
        llmSpan.attributes["gen_ai.response.time_to_first_token"],
        "TTFB should not be set without model_call_ended",
      ).toBeUndefined();
    });
  });
});
