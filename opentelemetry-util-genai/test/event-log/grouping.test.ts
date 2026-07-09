import { describe, it, expect } from "vitest";
import {
  groupByTurn,
  groupByStep,
  pairLlm,
  pairTool,
} from "../../src/event-log/grouping.js";
import { EventName, type EventLogRecord } from "../../src/event-log/types.js";

const T = (overrides: Partial<EventLogRecord> = {}): EventLogRecord => ({
  time_unix_nano: 0,
  "event.id": "e",
  "event.name": EventName.LLM_REQUEST,
  "user.id": "u",
  ...overrides,
});

describe("groupByTurn", () => {
  it("groups records by gen_ai.turn.id", () => {
    const records = [
      T({ "gen_ai.turn.id": "t1", "gen_ai.session.id": "s1" }),
      T({ "gen_ai.turn.id": "t1", "gen_ai.session.id": "s1" }),
      T({ "gen_ai.turn.id": "t2", "gen_ai.session.id": "s1" }),
    ];
    const warnings: string[] = [];
    const turns = groupByTurn(records, warnings);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.turnId).toBe("t1");
    expect(turns[0]!.records).toHaveLength(2);
    expect(turns[1]!.turnId).toBe("t2");
  });

  it("falls back to session.id when turn.id is missing", () => {
    const records = [
      T({ "gen_ai.session.id": "s1" }),
      T({ "gen_ai.session.id": "s1" }),
    ];
    const warnings: string[] = [];
    const turns = groupByTurn(records, warnings);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnId).toBeUndefined();
    expect(turns[0]!.sessionId).toBe("s1");
  });

  it("captures first valid trace_id and warns on inconsistency", () => {
    const records = [
      T({ "gen_ai.turn.id": "t1", trace_id: "a".repeat(32) }),
      T({ "gen_ai.turn.id": "t1", trace_id: "b".repeat(32) }),
    ];
    const warnings: string[] = [];
    const turns = groupByTurn(records, warnings);
    expect(turns[0]!.traceId).toBe("a".repeat(32));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Inconsistent trace_id");
  });

  it("warns on invalid trace_id (not 32-hex, all-zero) but still picks a valid one", () => {
    const records = [
      T({ "gen_ai.turn.id": "t1", trace_id: "not-hex" }),
      T({ "gen_ai.turn.id": "t1", trace_id: "0".repeat(32) }),
      T({ "gen_ai.turn.id": "t1", trace_id: "c".repeat(32) }),
    ];
    const warnings: string[] = [];
    const turns = groupByTurn(records, warnings);
    expect(turns[0]!.traceId).toBe("c".repeat(32));
    // not-hex + all-zero both yield warnings
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("Invalid trace_id");
  });
});

describe("groupByStep", () => {
  it("groups by gen_ai.step.id preserving insertion order", () => {
    const records = [
      T({ "gen_ai.step.id": "step_1" }),
      T({ "gen_ai.step.id": "step_2" }),
      T({ "gen_ai.step.id": "step_1" }),
    ];
    const steps = groupByStep(records);
    expect(steps.map((s) => s.stepId)).toEqual(["step_1", "step_2"]);
    expect(steps[0]!.records).toHaveLength(2);
  });

  it("places records without step.id into virtual group", () => {
    const records = [T({}), T({})];
    const steps = groupByStep(records);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepId).toBeUndefined();
    expect(steps[0]!.records).toHaveLength(2);
  });
});

describe("pairLlm", () => {
  it("pairs request and response in time order", () => {
    const records = [
      T({ time_unix_nano: 1000000000, "event.name": EventName.LLM_REQUEST }),
      T({ time_unix_nano: 2000000000, "event.name": EventName.LLM_RESPONSE }),
    ];
    const warnings: string[] = [];
    const pairs = pairLlm(records, warnings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.request).toBe(records[0]);
    expect(pairs[0]!.response).toBe(records[1]);
    expect(warnings).toHaveLength(0);
  });

  it("prefers response.id match over time order when available", () => {
    const req1 = T({
      time_unix_nano: 1000000000,
      "event.name": EventName.LLM_REQUEST,
      "gen_ai.response.id": "id-B",
    });
    const resp1 = T({
      time_unix_nano: 2000000000,
      "event.name": EventName.LLM_RESPONSE,
      "gen_ai.response.id": "id-A",
    });
    const resp2 = T({
      time_unix_nano: 3000000000,
      "event.name": EventName.LLM_RESPONSE,
      "gen_ai.response.id": "id-B",
    });
    const warnings: string[] = [];
    const pairs = pairLlm([req1, resp1, resp2], warnings);
    // req1 -> resp2 (id match), resp1 becomes orphan
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.request).toBe(req1);
    expect(pairs[0]!.response).toBe(resp2);
    expect(pairs[1]!.response).toBe(resp1);
    expect(pairs[1]!.request).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("reports orphan request when no response exists", () => {
    const records = [
      T({ time_unix_nano: 1000000000, "event.name": EventName.LLM_REQUEST }),
    ];
    const warnings: string[] = [];
    const pairs = pairLlm(records, warnings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.request).toBeDefined();
    expect(pairs[0]!.response).toBeUndefined();
    expect(warnings[0]).toContain("Orphan llm.request");
  });

  it("reports orphan response when no request exists", () => {
    const records = [
      T({ time_unix_nano: 1000000000, "event.name": EventName.LLM_RESPONSE }),
    ];
    const warnings: string[] = [];
    const pairs = pairLlm(records, warnings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.response).toBeDefined();
    expect(warnings[0]).toContain("Orphan llm.response");
  });
});

describe("pairTool", () => {
  it("pairs tool.call with tool.result by tool.call.id", () => {
    const records = [
      T({
        "event.name": EventName.TOOL_CALL,
        "gen_ai.tool.call.id": "c1",
        "gen_ai.tool.name": "bash",
      }),
      T({
        "event.name": EventName.TOOL_CALL,
        "gen_ai.tool.call.id": "c2",
        "gen_ai.tool.name": "read",
      }),
      T({
        "event.name": EventName.TOOL_RESULT,
        "gen_ai.tool.call.id": "c2",
      }),
      T({
        "event.name": EventName.TOOL_RESULT,
        "gen_ai.tool.call.id": "c1",
      }),
    ];
    const warnings: string[] = [];
    const pairs = pairTool(records, warnings);
    expect(pairs).toHaveLength(2);
    const c1 = pairs.find((p) => p.call === records[0])!;
    const c2 = pairs.find((p) => p.call === records[1])!;
    expect(c1.result).toBe(records[3]);
    expect(c2.result).toBe(records[2]);
    expect(warnings).toHaveLength(0);
  });

  it("reports orphan tool.result", () => {
    const records = [
      T({
        "event.name": EventName.TOOL_RESULT,
        "gen_ai.tool.call.id": "lone",
      }),
    ];
    const warnings: string[] = [];
    const pairs = pairTool(records, warnings);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.result).toBeDefined();
    expect(pairs[0]!.call).toBeUndefined();
    expect(warnings[0]).toContain("Orphan tool.result");
  });
});
