# @loongsuite/otel-util-genai Node.js 验证 Demo

这个 Demo 用真实可执行代码验证以下关键行为：

- `ENTRY -> AGENT -> STEP -> LLM/TOOL` 的父子关系；
- `context.with(invocation.contextToken, ...)` 能把自动采集的下游 span 挂到手工 span 下；
- OpenAI 兼容接口中的 `tool_calls` 和 `tool` 消息不会丢失调用 ID；
- LLM 与 Agent 的 token 属性正确；
- 异常会沿 `LLM -> STEP -> AGENT -> ENTRY` 完整收口；
- OTLP HTTP exporter 在进程退出前完成 `forceFlush()` 和 `shutdown()`。

## 运行环境

- Node.js 20 或 22 LTS；
- npm 公共仓库可访问。

## 安装

Demo 固定使用已经验收的正式版本
`@loongsuite/otel-util-genai@0.1.0`：

```bash
npm ci
```

## 离线验证

离线用例不访问模型或采集端：

```bash
npm test
npm run demo
```

预期树结构：

```text
ENTRY enter_ai_application_system
  AGENT invoke_agent WeatherAgent
    STEP react step
      LLM chat qwen-plus
        simulated.model.transport
      TOOL execute_tool get_weather
    STEP react step
      LLM chat qwen-plus
        simulated.model.transport
```

## 真实 DashScope 验证

```bash
export DASHSCOPE_API_KEY="<your-api-key>"
npm run demo:dashscope
```

默认调用 DashScope 的 OpenAI 兼容接口和 `qwen-plus`。程序会输出回答、traceId 和本地收集到的 span 树。

## OTLP 导出验证

从 ARMS 控制台复制当前应用的 OTLP HTTP 接入地址和鉴权 Header，然后设置：

```bash
export OTEL_SERVICE_NAME="your-genai-service"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="<console-provided-traces-endpoint>"
export OTEL_EXPORTER_OTLP_HEADERS="Authentication=<credential>"
npm run demo:otlp
```

如果接入页给出的是通用 `OTEL_EXPORTER_OTLP_ENDPOINT`，应使用该变量。不同接入页提供的 URL 形式可能不同，应原样使用控制台给出的 endpoint，不要凭经验自行拼接路径。

只有 `forceFlush()` 和 `shutdown()` 都成功后，程序才会输出：

```text
export completed traceId=<trace-id>
```

随后应使用该 traceId 在 ARMS 控制台检查链路树、属性和重复 span；“导出器返回成功”不等于“控制台验收已完成”。

## 真实 DashScope 到 OTLP 的端到端验证

`demo:e2e` 会真实调用 DashScope，执行工具调用和第二轮模型请求，再把同一条 GenAI trace 导出到 OTLP：

```bash
export DASHSCOPE_API_KEY="<your-api-key>"
export OTEL_SERVICE_NAME="your-genai-service"
export OTEL_RESOURCE_ATTRIBUTES="service.name=your-genai-service"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="<console-provided-traces-endpoint>"
export OTEL_EXPORTER_OTLP_HEADERS="<console-provided-auth-headers>"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
npm run demo:e2e
```

如果接入页提供的是通用 `OTEL_EXPORTER_OTLP_ENDPOINT`，应改用该变量。程序只在真实模型调用以及 `forceFlush()`、`shutdown()` 全部成功后输出 traceId。

## 真实图片理解到 OTLP 的端到端验证

`demo:multimodal-e2e` 使用图片 URL 调用 DashScope
`qwen3-vl-plus`，并验证 util 自动生成：

- `gen_ai.input.messages` 中的 URI Part；
- Schema 字段 `mime_type`；
- `gen_ai.input.multimodal_metadata`；
- 模型、响应 ID、finish reason 和 Token 属性。

```bash
export DASHSCOPE_API_KEY="<your-api-key>"
export OTEL_SERVICE_NAME="your-multimodal-service"
export OTEL_RESOURCE_ATTRIBUTES="service.name=your-multimodal-service"
export OTEL_EXPORTER_OTLP_ENDPOINT="<console-provided-endpoint>"
export OTEL_EXPORTER_OTLP_HEADERS="<console-provided-auth-headers>"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
npm run demo:multimodal-e2e
```

默认使用阿里云百炼公开示例图片，也可以覆盖：

```bash
export MULTIMODAL_IMAGE_URL="https://example.com/image.jpg"
export MULTIMODAL_IMAGE_MIME_TYPE="image/jpeg"
export MULTIMODAL_PROMPT="请描述这张图片。"
```

这个 Demo 验证的是模型实际接收的 URL 图片，因此对应 GenAI `Uri`
Part。`File` Part 的 `fileId -> file_id` 序列化由 util 单元测试覆盖，但在
找到支持文件 ID 直接输入的模型接口并完成真实调用前，不把它作为本 Demo
的对外支持场景。

## Event Log 多模态 OTLP 验证

`demo:event-log-e2e` 使用符合 Schema 的 snake_case URI Part
（`mime_type`），转换并导出 `ENTRY -> AGENT -> STEP -> LLM` 链路，用于
验证 input/output multimodal metadata：

```bash
export OTEL_SERVICE_NAME="your-event-log-service"
export OTEL_RESOURCE_ATTRIBUTES="service.name=your-event-log-service"
export OTEL_EXPORTER_OTLP_ENDPOINT="<console-provided-endpoint>"
export OTEL_EXPORTER_OTLP_HEADERS="<console-provided-auth-headers>"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
npm run demo:event-log-e2e
```

## ARMS Node.js 探针自动埋点验证

[`arms-probe-demo`](./arms-probe-demo/) 是独立安装的探针验证程序，固定使用
`@loongsuite/cms_node_sdk@1.0.4` 和受该版本支持的 `openai@5.23.2`。它不会
加载 `@loongsuite/otel-util-genai` 或初始化第二套 Provider，用于验证
`node -r @loongsuite/cms_node_sdk/register app.js` 对 OpenAI 调用的自动采集。

请按子目录 README 配置 ARMS License、地域、workspace 和服务名。新服务验证会
等待首次配置握手，然后真实调用 DashScope；最终以 ARMS 中的 HTTP → LLM → HTTP
链路、模型、消息和 token 属性为准。

## 安全与依赖基线

本 Demo 固定使用 `@loongsuite/otel-util-genai@0.1.0` 已完成兼容性验收的
OpenTelemetry JS 1.x 依赖组合。当前 `npm audit` 会报告以下传递依赖问题：

- [`@opentelemetry/core` W3C Baggage
  内存分配问题](https://github.com/advisories/GHSA-8988-4f7v-96qf)；
- [`@opentelemetry/propagator-jaeger`
  畸形 Header 拒绝服务问题](https://github.com/advisories/GHSA-45rx-2jwx-cxfr)。

本 Demo 不启用 Jaeger Propagator。对于来自不可信网络的 W3C Baggage Header，
应在入口限制 Header 大小和条目数量。不要执行 `npm audit fix --force` 将本示例
直接升级到 OpenTelemetry JS 2.x；该升级超出当前 npm 包的已验证兼容范围，必须在
升级后重新验证 Span 树、上下文传播、属性和 OTLP 导出。

## 发布前脱敏要求

不要向此目录提交 API Key、ARMS License、OTLP 鉴权 Header、内部 Project 或
Workspace、CLI profile、历史 traceId、Trace 导出文件或 `.env`。示例中的所有
鉴权值都必须通过环境变量传入。
