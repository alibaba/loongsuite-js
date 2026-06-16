#!/usr/bin/env node
/**
 * End-to-end verification script for the three bug fixes:
 *   1. input_token includes cache tokens
 *   2. Historical transcript anchor steal is prevented
 *   3. logOnly mode generates valid trace_id/span_id/parent_span_id
 *
 * Usage: node test/e2e-verify-fixes.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ------- Setup: override config to logOnly mode with temp log dir -------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-otel-claude-"));
const logDir = path.join(tmpDir, "logs");
fs.mkdirSync(logDir, { recursive: true });

// Temporarily replace ~/.claude/otel-config.json to force logOnly mode
const realConfigPath = path.join(os.homedir(), ".claude", "otel-config.json");
const backupConfigPath = realConfigPath + ".e2e-backup";
let configBackedUp = false;
if (fs.existsSync(realConfigPath)) {
  fs.copyFileSync(realConfigPath, backupConfigPath);
  configBackedUp = true;
}
fs.writeFileSync(realConfigPath, JSON.stringify({
  log_enabled: true,
  log_dir: logDir,
  log_filename_format: "hook",
}));

function restoreConfig() {
  if (configBackedUp) {
    fs.copyFileSync(backupConfigPath, realConfigPath);
    fs.unlinkSync(backupConfigPath);
  } else {
    fs.unlinkSync(realConfigPath);
  }
}

// Ensure no OTLP endpoint (forces logOnly)
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.CLAUDE_TELEMETRY_DEBUG;

// Reset config cache so it re-reads our overridden file
const configModule = require("../src/config");
configModule.resetConfigCache();

// ------- Create realistic transcript JSONL -------
const transcriptPath = path.join(tmpDir, "session-test.jsonl");

const now = Date.now() / 1000;
const sessionStart = now - 30;
const sessionStop = now;

// Simulate: 3 historical LLM calls (from earlier turn) + 2 current turn LLM calls
// This tests anchor steal fix: only the last 2 should be used
const transcriptRecords = [];

// User message (first turn - historical)
transcriptRecords.push(JSON.stringify({
  type: "user",
  message: { content: [{ type: "text", text: "historical prompt from before plugin install" }] }
}));

// Historical assistant messages (3 calls)
for (let i = 0; i < 3; i++) {
  transcriptRecords.push(JSON.stringify({
    type: "assistant",
    message: {
      id: `msg_hist_${i}`,
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: `historical response ${i}` }],
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 },
      stop_reason: "end_turn",
    }
  }));
}

// User message (current turn)
transcriptRecords.push(JSON.stringify({
  type: "user",
  message: { content: [{ type: "text", text: "current prompt after plugin installed" }] }
}));

// Current turn assistant messages (2 calls with heavy caching)
for (let i = 0; i < 2; i++) {
  transcriptRecords.push(JSON.stringify({
    type: "assistant",
    message: {
      id: `msg_curr_${i}`,
      model: "claude-sonnet-4-20250514",
      content: [
        { type: "text", text: `current response ${i}` },
        ...(i === 0 ? [{ type: "tool_use", id: `tool_${i}`, name: "Bash", input: { command: "ls" } }] : []),
      ],
      usage: {
        input_tokens: 200,        // API reports only non-cached portion
        output_tokens: 300,
        cache_read_input_tokens: 15000,   // Bulk of actual input
        cache_creation_input_tokens: 3000, // New cache entries
      },
      stop_reason: i === 1 ? "end_turn" : "tool_use",
    }
  }));
}

fs.writeFileSync(transcriptPath, transcriptRecords.join("\n") + "\n");

// ------- Create session state (simulates what hooks would have collected) -------
const state = {
  session_id: "test-session-e2e",
  model: "claude-sonnet-4-20250514",
  start_time: sessionStart,
  stop_time: sessionStop,
  transcript_path: transcriptPath,
  transcript_offset: 0,
  events: [
    // Current turn: user_prompt_submit + pre_tool_use + post_tool_use
    {
      type: "user_prompt_submit",
      timestamp: sessionStart + 20,
      prompt: "current prompt after plugin installed",
    },
    {
      type: "pre_tool_use",
      timestamp: sessionStart + 23,
      tool_name: "Bash",
      tool_use_id: "tool_0",
      tool_input: { command: "ls" },
    },
    {
      type: "post_tool_use",
      timestamp: sessionStart + 25,
      tool_name: "Bash",
      tool_use_id: "tool_0",
      tool_response: "file1.txt\nfile2.txt",
    },
  ],
};

// ------- Run the export -------
const cli = require("../src/cli");

console.log("=== E2E Verification: Three Bug Fixes ===\n");
console.log(`Temp dir: ${tmpDir}`);
console.log(`Transcript: ${transcriptPath}`);
console.log(`Log dir: ${logDir}\n`);

(async () => {
  try {
    // Suppress stderr from exportSessionTrace
    const origStderr = console.error;
    const stderrCapture = [];
    console.error = (...args) => stderrCapture.push(args.join(" "));

    await cli._exportSessionTrace(state, "end_turn");

    console.error = origStderr;

    // Print captured stderr
    console.log("--- stderr output ---");
    stderrCapture.forEach(l => console.log(`  ${l}`));
    console.log("");

    // ------- Read JSONL output -------
    const logFiles = fs.readdirSync(logDir).filter(f => f.endsWith(".jsonl"));
    if (logFiles.length === 0) {
      console.log("FAIL: No JSONL log files generated!");
      process.exit(1);
    }

    const logContent = fs.readFileSync(path.join(logDir, logFiles[0]), "utf-8");
    const records = logContent.trim().split("\n").map(l => JSON.parse(l));

    console.log(`Total JSONL records: ${records.length}\n`);

    // ------- Verify Fix 1: input_tokens includes cache -------
    console.log("=== Fix 1: input_tokens includes cache tokens ===");
    const llmResponses = records.filter(r => r["event.name"] === "llm.response");
    console.log(`  llm.response records: ${llmResponses.length}`);

    let fix1Pass = true;
    for (const resp of llmResponses) {
      const inputTokens = resp["usage.input_tokens"];
      const totalTokens = resp["usage.total_tokens"];
      const outputTokens = resp["usage.output_tokens"];
      console.log(`  input_tokens=${inputTokens}, output_tokens=${outputTokens}, total=${totalTokens}`);

      // Each current LLM call has: input=200 + cache_read=15000 + cache_create=3000 = 18200
      // Historical calls have: input=100 + cache_read=5000 + cache_create=2000 = 7100
      // We expect values >> 200 (the raw API value)
      if (inputTokens <= 200) {
        console.log(`  FAIL: input_tokens=${inputTokens} — should be >> 200 (cache not included)`);
        fix1Pass = false;
      }
    }
    console.log(`  Result: ${fix1Pass ? "PASS" : "FAIL"}\n`);

    // ------- Verify Fix 2: anchor steal prevention -------
    console.log("=== Fix 2: Historical transcript anchor steal ===");
    // In logOnly mode the _discarded filter happens before turns are split.
    // With 1 pre_tool_use hook anchor, expectedCount = 1 + 1 = 2.
    // Total LLM events from transcript = 5 (3 historical + 2 current).
    // startIdx = max(0, 5 - 2) = 3. So first 3 should be discarded.
    // Only 2 LLM events should produce llm.request/llm.response records.
    const llmRequests = records.filter(r => r["event.name"] === "llm.request");
    // Subtract 1 for the user prompt (which is also llm.request)
    const userPromptRecords = llmRequests.filter(r => r["message.role"] === "user" && r["input.messages"]);
    const actualLlmRequests = llmRequests.filter(r => r["message.role"] !== "user" || !r["input.messages"]);

    console.log(`  llm.request records: ${llmRequests.length}`);
    console.log(`  llm.response records: ${llmResponses.length}`);

    // We expect 2 LLM responses (only current turn's 2 calls, not all 5)
    const fix2Pass = llmResponses.length === 2;
    if (!fix2Pass) {
      console.log(`  FAIL: Expected 2 llm.response records (discarding 3 historical), got ${llmResponses.length}`);
    } else {
      console.log(`  PASS: Only 2 current-turn LLM calls exported (3 historical discarded)`);
    }
    console.log("");

    // ------- Verify Fix 3: trace_id/span_id/parent_span_id present -------
    console.log("=== Fix 3: trace_id/span_id/parent_span_id in logOnly mode ===");
    let fix3Pass = true;
    const traceIdPattern = /^[0-9a-f]{32}$/;
    const spanIdPattern = /^[0-9a-f]{16}$/;

    const traceIds = new Set();
    const spanIds = new Set();

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const evName = r["event.name"];

      // trace_id
      if (!r.trace_id || !traceIdPattern.test(r.trace_id)) {
        console.log(`  FAIL record[${i}] (${evName}): trace_id = ${JSON.stringify(r.trace_id)}`);
        fix3Pass = false;
      } else {
        traceIds.add(r.trace_id);
      }

      // span_id
      if (!r.span_id || !spanIdPattern.test(r.span_id)) {
        console.log(`  FAIL record[${i}] (${evName}): span_id = ${JSON.stringify(r.span_id)}`);
        fix3Pass = false;
      } else {
        spanIds.add(r.span_id);
      }

      // parent_span_id
      if (!r.parent_span_id || !spanIdPattern.test(r.parent_span_id)) {
        console.log(`  FAIL record[${i}] (${evName}): parent_span_id = ${JSON.stringify(r.parent_span_id)}`);
        fix3Pass = false;
      }
    }

    if (fix3Pass) {
      console.log(`  PASS: All ${records.length} records have valid trace_id (32 hex), span_id (16 hex), parent_span_id (16 hex)`);
      console.log(`  Unique trace_ids: ${traceIds.size}, unique span_ids: ${spanIds.size}`);
    }
    console.log("");

    // ------- Verify parent-child relationships -------
    console.log("=== Bonus: span hierarchy sanity check ===");
    // All records in same turn should share trace_id
    const allSameTrace = traceIds.size === 1;
    console.log(`  All records share one trace_id: ${allSameTrace ? "PASS" : "FAIL (multiple traces)"}`);

    // LLM request+response pairs should share span_id
    const reqSpans = llmRequests.filter(r => r["message.role"] !== "user").map(r => r.span_id);
    const respSpans = llmResponses.map(r => r.span_id);
    const pairsMatch = reqSpans.length === respSpans.length &&
      reqSpans.every((s, i) => s === respSpans[i]);
    console.log(`  LLM req/resp span_id pairs match: ${pairsMatch ? "PASS" : "FAIL"}`);

    // Tool call and result should share span_id
    const toolCalls = records.filter(r => r["event.name"] === "tool.call");
    const toolResults = records.filter(r => r["event.name"] === "tool.result");
    const toolPairsMatch = toolCalls.length === toolResults.length &&
      toolCalls.every((c, i) => c.span_id === toolResults[i].span_id);
    console.log(`  Tool call/result span_id pairs match: ${toolPairsMatch ? "PASS" : "FAIL"}`);
    console.log("");

    // ------- Summary -------
    console.log("=== SUMMARY ===");
    const allPass = fix1Pass && fix2Pass && fix3Pass;
    console.log(`  Fix 1 (input_token): ${fix1Pass ? "PASS" : "FAIL"}`);
    console.log(`  Fix 2 (anchor steal): ${fix2Pass ? "PASS" : "FAIL"}`);
    console.log(`  Fix 3 (span_id):     ${fix3Pass ? "PASS" : "FAIL"}`);
    console.log(`  Overall: ${allPass ? "ALL PASS" : "SOME FAILED"}`);
    console.log("");

    // Dump sample records for manual inspection
    console.log("--- Sample JSONL records (first 3) ---");
    records.slice(0, 3).forEach((r, i) => {
      console.log(`[${i}] ${r["event.name"]}:`);
      console.log(`    trace_id: ${r.trace_id}`);
      console.log(`    span_id: ${r.span_id}`);
      console.log(`    parent_span_id: ${r.parent_span_id}`);
      if (r["usage.input_tokens"] !== undefined) {
        console.log(`    usage.input_tokens: ${r["usage.input_tokens"]}`);
      }
    });

    // Cleanup
    restoreConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    process.exit(allPass ? 0 : 1);
  } catch (err) {
    console.error = console.error; // restore
    console.error("E2E test crashed:", err);
    restoreConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
})();
