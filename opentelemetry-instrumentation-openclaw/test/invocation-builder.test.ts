// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  buildLlmInvocation,
  buildEntryInvocation,
  buildAgentInvocation,
  buildStepInvocation,
  buildToolInvocation,
  type OpenclawContext,
  type LlmBuildParams,
} from "../src/invocation-builder.js";

const OCTX: OpenclawContext = {
  openclawVersion: "1.0.0",
  sessionId: "sess-001",
  channelId: "ch-001",
  runId: "run-001",
  turnId: "turn-001",
};

const OCTX_WITH_AGENT: OpenclawContext = {
  ...OCTX,
  agentName: "my-agent",
};

describe("buildLlmInvocation", () => {
  it("passes toolDefinitions through to the invocation", () => {
    const params: LlmBuildParams = {
      provider: "openai",
      model: "gpt-4o",
      prompt: "Hello",
      toolDefinitions: [
        { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object" } },
        { type: "web_search", name: "search" },
      ],
    };

    const inv = buildLlmInvocation(OCTX, params);

    expect(inv.toolDefinitions).toHaveLength(2);
    expect(inv.toolDefinitions![0].name).toBe("get_weather");
    expect(inv.toolDefinitions![0].type).toBe("function");
    expect(inv.toolDefinitions![1].name).toBe("search");
  });

  it("omits toolDefinitions when not provided", () => {
    const params: LlmBuildParams = {
      provider: "openai",
      model: "gpt-4o",
      prompt: "Hello",
    };

    const inv = buildLlmInvocation(OCTX, params);

    expect(inv.toolDefinitions).toBeUndefined();
  });

  it("preserves existing invocation fields alongside new ones", () => {
    const params: LlmBuildParams = {
      provider: "anthropic",
      model: "claude-3-opus",
      prompt: "Test",
      systemPrompt: "Be helpful",
      inputTokens: 100,
      outputTokens: 50,
      stopReason: "stop",
      toolDefinitions: [
        { type: "function", name: "calc", description: "Calculate", parameters: null },
      ],
    };

    const inv = buildLlmInvocation(OCTX, params);

    expect(inv.provider).toBe("anthropic");
    expect(inv.requestModel).toBe("claude-3-opus");
    expect(inv.inputTokens).toBe(100);
    expect(inv.outputTokens).toBe(50);
    expect(inv.toolDefinitions).toHaveLength(1);
    expect(inv.systemInstruction).toHaveLength(1);
  });
});

describe("gen_ai.agent.name propagation", () => {
  it("buildLlmInvocation includes gen_ai.agent.name when agentName is set", () => {
    const inv = buildLlmInvocation(OCTX_WITH_AGENT, { provider: "openai", model: "gpt-4o", prompt: "Hi" });
    expect(inv.attributes?.["gen_ai.agent.name"]).toBe("my-agent");
  });

  it("buildLlmInvocation omits gen_ai.agent.name when agentName is undefined", () => {
    const inv = buildLlmInvocation(OCTX, { provider: "openai", model: "gpt-4o", prompt: "Hi" });
    expect(inv.attributes?.["gen_ai.agent.name"]).toBeUndefined();
  });

  it("buildEntryInvocation includes gen_ai.agent.name when agentName is set", () => {
    const inv = buildEntryInvocation(OCTX_WITH_AGENT, { from: "my-agent" });
    expect(inv.attributes?.["gen_ai.agent.name"]).toBe("my-agent");
  });

  it("buildEntryInvocation omits gen_ai.agent.name when agentName is undefined", () => {
    const inv = buildEntryInvocation(OCTX);
    expect(inv.attributes?.["gen_ai.agent.name"]).toBeUndefined();
  });

  it("buildAgentInvocation always includes gen_ai.agent.name", () => {
    const inv = buildAgentInvocation(OCTX, "test-agent");
    expect(inv.attributes?.["gen_ai.agent.name"]).toBe("test-agent");
  });

  it("buildStepInvocation includes gen_ai.agent.name when agentName is set", () => {
    const inv = buildStepInvocation(OCTX_WITH_AGENT, 1);
    expect(inv.attributes?.["gen_ai.agent.name"]).toBe("my-agent");
  });

  it("buildStepInvocation omits gen_ai.agent.name when agentName is undefined", () => {
    const inv = buildStepInvocation(OCTX, 1);
    expect(inv.attributes?.["gen_ai.agent.name"]).toBeUndefined();
  });

  it("buildToolInvocation includes gen_ai.agent.name when agentName is set", () => {
    const inv = buildToolInvocation("search", "tc-1", { q: "test" }, OCTX_WITH_AGENT);
    expect(inv.attributes?.["gen_ai.agent.name"]).toBe("my-agent");
  });

  it("buildToolInvocation omits gen_ai.agent.name when agentName is undefined", () => {
    const inv = buildToolInvocation("search", "tc-1", { q: "test" }, OCTX);
    expect(inv.attributes?.["gen_ai.agent.name"]).toBeUndefined();
  });
});
