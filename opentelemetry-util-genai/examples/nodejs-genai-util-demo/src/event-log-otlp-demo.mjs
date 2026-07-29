import { randomBytes, randomUUID } from "node:crypto";
import {
  VERSION,
  convertEventLogToTrace,
} from "@loongsuite/otel-util-genai";
import { enableDemoContentExport } from "./safety.mjs";
import { createOtlpRuntime } from "./telemetry.mjs";

enableDemoContentExport();

const serviceName =
  process.env.OTEL_SERVICE_NAME ??
  "loongsuite-genai-event-log-e2e";
const traceId = randomBytes(16).toString("hex");
const sessionId = randomUUID();
const turnId = randomUUID();
const nowNs = BigInt(Date.now()) * 1_000_000n;
const runtime = createOtlpRuntime({ serviceName });

const base = {
  trace_id: traceId,
  "gen_ai.turn.id": turnId,
  "gen_ai.session.id": sessionId,
  "gen_ai.agent.name": "EventLogMultimodalValidation",
  "gen_ai.provider.name": "dashscope",
  "gen_ai.step.id": "step-1",
  "user.id": "event-log-e2e-validation-user",
};
const inputUri = {
  type: "uri",
  mime_type: "image/png",
  modality: "image",
  uri: "https://example.com/event-log-input.png",
};
const outputUri = {
  type: "uri",
  mime_type: "image/webp",
  modality: "image",
  uri: "https://example.com/event-log-output.webp",
};
const records = [
  {
    ...base,
    time_unix_nano: nowNs.toString(),
    "event.id": "request-1",
    "event.name": "llm.request",
    "gen_ai.request.model": "event-log-vision-model",
    "gen_ai.input.messages_delta": JSON.stringify([
      {
        role: "user",
        parts: [
          { type: "text", content: "Describe the image." },
          inputUri,
        ],
      },
    ]),
  },
  {
    ...base,
    time_unix_nano: (nowNs + 1_000_000_000n).toString(),
    "event.id": "response-1",
    "event.name": "llm.response",
    "gen_ai.request.model": "event-log-vision-model",
    "gen_ai.response.model": "event-log-vision-model",
    "gen_ai.response.id": "event-log-response-1",
    "gen_ai.response.finish_reasons": ["stop"],
    "gen_ai.usage.input_tokens": 12,
    "gen_ai.usage.output_tokens": 5,
    "gen_ai.usage.total_tokens": 17,
    "gen_ai.output.messages": JSON.stringify([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "Generated image reference." },
          outputUri,
        ],
        finish_reason: "stop",
      },
    ]),
  },
];

try {
  const result = convertEventLogToTrace(records, {
    handler: runtime.handler,
  });
  if (result.spanCount !== 4 || result.traceIds[0] !== traceId) {
    throw new Error(
      `Unexpected conversion result: ${JSON.stringify(result)}`,
    );
  }
  if (result.warnings.length > 0) {
    throw new Error(
      `Event-log conversion warnings: ${result.warnings.join("; ")}`,
    );
  }
} finally {
  await runtime.shutdown();
}

console.log(`export completed traceId=${traceId}`);
console.log(`service.name=${serviceName}`);
console.log(`util.version=${VERSION}`);
console.log("span.count=4");
console.log("input.mime_type=image/png");
console.log("output.mime_type=image/webp");
