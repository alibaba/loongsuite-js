// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * state.js — Session state file read/write helpers.
 *
 * State files are stored at:
 *   ~/.cache/opentelemetry.instrumentation.claude/sessions/<sessionId>.json
 *
 * Writes are atomic: we write to a temp file then rename into place,
 * exactly matching the Python version's os.replace() approach.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opentelemetry.instrumentation.claude",
  "sessions"
);

/**
 * Ensure the state directory exists and return its path.
 * @returns {string}
 */
function stateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

/**
 * Sanitize a session ID so it is safe to use as a file-system component.
 *
 * Claude Code session IDs are UUIDs (e.g. "abc1-..."), but we cannot trust
 * arbitrary caller input.  Strip everything that is not alphanumeric, hyphen,
 * or underscore, then take only the basename to prevent directory traversal
 * attacks (e.g. "../../.ssh/authorized_keys").
 *
 * @param {string} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  // path.basename removes any leading path components
  const base = path.basename(String(sessionId));
  // Allow only safe characters: letters, digits, hyphens, underscores
  return base.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

/**
 * Return the path to a session's state file.
 * @param {string} sessionId
 * @returns {string}
 */
function stateFile(sessionId) {
  return path.join(stateDir(), `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * Load persisted session state.  Returns a fresh state object if none exists
 * or if the file is corrupted.
 * @param {string} sessionId
 * @returns {Object}
 */
function loadState(sessionId) {
  const sf = stateFile(sessionId);
  if (fs.existsSync(sf)) {
    try {
      return JSON.parse(fs.readFileSync(sf, "utf-8"));
    } catch (err) {
      console.error(
        `[otel-claude-hook] State file for session ${sessionId} is corrupted; discarding and starting fresh. (${err.message})`
      );
    }
  }
  return {
    session_id: sessionId,
    start_time: Date.now() / 1000,
    prompt: "",
    model: "unknown",
    transcript_path: null,
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

/**
 * Persist session state atomically.
 * @param {string} sessionId
 * @param {Object} state
 */
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

/**
 * Remove a session's state file.
 * @param {string} sessionId
 */
function clearState(sessionId) {
  const sf = stateFile(sessionId);
  if (fs.existsSync(sf)) {
    try { fs.unlinkSync(sf); } catch {}
  }
}

/**
 * Read a child session's state snapshot (for SubagentStop inlining).
 * Removes the child state file after reading.
 * @param {string} childSessionId
 * @returns {Object|null}
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

module.exports = {
  loadState,
  saveState,
  clearState,
  stateFile,
  stateDir,
  readAndDeleteChildState,
  sanitizeSessionId,
  STATE_DIR,
};
