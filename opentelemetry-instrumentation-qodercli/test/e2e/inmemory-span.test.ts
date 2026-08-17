import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";

import { replayTurn, toMs } from "../../src/replay.js";
import type { Turn } from "../../src/state.js";
import type { TranscriptData } from "../../src/transcript.js";

// Constitution C3 needs these env vars before util-genai loads.
process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] = "gen_ai_latest_experimental";
process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "SPAN_ONLY";

function buildSyntheticData(turnStartSec: number, sessionId: string): {
  turn: Turn;
  transcript: TranscriptData;
} {
  const baseMs = toMs(turnStartSec);
  const turn: Turn = {
    startIdx: 0,
    userPromptIdx: 0,
    promptId: "p-1",
    userPromptText: "list files in /tmp",
    events: [],
    startedAt: turnStartSec,
    endedAt: turnStartSec + 1.0,
    closed: true,
  };
  const transcript: TranscriptData = {
    sessionId,
    model: "claude-test",
    modelProvider: "anthropic",
    totalUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 25,
      totalTokens: 150,
    },
    tokenEvents: [
      {
        messageId: "msg-A",
        model: "claude-test",
        providerName: "anthropic",
        timestampMs: baseMs + 100,
        finishReasons: ["tool_use"],
        inputTokens: 60,
        outputTokens: 20,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 10,
        totalTokens: 80,
        inputMessages: [
          { role: "user", parts: [{ type: "text", content: "list files" }] },
        ],
        outputMessages: [
          {
            role: "assistant",
            parts: [
              {
                type: "tool_call",
                id: "tu-1",
                name: "Bash",
                arguments: { command: "ls /tmp" },
              },
            ],
            finishReason: "tool_use",
          },
        ],
        toolUses: [{ id: "tu-1", name: "Bash", input: { command: "ls /tmp" } }],
        finalized: true,
      },
      {
        messageId: "msg-B",
        model: "claude-test",
        providerName: "anthropic",
        timestampMs: baseMs + 500,
        finishReasons: ["end_turn"],
        inputTokens: 40,
        outputTokens: 30,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 15,
        totalTokens: 70,
        inputMessages: [],
        outputMessages: [
          {
            role: "assistant",
            parts: [{ type: "text", content: "files: a.txt, b.txt" }],
            finishReason: "end_turn",
          },
        ],
        toolUses: [],
        finalized: true,
      },
    ],
    toolCalls: [
      {
        toolUseId: "tu-1",
        toolName: "Bash",
        toolInput: { command: "ls /tmp" },
        toolResponse: "a.txt\nb.txt",
        isError: false,
        requestedAtMs: baseMs + 100,
        completedAtMs: baseMs + 300,
      },
    ],
    systemInstruction: [{ type: "text", content: "You are qodercli." }],
    toolDefinitions: [
      { type: "function", name: "Bash", description: null, parameters: null },
    ],
    finalAssistantMessage: {
      role: "assistant",
      parts: [{ type: "text", content: "files: a.txt, b.txt" }],
      finishReason: "end_turn",
    },
  };
  return { turn, transcript };
}

describe("E2E InMemorySpanExporter", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider;

  beforeAll(() => {
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "qodercli-agent",
        "gen_ai.agent.system": "qodercli",
        "acs.arms.service.feature": "genai_app",
      }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it("emits an ENTRY → AGENT → STEP/LLM/TOOL tree with required attributes", async () => {
    const tracer = trace.getTracer("e2e-test");
    const turnStartSec = Date.now() / 1000;
    const { turn, transcript } = buildSyntheticData(turnStartSec, "sess-1");

    replayTurn({
      turn,
      transcript,
      tracer,
      sessionId: "sess-1",
      turnIndex: 0,
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    // Find each kind via attribute.
    const byKind = (k: string) =>
      spans.filter((s) => s.attributes["gen_ai.span.kind"] === k);

    const entry = byKind("ENTRY");
    const agent = byKind("AGENT");
    const step = byKind("STEP");
    const llm = byKind("LLM");
    const tool = byKind("TOOL");

    expect(entry).toHaveLength(1);
    expect(agent).toHaveLength(1);
    expect(step.length).toBeGreaterThanOrEqual(2);
    expect(llm).toHaveLength(2);
    expect(tool).toHaveLength(1);

    // 1. ENTRY has session.id
    expect(entry[0]!.attributes["gen_ai.session.id"]).toBe("sess-1");

    // 2. AGENT has agent.name + aggregated usage
    expect(agent[0]!.attributes["gen_ai.agent.name"]).toBe("qodercli");
    expect(agent[0]!.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(agent[0]!.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(agent[0]!.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(
      25,
    );

    // 3. LLM has request.model + token usage + provider
    const firstLlm = llm[0]!;
    expect(firstLlm.attributes["gen_ai.request.model"]).toBe("claude-test");
    expect(firstLlm.attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(firstLlm.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);

    // 4. TOOL has tool.name + tool.call.id + arguments + result
    expect(tool[0]!.attributes["gen_ai.tool.name"]).toBe("Bash");
    expect(tool[0]!.attributes["gen_ai.tool.call.id"]).toBe("tu-1");
    expect(
      String(tool[0]!.attributes["gen_ai.tool.call.arguments"]),
    ).toContain("ls /tmp");
    expect(String(tool[0]!.attributes["gen_ai.tool.call.result"])).toContain(
      "a.txt",
    );

    // 5. Time check (Constitution C2): startTime[0] (epoch sec) within 60s of now
    const now = Math.round(Date.now() / 1000);
    const entryStartSec = entry[0]!.startTime[0];
    expect(Math.abs(now - entryStartSec)).toBeLessThan(60);

    // 6. Resource has C4-mandated attributes (via tracer provider register)
    const entryResource = entry[0]!.resource.attributes;
    expect(entryResource["service.name"]).toBe("qodercli-agent");
    expect(entryResource["gen_ai.agent.system"]).toBe("qodercli");
    expect(entryResource["acs.arms.service.feature"]).toBe("genai_app");

    // 7. messages captured (Constitution C3)
    expect(entry[0]!.attributes["gen_ai.input.messages"]).toBeDefined();
    expect(agent[0]!.attributes["gen_ai.system_instructions"]).toBeDefined();
    expect(agent[0]!.attributes["gen_ai.tool.definitions"]).toBeDefined();
  });

  it("two turns produce two distinct trace IDs but share session.id", async () => {
    exporter.reset();
    const tracer = trace.getTracer("e2e-test");
    const turnStartSec = Date.now() / 1000;
    const sessionId = "sess-multi";
    const t1 = buildSyntheticData(turnStartSec, sessionId);
    const t2 = buildSyntheticData(turnStartSec + 2, sessionId);

    replayTurn({
      turn: t1.turn,
      transcript: t1.transcript,
      tracer,
      sessionId,
      turnIndex: 0,
    });
    replayTurn({
      turn: t2.turn,
      transcript: t2.transcript,
      tracer,
      sessionId,
      turnIndex: 1,
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const entries = spans.filter(
      (s) => s.attributes["gen_ai.span.kind"] === "ENTRY",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.spanContext().traceId).not.toBe(
      entries[1]!.spanContext().traceId,
    );
    expect(entries[0]!.attributes["gen_ai.session.id"]).toBe(sessionId);
    expect(entries[1]!.attributes["gen_ai.session.id"]).toBe(sessionId);
  });
});
