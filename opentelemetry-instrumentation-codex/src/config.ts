import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const CONFIG_PATH = path.join(os.homedir(), ".codex", "otel-config.json");

let _configCache: Record<string, unknown> | undefined;

export function loadConfigFile(): Record<string, unknown> {
  if (_configCache !== undefined) return _configCache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    _configCache = JSON.parse(raw);
    if (_configCache === null || typeof _configCache !== "object" || Array.isArray(_configCache)) {
      _configCache = {};
    }
  } catch {
    _configCache = {};
  }
  return _configCache!;
}

export function resetConfigCache(): void {
  _configCache = undefined;
}

function getConfig(key: string, envVar: string, defaultValue: string): string;
function getConfig(key: string, envVar: string, defaultValue: boolean): boolean;
function getConfig(key: string, envVar: string, defaultValue: string | boolean): string | boolean {
  const cfg = loadConfigFile();
  if (key in cfg && cfg[key] !== null && cfg[key] !== undefined && cfg[key] !== "") {
    return cfg[key] as string | boolean;
  }
  const envVal = process.env[envVar];
  if (envVal !== undefined && envVal !== "") {
    if (typeof defaultValue === "boolean") {
      return envVal === "1" || envVal === "true";
    }
    return envVal;
  }
  return defaultValue;
}

export function getEndpoint(): string {
  return getConfig("otlp_endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT", "");
}

export function getHeaders(): string {
  return getConfig("otlp_headers", "OTEL_EXPORTER_OTLP_HEADERS", "");
}

export function getServiceName(defaultName = ""): string {
  return getConfig("service_name", "OTEL_SERVICE_NAME", defaultName);
}

export function getResourceAttributes(): string {
  return getConfig("resource_attributes", "OTEL_RESOURCE_ATTRIBUTES", "");
}

export function isDebug(): boolean {
  return getConfig("debug", "CODEX_TELEMETRY_DEBUG", false);
}

export function isLogEnabled(): boolean {
  return getConfig("log_enabled", "OTEL_CODEX_LOG_ENABLED", false);
}

export function getLogDir(): string {
  return getConfig("log_dir", "OTEL_CODEX_LOG_DIR", "");
}

export function getLogFilenameFormat(): string {
  return getConfig("log_filename_format", "OTEL_CODEX_LOG_FILENAME_FORMAT", "hook");
}
