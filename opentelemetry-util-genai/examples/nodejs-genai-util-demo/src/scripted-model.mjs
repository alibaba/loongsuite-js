export class ScriptedModelClient {
  constructor({ tracer } = {}) {
    this.tracer = tracer;
    this.callCount = 0;
  }

  async complete({ model, messages }) {
    const transportSpan = this.tracer?.startSpan(
      "simulated.model.transport",
    );
    try {
      this.callCount += 1;
      if (this.callCount === 1) {
        return {
          id: "response-1",
          model,
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-weather-1",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: JSON.stringify({ city: "杭州" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
          },
        };
      }

      const toolMessage = messages.find(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id === "call-weather-1",
      );
      if (!toolMessage) {
        throw new Error("The second model call is missing the tool response");
      }
      return {
        id: "response-2",
        model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "杭州天气晴朗，气温 26°C。",
            },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 6,
          total_tokens: 26,
        },
      };
    } finally {
      transportSpan?.end();
    }
  }
}
