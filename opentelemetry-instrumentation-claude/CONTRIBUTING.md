# Contributing

## Development Setup

1. Clone the repo and `cd` into the plugin directory:
   ```bash
   git clone https://github.com/alibaba/loongsuite-js.git
   cd loongsuite-js/opentelemetry-instrumentation-claude
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Link globally for testing:
   ```bash
   npm link
   ```
4. Verify the setup:
   ```bash
   CLAUDE_TELEMETRY_DEBUG=1 otel-claude-hook check-env
   ```

## Testing intercept.js

Set `OTEL_CLAUDE_DEBUG=1` to enable verbose logging from `intercept.js`:

```bash
OTEL_CLAUDE_DEBUG=1 NODE_OPTIONS="--require ./src/intercept.js" node -e "console.log('test')"
```

## Testing Hook Commands Locally

```bash
# Simulate UserPromptSubmit
echo '{"session_id":"test-123","prompt":"hello"}' | otel-claude-hook user-prompt-submit

# Simulate Stop (exports trace)
echo '{"session_id":"test-123","stop_reason":"end_turn"}' | CLAUDE_TELEMETRY_DEBUG=1 otel-claude-hook stop
```

## Submitting Changes

- Fork the repo and create a feature branch from `main`
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- Ensure changes don't break existing hook command behavior
- Open a MR/PR with a clear description of the change and motivation

## Reporting Issues

Please include:
- OS and shell (e.g. macOS 14 / bash 5.x)
- Node.js version (`node --version`)
- Claude Code version (`claude --version`)
- Full error output with `OTEL_CLAUDE_DEBUG=1` enabled
