# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.2.0-beta] - 2026-05-08

### Added
- **Per-turn independent traces**: each conversation turn produces an independent trace (new traceId); all turns share `gen_ai.session.id`
- **STEP = LLM reasoning cycle**: STEP spans now map to one `llm_call` + resulting tool calls, matching ARMS semantic conventions
- **Transcript-based tracing**: `transcript.js` parses Claude Code native transcript JSONL for LLM call data, replacing reliance on `intercept.js` HTTP interception; works with all Claude Code versions
- **Config file support**: `~/.claude/otel-config.json` with priority: config file > env var > default
- **JSONL log collection**: chain hash incremental validation, daily file rotation, event_t schema (`llm.request`/`llm.response`/`tool.call`/`tool.result`)
- **Log-only mode**: skip OTel Trace export when only JSONL logging is needed (for ai-agent-collector integration)
- **Configurable log filename format**: `"default"` (`claude-code.jsonl.YYYYMMDD`) or `"hook"` (`claude-code-YYYY-MM-DD.jsonl`)
- **Multimodal image support**: `BlobPart` (base64) and `UriPart` (URL) across Anthropic, OpenAI Chat, and OpenAI Responses protocols
- **Message converter module**: Anthropic/OpenAI/Responses protocol conversion to ARMS semantic format
- **`--no-alias` install option**: skip shell alias setup for managed installations (pilot)
- **Cursor IDE compatibility**: `matcher` field on hook entries; auto-skip when called by Cursor
- **Hook wrapper script**: `hook-entry.sh` with built-in Node discovery (nvm, homebrew, volta, fnm fallbacks), eliminating PATH dependency
- Jest test suite: hooks, state, telemetry, intercept parsers, cli commands, transcript, message-converter

### Fixed
- **O(N²) OOM in transcript parsing**: store `input_messages` as delta instead of cumulative copies (35MB transcript: memory from >4GB to ~98MB)
- **`-p` mode missing LLM/STEP spans**: remove `setImmediate` race in `intercept.js`
- **`OTEL_RESOURCE_ATTRIBUTES` not fully parsed** into OTel Resource
- **`input.messages_delta` was cumulative**: now computes true incremental delta via slice-based diff
- **Orphaned `pre_tool_use` events**: produce TOOL spans with `tool.orphaned=true` instead of silently dropping
- **Duplicate trace generation**: events cleared after successful export in `cmdStop()`
- `process.ppid` ≠ claude PID bug: `resolveClaudePid()` walks the process tree
- `readProxyEvents` with unknown PID no longer deletes files (safe fallback)
- `tool_use_id` fallback aligned between `cmdPreToolUse` and `cmdPostToolUse` (both use `null`)
- `detectLang()` no longer spawns subprocesses; uses env vars only
- `setup-alias.sh`: add file writability check, handle `cat >>` failure gracefully
- `uninstall.sh`: add `npm uninstall -g` step for global package cleanup
- `package-lock.json` regenerated to resolve from npm registry (fix `link: true` issue)
- Remove `agent.name` from event logs, keep `agent.type` as `"claude-code"`
- Test isolation: mock `otel-config.json` reads to prevent local config interference

### Changed
- **Alias env var cleanup**: GenAI SDK env vars (Group A) moved from alias to `bin/otel-claude-hook` entry point; `NODE_OPTIONS` + `intercept.js` removed from alias
- `setup-alias.sh`: add `--minimal` mode (cleanup only, no alias write) for pilot installations
- Auto-upgrade legacy alias blocks containing `intercept.js` references
- `gen_ai.session.id` set on ALL spans (ENTRY, AGENT, STEP, LLM, TOOL), not just ENTRY
- JSONL log fields migrated from `gen_ai.*` to event_t dotted namespace

### Performance
- Hook subprocess startup latency reduced by removing synchronous OS calls in `detectLang()`

---

## [0.1.1] - 2026-04-08

### Added
- npm global install support: `npm install -g @loongsuite/opentelemetry-instrumentation-claude`
- `otel-claude-hook install --user` completes full setup (hooks + intercept.js + shell alias)
- Remote install script (`remote-install.sh`) for one-line curl-based installation
- Uninstall command: `otel-claude-hook uninstall [--purge] [--project]`
- `--quiet` flag on `install` command for safe `postinstall` execution
- Shell alias wrapped in `# BEGIN otel-claude-hook` / `# END otel-claude-hook` comment blocks
- `OTEL_CLAUDE_LANG` env var for explicit language override (zh/en)
- LICENSE (Apache-2.0), CONTRIBUTING.md, CHANGELOG.md added
- Apache-2.0 SPDX headers added to all source files

### Fixed
- Renamed Alibaba-internal field names: `dashscope_id` → `response_id`,
  `dashscope_request_id` → `request_id`, `eagleeye_trace_id` → `vendor_trace_id`
- Session JSONL isolation: `intercept.js` names files `proxy_events_<PID>.jsonl`
  (one file per claude process) to prevent cross-session event pollution
- Proxy events are deleted after being read by `cmdStop`, preventing stale data accumulation
- `createToolTitle()` inner comparisons now correctly use the `maxLength` parameter
- `removeAliasFromFile()` uses `BEGIN…END` block matching instead of broad `grep`-based filter,
  preventing accidental removal of unrelated shell lines
- Shell alias installation is idempotent: `setup-alias.sh` skips if block already present
- `postinstall` uses `|| true` to never fail `npm install` on setup errors

### Changed
- Package renamed to `@loongsuite/opentelemetry-instrumentation-claude`
- `claude` alias now uses `npx -y @anthropic-ai/claude-code@latest` for cross-platform support
- `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_METRIC_EXPORT_INTERVAL`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` added to default alias

---

## [0.1.0] - 2026-04-07

### Added
- Initial release: Node.js port of `opentelemetry-instrumentation-claude` from Python
- Hook-based session tracing via Claude Code `settings.json`:
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`,
  `SubagentStart`, `SubagentStop`, `Notification`
- `intercept.js` for in-process LLM API call capture, with three strategies:
  - **Strategy A**: undici `Dispatcher` (best for `npx @anthropic-ai/claude-code`)
  - **Strategy B**: `https.request` / `http.request` patch (bundled claude binary)
  - **Strategy C**: `globalThis.fetch` monkey-patch (Bun runtime and fallback)
- Support for Anthropic Messages API, OpenAI Chat Completions, OpenAI Responses API
- Streaming (SSE) and non-streaming (JSON) response parsing
- Nested subagent span hierarchy (`SubagentStop` inlines child session trace)
- Atomic state file writes using `rename` (matches Python `os.replace()` semantics)
- `otel-claude-hook` CLI: `install`, `uninstall`, `show-config`, `check-env`
- Bilingual output (zh/en) based on `$LANG` / `$LANGUAGE` environment variables
- OTel HrTime `[seconds, nanos]` format for nanosecond-precision span timestamps
- `CLAUDE_CODE_ENABLE_TELEMETRY=1` enabled by default via shell alias
- Apache-2.0 license
