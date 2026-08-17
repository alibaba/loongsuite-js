import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetConfigCache,
  getEndpoint,
  getServiceName,
  isDebug,
} from "../../src/config.js";

const ORIG = process.env;

beforeEach(() => {
  process.env = { ...ORIG };
  _resetConfigCache();
});

afterEach(() => {
  process.env = ORIG;
  _resetConfigCache();
});

describe("config.getEndpoint", () => {
  it("returns env value", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "https://example.com";
    expect(getEndpoint()).toBe("https://example.com");
  });

  it("treats empty string as unset (Constitution C8)", () => {
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = "";
    expect(getEndpoint()).toBeUndefined();
  });

  it("returns undefined when nothing set", () => {
    delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    expect(getEndpoint()).toBeUndefined();
  });
});

describe("config.getServiceName", () => {
  it("falls back to qodercli-agent default", () => {
    delete process.env["OTEL_SERVICE_NAME"];
    expect(getServiceName()).toBe("qodercli-agent");
  });

  it("env value takes precedence over default", () => {
    process.env["OTEL_SERVICE_NAME"] = "my-svc";
    expect(getServiceName()).toBe("my-svc");
  });

  it("empty env string falls back to default (C8)", () => {
    process.env["OTEL_SERVICE_NAME"] = "  ";
    expect(getServiceName()).toBe("qodercli-agent");
  });
});

describe("config.isDebug", () => {
  it("true when QODERCLI_TELEMETRY_DEBUG=1", () => {
    process.env["QODERCLI_TELEMETRY_DEBUG"] = "1";
    expect(isDebug()).toBe(true);
  });
  it("false when unset", () => {
    delete process.env["QODERCLI_TELEMETRY_DEBUG"];
    expect(isDebug()).toBe(false);
  });
});
