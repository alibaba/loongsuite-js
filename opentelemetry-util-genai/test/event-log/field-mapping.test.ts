import { describe, it, expect } from "vitest";
import {
  readNanoMs,
  buildEntryInvocation,
  buildInvokeAgentInvocation,
  buildReactStepInvocation,
  buildLlmInvocation,
  buildExecuteToolInvocation,
  buildAccumulatedInputMessages,
  readTurnSystemInstruction,
  readTurnToolDefinitions,
} from "../../src/event-log/field-mapping.js";
import { EventName, type EventLogRecord } from "../../src/event-log/types.js";

describe("readNanoMs", () => {
  it("converts number nanos to ms", () => {
    expect(readNanoMs(1_500_000_000)).toBe(1500);
  });

  it("converts string nanos to ms", () => {
    expect(readNanoMs("1779667200500000000")).toBe(1779667200500);
  });

  it("converts bigint nanos to ms", () => {
    expect(readNanoMs(1_500_000_000n)).toBe(1500);
  });

  it("returns 0 for negative, NaN, and unparseable inputs", () => {
    expect(readNanoMs(-1)).toBe(0);
    expect(readNanoMs(NaN)).toBe(0);
    expect(readNanoMs("not a number")).toBe(0);
    expect(readNanoMs(undefined)).toBe(0);
    expect(readNanoMs(null)).toBe(0);
  });
});

describe("buildEntryInvocation", () => {
  it("pulls session.id, user.id, and first/last messages", () => {
    const records: EventLogRecord[] = [
      {
        "event.name": EventName.LLM_REQUEST,
        "gen_ai.session.id": "s1",
        "user.id": "u1",
        "gen_ai.input.messages_delta": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "hi" }] },
        ]),
      },
      {
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.session.id": "s1",
        "user.id": "u1",
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [{ type: "text", content: "hello" }],
            finish_reason: "stop",
          },
        ]),
      },
    ];
    const inv = buildEntryInvocation(records);
    expect(inv.sessionId).toBe("s1");
    expect(inv.userId).toBe("u1");
    expect(inv.inputMessages).toHaveLength(1);
    expect(inv.inputMessages![0]!.role).toBe("user");
    expect(inv.outputMessages).toHaveLength(1);
    expect(inv.outputMessages![0]!.finishReason).toBe("stop");
  });
});

describe("buildInvokeAgentInvocation", () => {
  it("aggregates tokens across multiple llm.response events in turn", () => {
    const records: EventLogRecord[] = [
      {
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.usage.cache_read.input_tokens": 80,
        "gen_ai.usage.cache_creation.input_tokens": 10,
      },
      {
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.usage.input_tokens": 50,
        "gen_ai.usage.output_tokens": 15,
        "gen_ai.usage.cache_read.input_tokens": 40,
      },
    ];
    const inv = buildInvokeAgentInvocation(records);
    expect(inv.provider).toBe("anthropic");
    expect(inv.requestModel).toBe("claude");
    expect(inv.inputTokens).toBe(150);
    expect(inv.outputTokens).toBe(35);
    expect(inv.usageCacheReadInputTokens).toBe(120);
    expect(inv.usageCacheCreationInputTokens).toBe(10);
  });

  it("falls back to provider=unknown when missing", () => {
    const inv = buildInvokeAgentInvocation([{}]);
    expect(inv.provider).toBe("unknown");
  });
});

describe("buildReactStepInvocation", () => {
  it("derives round from gen_ai.react.round if present", () => {
    const inv = buildReactStepInvocation([
      { "gen_ai.react.round": 7, "gen_ai.step.id": "step_7" },
    ]);
    expect(inv.round).toBe(7);
  });

  it("derives round from step.id suffix when explicit round missing", () => {
    expect(
      buildReactStepInvocation([{ "gen_ai.step.id": "step_3" }]).round,
    ).toBe(3);
    expect(
      buildReactStepInvocation([{ "gen_ai.step.id": "sess:t1:s12" }]).round,
    ).toBe(12);
  });

  it("falls back to last llm.response finish_reason for finishReason", () => {
    const inv = buildReactStepInvocation([
      {
        "event.name": EventName.LLM_RESPONSE,
        "gen_ai.step.id": "step_1",
        "gen_ai.response.finish_reasons": ["tool_calls"],
      },
    ]);
    expect(inv.finishReason).toBe("tool_calls");
  });
});

describe("buildLlmInvocation", () => {
  it("populates request and response fields with cache tokens", () => {
    const req: EventLogRecord = {
      "event.name": EventName.LLM_REQUEST,
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude",
    };
    const resp: EventLogRecord = {
      "event.name": EventName.LLM_RESPONSE,
      "gen_ai.response.model": "claude-2026",
      "gen_ai.response.id": "msg-1",
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.usage.cache_read.input_tokens": 80,
      "gen_ai.usage.cache_creation.input_tokens": 5,
    };
    const inv = buildLlmInvocation({ request: req, response: resp }, undefined, undefined, undefined);
    expect(inv.provider).toBe("anthropic");
    expect(inv.requestModel).toBe("claude");
    expect(inv.responseModelName).toBe("claude-2026");
    expect(inv.responseId).toBe("msg-1");
    expect(inv.finishReasons).toEqual(["stop"]);
    expect(inv.inputTokens).toBe(100);
    expect(inv.outputTokens).toBe(20);
    expect(inv.usageCacheReadInputTokens).toBe(80);
    expect(inv.usageCacheCreationInputTokens).toBe(5);
  });

  it("uses orphan response side when request is missing", () => {
    const resp: EventLogRecord = {
      "event.name": EventName.LLM_RESPONSE,
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5",
      "gen_ai.usage.input_tokens": 10,
    };
    const inv = buildLlmInvocation({ response: resp }, undefined, undefined, undefined);
    expect(inv.provider).toBe("openai");
    expect(inv.requestModel).toBe("gpt-5");
    expect(inv.inputTokens).toBe(10);
  });
});

describe("buildAccumulatedInputMessages", () => {
  it("uses full gen_ai.input.messages when present", () => {
    const pairs = [
      {
        request: {
          "gen_ai.input.messages": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "full" }] },
          ]),
          "gen_ai.input.messages_delta": JSON.stringify([
            { role: "ignored", parts: [] },
          ]),
        } as EventLogRecord,
      },
    ];
    const msgs = buildAccumulatedInputMessages(pairs, 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
  });

  it("accumulates messages_delta across multiple prior requests", () => {
    const pairs = [
      {
        request: {
          "gen_ai.input.messages_delta": JSON.stringify([
            { role: "user", parts: [{ type: "text", content: "q1" }] },
          ]),
        } as EventLogRecord,
      },
      {
        request: {
          "gen_ai.input.messages_delta": JSON.stringify([
            { role: "assistant", parts: [{ type: "text", content: "a1" }] },
            { role: "user", parts: [{ type: "text", content: "q2" }] },
          ]),
        } as EventLogRecord,
      },
    ];
    const msgs = buildAccumulatedInputMessages(pairs, 1);
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("buildExecuteToolInvocation", () => {
  it("populates name, id, arguments, result, type default", () => {
    const call: EventLogRecord = {
      "event.name": EventName.TOOL_CALL,
      "gen_ai.tool.name": "bash",
      "gen_ai.tool.call.id": "c1",
      "gen_ai.tool.call.arguments": { cmd: "ls" },
    };
    const result: EventLogRecord = {
      "event.name": EventName.TOOL_RESULT,
      "gen_ai.tool.call.id": "c1",
      "gen_ai.tool.call.result": { stdout: "ok" },
    };
    const inv = buildExecuteToolInvocation({ call, result });
    expect(inv.toolName).toBe("bash");
    expect(inv.toolCallId).toBe("c1");
    expect(inv.toolType).toBe("function");
    expect(inv.toolCallArguments).toEqual({ cmd: "ls" });
    expect(inv.toolCallResult).toEqual({ stdout: "ok" });
  });

  it("defaults toolName to unknown when missing", () => {
    const inv = buildExecuteToolInvocation({});
    expect(inv.toolName).toBe("unknown");
  });
});

describe("readTurnSystemInstruction / readTurnToolDefinitions", () => {
  it("returns undefined when not present (optimistic read)", () => {
    expect(readTurnSystemInstruction([{}, {}])).toBeUndefined();
    expect(readTurnToolDefinitions([{}, {}])).toBeUndefined();
  });

  it("parses array JSON systemInstructions", () => {
    const parts = readTurnSystemInstruction([
      {
        "gen_ai.system_instructions": JSON.stringify([
          { type: "text", content: "You are helpful" },
        ]),
      },
    ]);
    expect(parts).toHaveLength(1);
    expect((parts![0] as { type: string }).type).toBe("text");
  });

  it("wraps plain string systemInstructions in a Text part", () => {
    const parts = readTurnSystemInstruction([
      { "gen_ai.system_instructions": JSON.stringify("You are helpful") },
    ]);
    expect(parts).toHaveLength(1);
    expect((parts![0] as { type: string; content: string }).content).toBe(
      "You are helpful",
    );
  });

  it("parses toolDefinitions array", () => {
    const tools = readTurnToolDefinitions([
      {
        "gen_ai.tool.definitions": JSON.stringify([
          { type: "function", name: "ls", description: "list" },
          { type: "function", name: "cat", description: "read" },
        ]),
      },
    ]);
    expect(tools).toHaveLength(2);
    expect(tools![0]!.name).toBe("ls");
  });
});
