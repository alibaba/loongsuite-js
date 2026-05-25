// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
//
// Tests for custom resource attributes and global span attributes feature:
// - parseKeyValueEnv() parsing logic
// - Config merge priority (config > env)
// - Resource injection via resourceAttributes
// - Span attribute propagation via globalSpanAttributes

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawPluginApi, PluginHookContext } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock OTel SDK — capture spans and resource creation calls
// ---------------------------------------------------------------------------

type MockSpanRecord = {
  name: string;
  kind: number;
  startTime?: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  parentSpanId?: string;
  spanId?: string;
  status?: { code: number };
};

let capturedSpans: MockSpanRecord[] = [];
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
      traceId: "mock-trace",
      spanId: uniqueSpanId,
    })),
    _record: record,
  };
}

const mockResourceFromAttributes = vi.fn().mockReturnValue({});

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => {
  class MockOTLPTraceExporter {}
  return { OTLPTraceExporter: MockOTLPTraceExporter };
});

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: (...args: unknown[]) => mockResourceFromAttributes(...args),
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
      active() { return ROOT_CONTEXT; },
      with(ctx: unknown, fn: () => unknown) { return fn(); },
    },
    metrics: { getMeter() { return noopMeter; } },
    diag: { debug() {}, info() {}, warn() {}, error() {} },
    SpanKind: { SERVER: 0, CLIENT: 1, INTERNAL: 2 },
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    ROOT_CONTEXT,
  };
});

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

// ---------------------------------------------------------------------------
// Import plugin after mocks
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
// Env var management helpers
// ---------------------------------------------------------------------------

const envKeysToClean: string[] = [];

function setEnv(key: string, value: string) {
  envKeysToClean.push(key);
  process.env[key] = value;
}

function cleanEnv() {
  for (const key of envKeysToClean) {
    delete process.env[key];
  }
  envKeysToClean.length = 0;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("custom-attributes: parseKeyValueEnv + config merge", () => {
  beforeEach(() => {
    capturedSpans = [];
    spanIdCounter = 0;
    mockResourceFromAttributes.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanEnv();
  });

  // ===========================================================================
  // 1. Resource attributes
  // ===========================================================================

  describe("resourceAttributes — config file", () => {
    it("passes resourceAttributes to resourceFromAttributes", async () => {
      const api = makeApi({
        resourceAttributes: {
          "deployment.environment": "production",
          "k8s.namespace": "default",
        },
      });
      armsTracePlugin.activate(api);

      // Trigger a span to force exporter initialization
      await api.fire("message_received", {
        from: "user-1",
        content: "hi",
        timestamp: Date.now(),
      });
      await api.fire("before_agent_start", { prompt: "hi", messages: [] });
      await api.fire("llm_input", {
        runId: "run-res-001",
        sessionId: "sess-res-001",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "",
        prompt: "hi",
        historyMessages: [],
        imagesCount: 0,
      });

      // resourceFromAttributes should have been called with our custom attributes
      expect(mockResourceFromAttributes).toHaveBeenCalled();
      const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
      expect(resourceArg["deployment.environment"]).toBe("production");
      expect(resourceArg["k8s.namespace"]).toBe("default");
    });
  });

  describe("resourceAttributes — env var OTEL_RESOURCE_ATTRIBUTES", () => {
    it("parses standard key=value,key=value format", async () => {
      setEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.env=staging,k8s.pod.name=pod-abc-123");
      const api = makeApi();
      armsTracePlugin.activate(api);

      await api.fire("message_received", {
        from: "user-1",
        content: "test",
        timestamp: Date.now(),
      });
      await api.fire("before_agent_start", { prompt: "test", messages: [] });
      await api.fire("llm_input", {
        runId: "run-env-001",
        sessionId: "sess-env-001",
        provider: "openai",
        model: "gpt-4o",
        systemPrompt: "",
        prompt: "test",
        historyMessages: [],
        imagesCount: 0,
      });

      expect(mockResourceFromAttributes).toHaveBeenCalled();
      const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
      expect(resourceArg["deployment.env"]).toBe("staging");
      expect(resourceArg["k8s.pod.name"]).toBe("pod-abc-123");
    });

    it("handles values containing equals sign", async () => {
      setEnv("OTEL_RESOURCE_ATTRIBUTES", "custom.tag=key=value,other=normal");
      const api = makeApi();
      armsTracePlugin.activate(api);

      await api.fire("message_received", { from: "u", content: "x", timestamp: Date.now() });
      await api.fire("before_agent_start", { prompt: "x", messages: [] });
      await api.fire("llm_input", {
        runId: "run-eq-001", sessionId: "s1", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "x", historyMessages: [], imagesCount: 0,
      });

      const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
      expect(resourceArg["custom.tag"]).toBe("key=value");
      expect(resourceArg["other"]).toBe("normal");
    });
  });

  describe("resourceAttributes — config > env priority", () => {
    it("config values override env values for same key", async () => {
      setEnv("OTEL_RESOURCE_ATTRIBUTES", "deployment.env=from-env,shared.key=env-val");
      const api = makeApi({
        resourceAttributes: {
          "deployment.env": "from-config",
          "config.only": "yes",
        },
      });
      armsTracePlugin.activate(api);

      await api.fire("message_received", { from: "u", content: "x", timestamp: Date.now() });
      await api.fire("before_agent_start", { prompt: "x", messages: [] });
      await api.fire("llm_input", {
        runId: "run-pri-001", sessionId: "s1", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "x", historyMessages: [], imagesCount: 0,
      });

      const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
      expect(resourceArg["deployment.env"]).toBe("from-config");
      expect(resourceArg["shared.key"]).toBe("env-val");
      expect(resourceArg["config.only"]).toBe("yes");
    });
  });

  // ===========================================================================
  // 2. Global span attributes
  // ===========================================================================

  describe("globalSpanAttributes — config file", () => {
    it("injects globalSpanAttributes into all generated spans", async () => {
      const api = makeApi({
        globalSpanAttributes: {
          "biz.team": "payment",
          "biz.app": "checkout",
          "biz.priority": 1,
        },
      });
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      await api.fire("message_received", { from: "user-1", content: "Hello", timestamp: baseTime });
      await api.fire("before_agent_start", { prompt: "Hello", messages: [] });
      await api.fire("llm_input", {
        runId: "run-gsa-001", sessionId: "sess-gsa", provider: "openai", model: "gpt-4o",
        systemPrompt: "sys", prompt: "Hello", historyMessages: [], imagesCount: 0,
      });
      await api.fire("before_message_write", {
        message: { role: "assistant", content: "Hi!", timestamp: baseTime + 200, stopReason: "stop", usage: { input: 5, output: 3 } },
      });
      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", { messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi!" }], success: true, durationMs: 300 });
      await vi.advanceTimersByTimeAsync(200);

      expect(capturedSpans.length).toBeGreaterThanOrEqual(4);

      for (const span of capturedSpans) {
        expect(span.attributes["biz.team"], `span "${span.name}" should have biz.team`).toBe("payment");
        expect(span.attributes["biz.app"], `span "${span.name}" should have biz.app`).toBe("checkout");
        expect(span.attributes["biz.priority"], `span "${span.name}" should have biz.priority`).toBe(1);
      }
    });
  });

  describe("globalSpanAttributes — env var OTEL_SPAN_ATTRIBUTES", () => {
    it("parses and injects env-defined span attributes", async () => {
      setEnv("OTEL_SPAN_ATTRIBUTES", "env.team=infra,env.region=cn-hangzhou");
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();
      await api.fire("message_received", { from: "user-1", content: "Hi", timestamp: baseTime });
      await api.fire("before_agent_start", { prompt: "Hi", messages: [] });
      await api.fire("llm_input", {
        runId: "run-envspan-001", sessionId: "sess-envspan", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "Hi", historyMessages: [], imagesCount: 0,
      });
      await api.fire("before_message_write", {
        message: { role: "assistant", content: "Hello!", timestamp: baseTime + 100, stopReason: "stop", usage: { input: 3, output: 2 } },
      });
      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", { messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }], success: true, durationMs: 150 });
      await vi.advanceTimersByTimeAsync(200);

      expect(capturedSpans.length).toBeGreaterThanOrEqual(4);
      for (const span of capturedSpans) {
        expect(span.attributes["env.team"], `span "${span.name}" should have env.team`).toBe("infra");
        expect(span.attributes["env.region"], `span "${span.name}" should have env.region`).toBe("cn-hangzhou");
      }
    });
  });

  describe("globalSpanAttributes — config > env priority", () => {
    it("config values override env values for same key", async () => {
      setEnv("OTEL_SPAN_ATTRIBUTES", "biz.team=env-team,env.only=from-env");
      const api = makeApi({
        globalSpanAttributes: {
          "biz.team": "config-team",
          "config.only": "from-config",
        },
      });
      armsTracePlugin.activate(api);

      const baseTime = Date.now();
      await api.fire("message_received", { from: "user-1", content: "X", timestamp: baseTime });
      await api.fire("before_agent_start", { prompt: "X", messages: [] });
      await api.fire("llm_input", {
        runId: "run-pri-span-001", sessionId: "sess-pri", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "X", historyMessages: [], imagesCount: 0,
      });
      await api.fire("before_message_write", {
        message: { role: "assistant", content: "Y", timestamp: baseTime + 50, stopReason: "stop", usage: { input: 2, output: 1 } },
      });
      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", { messages: [{ role: "user", content: "X" }, { role: "assistant", content: "Y" }], success: true, durationMs: 80 });
      await vi.advanceTimersByTimeAsync(200);

      expect(capturedSpans.length).toBeGreaterThanOrEqual(1);
      for (const span of capturedSpans) {
        expect(span.attributes["biz.team"], `span "${span.name}": config should win`).toBe("config-team");
        expect(span.attributes["env.only"], `span "${span.name}": env-only key preserved`).toBe("from-env");
        expect(span.attributes["config.only"], `span "${span.name}": config-only key preserved`).toBe("from-config");
      }
    });
  });

  // ===========================================================================
  // 3. globalSpanAttributes vs customAttributes (per-request) priority
  // ===========================================================================

  describe("globalSpanAttributes vs per-request customAttributes priority", () => {
    it("per-request customAttributes override globalSpanAttributes", async () => {
      const api = makeApi({
        enableTracePropagation: true,
        globalSpanAttributes: {
          "biz.team": "global-team",
          "global.only": "yes",
        },
      });
      armsTracePlugin.activate(api);

      const baseTime = Date.now();

      // Send message with embedded otel custom attributes that override biz.team
      // enableTracePropagation must be true for <!--otel:...--> extraction to occur
      const content = "Hello<!--otel:{\"attr\":{\"biz.team\":\"request-team\",\"request.only\":\"dynamic\"}}-->";
      await api.fire("message_received", { from: "user-1", content, timestamp: baseTime });
      await api.fire("before_agent_start", { prompt: "Hello", messages: [] });
      await api.fire("llm_input", {
        runId: "run-override-001", sessionId: "sess-override", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "Hello", historyMessages: [], imagesCount: 0,
      });
      await api.fire("before_message_write", {
        message: { role: "assistant", content: "World", timestamp: baseTime + 100, stopReason: "stop", usage: { input: 5, output: 3 } },
      });
      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", { messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "World" }], success: true, durationMs: 150 });
      await vi.advanceTimersByTimeAsync(200);

      expect(capturedSpans.length).toBeGreaterThanOrEqual(1);

      // Check that per-request value wins for overlapping key
      for (const span of capturedSpans) {
        expect(span.attributes["biz.team"], `span "${span.name}": per-request should override global`).toBe("request-team");
        expect(span.attributes["global.only"], `span "${span.name}": global-only key preserved`).toBe("yes");
        expect(span.attributes["request.only"], `span "${span.name}": request-only key present`).toBe("dynamic");
      }
    });
  });

  // ===========================================================================
  // 4. Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("empty env var produces no attributes", async () => {
      setEnv("OTEL_RESOURCE_ATTRIBUTES", "");
      setEnv("OTEL_SPAN_ATTRIBUTES", "");
      const api = makeApi();
      armsTracePlugin.activate(api);

      await api.fire("message_received", { from: "u", content: "x", timestamp: Date.now() });
      await api.fire("before_agent_start", { prompt: "x", messages: [] });
      await api.fire("llm_input", {
        runId: "run-empty-001", sessionId: "s1", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "x", historyMessages: [], imagesCount: 0,
      });

      // resourceFromAttributes should not include any custom resource keys
      if (mockResourceFromAttributes.mock.calls.length > 0) {
        const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
        // Standard keys should still exist
        expect(resourceArg["service.name"]).toBe("test-svc");
        // No extra env keys
        expect(Object.keys(resourceArg).every(k =>
          ["service.name", "service.instance.id", "host.name", "telemetry.sdk.language",
           "acs.arms.service.feature", "gen_ai.agent.system"].includes(k)
        )).toBe(true);
      }
    });

    it("malformed env pairs (no = sign) are skipped", async () => {
      setEnv("OTEL_RESOURCE_ATTRIBUTES", "valid.key=val,badpair,=onlyvalue,another.valid=ok");
      const api = makeApi();
      armsTracePlugin.activate(api);

      await api.fire("message_received", { from: "u", content: "x", timestamp: Date.now() });
      await api.fire("before_agent_start", { prompt: "x", messages: [] });
      await api.fire("llm_input", {
        runId: "run-malform-001", sessionId: "s1", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "x", historyMessages: [], imagesCount: 0,
      });

      const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
      expect(resourceArg["valid.key"]).toBe("val");
      expect(resourceArg["another.valid"]).toBe("ok");
      // "badpair" (no =) and "=onlyvalue" (empty key) should be skipped
      expect(resourceArg["badpair"]).toBeUndefined();
      expect(resourceArg[""]).toBeUndefined();
    });

    it("trims whitespace around keys and values", async () => {
      setEnv("OTEL_RESOURCE_ATTRIBUTES", " space.key = space value , trim.key =trimmed");
      const api = makeApi();
      armsTracePlugin.activate(api);

      await api.fire("message_received", { from: "u", content: "x", timestamp: Date.now() });
      await api.fire("before_agent_start", { prompt: "x", messages: [] });
      await api.fire("llm_input", {
        runId: "run-trim-001", sessionId: "s1", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "x", historyMessages: [], imagesCount: 0,
      });

      const resourceArg = mockResourceFromAttributes.mock.calls[0][0] as Record<string, unknown>;
      expect(resourceArg["space.key"]).toBe("space value");
      expect(resourceArg["trim.key"]).toBe("trimmed");
    });

    it("no globalSpanAttributes when neither config nor env is set", async () => {
      const api = makeApi();
      armsTracePlugin.activate(api);

      const baseTime = Date.now();
      await api.fire("message_received", { from: "u", content: "x", timestamp: baseTime });
      await api.fire("before_agent_start", { prompt: "x", messages: [] });
      await api.fire("llm_input", {
        runId: "run-none-001", sessionId: "s1", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "x", historyMessages: [], imagesCount: 0,
      });
      await api.fire("before_message_write", {
        message: { role: "assistant", content: "y", timestamp: baseTime + 50, stopReason: "stop", usage: { input: 1, output: 1 } },
      });
      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }], success: true, durationMs: 80 });
      await vi.advanceTimersByTimeAsync(200);

      // Spans should still have standard openclaw.* attributes but not any custom biz.*
      for (const span of capturedSpans) {
        expect(span.attributes["openclaw.version"]).toBe("1.0.0");
        expect(span.attributes["biz.team"]).toBeUndefined();
      }
    });
  });

  // ===========================================================================
  // 5. Tool call spans also receive globalSpanAttributes
  // ===========================================================================

  describe("tool call spans receive globalSpanAttributes", () => {
    it("before_tool_call + after_tool_call span carries global attrs", async () => {
      const api = makeApi({
        globalSpanAttributes: { "biz.team": "tools-team" },
      });
      armsTracePlugin.activate(api);

      const baseTime = Date.now();
      await api.fire("message_received", { from: "user-1", content: "run bash", timestamp: baseTime });
      await api.fire("before_agent_start", { prompt: "run bash", messages: [] });
      await api.fire("llm_input", {
        runId: "run-tool-001", sessionId: "sess-tool", provider: "openai", model: "gpt-4o",
        systemPrompt: "", prompt: "run bash", historyMessages: [], imagesCount: 0,
      });

      // Tool call
      await api.fire("before_tool_call", {
        toolName: "Bash", params: { command: "ls" }, runId: "run-tool-001", toolCallId: "tc-001",
      });
      await api.fire("after_tool_call", {
        toolName: "Bash", params: { command: "ls" }, runId: "run-tool-001", toolCallId: "tc-001",
        result: "file1.txt", durationMs: 50,
      });

      await api.fire("before_message_write", {
        message: { role: "assistant", content: "Done", timestamp: baseTime + 200, stopReason: "stop", usage: { input: 10, output: 5 } },
      });
      await vi.advanceTimersByTimeAsync(50);
      await api.fire("agent_end", { messages: [{ role: "user", content: "run bash" }, { role: "assistant", content: "Done" }], success: true, durationMs: 250 });
      await vi.advanceTimersByTimeAsync(200);

      // Find tool span
      const toolSpans = capturedSpans.filter(s => s.attributes["gen_ai.tool.name"] === "Bash");
      expect(toolSpans.length).toBeGreaterThanOrEqual(1);
      for (const span of toolSpans) {
        expect(span.attributes["biz.team"]).toBe("tools-team");
      }
    });
  });
});
