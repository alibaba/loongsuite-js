import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_SESSION_ID,
  GEN_AI_USER_ID,
  GEN_AI_SPAN_KIND,
  GenAiSpanKindValues,
} from "../src/semconv/gen-ai-extended-attributes.js";

const ORIGINAL_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  ORIGINAL_ENV.OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
});
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function setup() {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import(
    "@opentelemetry/sdk-trace-base"
  );
  const { ExtendedTelemetryHandler } = await import("../src/extended-handler.js");
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const handler = new ExtendedTelemetryHandler({ tracerProvider: provider });
  return { exporter, provider, handler };
}

describe("baggage propagation of common GenAI attributes", () => {
  it("child GenAI spans inherit agent.name / user.id / session.id from the Agent span", async () => {
    const { exporter, provider, handler } = await setup();
    const { createInvokeAgentInvocation, createReactStepInvocation, createExecuteToolInvocation } =
      await import("../src/extended-types.js");
    const { createLLMInvocation } = await import("../src/types.js");

    const agent = createInvokeAgentInvocation("openai", {
      agentName: "MyAgent",
      userId: "u1",
      sessionId: "s1",
      requestModel: "gpt-5",
    });
    handler.startInvokeAgent(agent);

    // Children created WITHOUT explicitly setting the three common attrs.
    const step = createReactStepInvocation({ round: 1 });
    handler.startReactStep(step, agent.contextToken ?? undefined);

    const llm = createLLMInvocation({ requestModel: "gpt-5", provider: "openai" });
    handler.startLlm(llm, step.contextToken ?? undefined);
    handler.stopLlm(llm);

    const tool = createExecuteToolInvocation("search");
    handler.startExecuteTool(tool, step.contextToken ?? undefined);
    handler.stopExecuteTool(tool);

    handler.stopReactStep(step);
    handler.stopInvokeAgent(agent);
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    for (const kind of [
      GenAiSpanKindValues.STEP,
      GenAiSpanKindValues.LLM,
      GenAiSpanKindValues.TOOL,
    ]) {
      const s = spans.find((x) => x.attributes[GEN_AI_SPAN_KIND] === kind);
      expect(s, `${kind} span exists`).toBeDefined();
      expect(s!.attributes[GEN_AI_AGENT_NAME], `${kind} agent.name`).toBe("MyAgent");
      expect(s!.attributes[GEN_AI_USER_ID], `${kind} user.id`).toBe("u1");
      expect(s!.attributes[GEN_AI_SESSION_ID], `${kind} session.id`).toBe("s1");
    }
    await provider.shutdown();
  });

  it("explicitly-set values on the child win over inherited baggage", async () => {
    const { exporter, provider, handler } = await setup();
    const { createInvokeAgentInvocation } = await import("../src/extended-types.js");
    const { createLLMInvocation } = await import("../src/types.js");

    const agent = createInvokeAgentInvocation("openai", { agentName: "MyAgent", requestModel: "gpt-5" });
    handler.startInvokeAgent(agent);

    const llm = createLLMInvocation({ requestModel: "gpt-5", provider: "openai", agentName: "OverrideAgent" });
    handler.startLlm(llm, agent.contextToken ?? undefined);
    handler.stopLlm(llm);

    handler.stopInvokeAgent(agent);
    await provider.forceFlush();

    const s = exporter.getFinishedSpans().find((x) => x.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.LLM);
    expect(s!.attributes[GEN_AI_AGENT_NAME]).toBe("OverrideAgent");
    await provider.shutdown();
  });

  it("Entry also publishes common attributes to baggage", async () => {
    const { exporter, provider, handler } = await setup();
    const { createEntryInvocation, createInvokeAgentInvocation } = await import(
      "../src/extended-types.js"
    );

    const entry = createEntryInvocation({ sessionId: "sess-x", userId: "user-x", agentName: "EntryAgent" });
    handler.startEntry(entry);

    // Agent created under entry, without setting user/session.
    const agent = createInvokeAgentInvocation("openai", { requestModel: "gpt-5" });
    handler.startInvokeAgent(agent, entry.contextToken ?? undefined);
    handler.stopInvokeAgent(agent);
    handler.stopEntry(entry);
    await provider.forceFlush();

    const s = exporter.getFinishedSpans().find((x) => x.attributes[GEN_AI_SPAN_KIND] === GenAiSpanKindValues.AGENT);
    expect(s!.attributes[GEN_AI_SESSION_ID]).toBe("sess-x");
    expect(s!.attributes[GEN_AI_USER_ID]).toBe("user-x");
    expect(s!.attributes[GEN_AI_AGENT_NAME]).toBe("EntryAgent");
    await provider.shutdown();
  });

  it("no baggage set → no inheritance (backward compatible)", async () => {
    const { exporter, provider, handler } = await setup();
    const { createLLMInvocation } = await import("../src/types.js");

    const llm = createLLMInvocation({ requestModel: "gpt-5", provider: "openai" });
    handler.startLlm(llm);
    handler.stopLlm(llm);
    await provider.forceFlush();

    const s = exporter.getFinishedSpans()[0];
    expect(s!.attributes[GEN_AI_AGENT_NAME]).toBeUndefined();
    expect(s!.attributes[GEN_AI_USER_ID]).toBeUndefined();
    expect(s!.attributes[GEN_AI_SESSION_ID]).toBeUndefined();
    await provider.shutdown();
  });
});
