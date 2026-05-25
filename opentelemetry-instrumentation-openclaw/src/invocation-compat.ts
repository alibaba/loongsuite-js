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
