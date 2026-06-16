// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");

describe("telemetry", () => {
  let telemetry;
  const origReadFileSync = fs.readFileSync;

  beforeEach(() => {
    jest.resetModules();
    fs.readFileSync = function (p, ...args) {
      if (typeof p === "string" && p.includes("otel-config.json")) {
        throw new Error("ENOENT");
      }
      return origReadFileSync.call(this, p, ...args);
    };
  });

  afterEach(async () => {
    fs.readFileSync = origReadFileSync;
    if (telemetry) {
      try { await telemetry.shutdownTelemetry(); } catch {}
      telemetry = null;
    }
  });

  test("throws when no backend configured", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
    telemetry = require("../src/telemetry");
    expect(() => telemetry.configureTelemetry()).toThrow(/NO TELEMETRY BACKEND/);
  });

  test("configures console provider in debug mode", () => {
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    telemetry = require("../src/telemetry");
    const provider = telemetry.configureTelemetry();
    expect(provider).toBeDefined();
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
  });

  test("is idempotent — returns same provider on repeat calls", () => {
    process.env.CLAUDE_TELEMETRY_DEBUG = "1";
    telemetry = require("../src/telemetry");
    const p1 = telemetry.configureTelemetry();
    const p2 = telemetry.configureTelemetry();
    expect(p1).toBe(p2);
    delete process.env.CLAUDE_TELEMETRY_DEBUG;
  });

  test("resolveServiceName uses OTEL_SERVICE_NAME env var", () => {
    process.env.OTEL_SERVICE_NAME = "my-service";
    telemetry = require("../src/telemetry");
    expect(telemetry.resolveServiceName()).toBe("my-service");
    delete process.env.OTEL_SERVICE_NAME;
  });

  test("resolveServiceName reads service.name from OTEL_RESOURCE_ATTRIBUTES", () => {
    delete process.env.OTEL_SERVICE_NAME;
    process.env.OTEL_RESOURCE_ATTRIBUTES = "env=prod,service.name=my-agent";
    telemetry = require("../src/telemetry");
    expect(telemetry.resolveServiceName()).toBe("my-agent");
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  test("resolveServiceName returns default when nothing set", () => {
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    telemetry = require("../src/telemetry");
    expect(telemetry.resolveServiceName()).toBe("claude-agents");
  });

  test("parseResourceAttributes parses all key=value pairs", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.name=cc-test,acs.cms.workspace=ximing,benchmark.instance_id=autojump";
    telemetry = require("../src/telemetry");
    const attrs = telemetry.parseResourceAttributes();
    expect(attrs).toEqual({
      "service.name": "cc-test",
      "acs.cms.workspace": "ximing",
      "benchmark.instance_id": "autojump",
    });
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  test("parseResourceAttributes returns empty object when unset", () => {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    telemetry = require("../src/telemetry");
    expect(telemetry.parseResourceAttributes()).toEqual({});
  });

  test("parseResourceAttributes handles values with = signs", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "key=val=ue,other=ok";
    telemetry = require("../src/telemetry");
    const attrs = telemetry.parseResourceAttributes();
    expect(attrs["key"]).toBe("val=ue");
    expect(attrs["other"]).toBe("ok");
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  test("buildResourceAttrs includes all env attrs plus resolved service.name", () => {
    process.env.OTEL_SERVICE_NAME = "my-svc";
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "acs.cms.workspace=test-ws,benchmark.model.name=claude-4";
    telemetry = require("../src/telemetry");
    const attrs = telemetry.buildResourceAttrs();
    expect(attrs["service.name"]).toBe("my-svc");
    expect(attrs["acs.cms.workspace"]).toBe("test-ws");
    expect(attrs["benchmark.model.name"]).toBe("claude-4");
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  test("buildResourceAttrs: OTEL_SERVICE_NAME overrides service.name in OTEL_RESOURCE_ATTRIBUTES", () => {
    process.env.OTEL_SERVICE_NAME = "override-name";
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.name=from-attrs,custom=val";
    telemetry = require("../src/telemetry");
    const attrs = telemetry.buildResourceAttrs();
    expect(attrs["service.name"]).toBe("override-name");
    expect(attrs["custom"]).toBe("val");
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });

  test("buildResourceAttrs always sets gen_ai.agent.system=claude", () => {
    telemetry = require("../src/telemetry");
    const attrs = telemetry.buildResourceAttrs();
    expect(attrs["gen_ai.agent.system"]).toBe("claude");
  });

  test("gen_ai.agent.system cannot be overridden by OTEL_RESOURCE_ATTRIBUTES", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "gen_ai.agent.system=other-system,foo=bar";
    telemetry = require("../src/telemetry");
    const attrs = telemetry.buildResourceAttrs();
    expect(attrs["gen_ai.agent.system"]).toBe("claude");
    expect(attrs["foo"]).toBe("bar");
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  });
});
