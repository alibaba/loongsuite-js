import { describe, expect, it } from "vitest";
import {
  HOOK_EVENT_NAMES,
  MAX_CONTENT_LENGTH,
  createEventData,
  createToolTitle,
  truncate,
} from "../../src/hooks.js";

describe("hooks.createToolTitle", () => {
  it("builds Bash: <command> title", () => {
    expect(createToolTitle("Bash", { command: "ls -la" })).toBe("Bash: ls -la");
  });
  it("falls back to tool name without obvious field", () => {
    expect(createToolTitle("Read", { file_path: "/foo/bar.ts" })).toContain(
      "Read",
    );
  });
  it("truncates very long inputs", () => {
    const long = "x".repeat(200);
    const title = createToolTitle("Bash", { command: long });
    expect(title.length).toBeLessThan(120);
    expect(title.endsWith("...")).toBe(true);
  });
});

describe("hooks.truncate", () => {
  it("returns input unchanged when short", () => {
    expect(truncate("hi")).toBe("hi");
  });
  it("appends marker when truncating", () => {
    const big = "y".repeat(MAX_CONTENT_LENGTH + 10);
    const t = truncate(big);
    expect(t.length).toBe(MAX_CONTENT_LENGTH);
    expect(t.endsWith("[truncated]")).toBe(true);
  });
});

describe("hooks.createEventData", () => {
  it("maps SessionStart", () => {
    const ev = createEventData("SessionStart", { source: "startup" });
    expect(ev?.type).toBe("session_start");
  });
  it("maps PreToolUse with tool_name and tool_use_id", () => {
    const ev = createEventData("PreToolUse", {
      tool_name: "Bash",
      tool_use_id: "tu1",
      tool_input: { command: "ls" },
    });
    expect(ev?.type).toBe("pre_tool_use");
    if (ev?.type === "pre_tool_use") {
      expect(ev.toolName).toBe("Bash");
      expect(ev.toolUseId).toBe("tu1");
    }
  });
  it("returns null for unknown event", () => {
    expect(createEventData("UnknownEvent", {})).toBeNull();
  });
});

describe("HOOK_EVENT_NAMES", () => {
  it("covers all 11 documented qodercli events", () => {
    expect(HOOK_EVENT_NAMES).toHaveLength(11);
    const names = HOOK_EVENT_NAMES.map((h) => h.event);
    expect(names).toContain("SessionStart");
    expect(names).toContain("UserPromptSubmit");
    expect(names).toContain("Stop");
    expect(names).toContain("SessionEnd");
  });
});
