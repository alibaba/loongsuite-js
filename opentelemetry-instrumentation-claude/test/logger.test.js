// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
  isLogEnabled,
  resolveLogDir,
  getLogFilePath,
  stableSerialize,
  INITIAL_HASH,
  hashStep,
  computeHash,
  shouldLogFullMessages,
  writeLogRecords,
} = require("../src/logger");

// ---------------------------------------------------------------------------
// stableSerialize
// ---------------------------------------------------------------------------
describe("stableSerialize", () => {
  test("null", () => expect(stableSerialize(null)).toBe("null"));
  test("undefined", () => expect(stableSerialize(undefined)).toBe("null"));
  test("number", () => expect(stableSerialize(42)).toBe("42"));
  test("boolean", () => expect(stableSerialize(true)).toBe("true"));
  test("string", () => expect(stableSerialize("hello")).toBe('"hello"'));
  test("empty array", () => expect(stableSerialize([])).toBe("[]"));
  test("array with values", () => expect(stableSerialize([1, "a"])).toBe('[1,"a"]'));

  test("object keys are sorted", () => {
    expect(stableSerialize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("nested objects sort recursively", () => {
    const obj = { z: { b: 2, a: 1 }, a: [3, { y: 1, x: 2 }] };
    expect(stableSerialize(obj)).toBe('{"a":[3,{"x":2,"y":1}],"z":{"a":1,"b":2}}');
  });

  test("deterministic — same input always same output", () => {
    const obj = { role: "user", content: "hello", parts: [{ type: "text" }] };
    const s1 = stableSerialize(obj);
    const s2 = stableSerialize(obj);
    expect(s1).toBe(s2);
  });
});

// ---------------------------------------------------------------------------
// INITIAL_HASH
// ---------------------------------------------------------------------------
describe("INITIAL_HASH", () => {
  test("equals sha256 of empty string truncated to 32 hex", () => {
    const expected = crypto.createHash("sha256").update("").digest("hex").slice(0, 32);
    expect(INITIAL_HASH).toBe(expected);
  });

  test("is 32 characters", () => {
    expect(INITIAL_HASH).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// hashStep
// ---------------------------------------------------------------------------
describe("hashStep", () => {
  test("produces 32-char hex string", () => {
    const result = hashStep(INITIAL_HASH, { role: "user", content: "hi" });
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  test("different messages produce different hashes", () => {
    const h1 = hashStep(INITIAL_HASH, { role: "user", content: "hello" });
    const h2 = hashStep(INITIAL_HASH, { role: "user", content: "world" });
    expect(h1).not.toBe(h2);
  });

  test("different prevHash produces different result", () => {
    const msg = { role: "user", content: "test" };
    const h1 = hashStep(INITIAL_HASH, msg);
    const h2 = hashStep("a".repeat(32), msg);
    expect(h1).not.toBe(h2);
  });

  test("deterministic", () => {
    const msg = { role: "user", content: "test" };
    expect(hashStep(INITIAL_HASH, msg)).toBe(hashStep(INITIAL_HASH, msg));
  });
});

// ---------------------------------------------------------------------------
// computeHash
// ---------------------------------------------------------------------------
describe("computeHash", () => {
  test("empty delta returns prevHash", () => {
    expect(computeHash(INITIAL_HASH, [])).toBe(INITIAL_HASH);
  });

  test("single message", () => {
    const msg = { role: "user", content: "hi" };
    const expected = hashStep(INITIAL_HASH, msg);
    expect(computeHash(INITIAL_HASH, [msg])).toBe(expected);
  });

  test("chaining — H2 depends on H1", () => {
    const m1 = { role: "user", content: "a" };
    const m2 = { role: "assistant", content: "b" };
    const h1 = hashStep(INITIAL_HASH, m1);
    const h2 = hashStep(h1, m2);
    expect(computeHash(INITIAL_HASH, [m1, m2])).toBe(h2);
  });

  test("order matters", () => {
    const m1 = { role: "user", content: "a" };
    const m2 = { role: "assistant", content: "b" };
    const forward = computeHash(INITIAL_HASH, [m1, m2]);
    const reverse = computeHash(INITIAL_HASH, [m2, m1]);
    expect(forward).not.toBe(reverse);
  });
});

// ---------------------------------------------------------------------------
// shouldLogFullMessages
// ---------------------------------------------------------------------------
describe("shouldLogFullMessages", () => {
  test("returns false when hash matches (normal incremental append)", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const currentHash = computeHash(INITIAL_HASH, msgs);
    expect(shouldLogFullMessages(INITIAL_HASH, msgs, currentHash)).toBe(false);
  });

  test("returns true when hash mismatches (context compression)", () => {
    const msgs = [{ role: "user", content: "a" }];
    const currentHash = computeHash(INITIAL_HASH, msgs);
    const wrongPrevHash = "f".repeat(32);
    expect(shouldLogFullMessages(wrongPrevHash, msgs, currentHash)).toBe(true);
  });

  test("returns true on first call (prevHash = INITIAL_HASH but delta != full context)", () => {
    const fullContext = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const currentHash = computeHash(INITIAL_HASH, fullContext);
    const delta = [{ role: "assistant", content: "b" }];
    expect(shouldLogFullMessages(INITIAL_HASH, delta, currentHash)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isLogEnabled
// ---------------------------------------------------------------------------
describe("isLogEnabled", () => {
  const origEnv = process.env.OTEL_CLAUDE_LOG_ENABLED;
  const config = require("../src/config");
  let origReadFileSync;

  beforeEach(() => {
    config.resetConfigCache();
    origReadFileSync = fs.readFileSync;
    fs.readFileSync = function (p, ...args) {
      if (typeof p === "string" && p.includes("otel-config.json")) {
        throw new Error("ENOENT");
      }
      return origReadFileSync.call(this, p, ...args);
    };
  });

  afterEach(() => {
    fs.readFileSync = origReadFileSync;
    if (origEnv === undefined) delete process.env.OTEL_CLAUDE_LOG_ENABLED;
    else process.env.OTEL_CLAUDE_LOG_ENABLED = origEnv;
    config.resetConfigCache();
  });

  test("returns true when OTEL_CLAUDE_LOG_ENABLED=1", () => {
    process.env.OTEL_CLAUDE_LOG_ENABLED = "1";
    expect(isLogEnabled()).toBe(true);
  });

  test("returns false when unset", () => {
    delete process.env.OTEL_CLAUDE_LOG_ENABLED;
    expect(isLogEnabled()).toBe(false);
  });

  test("returns true for 'true' string", () => {
    process.env.OTEL_CLAUDE_LOG_ENABLED = "true";
    expect(isLogEnabled()).toBe(true);
  });

  test("returns false for other values", () => {
    process.env.OTEL_CLAUDE_LOG_ENABLED = "no";
    expect(isLogEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveLogDir
// ---------------------------------------------------------------------------
describe("resolveLogDir", () => {
  const origEnv = process.env.OTEL_CLAUDE_LOG_DIR;
  const config = require("../src/config");
  let origReadFileSync;

  beforeEach(() => {
    config.resetConfigCache();
    origReadFileSync = fs.readFileSync;
    fs.readFileSync = function (p, ...args) {
      if (typeof p === "string" && p.includes("otel-config.json")) {
        throw new Error("ENOENT");
      }
      return origReadFileSync.call(this, p, ...args);
    };
  });

  afterEach(() => {
    fs.readFileSync = origReadFileSync;
    if (origEnv === undefined) delete process.env.OTEL_CLAUDE_LOG_DIR;
    else process.env.OTEL_CLAUDE_LOG_DIR = origEnv;
    config.resetConfigCache();
  });

  test("uses OTEL_CLAUDE_LOG_DIR when set", () => {
    process.env.OTEL_CLAUDE_LOG_DIR = "/tmp/custom-logs";
    expect(resolveLogDir()).toBe("/tmp/custom-logs");
  });

  test("defaults to ~/.loongcollector/data/", () => {
    delete process.env.OTEL_CLAUDE_LOG_DIR;
    expect(resolveLogDir()).toBe(path.join(os.homedir(), ".loongcollector", "data"));
  });
});

// ---------------------------------------------------------------------------
// getLogFilePath
// ---------------------------------------------------------------------------
describe("getLogFilePath", () => {
  const origEnv = process.env.OTEL_CLAUDE_LOG_DIR;
  const config = require("../src/config");
  let origReadFileSync;

  beforeEach(() => {
    config.resetConfigCache();
    origReadFileSync = fs.readFileSync;
    fs.readFileSync = function (p, ...args) {
      if (typeof p === "string" && p.includes("otel-config.json")) {
        throw new Error("ENOENT");
      }
      return origReadFileSync.call(this, p, ...args);
    };
  });

  afterEach(() => {
    fs.readFileSync = origReadFileSync;
    if (origEnv === undefined) delete process.env.OTEL_CLAUDE_LOG_DIR;
    else process.env.OTEL_CLAUDE_LOG_DIR = origEnv;
    config.resetConfigCache();
  });

  test("filename matches claude-code.jsonl.YYYYMMDD pattern", () => {
    process.env.OTEL_CLAUDE_LOG_DIR = "/tmp/test-logs";
    const filePath = getLogFilePath();
    expect(filePath).toMatch(/^\/tmp\/test-logs\/claude-code\.jsonl\.\d{8}$/);
  });

  test("date portion matches today", () => {
    process.env.OTEL_CLAUDE_LOG_DIR = "/tmp/test-logs";
    const filePath = getLogFilePath();
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    expect(filePath).toContain(`${y}${m}${d}`);
  });
});

// ---------------------------------------------------------------------------
// writeLogRecords
// ---------------------------------------------------------------------------
describe("writeLogRecords", () => {
  let tmpDir;
  const config = require("../src/config");
  let origReadFileSync;

  beforeEach(() => {
    config.resetConfigCache();
    origReadFileSync = fs.readFileSync;
    fs.readFileSync = function (p, ...args) {
      if (typeof p === "string" && p.includes("otel-config.json")) {
        throw new Error("ENOENT");
      }
      return origReadFileSync.call(this, p, ...args);
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
    process.env.OTEL_CLAUDE_LOG_DIR = tmpDir;
  });

  afterEach(() => {
    fs.readFileSync = origReadFileSync;
    delete process.env.OTEL_CLAUDE_LOG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    config.resetConfigCache();
  });

  test("writes records as JSONL", () => {
    const records = [
      { "gen_ai.role": "user", timestamp_ns: 1000 },
      { "gen_ai.role": "assistant", timestamp_ns: 2000 },
    ];
    writeLogRecords(records);

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^claude-code\.jsonl\.\d{8}$/);

    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(records[0]);
    expect(JSON.parse(lines[1])).toEqual(records[1]);
  });

  test("appends to existing file", () => {
    writeLogRecords([{ a: 1 }]);
    writeLogRecords([{ b: 2 }]);

    const files = fs.readdirSync(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("no-op for empty array", () => {
    writeLogRecords([]);
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });

  test("no-op for null", () => {
    writeLogRecords(null);
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(0);
  });
});
