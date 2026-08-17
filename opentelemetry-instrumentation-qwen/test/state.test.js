// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

jest.mock("fs");
jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, homedir: jest.fn(() => "/mock/home") };
});

const { loadState, saveState, clearState, stateFile, sanitizeSessionId, readAndDeleteChildState, appendEvent, loadEvents, deleteEvents, eventsFile, STATE_DIR } = require("../src/state");

describe("state.js", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync.mockImplementation(() => {});
  });

  describe("sanitizeSessionId", () => {
    it("strips path traversal", () => {
      expect(sanitizeSessionId("../../etc/passwd")).toBe("passwd");
    });

    it("replaces special characters", () => {
      expect(sanitizeSessionId("abc!@#$%def")).toBe("abc_____def");
    });

    it("preserves hyphens and underscores", () => {
      expect(sanitizeSessionId("session-123_abc")).toBe("session-123_abc");
    });

    it("returns 'unknown' for empty string", () => {
      expect(sanitizeSessionId("")).toBe("unknown");
    });
  });

  describe("stateFile", () => {
    it("returns path under STATE_DIR", () => {
      const sf = stateFile("test-session");
      expect(sf).toContain("test-session.json");
      expect(sf).toContain("opentelemetry.instrumentation.qwen");
    });
  });

  describe("loadState", () => {
    it("returns default state when no file exists", () => {
      fs.existsSync.mockReturnValue(false);
      const state = loadState("new-session");
      expect(state.session_id).toBe("new-session");
      expect(state.metrics.input_tokens).toBe(0);
      expect(state.events).toEqual([]);
    });

    it("loads existing state from file", () => {
      const mockState = {
        session_id: "existing-session",
        start_time: 1700000000,
        prompt: "test prompt",
        model: "qwen-max",
        metrics: { input_tokens: 100, output_tokens: 50, tools_used: 2, turns: 1 },
        tools_used: ["Read", "Write"],
        events: [{ type: "user_prompt_submit", timestamp: 1700000000, prompt: "test" }],
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(mockState));

      const state = loadState("existing-session");
      expect(state.session_id).toBe("existing-session");
      expect(state.model).toBe("qwen-max");
      expect(state.events).toHaveLength(1);
    });

    it("returns default state when file is corrupted", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("not valid json {{{");

      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const state = loadState("corrupted-session");
      expect(state.session_id).toBe("corrupted-session");
      expect(state.events).toEqual([]);
      consoleSpy.mockRestore();
    });
  });

  describe("saveState", () => {
    it("writes atomically via temp file", () => {
      const state = { session_id: "save-test", events: [] };
      fs.writeFileSync.mockImplementation(() => {});
      fs.renameSync.mockImplementation(() => {});

      saveState("save-test", state);

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
      const tmpPath = fs.writeFileSync.mock.calls[0][0];
      expect(tmpPath).toContain(".tmp");
    });

    it("cleans up temp file on write error", () => {
      const state = { session_id: "fail-test" };
      fs.writeFileSync.mockImplementation(() => { throw new Error("disk full"); });
      fs.unlinkSync.mockImplementation(() => {});

      expect(() => saveState("fail-test", state)).toThrow("disk full");
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  describe("clearState", () => {
    it("deletes state file if it exists", () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {});

      clearState("clear-test");
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it("does nothing if file does not exist", () => {
      fs.existsSync.mockReturnValue(false);
      clearState("nonexistent");
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe("readAndDeleteChildState", () => {
    it("reads and deletes child state file", () => {
      const childState = { session_id: "child-1", events: [{ type: "pre_tool_use" }] };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(childState));
      fs.unlinkSync.mockImplementation(() => {});

      const result = readAndDeleteChildState("child-1");
      expect(result.session_id).toBe("child-1");
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it("returns null if no child state file", () => {
      fs.existsSync.mockReturnValue(false);
      const result = readAndDeleteChildState("missing-child");
      expect(result).toBeNull();
    });
  });

  describe("eventsFile", () => {
    it("returns JSONL path under STATE_DIR", () => {
      const ef = eventsFile("test-session");
      expect(ef).toContain("test-session.events.jsonl");
      expect(ef).toContain("opentelemetry.instrumentation.qwen");
    });
  });

  describe("appendEvent / loadEvents / deleteEvents", () => {
    it("appendEvent writes a JSON line", () => {
      fs.appendFileSync.mockImplementation(() => {});
      appendEvent("sess-1", { type: "pre_tool_use", timestamp: 1 });
      expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
      const written = fs.appendFileSync.mock.calls[0][1];
      expect(written).toContain('"type":"pre_tool_use"');
      expect(written.endsWith("\n")).toBe(true);
    });

    it("loadEvents parses JSONL file", () => {
      const lines = [
        JSON.stringify({ type: "a", timestamp: 1 }),
        JSON.stringify({ type: "b", timestamp: 2 }),
        "",
      ].join("\n");
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(lines);

      const events = loadEvents("sess-1");
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("a");
      expect(events[1].type).toBe("b");
    });

    it("loadEvents returns [] when file does not exist", () => {
      fs.existsSync.mockReturnValue(false);
      expect(loadEvents("missing")).toEqual([]);
    });

    it("loadEvents skips corrupted lines", () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{"type":"ok"}\nnot-json\n{"type":"ok2"}\n');
      const events = loadEvents("sess-1");
      expect(events).toHaveLength(2);
    });

    it("deleteEvents removes the JSONL file", () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {});
      deleteEvents("sess-1");
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it("deleteEvents is safe when file does not exist", () => {
      fs.existsSync.mockReturnValue(false);
      deleteEvents("missing");
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
