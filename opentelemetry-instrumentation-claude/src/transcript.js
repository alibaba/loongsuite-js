// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * transcript.js — Claude Code Transcript JSONL parser.
 *
 * Reads Claude Code's native session transcript (JSONL at
 * ~/.claude/projects/<hash>/<session-id>.jsonl) and extracts
 * llm_call events compatible with readProxyEvents() output format.
 *
 * Streaming chunks: Claude Code writes multiple assistant records per
 * LLM call sharing the same message.id. Each chunk contains one
 * content block. We group by id, merge content, deduplicate.
 */

const fs = require("fs");

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB safety limit

/**
 * Parse a Claude Code transcript JSONL file and return llm_call events.
 *
 * @param {string} transcriptPath - Path to the transcript JSONL file
 * @param {number} startTime - Session start time (epoch seconds, for timestamp assignment)
 * @param {number} stopTime - Session stop time (epoch seconds)
 * @param {number} [byteOffset=0] - Byte offset to start reading from (for incremental parsing across turns)
 * @returns {Array<Object>} Array of llm_call events, with `.nextOffset` property indicating the byte position for the next incremental read
 */
function parseClaudeTranscript(transcriptPath, startTime, stopTime, byteOffset = 0) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  let content;
  let fileSize;
  try {
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    if (byteOffset >= fileSize) {
      const empty = [];
      empty.nextOffset = byteOffset;
      return empty;
    }

    const readFrom = Math.max(byteOffset, 0);
    const readLen = fileSize - readFrom;

    if (readLen > MAX_TRANSCRIPT_BYTES) {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const tailOffset = fileSize - MAX_TRANSCRIPT_BYTES;
        const actualOffset = Math.max(tailOffset, readFrom);
        const actualLen = fileSize - actualOffset;
        const buf = Buffer.alloc(actualLen);
        fs.readSync(fd, buf, 0, actualLen, actualOffset);
        content = buf.toString("utf-8");
        if (actualOffset > readFrom) {
          const firstNewline = content.indexOf("\n");
          if (firstNewline >= 0) content = content.slice(firstNewline + 1);
        }
      } finally {
        fs.closeSync(fd);
      }
    } else if (readFrom > 0) {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, readFrom);
        content = buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(transcriptPath, "utf-8");
    }
  } catch {
    return [];
  }

  // Phase 1: Parse all records, group assistant records by message.id
  const assistantGroups = new Map(); // message.id → { chunks: [], usage, model, stop_reason }
  const conversationRecords = [];    // ordered list of { type, data } for input_messages reconstruction

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const recordType = record.type;
    if (!recordType) continue;

    if (recordType === "assistant") {
      const msg = record.message;
      if (!msg || !msg.id) continue;

      const msgId = msg.id;
      if (!assistantGroups.has(msgId)) {
        assistantGroups.set(msgId, {
          id: msgId,
          chunks: [],
          usage: null,
          model: null,
          stop_reason: null,
          order: conversationRecords.length,
        });
        conversationRecords.push({ type: "assistant", msgId });
      }

      const group = assistantGroups.get(msgId);

      // Collect content blocks from this chunk
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          group.chunks.push(block);
        }
      }

      // Usage, model, stop_reason — same across chunks, take latest
      if (msg.usage) group.usage = msg.usage;
      if (msg.model) group.model = msg.model;
      if (msg.stop_reason) group.stop_reason = msg.stop_reason;

    } else if (recordType === "user") {
      const msg = record.message;
      if (!msg) continue;
      conversationRecords.push({ type: "user", content: msg.content });
    }
    // Ignore other record types (permission-mode, attachment, last-prompt, etc.)
  }

  if (assistantGroups.size === 0) {
    const empty = [];
    empty.nextOffset = fileSize;
    return empty;
  }

  // Phase 2: Deduplicate content blocks within each assistant group
  for (const group of assistantGroups.values()) {
    group.mergedContent = deduplicateContentBlocks(group.chunks);
    delete group.chunks;
  }

  // Phase 3: Build llm_call events with delta input_messages (not cumulative)
  // Storing only new messages since the last LLM call avoids O(N²) memory
  // from N copies of increasingly large conversation history.
  const llmEvents = [];
  const conversationHistory = [];
  let prevCount = 0;

  for (const rec of conversationRecords) {
    if (rec.type === "user") {
      conversationHistory.push({ role: "user", content: rec.content });
    } else if (rec.type === "assistant") {
      const group = assistantGroups.get(rec.msgId);
      if (!group) continue;

      const usage = group.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const cacheCreate = usage.cache_creation_input_tokens || 0;

      const delta = conversationHistory.slice(prevCount);

      llmEvents.push({
        type: "llm_call",
        timestamp: 0,
        request_start_time: 0,
        protocol: "anthropic",
        model: group.model || "unknown",
        input_messages: delta,
        _input_is_delta: true,
        output_content: group.mergedContent,
        stop_reason: group.stop_reason || "end_turn",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      });

      conversationHistory.push({
        role: "assistant",
        content: group.mergedContent,
      });
      prevCount = conversationHistory.length;
    }
  }

  // Phase 4: Assign timestamps (evenly distributed between startTime and stopTime)
  if (llmEvents.length > 0) {
    assignTimestamps(llmEvents, startTime, stopTime);
  }

  llmEvents.nextOffset = fileSize;
  return llmEvents;
}

/**
 * Deduplicate content blocks from streaming chunks.
 *
 * Each streaming chunk contains one content block. We collect all blocks
 * and deduplicate by (type + identity):
 * - text blocks: deduplicate by type only (merge/keep longest)
 * - thinking blocks: deduplicate by type only (merge/keep longest)
 * - tool_use blocks: deduplicate by id
 *
 * @param {Array} blocks - Raw content blocks from all chunks
 * @returns {Array} Deduplicated content blocks
 */
function deduplicateContentBlocks(blocks) {
  if (!blocks || blocks.length === 0) return [];

  const result = [];
  const seenToolUseIds = new Set();
  let bestText = null;
  let bestThinking = null;

  for (const block of blocks) {
    if (!block || !block.type) continue;

    if (block.type === "text") {
      // Keep the longest text block
      if (!bestText || (block.text || "").length > (bestText.text || "").length) {
        bestText = block;
      }
    } else if (block.type === "thinking") {
      // Keep the longest thinking block
      if (!bestThinking || (block.thinking || "").length > (bestThinking.thinking || "").length) {
        bestThinking = block;
      }
    } else if (block.type === "tool_use") {
      // Deduplicate by tool_use id
      if (block.id && !seenToolUseIds.has(block.id)) {
        seenToolUseIds.add(block.id);
        result.push(block);
      } else if (!block.id) {
        result.push(block);
      }
    } else {
      // Other block types (e.g., image) — keep as-is
      result.push(block);
    }
  }

  // Insert text/thinking at the front in natural order (thinking → text → tool_use)
  if (bestText) result.unshift(bestText);
  if (bestThinking) result.unshift(bestThinking);

  return result;
}

/**
 * Assign timestamps to llm_call events.
 *
 * Since transcript records have no timestamps, we distribute them
 * evenly between startTime and stopTime. The exact timestamps don't
 * matter much — they just need correct relative ordering for span
 * visualization.
 *
 * @param {Array} llmEvents - llm_call events (mutated in place)
 * @param {number} startTime - Session start time (epoch seconds)
 * @param {number} stopTime - Session stop time (epoch seconds)
 */
function assignTimestamps(llmEvents, startTime, stopTime) {
  const n = llmEvents.length;
  const duration = Math.max(stopTime - startTime, 1);
  const interval = duration / (n + 1);

  for (let i = 0; i < n; i++) {
    const ts = startTime + interval * (i + 1);
    llmEvents[i].timestamp = ts;
    llmEvents[i].request_start_time = ts - Math.min(interval * 0.5, 1);
  }
}

/**
 * Align transcript llm_call events with hook events for better timestamp accuracy.
 *
 * Called from exportSessionTrace() after merging transcript events with hook events.
 * Uses pre_tool_use/post_tool_use/user_prompt_submit timestamps as anchors.
 *
 * Pattern:
 *   user_prompt_submit (t0)
 *     llm_call #1 → pre_tool_use (t1) → post_tool_use (t2)
 *     llm_call #2 → pre_tool_use (t3) → post_tool_use (t4)
 *     llm_call #3 → stop
 *
 * @param {Array} llmEvents - llm_call events from transcript (mutated in place)
 * @param {Array} hookEvents - hook events with timestamps
 * @param {number} stopTime - Session stop time
 */
function alignWithHookEvents(llmEvents, hookEvents, stopTime) {
  if (llmEvents.length === 0 || hookEvents.length === 0) return;

  // Extract time anchors from hook events
  const anchors = [];
  let lastAnchorTime = null;

  for (const ev of hookEvents) {
    if (ev.type === "user_prompt_submit" && ev.timestamp) {
      lastAnchorTime = ev.timestamp;
      anchors.push({ type: "start", ts: ev.timestamp });
    } else if (ev.type === "pre_tool_use" && ev.timestamp) {
      anchors.push({ type: "pre_tool", ts: ev.timestamp });
    } else if (ev.type === "post_tool_use" && ev.timestamp) {
      lastAnchorTime = ev.timestamp;
      anchors.push({ type: "post_tool", ts: ev.timestamp });
    }
  }

  // Strategy: each llm_call ends just before the next pre_tool_use,
  // and starts just after the previous post_tool_use (or user_prompt_submit).
  // Only pair the last N events (N = expected LLM call count) to avoid
  // historical transcript data stealing anchors from the current turn.
  const preToolAnchors = anchors.filter(a => a.type === "pre_tool");
  const startAnchors = anchors.filter(a => a.type === "start" || a.type === "post_tool");

  const expectedCount = preToolAnchors.length + 1;
  const startIdx = Math.max(0, llmEvents.length - expectedCount);

  for (let i = 0; i < startIdx; i++) {
    llmEvents[i]._discarded = true;
  }

  let preToolIdx = 0;
  for (let i = startIdx; i < llmEvents.length; i++) {
    const ev = llmEvents[i];
    const relIdx = i - startIdx;

    // request_start_time: use the most recent post_tool or user_prompt_submit before this call
    if (relIdx === 0 && startAnchors.length > 0) {
      ev.request_start_time = startAnchors[0].ts;
    } else if (relIdx > 0) {
      const prevEnd = llmEvents[i - 1].timestamp;
      const postAfterPrev = startAnchors.find(a => a.ts >= prevEnd);
      if (postAfterPrev) {
        ev.request_start_time = postAfterPrev.ts;
      } else {
        ev.request_start_time = prevEnd + 0.001;
      }
    }

    // timestamp (response end): use the next pre_tool_use if this is not the last call
    if (relIdx < expectedCount - 1 && preToolIdx < preToolAnchors.length) {
      ev.timestamp = preToolAnchors[preToolIdx].ts;
      preToolIdx++;
    } else {
      ev.timestamp = stopTime;
    }

    // Ensure request_start < timestamp
    if (ev.request_start_time >= ev.timestamp) {
      ev.request_start_time = ev.timestamp - 0.5;
    }
  }
}

module.exports = {
  parseClaudeTranscript,
  alignWithHookEvents,
  deduplicateContentBlocks,
  MAX_TRANSCRIPT_BYTES,
};
