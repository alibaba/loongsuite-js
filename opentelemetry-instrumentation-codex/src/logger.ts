import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { isLogEnabled as _isLogEnabled, getLogDir, getLogFilenameFormat } from "./config.js";

export function isLogEnabled(): boolean {
  return _isLogEnabled();
}

export function resolveLogDir(): string {
  const dir = getLogDir();
  if (dir) return dir.replace(/^~/, os.homedir());
  return path.join(os.homedir(), ".ai-agent-collector", "logs", "codex");
}

export function getLogFilePath(): string {
  const dir = resolveLogDir();
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  if (getLogFilenameFormat() === "hook") {
    return path.join(dir, `codex-${y}-${m}-${d}.jsonl`);
  }
  return path.join(dir, `codex.jsonl.${y}${m}${d}`);
}

export function stableSerialize(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean" || typeof obj === "number") return JSON.stringify(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableSerialize).join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + stableSerialize((obj as Record<string, unknown>)[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(obj);
}

export const INITIAL_HASH = crypto.createHash("sha256").update("").digest("hex").slice(0, 32);

export function hashStep(prevHash: string, msg: unknown): string {
  const msgBytes = Buffer.from(stableSerialize(msg), "utf-8");
  const combined = Buffer.concat([Buffer.from(prevHash, "utf-8"), msgBytes]);
  return crypto.createHash("sha256").update(combined).digest("hex").slice(0, 32);
}

export function computeHash(prevHash: string, deltaMessages: unknown[]): string {
  let h = prevHash;
  for (const msg of deltaMessages) {
    h = hashStep(h, msg);
  }
  return h;
}

export function shouldLogFullMessages(
  prevHash: string,
  delta: unknown[],
  currentHash: string,
): boolean {
  return computeHash(prevHash, delta) !== currentHash;
}

export function writeLogRecords(records: Record<string, unknown>[]): void {
  if (!records || records.length === 0) return;
  const filePath = getLogFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(filePath, lines, "utf-8");
}
