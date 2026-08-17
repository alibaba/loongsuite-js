# opentelemetry-instrumentation-qodercli

OpenTelemetry instrumentation for [Qoder CLI](https://docs.qoder.com/), reporting per-turn AI agent execution traces (sessions / turns / tools / LLM calls) to any OTLP-compatible backend, in conformance with the [ARMS GenAI semantic convention](https://help.aliyun.com/zh/arms/).

Spans use the GenAI semconv kinds:

| Span | `gen_ai.span.kind` | `gen_ai.operation.name` |
|------|---------------------|--------------------------|
| `enter_ai_application_system` | ENTRY | `enter` |
| `invoke_agent qodercli`       | AGENT | `invoke_agent` |
| `react step`                  | STEP  | `react` |
| `chat <model>`                | LLM   | `chat` |
| `execute_tool <name>`         | TOOL  | `execute_tool` |

Typical trace tree per user turn:

```
enter_ai_application_system        (ENTRY, traceId-A, gen_ai.session.id=<sid>)
  └── invoke_agent qodercli        (AGENT)
       ├── react step              (STEP, round=1)
       │    ├── chat claude-x      (LLM,  input/output tokens, messages)
       │    └── execute_tool Bash  (TOOL, args + result)
       └── react step              (STEP, round=2)
            └── chat claude-x      (LLM,  end_turn)
```

Each `UserPromptSubmit` opens a new trace, so multiple turns within one session
share `gen_ai.session.id` but have independent trace IDs.

---

## Requirements

| Dependency | Version |
|------------|---------|
| Node.js    | ≥ 18.0.0 |
| Qoder CLI  | any version that supports `~/.qoder/settings.json` `hooks` |

---

## Installation

### Option 1: npm global (recommended)

```bash
npm install -g @loongsuite/opentelemetry-instrumentation-qodercli
```

The `postinstall` step automatically writes hook entries into `~/.qoder/settings.json`.

### Option 2: source install

```bash
git clone https://github.com/alibaba/loongsuite-js-plugins.git
cd loongsuite-js-plugins/opentelemetry-instrumentation-qodercli
bash scripts/install.sh
```

### Option 3: one-line remote install

```bash
curl -fsSL https://<your-host>/remote-install.sh | bash -s -- \
  --endpoint "https://your-otlp-endpoint" \
  --headers "x-arms-license-key=...,x-arms-project=..." \
  --service-name "my-qodercli-agent"
```

---

## Configuration

All configuration is via environment variables (`~/.qoder/otel-config.json` is also honored, see below).

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/proto endpoint URL | _required_ (or use debug mode) |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Comma-separated `key=value` headers | — |
| `OTEL_SERVICE_NAME`           | service.name resource attribute | `qodercli-agent` |
| `OTEL_RESOURCE_ATTRIBUTES`    | Extra `key=value,...` attrs | — |
| `QODERCLI_TELEMETRY_DEBUG`    | Set `1` to also log spans to console | unset |
| `OTEL_QODERCLI_HOOK_CMD`      | Override hook command name (advanced) | `otel-qodercli-hook` |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | `SPAN_ONLY` to capture messages, `NO_CONTENT` to opt out | `SPAN_ONLY` (auto-set) |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | Required for messages capture (auto-set) | `gen_ai_latest_experimental` |

**Constitution C8**: empty-string values are treated as unset — e.g. `OTEL_EXPORTER_OTLP_ENDPOINT=""` will not crash the plugin.

### Optional JSON config

```json
// ~/.qoder/otel-config.json
{
  "endpoint": "https://your-otlp-endpoint",
  "headers": { "x-arms-license-key": "...", "x-arms-project": "..." },
  "serviceName": "my-qodercli-agent",
  "debug": false
}
```

Priority: **JSON > env > default**.

### Sample: Aliyun ARMS / SLS-OTEL backend

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://<your-project>.cn-<region>.log.aliyuncs.com/apm/trace/opentelemetry"
export OTEL_EXPORTER_OTLP_HEADERS="x-arms-license-key=<key>,x-arms-project=<project>,x-cms-workspace=<workspace>"
export OTEL_SERVICE_NAME="my-qodercli-agent"
```

### Local debug (no backend required)

```bash
export QODERCLI_TELEMETRY_DEBUG=1
qodercli "hello"
```

---

## How it works

1. **Hook registration** — `otel-qodercli-hook install` writes 11 hook entries into `~/.qoder/settings.json` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Notification`, `SessionEnd`).
2. **Hook subprocess** — qodercli pipes a JSON event payload to `otel-qodercli-hook <subcommand>` for each event. The hook appends the event to a per-session JSON file under `~/.cache/opentelemetry.instrumentation.qodercli/sessions/<session_id>.json` (atomic `rename` write).
3. **Stop / SessionEnd** — triggers replay: read the qodercli transcript JSONL at `~/.qoder/projects/<slugified-cwd>/<session_id>.jsonl`, merge multi-chunk assistant responses by `message.id`, build per-turn span trees, export via `BatchSpanProcessor → OTLP`, then `forceFlush + shutdown`.
4. **Subagents** — `SubagentStart`/`Stop` carry an `agent_id`; the corresponding child transcript is replayed as a nested `AGENT` span tree.

---

## Hook events captured

| Event | qodercli matcher | Span behavior |
|-------|------------------|----------------|
| `SessionStart`        | `startup` / `resume` / `compact` | initializes SessionState |
| `UserPromptSubmit`    | (none)                            | opens new trace (ENTRY) |
| `PreToolUse`          | tool name (Bash, Read, …)         | reserves TOOL span |
| `PostToolUse`         | tool name                         | finalizes TOOL span (success) |
| `PostToolUseFailure`  | tool name                         | TOOL span with status=ERROR |
| `Stop`                | (none)                            | replay + flush |
| `SubagentStart`       | agent type                        | nests sub-AGENT span |
| `SubagentStop`        | agent type                        | finalizes sub-AGENT |
| `PreCompact`          | `manual` / `auto`                 | adds span event |
| `Notification`        | `permission` / `result`           | adds span event |
| `SessionEnd`          | `prompt_input_exit` / `other`     | flushes any unexported turns |

---

## CLI reference

```bash
otel-qodercli-hook install [--user|--project] [--quiet]   # writes settings.json
otel-qodercli-hook uninstall [--user|--project] [--purge] # removes hooks
otel-qodercli-hook show-config                            # prints hook JSON snippet
otel-qodercli-hook check-env                              # prints effective env
```

The 11 hook subcommands are invoked by qodercli automatically:

```
otel-qodercli-hook session-start | user-prompt-submit | pre-tool-use |
                   post-tool-use | post-tool-use-failure | stop |
                   subagent-start | subagent-stop | pre-compact |
                   notification | session-end
```

---

## Span attributes summary

Per ARMS GenAI semconv (see `arms/semantic-conventions/arms_docs/trace/gen-ai.md`):

| Span | Mandatory attrs |
|------|----------------|
| ENTRY  | `gen_ai.span.kind=ENTRY`, `gen_ai.operation.name=enter`, `gen_ai.session.id`, `gen_ai.input.messages`, `gen_ai.output.messages` |
| AGENT  | `gen_ai.span.kind=AGENT`, `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=qodercli`, aggregated `gen_ai.usage.{input,output,total,cache_read.input}_tokens`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, messages |
| STEP   | `gen_ai.span.kind=STEP`, `gen_ai.operation.name=react`, `gen_ai.react.round` |
| LLM    | `gen_ai.span.kind=LLM`, `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.*`, messages, `gen_ai.system_instructions`, `gen_ai.tool.definitions` |
| TOOL   | `gen_ai.span.kind=TOOL`, `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.type` |

Resource (Constitution C4): `service.name`, `gen_ai.agent.system=qodercli`, `acs.arms.service.feature=genai_app`.

---

## Project layout

```
opentelemetry-instrumentation-qodercli/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── bin/otel-qodercli-hook
├── src/
│   ├── index.ts          # public API re-exports
│   ├── cli.ts            # commander entry; install / uninstall / 11 hook commands
│   ├── state.ts          # SessionState (atomic JSON), splitIntoTurns
│   ├── transcript.ts     # JSONL parser + multi-chunk merge + tool pairing
│   ├── replay.ts         # Span tree builder + toMs() helper (Constitution C2)
│   ├── telemetry.ts      # NodeTracerProvider + Resource (C4) + OTLP/proto
│   ├── config.ts         # JSON config reader + env precedence (C8)
│   └── hooks.ts          # Hook event normalizer + tool title formatter
├── scripts/
│   ├── install.sh
│   ├── uninstall.sh
│   ├── pack.sh
│   └── remote-install.sh
└── test/
    ├── unit/             # state / transcript / replay / config / hooks
    └── e2e/inmemory-span.test.ts
```

---

## License

Apache-2.0
