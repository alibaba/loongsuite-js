import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { ExtendedTelemetryHandler } from "../../src/extended-handler.js";
import { convertEventLogToReadableSpans } from "../../src/event-log/readable-spans.js";
import { createTurnStreamSession } from "../../src/event-log/turn-stream.js";
import { resolveSkill } from "../../src/event-log/skill.js";
import type { EventLogRecord } from "../../src/event-log/types.js";
import {
  GEN_AI_SKILL_DESCRIPTION,
  GEN_AI_SKILL_ID,
  GEN_AI_SKILL_NAME,
  GEN_AI_SKILL_VERSION,
  GEN_AI_SPAN_KIND,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

function call(
  toolName: string,
  args: unknown,
  extra: EventLogRecord = {},
): EventLogRecord {
  return {
    "event.name": "tool.call",
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.call.arguments": args,
    ...extra,
  };
}

function result(value: unknown, extra: EventLogRecord = {}): EventLogRecord {
  return {
    "event.name": "tool.result",
    "gen_ai.tool.call.result": value,
    ...extra,
  };
}

function toolTurn(
  toolName: string,
  args: unknown,
  callExtra: EventLogRecord = {},
  resultExtra: EventLogRecord = {},
): EventLogRecord[] {
  const base = {
    trace_id: "1234567890abcdef1234567890abcdef",
    "gen_ai.session.id": "session-1",
    "gen_ai.turn.id": "turn-1",
    "gen_ai.step.id": "step-1",
    "gen_ai.agent.type": "codex",
    "user.id": "user-1",
  };
  return [
    {
      ...base,
      "event.id": "tool-call",
      "event.name": "tool.call",
      time_unix_nano: "1780000001000000000",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.call.id": "call-1",
      "gen_ai.tool.call.arguments": args,
      ...callExtra,
    },
    {
      ...base,
      "event.id": "tool-result",
      "event.name": "tool.result",
      time_unix_nano: "1780000002000000000",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.call.id": "call-1",
      "gen_ai.tool.call.result": { stdout: "ok" },
      ...resultExtra,
    },
  ];
}

function toolSpan(spans: ReadableSpan[]): ReadableSpan {
  return spans.find(
    (span) => span.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.TOOL,
  )!;
}

describe("resolveSkill", () => {
  it("merges field-by-field with explicit result > explicit call > custom > built-in", () => {
    const resolved = resolveSkill(
      call(
        "Skill",
        {
          skill: "from-args",
          id: "args-id",
          version: "args-version",
        },
        {
          [GEN_AI_SKILL_NAME]: "explicit-call-name",
          [GEN_AI_SKILL_DESCRIPTION]: "explicit call description",
        },
      ),
      result(
        {
          success: true,
          name: "from-result",
          id: "result-id",
          version: "result-version",
          description: "result description",
        },
        {
          [GEN_AI_SKILL_VERSION]: "explicit-result-version",
        },
      ),
      {
        detect: () => ({
          name: "custom-name",
          id: "custom-id",
          version: "custom-version",
          description: "custom description",
        }),
      },
    );

    expect(resolved).toEqual({
      name: "explicit-call-name",
      id: "custom-id",
      version: "explicit-result-version",
      description: "explicit call description",
    });
  });

  it("detects Claude Code Skill arguments and falls id back to name", () => {
    expect(
      resolveSkill(
        call("Skill", JSON.stringify({ skill: "arms-genai-verify", args: "check" })),
      ),
    ).toEqual({
      name: "arms-genai-verify",
      id: "arms-genai-verify",
    });
  });

  it("extracts Hermes-style metadata from a successful first-class result", () => {
    expect(
      resolveSkill(
        call("skill_view", { name: "loongsuite-pr-review" }),
        result({
          success: true,
          name: "loongsuite-pr-review",
          description: "Review PR readiness",
          metadata: {
            id: "skill-pr-review",
            version: "1.2.3",
          },
        }),
      ),
    ).toEqual({
      name: "loongsuite-pr-review",
      id: "skill-pr-review",
      version: "1.2.3",
      description: "Review PR readiness",
    });
  });

  it.each([
    ["/Users/u/.codex/skills/hatch-pet/SKILL.md", "hatch-pet"],
    ["/Users/u/.cursor/skills/bmi-calculator/scripts/x.py", "bmi-calculator"],
    ["/Users/u/.cursor/skills-cursor/create-hook/SKILL.md", "create-hook"],
    ["/Users/u/.codex/skills/.system/imagegen/SKILL.md", "imagegen"],
    ["C:\\Users\\u\\.codex\\skills\\windows-skill\\scripts\\run.ps1", "windows-skill"],
  ])("detects Skill paths in arguments: %s", (path, expected) => {
    expect(resolveSkill(call("exec", { command: `node ${path}` }))).toEqual({
      name: expected,
      id: expected,
    });
  });

  it("does not match noisy directory names or paths found only in tool output", () => {
    expect(
      resolveSkill(
        call("exec", {
          command: "node /tmp/hatch-pet-users-fangxiu-codex-skills-3/run.js",
        }),
        result({
          stdout: "README mentions /Users/u/.codex/skills/hatch-pet/SKILL.md",
        }),
      ),
    ).toBeUndefined();
  });

  it("disabling detection preserves explicit fields but disables inference", () => {
    expect(
      resolveSkill(
        call("Skill", { skill: "detected" }, {
          [GEN_AI_SKILL_NAME]: "explicit",
        }),
        undefined,
        false,
      ),
    ).toEqual({ name: "explicit", id: "explicit" });
    expect(resolveSkill(call("Skill", { skill: "detected" }), undefined, false))
      .toBeUndefined();
  });

  it("supports replacement tool names, pathHeuristic=false and custom detection", () => {
    expect(
      resolveSkill(call("InvokeSkill", { name: "internal" }), undefined, {
        toolNames: ["InvokeSkill"],
        pathHeuristic: false,
      }),
    ).toEqual({ name: "internal", id: "internal" });

    expect(
      resolveSkill(
        call("exec", { command: "cat /x/skills/path-only/SKILL.md" }),
        undefined,
        { pathHeuristic: false },
      ),
    ).toBeUndefined();

    expect(
      resolveSkill(call("ordinary", {}), undefined, {
        detect: () => ({ name: "custom", id: "custom-id" }),
      }),
    ).toEqual({ name: "custom", id: "custom-id" });
  });

  it("propagates custom detector exceptions", () => {
    expect(() =>
      resolveSkill(call("ordinary", {}), undefined, {
        detect: () => {
          throw new Error("bad detector");
        },
      }),
    ).toThrow("bad detector");
  });
});

describe("Skill attributes in converted TOOL spans", () => {
  it("adds detected attributes only to the matching TOOL span", async () => {
    const { spans } = await convertEventLogToReadableSpans(
      toolTurn("exec", {
        command: "node /Users/u/.codex/skills/hatch-pet/scripts/build.js",
      }),
    );
    const tool = toolSpan(spans);
    expect(tool.attributes[GEN_AI_SKILL_NAME]).toBe("hatch-pet");
    expect(tool.attributes[GEN_AI_SKILL_ID]).toBe("hatch-pet");
    for (const span of spans.filter((candidate) => candidate !== tool)) {
      expect(span.attributes[GEN_AI_SKILL_NAME]).toBeUndefined();
      expect(span.attributes[GEN_AI_SKILL_ID]).toBeUndefined();
    }
  });

  it("skillDetection=false disables inference but keeps explicit event fields", async () => {
    const inferred = await convertEventLogToReadableSpans(
      toolTurn("Skill", { skill: "auto" }),
      { skillDetection: false },
    );
    expect(toolSpan(inferred.spans).attributes[GEN_AI_SKILL_NAME]).toBeUndefined();

    const explicit = await convertEventLogToReadableSpans(
      toolTurn(
        "ordinary",
        {},
        {
          [GEN_AI_SKILL_NAME]: "explicit",
          [GEN_AI_SKILL_ID]: "skill-explicit",
        },
      ),
      { skillDetection: false },
    );
    expect(toolSpan(explicit.spans).attributes[GEN_AI_SKILL_NAME]).toBe(
      "explicit",
    );
    expect(toolSpan(explicit.spans).attributes[GEN_AI_SKILL_ID]).toBe(
      "skill-explicit",
    );
  });

  it("streaming conversion uses the same detection and configuration", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
    const session = createTurnStreamSession({
      handler,
      skillDetection: {
        toolNames: ["InvokeSkill"],
        pathHeuristic: false,
      },
    });
    const records = toolTurn("InvokeSkill", { name: "streaming-skill" });

    session.push([records[0]!]);
    session.push([records[1]!]);
    session.end();
    await provider.forceFlush();

    const tool = toolSpan(exporter.getFinishedSpans());
    expect(tool.attributes[GEN_AI_SKILL_NAME]).toBe("streaming-skill");
    expect(tool.attributes[GEN_AI_SKILL_ID]).toBe("streaming-skill");
    await provider.shutdown();
  });

  it("propagates detection configuration into nested subagent TOOL spans", async () => {
    const parent = toolTurn("Agent", { task: "delegate" });
    parent[0]!["gen_ai.tool.call.id"] = "parent-agent";
    parent[1]!["gen_ai.tool.call.id"] = "parent-agent";

    const childBase = {
      ...parent[0],
      "gen_ai.agent.scope": "subagent",
      "gen_ai.subagent.parent_tool_call.id": "parent-agent",
      "gen_ai.agent.type": "child-agent",
      "gen_ai.step.id": "child-step",
    };
    const childCall: EventLogRecord = {
      ...childBase,
      "event.id": "child-tool-call",
      "event.name": "tool.call",
      time_unix_nano: "1780000001200000000",
      "gen_ai.tool.name": "InvokeSkill",
      "gen_ai.tool.call.id": "child-skill",
      "gen_ai.tool.call.arguments": { name: "child-skill-name" },
    };
    const childResult: EventLogRecord = {
      ...childBase,
      "event.id": "child-tool-result",
      "event.name": "tool.result",
      time_unix_nano: "1780000001800000000",
      "gen_ai.tool.name": "InvokeSkill",
      "gen_ai.tool.call.id": "child-skill",
      "gen_ai.tool.call.result": { success: true },
    };

    const { spans } = await convertEventLogToReadableSpans(
      [parent[0]!, childCall, childResult, parent[1]!],
      {
        skillDetection: {
          toolNames: ["InvokeSkill"],
          pathHeuristic: false,
        },
      },
    );

    const childTool = spans.find(
      (span) => span.name === "execute_tool InvokeSkill",
    )!;
    expect(childTool.attributes[GEN_AI_SKILL_NAME]).toBe("child-skill-name");
    expect(childTool.attributes[GEN_AI_SKILL_ID]).toBe("child-skill-name");
  });
});
