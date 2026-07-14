// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the stale-close bug where an agent's ENTRY/AGENT spans lingered
// open (their agent_end resolved to the wrong channel and closed nothing),
// then were mis-closed by a much later agent_end -> giant 1d+ durations.
//
//   - Main fix: agent_end recovers the real context via runId when channel
//     resolution yields no closable span (channel-first, runId as supplement).
//   - Hardening: the stale-context sweeper force-closes leaked open spans using
//     a bounded last-activity end time instead of "now".

import { describe, it, expect, vi, afterEach } from "vitest";
import type { OpenClawPluginApi } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks (mirror channel-mismatch-repro.test.ts)
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
// Helpers
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
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    on: vi.fn((hookName: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
      handlers.set(hookName, handler);
    }),
    handlers,
  };
}

const getHandler = (api: ReturnType<typeof makeApi>, name: string) => api.handlers.get(name)!;
const infoMessages = (api: ReturnType<typeof makeApi>) =>
  (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.map(([m]: [string]) => m);
const warnMessages = (api: ReturnType<typeof makeApi>) =>
  (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(([m]: [string]) => m);

// ---------------------------------------------------------------------------

describe("agent_end stale-close fix", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers ENTRY/AGENT via runId when agent_end lands on a mismatched channel", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input");
    const llmOutput = getHandler(api, "llm_output");
    const agentEnd = getHandler(api, "agent_end");

    const sessionUUID = "c06c15b8-abcd-4e69-832f-fd4787bb18a5";
    const runId = sessionUUID; // openclaw: runId = opts.runId || sessionId

    // llm_input on a "system/" channel opens ENTRY + AGENT there.
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

    // Clear the pending LLM span so agent_end does not wait 5s on it.
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

    // agent_end arrives on the "agent/" channel (mismatch) but carries runId.
    await agentEnd(
      { messages: [], success: true, durationMs: 100, runId },
      { sessionKey: "agent_xukai7", agentId: "xukai7", runId, sessionId: sessionUUID },
    );

    // Let the deferred setTimeout(100) close ENTRY/AGENT.
    await new Promise((r) => setTimeout(r, 180));

    expect(infoMessages(api).filter((m) => m.includes("recovered context via runId")).length).toBe(1);
    expect(infoMessages(api).filter((m) => m.includes("Ended agent span")).length).toBe(1);
    expect(infoMessages(api).filter((m) => m.includes("Ended root span")).length).toBe(1);
  });

  it("CONTROL: matched channel closes normally without runId recovery", async () => {
    const api = makeApi();
    armsTracePlugin.activate(api);

    const llmInput = getHandler(api, "llm_input");
    const llmOutput = getHandler(api, "llm_output");
    const agentEnd = getHandler(api, "agent_end");

    const sessionId = "17bb3877-5cae-44cf-abb2-ee5b57f766b3";
    const runId = "ad2423c7-309b-476e-b755-a6895d49feb3";
    const agentSessionKey = "agent_xukai7";

    await llmInput(
      { runId, sessionId, provider: "deepseek", model: "deepseek-v4-pro", prompt: "Help", historyMessages: [], imagesCount: 0 },
      { sessionKey: agentSessionKey, agentId: "xukai7" },
    );
    await llmOutput(
      { runId, sessionId, provider: "deepseek", model: "deepseek-v4-pro", assistantTexts: ["ok"], usage: { input: 1, output: 1 } },
      { sessionKey: agentSessionKey, agentId: "xukai7" },
    );
    await agentEnd(
      { messages: [], success: true, durationMs: 100, runId },
      { sessionKey: agentSessionKey, agentId: "xukai7", runId, sessionId },
    );
    await new Promise((r) => setTimeout(r, 180));

    expect(infoMessages(api).filter((m) => m.includes("recovered context via runId")).length).toBe(0);
    expect(infoMessages(api).filter((m) => m.includes("Ended root span")).length).toBe(1);
  });

  it("HARDENING: stale sweeper force-closes leaked spans with a bounded end time", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-07-04T11:15:00.000Z").getTime();
    vi.setSystemTime(t0);

    const api = makeApi();
    armsTracePlugin.activate(api);
    const llmInput = getHandler(api, "llm_input");

    const sessionUUID = "9f1e2d3c-0000-4a5b-8c7d-000000000009";
    // Open ENTRY + AGENT + STEP, then never fire agent_end (leak).
    await llmInput(
      { runId: sessionUUID, sessionId: sessionUUID, provider: "deepseek", model: "deepseek-v4-pro", prompt: "Help", historyMessages: [], imagesCount: 0 },
      { sessionKey: sessionUUID, agentId: "xukai7" },
    );

    // Advance past CONTEXT_MAX_AGE_MS (20m); sweep interval is 10m.
    await vi.advanceTimersByTimeAsync(41 * 60 * 1000);

    const forceLogs = warnMessages(api).filter((m) => m.includes("Force-closed leaked spans"));
    expect(forceLogs.length).toBeGreaterThanOrEqual(1);

    // The bounded end time must be ~t0 (last activity), NOT the swept-at time.
    const match = /boundedEnd=(\d+)/.exec(forceLogs[0]);
    expect(match).not.toBeNull();
    const boundedEnd = Number(match![1]);
    expect(boundedEnd).toBeGreaterThanOrEqual(t0);
    expect(boundedEnd).toBeLessThan(t0 + 5 * 60 * 1000); // far below t0 + 41m
  });
});
