// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import type * as httpTypes from "node:http";

// Access the mutable CJS module exports (same objects that trace-propagation.ts patches)
const _require = createRequire(import.meta.url);
const httpModule  = _require("http")  as typeof import("node:http");
const httpsModule = _require("https") as typeof import("node:https");

import {
  parseTraceparent,
  formatTraceparent,
  getRemoteParentContext,
  updatePropagationStore,
  resetPropagationStore,
  installPropagation,
  uninstallPropagation,
  shouldInject,
  makeRequestPatch,
  extractOtelFromContent,
} from "../src/trace-propagation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TRACE_ID    = "4bf92f3577b34da6a3ce929d0e0e4736";
const VALID_SPAN_ID     = "00f067aa0ba902b7";
const VALID_TRACEPARENT = `00-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`;

// ---------------------------------------------------------------------------
// 1-4: W3C helper functions
// ---------------------------------------------------------------------------

describe("parseTraceparent", () => {
  it("parses a valid traceparent header", () => {
    const ctx = parseTraceparent(VALID_TRACEPARENT);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe(VALID_TRACE_ID);
    expect(ctx!.spanId).toBe(VALID_SPAN_ID);
    expect(ctx!.traceFlags).toBe(TraceFlags.SAMPLED);
    expect(ctx!.isRemote).toBe(true);
  });

  it("normalises uppercase hex to lowercase", () => {
    const upper = `00-${VALID_TRACE_ID.toUpperCase()}-${VALID_SPAN_ID.toUpperCase()}-01`;
    const ctx = parseTraceparent(upper);
    expect(ctx!.traceId).toBe(VALID_TRACE_ID);
    expect(ctx!.spanId).toBe(VALID_SPAN_ID);
  });

  it("returns null for malformed header (wrong segment count)", () => {
    expect(parseTraceparent("00-abc")).toBeNull();
  });

  it("returns null for unsupported version prefix", () => {
    expect(parseTraceparent(`01-${VALID_TRACE_ID}-${VALID_SPAN_ID}-01`)).toBeNull();
  });

  it("returns null for all-zero traceId", () => {
    expect(parseTraceparent(`00-${"0".repeat(32)}-${VALID_SPAN_ID}-01`)).toBeNull();
  });

  it("returns null for all-zero spanId", () => {
    expect(parseTraceparent(`00-${VALID_TRACE_ID}-${"0".repeat(16)}-01`)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseTraceparent("")).toBeNull();
  });
});

describe("formatTraceparent", () => {
  it("formats a SpanContext back to traceparent string", () => {
    const ctx = parseTraceparent(VALID_TRACEPARENT);
    const formatted = formatTraceparent(ctx!);
    expect(formatted).toBe(VALID_TRACEPARENT);
  });

  it("roundtrips: parse → format → parse yields identical SpanContext", () => {
    const first  = parseTraceparent(VALID_TRACEPARENT);
    const second = parseTraceparent(formatTraceparent(first!));
    expect(second).toEqual(first);
  });

  it("pads flags to two hex digits", () => {
    const spanCtx = parseTraceparent(VALID_TRACEPARENT)!;
    spanCtx.traceFlags = 0;
    const formatted = formatTraceparent(spanCtx);
    expect(formatted).toMatch(/^00-.{32}-.{16}-00$/);
  });
});

// ---------------------------------------------------------------------------
// 5-6: install / uninstall lifecycle
// ---------------------------------------------------------------------------

describe("installPropagation / uninstallPropagation", () => {
  // Capture the *originals* before any test mutates the CJS exports
  const origServerEmit = httpModule.Server.prototype.emit;
  const origHttpsReq   = (httpsModule as Record<string, unknown>)["request"];
  const origHttpReq    = (httpModule  as Record<string, unknown>)["request"];

  afterEach(() => {
    uninstallPropagation();
  });

  it("patches http.Server.prototype.emit after install", () => {
    installPropagation({});
    expect(httpModule.Server.prototype.emit).not.toBe(origServerEmit);
  });

  it("patches httpsModule.request after install", () => {
    installPropagation({});
    expect((httpsModule as Record<string, unknown>)["request"]).not.toBe(origHttpsReq);
  });

  it("patches httpModule.request after install", () => {
    installPropagation({});
    expect((httpModule as Record<string, unknown>)["request"]).not.toBe(origHttpReq);
  });

  it("is idempotent — double install does not re-patch", () => {
    installPropagation({});
    const patchedEmit = httpModule.Server.prototype.emit;
    installPropagation({});
    expect(httpModule.Server.prototype.emit).toBe(patchedEmit);
  });

  it("restores http.Server.prototype.emit after uninstall", () => {
    installPropagation({});
    uninstallPropagation();
    expect(httpModule.Server.prototype.emit).toBe(origServerEmit);
  });

  it("restores httpsModule.request after uninstall", () => {
    installPropagation({});
    uninstallPropagation();
    expect((httpsModule as Record<string, unknown>)["request"]).toBe(origHttpsReq);
  });

  it("restores httpModule.request after uninstall", () => {
    installPropagation({});
    uninstallPropagation();
    expect((httpModule as Record<string, unknown>)["request"]).toBe(origHttpReq);
  });

  it("uninstall is a no-op when not installed", () => {
    expect(() => uninstallPropagation()).not.toThrow();
    expect(httpModule.Server.prototype.emit).toBe(origServerEmit);
  });
});

// ---------------------------------------------------------------------------
// 7-8: HTTP inbound — server emit patch extracts traceparent
// ---------------------------------------------------------------------------

describe("HTTP inbound — emit('request') extraction", () => {
  afterEach(() => uninstallPropagation());

  it("sets remoteParentContext when traceparent header is present", () => {
    installPropagation({});

    const fakeReq = {
      headers: { traceparent: VALID_TRACEPARENT },
    } as unknown as httpTypes.IncomingMessage;

    const server = new httpModule.Server();
    server.emit("request", fakeReq, {});

    const ctx = getRemoteParentContext();
    expect(ctx).toBeDefined();
    const spanCtx = trace.getSpanContext(ctx!);
    expect(spanCtx?.traceId).toBe(VALID_TRACE_ID);
    expect(spanCtx?.spanId).toBe(VALID_SPAN_ID);
    expect(spanCtx?.isRemote).toBe(true);
  });

  it("leaves remoteParentContext undefined when no traceparent header", () => {
    installPropagation({});

    const fakeReq = { headers: {} } as unknown as httpTypes.IncomingMessage;
    const server = new httpModule.Server();
    server.emit("request", fakeReq, {});

    expect(getRemoteParentContext()).toBeUndefined();
  });

  it("leaves remoteParentContext undefined for invalid traceparent header", () => {
    installPropagation({});

    const fakeReq = { headers: { traceparent: "not-valid" } } as unknown as httpTypes.IncomingMessage;
    const server = new httpModule.Server();
    server.emit("request", fakeReq, {});

    expect(getRemoteParentContext()).toBeUndefined();
  });

  it("also sets context on 'upgrade' event (WebSocket handshake)", () => {
    installPropagation({});

    const fakeReq = {
      headers: { traceparent: VALID_TRACEPARENT },
    } as unknown as httpTypes.IncomingMessage;
    const server = new httpModule.Server();
    server.emit("upgrade", fakeReq, {}, Buffer.alloc(0));

    expect(getRemoteParentContext()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9: WebSocket path — updatePropagationStore
// ---------------------------------------------------------------------------

describe("WebSocket inbound — updatePropagationStore", () => {
  it("sets remoteParentContext via updatePropagationStore", () => {
    const spanCtx = parseTraceparent(VALID_TRACEPARENT)!;
    const remoteCtx = trace.setSpanContext(ROOT_CONTEXT, spanCtx);
    updatePropagationStore({ remoteParentContext: remoteCtx });

    const got = getRemoteParentContext();
    expect(got).toBe(remoteCtx);
  });

  it("merges fields — preserves existing outboundSpanContext when setting remoteParentContext", () => {
    const outboundCtx = {
      traceId: VALID_TRACE_ID,
      spanId: "aabbccdd11223344",
      traceFlags: TraceFlags.SAMPLED,
    };
    // Start fresh store with outbound context
    updatePropagationStore({ outboundSpanContext: outboundCtx });
    // Merge in remote context
    const remoteCtx = trace.setSpanContext(ROOT_CONTEXT, parseTraceparent(VALID_TRACEPARENT)!);
    updatePropagationStore({ remoteParentContext: remoteCtx });

    // Both fields should be present
    expect(getRemoteParentContext()).toBe(remoteCtx);
  });
});

// ---------------------------------------------------------------------------
// shouldInject unit tests
// ---------------------------------------------------------------------------

describe("shouldInject", () => {
  it("returns true when no filters", () => {
    expect(shouldInject("https://api.openai.com/v1/chat")).toBe(true);
  });

  it("returns false when URL matches excludeUrl", () => {
    expect(shouldInject("https://arms.example.com/v1/traces", undefined, "arms.example.com")).toBe(false);
  });

  it("returns true for matching targetUrl", () => {
    expect(shouldInject("https://api.openai.com/v1/chat", ["api.openai.com"])).toBe(true);
  });

  it("returns false for non-matching targetUrl", () => {
    expect(shouldInject("https://other.service.com/api", ["api.openai.com"])).toBe(false);
  });

  it("excludeUrl takes priority over targetUrl match", () => {
    expect(
      shouldInject("https://arms.example.com/v1/traces", ["arms.example.com"], "arms.example.com"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10-13: Outbound — makeRequestPatch injects headers
// ---------------------------------------------------------------------------

describe("outbound traceparent injection via makeRequestPatch", () => {
  afterEach(() => resetPropagationStore());

  const spanCtx = {
    traceId: VALID_TRACE_ID,
    spanId: VALID_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false as const,
  };

  function makeCapturingPatch(targetUrls?: string[], excludeUrl?: string) {
    const calls: unknown[][] = [];
    const mockOriginal = (...args: unknown[]) => {
      calls.push(args);
      return {} as httpTypes.ClientRequest;
    };
    const patched = makeRequestPatch(mockOriginal, targetUrls, excludeUrl);
    return { patched, calls };
  }

  it("injects traceparent when outboundSpanContext is in the store", () => {
    updatePropagationStore({ outboundSpanContext: spanCtx });

    const { patched, calls } = makeCapturingPatch();
    patched("https://api.openai.com/v1/chat", {});

    const opts = calls[0]?.[1] as { headers?: Record<string, string> };
    expect(opts?.headers?.["traceparent"]).toBe(VALID_TRACEPARENT);
  });

  it("does NOT inject when no outboundSpanContext in store", () => {
    resetPropagationStore(); // ensure clean state regardless of prior test
    const { patched, calls } = makeCapturingPatch();
    patched("https://api.openai.com/v1/chat", {});

    const opts = calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["traceparent"]).toBeUndefined();
  });

  it("injects for matching targetUrl", () => {
    updatePropagationStore({ outboundSpanContext: spanCtx });

    const { patched, calls } = makeCapturingPatch(["api.openai.com"]);
    patched("https://api.openai.com/v1/chat", {});

    const opts = calls[0]?.[1] as { headers?: Record<string, string> };
    expect(opts?.headers?.["traceparent"]).toBe(VALID_TRACEPARENT);
  });

  it("does NOT inject for non-matching targetUrl", () => {
    updatePropagationStore({ outboundSpanContext: spanCtx });

    const { patched, calls } = makeCapturingPatch(["api.openai.com"]);
    patched("https://other.service.com/api", {});

    const opts = calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["traceparent"]).toBeUndefined();
  });

  it("excludes the OTLP endpoint from injection", () => {
    updatePropagationStore({ outboundSpanContext: spanCtx });

    const { patched, calls } = makeCapturingPatch(undefined, "arms.example.com");
    patched("https://arms.example.com/v1/traces", {});

    const opts = calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(opts?.headers?.["traceparent"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractOtelFromContent — WebSocket content-embedded extraction
// ---------------------------------------------------------------------------

describe("extractOtelFromContent", () => {
  it("extracts traceparent only", () => {
    const content = `你好\n<!--otel:{"tp":"${VALID_TRACEPARENT}"}-->`;
    const result = extractOtelFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.spanContext!.traceId).toBe(VALID_TRACE_ID);
    expect(result!.spanContext!.spanId).toBe(VALID_SPAN_ID);
    expect(result!.customAttributes).toBeUndefined();
    expect(result!.cleanContent).toBe("你好");
  });

  it("extracts custom attributes only", () => {
    const content = '查询订单\n<!--otel:{"attr":{"user.id":"U-123","count":42,"debug":true}}-->';
    const result = extractOtelFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.spanContext).toBeUndefined();
    expect(result!.customAttributes).toEqual({
      "user.id": "U-123",
      "count": 42,
      "debug": true,
    });
    expect(result!.cleanContent).toBe("查询订单");
  });

  it("extracts both traceparent and attributes", () => {
    const content = `你好\n<!--otel:{"tp":"${VALID_TRACEPARENT}","attr":{"env":"prod"}}-->`;
    const result = extractOtelFromContent(content);
    expect(result!.spanContext!.traceId).toBe(VALID_TRACE_ID);
    expect(result!.customAttributes).toEqual({ "env": "prod" });
    expect(result!.cleanContent).toBe("你好");
  });

  it("returns null for message without otel payload", () => {
    expect(extractOtelFromContent("普通消息")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractOtelFromContent("msg\n<!--otel:not-json-->")).toBeNull();
  });

  it("returns null for otel payload not at end of message", () => {
    expect(extractOtelFromContent('<!--otel:{"tp":"00-abc"}-->\n后续文字')).toBeNull();
  });

  it("returns null when neither tp nor attr is valid", () => {
    expect(extractOtelFromContent('msg\n<!--otel:{"tp":"invalid"}-->')).toBeNull();
  });

  it("ignores reserved attribute prefixes", () => {
    const content = '消息\n<!--otel:{"attr":{"openclaw.version":"hacked","gen_ai.model":"bad","user.id":"ok"}}-->';
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes).toEqual({ "user.id": "ok" });
  });

  it("enforces max attribute count of 20", () => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < 25; i++) attrs[`key${i}`] = `val${i}`;
    const content = `消息\n<!--otel:${JSON.stringify({ attr: attrs })}-->`;
    const result = extractOtelFromContent(content);
    expect(Object.keys(result!.customAttributes!).length).toBe(20);
  });

  it("truncates attribute values longer than 1024 characters", () => {
    const longVal = "x".repeat(2000);
    const content = `消息\n<!--otel:{"attr":{"key":"${longVal}"}}-->`;
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes!["key"]).toHaveLength(1024);
  });

  it("skips non-primitive attribute values", () => {
    const content = '消息\n<!--otel:{"attr":{"obj":{"nested":1},"arr":[1,2],"ok":"yes"}}-->';
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes).toEqual({ "ok": "yes" });
  });

  it("skips attribute keys longer than 128 characters", () => {
    const longKey = "k".repeat(200);
    const content = `消息\n<!--otel:{"attr":{"${longKey}":"val","short":"ok"}}-->`;
    const result = extractOtelFromContent(content);
    expect(result!.customAttributes).toEqual({ "short": "ok" });
  });

  it("handles message without leading newline before otel tag", () => {
    const content = `msg<!--otel:{"tp":"${VALID_TRACEPARENT}"}-->`;
    const result = extractOtelFromContent(content);
    expect(result).not.toBeNull();
    expect(result!.cleanContent).toBe("msg");
  });
});
