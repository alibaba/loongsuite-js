import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertEventLogToTrace } from "../../src/event-log/converter.js";
import { EventLogConversionError } from "../../src/event-log/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown[] {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf-8"),
  );
}

interface SpanCalls {
  startEntry: ReturnType<typeof vi.fn>;
  stopEntry: ReturnType<typeof vi.fn>;
  startInvokeAgent: ReturnType<typeof vi.fn>;
  stopInvokeAgent: ReturnType<typeof vi.fn>;
  startReactStep: ReturnType<typeof vi.fn>;
  stopReactStep: ReturnType<typeof vi.fn>;
  startLlm: ReturnType<typeof vi.fn>;
  stopLlm: ReturnType<typeof vi.fn>;
  startExecuteTool: ReturnType<typeof vi.fn>;
  stopExecuteTool: ReturnType<typeof vi.fn>;
}

function createMockHandler(): { handler: any; calls: SpanCalls } {
  let nextSpanId = 0;
  const makeSpan = () => ({
    spanContext: () => ({ traceId: "x".repeat(32), spanId: String(nextSpanId++).padStart(16, "0") }),
    end: vi.fn(),
  });

  const calls: SpanCalls = {
    startEntry: vi.fn((inv) => {
      inv.span = makeSpan();
      inv.contextToken = { __ctx: "entry" };
      return inv;
    }),
    stopEntry: vi.fn(),
    startInvokeAgent: vi.fn((inv) => {
      inv.span = makeSpan();
      inv.contextToken = { __ctx: "agent" };
      return inv;
    }),
    stopInvokeAgent: vi.fn(),
    startReactStep: vi.fn((inv) => {
      inv.span = makeSpan();
      inv.contextToken = { __ctx: "step" };
      return inv;
    }),
    stopReactStep: vi.fn(),
    startLlm: vi.fn((inv) => {
      inv.span = makeSpan();
      return inv;
    }),
    stopLlm: vi.fn(),
    startExecuteTool: vi.fn((inv) => {
      inv.span = makeSpan();
      return inv;
    }),
    stopExecuteTool: vi.fn(),
  };
  return { handler: calls as any, calls };
}

describe("convertEventLogToTrace — empty input", () => {
  it("returns empty result without throwing", () => {
    const { handler } = createMockHandler();
    const result = convertEventLogToTrace([], { handler });
    expect(result.traceIds).toEqual([]);
    expect(result.spanCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

describe("convertEventLogToTrace — single turn", () => {
  let calls: SpanCalls;
  let handler: any;

  beforeEach(() => {
    const m = createMockHandler();
    calls = m.calls;
    handler = m.handler;
  });

  it("invokes startEntry → startInvokeAgent → startReactStep → startLlm + startExecuteTool in order", () => {
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });

    expect(calls.startEntry).toHaveBeenCalledTimes(1);
    expect(calls.startInvokeAgent).toHaveBeenCalledTimes(1);
    expect(calls.startReactStep).toHaveBeenCalledTimes(1);
    expect(calls.startLlm).toHaveBeenCalledTimes(1);
    expect(calls.startExecuteTool).toHaveBeenCalledTimes(1);

    // stop calls happen too
    expect(calls.stopLlm).toHaveBeenCalledTimes(1);
    expect(calls.stopExecuteTool).toHaveBeenCalledTimes(1);
    expect(calls.stopReactStep).toHaveBeenCalledTimes(1);
    expect(calls.stopInvokeAgent).toHaveBeenCalledTimes(1);
    expect(calls.stopEntry).toHaveBeenCalledTimes(1);
  });

  it("returns correct span count and trace_id", () => {
    const records = loadFixture("single-turn-simple");
    const result = convertEventLogToTrace(records, { handler });
    // ENTRY + AGENT + STEP + LLM + TOOL = 5 spans
    expect(result.spanCount).toBe(5);
    expect(result.traceIds).toEqual(["4bf92f3577b34da6a3ce929d0e0e4736"]);
  });

  it("converts time_unix_nano to ms when calling handler", () => {
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });
    // first nano: 1779667200000000000 → 1779667200000 ms
    expect(calls.startEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1779667200000,
    );
    // tool end nano: 1779667201000000000 → 1779667201000 ms
    expect(calls.stopExecuteTool).toHaveBeenCalledWith(
      expect.anything(),
      1779667201000,
    );
  });

  it("passes parentContext chain entry → agent → step → leaves", () => {
    const records = loadFixture("single-turn-simple");
    convertEventLogToTrace(records, { handler });
    // startInvokeAgent should receive the entry ctx
    const agentParentCtx = calls.startInvokeAgent.mock.calls[0]![1];
    expect(agentParentCtx).toEqual({ __ctx: "entry" });
    // startReactStep should receive the agent ctx
    const stepParentCtx = calls.startReactStep.mock.calls[0]![1];
    expect(stepParentCtx).toEqual({ __ctx: "agent" });
    // startLlm / startExecuteTool should receive the step ctx
    expect(calls.startLlm.mock.calls[0]![1]).toEqual({ __ctx: "step" });
    expect(calls.startExecuteTool.mock.calls[0]![1]).toEqual({ __ctx: "step" });
  });
});

describe("convertEventLogToTrace — multi turn", () => {
  it("creates separate trace per turn", () => {
    const { handler, calls } = createMockHandler();
    const records = loadFixture("multi-turn-react");
    const result = convertEventLogToTrace(records, { handler });
    expect(result.traceIds).toHaveLength(2);
    expect(result.traceIds).toContain("11111111111111111111111111111111");
    expect(result.traceIds).toContain("22222222222222222222222222222222");
    expect(calls.startEntry).toHaveBeenCalledTimes(2);
    // turn A: 2 steps; turn B: 1 step → 3 STEPs total
    expect(calls.startReactStep).toHaveBeenCalledTimes(3);
    // LLM calls: 2 in turn A + 1 in turn B = 3
    expect(calls.startLlm).toHaveBeenCalledTimes(3);
    // tools: 1 in turn A step 1
    expect(calls.startExecuteTool).toHaveBeenCalledTimes(1);
  });
});

describe("convertEventLogToTrace — strict mode", () => {
  it("throws EventLogConversionError when orphans exist", () => {
    const { handler } = createMockHandler();
    const records = loadFixture("orphan-llm-request");
    expect(() => convertEventLogToTrace(records, { handler, strict: true })).toThrow(
      EventLogConversionError,
    );
  });

  it("non-strict mode collects orphan warnings but completes", () => {
    const { handler } = createMockHandler();
    const records = loadFixture("orphan-llm-request");
    const result = convertEventLogToTrace(records, { handler, strict: false });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("Orphan"))).toBe(true);
    // The orphan llm.request still produces a degenerate LLM span; orphan
    // tool.result still produces a TOOL span.
    expect(result.spanCount).toBeGreaterThan(0);
  });
});

describe("convertEventLogToTrace — invalid trace_id fallback", () => {
  it("warns and falls back to SDK-allocated id when trace_id invalid", () => {
    const { handler } = createMockHandler();
    const records = [
      {
        time_unix_nano: 1779667200000000000,
        "event.id": "x",
        "event.name": "llm.request",
        "user.id": "u",
        trace_id: "not-a-valid-hex",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t",
        "gen_ai.step.id": "step_1",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5",
      },
      {
        time_unix_nano: 1779667200100000000,
        "event.id": "y",
        "event.name": "llm.response",
        "user.id": "u",
        trace_id: "not-a-valid-hex",
        "gen_ai.session.id": "s",
        "gen_ai.turn.id": "t",
        "gen_ai.step.id": "step_1",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.output_tokens": 1,
      },
    ];
    const result = convertEventLogToTrace(records, { handler });
    // trace_id is invalid so it shouldn't appear in traceIds (SDK would allocate one,
    // but our mock returns 'x'.repeat(32) which is captured as fallback)
    expect(result.warnings.some((w) => w.includes("Invalid trace_id"))).toBe(true);
  });
});

describe("convertEventLogToTrace — default handler", () => {
  it("falls back to getExtendedTelemetryHandler when handler option not provided", () => {
    // Smoke test only: should not throw when running without explicit handler.
    // The default singleton uses noop tracer so no spans are exported.
    const records = loadFixture("single-turn-simple");
    expect(() => convertEventLogToTrace(records)).not.toThrow();
  });
});

describe("convertEventLogToTrace — AGENT token aggregation", () => {
  it("sums tokens from all llm.response in turn", () => {
    const { handler, calls } = createMockHandler();
    const records = loadFixture("multi-turn-react");
    convertEventLogToTrace(records, { handler });
    // Turn A AGENT invocation should have aggregated tokens from steps 1+2:
    // input: 200 + 230 = 430; output: 30 + 40 = 70
    const turnAAgent = calls.startInvokeAgent.mock.calls[0]![0];
    expect(turnAAgent.inputTokens).toBe(430);
    expect(turnAAgent.outputTokens).toBe(70);
    // Turn B AGENT: input 50, output 10
    const turnBAgent = calls.startInvokeAgent.mock.calls[1]![0];
    expect(turnBAgent.inputTokens).toBe(50);
    expect(turnBAgent.outputTokens).toBe(10);
  });
});

describe("convertEventLogToTrace — cache tokens flow into LLM invocation", () => {
  it("propagates cache_read and cache_creation tokens", () => {
    const { handler, calls } = createMockHandler();
    const records = loadFixture("with-cache-tokens");
    convertEventLogToTrace(records, { handler });
    const llmInv = calls.startLlm.mock.calls[0]![0];
    expect(llmInv.usageCacheReadInputTokens).toBe(10500);
    expect(llmInv.usageCacheCreationInputTokens).toBe(1200);
    expect(llmInv.inputTokens).toBe(12000);
    expect(llmInv.outputTokens).toBe(250);
  });
});

describe("convertEventLogToTrace — messages-delta accumulation", () => {
  it("accumulates delta across consecutive LLM steps within turn", () => {
    const { handler, calls } = createMockHandler();
    const records = loadFixture("messages-delta-only");
    convertEventLogToTrace(records, { handler });
    // Second LLM call's inputMessages should be cumulative
    const llm1 = calls.startLlm.mock.calls[0]![0];
    const llm2 = calls.startLlm.mock.calls[1]![0];
    expect(llm1.inputMessages).toHaveLength(1);
    expect(llm1.inputMessages![0].role).toBe("user");
    // llm2: delta from llm1 (1 msg) + delta from llm2 (2 msgs) = 3
    expect(llm2.inputMessages).toHaveLength(3);
    expect(llm2.inputMessages![0].role).toBe("user");
    expect(llm2.inputMessages![1].role).toBe("assistant");
    expect(llm2.inputMessages![2].role).toBe("tool");
  });
});
