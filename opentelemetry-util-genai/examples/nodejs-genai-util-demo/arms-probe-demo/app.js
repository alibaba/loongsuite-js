"use strict";

const http = require("node:http");
const OpenAI = require("openai");

const apiKey = process.env.DASHSCOPE_API_KEY;
if (!apiKey) {
  throw new Error("DASHSCOPE_API_KEY is required");
}

const client = new OpenAI({
  apiKey,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});
const warmupMs = Number(process.env.PROBE_WARMUP_MS ?? "65000");
if (!Number.isFinite(warmupMs) || warmupMs < 0) {
  throw new Error("PROBE_WARMUP_MS must be a non-negative number");
}

const server = http.createServer(async (_request, response) => {
  try {
    const completion = await client.chat.completions.create({
      model: "qwen-plus",
      messages: [
        {
          role: "user",
          content: "只回答“ARMS Node.js 探针链路验证成功”。",
        },
      ],
    });
    const answer = completion.choices[0]?.message?.content ?? "";

    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(answer);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve the local validation server address");
  }

  console.log(`warmup.ms=${warmupMs}`);
  setTimeout(() => {
    http.get(`http://127.0.0.1:${address.port}/probe-validation`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        console.log(`status=${response.statusCode}`);
        console.log(`answer=${body}`);
        server.close(() => {
          // register 预加载脚本会在 SIGTERM 中调用 sdk.shutdown()，确保批量数据刷出。
          process.kill(process.pid, "SIGTERM");
        });
      });
    });
  }, warmupMs);
});
