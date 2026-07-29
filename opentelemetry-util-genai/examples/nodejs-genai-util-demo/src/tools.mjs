export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询指定城市的演示天气数据。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名称" },
        },
        required: ["city"],
        additionalProperties: false,
      },
    },
  },
];

export function dispatchTool(name, argumentsJson) {
  if (name !== "get_weather") {
    throw new Error(`Unknown tool: ${name}`);
  }

  let args;
  try {
    args = JSON.parse(argumentsJson || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON arguments for ${name}`, { cause: error });
  }
  if (typeof args.city !== "string" || !args.city.trim()) {
    throw new TypeError("get_weather requires a non-empty city");
  }

  return JSON.stringify({
    city: args.city,
    condition: "sunny",
    temperature_celsius: 26,
  });
}
