import { describe, it, expect, vi, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  ExtendedTelemetryHandler,
  getExtendedTelemetryHandler,
} from "../src/extended-handler.js";
import {
  createEmbeddingInvocation,
  createExecuteToolInvocation,
  createCreateAgentInvocation,
  createInvokeAgentInvocation,
  createRetrievalInvocation,
  createRerankInvocation,
  createEntryInvocation,
  createReactStepInvocation,
} from "../src/extended-types.js";
import { createMemoryInvocation } from "../src/memory/memory-types.js";
import type { GenAIError } from "../src/types.js";
import {
  GEN_AI_SKILL_DESCRIPTION,
  GEN_AI_SKILL_ID,
  GEN_AI_SKILL_NAME,
  GEN_AI_SKILL_VERSION,
} from "../src/semconv/gen-ai-extended-attributes.js";

function createMocks() {
  const endFn = vi.fn();
  const setAttributesFn = vi.fn();
  const setAttributeFn = vi.fn();
  const updateNameFn = vi.fn();
  const setStatusFn = vi.fn();
  const isRecordingFn = vi.fn().mockReturnValue(true);
  const spanContextFn = vi.fn().mockReturnValue({
    traceId: "abc",
    spanId: "def",
    traceFlags: 1,
  });

  const mockSpan = {
    end: endFn,
    setAttributes: setAttributesFn,
    setAttribute: setAttributeFn,
    updateName: updateNameFn,
    setStatus: setStatusFn,
    isRecording: isRecordingFn,
    spanContext: spanContextFn,
    recordException: vi.fn(),
    addEvent: vi.fn(),
  };

  const startSpanFn = vi.fn().mockReturnValue(mockSpan);

  return {
    mockSpan,
    endFn,
    startSpanFn,
    setAttributesFn,
    updateNameFn,
    setStatusFn,
    mockTracerProvider: {
      getTracer: vi.fn().mockReturnValue({
        startSpan: startSpanFn,
      }),
    },
    mockMeterProvider: {
      getMeter: vi.fn().mockReturnValue({
        createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
      }),
    },
  };
}

describe("ExtendedTelemetryHandler", () => {
  let mocks: ReturnType<typeof createMocks>;
  let handler: ExtendedTelemetryHandler;

  beforeEach(() => {
    mocks = createMocks();
    handler = new ExtendedTelemetryHandler({
      tracerProvider: mocks.mockTracerProvider as any,
      meterProvider: mocks.mockMeterProvider as any,
    });
  });

  const error: GenAIError = { message: "fail", type: "TestError" };

  describe("embedding", () => {
    it("start/stop creates and ends span", () => {
      const inv = createEmbeddingInvocation("text-embedding-3-small");
      handler.startEmbedding(inv);
      expect(inv.span).toBeDefined();
      handler.stopEmbedding(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("fail sets error status", () => {
      const inv = createEmbeddingInvocation("model");
      handler.startEmbedding(inv);
      handler.failEmbedding(inv, error);
      expect(mocks.setStatusFn).toHaveBeenCalledWith(
        expect.objectContaining({ code: SpanStatusCode.ERROR }),
      );
    });

    it("callback pattern works", () => {
      handler.embedding(createEmbeddingInvocation("model"), (inv) => {
        inv.inputTokens = 50;
      });
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("createAgent", () => {
    it("start/stop creates and ends span", () => {
      const inv = createCreateAgentInvocation("openai", {
        agentName: "TestAgent",
      });
      handler.startCreateAgent(inv);
      handler.stopCreateAgent(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("callback pattern works", () => {
      handler.createAgent(
        createCreateAgentInvocation("openai"),
        (inv) => {
          inv.agentName = "MyAgent";
        },
      );
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("executeTool", () => {
    it("start/stop creates and ends span", () => {
      const inv = createExecuteToolInvocation("get_weather");
      handler.startExecuteTool(inv);
      handler.stopExecuteTool(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("fail sets error status", () => {
      const inv = createExecuteToolInvocation("tool");
      handler.startExecuteTool(inv);
      handler.failExecuteTool(inv, error);
      expect(mocks.setStatusFn).toHaveBeenCalled();
    });

    it("writes explicit Skill metadata on the TOOL span", () => {
      const inv = createExecuteToolInvocation("Skill", {
        skillName: "code-review",
        skillId: "skill-29bbe8a7",
        skillVersion: "1.2.3",
        skillDescription: "Review repository changes",
      });
      handler.startExecuteTool(inv);
      handler.stopExecuteTool(inv);

      expect(mocks.setAttributesFn).toHaveBeenCalledWith(
        expect.objectContaining({
          [GEN_AI_SKILL_NAME]: "code-review",
          [GEN_AI_SKILL_ID]: "skill-29bbe8a7",
          [GEN_AI_SKILL_VERSION]: "1.2.3",
          [GEN_AI_SKILL_DESCRIPTION]: "Review repository changes",
        }),
      );
    });
  });

  describe("invokeAgent", () => {
    it("start/stop creates and ends span", () => {
      const inv = createInvokeAgentInvocation("openai", {
        agentName: "Agent",
      });
      handler.startInvokeAgent(inv);
      handler.stopInvokeAgent(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("callback with async works", async () => {
      await handler.invokeAgent(
        createInvokeAgentInvocation("openai"),
        async (inv) => {
          inv.inputTokens = 10;
          inv.outputTokens = 20;
        },
      );
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("retrieval", () => {
    it("start/stop creates and ends span", () => {
      const inv = createRetrievalInvocation({
        dataSourceId: "my_store",
      });
      handler.startRetrieval(inv);
      handler.stopRetrieval(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("rerank", () => {
    it("start/stop creates and ends span", () => {
      const inv = createRerankInvocation("cohere", {
        requestModel: "rerank-v2",
      });
      handler.startRerank(inv);
      handler.stopRerank(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("memory", () => {
    it("start/stop creates and ends span", () => {
      const inv = createMemoryInvocation("add");
      handler.startMemory(inv);
      handler.stopMemory(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("fail sets error status", () => {
      const inv = createMemoryInvocation("search");
      handler.startMemory(inv);
      handler.failMemory(inv, error);
      expect(mocks.setStatusFn).toHaveBeenCalled();
    });
  });

  describe("entry", () => {
    it("start/stop creates and ends span", () => {
      const inv = createEntryInvocation({
        sessionId: "sess-1",
        userId: "user-1",
      });
      handler.startEntry(inv);
      handler.stopEntry(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("reactStep", () => {
    it("start/stop creates and ends span", () => {
      const inv = createReactStepInvocation({ round: 1 });
      handler.startReactStep(inv);
      handler.stopReactStep(inv);
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("fail sets error status", () => {
      const inv = createReactStepInvocation({ round: 2 });
      handler.startReactStep(inv);
      handler.failReactStep(inv, error);
      expect(mocks.setStatusFn).toHaveBeenCalled();
    });
  });

  describe("error in callback re-throws", () => {
    it("embedding callback error", () => {
      expect(() =>
        handler.embedding(createEmbeddingInvocation("model"), () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });

    it("invokeAgent async callback error", async () => {
      await expect(
        handler.invokeAgent(
          createInvokeAgentInvocation("openai"),
          async () => {
            throw new Error("async boom");
          },
        ),
      ).rejects.toThrow("async boom");
      expect(mocks.endFn).toHaveBeenCalledOnce();
    });
  });

  describe("startTime/endTime passthrough", () => {
    const customStart = 1700000000000;
    const customEnd = 1700000005000;

    it("startEntry passes startTime, stopEntry passes endTime", () => {
      const inv = createEntryInvocation({ sessionId: "s1" });
      handler.startEntry(inv, undefined, customStart);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
      handler.stopEntry(inv, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("startInvokeAgent passes startTime, stopInvokeAgent passes endTime", () => {
      const inv = createInvokeAgentInvocation("openai", { agentName: "A" });
      handler.startInvokeAgent(inv, undefined, customStart);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
      handler.stopInvokeAgent(inv, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("startReactStep passes startTime, stopReactStep passes endTime", () => {
      const inv = createReactStepInvocation({ round: 1 });
      handler.startReactStep(inv, undefined, customStart);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
      handler.stopReactStep(inv, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("startExecuteTool passes startTime, stopExecuteTool passes endTime", () => {
      const inv = createExecuteToolInvocation("calc");
      handler.startExecuteTool(inv, undefined, customStart);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
      handler.stopExecuteTool(inv, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("startEmbedding passes startTime, stopEmbedding passes endTime", () => {
      const inv = createEmbeddingInvocation("text-embedding-3-small");
      handler.startEmbedding(inv, undefined, customStart);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
      handler.stopEmbedding(inv, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("startMemory passes startTime, stopMemory passes endTime", () => {
      const inv = createMemoryInvocation("add");
      handler.startMemory(inv, undefined, customStart);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: customStart }),
        undefined,
      );
      handler.stopMemory(inv, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("failEntry passes custom endTime", () => {
      const inv = createEntryInvocation({ sessionId: "s1" });
      handler.startEntry(inv, undefined, customStart);
      handler.failEntry(inv, { message: "err", type: "E" }, customEnd);
      expect(mocks.endFn).toHaveBeenCalledWith(customEnd);
    });

    it("omitted timestamps default to undefined (no forced value)", () => {
      const inv = createReactStepInvocation({ round: 1 });
      handler.startReactStep(inv);
      expect(mocks.startSpanFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ startTime: undefined }),
        undefined,
      );
      handler.stopReactStep(inv);
      expect(mocks.endFn).toHaveBeenCalledWith(undefined);
    });
  });

  describe("not started returns early", () => {
    it("stopEmbedding on un-started invocation", () => {
      const inv = createEmbeddingInvocation("model");
      handler.stopEmbedding(inv);
      expect(mocks.endFn).not.toHaveBeenCalled();
    });

    it("failCreateAgent on un-started invocation", () => {
      const inv = createCreateAgentInvocation("provider");
      handler.failCreateAgent(inv, error);
      expect(mocks.endFn).not.toHaveBeenCalled();
    });
  });
});

describe("getExtendedTelemetryHandler", () => {
  it("returns an ExtendedTelemetryHandler", () => {
    const handler = getExtendedTelemetryHandler();
    expect(handler).toBeInstanceOf(ExtendedTelemetryHandler);
  });
});
