import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { ExtendedTelemetryHandler } from "../../src/extended-handler.js";
import { convertEventLogToTrace } from "../../src/event-log/converter.js";
import { createTurnStreamSession } from "../../src/event-log/turn-stream.js";
import { EventName, EventLogConversionError, type EventLogRecord } from "../../src/event-log/types.js";
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SPAN_KIND,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_RESPONSE_ID,
  GenAiSpanKindValues,
} from "../../src/semconv/gen-ai-extended-attributes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): EventLogRecord[] {
  return JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf-8"));
}

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

function makeHarness() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
  return { exporter, provider, handler };
}
const byKind = (spans: ReadableSpan[], k: string) =>
  spans.filter((s) => s.attributes[GEN_AI_SPAN_KIND] === k);
const spanOf = (spans: ReadableSpan[], k: string) => byKind(spans, k)[0]!;

/** Run the batch converter and return finished spans + warnings. */
async function runBatch(records: EventLogRecord[]): Promise<{ spans: ReadableSpan[]; warnings: string[] }> {
  const { exporter, provider, handler } = makeHarness();
  const r = convertEventLogToTrace(records, { handler });
  await provider.forceFlush();
  return { spans: exporter.getFinishedSpans(), warnings: r.warnings };
}

/** Run the streaming session over a push plan and return finished spans. */
async function runStream(pushes: EventLogRecord[][]): Promise<{ spans: ReadableSpan[]; warnings: string[]; provider: BasicTracerProvider; exporter: InMemorySpanExporter }> {
  const { exporter, provider, handler } = makeHarness();
  const s = createTurnStreamSession({ handler });
  for (const p of pushes) s.push(p);
  s.end();
  await provider.forceFlush();
  return { spans: exporter.getFinishedSpans(), warnings: s.warnings, provider, exporter };
}

function kindCounts(spans: ReadableSpan[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of spans) {
    const k = String(s.attributes[GEN_AI_SPAN_KIND]);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// Multi-step turn with tokens (2 plain steps, no subagent).
function twoStepFixture(): EventLogRecord[] {
  const tid = "ccdd000000000000ccdd000000000000";
  const base = (over: Record<string, unknown>): EventLogRecord => ({
    trace_id: tid,
    "gen_ai.session.id": "s",
    "gen_ai.turn.id": "s:t1",
    "user.id": "u1",
    "gen_ai.agent.type": "claude-code",
    "gen_ai.provider.name": "anthropic",
    ...over,
  });
  return [
    base({ time_unix_nano: "1780000001000000000", "event.id": "s1req", "event.name": "llm.request", "gen_ai.step.id": "s:t1:s1", "gen_ai.request.model": "opus", "gen_ai.input.messages_delta": '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]' }),
    base({ time_unix_nano: "1780000002000000000", "event.id": "s1resp", "event.name": "llm.response", "gen_ai.step.id": "s:t1:s1", "gen_ai.request.model": "opus", "gen_ai.response.model": "opus", "gen_ai.response.id": "r1", "gen_ai.response.finish_reasons": ["tool_calls"], "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5, "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"ok"}],"finish_reason":"tool_calls"}]' }),
    base({ time_unix_nano: "1780000003000000000", "event.id": "s2req", "event.name": "llm.request", "gen_ai.step.id": "s:t1:s2", "gen_ai.request.model": "opus", "gen_ai.input.messages_delta": '[{"role":"user","parts":[{"type":"text","content":"more"}]}]' }),
    base({ time_unix_nano: "1780000004000000000", "event.id": "s2resp", "event.name": "llm.response", "gen_ai.step.id": "s:t1:s2", "gen_ai.request.model": "opus", "gen_ai.response.model": "opus", "gen_ai.response.id": "r2", "gen_ai.response.finish_reasons": ["stop"], "gen_ai.usage.input_tokens": 20, "gen_ai.usage.output_tokens": 8, "gen_ai.output.messages": '[{"role":"assistant","parts":[{"type":"text","content":"done"}],"finish_reason":"stop"}]' }),
  ];
}

// N plain LLM-only steps (2 records each: request + response), one turn.
function nStepTurn(n: number, tid = "dddd000000000000dddd000000000000"): EventLogRecord[] {
  const base = (over: Record<string, unknown>): EventLogRecord => ({
    trace_id: tid, "gen_ai.session.id": "s", "gen_ai.turn.id": "s:t1",
    "user.id": "u1", "gen_ai.agent.type": "claude-code", "gen_ai.provider.name": "anthropic", ...over,
  });
  const out: EventLogRecord[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(base({ time_unix_nano: `17800000${String(i).padStart(2, "0")}00000000`, "event.id": `s${i}req`, "event.name": "llm.request", "gen_ai.step.id": `s:t1:s${i}`, "gen_ai.request.model": "opus", "gen_ai.input.messages_delta": `[{"role":"user","parts":[{"type":"text","content":"m${i}"}]}]` }));
    out.push(base({ time_unix_nano: `17800000${String(i).padStart(2, "0")}50000000`, "event.id": `s${i}resp`, "event.name": "llm.response", "gen_ai.step.id": `s:t1:s${i}`, "gen_ai.request.model": "opus", "gen_ai.response.model": "opus", "gen_ai.response.id": `r${i}`, "gen_ai.response.finish_reasons": [i === n ? "stop" : "tool_calls"], "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5 }));
  }
  return out;
}

describe("TurnStreamSession", () => {
  it("finalizes older steps incrementally once the grace window (K=2) is exceeded", async () => {
    const { exporter, provider, handler } = makeHarness();
    const recs = nStepTurn(4); // s1..s4
    const byStep = (i: number) => [recs[(i - 1) * 2]!, recs[(i - 1) * 2 + 1]!];
    const s = createTurnStreamSession({ handler }); // default graceSteps=2 → keep last 3 groups

    s.push([...byStep(1), ...byStep(2), ...byStep(3)]);
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(0); // 3 groups ≤ keep(3) → nothing finalized

    s.push([recs[6]!]); // s4 request → 4 groups → s1 (oldest) finalized
    await provider.forceFlush();
    const mid = exporter.getFinishedSpans();
    expect(byKind(mid, GenAiSpanKindValues.STEP)).toHaveLength(1); // only s1 emitted
    expect(byKind(mid, GenAiSpanKindValues.LLM)).toHaveLength(1);
    expect(byKind(mid, GenAiSpanKindValues.ENTRY)).toHaveLength(0); // ENTRY still open

    s.push([recs[7]!]); // s4 response
    const r = s.end();
    await provider.forceFlush();
    const all = exporter.getFinishedSpans();
    expect(byKind(all, GenAiSpanKindValues.ENTRY)).toHaveLength(1);
    expect(byKind(all, GenAiSpanKindValues.STEP)).toHaveLength(4);
    expect(byKind(all, GenAiSpanKindValues.LLM)).toHaveLength(4);
    expect(r.lateDroppedRecordCount).toBe(0);
    expect(new Set(all.map((x) => x.spanContext().traceId)).size).toBe(1);
  });

  // The observed Claude same-millisecond pattern: s1's trailing tool.result is
  // delivered ONE push AFTER s2 already started, across push boundaries. With
  // >(1+grace) steps, s1 gets finalized mid-stream, so a too-small grace drops
  // the late tool.result. Replays 4 steps where s1's tool.result trails s2.
  async function replayInterleaved(graceSteps: number) {
    const { exporter, provider, handler } = makeHarness();
    const tid = "eeee000000000000eeee000000000000";
    const r = (over: Record<string, unknown>): EventLogRecord => ({
      trace_id: tid, "gen_ai.session.id": "s", "gen_ai.turn.id": "s:t1", "user.id": "u",
      "gen_ai.agent.type": "claude-code", "gen_ai.provider.name": "anthropic", ...over,
    });
    const s = createTurnStreamSession({ handler, graceSteps });
    const llm = (step: string, t: string, fin: string) => [
      r({ time_unix_nano: `${t}000000`, "event.name": "llm.request", "gen_ai.step.id": step, "gen_ai.request.model": "opus" }),
      r({ time_unix_nano: `${t}500000`, "event.name": "llm.response", "gen_ai.step.id": step, "gen_ai.response.id": step, "gen_ai.request.model": "opus", "gen_ai.response.finish_reasons": [fin], "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 2 }),
    ];
    // s1: llm + tool.call (tool.result comes later)
    for (const rec of llm("s:t1:s1", "1780000001", "tool_calls")) s.push([rec]);
    s.push([r({ time_unix_nano: "1780000002500000", "event.name": "tool.call", "gen_ai.step.id": "s:t1:s1", "gen_ai.tool.name": "Bash", "gen_ai.tool.call.id": "c1" })]);
    // s2 starts, THEN s1's tool.result arrives (distance-1 interleave)
    s.push([r({ time_unix_nano: "1780000003000000", "event.name": "llm.request", "gen_ai.step.id": "s:t1:s2", "gen_ai.request.model": "opus" })]);
    s.push([r({ time_unix_nano: "1780000003000000", "event.name": "tool.result", "gen_ai.step.id": "s:t1:s1", "gen_ai.tool.name": "Bash", "gen_ai.tool.call.id": "c1" })]);
    s.push([r({ time_unix_nano: "1780000004500000", "event.name": "llm.response", "gen_ai.step.id": "s:t1:s2", "gen_ai.response.id": "s:t1:s2", "gen_ai.request.model": "opus", "gen_ai.response.finish_reasons": ["tool_calls"], "gen_ai.usage.input_tokens": 5, "gen_ai.usage.output_tokens": 2 })]);
    // s3, s4 push s1 out of a small grace window
    for (const rec of llm("s:t1:s3", "1780000005", "tool_calls")) s.push([rec]);
    for (const rec of llm("s:t1:s4", "1780000006", "stop")) s.push([rec]);
    const res = s.end();
    await provider.forceFlush();
    return { res, spans: exporter.getFinishedSpans() };
  }

  it("grace window (K=2) tolerates distance-1 cross-batch interleaving; K=0 drops it", async () => {
    // Default grace (2): the late tool.result is still within the window → kept.
    const ok = await replayInterleaved(2);
    expect(ok.res.lateDroppedRecordCount).toBe(0);
    expect(byKind(ok.spans, GenAiSpanKindValues.TOOL)).toHaveLength(1); // paired, not dropped
    const tool = spanOf(ok.spans, GenAiSpanKindValues.TOOL);
    const dur = tool.endTime[0] * 1e9 + tool.endTime[1] - (tool.startTime[0] * 1e9 + tool.startTime[1]);
    expect(dur).toBeGreaterThan(0);

    // No grace (0): s1 finalized as soon as s2 appears → its late tool.result dropped.
    const bad = await replayInterleaved(0);
    expect(bad.res.lateDroppedRecordCount).toBeGreaterThan(0);
    expect(bad.res.warnings.some((w) => w.includes("LATE_STEP_DROP"))).toBe(true);
  });

  it("nests subagent correctly when input is fragmented across pushes", async () => {
    const recs = loadFixture("subagent-simple");
    const { spans } = await runStream([
      [recs[0]!, recs[1]!, recs[2]!], // p-req, p-resp, p-tool-call
      [recs[3]!, recs[4]!],           // subagent children
      [recs[5]!],                     // p-tool-result
    ]);

    expect(byKind(spans, GenAiSpanKindValues.ENTRY)).toHaveLength(1);
    expect(byKind(spans, GenAiSpanKindValues.AGENT)).toHaveLength(2);
    expect(byKind(spans, GenAiSpanKindValues.TOOL)).toHaveLength(1);
    expect(spans).toHaveLength(8);

    const tool = spanOf(spans, GenAiSpanKindValues.TOOL);
    const childAgent = byKind(spans, GenAiSpanKindValues.AGENT).find(
      (a) => a.attributes[GEN_AI_AGENT_NAME] === "child-agent",
    )!;
    expect(childAgent.parentSpanId).toBe(tool.spanContext().spanId);
    const childLlm = byKind(spans, GenAiSpanKindValues.LLM).find(
      (l) => l.attributes[GEN_AI_REQUEST_MODEL] === "claude-haiku",
    )!;
    const childStep = byKind(spans, GenAiSpanKindValues.STEP).find(
      (st) => st.parentSpanId === childAgent.spanContext().spanId,
    )!;
    expect(childLlm.parentSpanId).toBe(childStep.spanContext().spanId);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it("counts + warns on late records beyond the grace window (no duplicate subtree)", async () => {
    const { exporter, provider, handler } = makeHarness();
    const [s1req, s1resp, s2req, s2resp] = twoStepFixture();
    // graceSteps=0 → s1 finalized as soon as s2 appears, so a later s1 record is dropped.
    const s = createTurnStreamSession({ handler, graceSteps: 0 });
    s.push([s1req!, s1resp!]);
    s.push([s2req!, s2resp!]); // finalizes s1 (keep last 1 group)
    // Late arrival for s1 after it was finalized (beyond grace window).
    s.push([{ ...s1resp!, "event.id": "s1resp-late" }]);
    const r = s.end();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(byKind(spans, GenAiSpanKindValues.STEP)).toHaveLength(2); // not 3
    expect(r.lateDroppedRecordCount).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes("LATE_STEP_DROP"))).toBe(true);
  });

  describe("equivalence with batch convertEventLogToTrace", () => {
    const cases: Array<{ name: string; records: () => EventLogRecord[] }> = [
      { name: "single-turn-simple", records: () => loadFixture("single-turn-simple") },
      { name: "subagent-simple", records: () => loadFixture("subagent-simple") },
      { name: "two-step", records: twoStepFixture },
    ];

    for (const c of cases) {
      it(`single-push+end matches batch: ${c.name}`, async () => {
        const records = c.records();
        const { spans: batch, warnings: bWarn } = await runBatch(records);
        const { spans: stream, warnings: sWarn } = await runStream([records]);

        // Same span-kind population.
        expect(kindCounts(stream)).toEqual(kindCounts(batch));

        // AGENT token aggregates identical.
        const ba = spanOf(batch, GenAiSpanKindValues.AGENT);
        const sa = spanOf(stream, GenAiSpanKindValues.AGENT);
        for (const attr of [GEN_AI_USAGE_INPUT_TOKENS, GEN_AI_USAGE_OUTPUT_TOKENS, GEN_AI_USAGE_TOTAL_TOKENS]) {
          expect(sa.attributes[attr]).toBe(ba.attributes[attr]);
        }

        // Every non-ENTRY span resolves its parent within the same trace.
        const ids = new Set(stream.map((s) => s.spanContext().spanId));
        for (const s of stream) {
          if (s.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.ENTRY) continue;
          expect(ids.has(s.parentSpanId!)).toBe(true);
        }

        // LLM input.messages must match batch exactly — locks delta/full
        // accumulation semantics (matched by response.id).
        const llmInputById = (arr: ReadableSpan[]) =>
          new Map(
            byKind(arr, GenAiSpanKindValues.LLM).map((s) => [
              String(s.attributes[GEN_AI_RESPONSE_ID]),
              s.attributes[GEN_AI_INPUT_MESSAGES],
            ]),
          );
        const bIn = llmInputById(batch);
        const sIn = llmInputById(stream);
        expect([...sIn.keys()].sort()).toEqual([...bIn.keys()].sort());
        for (const [id, msgs] of sIn) expect(msgs).toEqual(bIn.get(id));

        // ENTRY/AGENT start time identical (turnStartMs includes user/child records).
        for (const kind of [GenAiSpanKindValues.ENTRY, GenAiSpanKindValues.AGENT]) {
          expect(spanOf(stream, kind).startTime).toEqual(spanOf(batch, kind).startTime);
        }

        // Warning sets identical.
        expect([...sWarn].sort()).toEqual([...bWarn].sort());
      });
    }

    it("fragmented multi-push matches single-push structure (two-step)", async () => {
      const records = twoStepFixture();
      const whole = await runStream([records]);
      const frag = await runStream([
        [records[0]!], [records[1]!], [records[2]!], [records[3]!],
      ]);
      expect(kindCounts(frag.spans)).toEqual(kindCounts(whole.spans));
      const wa = spanOf(whole.spans, GenAiSpanKindValues.AGENT);
      const fa = spanOf(frag.spans, GenAiSpanKindValues.AGENT);
      expect(fa.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(wa.attributes[GEN_AI_USAGE_INPUT_TOKENS]);
      expect(fa.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(wa.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]);
    });
  });

  it("links ENTRY to upstream parent_span_id from an 'other' event (fragmented)", async () => {
    const TRACE_ID = "b".repeat(32);
    const PARENT_SPAN_ID = "cafebabecafebabe";
    const otherEvt: EventLogRecord = {
      time_unix_nano: "1780000000500000000", "event.id": "user-input", "event.name": EventName.OTHER,
      trace_id: TRACE_ID, parent_span_id: PARENT_SPAN_ID,
      "gen_ai.session.id": "s", "gen_ai.turn.id": "s:t1", "user.id": "u", "gen_ai.agent.type": "demo",
      "gen_ai.input.messages_delta": '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]',
    };
    const req: EventLogRecord = {
      time_unix_nano: "1780000001000000000", "event.id": "req", "event.name": EventName.LLM_REQUEST,
      trace_id: TRACE_ID, parent_span_id: "aaaaaaaaaaaaaaaa", // intra-trace noise — must be ignored
      "gen_ai.session.id": "s", "gen_ai.turn.id": "s:t1", "gen_ai.step.id": "s:t1:s1",
      "gen_ai.agent.type": "demo", "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max",
    };
    const resp: EventLogRecord = {
      time_unix_nano: "1780000002000000000", "event.id": "resp", "event.name": EventName.LLM_RESPONSE,
      trace_id: TRACE_ID, parent_span_id: "bbbbbbbbbbbbbbbb",
      "gen_ai.session.id": "s", "gen_ai.turn.id": "s:t1", "gen_ai.step.id": "s:t1:s1",
      "gen_ai.agent.type": "demo", "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max",
      "gen_ai.response.finish_reasons": ["stop"], "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5,
    };
    // Fragmented: 'other' marker, then request, then response in separate pushes.
    const { spans } = await runStream([[otherEvt], [req], [resp]]);
    const entry = spanOf(spans, GenAiSpanKindValues.ENTRY);
    expect(entry.parentSpanId).toBe(PARENT_SPAN_ID); // NOT synthetic, NOT intra-trace noise
    for (const s of spans) expect(s.spanContext().traceId).toBe(TRACE_ID);
  });

  it("resolves trace_id even when the first parent record lacks it", async () => {
    const TRACE_ID = "e".repeat(32);
    const req: EventLogRecord = {
      time_unix_nano: "1780000001000000000", "event.id": "req", "event.name": EventName.LLM_REQUEST,
      // no trace_id on the first record
      "gen_ai.turn.id": "s:t1", "gen_ai.step.id": "s:t1:s1", "gen_ai.agent.type": "demo",
      "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max",
    };
    const resp: EventLogRecord = {
      time_unix_nano: "1780000002000000000", "event.id": "resp", "event.name": EventName.LLM_RESPONSE,
      trace_id: TRACE_ID, // valid trace_id appears later
      "gen_ai.turn.id": "s:t1", "gen_ai.step.id": "s:t1:s1", "gen_ai.agent.type": "demo",
      "gen_ai.provider.name": "qwen", "gen_ai.request.model": "qwen-max",
      "gen_ai.response.finish_reasons": ["stop"], "gen_ai.usage.input_tokens": 3, "gen_ai.usage.output_tokens": 2,
    };
    const { spans } = await runStream([[req, resp]]);
    for (const s of spans) expect(s.spanContext().traceId).toBe(TRACE_ID);
  });

  it("strict mode throws when warnings occur", () => {
    const { handler } = makeHarness();
    const s = createTurnStreamSession({ handler, strict: true });
    // llm.request with no step.id and no model → user-hook candidate → warning at end.
    s.push([
      { time_unix_nano: "1780000001000000000", "event.name": EventName.LLM_REQUEST, trace_id: "a".repeat(32), "gen_ai.turn.id": "t1", "gen_ai.input.messages_delta": '[{"role":"user","parts":[{"type":"text","content":"hi"}]}]' } as EventLogRecord,
      { time_unix_nano: "1780000002000000000", "event.name": EventName.LLM_REQUEST, trace_id: "a".repeat(32), "gen_ai.turn.id": "t1", "gen_ai.step.id": "t1:s1", "gen_ai.request.model": "m", "gen_ai.provider.name": "p" } as EventLogRecord,
      { time_unix_nano: "1780000003000000000", "event.name": EventName.LLM_RESPONSE, trace_id: "a".repeat(32), "gen_ai.turn.id": "t1", "gen_ai.step.id": "t1:s1", "gen_ai.request.model": "m", "gen_ai.provider.name": "p", "gen_ai.response.finish_reasons": ["stop"] } as EventLogRecord,
    ]);
    expect(() => s.end()).toThrow(EventLogConversionError);
  });

  it("open/traceId/spanCount reflect lifecycle", async () => {
    const { handler } = makeHarness();
    const records = twoStepFixture();
    const s = createTurnStreamSession({ handler });
    expect(s.open).toBe(false);
    s.push(records);
    expect(s.open).toBe(true);
    expect(s.traceId).toBe("ccdd000000000000ccdd000000000000");
    const r = s.end();
    expect(s.open).toBe(false);
    expect(r.spanCount).toBe(s.spanCount);
    expect(r.spanCount).toBeGreaterThanOrEqual(6); // ENTRY+AGENT+2 STEP+2 LLM
  });
});
