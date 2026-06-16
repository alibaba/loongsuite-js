// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  parseClaudeTranscript,
  alignWithHookEvents,
  deduplicateContentBlocks,
  MAX_TRANSCRIPT_BYTES,
} = require("../src/transcript");

const TMP_DIR = path.join(os.tmpdir(), `otel-transcript-test-${process.pid}`);

beforeAll(() => fs.mkdirSync(TMP_DIR, { recursive: true }));
afterAll(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} });

function tmpFile(name) { return path.join(TMP_DIR, name); }

function writeJsonl(name, records) {
  const p = tmpFile(name);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return p;
}

// ─── parseClaudeTranscript ──────────────────────────────────────────────────
describe("parseClaudeTranscript", () => {
  test("returns [] for null path", () => {
    expect(parseClaudeTranscript(null, 0, 100)).toEqual([]);
  });

  test("returns [] for nonexistent file", () => {
    expect(parseClaudeTranscript("/no/such/file.jsonl", 0, 100)).toEqual([]);
  });

  test("returns [] for empty file", () => {
    const p = tmpFile("empty.jsonl");
    fs.writeFileSync(p, "", "utf-8");
    const result = parseClaudeTranscript(p, 0, 100);
    expect(result).toHaveLength(0);
  });

  test("parses single LLM call (1 user + 1 assistant)", () => {
    const p = writeJsonl("single.jsonl", [
      { type: "user", message: { content: "hello" } },
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
          content: [{ type: "text", text: "Hello! How can I help?" }],
        },
      },
    ]);

    const events = parseClaudeTranscript(p, 100, 200);
    expect(events).toHaveLength(1);

    const ev = events[0];
    expect(ev.type).toBe("llm_call");
    expect(ev.protocol).toBe("anthropic");
    expect(ev.model).toBe("claude-opus-4-6");
    expect(ev.stop_reason).toBe("end_turn");
    expect(ev.input_tokens).toBe(50);
    expect(ev.output_tokens).toBe(20);
    expect(ev.cache_read_input_tokens).toBe(10);
    expect(ev.cache_creation_input_tokens).toBe(5);
    expect(ev.output_content).toEqual([{ type: "text", text: "Hello! How can I help?" }]);
    expect(ev.input_messages).toHaveLength(1);
    expect(ev.input_messages[0]).toEqual({ role: "user", content: "hello" });
    expect(ev.timestamp).toBeGreaterThan(100);
    expect(ev.timestamp).toBeLessThan(200);
  });

  test("parses multi-step ReAct (2 LLM calls with cumulative input_messages)", () => {
    const p = writeJsonl("react.jsonl", [
      { type: "user", message: { content: "list files" } },
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 30 },
          content: [
            { type: "text", text: "I'll list the files." },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1.txt\nfile2.txt" }] },
      },
      {
        type: "assistant",
        message: {
          id: "msg_002",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 40 },
          content: [{ type: "text", text: "Here are the files: file1.txt, file2.txt" }],
        },
      },
    ]);

    const events = parseClaudeTranscript(p, 100, 200);
    expect(events).toHaveLength(2);

    // First LLM call — delta contains initial user message
    expect(events[0]._input_is_delta).toBe(true);
    expect(events[0].input_messages).toHaveLength(1);
    expect(events[0].input_messages[0].role).toBe("user");
    expect(events[0].input_tokens).toBe(100);
    expect(events[0].stop_reason).toBe("tool_use");

    // Second LLM call — delta only (tool_result from user)
    expect(events[1]._input_is_delta).toBe(true);
    expect(events[1].input_messages).toHaveLength(1);
    expect(events[1].input_messages[0].role).toBe("user");
    expect(events[1].input_tokens).toBe(200);
    expect(events[1].stop_reason).toBe("end_turn");
  });

  test("deduplicates streaming chunks with same message.id", () => {
    const p = writeJsonl("streaming.jsonl", [
      { type: "user", message: { content: "hello" } },
      // Chunk 1: thinking block
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          usage: { input_tokens: 50, output_tokens: 20 },
          content: [{ type: "thinking", thinking: "Let me think..." }],
        },
      },
      // Chunk 2: text block (partial)
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          usage: { input_tokens: 50, output_tokens: 20 },
          content: [{ type: "text", text: "Hi" }],
        },
      },
      // Chunk 3: text block (full, longer)
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 20 },
          content: [{ type: "text", text: "Hi there! How can I help?" }],
        },
      },
    ]);

    const events = parseClaudeTranscript(p, 0, 100);
    expect(events).toHaveLength(1);

    const ev = events[0];
    // Should have thinking + text (deduplicated, longest text kept)
    expect(ev.output_content).toHaveLength(2);
    expect(ev.output_content[0].type).toBe("thinking");
    expect(ev.output_content[1].type).toBe("text");
    expect(ev.output_content[1].text).toBe("Hi there! How can I help?");
  });

  test("ignores non-user/assistant record types", () => {
    const p = writeJsonl("mixed-types.jsonl", [
      { type: "permission-mode", content: { mode: "auto" } },
      { type: "user", message: { content: "hi" } },
      { type: "attachment", attachment: { path: "/tmp/file" } },
      { type: "last-prompt", prompt: "something" },
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "hello" }],
        },
      },
      { type: "system", message: { content: "system msg" } },
    ]);

    const events = parseClaudeTranscript(p, 0, 100);
    expect(events).toHaveLength(1);
    expect(events[0].input_messages).toHaveLength(1);
  });

  test("assigns timestamps evenly distributed between startTime and stopTime", () => {
    const records = [{ type: "user", message: { content: "hi" } }];
    for (let i = 1; i <= 4; i++) {
      records.push({
        type: "assistant",
        message: {
          id: `msg_${i}`,
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: `response ${i}` }],
        },
      });
      if (i < 4) {
        records.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }] } });
      }
    }

    const p = writeJsonl("timestamps.jsonl", records);
    const events = parseClaudeTranscript(p, 100, 200);
    expect(events).toHaveLength(4);

    // Timestamps should be strictly increasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThan(events[i - 1].timestamp);
    }
    // All within bounds
    for (const ev of events) {
      expect(ev.timestamp).toBeGreaterThan(100);
      expect(ev.timestamp).toBeLessThan(200);
      expect(ev.request_start_time).toBeLessThan(ev.timestamp);
    }
  });

  test("handles malformed JSON lines gracefully", () => {
    const p = tmpFile("malformed.jsonl");
    fs.writeFileSync(p, [
      '{"type":"user","message":{"content":"hi"}}',
      'NOT_JSON{{{',
      '',
      '{"type":"assistant","message":{"id":"m1","model":"test","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"text","text":"ok"}]}}',
    ].join("\n"), "utf-8");

    const events = parseClaudeTranscript(p, 0, 100);
    expect(events).toHaveLength(1);
  });

  test("reads tail of file exceeding MAX_TRANSCRIPT_BYTES instead of skipping", () => {
    const p = tmpFile("huge.jsonl");
    // Fill with padding lines to exceed the limit
    const paddingLine = JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } }) + "\n";
    const fd = fs.openSync(p, "w");
    const targetSize = MAX_TRANSCRIPT_BYTES + 1024;
    let written = 0;
    while (written < targetSize) {
      fs.writeSync(fd, paddingLine);
      written += Buffer.byteLength(paddingLine);
    }
    // Append a real assistant record at the very end (within the tail window)
    const tailRecord = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_tail",
        model: "tail-model",
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
        content: [{ type: "text", text: "from tail" }],
      },
    }) + "\n";
    fs.writeSync(fd, tailRecord);
    fs.closeSync(fd);

    const events = parseClaudeTranscript(p, 0, 100);
    // Should find the tail record (not return [])
    expect(events.length).toBeGreaterThan(0);
    const tailEvent = events.find(e => e.model === "tail-model");
    expect(tailEvent).toBeDefined();
    expect(tailEvent.output_content[0].text).toBe("from tail");
  });

  test("handles assistant record without message.id gracefully", () => {
    const p = writeJsonl("no-id.jsonl", [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    ]);
    const events = parseClaudeTranscript(p, 0, 100);
    expect(events).toHaveLength(0);
  });

  test("handles missing usage gracefully", () => {
    const p = writeJsonl("no-usage.jsonl", [
      { type: "user", message: { content: "hi" } },
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);
    const events = parseClaudeTranscript(p, 0, 100);
    expect(events).toHaveLength(1);
    expect(events[0].input_tokens).toBe(0);
    expect(events[0].output_tokens).toBe(0);
  });
});

// ─── incremental reading (byteOffset) ─────────────────────────────────────
describe("parseClaudeTranscript incremental reading", () => {
  test("returns nextOffset on first full read", () => {
    const p = writeJsonl("offset-first.jsonl", [
      { type: "user", message: { content: "hello" } },
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "Hi!" }],
        },
      },
    ]);

    const events = parseClaudeTranscript(p, 100, 200);
    expect(events).toHaveLength(1);
    expect(typeof events.nextOffset).toBe("number");
    expect(events.nextOffset).toBeGreaterThan(0);
  });

  test("incremental read only returns new turn data", () => {
    const p = tmpFile("offset-incremental.jsonl");

    // Write Turn 1
    const turn1Records = [
      { type: "user", message: { content: "question one" } },
      {
        type: "assistant",
        message: {
          id: "msg_t1",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "answer one" }],
        },
      },
    ];
    fs.writeFileSync(p, turn1Records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    // Parse Turn 1 (full read)
    const events1 = parseClaudeTranscript(p, 100, 200);
    expect(events1).toHaveLength(1);
    expect(events1[0].input_messages[0].content).toBe("question one");
    expect(events1[0].output_content[0].text).toBe("answer one");
    const offset1 = events1.nextOffset;
    expect(offset1).toBeGreaterThan(0);

    // Append Turn 2
    const turn2Records = [
      { type: "user", message: { content: "question two" } },
      {
        type: "assistant",
        message: {
          id: "msg_t2",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 10 },
          content: [{ type: "text", text: "answer two" }],
        },
      },
    ];
    fs.appendFileSync(p, turn2Records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    // Parse Turn 2 (incremental from offset)
    const events2 = parseClaudeTranscript(p, 200, 300, offset1);
    expect(events2).toHaveLength(1);
    expect(events2[0].input_messages[0].content).toBe("question two");
    expect(events2[0].output_content[0].text).toBe("answer two");
    expect(events2[0].input_tokens).toBe(20);
    expect(events2.nextOffset).toBeGreaterThan(offset1);
  });

  test("returns empty array when offset equals file size (no new data)", () => {
    const p = writeJsonl("offset-noop.jsonl", [
      { type: "user", message: { content: "hi" } },
      {
        type: "assistant",
        message: {
          id: "msg_001",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "hello" }],
        },
      },
    ]);

    const events1 = parseClaudeTranscript(p, 0, 100);
    const offset = events1.nextOffset;

    // No new data — should return empty
    const events2 = parseClaudeTranscript(p, 100, 200, offset);
    expect(events2).toHaveLength(0);
    expect(events2.nextOffset).toBe(offset);
  });

  test("three consecutive incremental reads return correct per-turn data", () => {
    const p = tmpFile("offset-three-turns.jsonl");

    // Turn 1
    fs.writeFileSync(p,
      JSON.stringify({ type: "user", message: { content: "who are you" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1", model: "claude-opus-4-6", stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "I am Claude" }],
        },
      }) + "\n",
      "utf-8"
    );

    const e1 = parseClaudeTranscript(p, 100, 110);
    expect(e1).toHaveLength(1);
    expect(e1[0].output_content[0].text).toBe("I am Claude");
    const off1 = e1.nextOffset;

    // Turn 2
    fs.appendFileSync(p,
      JSON.stringify({ type: "user", message: { content: "what model" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_2", model: "claude-opus-4-6", stop_reason: "end_turn",
          usage: { input_tokens: 15, output_tokens: 8 },
          content: [{ type: "text", text: "I use Opus" }],
        },
      }) + "\n",
      "utf-8"
    );

    const e2 = parseClaudeTranscript(p, 110, 120, off1);
    expect(e2).toHaveLength(1);
    expect(e2[0].input_messages[0].content).toBe("what model");
    expect(e2[0].output_content[0].text).toBe("I use Opus");
    const off2 = e2.nextOffset;

    // Turn 3
    fs.appendFileSync(p,
      JSON.stringify({ type: "user", message: { content: "what can you do" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_3", model: "claude-opus-4-6", stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 12 },
          content: [{ type: "text", text: "I can help with code" }],
        },
      }) + "\n",
      "utf-8"
    );

    const e3 = parseClaudeTranscript(p, 120, 130, off2);
    expect(e3).toHaveLength(1);
    expect(e3[0].input_messages[0].content).toBe("what can you do");
    expect(e3[0].output_content[0].text).toBe("I can help with code");
    expect(e3.nextOffset).toBeGreaterThan(off2);
  });

  test("byteOffset=0 reads entire file (backward compatible)", () => {
    const p = tmpFile("offset-compat.jsonl");
    fs.writeFileSync(p,
      JSON.stringify({ type: "user", message: { content: "q1" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_a", model: "test", stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "a1" }],
        },
      }) + "\n" +
      JSON.stringify({ type: "user", message: { content: "q2" } }) + "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_b", model: "test", stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 2 },
          content: [{ type: "text", text: "a2" }],
        },
      }) + "\n",
      "utf-8"
    );

    // byteOffset=0 (default) reads everything
    const events = parseClaudeTranscript(p, 0, 100, 0);
    expect(events).toHaveLength(2);
    expect(events[0].output_content[0].text).toBe("a1");
    expect(events[1].output_content[0].text).toBe("a2");
  });
});

// ─── deduplicateContentBlocks ───────────────────────────────────────────────
describe("deduplicateContentBlocks", () => {
  test("returns [] for empty input", () => {
    expect(deduplicateContentBlocks([])).toEqual([]);
    expect(deduplicateContentBlocks(null)).toEqual([]);
  });

  test("keeps longest text block from multiple", () => {
    const result = deduplicateContentBlocks([
      { type: "text", text: "hi" },
      { type: "text", text: "hello world" },
      { type: "text", text: "hey" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello world");
  });

  test("keeps longest thinking block from multiple", () => {
    const result = deduplicateContentBlocks([
      { type: "thinking", thinking: "short" },
      { type: "thinking", thinking: "longer thinking content" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].thinking).toBe("longer thinking content");
  });

  test("deduplicates tool_use by id", () => {
    const result = deduplicateContentBlocks([
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "tu_2", name: "Read", input: { path: "/tmp" } },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map(b => b.id)).toEqual(["tu_1", "tu_2"]);
  });

  test("keeps tool_use blocks without id", () => {
    const result = deduplicateContentBlocks([
      { type: "tool_use", name: "Bash", input: {} },
      { type: "tool_use", name: "Read", input: {} },
    ]);
    expect(result).toHaveLength(2);
  });

  test("orders: thinking → text → tool_use", () => {
    const result = deduplicateContentBlocks([
      { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
      { type: "text", text: "I'll help" },
      { type: "thinking", thinking: "Let me think" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("thinking");
    expect(result[1].type).toBe("text");
    expect(result[2].type).toBe("tool_use");
  });

  test("passes through other block types (e.g., image)", () => {
    const result = deduplicateContentBlocks([
      { type: "image", source: { data: "base64..." } },
      { type: "text", text: "hello" },
    ]);
    expect(result).toHaveLength(2);
    expect(result.find(b => b.type === "image")).toBeDefined();
  });

  test("skips blocks without type", () => {
    const result = deduplicateContentBlocks([
      null,
      { text: "no type" },
      { type: "text", text: "valid" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("valid");
  });
});

// ─── alignWithHookEvents ────────────────────────────────────────────────────
describe("alignWithHookEvents", () => {
  test("no-op for empty llmEvents", () => {
    const hookEvents = [{ type: "user_prompt_submit", timestamp: 100 }];
    alignWithHookEvents([], hookEvents, 200);
    // No crash
  });

  test("no-op for empty hookEvents", () => {
    const llmEvents = [
      { type: "llm_call", timestamp: 50, request_start_time: 40 },
    ];
    const origTs = llmEvents[0].timestamp;
    alignWithHookEvents(llmEvents, [], 200);
    expect(llmEvents[0].timestamp).toBe(origTs);
  });

  test("aligns llm_call timestamps with hook events", () => {
    const llmEvents = [
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
    ];
    const hookEvents = [
      { type: "user_prompt_submit", timestamp: 100 },
      { type: "pre_tool_use", timestamp: 110 },
      { type: "post_tool_use", timestamp: 115 },
    ];

    alignWithHookEvents(llmEvents, hookEvents, 200);

    // First llm_call: request_start = user_prompt_submit, timestamp = pre_tool_use
    expect(llmEvents[0].request_start_time).toBe(100);
    expect(llmEvents[0].timestamp).toBe(110);

    // Second llm_call (last): timestamp = stopTime
    expect(llmEvents[1].timestamp).toBe(200);
  });

  test("last llm_call uses stopTime when no more pre_tool hooks", () => {
    const llmEvents = [
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
    ];
    const hookEvents = [
      { type: "user_prompt_submit", timestamp: 100 },
      { type: "pre_tool_use", timestamp: 110 },
      { type: "post_tool_use", timestamp: 115 },
    ];

    alignWithHookEvents(llmEvents, hookEvents, 300);

    // Only 1 pre_tool anchor, so after first llm_call uses it, the rest get stopTime
    expect(llmEvents[2].timestamp).toBe(300);
  });

  test("PostToolUse dropped: next llm_call request_start_time >= prevEnd", () => {
    // Scenario: 3 llm_calls, 2 pre_tool_use, but only 1 post_tool_use
    // (last tool's PostToolUse is dropped — 30% drop rate)
    //
    // Expected timeline:
    //   user_prompt_submit(100) → llm#0 → pre_tool#0(110) → post_tool#0(115)
    //   → llm#1 → pre_tool#1(120) → [PostToolUse DROPPED]
    //   → llm#2 (should sort AFTER pre_tool#1)
    const llmEvents = [
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
    ];
    const hookEvents = [
      { type: "user_prompt_submit", timestamp: 100 },
      { type: "pre_tool_use", timestamp: 110 },
      { type: "post_tool_use", timestamp: 115 },
      { type: "pre_tool_use", timestamp: 120 },
      // no post_tool_use for second tool — dropped
    ];

    alignWithHookEvents(llmEvents, hookEvents, 200);

    // llm#1.timestamp should be pre_tool#1 = 120 (the second pre_tool anchor)
    expect(llmEvents[1].timestamp).toBe(120);

    // llm#2.request_start_time must be > llm#1.timestamp (120)
    // so that llm#2 sorts AFTER the orphan PreToolUse event at 120
    expect(llmEvents[2].request_start_time).toBeGreaterThan(llmEvents[1].timestamp);
  });

  test("corrects request_start_time >= timestamp", () => {
    const llmEvents = [
      { type: "llm_call", timestamp: 0, request_start_time: 0 },
    ];
    const hookEvents = [
      { type: "user_prompt_submit", timestamp: 200 },
    ];

    alignWithHookEvents(llmEvents, hookEvents, 150);

    // request_start_time (200) >= timestamp (150), should be corrected
    expect(llmEvents[0].request_start_time).toBeLessThan(llmEvents[0].timestamp);
  });
});

// ─── llm_call event format compatibility ────────────────────────────────────
describe("llm_call event format", () => {
  test("events have all required fields matching intercept.js format", () => {
    const p = writeJsonl("format-check.jsonl", [
      { type: "user", message: { content: "test" } },
      {
        type: "assistant",
        message: {
          id: "msg_fmt",
          model: "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
          content: [{ type: "text", text: "response" }],
        },
      },
    ]);

    const events = parseClaudeTranscript(p, 0, 100);
    const ev = events[0];

    // All required fields must exist and have correct types
    expect(ev.type).toBe("llm_call");
    expect(ev.protocol).toBe("anthropic");
    expect(typeof ev.model).toBe("string");
    expect(typeof ev.timestamp).toBe("number");
    expect(typeof ev.request_start_time).toBe("number");
    expect(Array.isArray(ev.input_messages)).toBe(true);
    expect(Array.isArray(ev.output_content)).toBe(true);
    expect(typeof ev.stop_reason).toBe("string");
    expect(typeof ev.input_tokens).toBe("number");
    expect(typeof ev.output_tokens).toBe("number");
    expect(typeof ev.cache_read_input_tokens).toBe("number");
    expect(typeof ev.cache_creation_input_tokens).toBe("number");
  });
});
