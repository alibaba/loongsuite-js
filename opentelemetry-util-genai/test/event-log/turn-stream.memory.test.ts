import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { ExtendedTelemetryHandler } from "../../src/extended-handler.js";
import { createTurnStreamSession } from "../../src/event-log/turn-stream.js";
import type { EventLogRecord } from "../../src/event-log/types.js";
import { GEN_AI_SPAN_KIND, GenAiSpanKindValues } from "../../src/semconv/gen-ai-extended-attributes.js";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  ORIGINAL_ENV.OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  ORIGINAL_ENV.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "SPAN_ONLY";
});
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const GRACE = 2;
const KEEP = 1 + GRACE;
const RECORDS_PER_STEP = 2;
const MAX_PENDING = KEEP * RECORDS_PER_STEP; // 6

/** A SpanExporter that immediately discards spans (keeps memory flat). */
class NoopExporter {
  export(_spans: ReadableSpan[], cb: (r: ExportResult) => void): void { cb({ code: ExportResultCode.SUCCESS }); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

function handlerWith(exporter: InMemorySpanExporter | NoopExporter) {
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter as never)] });
  return new ExtendedTelemetryHandler({ tracerProvider: provider });
}

const TID = "aaaa0000aaaa0000aaaa0000aaaa0000";
/** One LLM-only step (request+response). `outPayload` inflates the response output (per-step, not accumulated). */
function stepRecords(i: number, outPayload = ""): EventLogRecord[] {
  const t = 1780000000000000000n + BigInt(i) * 1_000_000_000n;
  const base = {
    trace_id: TID, "gen_ai.session.id": "s", "gen_ai.turn.id": "s:t1", "user.id": "u",
    "gen_ai.agent.type": "claude-code", "gen_ai.provider.name": "anthropic",
  };
  const out = `[{"role":"assistant","parts":[{"type":"text","content":"r${i}${outPayload}"}],"finish_reason":"stop"}]`;
  return [
    { ...base, time_unix_nano: String(t), "event.id": `s${i}req`, "event.name": "llm.request", "gen_ai.step.id": `s:t1:s${i}`, "gen_ai.request.model": "opus", "gen_ai.input.messages_delta": `[{"role":"user","parts":[{"type":"text","content":"m${i}"}]}]` },
    { ...base, time_unix_nano: String(t + 500_000_000n), "event.id": `s${i}resp`, "event.name": "llm.response", "gen_ai.step.id": `s:t1:s${i}`, "gen_ai.request.model": "opus", "gen_ai.response.model": "opus", "gen_ai.response.id": `r${i}`, "gen_ai.response.finish_reasons": ["tool_calls"], "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5, "gen_ai.output.messages": out },
  ];
}
const byKind = (spans: ReadableSpan[], k: string) => spans.filter((s) => s.attributes[GEN_AI_SPAN_KIND] === k);

describe("TurnStreamSession — memory bounds", () => {
  it("A: finalizes+exports older steps incrementally; ENTRY stays open until end()", () => {
    const exporter = new InMemorySpanExporter();
    const session = createTurnStreamSession({ handler: handlerWith(exporter) });
    const N = 200;

    for (let i = 1; i <= N; i++) {
      session.push(stepRecords(i));
      const finished = exporter.getFinishedSpans();
      const expectedSteps = Math.max(0, i - KEEP); // last KEEP groups stay open
      expect(byKind(finished, GenAiSpanKindValues.STEP)).toHaveLength(expectedSteps);
      expect(byKind(finished, GenAiSpanKindValues.LLM)).toHaveLength(expectedSteps);
      expect(byKind(finished, GenAiSpanKindValues.ENTRY)).toHaveLength(0); // root still open
      expect(session.pendingRecordCount).toBeLessThanOrEqual(MAX_PENDING);
    }

    session.end();
    const all = exporter.getFinishedSpans();
    expect(byKind(all, GenAiSpanKindValues.ENTRY)).toHaveLength(1);
    expect(byKind(all, GenAiSpanKindValues.AGENT)).toHaveLength(1);
    expect(byKind(all, GenAiSpanKindValues.STEP)).toHaveLength(N);
    expect(byKind(all, GenAiSpanKindValues.LLM)).toHaveLength(N);
  });

  it("B1: parent-step buffer is bounded and independent of turn size", () => {
    const measure = (n: number): { maxPending: number; spanCount: number; lateDropped: number } => {
      const session = createTurnStreamSession({ handler: handlerWith(new NoopExporter()) });
      let maxPending = 0;
      for (let i = 1; i <= n; i++) {
        session.push(stepRecords(i));
        maxPending = Math.max(maxPending, session.pendingRecordCount);
      }
      const r = session.end();
      return { maxPending, spanCount: r.spanCount, lateDropped: r.lateDroppedRecordCount };
    };

    const small = measure(1000);
    const large = measure(5000);

    // Bounded by the grace window, regardless of turn size.
    expect(small.maxPending).toBeLessThanOrEqual(MAX_PENDING);
    expect(large.maxPending).toBeLessThanOrEqual(MAX_PENDING);
    // The unfinalized event window does not grow with turn size. Other compact
    // session state (finalized IDs and accumulated messages) is intentionally
    // linear in the turn size and is covered by the heap test below.
    expect(large.maxPending).toBe(small.maxPending);
    // No data lost, all spans produced.
    expect(small.spanCount).toBe(2 + 2 * 1000);
    expect(large.spanCount).toBe(2 + 2 * 5000);
    expect(small.lateDropped).toBe(0);
    expect(large.lateDropped).toBe(0);
  }, 30000);

  it.skipIf(!globalThis.gc)("B2: heap stays bounded under production config (BatchSpanProcessor + async)", async () => {
    const gc = globalThis.gc as () => void;
    const heapAfterGc = (): number => { gc(); gc(); return process.memoryUsage().heapUsed; };
    const PAYLOAD = "x".repeat(4096); // ~4KB per step

    // Mirrors the pilot: BatchSpanProcessor (bounded queue, frees on export) +
    // event-loop yields (real sendBatch is async / timer-driven). Measures the
    // session's live working set while the turn is still open.
    const retainedWhileOpen = async (n: number): Promise<number> => {
      const provider = new BasicTracerProvider({
        spanProcessors: [new BatchSpanProcessor(new NoopExporter() as never, { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5 })],
      });
      const session = createTurnStreamSession({ handler: new ExtendedTelemetryHandler({ tracerProvider: provider }) });
      for (let i = 1; i <= n; i++) {
        session.push(stepRecords(i, PAYLOAD));
        if (i % 200 === 0) await new Promise((r) => setImmediate(r)); // let the batch processor drain
      }
      await new Promise((r) => setTimeout(r, 50));
      const h = heapAfterGc();
      session.end();
      await provider.forceFlush();
      await provider.shutdown();
      return h;
    };

    const base = heapAfterGc();
    const r1 = (await retainedWhileOpen(1000)) - base;
    const r8 = (await retainedWhileOpen(8000)) - heapAfterGc();
    // eslint-disable-next-line no-console
    console.log("HEAP EVIDENCE (MB)", { r1MB: (r1 / 1048576).toFixed(1), r8MB: (r8 / 1048576).toFixed(1) });

    // A retained-all-spans blowup would be hundreds of MB (O(N²) with accumulated
    // input was ~1.8GB). Bounded working set stays tens of MB and does not scale.
    expect(r8).toBeLessThan(100 * 1048576);          // absolute bound
    expect(r8 - r1).toBeLessThan(50 * 1048576);       // ~flat: 8x steps ≠ 8x memory
  }, 30000);
});
