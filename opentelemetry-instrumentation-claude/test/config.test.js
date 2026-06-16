// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(os.homedir(), ".claude", "otel-config.json");

describe("config", () => {
  let config;
  let originalConfigContent;
  let configExisted;

  beforeAll(() => {
    configExisted = fs.existsSync(CONFIG_PATH);
    if (configExisted) {
      originalConfigContent = fs.readFileSync(CONFIG_PATH, "utf-8");
    }
  });

  afterAll(() => {
    if (configExisted) {
      fs.writeFileSync(CONFIG_PATH, originalConfigContent, "utf-8");
    } else {
      try { fs.unlinkSync(CONFIG_PATH); } catch {}
    }
  });

  beforeEach(() => {
    jest.resetModules();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
    delete process.env.LOONGSUITE_SEMCONV_DIALECT_NAME;
    delete process.env.OTEL_CLAUDE_LOG_ENABLED;
    delete process.env.OTEL_CLAUDE_LOG_DIR;
  });

  afterEach(() => {
    if (config) {
      config.resetConfigCache();
      config = null;
    }
  });

  function writeConfig(obj) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj), "utf-8");
  }

  function removeConfig() {
    try { fs.unlinkSync(CONFIG_PATH); } catch {}
  }

  // ---- loadConfigFile ----

  test("loadConfigFile returns empty object when file does not exist", () => {
    removeConfig();
    config = require("../src/config");
    expect(config.loadConfigFile()).toEqual({});
  });

  test("loadConfigFile reads valid JSON", () => {
    writeConfig({ otlp_endpoint: "https://example.com" });
    config = require("../src/config");
    const cfg = config.loadConfigFile();
    expect(cfg.otlp_endpoint).toBe("https://example.com");
  });

  test("loadConfigFile returns empty object for invalid JSON", () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "not json {{{", "utf-8");
    config = require("../src/config");
    expect(config.loadConfigFile()).toEqual({});
  });

  test("loadConfigFile caches result", () => {
    writeConfig({ otlp_endpoint: "https://first.com" });
    config = require("../src/config");
    const first = config.loadConfigFile();
    writeConfig({ otlp_endpoint: "https://second.com" });
    const second = config.loadConfigFile();
    expect(first).toBe(second);
    expect(second.otlp_endpoint).toBe("https://first.com");
  });

  test("resetConfigCache clears cache", () => {
    writeConfig({ otlp_endpoint: "https://first.com" });
    config = require("../src/config");
    config.loadConfigFile();
    config.resetConfigCache();
    writeConfig({ otlp_endpoint: "https://second.com" });
    const result = config.loadConfigFile();
    expect(result.otlp_endpoint).toBe("https://second.com");
  });

  // ---- getConfig priority ----

  test("config file takes priority over env var", () => {
    writeConfig({ otlp_endpoint: "https://from-config.com" });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://from-env.com";
    config = require("../src/config");
    expect(config.getEndpoint()).toBe("https://from-config.com");
  });

  test("env var used when config file key is missing", () => {
    writeConfig({});
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://from-env.com";
    config = require("../src/config");
    expect(config.getEndpoint()).toBe("https://from-env.com");
  });

  test("default used when neither config file nor env var", () => {
    removeConfig();
    config = require("../src/config");
    expect(config.getEndpoint()).toBe("");
  });

  test("empty string in config file falls back to env var", () => {
    writeConfig({ otlp_endpoint: "" });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://from-env.com";
    config = require("../src/config");
    expect(config.getEndpoint()).toBe("https://from-env.com");
  });

  test("null in config file falls back to env var", () => {
    writeConfig({ otlp_endpoint: null });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://from-env.com";
    config = require("../src/config");
    expect(config.getEndpoint()).toBe("https://from-env.com");
  });

  // ---- boolean config ----

  test("isDebug returns boolean from config file", () => {
    writeConfig({ debug: true });
    config = require("../src/config");
    expect(config.isDebug()).toBe(true);
  });

  test("isDebug parses '1' from env var as true", () => {
    removeConfig();
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    config = require("../src/config");
    expect(config.isDebug()).toBe(true);
  });

  test("isDebug returns false by default", () => {
    removeConfig();
    config = require("../src/config");
    expect(config.isDebug()).toBe(false);
  });

  test("isLogEnabled from config file", () => {
    writeConfig({ log_enabled: true });
    config = require("../src/config");
    expect(config.isLogEnabled()).toBe(true);
  });

  test("isLogEnabled from env var", () => {
    removeConfig();
    process.env.OTEL_CLAUDE_LOG_ENABLED = "true";
    config = require("../src/config");
    expect(config.isLogEnabled()).toBe(true);
  });

  // ---- convenience functions ----

  test("getHeaders from config file", () => {
    writeConfig({ otlp_headers: "x-api-key=abc" });
    config = require("../src/config");
    expect(config.getHeaders()).toBe("x-api-key=abc");
  });

  test("getServiceName from config file", () => {
    writeConfig({ service_name: "my-svc" });
    config = require("../src/config");
    expect(config.getServiceName("default-svc")).toBe("my-svc");
  });

  test("getServiceName falls back to default", () => {
    removeConfig();
    config = require("../src/config");
    expect(config.getServiceName("default-svc")).toBe("default-svc");
  });

  test("getResourceAttributes from config file", () => {
    writeConfig({ resource_attributes: "k1=v1,k2=v2" });
    config = require("../src/config");
    expect(config.getResourceAttributes()).toBe("k1=v1,k2=v2");
  });

  test("getSemconvDialect from config file", () => {
    writeConfig({ semconv_dialect: "ALIBABA_GROUP" });
    config = require("../src/config");
    expect(config.getSemconvDialect()).toBe("ALIBABA_GROUP");
  });

  test("getLogDir from config file", () => {
    writeConfig({ log_dir: "/tmp/logs" });
    config = require("../src/config");
    expect(config.getLogDir()).toBe("/tmp/logs");
  });

  // ---- CONFIG_PATH ----

  test("CONFIG_PATH is ~/.claude/otel-config.json", () => {
    config = require("../src/config");
    expect(config.CONFIG_PATH).toBe(path.join(os.homedir(), ".claude", "otel-config.json"));
  });
});
