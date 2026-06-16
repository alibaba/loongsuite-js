// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const config = require("./config");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function isLogEnabled() {
  return config.isLogEnabled();
}

function resolveLogDir() {
  const dir = config.getLogDir();
  if (dir) return dir;
  return path.join(os.homedir(), ".loongcollector", "data");
}

function getLogFilePath() {
  const dir = resolveLogDir();
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  if (config.getLogFilenameFormat() === "hook") {
    return path.join(dir, `claude-code-${y}-${m}-${d}.jsonl`);
  }
  return path.join(dir, `claude-code.jsonl.${y}${m}${d}`);
}

// ---------------------------------------------------------------------------
// Chain hash — deterministic serialization + SHA-256
// ---------------------------------------------------------------------------

function stableSerialize(obj) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean" || typeof obj === "number") return JSON.stringify(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableSerialize).join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    const parts = keys.map(k => JSON.stringify(k) + ":" + stableSerialize(obj[k]));
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(obj);
}

const INITIAL_HASH = crypto.createHash("sha256").update("").digest("hex").slice(0, 32);

function hashStep(prevHash, msg) {
  const msgBytes = Buffer.from(stableSerialize(msg), "utf-8");
  const combined = Buffer.concat([Buffer.from(prevHash, "utf-8"), msgBytes]);
  return crypto.createHash("sha256").update(combined).digest("hex").slice(0, 32);
}

function computeHash(prevHash, deltaMessages) {
  let h = prevHash;
  for (const msg of deltaMessages) {
    h = hashStep(h, msg);
  }
  return h;
}

function shouldLogFullMessages(prevHash, delta, currentHash) {
  return computeHash(prevHash, delta) !== currentHash;
}

// ---------------------------------------------------------------------------
// JSONL file writing
// ---------------------------------------------------------------------------

function appendLogRecord(record) {
  const filePath = getLogFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

function writeLogRecords(records) {
  if (!records || records.length === 0) return;
  const filePath = getLogFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(filePath, lines, "utf-8");
}

module.exports = {
  isLogEnabled,
  resolveLogDir,
  getLogFilePath,
  stableSerialize,
  INITIAL_HASH,
  hashStep,
  computeHash,
  shouldLogFullMessages,
  appendLogRecord,
  writeLogRecords,
};
