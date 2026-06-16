// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
  "otel-config.json"
);

let _configCache = undefined;

function loadConfigFile() {
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
  return _configCache;
}

function resetConfigCache() {
  _configCache = undefined;
}

function getConfig(key, envVar, defaultValue) {
  const cfg = loadConfigFile();
  if (key in cfg && cfg[key] !== null && cfg[key] !== undefined && cfg[key] !== "") {
    return cfg[key];
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

function getEndpoint() {
  return getConfig("otlp_endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT", "");
}

function getHeaders() {
  return getConfig("otlp_headers", "OTEL_EXPORTER_OTLP_HEADERS", "");
}

function getServiceName(defaultName) {
  return getConfig("service_name", "OTEL_SERVICE_NAME", defaultName || "");
}

function getResourceAttributes() {
  return getConfig("resource_attributes", "OTEL_RESOURCE_ATTRIBUTES", "");
}

function isDebug() {
  return getConfig("debug", "CLAUDE_TELEMETRY_DEBUG", false);
}

function getSemconvDialect() {
  return getConfig("semconv_dialect", "LOONGSUITE_SEMCONV_DIALECT_NAME", "");
}

function isLogEnabled() {
  return getConfig("log_enabled", "OTEL_CLAUDE_LOG_ENABLED", false);
}

function getLogDir() {
  return getConfig("log_dir", "OTEL_CLAUDE_LOG_DIR", "");
}

function getLogFilenameFormat() {
  return getConfig("log_filename_format", "OTEL_CLAUDE_LOG_FILENAME_FORMAT", "default");
}

module.exports = {
  CONFIG_PATH,
  loadConfigFile,
  resetConfigCache,
  getConfig,
  getEndpoint,
  getHeaders,
  getServiceName,
  getResourceAttributes,
  isDebug,
  getSemconvDialect,
  isLogEnabled,
  getLogDir,
  getLogFilenameFormat,
};
