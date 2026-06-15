// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlEmitter } from "../src/jsonl-emitter.js";
import { registerJsonlHooks } from "../src/jsonl-hooks.js";
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  LlmInputEvent,
  LlmOutputEvent,
  MessageReceivedEvent,
  OpenClawPluginApi,
} from "../src/types.js";

type HookHandler = (event: unknown, ctx: Record<string, unknown>) => Promise<void> | void;

interface HookBus {
  handlers: Map<string, HookHandler[]>;
  fire(name: string, event: unknown, ctx?: Record<string, unknown>): Promise<void>;
  api: OpenClawPluginApi;
}

function makeApi(): HookBus {
  const handlers = new Map<string, HookHandler[]>();
  const api: OpenClawPluginApi = {
    config: {},
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(name, handler) {
      const list = handlers.get(name) || [];
      list.push(handler as HookHandler);
      handlers.set(name, list);
    },
  };
  return {
    handlers,
    api,
    async fire(name, event, ctx = {}) {
      const list = handlers.get(name) || [];
      for (const h of list) {
        await h(event, ctx);
      }
    },
  };
}

function todayJsonl(dir: string): string {
  const d = new Date();
  return path.join(
    dir,
    `openclaw-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`,
  );
}

function readLines(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("registerJsonlHooks — end-to-end one turn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("emits 4 lines for one LLM turn with one tool call", async () => {
    const bus = makeApi();
    const emitter = new JsonlEmitter({
      logDir: tmpDir,
      captureMessageContent: false,
      logger: bus.api.logger,
    });
    registerJsonlHooks(bus.api, emitter);

    await bus.fire("message_received", {
      from: "alice",
      content: "hi",
    } satisfies MessageReceivedEvent, { sessionKey: "sess-A" });

    await bus.fire("llm_input", {
      runId: "run-1",
      sessionId: "sess-A",
      provider: "openai",
      model: "gpt-4o",
      systemPrompt: "you are helpful",
      prompt: "hi",
      historyMessages: [],
      imagesCount: 0,
    } satisfies LlmInputEvent);

    await bus.fire("before_tool_call", {
      runId: "run-1",
      toolName: "shell",
      toolCallId: "call-1",
      params: { cmd: "ls" },
    } satisfies BeforeToolCallEvent);

    await bus.fire("after_tool_call", {
      runId: "run-1",
      toolName: "shell",
      toolCallId: "call-1",
      params: { cmd: "ls" },
      result: { stdout: "ok" },
      durationMs: 12,
    } satisfies AfterToolCallEvent);

    await bus.fire("llm_output", {
      runId: "run-1",
      sessionId: "sess-A",
      provider: "openai",
      model: "gpt-4o",
      assistantTexts: ["all good"],
      usage: { input: 5, output: 7, total: 12 },
    } satisfies LlmOutputEvent);

    const lines = readLines(todayJsonl(tmpDir));
    expect(lines.length).toBe(4);

    const names = lines.map((l) => l["event.name"]);
    expect(names).toEqual([
      "llm.request",
      "tool.call",
      "tool.result",
      "llm.response",
    ]);

    // user.id propagated from message_received
    for (const l of lines) {
      expect(l["user.id"]).toBe("alice");
      expect(l["session.id"]).toBe("sess-A");
      expect(l["agent.type"]).toBe("openclaw");
      expect(l["turn.id"]).toBe("run-1");
    }

    // step.id stays consistent within the turn
    const steps = lines.map((l) => l["step.id"]);
    expect(new Set(steps).size).toBe(1);
  });

  it("does not double-emit llm.response when llm_output fires twice for same step", async () => {
    const bus = makeApi();
    const emitter = new JsonlEmitter({
      logDir: tmpDir,
      captureMessageContent: false,
      logger: bus.api.logger,
    });
    registerJsonlHooks(bus.api, emitter);

    await bus.fire("llm_input", {
      runId: "r",
      sessionId: "s",
      provider: "p",
      model: "m",
      prompt: "x",
      historyMessages: [],
      imagesCount: 0,
    } satisfies LlmInputEvent);
    await bus.fire("llm_output", {
      runId: "r",
      sessionId: "s",
      provider: "p",
      model: "m",
      assistantTexts: ["a"],
      usage: { input: 1, output: 1 },
    } satisfies LlmOutputEvent);
    await bus.fire("llm_output", {
      runId: "r",
      sessionId: "s",
      provider: "p",
      model: "m",
      assistantTexts: ["b"],
      usage: { input: 2, output: 2 },
    } satisfies LlmOutputEvent);

    const lines = readLines(todayJsonl(tmpDir));
    const responses = lines.filter((l) => l["event.name"] === "llm.response");
    expect(responses.length).toBe(1);
  });

  it("captureMessageContent=true includes input/output messages", async () => {
    const bus = makeApi();
    const emitter = new JsonlEmitter({
      logDir: tmpDir,
      captureMessageContent: true,
      logger: bus.api.logger,
    });
    registerJsonlHooks(bus.api, emitter);

    await bus.fire("llm_input", {
      runId: "r",
      sessionId: "s",
      provider: "p",
      model: "m",
      prompt: "what time is it",
      historyMessages: [],
      imagesCount: 0,
    } satisfies LlmInputEvent);
    await bus.fire("llm_output", {
      runId: "r",
      sessionId: "s",
      provider: "p",
      model: "m",
      assistantTexts: ["it is noon"],
      usage: { input: 1, output: 2 },
    } satisfies LlmOutputEvent);

    const lines = readLines(todayJsonl(tmpDir));
    const req = lines.find((l) => l["event.name"] === "llm.request");
    const res = lines.find((l) => l["event.name"] === "llm.response");
    expect(req).toBeDefined();
    expect(res).toBeDefined();
    expect(req!["gen_ai.input.messages"]).toBeDefined();
    expect(res!["gen_ai.output.messages"]).toBeDefined();
  });

  it("step.id increments across multiple LLM turns within same run", async () => {
    const bus = makeApi();
    const emitter = new JsonlEmitter({
      logDir: tmpDir,
      captureMessageContent: false,
      logger: bus.api.logger,
    });
    registerJsonlHooks(bus.api, emitter);

    for (let i = 1; i <= 3; i += 1) {
      await bus.fire("llm_input", {
        runId: "run-Z",
        sessionId: "sess",
        provider: "p",
        model: "m",
        prompt: `turn ${i}`,
        historyMessages: [],
        imagesCount: 0,
      } satisfies LlmInputEvent);
      await bus.fire("llm_output", {
        runId: "run-Z",
        sessionId: "sess",
        provider: "p",
        model: "m",
        assistantTexts: [`reply ${i}`],
        usage: { input: i, output: i },
      } satisfies LlmOutputEvent);
    }

    const lines = readLines(todayJsonl(tmpDir));
    expect(lines.length).toBe(6);

    const requestSteps = lines
      .filter((l) => l["event.name"] === "llm.request")
      .map((l) => Number(l["step.id"]));
    expect(requestSteps).toEqual([1, 2, 3]);
  });
});
