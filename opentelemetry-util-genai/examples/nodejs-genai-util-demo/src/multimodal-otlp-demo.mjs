import { randomUUID } from "node:crypto";
import { context } from "@opentelemetry/api";
import OpenAI from "openai";
import {
  VERSION,
  createEntryInvocation,
  createLLMInvocation,
} from "@loongsuite/otel-util-genai";
import {
  enableDemoContentExport,
  toSafeGenAIError,
  validatePublicImageUrl,
} from "./safety.mjs";
import { createOtlpRuntime } from "./telemetry.mjs";

if (!process.env.DASHSCOPE_API_KEY) {
  throw new Error("DASHSCOPE_API_KEY is required");
}

enableDemoContentExport();

const serviceName =
  process.env.OTEL_SERVICE_NAME ??
  "loongsuite-genai-multimodal-e2e";
const model = process.env.MODEL_NAME ?? "qwen3-vl-plus";
const prompt =
  process.env.MULTIMODAL_PROMPT ??
  "请描述图片中的人物、动物和场景，用一句中文回答。";
const imageUrl = validatePublicImageUrl(
  process.env.MULTIMODAL_IMAGE_URL ??
    "https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg",
);
const imageMimeType =
  process.env.MULTIMODAL_IMAGE_MIME_TYPE ?? "image/jpeg";

const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL:
    process.env.OPENAI_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
const runtime = createOtlpRuntime({ serviceName });

const imagePart = {
  type: "uri",
  mimeType: imageMimeType,
  modality: "image",
  uri: imageUrl,
};
const inputMessages = [
  {
    role: "user",
    parts: [
      { type: "text", content: prompt },
      imagePart,
    ],
  },
];

const sessionId = randomUUID();
const entryInvocation = createEntryInvocation({
  sessionId,
  userId: "multimodal-e2e-validation-user",
  agentName: "MultimodalValidation",
  inputMessages,
});
runtime.handler.startEntry(entryInvocation);

let response;
let traceId;
try {
  const llmInvocation = createLLMInvocation({
    provider: "dashscope",
    operationName: "chat",
    requestModel: model,
    inputMessages,
    conversationId: sessionId,
    outputType: "text",
  });
  runtime.handler.startLlm(llmInvocation, entryInvocation.contextToken);

  try {
    response = await context.with(llmInvocation.contextToken, () =>
      client.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: imageUrl },
              },
            ],
          },
        ],
      }),
    );

    const choice = response.choices?.[0];
    if (!choice?.message) {
      throw new Error("The model response has no first choice");
    }

    llmInvocation.responseId = response.id ?? null;
    llmInvocation.responseModelName = response.model ?? model;
    llmInvocation.finishReasons = [choice.finish_reason ?? "stop"];
    llmInvocation.inputTokens = response.usage?.prompt_tokens ?? null;
    llmInvocation.outputTokens =
      response.usage?.completion_tokens ?? null;
    llmInvocation.totalTokens = response.usage?.total_tokens ?? null;
    llmInvocation.outputMessages = [
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            content: choice.message.content ?? "",
          },
        ],
        finishReason: choice.finish_reason ?? "stop",
      },
    ];
    runtime.handler.stopLlm(llmInvocation);
  } catch (error) {
    if (llmInvocation.span?.isRecording()) {
      runtime.handler.failLlm(
        llmInvocation,
        toSafeGenAIError(
          error,
          "LLMError",
          "Multimodal LLM request failed",
        ),
      );
    }
    throw error;
  }

  entryInvocation.outputMessages = llmInvocation.outputMessages;
  runtime.handler.stopEntry(entryInvocation);
  traceId = entryInvocation.span.spanContext().traceId;
} catch (error) {
  if (entryInvocation.span?.isRecording()) {
    runtime.handler.failEntry(
      entryInvocation,
      toSafeGenAIError(
        error,
        "EntryError",
        "Multimodal validation failed",
      ),
    );
  }
  throw error;
} finally {
  await runtime.shutdown();
}

const choice = response.choices[0];
console.log(`export completed traceId=${traceId}`);
console.log(`service.name=${serviceName}`);
console.log(`util.version=${VERSION}`);
console.log(`model=${response.model ?? model}`);
console.log(`response.id=${response.id ?? ""}`);
console.log(`finish_reason=${choice.finish_reason ?? ""}`);
console.log(
  `tokens=${response.usage?.prompt_tokens ?? 0}/` +
    `${response.usage?.completion_tokens ?? 0}/` +
    `${response.usage?.total_tokens ?? 0}`,
);
console.log(`answer=${choice.message.content ?? ""}`);
