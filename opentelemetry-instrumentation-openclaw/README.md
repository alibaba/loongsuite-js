# opentelemetry-instrumentation-openclaw

OpenClaw plugin — report AI Agent execution traces to any OTLP-compatible backend via OpenTelemetry.

Spans follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):

| Span | gen_ai.span.kind | Description |
|------|-----------------|-------------|
| `enter_ai_application_system` | ENTRY | Request entry point |
| `invoke_agent` | AGENT | Agent invocation |
| `react` | STEP | ReAct reasoning step |
| `chat` | LLM | LLM call |
| `execute_tool` | TOOL | Tool execution |
| `session_start` / `session_end` | — | Session lifecycle |
| `gateway_start` / `gateway_stop` | — | Gateway lifecycle |

Typical trace tree:

```
enter_ai_application_system  (ENTRY)
  └── invoke_agent main      (AGENT)
       ├── react step        (STEP)
       │    ├── chat glm-5.1 (LLM)
       │    └── execute_tool  (TOOL)
       ├── react step        (STEP)
       │    ├── chat glm-5.1 (LLM)
       │    └── execute_tool  (TOOL)
       └── chat glm-5.1     (LLM, final answer)
```

---

## Installation

The install script sets up two components:

1. **opentelemetry-instrumentation-openclaw** — Downloads, extracts, installs dependencies, and writes plugin config (Trace reporting)
2. **diagnostics-otel** — Locates the built-in OpenClaw extension and enables Metrics collection

```bash
curl -fsSL https://<your-plugin-host>/install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --serviceName "my-openclaw-agent"
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `--endpoint` | Yes | OTLP endpoint URL |
| `--serviceName` | Yes | Service name for traces |
| `--x-arms-license-key` | No | ARMS license key |
| `--x-arms-project` | No | ARMS project ID |
| `--x-cms-workspace` | No | CMS workspace ID |
| `--plugin-url` | No | Custom tarball download URL |
| `--install-dir` | No | Override install directory |
| `--disable-metrics` | No | Skip diagnostics-otel metrics setup |
| `--semconv-dialect` | No | Semantic convention dialect (`ALIBABA_CLOUD` / `ALIBABA_GROUP`) |

### Backend-specific auth headers

If your OTLP backend requires authentication headers, pass them to the plugin config after installation. Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "opentelemetry-instrumentation-openclaw": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "endpoint": "https://your-otlp-endpoint:4318",
          "headers": {
            "x-api-key": "your-api-key"
          },
          "serviceName": "my-openclaw-agent"
        }
      }
    }
  }
}
```

> **Note**: `hooks.allowConversationAccess: true` is required for OpenClaw >= 2026.4.25. Without it, the plugin loads but conversation hooks (`llm_input`, `llm_output`, `agent_end`) are blocked by the security policy. Versions before 2026.4.25 do not recognize this field and will reject it with a config validation error — omit the `hooks` block on older versions. The install script auto-detects the OpenClaw version and writes this field only when supported.

> **Alibaba Cloud ARMS users**: The headers `x-arms-license-key`, `x-arms-project`, and `x-cms-workspace` are ARMS-specific authentication fields. Obtain these from the ARMS console → Integration Center.

### Environment variable fallback

When a config field is not set in `openclaw.json`, the plugin falls back to environment variables:

| Environment Variable | Config Equivalent | Description |
|---|---|---|
| `ARMS_OTLP_ENDPOINT` | `endpoint` | OTLP endpoint URL |
| `ARMS_LICENSE_KEY` | `headers.x-arms-license-key` | ARMS license key |
| `ARMS_PROJECT` | `headers.x-arms-project` | ARMS project ID |
| `ARMS_CMS_WORKSPACE` | `headers.x-cms-workspace` | CMS workspace ID |
| `ARMS_SERVICE_NAME` | `serviceName` | Service name (also reads `OTEL_SERVICE_NAME`) |
| `ARMS_TRACE_DEBUG` | `debug` | Enable debug logging (`true` / `1`) |
| `ARMS_ENABLE_TRACE_PROPAGATION` | `enableTracePropagation` | Enable W3C Trace Context propagation (`true` / `1`) |
| `OTEL_RESOURCE_ATTRIBUTES` | `resourceAttributes` | Custom resource attributes (`key1=value1,key2=value2`) |
| `OTEL_SPAN_ATTRIBUTES` | `globalSpanAttributes` | Global span attributes injected to all spans (`key1=value1,key2=value2`) |

Priority: **config file > environment variable > default value**

### Prerequisites

- Node.js >= 18
- npm
- OpenClaw CLI (optional, used for auto-restarting the gateway)

---

## W3C Trace Context Propagation

Enable trace propagation to correlate OpenClaw spans with upstream callers and downstream LLM APIs.

```json
{
  "config": {
    "enableTracePropagation": true,
    "propagationTargetUrls": ["api.openai.com", "dashscope.aliyuncs.com"]
  }
}
```

### How it works

1. **Inbound** (HTTP): Extracts `traceparent` header from incoming HTTP requests. All spans in that conversation inherit the upstream trace ID.
2. **Inbound** (WebSocket): Extracts trace context from message content via `<!--otel:{JSON}-->` embedding (see below).
3. **Outbound**: Injects `traceparent` header into outgoing HTTPS requests to LLM APIs (filtered by `propagationTargetUrls`; OTLP endpoint is always excluded).

### WebSocket content-embedded propagation

For WebSocket connections where HTTP headers are not available per-message, embed trace context in the message body:

```
Your message here
<!--otel:{"tp":"00-abcdef1234567890abcdef1234567890-1234567890abcdef-01","attr":{"user.id":"u123","biz.order_id":"ORD-001"}}-->
```

| Field | Description |
|---|---|
| `tp` | W3C `traceparent` header value |
| `attr` | Custom attributes to attach to all spans in this conversation |

The `<!--otel:...-->` comment is stripped from the content before it reaches the LLM.

**Custom attribute limits**:
- Max 20 attributes per message
- Key max length: 128 characters
- Value max length: 1024 characters
- Reserved prefixes `openclaw.*` and `gen_ai.*` are rejected

---

## Custom Resource & Span Attributes

Inject fixed attributes into the OTel Resource or into every span, useful for deployment metadata and business identifiers.

### Via config file

```json
{
  "config": {
    "resourceAttributes": {
      "deployment.environment": "production",
      "k8s.namespace": "default"
    },
    "globalSpanAttributes": {
      "biz.team": "payment",
      "biz.app": "checkout"
    }
  }
}
```

### Via environment variables

```bash
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=production,k8s.namespace=default"
export OTEL_SPAN_ATTRIBUTES="biz.team=payment,biz.app=checkout"
```

> **Note**: Environment variables must be visible to the gateway process. OpenClaw gateway defaults to daemon mode, which does not inherit the calling shell's environment. For local development/testing, use the config file approach above. Environment variables are suited for container deployments (Docker/K8s) where env is injected into the process directly.

### Attribute priority (low → high)

1. `globalSpanAttributes` / `OTEL_SPAN_ATTRIBUTES` — global fixed attributes
2. Per-request `customAttributes` (via `<!--otel:{attr:{...}}-->`) — dynamic per-conversation
3. Built-in `openclaw.*` / `gen_ai.*` attributes — always preserved

For `resourceAttributes`, config file values override environment variable values for the same key.

---

## Uninstall

```bash
curl -fsSL https://<your-plugin-host>/uninstall.sh | bash
```

| Parameter | Description |
|-----------|-------------|
| `-y` / `--yes` | Skip confirmation prompt |
| `--install-dir` | Specify plugin install directory |
| `--keep-metrics` | Keep diagnostics-otel metrics config |

---

## Manual Configuration

If you prefer to configure manually, edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["opentelemetry-instrumentation-openclaw", "diagnostics-otel"],
    "load": { "paths": ["/path/to/opentelemetry-instrumentation-openclaw"] },
    "entries": {
      "opentelemetry-instrumentation-openclaw": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "endpoint": "https://your-otlp-endpoint:4318",
          "headers": {
            "x-api-key": "your-backend-api-key"
          },
          "serviceName": "my-openclaw-agent",
          "debug": false,
          "batchSize": 10,
          "flushIntervalMs": 5000,
          "enableTracePropagation": true,
          "propagationTargetUrls": ["api.openai.com"]
        }
      },
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://your-otlp-endpoint:4318",
      "protocol": "http/protobuf",
      "headers": { "x-api-key": "your-backend-api-key" },
      "serviceName": "my-openclaw-agent",
      "traces": false,
      "metrics": true,
      "logs": false
    }
  }
}
```

### Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `endpoint` | string | — | OTLP endpoint URL (required) |
| `headers` | object | `{}` | HTTP headers for OTLP authentication |
| `serviceName` | string | `"openclaw-agent"` | Service name in traces |
| `debug` | boolean | `false` | Enable debug logging |
| `batchSize` | number | `10` | Spans buffered before export |
| `flushIntervalMs` | number | `5000` | Max buffer wait time (ms) |
| `enableTracePropagation` | boolean | `false` | Enable W3C Trace Context propagation |
| `propagationTargetUrls` | string[] | — | URL substrings for outbound `traceparent` injection |
| `resourceAttributes` | object | — | Custom resource attributes (merged into OTel Resource) |
| `globalSpanAttributes` | object | — | Custom attributes injected into every span |
| `enabledHooks` | string[] | — | Restrict which hooks are active (all if omitted) |

> **Note**: Set `diagnostics.otel.traces: false` to avoid duplicate traces — `opentelemetry-instrumentation-openclaw` already handles trace reporting.

> **Migration compatibility**: Existing `openclaw-cms-plugin` users can upgrade in place. The installer migrates old config entries to the new plugin ID automatically.

---

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run dev      # Watch mode
npm test         # Run tests (Vitest)
```

---

## Maintainer Release Pipeline

This repo includes a manual GitHub Actions workflow:
- `.github/workflows/release-openclaw-plugin.yml`

Trigger it from **Actions → Release OpenClaw Plugin → Run workflow** and provide:
- `version` (must match `package.json`, e.g. `0.1.3-beta`)
- `oss_path_prefix` (e.g. `opentelemetry-instrumentation-openclaw`)
- `create_latest_alias` (`true` uploads an additional `/latest` path)
- `dry_run` (`true` skips OSS upload + GitHub Release)

Required repository secrets:
- `OSS_BUCKET`
- `OSS_ENDPOINT`
- `OSS_ACCESS_KEY_ID`
- `OSS_ACCESS_KEY_SECRET`

Workflow outputs:
- builds and packs `opentelemetry-instrumentation-openclaw.tar.gz`
- uploads tarball + `install.sh` + `install-wget.sh` + `uninstall.sh` + `SHA256SUMS` to OSS
- creates tag `opentelemetry-instrumentation-openclaw/v<version>`
- creates a GitHub Release with uploaded assets

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
