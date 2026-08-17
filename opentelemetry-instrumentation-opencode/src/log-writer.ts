/**
 * log-writer.ts — JSONL event log writer for loongsuite-pilot consumption.
 *
 * Writes AI Agent Event Schema records to daily-rotated JSONL files.
 * Configuration is read from ~/.opencode/otel-config.json (shared with pilot).
 * Falls back to ~/.loongsuite-pilot/logs/opencode when config is absent.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogConfig = {
  enabled: boolean
  logDir: string
}

export type EventRecord = Record<string, unknown>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(os.homedir(), ".opencode", "otel-config.json")
const DEFAULT_LOG_DIR = path.join(os.homedir(), ".loongsuite-pilot", "logs", "opencode")
const LOG_PREFIX = "opencode"
const AGENT_TYPE = "opencode"

// ---------------------------------------------------------------------------
// Config loading (cached at module level, loaded once)
// ---------------------------------------------------------------------------

let _cachedConfig: LogConfig | null = null

/**
 * Reads ~/.opencode/otel-config.json and resolves log configuration.
 * Result is cached for the lifetime of the process.
 */
export function loadLogConfig(): LogConfig {
  if (_cachedConfig) return _cachedConfig

  let enabled = true
  let logDir = DEFAULT_LOG_DIR

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8")
    const cfg = JSON.parse(raw) as Record<string, unknown>

    if (cfg.log_enabled === false) {
      enabled = false
    }

    if (typeof cfg.log_dir === "string" && cfg.log_dir.length > 0) {
      logDir = cfg.log_dir.replace(/^~/, os.homedir())
    }
  } catch {
    // Config file missing or malformed — use defaults (enabled + default dir)
  }

  _cachedConfig = { enabled, logDir }
  return _cachedConfig
}

/**
 * Returns whether event logging is enabled.
 */
export function isLogEnabled(): boolean {
  return loadLogConfig().enabled
}

// ---------------------------------------------------------------------------
// File path resolution
// ---------------------------------------------------------------------------

function getTodayDateString(): string {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Returns the path to today's JSONL log file.
 */
export function getLogFilePath(): string {
  const { logDir } = loadLogConfig()
  return path.join(logDir, `${LOG_PREFIX}-${getTodayDateString()}.jsonl`)
}

// ---------------------------------------------------------------------------
// Public: user.id / service.name resolution
// ---------------------------------------------------------------------------

let _userId: string | undefined
let _serviceName: string | undefined

/**
 * Resolves user.id: env var > hostname.
 */
function resolveUserId(): string {
  if (_userId === undefined) {
    _userId = process.env["LOONGSUITE_PILOT_USER_ID"] ?? os.hostname()
  }
  return _userId
}

/**
 * Resolves service.name: env var > "opencode".
 */
function resolveServiceName(): string {
  if (_serviceName === undefined) {
    _serviceName = process.env["OTEL_SERVICE_NAME"] ?? AGENT_TYPE
  }
  return _serviceName
}

// ---------------------------------------------------------------------------
// Public: append event
// ---------------------------------------------------------------------------

/**
 * Formats and appends a single event record to the daily JSONL log file.
 *
 * Automatically fills common fields:
 *   - observed_time_unix_nano (current time)
 *   - event.id (UUID v4)
 *   - agent.type ("opencode")
 *   - user.id (hostname or env var)
 *   - service.name (env var or "opencode")
 *
 * The caller must provide at minimum:
 *   - time_unix_nano
 *   - event.name
 *   - gen_ai.session.id
 *
 * Silently returns on failure — never throws.
 */
export function appendEvent(event: EventRecord): void {
  if (!isLogEnabled()) return

  try {
    const filePath = getLogFilePath()
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })

    const eventId = crypto.randomUUID()
    const observedTime = String(Date.now() * 1_000_000)

    // Start with caller-provided fields, then override with generated fields
    const record: EventRecord = {
      ...event,
      "time_unix_nano": event["time_unix_nano"],
      "observed_time_unix_nano": observedTime,
      "event.id": eventId,
      "event.name": event["event.name"],
      "user.id": event["user.id"] ?? resolveUserId(),
      "agent.type": AGENT_TYPE,
      "service.name": resolveServiceName(),
    }

    // Remove undefined/null values to keep JSONL clean
    for (const key of Object.keys(record)) {
      if (record[key] === undefined || record[key] === null) {
        delete record[key]
      }
    }

    const line = JSON.stringify(record) + "\n"
    fs.appendFileSync(filePath, line, "utf-8")
  } catch {
    // Silent failure — log writing must never break the plugin
  }
}

// ---------------------------------------------------------------------------
// Utility: reset config cache (for testing)
// ---------------------------------------------------------------------------

/** @internal Reset cached config — only for testing. */
export function _resetConfigCache(): void {
  _cachedConfig = null
  _userId = undefined
  _serviceName = undefined
}
