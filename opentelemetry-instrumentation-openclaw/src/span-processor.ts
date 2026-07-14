// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// Public helper API for authoring custom SpanProcessors, exposed via the
// package subpath:
//
//   import { defineGenAiSpanProcessor } from
//     "@loongsuite/opentelemetry-instrumentation-openclaw/span-processor";
//
// Goal: let users enrich spans by type without knowing OTel SDK internals or the
// semantic-convention dialect. `onEnding` is the recommended hook — at that point
// every attribute is populated AND the span is still writable.

import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

// The span-kind attribute name differs by dialect:
//   default (ALIBABA_CLOUD)      → "gen_ai.span.kind"
//   ALIBABA_GROUP / sunfire      → "gen_ai.span_kind_name"
// Users should not care — we probe both.
const SPAN_KIND_ATTR_KEYS = ["gen_ai.span.kind", "gen_ai.span_kind_name"] as const;

const ATTR_REQUEST_MODEL = "gen_ai.request.model";
const ATTR_TOOL_NAME = "gen_ai.tool.name";

/** Normalized, dialect-independent view of a GenAI span at `onEnding`. */
export interface GenAiSpanInfo {
  /** One of LLM / TOOL / AGENT / STEP / ENTRY, or undefined if not a GenAI span. */
  kind: string | undefined;
  /** Span name. */
  name: string;
  /** gen_ai.request.model, when present (mainly on LLM spans). */
  model?: string;
  /** gen_ai.tool.name, when present (mainly on TOOL spans). */
  toolName?: string;
}

/**
 * Type-dispatched hooks. All are optional; each fires at `onEnding` for its span
 * type, when the span is still writable and all attributes are populated.
 */
export interface GenAiSpanProcessorHooks {
  onLlmEnding?(span: Span, info: GenAiSpanInfo): void;
  onToolEnding?(span: Span, info: GenAiSpanInfo): void;
  onAgentEnding?(span: Span, info: GenAiSpanInfo): void;
  onStepEnding?(span: Span, info: GenAiSpanInfo): void;
  onEntryEnding?(span: Span, info: GenAiSpanInfo): void;
}

type SpanProcessorWithEnding = SpanProcessor & {
  onEnding?: (span: Span) => void;
};

function readStringAttr(
  attrs: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = attrs[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSpanInfo(span: Span | ReadableSpan): GenAiSpanInfo {
  const attrs = (span.attributes ?? {}) as Record<string, unknown>;
  let kind: string | undefined;
  for (const key of SPAN_KIND_ATTR_KEYS) {
    const value = readStringAttr(attrs, key);
    if (value) {
      kind = value;
      break;
    }
  }
  return {
    kind,
    name: span.name,
    model: readStringAttr(attrs, ATTR_REQUEST_MODEL),
    toolName: readStringAttr(attrs, ATTR_TOOL_NAME),
  };
}

/**
 * Build a SpanProcessor that dispatches to type-specific hooks at `onEnding`.
 *
 * @example
 * export default defineGenAiSpanProcessor({
 *   onLlmEnding(span, { model }) {
 *     span.setAttribute("business.cost_tier",
 *       model?.includes("gpt-4") ? "premium" : "standard");
 *   },
 *   onToolEnding(span, { toolName }) {
 *     span.setAttribute("business.tool_class",
 *       toolName?.startsWith("mcp_") ? "mcp" : "native");
 *   },
 * });
 */
export function defineGenAiSpanProcessor(
  hooks: GenAiSpanProcessorHooks,
): SpanProcessor {
  const onEnding = (span: Span): void => {
    const info = readSpanInfo(span);
    switch (info.kind) {
      case "LLM":
        hooks.onLlmEnding?.(span, info);
        break;
      case "TOOL":
        hooks.onToolEnding?.(span, info);
        break;
      case "AGENT":
        hooks.onAgentEnding?.(span, info);
        break;
      case "STEP":
        hooks.onStepEnding?.(span, info);
        break;
      case "ENTRY":
        hooks.onEntryEnding?.(span, info);
        break;
      default:
        break;
    }
  };

  const processor: SpanProcessorWithEnding = {
    onStart(): void {},
    onEnding,
    onEnd(): void {},
    forceFlush(): Promise<void> {
      return Promise.resolve();
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    },
  };
  return processor;
}

/**
 * Identity helper for authoring a raw SpanProcessor with full type hints.
 * Use this when you need lifecycle control beyond `defineGenAiSpanProcessor`.
 */
export function defineSpanProcessor(processor: SpanProcessor): SpanProcessor {
  return processor;
}

export type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
