function textPart(content) {
  return { type: "text", content };
}

function toolCallPart(toolCall) {
  return {
    type: "tool_call",
    id: toolCall.id ?? null,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  };
}

export function toGenAIMessageFinishReason(finishReason) {
  return finishReason === "tool_calls" ? "tool_call" : finishReason || "stop";
}

export function toGenAIInputMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: message.tool_call_id ?? null,
            response: message.content ?? "",
          },
        ],
      };
    }

    if (
      message.content != null &&
      typeof message.content !== "string"
    ) {
      throw new TypeError(
        "This text-and-tools demo only accepts string message content.",
      );
    }

    const parts = [];
    if (message.content) {
      parts.push(textPart(message.content));
    }
    for (const toolCall of message.tool_calls ?? []) {
      parts.push(toolCallPart(toolCall));
    }
    return { role: message.role, parts };
  });
}

export function toGenAIOutputMessage(message, finishReason) {
  const parts = [];
  if (message.content) {
    parts.push(textPart(message.content));
  }
  for (const toolCall of message.tool_calls ?? []) {
    parts.push(toolCallPart(toolCall));
  }
  return {
    role: "assistant",
    parts,
    finishReason: toGenAIMessageFinishReason(finishReason),
  };
}

export function toGenAIToolDefinitions(tools) {
  return tools.map((tool) => {
    if (tool.type !== "function") {
      return { type: tool.type, name: tool.name };
    }
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description ?? null,
      parameters: tool.function.parameters ?? {},
    };
  });
}
