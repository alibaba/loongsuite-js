# ARMS Node.js 探针验证 Demo

此目录只验证 `@loongsuite/cms_node_sdk` 的 OpenAI 自动埋点能力，不初始化
OpenTelemetry SDK，也不使用 `@loongsuite/otel-util-genai` 手动创建 LLM Span。

`@loongsuite/cms_node_sdk@1.0.4` 声明支持 `openai >=4 <6`，因此本 Demo 固定
`openai@5.23.2`。请勿直接替换为 OpenAI 6；该组合不会命中当前探针的 OpenAI
自动埋点版本范围。

```bash
npm ci

export DASHSCOPE_API_KEY="<your-dashscope-api-key>"
export ARMS_LICENSE="<your-arms-license>"
export CMS_SERVICE_NAME="<your-service-name>"
export ARMS_REGION_ID="cn-hongkong"
# 默认 workspace 不需要设置
export ARMS_WORKSPACE="<your-workspace>"

npm start
```

启动命令等价于：

```bash
node -r @loongsuite/cms_node_sdk/register app.js
```

Demo 默认等待 65 秒再发起请求，使新服务有时间完成探针的首次配置握手。常驻服务
不需要额外等待；若验证的是已经在 ARMS 注册过的服务，可设置
`PROBE_WARMUP_MS=0` 缩短测试。

预期应用输出 HTTP 200 和模型回答。最终是否接入成功，应以 ARMS/SLS 中能够查询
到该服务的 HTTP SERVER Span、`openai.chat` LLM Span，以及模型、消息和 token
属性为准。
