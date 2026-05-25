// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the plugin
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
    trace: { setSpan: vi.fn().mockImplementation((_ctx: unknown) => makeContext()) },
    context: { active: vi.fn().mockImplementation(() => makeContext()) },
    SpanKind: { SERVER: 0, CLIENT: 1, INTERNAL: 2 },
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    metrics: { getMeter: vi.fn().mockReturnValue({ createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }) }) },
    diag: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn() },
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
// API mock factory
// ---------------------------------------------------------------------------

function makeApi(pluginConfig: Record<string, unknown> = {}): OpenClawPluginApi & {
  handlers: Map<string, (event: unknown, ctx: unknown) => void>;
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  return {
    config: {},
    pluginConfig: {
      endpoint: "https://otlp-test.example.com:4318",
      headers: { "x-arms-license-key": "test-key" },
      serviceName: "test-svc",
      debug: false,
      ...pluginConfig,
    },
    runtime: { version: "1.0.0" },
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(hookName, handler);
    }),
    handlers,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("armsTracePlugin metadata", () => {
  it("has correct id", () => {
    expect(armsTracePlugin.id).toBe("opentelemetry-instrumentation-openclaw");
  });

  it("has a name", () => {
    expect(typeof armsTracePlugin.name).toBe("string");
    expect(armsTracePlugin.name.length).toBeGreaterThan(0);
  });

  it("has a version string", () => {
    expect(typeof armsTracePlugin.version).toBe("string");
    expect(armsTracePlugin.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("has an activate function", () => {
    expect(typeof armsTracePlugin.activate).toBe("function");
  });
});

describe("armsTracePlugin.activate", () => {
  it("activates without throwing when config is valid", () => {
    const api = makeApi();
    expect(() => armsTracePlugin.activate(api)).not.toThrow();
  });

  it("logs error and returns early when endpoint is missing", () => {
    const api = makeApi({ endpoint: undefined });
    armsTracePlugin.activate(api);
    expect(api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("endpoint")
    );
  });

  it("falls back to legacy openclaw-cms-plugin entry config", () => {
    const api = makeApi({ endpoint: undefined });
    api.config = {
      plugins: {
        entries: {
          "openclaw-cms-plugin": {
            enabled: true,
            config: {
              endpoint: "https://legacy-endpoint.example.com:4318",
              headers: { "x-arms-license-key": "legacy-key" },
              serviceName: "legacy-svc",
            },
          },
        },
      },
    };

    armsTracePlugin.activate(api);
    expect(api.logger.error).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Using legacy 'openclaw-cms-plugin' configuration fallback")
    );
  });

  it("activates successfully when license key is missing (license key is optional)", () => {
    // x-arms-license-key is optional — plugin should activate without error
    const api = makeApi({ headers: {} });
    armsTracePlugin.activate(api);
    expect(api.logger.error).not.toHaveBeenCalled();
    // hooks should still be registered
    const hookNames = vi.mocked(api.on).mock.calls.map(([name]) => name);
    expect(hookNames.length).toBeGreaterThan(0);
  });

  it("registers gateway_stop hook", () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const hookNames = vi.mocked(api.on).mock.calls.map(([name]) => name);
    expect(hookNames).toContain("gateway_stop");
  });

  it("registers message_received hook", () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const hookNames = vi.mocked(api.on).mock.calls.map(([name]) => name);
    expect(hookNames).toContain("message_received");
  });

  it("registers before_tool_call and after_tool_call hooks", () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const hookNames = vi.mocked(api.on).mock.calls.map(([name]) => name);
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
  });

  it("registers llm_input and llm_output hooks", () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const hookNames = vi.mocked(api.on).mock.calls.map(([name]) => name);
    expect(hookNames).toContain("llm_input");
    expect(hookNames).toContain("llm_output");
  });

  it("logs activation message with endpoint and service name", () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("otlp-test.example.com")
    );
  });

  it("respects enabledHooks to skip specific hooks", () => {
    const api = makeApi({ enabledHooks: ["gateway_stop", "message_received"] });
    armsTracePlugin.activate(api);
    const hookNames = vi.mocked(api.on).mock.calls.map(([name]) => name);
    // Only the enabled hooks should be registered
    expect(hookNames).toContain("gateway_stop");
    expect(hookNames).toContain("message_received");
    expect(hookNames).not.toContain("before_tool_call");
  });
});

describe("hook handlers — message_received", () => {
  it("processes message_received without throwing", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const handler = vi.mocked(api.on).mock.calls.find(([name]) => name === "message_received")?.[1];
    expect(handler).toBeDefined();
    if (handler) {
      await expect(
        handler(
          { from: "user-1", content: "Hello", timestamp: Date.now() },
          { sessionKey: "test-channel", agentId: "main" }
        )
      ).resolves.not.toThrow();
    }
  });
});

describe("hook handlers — before_tool_call + after_tool_call", () => {
  it("registers both before_tool_call and after_tool_call hooks", () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const hookNames = (api.on as ReturnType<typeof vi.fn>).mock.calls.map(
      ([name]: [string]) => name
    );
    expect(hookNames).toContain("before_tool_call");
    expect(hookNames).toContain("after_tool_call");
  });

  it("after_tool_call with no matching pending call is a no-op", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const calls = (api.on as ReturnType<typeof vi.fn>).mock.calls;
    const afterHandler = calls.find(([n]: [string]) => n === "after_tool_call")?.[1];
    if (afterHandler) {
      await expect(
        afterHandler(
          { toolName: "Bash", params: {}, runId: "no-such-run", toolCallId: "no-such-call", result: "ok", durationMs: 10 },
          { sessionKey: "agent/test", agentId: "main" }
        )
      ).resolves.not.toThrow();
    }
  });
});

describe("hook handlers — gateway_stop", () => {
  it("gateway_stop handler resolves without throwing", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);
    const handler = vi.mocked(api.on).mock.calls.find(([n]) => n === "gateway_stop")?.[1];
    if (handler) {
      await expect(handler({}, {})).resolves.not.toThrow();
    }
  });
});
