// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import {
  ROOT_CONTEXT,
  trace,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import type * as httpTypes from "node:http";
import type * as httpsTypes from "node:https";

// Use createRequire to get the mutable CJS module.exports objects.
// ESM namespace objects (import * as X from ...) have non-configurable,
// non-writable property descriptors on Node.js built-in modules — you cannot
// reassign them.  CJS module.exports IS a plain object and is fully mutable,
// making it the correct target for monkey-patching in an ESM plugin.
const _require = createRequire(import.meta.url);
const httpModule  = _require("http")  as typeof httpTypes;
const httpsModule = _require("https") as typeof httpsTypes;

// ---------------------------------------------------------------------------
// Propagation store (per async-chain state)
// ---------------------------------------------------------------------------

interface PropagationStore {
  remoteParentContext?: Context;     // inbound: parsed upstream trace context
  outboundSpanContext?: SpanContext; // outbound: current Step span context
}

const propagationStore = new AsyncLocalStorage<PropagationStore>();

// ---------------------------------------------------------------------------
// W3C Trace Context helpers
// ---------------------------------------------------------------------------

// traceparent format: 00-{32-hex traceId}-{16-hex spanId}-{2-hex flags}
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function parseTraceparent(header: string): SpanContext | null {
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  const [, traceId, spanId, flags] = m;
  // Reject all-zero IDs (invalid per spec)
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
}

export function formatTraceparent(ctx: SpanContext): string {
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

// ---------------------------------------------------------------------------
// Store API (called from index.ts)
// ---------------------------------------------------------------------------

export function getRemoteParentContext(): Context | undefined {
  return propagationStore.getStore()?.remoteParentContext;
}

/** Replace the store with an empty object, clearing all fields. Primarily for testing. */
export function resetPropagationStore(): void {
  propagationStore.enterWith({});
}

/**
 * Merge-update the propagation store for the current async resource.
 * If no store exists yet (WebSocket path where HTTP patch didn't set one),
 * a fresh store is created via enterWith.
 */
export function updatePropagationStore(patch: Partial<PropagationStore>): void {
  const current = propagationStore.getStore();
  if (current) {
    Object.assign(current, patch);
  } else {
    propagationStore.enterWith({ ...patch });
  }
}

// ---------------------------------------------------------------------------
// HTTP Server patch — inbound traceparent extraction
// ---------------------------------------------------------------------------

let serverPatched = false;
// Capture at module load time before any patch is applied
const originalServerEmit = httpModule.Server.prototype.emit;

function patchHttpServer(): void {
  if (serverPatched) return;
  serverPatched = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (httpModule.Server.prototype as any).emit = function (event: string, ...args: unknown[]) {
    // 'request': plain HTTP; 'upgrade': WebSocket handshake
    if (event === "request" || event === "upgrade") {
      const req = args[0] as httpTypes.IncomingMessage;
      const tp = req.headers["traceparent"] as string | undefined;
      const store: PropagationStore = {};
      if (tp) {
        const spanCtx = parseTraceparent(tp);
        if (spanCtx) {
          // Build a remote parent OTel Context from the parsed span context
          store.remoteParentContext = trace.setSpanContext(ROOT_CONTEXT, spanCtx);
        }
      }
      // enterWith propagates this store to all async descendants of this
      // request's async resource — i.e. all hooks and the outbound LLM call.
      propagationStore.enterWith(store);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalServerEmit as any).apply(this, [event, ...args]);
  };
}

// ---------------------------------------------------------------------------
// HTTP/HTTPS Client patch — outbound traceparent injection
// ---------------------------------------------------------------------------

let clientPatched = false;
// Capture originals from the mutable CJS exports (no .bind — keeps reference identity for uninstall checks)
const origHttpsRequest = httpsModule.request as unknown as (...args: unknown[]) => httpTypes.ClientRequest;
const origHttpRequest  = httpModule.request  as unknown as (...args: unknown[]) => httpTypes.ClientRequest;

export function shouldInject(
  urlStr: string,
  targetUrls?: string[],
  excludeUrl?: string,
): boolean {
  if (excludeUrl && urlStr.includes(excludeUrl)) return false;
  if (!targetUrls || targetUrls.length === 0) return true;
  return targetUrls.some((p) => urlStr.includes(p));
}

/**
 * Wrap an http/https.request function to inject a traceparent header when
 * the propagation store has an outbound span context and the target URL
 * passes the filter.
 */
export function makeRequestPatch(
  original: (...args: unknown[]) => httpTypes.ClientRequest,
  targetUrls?: string[],
  excludeUrl?: string,
) {
  return function (
    this: unknown,
    urlOrOptions: unknown,
    optionsOrCb?: unknown,
    cb?: unknown,
  ): httpTypes.ClientRequest {
    // Normalise the three overload signatures:
    //   request(url, callback?)
    //   request(url, options, callback?)
    //   request(options, callback?)
    let urlStr = "";
    let opts: Record<string, unknown> = {};

    if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
      urlStr = urlOrOptions.toString();
      if (
        typeof optionsOrCb === "object" &&
        optionsOrCb !== null &&
        typeof optionsOrCb !== "function"
      ) {
        opts = optionsOrCb as Record<string, unknown>;
      } else if (typeof optionsOrCb === "function") {
        // request(url, callback) — no explicit options object; create one
        cb = optionsOrCb;
        optionsOrCb = {};
        opts = optionsOrCb as Record<string, unknown>;
      }
    } else if (typeof urlOrOptions === "object" && urlOrOptions !== null) {
      opts = urlOrOptions as Record<string, unknown>;
      urlStr =
        ((opts.protocol as string) || "https:") +
        "//" +
        ((opts.hostname as string) || (opts.host as string) || "") +
        ((opts.path as string) || "");
    }

    const store = propagationStore.getStore();
    const spanCtx = store?.outboundSpanContext;
    if (spanCtx && shouldInject(urlStr, targetUrls, excludeUrl)) {
      const existingHeaders = (opts.headers as Record<string, string>) || {};
      const patchedOpts = { ...opts, headers: { ...existingHeaders, traceparent: formatTraceparent(spanCtx) } };
      // Update the argument reference so original() receives the patched copy
      if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
        optionsOrCb = patchedOpts;
      } else {
        urlOrOptions = patchedOpts;
      }
    }

    return original.call(this, urlOrOptions, optionsOrCb, cb) as httpTypes.ClientRequest;
  };
}

function patchHttpClient(targetUrls?: string[], excludeUrl?: string): void {
  if (clientPatched) return;
  clientPatched = true;

  // Mutate the CJS module.exports directly (not the ESM namespace)
  (httpsModule as Record<string, unknown>)["request"] = makeRequestPatch(
    origHttpsRequest,
    targetUrls,
    excludeUrl,
  );
  (httpModule as Record<string, unknown>)["request"] = makeRequestPatch(
    origHttpRequest,
    targetUrls,
    excludeUrl,
  );
}

// ---------------------------------------------------------------------------
// Content-embedded OTel extraction (WebSocket path)
// ---------------------------------------------------------------------------

const MAX_CUSTOM_ATTR_COUNT = 20;
const MAX_CUSTOM_ATTR_KEY_LEN = 128;
const MAX_CUSTOM_ATTR_VALUE_LEN = 1024;
const RESERVED_ATTR_PREFIXES = ["openclaw.", "gen_ai."];
const OTEL_CONTENT_RE = /\n?<!--otel:(\{.*?\})-->$/s;

export interface OtelContentPayload {
  spanContext?: SpanContext;
  customAttributes?: Record<string, string | number | boolean>;
  cleanContent: string;
}

export function extractOtelFromContent(content: string): OtelContentPayload | null {
  const m = OTEL_CONTENT_RE.exec(content);
  if (!m) return null;

  let parsed: { tp?: string; attr?: Record<string, unknown> };
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const result: OtelContentPayload = {
    cleanContent: content.slice(0, m.index),
  };

  if (typeof parsed.tp === "string") {
    const spanCtx = parseTraceparent(parsed.tp);
    if (spanCtx) {
      result.spanContext = spanCtx;
    }
  }

  if (parsed.attr && typeof parsed.attr === "object" && !Array.isArray(parsed.attr)) {
    const attrs: Record<string, string | number | boolean> = {};
    let count = 0;
    for (const [key, value] of Object.entries(parsed.attr)) {
      if (count >= MAX_CUSTOM_ATTR_COUNT) break;
      if (key.length > MAX_CUSTOM_ATTR_KEY_LEN) continue;
      if (RESERVED_ATTR_PREFIXES.some((p) => key.startsWith(p))) continue;

      if (typeof value === "string") {
        attrs[key] = value.length > MAX_CUSTOM_ATTR_VALUE_LEN
          ? value.slice(0, MAX_CUSTOM_ATTR_VALUE_LEN)
          : value;
        count++;
      } else if (typeof value === "number" || typeof value === "boolean") {
        attrs[key] = value;
        count++;
      }
    }
    if (count > 0) {
      result.customAttributes = attrs;
    }
  }

  if (!result.spanContext && !result.customAttributes) return null;

  return result;
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

export interface PropagationConfig {
  /** URL substrings for outbound injection. Inject all if omitted. */
  targetUrls?: string[];
  /** URL substring to always exclude (OTLP endpoint). */
  excludeUrl?: string;
}

export function installPropagation(cfg: PropagationConfig): void {
  patchHttpServer();
  patchHttpClient(cfg.targetUrls, cfg.excludeUrl);
}

export function uninstallPropagation(): void {
  if (serverPatched) {
    httpModule.Server.prototype.emit = originalServerEmit;
    serverPatched = false;
  }
  if (clientPatched) {
    (httpsModule as Record<string, unknown>)["request"] = origHttpsRequest;
    (httpModule  as Record<string, unknown>)["request"] = origHttpRequest;
    clientPatched = false;
  }
}
