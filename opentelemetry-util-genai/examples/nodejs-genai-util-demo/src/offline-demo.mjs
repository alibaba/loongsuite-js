import { randomUUID } from "node:crypto";
import { runAgentRequest } from "./agent.mjs";
import { ScriptedModelClient } from "./scripted-model.mjs";
import {
  createInMemoryRuntime,
  formatSpanTree,
} from "./telemetry.mjs";

process.env.OTEL_SEMCONV_STABILITY_OPT_IN =
  "gen_ai_latest_experimental";
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
  "SPAN_ONLY";

const runtime = createInMemoryRuntime();
try {
  const result = await runAgentRequest({
    handler: runtime.handler,
    modelClient: new ScriptedModelClient({ tracer: runtime.tracer }),
    userMessage: "杭州今天天气怎么样？",
    sessionId: randomUUID(),
    userId: "demo-user",
  });
  const spans = runtime.exporter.getFinishedSpans();
  console.log(`traceId=${result.traceId}`);
  console.log(`answer=${result.text}`);
  console.log(formatSpanTree(spans));
} finally {
  await runtime.shutdown();
}
