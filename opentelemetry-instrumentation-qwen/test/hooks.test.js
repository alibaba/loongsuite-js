// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const {
  createToolTitle,
  createEventData,
  addResponseToEventData,
  truncateForDisplay,
  smartTruncateValue,
} = require("../src/hooks");

describe("hooks.js", () => {
  describe("createToolTitle", () => {
    it("returns tool name when no input", () => {
      expect(createToolTitle("Read")).toBe("Read");
    });

    it("returns tool name when input is empty object", () => {
      expect(createToolTitle("Write", {})).toBe("Write");
    });

    it("includes string params in title", () => {
      const title = createToolTitle("Read", { file_path: "/src/index.js" });
      expect(title).toContain("Read");
      expect(title).toContain("/src/index.js");
    });

    it("includes boolean and number params", () => {
      const title = createToolTitle("Shell", { command: "ls", timeout: 30 });
      expect(title).toContain("Shell");
      expect(title).toContain("ls");
    });

    it("limits to 3 summary parts", () => {
      const title = createToolTitle("Tool", {
        a: "1", b: "2", c: "3", d: "4",
      });
      expect(title.split(",").length).toBeLessThanOrEqual(3);
    });
  });

  describe("createEventData", () => {
    it("returns basic data for tool name only", () => {
      const data = createEventData("Read");
      expect(data["gen_ai.tool.name"]).toBe("Read");
    });

    it("includes input fields", () => {
      const data = createEventData("Write", { file_path: "/test.js", content: "hello" });
      expect(data["gen_ai.tool.name"]).toBe("Write");
      expect(data["input.file_path"]).toBe("/test.js");
      expect(data["input.content"]).toBe("hello");
    });

    it("includes gen_ai.tool.call.arguments as JSON string", () => {
      const data = createEventData("Shell", { command: "ls -la" });
      expect(data["gen_ai.tool.call.arguments"]).toBe('{"command":"ls -la"}');
    });

    it("includes gen_ai.tool.call.arguments for complex input", () => {
      const data = createEventData("Write", { file_path: "/test.js", content: "hello" });
      const parsed = JSON.parse(data["gen_ai.tool.call.arguments"]);
      expect(parsed.file_path).toBe("/test.js");
      expect(parsed.content).toBe("hello");
    });
  });

  describe("addResponseToEventData", () => {
    it("handles null response", () => {
      const data = {};
      addResponseToEventData(data, null);
      expect(data.status).toBe("success");
      expect(data["gen_ai.tool.call.result"]).toBe("null");
    });

    it("handles string response", () => {
      const data = {};
      addResponseToEventData(data, "file contents here");
      expect(data.status).toBe("success");
      expect(data["gen_ai.tool.call.result"]).toBe("file contents here");
    });

    it("handles object response as JSON string", () => {
      const data = {};
      addResponseToEventData(data, { result: "success", count: 42 });
      expect(data.status).toBe("success");
      const parsed = JSON.parse(data["gen_ai.tool.call.result"]);
      expect(parsed.result).toBe("success");
      expect(parsed.count).toBe(42);
    });

    it("handles error response with status error", () => {
      const data = {};
      addResponseToEventData(data, { error: "File not found" });
      expect(data.status).toBe("error");
      const parsed = JSON.parse(data["gen_ai.tool.call.result"]);
      expect(parsed.error).toBe("File not found");
    });

    it("handles isError response", () => {
      const data = {};
      addResponseToEventData(data, { isError: true, error: "Permission denied" });
      expect(data.status).toBe("error");
    });

    it("handles array response as JSON string", () => {
      const data = {};
      addResponseToEventData(data, ["a", "b", "c"]);
      expect(data.status).toBe("success");
      const parsed = JSON.parse(data["gen_ai.tool.call.result"]);
      expect(parsed).toEqual(["a", "b", "c"]);
    });

    it("handles object with llmContent and returnDisplay as JSON", () => {
      const data = {};
      addResponseToEventData(data, { llmContent: "No files found", returnDisplay: "No files found" });
      expect(data.status).toBe("success");
      const parsed = JSON.parse(data["gen_ai.tool.call.result"]);
      expect(parsed.llmContent).toBe("No files found");
      expect(parsed.returnDisplay).toBe("No files found");
    });
  });

  describe("truncateForDisplay", () => {
    it("returns short text unchanged", () => {
      expect(truncateForDisplay("hello")).toBe("hello");
    });

    it("truncates long text", () => {
      const long = "x".repeat(2 * 1024 * 1024);
      const result = truncateForDisplay(long);
      expect(result.length).toBeLessThan(long.length);
      expect(result).toMatch(/\.\.\.$/);
    });
  });

  describe("smartTruncateValue", () => {
    it("handles strings", () => {
      expect(smartTruncateValue("hello", 100)).toBe("hello");
    });

    it("handles empty array", () => {
      expect(smartTruncateValue([], 100)).toBe("[]");
    });

    it("handles empty object", () => {
      expect(smartTruncateValue({}, 100)).toBe("{}");
    });

    it("handles numbers", () => {
      expect(smartTruncateValue(42, 100)).toBe("42");
    });
  });
});
