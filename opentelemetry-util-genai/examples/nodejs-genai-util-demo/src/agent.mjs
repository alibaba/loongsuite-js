import { context } from "@opentelemetry/api";
import {
  createEntryInvocation,
  createExecuteToolInvocation,
  createInvokeAgentInvocation,
  createLLMInvocation,
  createReactStepInvocation,
} from "@loongsuite/otel-util-genai";
import {
  toGenAIInputMessages,
  toGenAIOutputMessage,
  toGenAIToolDefinitions,
} from "./messages.mjs";
import { toSafeGenAIError } from "./safety.mjs";
import { dispatchTool, TOOL_DEFINITIONS } from "./tools.mjs";

const AGENT_NAME = "WeatherAgent";
const MAX_ITERATIONS = 4;

export async function runAgentRequest({
  handler,
  modelClient,
  userMessage,
  sessionId,
  userId,
  model = "qwen-plus",
  provider = "dashscope",
}) {
  const entryInv = createEntryInvocation({
    sessionId,
    userId,
    agentName: AGENT_NAME,
    inputMessages: [
      { role: "user", parts: [{ type: "text", content: userMessage }] },
    ],
  });
  handler.startEntry(entryInv);

  try {
    const agentInv = createInvokeAgentInvocation(provider, {
      agentName: AGENT_NAME,
      agentDescription: "先查询天气工具，再回答用户问题。",
      requestModel: model,
    });
    handler.startInvokeAgent(agentInv, entryInv.contextToken);

    try {
      const messages = [
        {
          role: "system",
          content: "回答天气问题前必须调用 get_weather 工具。",
        },
        { role: "user", content: userMessage },
      ];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let finalText = null;

      for (let round = 1; round <= MAX_ITERATIONS; round += 1) {
        const stepInv = createReactStepInvocation({ round });
        handler.startReactStep(stepInv, agentInv.contextToken);

        try {
          const llmInv = createLLMInvocation({
            provider,
            operationName: "chat",
            requestModel: model,
            inputMessages: toGenAIInputMessages(messages),
            toolDefinitions: toGenAIToolDefinitions(TOOL_DEFINITIONS),
          });
          handler.startLlm(llmInv, stepInv.contextToken);

          let choice;
          try {
            // startXxx only returns a Context; it does not make that Context
            // active. context.with is required for auto-instrumented SDK/HTTP
            // spans to become children of this manually-created LLM span.
            const response = await context.with(llmInv.contextToken, () =>
              modelClient.complete({
                model,
                messages,
                tools: TOOL_DEFINITIONS,
              }),
            );

            choice = response.choices?.[0];
            if (!choice?.message) {
              throw new Error("The model response has no first choice");
            }

            const usage = response.usage;
            if (usage) {
              llmInv.inputTokens = usage.prompt_tokens ?? null;
              llmInv.outputTokens = usage.completion_tokens ?? null;
              llmInv.totalTokens = usage.total_tokens ?? null;
              totalInputTokens += usage.prompt_tokens ?? 0;
              totalOutputTokens += usage.completion_tokens ?? 0;
            }
            llmInv.responseId = response.id ?? null;
            llmInv.responseModelName = response.model ?? model;
            // Keep the provider's raw finish reason on the span attribute.
            // The message schema separately normalizes "tool_calls" to
            // the singular "tool_call".
            llmInv.finishReasons = [choice.finish_reason ?? "stop"];
            llmInv.outputMessages = [
              toGenAIOutputMessage(choice.message, choice.finish_reason),
            ];
            handler.stopLlm(llmInv);
          } catch (error) {
            if (llmInv.span?.isRecording()) {
              handler.failLlm(
                llmInv,
                toSafeGenAIError(error, "LLMError", "LLM request failed"),
              );
            }
            throw error;
          }

          const toolCalls = choice.message.tool_calls ?? [];
          if (toolCalls.length > 0) {
            messages.push(choice.message);
            for (const toolCall of toolCalls) {
              const toolDefinition = TOOL_DEFINITIONS.find(
                (item) =>
                  item.type === "function" &&
                  item.function.name === toolCall.function.name,
              );
              const toolInv = createExecuteToolInvocation(
                toolCall.function.name,
                {
                  toolCallId: toolCall.id ?? null,
                  toolDescription:
                    toolDefinition?.function.description ?? null,
                  toolType: "function",
                  toolCallArguments: toolCall.function.arguments,
                },
              );
              handler.startExecuteTool(toolInv, stepInv.contextToken);

              try {
                const result = await context.with(
                  toolInv.contextToken,
                  async () =>
                    dispatchTool(
                      toolCall.function.name,
                      toolCall.function.arguments,
                    ),
                );
                toolInv.toolCallResult = result;
                handler.stopExecuteTool(toolInv);
                messages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: result,
                });
              } catch (error) {
                if (toolInv.span?.isRecording()) {
                  handler.failExecuteTool(
                    toolInv,
                    toSafeGenAIError(
                      error,
                      "ToolError",
                      "Tool execution failed",
                    ),
                  );
                }
                throw error;
              }
            }

            stepInv.finishReason = "continue";
            handler.stopReactStep(stepInv);
            continue;
          }

          finalText = choice.message.content ?? "";
          stepInv.finishReason = "stop";
          handler.stopReactStep(stepInv);
          break;
        } catch (error) {
          if (stepInv.span?.isRecording()) {
            handler.failReactStep(
              stepInv,
              toSafeGenAIError(error, "StepError", "Agent step failed"),
            );
          }
          throw error;
        }
      }

      if (finalText == null) {
        throw new Error(`Agent exceeded ${MAX_ITERATIONS} iterations`);
      }

      agentInv.inputTokens = totalInputTokens;
      agentInv.outputTokens = totalOutputTokens;
      agentInv.outputMessages = [
        {
          role: "assistant",
          parts: [{ type: "text", content: finalText }],
          finishReason: "stop",
        },
      ];
      handler.stopInvokeAgent(agentInv);

      entryInv.outputMessages = [
        {
          role: "assistant",
          parts: [{ type: "text", content: finalText }],
          finishReason: "stop",
        },
      ];
      handler.stopEntry(entryInv);

      return {
        text: finalText,
        traceId: entryInv.span.spanContext().traceId,
      };
    } catch (error) {
      if (agentInv.span?.isRecording()) {
        handler.failInvokeAgent(
          agentInv,
          toSafeGenAIError(
            error,
            "AgentError",
            "Agent invocation failed",
          ),
        );
      }
      throw error;
    }
  } catch (error) {
    if (entryInv.span?.isRecording()) {
      handler.failEntry(
        entryInv,
        toSafeGenAIError(
          error,
          "EntryError",
          "Application request failed",
        ),
      );
    }
    throw error;
  }
}
