// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

"use strict";

describe("telemetry.js", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.QWEN_TELEMETRY_DEBUG;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveServiceName", () => {
    it("returns OTEL_SERVICE_NAME when set", () => {
      process.env.OTEL_SERVICE_NAME = "my-service";
      const { resolveServiceName } = require("../src/telemetry");
      expect(resolveServiceName()).toBe("my-service");
    });

    it("extracts service.name from OTEL_RESOURCE_ATTRIBUTES", () => {
      process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.env=prod,service.name=from-attrs";
      const { resolveServiceName } = require("../src/telemetry");
      expect(resolveServiceName()).toBe("from-attrs");
    });

    it("falls back to default", () => {
      const { resolveServiceName } = require("../src/telemetry");
      expect(resolveServiceName()).toBe("qwen-agents");
    });

    it("falls back to custom default", () => {
      const { resolveServiceName } = require("../src/telemetry");
      expect(resolveServiceName("custom")).toBe("custom");
    });
  });

  describe("configureTelemetry", () => {
    it("throws when no backend configured", () => {
      const { configureTelemetry } = require("../src/telemetry");
      expect(() => configureTelemetry()).toThrow(/NO TELEMETRY BACKEND CONFIGURED/);
    });

    it("configures console exporter in debug mode", () => {
      process.env.QWEN_TELEMETRY_DEBUG = "1";
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const { configureTelemetry, shutdownTelemetry } = require("../src/telemetry");

      const provider = configureTelemetry();
      expect(provider).toBeDefined();

      consoleSpy.mockRestore();
      return shutdownTelemetry();
    });

    it("configures OTLP exporter when endpoint set", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const { configureTelemetry, shutdownTelemetry } = require("../src/telemetry");

      const provider = configureTelemetry();
      expect(provider).toBeDefined();

      consoleSpy.mockRestore();
      return shutdownTelemetry();
    });
  });
});
