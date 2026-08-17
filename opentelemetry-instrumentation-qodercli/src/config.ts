// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface QoderCliPluginConfig {
  endpoint?: string;
  headers?: string | Record<string, string>;
  serviceName?: string;
  resourceAttributes?: string | Record<string, string>;
  debug?: boolean;
  logEnabled?: boolean;
  logDir?: string;
  logFilenameFormat?: string;
}

const CONFIG_PATH = path.join(os.homedir(), ".qoder", "otel-config.json");
const DEFAULT_SERVICE_NAME = "qodercli-agent";
const DEFAULT_LOG_DIR = path.join(
  os.homedir(),
  ".loongsuite-pilot",
  "logs",
  "qodercli",
);
const DEFAULT_LOG_FILENAME_FORMAT = "qodercli-{date}.jsonl";

let cached: QoderCliPluginConfig | null = null;

export function loadConfigFile(): QoderCliPluginConfig {
  if (cached) return cached;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const text = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(text) as QoderCliPluginConfig;
      cached = parsed && typeof parsed === "object" ? parsed : {};
      return cached;
    }
  } catch {
    /* ignore — fall through to empty */
  }
  cached = {};
  return cached;
}

/** Reset the in-memory cache (for tests). */
export function _resetConfigCache(): void {
  cached = null;
}

/**
 * Treat empty strings as unset — Constitution C8 mandates this so that
 * pilot scripts that accidentally export `OTEL_EXPORTER_OTLP_ENDPOINT=""`
 * cannot crash the plugin.
 */
function nonEmpty(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Priority: config file > env > default. */
function pick<T>(
  fromFile: T | undefined,
  fromEnv: T | undefined,
  fallback: T | undefined,
): T | undefined {
  if (fromFile !== undefined && fromFile !== null) return fromFile;
  if (fromEnv !== undefined) return fromEnv;
  return fallback;
}

export function getEndpoint(): string | undefined {
  const cfg = loadConfigFile();
  return pick(
    nonEmpty(cfg.endpoint),
    nonEmpty(process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]),
    undefined,
  );
}

/**
 * Returns headers as a single key=value,key=value string suitable for
 * the OTLP exporter env. Accepts both forms in JSON config.
 */
export function getHeaders(): string | undefined {
  const cfg = loadConfigFile();
  let fromFile: string | undefined;
  if (typeof cfg.headers === "string") {
    fromFile = nonEmpty(cfg.headers);
  } else if (cfg.headers && typeof cfg.headers === "object") {
    const parts = Object.entries(cfg.headers).map(
      ([k, v]) => `${k}=${String(v)}`,
    );
    fromFile = parts.length > 0 ? parts.join(",") : undefined;
  }
  return pick(
    fromFile,
    nonEmpty(process.env["OTEL_EXPORTER_OTLP_HEADERS"]),
    undefined,
  );
}

export function getServiceName(): string {
  const cfg = loadConfigFile();
  return (
    pick(
      nonEmpty(cfg.serviceName),
      nonEmpty(process.env["OTEL_SERVICE_NAME"]),
      DEFAULT_SERVICE_NAME,
    ) ?? DEFAULT_SERVICE_NAME
  );
}

export function getResourceAttributes(): string | undefined {
  const cfg = loadConfigFile();
  let fromFile: string | undefined;
  if (typeof cfg.resourceAttributes === "string") {
    fromFile = nonEmpty(cfg.resourceAttributes);
  } else if (
    cfg.resourceAttributes &&
    typeof cfg.resourceAttributes === "object"
  ) {
    const parts = Object.entries(cfg.resourceAttributes).map(
      ([k, v]) => `${k}=${String(v)}`,
    );
    fromFile = parts.length > 0 ? parts.join(",") : undefined;
  }
  return pick(
    fromFile,
    nonEmpty(process.env["OTEL_RESOURCE_ATTRIBUTES"]),
    undefined,
  );
}

export function isDebug(): boolean {
  const cfg = loadConfigFile();
  if (cfg.debug === true) return true;
  const v = process.env["QODERCLI_TELEMETRY_DEBUG"];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

export function isLogEnabled(): boolean {
  const cfg = loadConfigFile();
  if (cfg.logEnabled === true) return true;
  const v = process.env["OTEL_QODERCLI_LOG_ENABLED"];
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

export function getLogDir(): string {
  const cfg = loadConfigFile();
  return (
    pick(
      nonEmpty(cfg.logDir),
      nonEmpty(process.env["OTEL_QODERCLI_LOG_DIR"]),
      DEFAULT_LOG_DIR,
    ) ?? DEFAULT_LOG_DIR
  );
}

export function getLogFilenameFormat(): string {
  const cfg = loadConfigFile();
  return (
    pick(
      nonEmpty(cfg.logFilenameFormat),
      nonEmpty(process.env["OTEL_QODERCLI_LOG_FILENAME_FORMAT"]),
      DEFAULT_LOG_FILENAME_FORMAT,
    ) ?? DEFAULT_LOG_FILENAME_FORMAT
  );
}
