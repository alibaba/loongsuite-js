import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { runAgentRequest } from "./agent.mjs";
import { createOtlpRuntime } from "./telemetry.mjs";

if (!process.env.DASHSCOPE_API_KEY) {
  throw new Error("DASHSCOPE_API_KEY is required");
}

process.env.OTEL_SEMCONV_STABILITY_OPT_IN =
  "gen_ai_latest_experimental";
process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
  "SPAN_ONLY";

const serviceName =
  process.env.OTEL_SERVICE_NAME ??
  "loongsuite-genai-dashscope-e2e";
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL:
    process.env.OPENAI_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
const runtime = createOtlpRuntime({ serviceName });

let result;
try {
  result = await runAgentRequest({
    handler: runtime.handler,
    modelClient: {
      complete: (request) =>
        client.chat.completions.create(request),
    },
    userMessage: "请先调用天气工具，再告诉我杭州今天天气怎么样。",
    sessionId: randomUUID(),
    userId: "dashscope-e2e-validation-user",
    model: process.env.MODEL_NAME ?? "qwen-plus",
  });
} finally {
  await runtime.shutdown();
}

console.log(`export completed traceId=${result.traceId}`);
console.log(`service.name=${serviceName}`);
console.log(`answer=${result.text}`);
