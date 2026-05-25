# Tasks — OTel Instrumentation Plugin: <AGENT>

> 30 步固定序列,从 codex/claude 插件落地反推。
> 每个 task 单独执行 + 验证;失败 → self-correct(最多 3 次)。

**Feature ID**:1xx-instrumentation-<AGENT>
**生成日期**:YYYY-MM-DD

---

## Phase A — 项目脚手架(Setup)

### T01. package.json + 依赖
- 创建 `opentelemetry-instrumentation-<AGENT>/package.json`
- name: `@loongsuite/opentelemetry-instrumentation-<AGENT>`
- bin: `otel-<AGENT>-hook`
- dependencies:`@loongsuite/opentelemetry-util-genai` / `@opentelemetry/sdk-trace-node` / `@opentelemetry/exporter-trace-otlp-proto` / `commander`
- devDependencies:`tsup` / `typescript` / `@types/node`
- 验收:`npm install` 成功

### T02. tsconfig.json + tsup.config.ts
- 复制 codex 的版本,改 `outDir`
- 验收:`npm run typecheck` 0 错误

### T03. bin/otel-<AGENT>-hook(commander 入口)
- 8 个子命令:`session-start` / `user-prompt-submit` / `pre-tool-use` / `post-tool-use` / `stop` / `install` / `uninstall` / `check-env` / `show-config`
- 验收:`node bin/otel-<AGENT>-hook --help` 列出所有命令

---

## Phase B — 类型定义(Types)

### T04. src/state.ts
- `SessionEvent` discriminated union(对应 hook 事件类型)
- `SessionState` / `Turn` 接口
- `loadState` / `saveState` / `clearState`(基于 `~/.cache/.../sessions/` JSON 文件)
- `splitIntoTurns(state)` 把 events 切分为 turn 数组
- 验收:typecheck 通过

### T05. src/config.ts(对照 Constitution C8)
- `loadConfigFile()` 读 `~/.<AGENT>/otel-config.json`
- 字段 getters:`getEndpoint` / `getHeaders` / `getServiceName` / `getResourceAttributes` / `isDebug` / `isLogEnabled` / `getLogDir` / `getLogFilenameFormat`
- 优先级:JSON > env > 默认值;**空字符串视同未设置**
- 验收:单测覆盖各字段优先级

### T06. src/log-records.ts(可选,如需 JSONL 输出)
- 生成 event_t schema(`llm.request` / `llm.response` / `tool.call` / `tool.result`)
- 验收:typecheck 通过

---

## Phase C — Transcript 解析

### T07. src/transcript.ts:基础结构
- `TranscriptData` 接口:含 `model` / `modelProvider` / `tokenEvents[]` / `totalUsage`
- `parseTranscript(path)` 主函数,按行解析 JSONL

### T08. transcript:token 数据
- 在每个 LLM 调用事件中提取 `input_tokens` / `output_tokens` / `cached_input_tokens`
- 验收:用真实 transcript 文件单测

### T09. transcript:system_instructions + tool.definitions(Constitution C3)
- `TranscriptData` 加 `systemInstruction?: MessagePart[]` + `toolDefinitions?: ToolDefinition[]`
- 提取 agent 的 system prompt 文本 + 动态注册的 tool 列表
- 转换 tool 类型为 util-genai 的 `FunctionToolDefinition` 格式
- 验收:解析后属性结构对齐 ARMS semconv

---

## Phase D — Replay 引擎

### T10. src/replay.ts:toMs() helper(Constitution C2)
- 顶层定义 `function toMs(epochSec: number): number { return epochSec * 1000; }`
- 验收:单测

### T11. replay:buildReactSteps(turn) 函数
- 把 turn events 切分为 ReAct 步骤(LLM call + 后续 tool calls)
- 验收:单测覆盖多种 step 模式

### T12. replay:replayTurn 主驱动
- 创建 ENTRY → AGENT → STEP → LLM/TOOL 树状 span
- 每个 invocation 设置必采属性(spec 1.4 清单全部)
- **每个时间值都用 toMs() 包装**
- 验收:E2E InMemorySpanExporter 检查 span 树结构

### T13. replay:agent + LLM 注入 systemInstruction + toolDefinitions
- AGENT span 一次,每个 LLM span 都带
- 验收:E2E 检查 `gen_ai.system_instructions` / `gen_ai.tool.definitions` 同时出现在 AGENT 和 LLM span

---

## Phase E — Hook 命令处理

### T14. cli.ts:cmdSessionStart
- 读 stdin → 初始化 SessionState → saveState

### T15. cli.ts:cmdUserPromptSubmit
- 读 stdin → 追加 user prompt event → saveState

### T16. cli.ts:cmdPreToolUse
- 读 stdin → 追加 pre_tool_use event → saveState

### T17. cli.ts:cmdPostToolUse
- 读 stdin → 追加 post_tool_use event → saveState

### T18. cli.ts:cmdStop(主回放入口)
- 读 stdin → 追加 stop event → 解析 transcript → replay → export OTLP → write JSONL → clearState
- 验收:整个 hook 链路 end-to-end

### T19. cli.ts:GenAI env 顶层注入(Constitution C3)
- 文件顶部 `??=` 注入 `OTEL_SEMCONV_STABILITY_OPT_IN` + `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
- 验收:加载 cli.js 后 process.env 已被设置

---

## Phase F — Telemetry

### T20. src/telemetry.ts:configureTelemetry()
- 创建 NodeTracerProvider + resource(必含 `gen_ai.agent.system=<AGENT>` + `acs.arms.service.feature=genai_app`,Constitution C4)
- 配置 BatchSpanProcessor + OTLPTraceExporter
- debug 模式下用 ConsoleSpanExporter
- 空 endpoint 不报异常(Constitution C8)
- 验收:E2E InMemorySpanExporter 验证 resource 含必填字段

### T21. shutdownTelemetry()
- forceFlush + shutdown,确保 trace 全部发送

---

## Phase G — Install / Uninstall

### T22. cli.ts:cmdInstall(Constitution C5)
- 生成 hook-entry.sh wrapper(Node 路径自动探测,绝对路径 + 相对路径 fallback)
- 写入目标 agent 的 hook 配置文件
- 若需 trust hash:计算 + 写入 `[hooks.state]` BEGIN/END block(Constitution C9)
- 清理 stale state(防 duplicate key)
- 支持 `--quiet` / `--user`
- 重装幂等
- 验收:重复执行 N 次,文件状态一致

### T23. cli.ts:cmdUninstall
- 移除 hook 配置 + trust block
- 删 `~/.cache/.../hook-entry.sh`(若 `--purge` 还删 sessions/)
- 验收:卸载后无残留

### T24. scripts/install.sh + uninstall.sh + pack.sh + remote-install.sh
- 复制 codex 插件版本,改名 + 路径
- 验收:`bash scripts/pack.sh` 产出 tarball

### T25. trust.ts(若适用)
- canonicalJson() / versionForToml() / computeHookTrustHash() / hookStateKey() / writeTrustedHashes() / removeStaleTrustState() / removeTrustBlock()
- 验收:写入的 hash 与目标 agent 当前算法一致(实际跑一次 agent,看 trust 状态是 Trusted)

---

## Phase H — 测试

### T26. tests/unit/*
- transcript.ts / replay.ts / config.ts / trust.ts(若有)
- 覆盖率门槛参考 codex 插件

### T27. tests/e2e/inmemory-span.test.js
- 用 InMemorySpanExporter 跑一次 mock session
- 断言 6 项:
  1. span startTime epoch sec 与系统时间一致(Constitution C2)
  2. messages 入 span(Constitution C3)
  3. resource `gen_ai.agent.system=<AGENT>`(Constitution C4)
  4. system_instructions 在 AGENT 和 LLM(spec 1.4)
  5. tool.definitions 同上
  6. **每个 LLM/TOOL/STEP/AGENT/ENTRY span `endTime - startTime > 0` 且与 mock 事件时间差对应**(Constitution C2,首例 qodercli 经验:防 hardcoded `endMs = startMs + 1` 类 bug)
- 验收:全 PASS

### T28. 真实 ARMS 验证(对照 Constitution C6 第 5 关)
- 用户提供 endpoint + license + workspace
- 跑 1-2 turn 真实对话
- 用 `arms-genai-verify` skill SearchTraces + GetTrace
- 对照 spec 1.4 必采属性清单逐项 check
- 验收:所有规范字段在 ARMS 平台可见

---

## Phase I — 打包 + 发布

### T29. bash scripts/pack.sh
- 产出 `dist/otel-<AGENT>-hook.tar.gz`
- 验收:tarball 结构完整(bin/ + dist/ + package.json)

### T30. README.md + CONTRIBUTING.md
- 复制 codex README 结构,改 agent-specific 部分
- 必须含:Quick Start / 配置字段表(对照 src/config.ts 实参)/ 完整环境变量列表 / Hook 事件表
- 顶层仓库 README 也要更新("Plugins" 表 + Quick Start 章节)
- 验收:README 字段与代码一致(可手工 grep 验证)

---

## 完成条件(Definition of Done)

- [ ] T01-T30 全部 done
- [ ] Constitution C1-C10 全部对齐
- [ ] spec 1.4 必采属性清单 100% 覆盖
- [ ] 5 道验证关全 PASS(含真实 ARMS)
- [ ] PR 创建到 alibaba/loongsuite-js-plugins
