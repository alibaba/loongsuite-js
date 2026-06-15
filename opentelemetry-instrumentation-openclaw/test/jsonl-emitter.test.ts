// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JsonlEmitter,
  buildLlmRequestRecord,
  buildLlmResponseRecord,
  buildToolCallRecord,
  buildToolResultRecord,
  readSharedOtelConfig,
} from "../src/jsonl-emitter.js";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-jsonl-test-"));
}

function readJsonl(filePath: string): unknown[] {
  const text = fs.readFileSync(filePath, "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function todayJsonlFile(dir: string): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return path.join(dir, `openclaw-${yyyy}-${mm}-${dd}.jsonl`);
}

describe("buildLlmRequestRecord", () => {
  it("contains required event_t fields", () => {
    const rec = buildLlmRequestRecord(
      { sessionId: "sess-1", userId: "u-1", runId: "run-1", stepId: 1 },
      { provider: "openai", model: "gpt-4o", prompt: "hi" },
      false,
    );
    expect(rec["event.name"]).toBe("llm.request");
    expect(rec["session.id"]).toBe("sess-1");
    expect(rec["user.id"]).toBe("u-1");
    expect(rec["agent.type"]).toBe("openclaw");
    expect(rec["turn.id"]).toBe("run-1");
    expect(rec["step.id"]).toBe("1");
    expect(rec["gen_ai.provider.name"]).toBe("openai");
    expect(rec["gen_ai.request.model"]).toBe("gpt-4o");
    expect(rec["time_unix_nano"]).toMatch(/^\d+$/);
    expect(rec["event.id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("excludes input.messages when captureMessageContent=false", () => {
    const rec = buildLlmRequestRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      { prompt: "secret" },
      false,
    );
    expect(rec["gen_ai.input.messages"]).toBeUndefined();
  });

  it("includes input.messages when captureMessageContent=true", () => {
    const rec = buildLlmRequestRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      {
        systemPrompt: "you are helpful",
        prompt: "hi",
        historyMessages: [{ role: "user", content: "earlier" }],
      },
      true,
    );
    expect(Array.isArray(rec["gen_ai.input.messages"])).toBe(true);
    const msgs = rec["gen_ai.input.messages"] as unknown[];
    expect(msgs.length).toBe(3); // system + history + current user
  });
});

describe("buildLlmResponseRecord", () => {
  it("captures usage tokens", () => {
    const rec = buildLlmResponseRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      {
        provider: "openai",
        model: "gpt-4o",
        finishReason: "stop",
        usage: { input: 10, output: 20, total: 30, cacheRead: 5 },
      },
      false,
    );
    expect(rec["gen_ai.usage.input_tokens"]).toBe(10);
    expect(rec["gen_ai.usage.output_tokens"]).toBe(20);
    expect(rec["gen_ai.usage.total_tokens"]).toBe(30);
    expect(rec["gen_ai.usage.cache_read.input_tokens"]).toBe(5);
    expect(rec["response.finish_reasons"]).toBe("stop");
  });

  it("computes total when not provided", () => {
    const rec = buildLlmResponseRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      { usage: { input: 7, output: 13 } },
      false,
    );
    expect(rec["gen_ai.usage.total_tokens"]).toBe(20);
  });
});

describe("buildToolCallRecord / buildToolResultRecord", () => {
  it("tool.call carries tool name + args", () => {
    const rec = buildToolCallRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      "shell",
      "call-1",
      { cmd: "ls" },
    );
    expect(rec["event.name"]).toBe("tool.call");
    expect(rec["gen_ai.tool.name"]).toBe("shell");
    expect(rec["gen_ai.tool.call.id"]).toBe("call-1");
    expect(rec["gen_ai.tool.call.arguments"]).toEqual({ cmd: "ls" });
  });

  it("tool.result on success", () => {
    const rec = buildToolResultRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      "shell",
      "call-1",
      { result: { stdout: "ok" }, durationMs: 42 },
    );
    expect(rec["event.name"]).toBe("tool.result");
    expect(rec["tool.result.status"]).toBe("ok");
    expect(rec["gen_ai.tool.call.result"]).toEqual({ stdout: "ok" });
    expect(rec["tool.result.duration"]).toBe(42);
    expect(rec["error.type"]).toBeUndefined();
  });

  it("tool.result on error", () => {
    const rec = buildToolResultRecord(
      { sessionId: "s", runId: "r", stepId: 1 },
      "shell",
      "call-1",
      { error: "boom" },
    );
    expect(rec["tool.result.status"]).toBe("error");
    expect(rec["error.type"]).toBe("tool_error");
    expect(rec["error.message"]).toBe("boom");
    expect(rec["gen_ai.tool.call.result"]).toBeUndefined();
  });
});

describe("JsonlEmitter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("creates log dir and appends one JSONL line per emit", () => {
    const emitter = new JsonlEmitter({
      logDir: tmpDir,
      captureMessageContent: false,
      logger: noopLogger,
    });
    emitter.emit(
      buildLlmRequestRecord(
        { sessionId: "s", userId: "u", runId: "r", stepId: 1 },
        { provider: "p", model: "m", prompt: "x" },
        false,
      ),
    );
    emitter.emit(
      buildLlmResponseRecord(
        { sessionId: "s", userId: "u", runId: "r", stepId: 1 },
        { provider: "p", model: "m", finishReason: "stop", usage: { input: 1, output: 2, total: 3 } },
        false,
      ),
    );
    const file = todayJsonlFile(tmpDir);
    expect(fs.existsSync(file)).toBe(true);
    const lines = readJsonl(file);
    expect(lines.length).toBe(2);
    expect((lines[0] as Record<string, unknown>)["event.name"]).toBe("llm.request");
    expect((lines[1] as Record<string, unknown>)["event.name"]).toBe("llm.response");
  });

  it("appends instead of overwriting on second emit", () => {
    const emitter = new JsonlEmitter({
      logDir: tmpDir,
      captureMessageContent: false,
      logger: noopLogger,
    });
    for (let i = 0; i < 5; i += 1) {
      emitter.emit(
        buildToolCallRecord(
          { sessionId: "s", runId: "r", stepId: 1 },
          "tool-x",
          `call-${i}`,
          { i },
        ),
      );
    }
    const lines = readJsonl(todayJsonlFile(tmpDir));
    expect(lines.length).toBe(5);
  });

  it("write failure is silent (logger.warn called)", () => {
    let warnCalled = false;
    const logger = {
      info: () => {},
      warn: () => { warnCalled = true; },
      error: () => {},
    };
    // Use a path that cannot be created (file exists where dir is expected).
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "x");
    const emitter = new JsonlEmitter({
      logDir: path.join(blocker, "subdir"),
      captureMessageContent: false,
      logger,
    });
    emitter.emit(
      buildLlmRequestRecord(
        { sessionId: "s", runId: "r", stepId: 1 },
        {},
        false,
      ),
    );
    expect(warnCalled).toBe(true);
  });
});

describe("readSharedOtelConfig", () => {
  it("returns {} for missing file", () => {
    expect(readSharedOtelConfig("/tmp/__nonexistent_openclaw_otel_config.json"))
      .toEqual({});
  });

  it("parses a valid file", () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, "otel-config.json");
      fs.writeFileSync(file, JSON.stringify({
        log_enabled: true,
        log_dir: "/tmp/foo",
      }));
      const cfg = readSharedOtelConfig(file);
      expect(cfg.log_enabled).toBe(true);
      expect(cfg.log_dir).toBe("/tmp/foo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} for malformed JSON", () => {
    const dir = makeTmpDir();
    try {
      const file = path.join(dir, "bad.json");
      fs.writeFileSync(file, "not json{{");
      expect(readSharedOtelConfig(file)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
