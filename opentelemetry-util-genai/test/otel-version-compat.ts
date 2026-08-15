import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Read a parent span ID from the version-specific ReadableSpan shape. */
export function getReadableSpanParentId(span: ReadableSpan): string | undefined {
  const compatible = span as unknown as {
    parentSpanId?: string;
    parentSpanContext?: { spanId: string };
  };
  return compatible.parentSpanContext?.spanId ?? compatible.parentSpanId;
}
