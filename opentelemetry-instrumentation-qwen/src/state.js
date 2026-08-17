// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * state.js — Session state file read/write helpers.
 *
 * State files are stored at:
 *   ~/.cache/opentelemetry.instrumentation.qwen/sessions/<sessionId>.json
 *
 * Writes are atomic: we write to a temp file then rename into place.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opentelemetry.instrumentation.qwen",
  "sessions"
);

function stateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

/**
 * Sanitize a session ID so it is safe to use as a file-system component.
 * Strip everything that is not alphanumeric, hyphen, or underscore,
 * then take only the basename to prevent directory traversal.
 */
function sanitizeSessionId(sessionId) {
  const base = path.basename(String(sessionId));
  return base.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function stateFile(sessionId) {
  return path.join(stateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

function loadState(sessionId) {
  const sf = stateFile(sessionId);
  if (fs.existsSync(sf)) {
    try {
      return JSON.parse(fs.readFileSync(sf, "utf-8"));
    } catch (err) {
      console.error(
        `[otel-qwen-hook] State file for session ${sessionId} is corrupted; discarding and starting fresh. (${err.message})`
      );
    }
  }
  return {
    session_id: sessionId,
    start_time: Date.now() / 1000,
    prompt: "",
    model: "unknown",
    metrics: {
      input_tokens: 0,
      output_tokens: 0,
      tools_used: 0,
      turns: 0,
    },
    tools_used: [],
    events: [],
  };
}

function saveState(sessionId, state) {
  const dest = stateFile(sessionId);
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${sanitizeSessionId(sessionId)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function clearState(sessionId) {
  const sf = stateFile(sessionId);
  if (fs.existsSync(sf)) {
    try { fs.unlinkSync(sf); } catch {}
  }
}

/**
 * Read a child session's state snapshot (for SubagentStop inlining).
 * Removes the child state file after reading.
 */
function readAndDeleteChildState(childSessionId) {
  const sf = stateFile(childSessionId);
  if (!fs.existsSync(sf)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(sf, "utf-8"));
    try { fs.unlinkSync(sf); } catch {}
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSONL-based event log (concurrent-safe, eliminates read-modify-write race)
// ---------------------------------------------------------------------------

function eventsFile(sessionId) {
  return path.join(stateDir(), `${sanitizeSessionId(sessionId)}.events.jsonl`);
}

/**
 * Append a single event to the session's JSONL log.
 * fs.appendFileSync with O_APPEND is atomic for lines < PIPE_BUF (~4 KB),
 * which is well within the size of any single hook event.
 */
function appendEvent(sessionId, event) {
  const ef = eventsFile(sessionId);
  fs.appendFileSync(ef, JSON.stringify(event) + "\n");
}

function loadEvents(sessionId) {
  const ef = eventsFile(sessionId);
  if (!fs.existsSync(ef)) return [];
  try {
    const lines = fs.readFileSync(ef, "utf-8").split("\n");
    const events = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch {}
    }
    return events;
  } catch {
    return [];
  }
}

function deleteEvents(sessionId) {
  const ef = eventsFile(sessionId);
  if (fs.existsSync(ef)) {
    try { fs.unlinkSync(ef); } catch {}
  }
}

module.exports = {
  loadState,
  saveState,
  clearState,
  stateFile,
  stateDir,
  eventsFile,
  readAndDeleteChildState,
  appendEvent,
  loadEvents,
  deleteEvents,
  sanitizeSessionId,
  STATE_DIR,
};
