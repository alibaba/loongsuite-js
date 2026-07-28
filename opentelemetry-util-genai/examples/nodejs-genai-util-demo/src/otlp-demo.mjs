import { randomUUID } from "node:crypto";
import { runAgentRequest } from "./agent.mjs";
import { ScriptedModelClient } from "./scripted-model.mjs";
import { createOtlpRuntime } from "./telemetry.mjs";

process.env.OTEL_SEMCONV_STABILITY_OPT_IN =
  "gen_ai_latest_experimental";
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
  "SPAN_ONLY";

const runtime = createOtlpRuntime({
  serviceName:
    process.env.OTEL_SERVICE_NAME ?? "loongsuite-genai-otlp-validation",
});

let result;
try {
  result = await runAgentRequest({
    handler: runtime.handler,
    modelClient: new ScriptedModelClient({ tracer: runtime.tracer }),
    userMessage: "杭州今天天气怎么样？",
    sessionId: randomUUID(),
    userId: "otlp-validation-user",
  });
} finally {
  // BatchSpanProcessor exports buffered spans during forceFlush/shutdown.
  // Only print "export completed" after both operations resolve.
  await runtime.shutdown();
}

console.log(`export completed traceId=${result.traceId}`);
