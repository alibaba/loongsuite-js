# loongsuite-js

---

![loongsuite](/docs/_assets/img/loongsuite-logo.png)

## ✨ Introduction

[![CI](https://github.com/alibaba/loongsuite-js/actions/workflows/ci.yml/badge.svg)](https://github.com/alibaba/loongsuite-js/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-1.x-blueviolet.svg)](https://opentelemetry.io)

LoongSuite JS Plugins is a key component of LoongSuite, Alibaba's unified observability data collection suite, providing OpenTelemetry instrumentation plugins for JavaScript-based AI coding agents. Collect traces, tool calls, and LLM metrics from [Claude Code](https://www.anthropic.com/claude-code), [OpenAI Codex CLI](https://github.com/openai/codex), and [OpenClaw](https://openclaw.ai) — zero code changes required.

LoongSuite includes the following key components:
* [LoongCollector](https://github.com/alibaba/loongcollector): universal node agent, which provides log collection, Prometheus metric collection, and network and security collection capabilities based on eBPF.
* [LoongSuite Python Agent](https://github.com/alibaba/loongsuite-python): a process agent providing instrumentation for Python applications.
* [LoongSuite Go Agent](https://github.com/alibaba/loongsuite-go): a process agent for Golang with compile time instrumentation.
* [LoongSuite Java Agent](https://github.com/alibaba/loongsuite-java-agent): a process agent for Java applications.
* [LoongSuite JS Plugins](https://github.com/alibaba/loongsuite-js): OpenTelemetry instrumentation plugins for JavaScript-based AI coding agents.
* Other upcoming language agents.

---

## 📦 Plugins

| Plugin | Platform | Description |
|--------|----------|-------------|
| [opentelemetry-instrumentation-claude](./opentelemetry-instrumentation-claude/) | Claude Code | Hook-based session tracing + in-process LLM call capture via `intercept.js` |
| [opentelemetry-instrumentation-codex](./opentelemetry-instrumentation-codex/) | OpenAI Codex CLI | Hook-based session tracing with JSONL event logging |
| [opentelemetry-instrumentation-openclaw](./opentelemetry-instrumentation-openclaw/) | OpenClaw | Native gateway plugin: Traces + Metrics to any OTLP backend |

All plugins follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) and work with any OTLP-compatible backend (Jaeger, Honeycomb, Alibaba Sunfire, Grafana Tempo, Alibaba Cloud ARMS, etc.).

---

## ⚡ Quick Start

### Claude Code — 5 minutes to first trace

**One-line install (with OTLP backend):**

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --service-name "my-claude-agent"
```

The script automatically installs hooks, sets up the `claude` alias, and writes the OTLP config to your shell profile. Traces appear in your backend automatically. The Span tree looks like:

```
🤖 Claude Session: "Analyze this codebase..."
├── 👤 Turn 1: Analyze this codebase...
│   ├── 🔧 Read: /src/index.js             gen_ai.span.kind=TOOL
│   ├── 🔧 Bash: npm test                  gen_ai.span.kind=TOOL
│   └── 🧠 LLM call (claude-sonnet-4-5)   gen_ai.span.kind=LLM
│       ├── input_tokens:  2048
│       └── output_tokens: 512
└── 👤 Turn 2: ...
```

📖 [Full documentation → opentelemetry-instrumentation-claude](./opentelemetry-instrumentation-claude/README.md)

---

### OpenAI Codex CLI — 5 minutes to first trace

**One-line install (with OTLP backend):**

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-codex/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --service-name "my-codex-agent"
```

The script registers 5 lifecycle hooks (`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`) into `~/.codex/hooks.json`, computes per-hook `trusted_hash` values into `~/.codex/config.toml [hooks.state]` (required by Codex >= 2026-04-22 stable hooks), and generates a Node.js wrapper at `~/.cache/opentelemetry.instrumentation.codex/hook-entry.sh`. Traces appear in your backend automatically. The event log looks like:

```
📦 Codex Session: "Fix the login bug..."
├── 👤 user-prompt-submit: Fix the login bug...
│   ├── 🔧 pre-tool-use: shell (cd src && grep -r "login")
│   ├── 🔧 post-tool-use: shell (result captured)
│   └── 🧠 llm.response
│       ├── input_tokens:  8734
│       └── output_tokens: 512
└── 🛑 stop
```

**Out-of-the-box captures (per ARMS GenAI semantic conventions):**

| Attribute | Where | Notes |
|---|---|---|
| `gen_ai.input.messages` / `gen_ai.output.messages` | every LLM, AGENT, ENTRY span | content capture defaulted to `SPAN_ONLY`; opt-out via env |
| `gen_ai.system_instructions` | AGENT + every LLM span | Codex `base_instructions` + per-turn `developer_instructions` |
| `gen_ai.tool.definitions` | AGENT + every LLM span | Codex `dynamic_tools` (e.g. `automation_update`) — built-in pseudo-tools like `shell` / `apply_patch` are described inline in the system prompt and have no structured definition |
| `gen_ai.usage.{input,output,cache_read}_tokens` | LLM (per-call) + AGENT (turn total) | parsed from Codex transcript `token_count` events |
| `gen_ai.agent.system=codex` | resource (every span) | identifies the agent runtime |

📖 [Full documentation → opentelemetry-instrumentation-codex](./opentelemetry-instrumentation-codex/README.md)

---

### OpenClaw — one-line install

```bash
curl -fsSL https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/opentelemetry-instrumentation-openclaw/install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint:4318" \
  --serviceName "my-openclaw-agent"
```

📖 [Full documentation → opentelemetry-instrumentation-openclaw](./opentelemetry-instrumentation-openclaw/README.md)

---

## 🏗️ Repository Structure

```
loongsuite-js/
├── opentelemetry-instrumentation-claude/   # Claude Code plugin (JavaScript)
│   ├── src/                                # Core source files
│   ├── test/                               # Jest test suite (101 tests)
│   ├── scripts/                            # Install / uninstall / pack scripts
│   ├── bin/otel-claude-hook                # CLI entry point
│   └── README.md
├── opentelemetry-instrumentation-codex/    # OpenAI Codex CLI plugin (TypeScript)
│   ├── src/                                # TypeScript source files
│   ├── scripts/                            # Install / uninstall / pack scripts
│   ├── bin/otel-codex-hook                 # CLI entry point
│   └── README.md
└── opentelemetry-instrumentation-openclaw/ # OpenClaw platform plugin (TypeScript)
    ├── src/                                # TypeScript source files
    ├── scripts/                            # Install / uninstall scripts
    └── README.md
```

---

## 🛠️ Development

### Prerequisites

- Node.js >= 18.0.0
- npm >= 8.0.0

### Clone and set up

```bash
git clone https://github.com/alibaba/loongsuite-js.git
cd loongsuite-js

# Claude plugin
cd opentelemetry-instrumentation-claude
npm install
npm test

# OpenClaw plugin (TypeScript, requires build)
cd ../opentelemetry-instrumentation-openclaw
npm install
npm run build
```

### Run tests

```bash
cd opentelemetry-instrumentation-claude
npm test                   # run tests
npm test -- --coverage     # with coverage report
```

### Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat:     new feature
fix:      bug fix
docs:     documentation changes
test:     test additions or fixes
refactor: code refactoring
perf:     performance improvements
chore:    build / toolchain
```

---

## 🔧 Environment Variables

### Common OTel variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP export endpoint | `https://your-backend:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Request headers (comma-separated) | `x-api-key=your-key` |
| `OTEL_SERVICE_NAME` | Service name for traces | `my-claude-agent` |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional resource attributes | `env=prod,team=infra` |

### Claude plugin specific

| Variable | Description |
|----------|-------------|
| `CLAUDE_TELEMETRY_DEBUG` | Set to `1` for console output (no backend needed) |
| `OTEL_CLAUDE_DEBUG` | Set to `1` for verbose `intercept.js` logging |
| `OTEL_CLAUDE_LANG` | Force language: `zh` or `en` (default: auto-detect) |
| `OTEL_CLAUDE_HOOK_CMD` | Override hook command name |

### Codex plugin specific

| Variable | Description |
|----------|-------------|
| `CODEX_TELEMETRY_DEBUG` | Set to `1` for verbose stderr + console span output (no backend needed). Note: `CODEX_`, not `CLAUDE_` |
| `OTEL_CODEX_LOG_ENABLED` | Set to `1` to write JSONL logs (default: `false`; for ai-agent-collector / loongsuite-pilot integration) |
| `OTEL_CODEX_LOG_DIR` | JSONL output directory (default empty → fallback to `~/.cache/opentelemetry.instrumentation.codex/sessions`) |
| `OTEL_CODEX_LOG_FILENAME_FORMAT` | `hook` → `codex-YYYY-MM-DD.jsonl` (default); other value → `codex.jsonl.YYYYMMDD` |
| `OTEL_CODEX_LANG` | Force language: `zh` or `en` (default: auto-detect) |
| `OTEL_CODEX_TARBALL_URL` | Override tarball download URL for remote install |

**Content capture** (LLM messages / system instructions / tool definitions): the plugin auto-injects `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` + `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY` at hook startup, so message/system/tool content lands on spans by default. To opt out, explicitly set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` (the latter is read at runtime — `??=` style injection respects user override).

---

## 🤝 Contributing

Contributions are welcome! Please read the contributing guide for the plugin you're working on:

- [opentelemetry-instrumentation-claude/CONTRIBUTING.md](./opentelemetry-instrumentation-claude/CONTRIBUTING.md)
- [opentelemetry-instrumentation-openclaw/CONTRIBUTING.md](./opentelemetry-instrumentation-openclaw/CONTRIBUTING.md)

**Summary:**
1. Fork the repo and create a feature branch from `main`
2. Make your changes (follow Conventional Commits)
3. Ensure tests pass: `npm test`
4. Open a Pull Request

Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 📄 License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

---

## 🔗 Related

- [OpenTelemetry](https://opentelemetry.io)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Claude Code](https://www.anthropic.com/claude-code)
- [OpenAI Codex CLI](https://github.com/openai/codex)
- [OpenClaw](https://openclaw.ai)

## Community

We are looking forward to your feedback and suggestions. You can join
our [DingTalk group](https://qr.dingtalk.com/action/joingroup?code=v1,k1,66L9GmXJMuW04ueT1Xl52pV43X2cphzO3yiGuLCm3ks=&_dt_no_comment=1&origin=11?) or scan the QR code below to engage with us.

| LoongSuite JS SIG | LoongCollector SIG | LoongSuite Python SIG |
|----|----|----|
| <img src="docs/_assets/img/loongsuite-js-sig-dingtalk.jpg" height="150"> | <img src="docs/_assets/img/loongcollector-sig-dingtalk.jpg" height="150"> | <img src="docs/_assets/img/loongsuite-python-sig-dingtalk.jpg" height="150"> |

| LoongCollector Go SIG | LoongSuite Java SIG |
|----|----|
| <img src="docs/_assets/img/loongsuite-go-sig-dingtalk.png" height="150"> | <img src="docs/_assets/img/loongsuite-java-sig-dingtalk.jpg" height="150"> |