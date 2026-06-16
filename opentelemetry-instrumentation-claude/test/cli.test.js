// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

// ─── Redirect state files to a temp dir ───────────────────────────────────
const TMP_STATE = path.join(os.tmpdir(), `otel-claude-test-${process.pid}`);
fs.mkdirSync(TMP_STATE, { recursive: true });

// Mock state module to use temp dir
jest.mock("../src/state", () => {
  const path2 = require("path");
  const fs2 = require("fs");
  const os2 = require("os");
  const tmpDir = path2.join(os2.tmpdir(), `otel-claude-test-${process.pid}`);
  fs2.mkdirSync(tmpDir, { recursive: true });

  function stateFile(sid) { return path2.join(tmpDir, `${sid}.json`); }
  function stateDir() { return tmpDir; }

  return {
    STATE_DIR: tmpDir,
    stateFile,
    stateDir,
    loadState(sid) {
      const sf = stateFile(sid);
      if (fs2.existsSync(sf)) {
        try { return JSON.parse(fs2.readFileSync(sf, "utf-8")); } catch {}
      }
      return { session_id: sid, start_time: Date.now() / 1000, prompt: "", model: "unknown",
               transcript_path: null,
               metrics: { input_tokens: 0, output_tokens: 0, tools_used: 0, turns: 0 },
               tools_used: [], events: [] };
    },
    saveState(sid, state) { fs2.writeFileSync(stateFile(sid), JSON.stringify(state), "utf-8"); },
    clearState(sid) { try { fs2.unlinkSync(stateFile(sid)); } catch {} },
    readAndDeleteChildState(sid) {
      const sf = stateFile(sid);
      if (!fs2.existsSync(sf)) return null;
      try { const d = JSON.parse(fs2.readFileSync(sf, "utf-8")); fs2.unlinkSync(sf); return d; } catch { return null; }
    },
  };
});

// Mock telemetry
jest.mock("../src/telemetry", () => ({
  configureTelemetry: jest.fn(),
  shutdownTelemetry: jest.fn().mockResolvedValue(undefined),
  resolveServiceName: jest.fn().mockReturnValue("test-service"),
}));

// Mock OTel API
jest.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: jest.fn().mockReturnValue({
      startSpan: jest.fn().mockReturnValue({ setAttribute: jest.fn(), end: jest.fn() }),
    }),
    setSpan: jest.fn().mockReturnValue({}),
  },
  context: { active: jest.fn().mockReturnValue({}) },
  SpanStatusCode: { ERROR: 2 },
}));

// ─── Mock @loongsuite/opentelemetry-util-genai SDK ───────────────────────
// Jest hoists jest.mock() so we prefix variables with "mock" to allow references.
let mockHandlerInstance;

jest.mock("@loongsuite/opentelemetry-util-genai", () => {
  const mockMakeInv = (extra) => ({ contextToken: {}, attributes: {}, ...extra });
  const handler = {
    startEntry: jest.fn((inv) => { inv.contextToken = inv.contextToken || {}; }),
    stopEntry: jest.fn(),
    failEntry: jest.fn(),
    startInvokeAgent: jest.fn((inv) => { inv.contextToken = inv.contextToken || {}; }),
    stopInvokeAgent: jest.fn(),
    failInvokeAgent: jest.fn(),
    startReactStep: jest.fn((inv) => { inv.contextToken = inv.contextToken || {}; }),
    stopReactStep: jest.fn(),
    failReactStep: jest.fn(),
    startExecuteTool: jest.fn((inv) => { inv.contextToken = inv.contextToken || {}; }),
    stopExecuteTool: jest.fn(),
    failExecuteTool: jest.fn(),
    startLlm: jest.fn((inv) => { inv.contextToken = inv.contextToken || {}; }),
    stopLlm: jest.fn(),
    failLlm: jest.fn(),
  };

  mockHandlerInstance = handler;

  return {
    ExtendedTelemetryHandler: jest.fn().mockImplementation(() => handler),
    createEntryInvocation: jest.fn((opts) => mockMakeInv({ type: "entry", ...opts })),
    createInvokeAgentInvocation: jest.fn((provider, opts) => mockMakeInv({ type: "agent", provider, ...opts })),
    createReactStepInvocation: jest.fn((opts) => mockMakeInv({ type: "step", ...opts })),
    createExecuteToolInvocation: jest.fn((name, opts) => mockMakeInv({ type: "tool", toolName: name, ...opts })),
    createLLMInvocation: jest.fn((opts) => mockMakeInv({ type: "llm", ...opts })),
  };
});

const stateModule = require("../src/state");
const cli = require("../src/cli");
const sdk = require("@loongsuite/opentelemetry-util-genai");

afterAll(() => {
  try { fs.rmSync(TMP_STATE, { recursive: true, force: true }); } catch {}
});

// ─── buildHookConfig ───────────────────────────────────────────────────────
describe("buildHookConfig", () => {
  test("generates config for all 8 hook events", () => {
    const config = cli._buildHookConfig("otel-claude-hook");
    const events = Object.keys(config);
    expect(events).toContain("UserPromptSubmit");
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
    expect(events).toContain("Stop");
    expect(events).toContain("PreCompact");
    expect(events).toContain("SubagentStart");
    expect(events).toContain("SubagentStop");
    expect(events).toContain("Notification");
    expect(events).toHaveLength(8);
  });

  test("uses provided command name", () => {
    const config = cli._buildHookConfig("my-hook");
    const cmd = config.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("my-hook");
    expect(cmd).toContain("user-prompt-submit");
  });
});

// ─── tsNs: seconds → integer nanoseconds ─────────────────────────────────
describe("tsNs (seconds → integer nanoseconds)", () => {
  test("converts seconds to nanoseconds integer", () => {
    const ns = cli._tsNs(1.5);
    expect(ns).toBe(1500000000);
  });
  test("handles whole seconds", () => {
    expect(cli._tsNs(100)).toBe(100000000000);
  });
  test("sub-second precision", () => {
    expect(cli._tsNs(1.001)).toBe(1001000000);
  });
});

// ─── hrTime: seconds → [sec, nanos] OTel HrTime tuple ────────────────────
describe("hrTime (seconds → [sec, nanos] HrTime tuple)", () => {
  test("returns [seconds, nanos] tuple", () => {
    expect(cli._hrTime(1.5)).toEqual([1, 500000000]);
  });
  test("handles integer seconds", () => {
    expect(cli._hrTime(100)).toEqual([100, 0]);
  });
  test("subsecond precision", () => {
    expect(cli._hrTime(1.001)).toEqual([1, 1000000]);
  });
});

// ─── readProxyEvents ──────────────────────────────────────────────────────
describe("readProxyEvents", () => {
  test("returns empty array when dir does not exist", () => {
    const result = cli._readProxyEvents(0, 1e10, false, null);
    expect(Array.isArray(result)).toBe(true);
  });

  test("reads events from JSONL file within time window", () => {
    const now = Date.now() / 1000;
    const evt = JSON.stringify({ type: "llm_call", timestamp: now, model: "claude" });
    const file = path.join(TMP_STATE, "proxy_events_99999.jsonl");
    fs.writeFileSync(file, evt + "\n", "utf-8");
    const results = cli._readProxyEvents(now - 10, now + 10, false, 99999);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("llm_call");
    fs.unlinkSync(file);
  });

  test("filters events outside time window", () => {
    const now = Date.now() / 1000;
    const evt = JSON.stringify({ type: "llm_call", timestamp: now - 1000 });
    const file = path.join(TMP_STATE, "proxy_events_88888.jsonl");
    fs.writeFileSync(file, evt + "\n", "utf-8");
    const results = cli._readProxyEvents(now - 10, now + 10, false, 88888);
    expect(results.length).toBe(0);
    fs.unlinkSync(file);
  });

  test("deleteAfterRead removes the file", () => {
    const now = Date.now() / 1000;
    const file = path.join(TMP_STATE, "proxy_events_77777.jsonl");
    fs.writeFileSync(file, JSON.stringify({ type: "llm_call", timestamp: now }) + "\n", "utf-8");
    cli._readProxyEvents(now - 10, now + 10, true, 77777);
    expect(fs.existsSync(file)).toBe(false);
  });
});

// ─── Command handlers ─────────────────────────────────────────────────────
describe("cmdUserPromptSubmit", () => {
  const SID = `test-ups-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("increments turn count and saves prompt", () => {
    cli._cmdUserPromptSubmitWithEvent({ session_id: SID, prompt: "hello", model: "claude-3" });
    const state = stateModule.loadState(SID);
    expect(state.metrics.turns).toBe(1);
    expect(state.prompt).toBe("hello");
    expect(state.model).toBe("claude-3");
    expect(state.events[0].type).toBe("user_prompt_submit");
  });

  test("increments turns on second call", () => {
    cli._cmdUserPromptSubmitWithEvent({ session_id: SID, prompt: "hello" });
    cli._cmdUserPromptSubmitWithEvent({ session_id: SID, prompt: "world" });
    const state = stateModule.loadState(SID);
    expect(state.metrics.turns).toBe(2);
    expect(state.prompt).toBe("hello");
  });
});

describe("cmdPreToolUse", () => {
  const SID = `test-ptu-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("increments tools_used and records event", () => {
    cli._cmdPreToolUseWithEvent({ session_id: SID, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tool-001" });
    const state = stateModule.loadState(SID);
    expect(state.metrics.tools_used).toBe(1);
    expect(state.tools_used).toContain("Bash");
    expect(state.events[0].tool_use_id).toBe("tool-001");
  });

  test("tool_use_id falls back to null when missing", () => {
    cli._cmdPreToolUseWithEvent({ session_id: SID, tool_name: "Read", tool_input: {} });
    const state = stateModule.loadState(SID);
    expect(state.events[0].tool_use_id).toBeNull();
  });
});

describe("cmdPostToolUse", () => {
  const SID = `test-potu-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records post_tool_use event", () => {
    cli._cmdPostToolUseWithEvent({ session_id: SID, tool_name: "Bash", tool_response: { result: "ok" }, tool_use_id: "tool-001" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("post_tool_use");
    expect(state.events[0].tool_use_id).toBe("tool-001");
    expect(state.events[0].tool_response).toEqual({ result: "ok" });
  });
});

describe("cmdPreCompact", () => {
  const SID = `test-pc-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records pre_compact event", () => {
    cli._cmdPreCompactWithEvent({ session_id: SID, trigger: "manual", custom_instructions: "foo" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("pre_compact");
    expect(state.events[0].trigger).toBe("manual");
    expect(state.events[0].has_custom_instructions).toBe(true);
  });
});

describe("cmdNotification", () => {
  const SID = `test-notif-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records notification event", () => {
    cli._cmdNotificationWithEvent({ session_id: SID, message: "done", title: "T", level: "info" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("notification");
    expect(state.events[0].message).toBe("done");
  });
});

describe("installIntoSettings", () => {
  const fakeEntry = "/tmp/fake-otel-claude-hook-entry.sh";

  test("creates settings.json with hooks when file does not exist", () => {
    const tmp = path.join(os.tmpdir(), `settings-${Date.now()}.json`);
    cli._installIntoSettings(tmp, fakeEntry);
    const settings = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    fs.unlinkSync(tmp);
  });

  test("is idempotent — does not duplicate hooks", () => {
    const tmp = path.join(os.tmpdir(), `settings-idem-${Date.now()}.json`);
    cli._installIntoSettings(tmp, fakeEntry);
    cli._installIntoSettings(tmp, fakeEntry);
    const settings = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    fs.unlinkSync(tmp);
  });

  test("preserves existing hooks from other tools", () => {
    const tmp = path.join(os.tmpdir(), `settings-existing-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    }), "utf-8");
    cli._installIntoSettings(tmp, fakeEntry);
    const settings = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    const cmds = settings.hooks.UserPromptSubmit.flatMap(m => m.hooks.map(h => h.command));
    expect(cmds.some(c => c.includes("other-tool"))).toBe(true);
    expect(cmds.some(c => c.includes("otel-claude-hook"))).toBe(true);
    fs.unlinkSync(tmp);
  });
});

// ─── replayEventsAsSpans — SDK handler-based tests ───────────────────────
describe("replayEventsAsSpans", () => {
  let mockSpan, mockTracer, mockCtx, handler;

  beforeEach(() => {
    mockSpan = { setAttribute: jest.fn(), end: jest.fn() };
    mockTracer = { startSpan: jest.fn().mockReturnValue(mockSpan) };
    mockCtx = {};
    handler = mockHandlerInstance;
    // Reset all handler mocks
    Object.values(handler).forEach(fn => { if (typeof fn === "function" && fn.mockClear) fn.mockClear(); });
    // Reset SDK factory mocks
    Object.values(sdk).forEach(fn => { if (typeof fn === "function" && fn.mockClear) fn.mockClear(); });
  });

  test("creates ReactStep on llm_call (not user_prompt_submit)", () => {
    const events = [{
      type: "llm_call",
      timestamp: 1001,
      request_start_time: 1000,
      model: "claude-sonnet-4-5",
      input_tokens: 100,
      output_tokens: 50,
      stop_reason: "stop",
    }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    expect(sdk.createReactStepInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ round: 1 })
    );
    expect(handler.startReactStep).toHaveBeenCalled();
    expect(handler.stopReactStep).toHaveBeenCalled();
  });

  test("user_prompt_submit events are ignored (handled by splitEventsByTurn)", () => {
    const events = [{ type: "user_prompt_submit", timestamp: 1000, prompt: "hello" }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1001);
    expect(sdk.createReactStepInvocation).not.toHaveBeenCalled();
    expect(handler.startReactStep).not.toHaveBeenCalled();
  });

  test("creates ExecuteTool via handler for pre/post_tool_use pair", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" },
      { type: "post_tool_use", timestamp: 1001, tool_name: "Bash", tool_response: { result: "ok" }, tool_use_id: "t1" },
    ];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    expect(sdk.createExecuteToolInvocation).toHaveBeenCalledWith("Bash", expect.any(Object));
    expect(handler.startExecuteTool).toHaveBeenCalled();
    expect(handler.stopExecuteTool).toHaveBeenCalled();
  });

  test("pre_tool_use for non-Agent tool creates no span (deferred to post_tool_use)", () => {
    const events = [{ type: "pre_tool_use", timestamp: 1000, tool_name: "Read", tool_input: {}, tool_use_id: null }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1001);
    expect(handler.startExecuteTool).not.toHaveBeenCalled();
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  test("creates notification span via raw tracer", () => {
    const events = [{ type: "notification", timestamp: 1000, message: "done", level: "info", title: "" }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      expect.stringContaining("done"), expect.any(Object), mockCtx
    );
  });

  test("creates pre_compact span via raw tracer", () => {
    const events = [{ type: "pre_compact", timestamp: 1000, trigger: "manual", has_custom_instructions: false }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "compact", expect.any(Object), mockCtx
    );
  });

  test("creates LLM span under a STEP for llm_call", () => {
    const events = [{
      type: "llm_call",
      timestamp: 1001,
      request_start_time: 1000,
      model: "claude-3-5-sonnet",
      input_tokens: 100,
      output_tokens: 50,
      input_messages: [{ role: "user", content: "Hi" }],
      output_content: [{ type: "text", text: "Hello" }],
    }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    expect(sdk.createLLMInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "chat",
        requestModel: "claude-3-5-sonnet",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 50,
      })
    );
    expect(handler.startLlm).toHaveBeenCalled();
    expect(handler.stopLlm).toHaveBeenCalled();
    // LLM call also creates a STEP (reasoning cycle)
    expect(sdk.createReactStepInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ round: 1 })
    );
  });

  test("subagent_start creates InvokeAgent via handler", () => {
    const events = [{ type: "subagent_start", timestamp: 1000, subagent_session_id: "sub-123", agent_id: "ag-1", agent_type: "MyAgent" }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1001);
    expect(sdk.createInvokeAgentInvocation).toHaveBeenCalledWith("anthropic", expect.objectContaining({ agentName: "MyAgent" }));
    expect(handler.startInvokeAgent).toHaveBeenCalled();
    // Should also close in cleanup since there's no matching post
    expect(handler.stopInvokeAgent).toHaveBeenCalled();
  });

  test("handles multiple LLM calls as separate STEP reasoning cycles", () => {
    const events = [
      { type: "llm_call", timestamp: 1001, request_start_time: 1000, model: "claude-sonnet-4-5",
        input_tokens: 100, output_tokens: 50, stop_reason: "tool_use" },
      { type: "post_tool_use", timestamp: 1002, tool_name: "Bash", tool_response: { result: "ok" }, tool_use_id: "t1" },
      { type: "llm_call", timestamp: 1003, request_start_time: 1002.5, model: "claude-sonnet-4-5",
        input_tokens: 200, output_tokens: 100, stop_reason: "stop" },
    ];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1004);
    expect(sdk.createReactStepInvocation).toHaveBeenCalledTimes(2);
    expect(sdk.createReactStepInvocation).toHaveBeenCalledWith(expect.objectContaining({ round: 1 }));
    expect(sdk.createReactStepInvocation).toHaveBeenCalledWith(expect.objectContaining({ round: 2 }));
    // First step closed when second LLM call starts, second closed at stopTime
    expect(handler.stopReactStep).toHaveBeenCalledTimes(2);
    // Tool belongs to first step
    expect(handler.startExecuteTool).toHaveBeenCalled();
  });
});

// ─── cmdSubagentStart/Stop ────────────────────────────────────────────────
describe("cmdSubagentStart", () => {
  const SID = `test-sas-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records subagent_start event", () => {
    cli._cmdSubagentStartWithEvent({ session_id: SID, subagent_session_id: "child-1" });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("subagent_start");
    expect(state.events[0].subagent_session_id).toBe("child-1");
  });
});

describe("cmdSubagentStop", () => {
  const SID = `test-sasto-${Date.now()}`;
  afterEach(() => stateModule.clearState(SID));

  test("records subagent_stop event with token counts", () => {
    cli._cmdSubagentStopWithEvent({ session_id: SID, subagent_session_id: "child-1", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } });
    const state = stateModule.loadState(SID);
    expect(state.events[0].type).toBe("subagent_stop");
    expect(state.events[0].input_tokens).toBe(100);
    expect(state.events[0].stop_reason).toBe("end_turn");
  });

  test("inlines child state when child session exists", () => {
    const CHILD_SID = `test-child-${Date.now()}`;
    const childState = stateModule.loadState(CHILD_SID);
    childState.prompt = "child task";
    childState.events.push({ type: "user_prompt_submit", timestamp: 1000, prompt: "child task" });
    stateModule.saveState(CHILD_SID, childState);

    cli._cmdSubagentStopWithEvent({ session_id: SID, subagent_session_id: CHILD_SID, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    const state = stateModule.loadState(SID);
    expect(state.events[0]._child_state).toBeDefined();
    expect(state.events[0]._child_state.prompt).toBe("child task");
  });
});

// ─── cmdCheckEnv ──────────────────────────────────────────────────────────
describe("cmdCheckEnv", () => {
  const config = require("../src/config");
  const origReadFileSync = fs.readFileSync;

  beforeEach(() => {
    config.resetConfigCache();
    fs.readFileSync = function (p, ...args) {
      if (typeof p === "string" && p.includes("otel-config.json")) {
        throw new Error("ENOENT");
      }
      return origReadFileSync.call(this, p, ...args);
    };
  });

  afterEach(() => {
    fs.readFileSync = origReadFileSync;
    config.resetConfigCache();
  });

  test("exits 1 when no backend configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    expect(() => cli.cmdCheckEnv()).toThrow("process.exit");
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  test("does not exit when OTLP endpoint is configured", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://example.com";
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {});
    expect(() => cli.cmdCheckEnv()).not.toThrow();
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  test("does not exit in debug mode", () => {
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {});
    expect(() => cli.cmdCheckEnv()).not.toThrow();
    mockExit.mockRestore();
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
  });
});

// ─── cmdShowConfig ────────────────────────────────────────────────────────
describe("cmdShowConfig", () => {
  test("outputs valid JSON with hooks structure", () => {
    const logs = [];
    const spy = jest.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    cli.cmdShowConfig();
    spy.mockRestore();
    const parsed = JSON.parse(logs[0]);
    expect(parsed.hooks).toBeDefined();
    expect(Object.keys(parsed.hooks)).toContain("UserPromptSubmit");
  });
});

// ─── removeAliasFromFile ──────────────────────────────────────────────────
describe("removeAliasFromFile", () => {
  test("removes BEGIN/END block from shell profile", () => {
    const tmp = path.join(os.tmpdir(), `bashrc-${Date.now()}`);
    fs.writeFileSync(tmp, [
      "export PATH=$PATH:/usr/local/bin",
      "",
      "# BEGIN otel-claude-hook",
      "alias claude='NODE_OPTIONS=... claude'",
      "# END otel-claude-hook",
      "",
      "export FOO=bar",
    ].join("\n"), "utf-8");

    cli._removeAliasFromFile(tmp);

    const result = fs.readFileSync(tmp, "utf-8");
    expect(result).not.toContain("BEGIN otel-claude-hook");
    expect(result).not.toContain("alias claude=");
    expect(result).toContain("export FOO=bar");
    expect(result).toContain("export PATH=");
    fs.unlinkSync(tmp);
  });

  test("is a no-op when block is not present", () => {
    const tmp = path.join(os.tmpdir(), `bashrc2-${Date.now()}`);
    const content = "export FOO=bar\nexport BAZ=qux\n";
    fs.writeFileSync(tmp, content, "utf-8");
    cli._removeAliasFromFile(tmp);
    expect(fs.readFileSync(tmp, "utf-8")).toBe(content);
    fs.unlinkSync(tmp);
  });
});

// ─── replayEventsAsSpans — extended event types ─────────────────────────
describe("replayEventsAsSpans — extended", () => {
  let mockSpan, mockTracer, mockCtx, handler;

  beforeEach(() => {
    mockSpan = { setAttribute: jest.fn(), end: jest.fn() };
    mockTracer = { startSpan: jest.fn().mockReturnValue(mockSpan) };
    mockCtx = {};
    handler = mockHandlerInstance;
    Object.values(handler).forEach(fn => { if (typeof fn === "function" && fn.mockClear) fn.mockClear(); });
    Object.values(sdk).forEach(fn => { if (typeof fn === "function" && fn.mockClear) fn.mockClear(); });
  });

  test("subagent_stop with child_state creates container agent and recurses", () => {
    const events = [{
      type: "subagent_stop", timestamp: 1001,
      subagent_session_id: "child-x",
      _child_state: {
        prompt: "child prompt",
        start_time: 990, stop_time: 1000,
        metrics: { input_tokens: 5, output_tokens: 3 },
        model: "claude-sonnet",
        events: [
          { type: "llm_call", timestamp: 992, request_start_time: 991,
            model: "claude-sonnet", input_tokens: 5, output_tokens: 3, stop_reason: "stop" },
        ],
      },
    }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    // Container agent + recursive child step
    expect(handler.startInvokeAgent).toHaveBeenCalled();
    expect(handler.stopInvokeAgent).toHaveBeenCalled();
    // Child events include an llm_call → ReactStep
    expect(handler.startReactStep).toHaveBeenCalled();
  });

  test("llm_call with is_error=true calls failLlm", () => {
    const events = [{
      type: "llm_call", timestamp: 1001, request_start_time: 1000,
      model: "claude-3", input_tokens: 0, output_tokens: 0,
      is_error: true, error_message: "rate limit exceeded",
    }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    expect(handler.failLlm).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ message: "rate limit exceeded", type: "LLMError" }),
      expect.any(Array)
    );
    expect(handler.stopLlm).not.toHaveBeenCalled();
  });

  test("llm_call passes message conversions to createLLMInvocation", () => {
    const events = [{
      type: "llm_call", timestamp: 1001, request_start_time: 1000,
      model: "claude-3", input_tokens: 5, output_tokens: 2,
      system_prompt: [{ text: "Be helpful." }, { text: "Be concise." }],
      input_messages: [{ role: "user", content: "Hi" }],
      output_content: [{ type: "text", text: "Hello" }],
      protocol: "anthropic",
    }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    expect(sdk.createLLMInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.any(Array),
        inputMessages: expect.any(Array),
        outputMessages: expect.any(Array),
      })
    );
  });

  test("orphaned non-Agent pre_tool_use (no post) creates a TOOL span with tool.orphaned=true", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Write", tool_input: { file_path: "/tmp/test" }, tool_use_id: "orphan-1" },
    ];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 2000);
    expect(handler.startExecuteTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "Write",
        toolCallId: "orphan-1",
        toolCallArguments: { file_path: "/tmp/test" },
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(handler.stopExecuteTool).toHaveBeenCalled();
  });

  test("Agent pre_tool_use creates ExecuteTool span immediately and is closed at stopTime if no post", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Agent", tool_input: {}, tool_use_id: "agent-1" },
    ];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 2000);
    expect(handler.startExecuteTool).toHaveBeenCalled();
    // Closed in cleanup at stopTime
    expect(handler.stopExecuteTool).toHaveBeenCalledWith(
      expect.any(Object), [2000, 0]
    );
  });

  test("notification with empty message uses generic title", () => {
    const events = [{ type: "notification", timestamp: 1000, message: "", level: "info", title: "" }];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1001);
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "notification", expect.any(Object), mockCtx
    );
  });

  test("post_tool_use with error response calls failExecuteTool", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Bash", tool_input: { command: "rm /" }, tool_use_id: "t-err" },
      { type: "post_tool_use", timestamp: 1001, tool_name: "Bash", tool_response: { error: "Permission denied", isError: true }, tool_use_id: "t-err" },
    ];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1002);
    expect(handler.failExecuteTool).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ message: "Permission denied", type: "ToolError" }),
      expect.any(Array)
    );
  });

  test("subagent_start + subagent_stop + post_tool_use Agent flow", () => {
    const events = [
      { type: "pre_tool_use", timestamp: 1000, tool_name: "Agent", tool_input: { subagent_type: "Explore" }, tool_use_id: "a1" },
      { type: "subagent_start", timestamp: 1001, agent_id: "ag-1", agent_type: "Explore", subagent_session_id: "sub-1" },
      { type: "subagent_stop", timestamp: 1005, subagent_session_id: "sub-1", stop_reason: "end_turn", input_tokens: 10, output_tokens: 5 },
      { type: "post_tool_use", timestamp: 1006, tool_name: "Agent", tool_response: { agent_id: "ag-1", result: "done" }, tool_use_id: "a1" },
    ];
    cli._replayEventsAsSpans(handler, mockTracer, events, mockCtx, 1010);
    // Agent tool + subagent invoke
    expect(handler.startExecuteTool).toHaveBeenCalled();
    expect(handler.startInvokeAgent).toHaveBeenCalled();
    expect(handler.stopInvokeAgent).toHaveBeenCalled();
    expect(handler.stopExecuteTool).toHaveBeenCalled();
  });
});

// ─── exportSessionTrace ────────────────────────────────────────────────────
describe("exportSessionTrace", () => {
  let errSpy, handler;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    handler = mockHandlerInstance;
    Object.values(handler).forEach(fn => { if (typeof fn === "function" && fn.mockClear) fn.mockClear(); });
    Object.values(sdk).forEach(fn => { if (typeof fn === "function" && fn.mockClear) fn.mockClear(); });
  });
  afterEach(() => { errSpy.mockRestore(); });

  test("throws on invalid state", async () => {
    await expect(cli._exportSessionTrace(null)).rejects.toThrow("invalid state object");
    await expect(cli._exportSessionTrace("not-an-object")).rejects.toThrow("invalid state object");
  });

  test("exports a valid session state with ENTRY + AGENT hierarchy", async () => {
    const state = {
      session_id: "sess-export-test",
      prompt: "test prompt",
      model: "claude-3",
      start_time: 1000,
      stop_time: 1005,
      metrics: { input_tokens: 10, output_tokens: 5, tools_used: 1, turns: 1 },
      tools_used: ["Bash"],
      events: [{ type: "user_prompt_submit", timestamp: 1001, prompt: "test prompt" }],
    };
    await expect(cli._exportSessionTrace(state, "end_turn")).resolves.toBeUndefined();
    // ENTRY span
    expect(sdk.createEntryInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-export-test" })
    );
    expect(handler.startEntry).toHaveBeenCalled();
    expect(handler.stopEntry).toHaveBeenCalled();
    // AGENT span
    expect(sdk.createInvokeAgentInvocation).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ agentName: "claude-code" })
    );
    expect(handler.startInvokeAgent).toHaveBeenCalled();
    expect(handler.stopInvokeAgent).toHaveBeenCalled();
  });

  test("creates ReactStep for llm_call events within a turn", async () => {
    const state = {
      session_id: "sess-step-test",
      prompt: "hello",
      model: "claude-3",
      start_time: 1000,
      stop_time: 1003,
      metrics: { turns: 1 },
      tools_used: [],
      events: [
        { type: "user_prompt_submit", timestamp: 1001, prompt: "hello" },
        { type: "llm_call", timestamp: 1002, request_start_time: 1001.5, model: "claude-3",
          input_tokens: 100, output_tokens: 50, stop_reason: "stop" },
      ],
    };
    await cli._exportSessionTrace(state);
    expect(handler.startReactStep).toHaveBeenCalled();
    expect(handler.stopReactStep).toHaveBeenCalled();
  });

  test("handles empty prompt gracefully", async () => {
    const state = {
      session_id: "sess-no-prompt",
      prompt: "",
      model: "claude-3",
      start_time: 1000, stop_time: 1001,
      metrics: {}, tools_used: [],
      events: [{ type: "user_prompt_submit", timestamp: 1000, prompt: "" }],
    };
    await cli._exportSessionTrace(state);
    expect(sdk.createEntryInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ inputMessages: [] })
    );
  });
});

// ─── installIntercept ──────────────────────────────────────────────────────
describe("installIntercept", () => {
  test("returns null when intercept.js is not in package", () => {
    const fs = require("fs");
    const existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = cli._installIntercept();
    existsSyncSpy.mockRestore();
    errSpy.mockRestore();
    expect(result).toBeNull();
  });
});

// ─── resolveClaudePid — Windows guard ─────────────────────────────────────
describe("resolveClaudePid Windows guard", () => {
  test("returns null on win32 platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const result = cli._resolveClaudePid();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    expect(result).toBeNull();
  });
});

// ─── cmdUninstall ─────────────────────────────────────────────────────────
describe("cmdUninstall", () => {
  test("runs without throwing when nothing is installed (no-user, no-project)", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => cli.cmdUninstall({ user: false, project: false })).not.toThrow();
    spy.mockRestore();
  });

  test("uninstall settings file round-trip: install then uninstall removes hooks", () => {
    const tmpDir = path.join(os.tmpdir(), `cl-uninstall-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const settingsPath = path.join(tmpDir, "settings.json");
    const fakeEntry = "/tmp/fake-otel-claude-hook-entry.sh";

    cli._installIntoSettings(settingsPath, fakeEntry);
    let settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);

    cli._installIntoSettings(settingsPath, fakeEntry); // idempotent
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const hookCount = Object.values(parsed.hooks).flat().length;
    expect(hookCount).toBe(Object.keys(parsed.hooks).length);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── generateTurnLogRecords ──────────────────────────────────────────────
describe("generateTurnLogRecords", () => {
  const { INITIAL_HASH, computeHash } = require("../src/logger");
  const sessionId = "test-session";
  const model = "claude-sonnet-4-5-20250514";
  const traceId = "abc123def456";

  function expectCommonFields(rec, sessionId, traceId) {
    expect(rec["event.id"]).toBeDefined();
    expect(rec["event.id"]).toHaveLength(36);
    expect(rec["event.name"]).toBeDefined();
    expect(rec["session.id"]).toBe(sessionId);
    expect(rec["agent.type"]).toBe("claude-code");
    expect(rec["user.id"]).toBeDefined();
    if (traceId) expect(rec.trace_id).toBe(traceId);
  }

  test("single LLM call turn generates user request + llm.request + llm.response", () => {
    const turn = {
      prompt: "Hello",
      startTime: 1000,
      endTime: 1001,
      events: [
        {
          type: "llm_call",
          timestamp: 1000.5,
          request_start_time: 1000.1,
          model: "claude-sonnet-4-5-20250514",
          input_messages: [{ role: "user", content: "Hello" }],
          output_content: [{ type: "text", text: "Hi there!" }],
          stop_reason: "end_turn",
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    };
    const { records, hash } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, traceId);

    expect(records).toHaveLength(3);

    const userRec = records[0];
    expectCommonFields(userRec, sessionId, traceId);
    expect(userRec["event.name"]).toBe("llm.request");
    expect(userRec["message.role"]).toBe("user");
    expect(userRec["turn.id"]).toBe(`${sessionId}:t1`);
    expect(userRec["input.messages_delta"]).toBeDefined();

    const reqRec = records[1];
    expectCommonFields(reqRec, sessionId, traceId);
    expect(reqRec["event.name"]).toBe("llm.request");
    expect(reqRec["message.role"]).toBe("assistant");
    expect(reqRec["step.id"]).toBe(`${sessionId}:t1:s1`);
    expect(reqRec["request.model"]).toBe(model);
    expect(reqRec["input.messages_hash"]).toHaveLength(32);
    expect(reqRec["input.messages_delta"]).toBeDefined();

    const respRec = records[2];
    expectCommonFields(respRec, sessionId, traceId);
    expect(respRec["event.name"]).toBe("llm.response");
    expect(respRec["message.role"]).toBe("assistant");
    expect(respRec["step.id"]).toBe(`${sessionId}:t1:s1`);
    expect(respRec["usage.input_tokens"]).toBe(10);
    expect(respRec["usage.output_tokens"]).toBe(5);
    expect(respRec["usage.total_tokens"]).toBe(15);
    expect(respRec["request.model"]).toBe(model);
    expect(respRec["output.messages"]).toBeDefined();
    expect(hash).toBe(reqRec["input.messages_hash"]);
  });

  test("multi-step turn generates split events for LLM and tools", () => {
    const turn = {
      prompt: "List files",
      startTime: 1000,
      endTime: 1003,
      events: [
        {
          type: "llm_call",
          timestamp: 1000.5,
          input_messages: [{ role: "user", content: "List files" }],
          output_content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
          stop_reason: "tool_use",
          input_tokens: 20,
          output_tokens: 10,
        },
        {
          type: "pre_tool_use",
          timestamp: 1001,
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_use_id: "t1",
        },
        {
          type: "post_tool_use",
          timestamp: 1001.5,
          tool_name: "Bash",
          tool_response: "file1.txt\nfile2.txt",
          tool_use_id: "t1",
        },
        {
          type: "llm_call",
          timestamp: 1002,
          input_messages: [
            { role: "user", content: "List files" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file1.txt\nfile2.txt" }] },
          ],
          output_content: [{ type: "text", text: "Here are the files." }],
          stop_reason: "end_turn",
          input_tokens: 30,
          output_tokens: 8,
        },
      ],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, traceId);

    // user(llm.request) + llm.request + llm.response + tool.call + tool.result + llm.request + llm.response
    expect(records).toHaveLength(7);
    expect(records[0]["event.name"]).toBe("llm.request");
    expect(records[0]["message.role"]).toBe("user");
    expect(records[1]["event.name"]).toBe("llm.request");
    expect(records[1]["message.role"]).toBe("assistant");
    expect(records[1]["step.id"]).toBe(`${sessionId}:t1:s1`);
    expect(records[2]["event.name"]).toBe("llm.response");
    expect(records[2]["step.id"]).toBe(`${sessionId}:t1:s1`);
    expect(records[3]["event.name"]).toBe("tool.call");
    expect(records[3]["tool.name"]).toBe("Bash");
    expect(records[3]["tool.call.id"]).toBe("t1");
    expect(records[4]["event.name"]).toBe("tool.result");
    expect(records[4]["tool.name"]).toBe("Bash");
    expect(records[4]["tool.call.id"]).toBe("t1");
    expect(records[4]["tool.result.status"]).toBe("success");
    expect(records[4]["tool.result.duration_ms"]).toBe(500);
    expect(records[5]["event.name"]).toBe("llm.request");
    expect(records[5]["step.id"]).toBe(`${sessionId}:t1:s2`);
    expect(records[6]["event.name"]).toBe("llm.response");
    expect(records[6]["step.id"]).toBe(`${sessionId}:t1:s2`);
  });

  test("error LLM call includes error fields on llm.response", () => {
    const turn = {
      prompt: "test",
      startTime: 1000,
      endTime: 1001,
      events: [{
        type: "llm_call",
        timestamp: 1000.5,
        input_messages: [{ role: "user", content: "test" }],
        output_content: null,
        stop_reason: "error",
        is_error: true,
        error_message: "rate limit exceeded",
        input_tokens: 0,
        output_tokens: 0,
      }],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, null);
    const respRec = records.find(r => r["event.name"] === "llm.response");
    expect(respRec["is_error"]).toBe(true);
    expect(respRec["error.type"]).toBe("LLMError");
    expect(respRec["error.message"]).toBe("rate limit exceeded");
  });

  test("orphaned pre_tool_use generates tool.call without tool.result", () => {
    const turn = {
      prompt: null,
      startTime: 1000,
      endTime: 1001,
      events: [{
        type: "pre_tool_use",
        timestamp: 1000.5,
        tool_name: "Read",
        tool_input: { file: "test.js" },
        tool_use_id: "orphan1",
      }],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, null);
    expect(records).toHaveLength(1);
    expect(records[0]["event.name"]).toBe("tool.call");
    expect(records[0]["tool.name"]).toBe("Read");
    expect(records[0]["tool.call.id"]).toBe("orphan1");
    expect(records[0]["tool.result"]).toBeUndefined();
  });

  test("Agent tool calls are skipped", () => {
    const turn = {
      prompt: "test",
      startTime: 1000,
      endTime: 1001,
      events: [
        { type: "pre_tool_use", timestamp: 1000.2, tool_name: "Agent", tool_input: {}, tool_use_id: "a1" },
        { type: "post_tool_use", timestamp: 1000.5, tool_name: "Agent", tool_response: {}, tool_use_id: "a1" },
      ],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, null);
    expect(records).toHaveLength(1); // only user llm.request
    expect(records[0]["event.name"]).toBe("llm.request");
    expect(records[0]["message.role"]).toBe("user");
  });

  test("hash chaining — second turn uses first turn hash as prevHash", () => {
    const turn1 = {
      prompt: "Hello",
      startTime: 1000,
      endTime: 1001,
      events: [{
        type: "llm_call",
        timestamp: 1000.5,
        input_messages: [{ role: "user", content: "Hello" }],
        output_content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        input_tokens: 5,
        output_tokens: 2,
      }],
    };
    const turn2 = {
      prompt: "How are you?",
      startTime: 1001,
      endTime: 1002,
      events: [{
        type: "llm_call",
        timestamp: 1001.5,
        input_messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "How are you?" },
        ],
        output_content: [{ type: "text", text: "Good" }],
        stop_reason: "end_turn",
        input_tokens: 15,
        output_tokens: 3,
      }],
    };

    const r1 = cli._generateTurnLogRecords(turn1, 0, sessionId, model, INITIAL_HASH, null);
    const r2 = cli._generateTurnLogRecords(turn2, 1, sessionId, model, r1.hash, null);

    const hash1 = r1.records.find(r => r["event.name"] === "llm.request" && r["message.role"] === "assistant")["input.messages_hash"];
    const hash2 = r2.records.find(r => r["event.name"] === "llm.request" && r["message.role"] === "assistant")["input.messages_hash"];

    expect(hash1).not.toBe(hash2);
    expect(hash1).toHaveLength(32);
    expect(hash2).toHaveLength(32);
  });

  test("first LLM call with matching hash does not log full input.messages", () => {
    const turn = {
      prompt: "test",
      startTime: 1000,
      endTime: 1001,
      events: [{
        type: "llm_call",
        timestamp: 1000.5,
        input_messages: [{ role: "user", content: "test" }],
        output_content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        input_tokens: 3,
        output_tokens: 1,
      }],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, null);
    const reqRec = records.find(r => r["event.name"] === "llm.request" && r["message.role"] === "assistant");
    expect(reqRec["input.messages"]).toBeUndefined();
    expect(reqRec["input.messages_delta"]).toBeDefined();
  });

  test("logs full input.messages when hash mismatches (context change)", () => {
    const turn = {
      prompt: "test",
      startTime: 1000,
      endTime: 1001,
      events: [{
        type: "llm_call",
        timestamp: 1000.5,
        input_messages: [{ role: "user", content: "test" }],
        output_content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        input_tokens: 3,
        output_tokens: 1,
      }],
    };
    const wrongPrevHash = "f".repeat(32);
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, wrongPrevHash, null);
    const reqRec = records.find(r => r["event.name"] === "llm.request" && r["message.role"] === "assistant");
    expect(reqRec["input.messages"]).toBeDefined();
    expect(reqRec["input.messages_delta"]).toBeDefined();
  });

  test("no prompt — no user llm.request generated", () => {
    const turn = {
      prompt: null,
      startTime: 1000,
      endTime: 1001,
      events: [{
        type: "llm_call",
        timestamp: 1000.5,
        input_messages: [{ role: "user", content: "something" }],
        output_content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        input_tokens: 3,
        output_tokens: 1,
      }],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, null);
    expect(records.filter(r => r["message.role"] === "user")).toHaveLength(0);
    // llm.request (assistant) + llm.response
    expect(records.filter(r => r["message.role"] === "assistant")).toHaveLength(2);
  });

  test("tool error sets is_error and error fields on tool.result", () => {
    const turn = {
      prompt: null,
      startTime: 1000,
      endTime: 1002,
      events: [
        { type: "pre_tool_use", timestamp: 1000.5, tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: "e1" },
        { type: "post_tool_use", timestamp: 1001.5, tool_name: "Bash", tool_response: { isError: true, error: "Permission denied" }, tool_use_id: "e1" },
      ],
    };
    const { records } = cli._generateTurnLogRecords(turn, 0, sessionId, model, INITIAL_HASH, null);
    const resultRec = records.find(r => r["event.name"] === "tool.result");
    expect(resultRec["tool.result.status"]).toBe("error");
    expect(resultRec["is_error"]).toBe(true);
    expect(resultRec["error.message"]).toContain("Permission denied");
    expect(resultRec["tool.result.duration_ms"]).toBe(1000);
  });
});

// ─── maybeSaveTranscriptPath ────────────────────────────────────────────────
describe("maybeSaveTranscriptPath", () => {
  test("sets transcript_path when state has none and event has one", () => {
    const state = { transcript_path: null };
    const event = { transcript_path: "/path/to/transcript.jsonl" };
    cli._maybeSaveTranscriptPath(state, event);
    expect(state.transcript_path).toBe("/path/to/transcript.jsonl");
  });

  test("does not overwrite existing transcript_path", () => {
    const state = { transcript_path: "/existing/path.jsonl" };
    const event = { transcript_path: "/new/path.jsonl" };
    cli._maybeSaveTranscriptPath(state, event);
    expect(state.transcript_path).toBe("/existing/path.jsonl");
  });

  test("no-op when event has no transcript_path", () => {
    const state = { transcript_path: null };
    const event = { session_id: "test" };
    cli._maybeSaveTranscriptPath(state, event);
    expect(state.transcript_path).toBeNull();
  });
});

// ─── exportSessionTrace transcript integration ──────────────────────────────
describe("exportSessionTrace with transcript", () => {
  test("uses transcript when state has transcript_path", async () => {
    const sessionId = "transcript-export-" + Date.now();
    const state = stateModule.loadState(sessionId);
    state.start_time = 1000;
    state.prompt = "test prompt";
    state.model = "claude-opus-4-6";
    state.transcript_path = path.join(TMP_STATE, "fake-transcript.jsonl");

    // Write a minimal transcript file
    const records = [
      { type: "user", message: { content: "hello" } },
      {
        type: "assistant",
        message: {
          id: "msg_t1",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: "text", text: "Hi there!" }],
        },
      },
    ];
    fs.writeFileSync(state.transcript_path, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    state.events = [
      { type: "user_prompt_submit", timestamp: 1000, prompt: "hello" },
    ];
    stateModule.saveState(sessionId, state);

    await cli._exportSessionTrace(state, "end_turn");

    // Verify the SDK handler was called (entry + llm spans)
    expect(mockHandlerInstance.startEntry).toHaveBeenCalled();
    expect(mockHandlerInstance.startLlm).toHaveBeenCalled();

    stateModule.clearState(sessionId);
    try { fs.unlinkSync(state.transcript_path); } catch {}
  });

  test("does not crash when transcript parse fails", async () => {
    const sessionId = "transcript-error-" + Date.now();
    const state = stateModule.loadState(sessionId);
    state.start_time = 1000;
    state.prompt = "test";
    state.model = "test-model";
    state.transcript_path = "/nonexistent/path/transcript.jsonl";
    state.events = [
      { type: "user_prompt_submit", timestamp: 1000, prompt: "test" },
    ];
    stateModule.saveState(sessionId, state);

    // Should not throw
    await expect(cli._exportSessionTrace(state, "end_turn")).resolves.not.toThrow();

    stateModule.clearState(sessionId);
  });

  test("falls back gracefully when no transcript_path", async () => {
    const sessionId = "no-transcript-" + Date.now();
    const state = stateModule.loadState(sessionId);
    state.start_time = 1000;
    state.prompt = "test";
    state.model = "test-model";
    state.transcript_path = null;
    state.events = [
      { type: "user_prompt_submit", timestamp: 1000, prompt: "test" },
    ];
    stateModule.saveState(sessionId, state);

    await expect(cli._exportSessionTrace(state, "end_turn")).resolves.not.toThrow();
    expect(mockHandlerInstance.startEntry).toHaveBeenCalled();

    stateModule.clearState(sessionId);
  });
});
