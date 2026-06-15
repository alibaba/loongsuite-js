# Contributing to opentelemetry-instrumentation-openclaw

## Development Setup

1. Clone the repo and `cd` into the plugin directory:
   ```bash
   git clone https://github.com/alibaba/loongsuite-js.git
   cd loongsuite-js/opentelemetry-instrumentation-openclaw
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build (TypeScript → JavaScript):
   ```bash
   npm run build
   ```

4. Watch mode for development:
   ```bash
   npm run dev
   ```

## Local Testing

Install from local build into a running OpenClaw instance:

```bash
# Build first
npm run build

# Pack and install locally
bash scripts/install-local-test.sh --endpoint "https://your-otlp-endpoint" \
  --x-arms-license-key "your-key" \
  --x-arms-project "your-project" \
  --x-cms-workspace "your-workspace" \
  --serviceName "test-service"
```

Enable debug logging in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "opentelemetry-instrumentation-openclaw": {
        "enabled": true,
        "config": {
          "debug": true
        }
      }
    }
  }
}
```

Then restart the gateway and check logs:

```bash
openclaw gateway restart
openclaw gateway logs
```

## Code Style

- **TypeScript strict mode** — `any` usage is not allowed
- Follow existing naming conventions and file structure
- Use `src/` for plugin logic, keep `index.ts` as the plugin entry point

## Submitting Changes

- Fork the repo and create a feature branch from `main`
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- Ensure `npm run build` passes without errors
- Open a Pull Request with a clear description of the change and motivation

## Reporting Issues

Please include:
- OpenClaw version (`openclaw --version`)
- Node.js version (`node --version`)
- Plugin version
- Full error output (enable `debug: true` in plugin config)
