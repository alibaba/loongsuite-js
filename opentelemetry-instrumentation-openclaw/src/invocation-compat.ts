// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
//
// Compatibility layer between util-genai output formats and the existing
// plugin's attribute conventions. Ensures attribute values remain identical
// after refactoring.

import type { LLMInvocation, GenAIInvocation } from "@loongsuite/opentelemetry-util-genai";
import {
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_SYSTEM_INSTRUCTIONS,
  GEN_AI_SPAN_KIND,
  GEN_AI_TOOL_DEFINITIONS,
} from "@loongsuite/opentelemetry-util-genai";

const MAX_ATTR_LENGTH = 3_200_000;

function truncateAttr(value: string): string {
  return value.length > MAX_ATTR_LENGTH
    ? value.substring(0, MAX_ATTR_LENGTH)
    : value;
}

/**
 * Force `gen_ai.response.finish_reasons` to be a JSON string (e.g. `'["stop"]'`).
 * The current plugin outputs this as a JSON-stringified array for OTLP
 * transport compatibility, but util-genai may produce a native array.
 */
export function compatFinishReasons(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const val = attrs[GEN_AI_RESPONSE_FINISH_REASONS];
  if (val !== undefined && typeof val !== "string") {
    attrs[GEN_AI_RESPONSE_FINISH_REASONS] = JSON.stringify(val);
  }
  return attrs;
}

/**
 * Serialize input/output/system messages in the plugin's own format,
 * bypassing util-genai's environment-variable-controlled content capturing.
 * The current plugin always records message content unconditionally.
 */
export function compatSerializeMessages(
  inv: LLMInvocation,
): Record<string, string> {
  const attrs: Record<string, string> = {};

  if (inv.systemInstruction && inv.systemInstruction.length > 0) {
    attrs[GEN_AI_SYSTEM_INSTRUCTIONS] = truncateAttr(
      JSON.stringify(inv.systemInstruction),
    );
  }

  if (inv.inputMessages && inv.inputMessages.length > 0) {
    attrs[GEN_AI_INPUT_MESSAGES] = truncateAttr(
      JSON.stringify(inv.inputMessages),
    );
  }

  if (inv.outputMessages && inv.outputMessages.length > 0) {
    const serialized = inv.outputMessages.map((msg) => ({
      role: msg.role,
      parts: msg.parts,
      finish_reason: msg.finishReason,
    }));
    attrs[GEN_AI_OUTPUT_MESSAGES] = truncateAttr(JSON.stringify(serialized));
  }

  return attrs;
}

/**
 * Serialize tool definitions unconditionally (matching this plugin's strategy
 * of always capturing content). The full definition including `description`
 * and `parameters` is included for `function`-type tools.
 *
 * NOTE: upstream `stopLlm` also writes `gen_ai.tool.definitions` via
 * `getToolDefinitionsForSpan()`, but that path is gated by experimental mode.
 * We write into `inv.attributes` which is applied AFTER the upstream call
 * in `stopLlm` (via `Object.assign(attrs, invocation.attributes)`),
 * ensuring our unconditional version takes precedence.
 */
export function compatSerializeToolDefinitions(
  inv: LLMInvocation,
): Record<string, string> {
  if (!inv.toolDefinitions?.length) return {};

  const dicts = inv.toolDefinitions.map((td) => {
    if (td.type === "function" && "description" in td) {
      return { type: td.type, name: td.name, description: td.description, parameters: (td as { parameters?: unknown }).parameters ?? null };
    }
    return { type: td.type, name: td.name };
  });
  return { [GEN_AI_TOOL_DEFINITIONS]: truncateAttr(JSON.stringify(dicts)) };
}

/**
 * Handle the semantic convention dialect for `gen_ai.span.kind`.
 *
 * Some OTLP backends expect `gen_ai.span_kind_name` instead of
 * `gen_ai.span.kind`. This function ensures the invocation's attributes
 * contain only the correct dialect key, preventing dual-key drift.
 *
 * @param inv The invocation whose attributes to patch
 * @param dialectAttrName The target attribute name (e.g. "gen_ai.span_kind_name")
 * @param spanKindValue The span kind value (e.g. "LLM", "AGENT", "ENTRY")
 */
export function compatSpanKindDialect(
  inv: GenAIInvocation,
  dialectAttrName: string,
  spanKindValue: string,
): void {
  if (!inv.attributes) {
    inv.attributes = {};
  }

  if (dialectAttrName === GEN_AI_SPAN_KIND) {
    return;
  }

  // Set the dialect key and remove the default key to ensure single-key output
  inv.attributes[dialectAttrName] = spanKindValue;
  inv.attributes[GEN_AI_SPAN_KIND] = undefined;
}
