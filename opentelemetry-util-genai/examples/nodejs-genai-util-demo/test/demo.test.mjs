import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { runAgentRequest } from "../src/agent.mjs";
import {
  toGenAIMessageFinishReason,
  toGenAIInputMessages,
} from "../src/messages.mjs";
import {
  toSafeGenAIError,
  validatePublicImageUrl,
} from "../src/safety.mjs";
import { ScriptedModelClient } from "../src/scripted-model.mjs";
import { createInMemoryRuntime } from "../src/telemetry.mjs";

let runtime;

before(() => {
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN =
    "gen_ai_latest_experimental";
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
    "SPAN_ONLY";
  runtime = createInMemoryRuntime();
});

beforeEach(() => {
  runtime.exporter.reset();
});

after(async () => {
  await runtime.shutdown();
});

test("converts OpenAI tool messages without losing call identity", () => {
  const converted = toGenAIInputMessages([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          function: { name: "get_weather", arguments: "{\"city\":\"杭州\"}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      content: "{\"temperature_celsius\":26}",
    },
  ]);

  assert.deepEqual(converted, [
    {
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: "call-1",
          name: "get_weather",
          arguments: "{\"city\":\"杭州\"}",
        },
      ],
    },
    {
      role: "tool",
      parts: [
        {
          type: "tool_call_response",
          id: "call-1",
          response: "{\"temperature_celsius\":26}",
        },
      ],
    },
  ]);
  assert.equal(toGenAIMessageFinishReason("tool_calls"), "tool_call");
});

test("sanitizes telemetry errors and rejects credential-bearing image URLs", () => {
  assert.deepEqual(
    toSafeGenAIError(
      new Error("api_key=secret-value"),
      "LLMError",
      "LLM request failed",
    ),
    {
      type: "Error",
      message: "LLM request failed",
    },
  );
  assert.equal(
    validatePublicImageUrl("https://example.com/public-image.jpg"),
    "https://example.com/public-image.jpg",
  );
  assert.throws(
    () =>
      validatePublicImageUrl(
        "https://example.com/private-image.jpg?signature=secret-value",
      ),
    /must not contain credentials, query parameters, or fragments/,
  );
  assert.throws(
    () => validatePublicImageUrl("http://127.0.0.1/private-image.jpg"),
    /must use HTTPS/,
  );
  assert.throws(
    () => validatePublicImageUrl("https://127.0.0.1/private-image.jpg"),
    /must not reference a private IP address/,
  );
});

test("exports one coherent GenAI trace with tool-call semantics", async () => {
  const result = await runAgentRequest({
    handler: runtime.handler,
    modelClient: new ScriptedModelClient({ tracer: runtime.tracer }),
    userMessage: "杭州今天天气怎么样？",
    sessionId: "session-1",
    userId: "user-1",
  });
  const spans = runtime.exporter.getFinishedSpans();
  assert.equal(spans.length, 9);
  assert.equal(new Set(spans.map((span) => span.spanContext().traceId)).size, 1);
  assert.equal(spans[0].spanContext().traceId, result.traceId);

  const byName = new Map();
  for (const span of spans) {
    const list = byName.get(span.name) ?? [];
    list.push(span);
    byName.set(span.name, list);
  }
  assert.equal(byName.get("enter_ai_application_system")?.length, 1);
  assert.equal(byName.get("invoke_agent WeatherAgent")?.length, 1);
  assert.equal(byName.get("react step")?.length, 2);
  assert.equal(byName.get("chat qwen-plus")?.length, 2);
  assert.equal(byName.get("execute_tool get_weather")?.length, 1);
  assert.equal(byName.get("simulated.model.transport")?.length, 2);

  const entry = byName.get("enter_ai_application_system")[0];
  const agent = byName.get("invoke_agent WeatherAgent")[0];
  const llmSpans = byName.get("chat qwen-plus");
  const tool = byName.get("execute_tool get_weather")[0];
  const transportSpans = byName.get("simulated.model.transport");

  assert.equal(agent.parentSpanId, entry.spanContext().spanId);
  for (const transport of transportSpans) {
    assert.ok(
      llmSpans.some(
        (llmSpan) => transport.parentSpanId === llmSpan.spanContext().spanId,
      ),
      "context.with must attach the simulated auto span under an LLM span",
    );
  }

  for (const span of spans.filter((item) => item.attributes["gen_ai.span.kind"])) {
    assert.equal(span.attributes["gen_ai.agent.name"], "WeatherAgent");
    assert.equal(span.attributes["gen_ai.session.id"], "session-1");
    assert.equal(span.attributes["gen_ai.user.id"], "user-1");
  }
  assert.equal(agent.attributes["gen_ai.usage.input_tokens"], 30);
  assert.equal(agent.attributes["gen_ai.usage.output_tokens"], 10);
  assert.equal(agent.attributes["gen_ai.usage.total_tokens"], 40);
  assert.equal(tool.attributes["gen_ai.tool.call.id"], "call-weather-1");
  assert.equal(
    tool.attributes["gen_ai.tool.description"],
    "查询指定城市的演示天气数据。",
  );

  const firstOutput = JSON.parse(
    llmSpans[0].attributes["gen_ai.output.messages"],
  );
  assert.equal(firstOutput[0].parts[0].type, "tool_call");
  assert.equal(firstOutput[0].finish_reason, "tool_call");
  assert.deepEqual(
    llmSpans[0].attributes["gen_ai.response.finish_reasons"],
    ["tool_calls"],
  );

  const secondInput = JSON.parse(
    llmSpans[1].attributes["gen_ai.input.messages"],
  );
  const parts = secondInput.flatMap((message) => message.parts);
  assert.ok(parts.some((part) => part.type === "tool_call"));
  assert.ok(parts.some((part) => part.type === "tool_call_response"));

  assert.equal(
    entry.resource.attributes["service.name"],
    "loongsuite-genai-node-demo",
  );
  assert.equal(
    entry.resource.attributes["acs.arms.service.feature"],
    "genai_app",
  );
});

test("marks the full open invocation chain as failed", async () => {
  const sensitiveMessage =
    "model unavailable; api_key=secret-value; path=/private/data";
  await assert.rejects(
    runAgentRequest({
      handler: runtime.handler,
      modelClient: {
        complete: async () => {
          throw new Error(sensitiveMessage);
        },
      },
      userMessage: "杭州今天天气怎么样？",
      sessionId: "session-error",
      userId: "user-error",
    }),
    /api_key=secret-value/,
  );

  const spans = runtime.exporter.getFinishedSpans();
  assert.equal(spans.length, 4);
  const safeMessages = new Set([
    "LLM request failed",
    "Agent step failed",
    "Agent invocation failed",
    "Application request failed",
  ]);
  for (const span of spans) {
    assert.equal(span.status.code, SpanStatusCode.ERROR);
    assert.equal(span.attributes["error.type"], "Error");
    assert.ok(safeMessages.has(span.status.message));
    assert.doesNotMatch(
      JSON.stringify({
        status: span.status,
        attributes: span.attributes,
      }),
      /secret-value|private\/data/,
    );
  }
});

test("ends every open span when the model response has no choice", async () => {
  await assert.rejects(
    runAgentRequest({
      handler: runtime.handler,
      modelClient: {
        complete: async () => ({ choices: [] }),
      },
      userMessage: "杭州今天天气怎么样？",
      sessionId: "session-invalid-response",
      userId: "user-invalid-response",
    }),
    /model response has no first choice/,
  );

  const spans = runtime.exporter.getFinishedSpans();
  assert.equal(spans.length, 4);
  assert.deepEqual(
    new Set(spans.map((span) => span.attributes["gen_ai.span.kind"])),
    new Set(["LLM", "STEP", "AGENT", "ENTRY"]),
  );
  for (const span of spans) {
    assert.equal(span.status.code, SpanStatusCode.ERROR);
  }
});
