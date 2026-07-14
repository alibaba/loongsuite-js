// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the custom SpanProcessor injection feature:
//   - defineGenAiSpanProcessor: type dispatch, dialect tolerance, field extraction
//   - loadUserSpanProcessor: graceful degradation + runtime isolation

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGenAiSpanProcessor } from "../src/span-processor.js";
import { loadUserSpanProcessor } from "../src/span-processor-loader.js";
import type { OpenClawPluginApi } from "../src/types.js";

// A minimal writable span stand-in matching what the SDK passes at onEnding.
function fakeSpan(attributes: Record<string, unknown>, name = "span") {
  return {
    attributes,
    name,
    setAttribute(key: string, value: unknown) {
      this.attributes[key] = value;
      return this;
    },
  };
}

// Cast helper: onEnding is experimental and absent from the public type.
function callOnEnding(processor: unknown, span: unknown): void {
  (processor as { onEnding?: (s: unknown) => void }).onEnding?.(span);
}

function mockApi(): OpenClawPluginApi {
  return {
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

describe("defineGenAiSpanProcessor", () => {
  it("dispatches LLM spans to onLlmEnding with extracted model", () => {
    const seen: Array<[string, string | undefined]> = [];
    const processor = defineGenAiSpanProcessor({
      onLlmEnding(span, info) {
        seen.push(["llm", info.model]);
        span.setAttribute("business.cost_tier", "premium");
      },
      onToolEnding() {
        seen.push(["tool", undefined]);
      },
    });

    const span = fakeSpan({
      "gen_ai.span.kind": "LLM",
      "gen_ai.request.model": "deepseek-v4",
    });
    callOnEnding(processor, span);

    expect(seen).toEqual([["llm", "deepseek-v4"]]);
    expect(span.attributes["business.cost_tier"]).toBe("premium");
  });

  it("is dialect tolerant: reads gen_ai.span_kind_name and tool name", () => {
    const toolNames: Array<string | undefined> = [];
    const processor = defineGenAiSpanProcessor({
      onToolEnding(_span, info) {
        toolNames.push(info.toolName);
      },
    });

    callOnEnding(
      processor,
      fakeSpan({ "gen_ai.span_kind_name": "TOOL", "gen_ai.tool.name": "Bash" }),
    );

    expect(toolNames).toEqual(["Bash"]);
  });

  it("does not fire any hook for a non-GenAI / unknown-kind span", () => {
    const fn = vi.fn();
    const processor = defineGenAiSpanProcessor({
      onLlmEnding: fn,
      onToolEnding: fn,
      onAgentEnding: fn,
    });

    callOnEnding(processor, fakeSpan({}));
    callOnEnding(processor, fakeSpan({ "gen_ai.span.kind": "SESSION" }));

    expect(fn).not.toHaveBeenCalled();
  });
});

describe("loadUserSpanProcessor", () => {
  it("returns null and logs error when the module path does not exist", async () => {
    const api = mockApi();
    const result = await loadUserSpanProcessor(
      "/definitely/not/here/proc.mjs",
      api,
    );
    expect(result).toBeNull();
    expect(api.logger.error).toHaveBeenCalled();
  });

  it("returns null when default export is not a SpanProcessor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spp-bad-"));
    const file = join(dir, "bad.mjs");
    writeFileSync(file, "export default { notAProcessor: true };");

    const api = mockApi();
    const result = await loadUserSpanProcessor(file, api);

    expect(result).toBeNull();
    expect(api.logger.error).toHaveBeenCalled();
  });

  it("loads a valid processor and isolates runtime errors in onEnding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spp-good-"));
    const file = join(dir, "good.mjs");
    writeFileSync(
      file,
      [
        "export default {",
        "  onStart() {},",
        "  onEnding() { throw new Error('boom'); },",
        "  onEnd() {},",
        "  forceFlush() { return Promise.resolve(); },",
        "  shutdown() { return Promise.resolve(); },",
        "};",
      ].join("\n"),
    );

    const api = mockApi();
    const processor = await loadUserSpanProcessor(file, api);

    expect(processor).not.toBeNull();
    expect(api.logger.info).toHaveBeenCalled();
    // A throwing user callback must be swallowed, not propagated.
    expect(() => callOnEnding(processor, fakeSpan({}))).not.toThrow();
    expect(api.logger.warn).toHaveBeenCalled();
  });
});
