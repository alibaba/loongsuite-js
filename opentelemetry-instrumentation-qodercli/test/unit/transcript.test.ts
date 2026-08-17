import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseTranscript,
  getTranscriptPath,
  slugifyCwd,
} from "../../src/transcript.js";

function tmpFile(content: string): string {
  const p = path.join(
    os.tmpdir(),
    `qodercli-transcript-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  fs.writeFileSync(p, content);
  return p;
}

describe("transcript.slugifyCwd", () => {
  it("replaces slashes with hyphens", () => {
    expect(slugifyCwd("/Users/alice/proj/a")).toBe("-Users-alice-proj-a");
  });
});

describe("transcript.getTranscriptPath", () => {
  it("composes path from session id + cwd", () => {
    const p = getTranscriptPath("sid-1", "/Users/u/p");
    expect(p.endsWith(".jsonl")).toBe(true);
    expect(p.includes(".qoder/projects/-Users-u-p")).toBe(true);
    expect(p.endsWith("sid-1.jsonl")).toBe(true);
  });
});

describe("transcript.parseTranscript", () => {
  it("returns empty data for missing file", () => {
    const t = parseTranscript("/no/such/path.jsonl");
    expect(t.tokenEvents).toEqual([]);
    expect(t.totalUsage.totalTokens).toBe(0);
  });

  it("merges multi-chunk assistant responses sharing message.id", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-05-15T00:00:00Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-05-15T00:00:01Z",
        message: {
          id: "msg-1",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          content: [{ type: "thinking", thinking: "reasoning..." }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-05-15T00:00:02Z",
        message: {
          id: "msg-1",
          role: "assistant",
          model: "claude-test",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 25,
          },
          content: [{ type: "text", text: "hi back" }],
        },
      }),
    ].join("\n");
    const f = tmpFile(lines);
    try {
      const t = parseTranscript(f);
      expect(t.tokenEvents).toHaveLength(1);
      const ev = t.tokenEvents[0]!;
      expect(ev.messageId).toBe("msg-1");
      expect(ev.inputTokens).toBe(100);
      expect(ev.outputTokens).toBe(50);
      expect(ev.cacheReadInputTokens).toBe(25);
      expect(ev.providerName).toBe("anthropic");
      expect(ev.outputMessages[0]!.parts.length).toBeGreaterThanOrEqual(2);
      expect(t.totalUsage.totalTokens).toBe(150);
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("pairs tool_use with tool_result via tool_use_id", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-05-15T00:00:00Z",
        message: { role: "user", content: "ls" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-05-15T00:00:01Z",
        message: {
          id: "msg-2",
          role: "assistant",
          model: "claude-test",
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              id: "toolu_x",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        timestamp: "2026-05-15T00:00:02Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_x",
              content: "file1\nfile2",
              is_error: false,
            },
          ],
        },
      }),
    ].join("\n");
    const f = tmpFile(lines);
    try {
      const t = parseTranscript(f);
      expect(t.toolCalls).toHaveLength(1);
      const tc = t.toolCalls[0]!;
      expect(tc.toolUseId).toBe("toolu_x");
      expect(tc.toolName).toBe("Bash");
      expect(tc.toolResponse).toBe("file1\nfile2");
      expect(tc.isError).toBe(false);
    } finally {
      fs.unlinkSync(f);
    }
  });

  it("recovers from malformed JSONL lines", () => {
    const lines = [
      "not-json",
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T00:00:01Z",
        message: { id: "m", role: "assistant", model: "x" },
      }),
    ].join("\n");
    const f = tmpFile(lines);
    try {
      const t = parseTranscript(f);
      expect(t.tokenEvents).toHaveLength(1);
    } finally {
      fs.unlinkSync(f);
    }
  });
});
