import { describe, expect, it } from "vitest";
import { toMs, buildReactSteps } from "../../src/replay.js";
import type { Turn } from "../../src/state.js";
import type { TranscriptData } from "../../src/transcript.js";

describe("replay.toMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(toMs(1)).toBe(1000);
    expect(toMs(1.5)).toBe(1500);
  });

  it("returns Date.now() for non-finite or negative input", () => {
    expect(toMs(NaN)).toBeGreaterThan(0);
    expect(toMs(-1)).toBeGreaterThan(0);
  });

  it("treats values > 1e12 as already-millis", () => {
    const v = 1_700_000_000_000;
    expect(toMs(v)).toBe(v);
  });
});

describe("replay.buildReactSteps", () => {
  it("creates one STEP per LLM call within the turn window", () => {
    const turn: Turn = {
      startIdx: 0,
      userPromptIdx: 0,
      promptId: "p1",
      userPromptText: "do something",
      events: [],
      startedAt: 1000, // sec
      endedAt: 1002,
      closed: true,
    };
    const transcript: TranscriptData = {
      sessionId: "sid",
      model: "claude-x",
      modelProvider: "anthropic",
      totalUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 15,
      },
      tokenEvents: [
        {
          messageId: "m1",
          model: "claude-x",
          providerName: "anthropic",
          timestampMs: 1000_500,
          finishReasons: ["tool_use"],
          inputTokens: 5,
          outputTokens: 2,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          totalTokens: 7,
          inputMessages: [],
          outputMessages: [],
          toolUses: [{ id: "tu1", name: "Bash", input: {} }],
          finalized: true,
        },
        {
          messageId: "m2",
          model: "claude-x",
          providerName: "anthropic",
          timestampMs: 1001_500,
          finishReasons: ["end_turn"],
          inputTokens: 5,
          outputTokens: 3,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          totalTokens: 8,
          inputMessages: [],
          outputMessages: [],
          toolUses: [],
          finalized: true,
        },
      ],
      toolCalls: [
        {
          toolUseId: "tu1",
          toolName: "Bash",
          toolInput: {},
          toolResponse: "ok",
          isError: false,
          requestedAtMs: 1000_500,
          completedAtMs: 1000_700,
        },
      ],
    };
    const steps = buildReactSteps(turn, transcript);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.round).toBe(1);
    expect(steps[0]!.tools).toHaveLength(1);
    expect(steps[0]!.tools[0]!.toolUseId).toBe("tu1");
    expect(steps[1]!.round).toBe(2);
    expect(steps[1]!.tools).toHaveLength(0);

    // LLM duration: first LLM starts at turn start, ends at its chunk timestamp.
    // turn.startedAt = 1000s, LLM #1 timestampMs = 1_000_500.
    expect(steps[0]!.llmStartMs).toBe(1_000_000);
    expect(steps[0]!.llmEndMs).toBe(1_000_500);
    // LLM #2 starts at LLM #1's tool completion (1_000_700) — not at LLM #1's end.
    expect(steps[1]!.llmStartMs).toBe(1_000_700);
    expect(steps[1]!.llmEndMs).toBe(1_001_500);
    // STEP boundaries follow LLM start + last-of(LLM end, last tool end).
    expect(steps[0]!.startMs).toBe(1_000_000);
    expect(steps[0]!.endMs).toBe(1_000_700);
    expect(steps[1]!.startMs).toBe(1_000_700);
    expect(steps[1]!.endMs).toBe(1_001_500);
  });

  it("emits a synthetic empty STEP when no LLM calls fall in the turn window", () => {
    const turn: Turn = {
      startIdx: 0,
      userPromptIdx: 0,
      userPromptText: "",
      events: [],
      startedAt: 1,
      endedAt: 2,
      closed: true,
    };
    const transcript: TranscriptData = {
      sessionId: "",
      model: "",
      modelProvider: "unknown",
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 0,
      },
      tokenEvents: [],
      toolCalls: [],
    };
    const steps = buildReactSteps(turn, transcript);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.llm).toBeNull();
  });
});
