import { describe, test, expect, afterEach } from "bun:test"
import { buildResource } from "../src/otel.ts"

describe("buildResource", () => {
  const originalResAttrs = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  const originalServiceName = process.env["OTEL_SERVICE_NAME"]
  afterEach(() => {
    if (originalResAttrs === undefined) {
      delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    } else {
      process.env["OTEL_RESOURCE_ATTRIBUTES"] = originalResAttrs
    }
    if (originalServiceName === undefined) {
      delete process.env["OTEL_SERVICE_NAME"]
    } else {
      process.env["OTEL_SERVICE_NAME"] = originalServiceName
    }
  })

  test("includes service.name, app.version, os.type, host.arch", () => {
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    delete process.env["OTEL_SERVICE_NAME"]
    const resource = buildResource("1.2.3")
    const attrs = resource.attributes
    expect(attrs["service.name"]).toBe("opencode")
    expect(attrs["app.version"]).toBe("1.2.3")
    expect(attrs["os.type"]).toBe(process.platform)
    expect(attrs["host.arch"]).toBe(process.arch)
  })

  test("merges OTEL_RESOURCE_ATTRIBUTES from env", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    const resource = buildResource("0.0.1")
    const attrs = resource.attributes
    expect(attrs["team"]).toBe("platform")
    expect(attrs["env"]).toBe("prod")
  })

  test("trims whitespace in resource attributes", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = " team = platform "
    const resource = buildResource("0.0.1")
    expect(resource.attributes["team"]).toBe("platform")
  })

  test("env resource attributes override defaults", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=my-override"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["service.name"]).toBe("my-override")
  })
})
