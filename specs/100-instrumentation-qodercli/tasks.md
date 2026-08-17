# Tasks — OTel Instrumentation Plugin: qodercli

> 29 步固定序列(T25 trust.ts 已跳过 — qodercli 无 hook trust 机制)。
> 每个 task 独立执行 + 验证;失败 → self-correct(retry budget = 3,见 04-self-correct.md)。

**Feature ID**:100-instrumentation-qodercli
**生成日期**:2026-05-15

## Status Summary
- Total: 29
- Pending: 0
- In progress: 0
- Done: 29
- Blocked: 0

---

## Phase A — 项目脚手架(Setup)

### T01. package.json + 依赖 — `done`
- 创建 `opentelemetry-instrumentation-qodercli/package.json`
- name: `@loongsuite/opentelemetry-instrumentation-qodercli`,version: `0.1.0`,license: Apache-2.0
- bin: `{ "otel-qodercli-hook": "bin/otel-qodercli-hook" }`
- main / module / types: dist 入口
- scripts: `build` (tsc) / `typecheck` (tsc --noEmit) / `test` (vitest run) / `test:coverage` / `clean` / `pack`
- dependencies:`@loongsuite/opentelemetry-util-genai` `^0.1.0` / `@opentelemetry/api` `^1.9.0` / `@opentelemetry/sdk-trace-base` / `@opentelemetry/sdk-trace-node` / `@opentelemetry/exporter-trace-otlp-proto` / `@opentelemetry/resources` / `@opentelemetry/semantic-conventions` / `commander` `^14`
- devDependencies:`typescript` `^5` / `@types/node` `^20` / `vitest` `^4` / `@vitest/coverage-v8`
- engines.node: `>= 18.0.0`
- repository.directory: `opentelemetry-instrumentation-qodercli`
- 验收:目录创建 + JSON 合法 + 字段完整

### T02. tsconfig.json + vitest.config.ts — `done`
- 复制 openclaw 的 tsconfig.json,target=ES2022,module=NodeNext,outDir=dist,strict=true
- vitest.config.ts:globals=true,include=test/**/*.test.ts,coverage.provider=v8,coverage.reporter=[text,html]
- 验收:`npm run typecheck` 0 错误(此时 src/ 还为空,只验证配置)

### T03. bin/otel-qodercli-hook(commander 入口 shim) — `done`
- bin/ 目录为 shim 转发到 dist/cli.js
- 内容:`#!/usr/bin/env node\nrequire("../dist/cli.js");`
- chmod 755
- src/cli.ts 中通过 commander 注册 11 个 hook 子命令 + install/uninstall/check-env/show-config:
  - hook 子命令(11):`session-start` / `user-prompt-submit` / `pre-tool-use` / `post-tool-use` / `post-tool-use-failure` / `stop` / `subagent-start` / `subagent-stop` / `pre-compact` / `notification` / `session-end`
  - 管理子命令(4):`install` / `uninstall` / `check-env` / `show-config`
- 验收:build 后 `node bin/otel-qodercli-hook --help` 列出所有命令

---

## Phase B — 类型定义(Types)

### T04. src/state.ts — `done`
- `SessionEvent` discriminated union:type ∈ {session_start | user_prompt_submit | pre_tool_use | post_tool_use | post_tool_use_failure | stop | subagent_start | subagent_stop | pre_compact | notification | session_end}
- `SessionState` 接口:sessionId / cwd / events[] / createdAt / lastActivityAt / exportedTurns(已导出的 turn 索引)
- `Turn` 接口:promptId / userPromptText / events[] / startedAt / endedAt
- `loadState(sessionId)` / `saveStateAtomic(state)` / `clearState(sessionId)` / `readAndDeleteChildState(subagentId)` — 基于 `~/.cache/opentelemetry.instrumentation.qodercli/sessions/<id>.json`,采用 `fs.writeFileSync(tmp) + fs.renameSync(final)` 原子写入
- `splitIntoTurns(state)`:把 events 切为 turn 数组 — 边界 = `user_prompt_submit` 起,下一个 `user_prompt_submit` 或 `stop`/`session_end` 止
- 验收:typecheck 通过 + state.test.ts 单测

### T05. src/config.ts(对照 Constitution C8) — `done`
- `loadConfigFile()`:读 `~/.qoder/otel-config.json`(若存在);失败/缺失返回 `{}`
- 字段 getters:
  - `getEndpoint()` / `getHeaders()` / `getServiceName()` / `getResourceAttributes()` / `isDebug()`(`QODERCLI_TELEMETRY_DEBUG`) / `isLogEnabled()` / `getLogDir()` / `getLogFilenameFormat()`
- 优先级:**JSON > env > 默认值**
- **空字符串视同未设置**(`OTEL_EXPORTER_OTLP_ENDPOINT=""` 不应崩,回退默认 — 即不导出 OTLP,只 console)
- 验收:config.test.ts 覆盖 4 个分支(JSON/env/default/empty-string)

### T06. src/hooks.ts(formatter helpers,不输出 pilot JSONL) — `done`
- `createToolTitle(toolName, input)`:为 TOOL span name 生成短标题(类似 claude `Bash: ls -la`)
- `createEventData(rawHookInput)`:从 hook stdin JSON 提取通用字段 → 标准化为 SessionEvent
- `addResponseToEventData(event, toolResponse)`:PostToolUse 时把 response 合并进 event
- `MAX_CONTENT_LENGTH=1048576` (1MB):tool args/result 超长时截断 + 标记
- 验收:typecheck + 单测覆盖 3 个 helper 关键分支

---

## Phase C — Transcript 解析

### T07. src/transcript.ts:基础结构 — `done`
- `TranscriptData` 接口:含 `model` / `modelProvider` / `tokenEvents[]`(每个 LLM 调用一个 token event,合并自同 message.id 的 chunks)/ `totalUsage` / `systemInstruction?: MessagePart[]` / `toolDefinitions?: ToolDefinition[]`
- `TokenEvent` 接口:`{messageId, model, providerName, usage, inputMessages, outputMessages, finishReasons, requestId, timestampMs}`
- `parseTranscript(path: string): TranscriptData`:按行 readLine + JSON.parse,跳过解析失败行(防 transcript 写入半行)
- `getTranscriptPath(sessionId, cwd)`:实现 spec §1.2 的 slug 规则(cwd `/` → `-`,前导 `-`)
- 验收:typecheck 通过

### T08. transcript:token 数据 + chunk 合并 — `done`
- 按 `message.id` 分组所有 type=assistant 的 records
- 每组合并:把所有 chunks 的 `content[]` 顺序串接;取最后一个 chunk 的 `usage` + `stop_reason`(qodercli 行为:最后一个 chunk 才有完整 usage)
- 提取 `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` 映射到 util-genai 字段
- provider 推断:tool_use_id `toolu_bdrk_*` 或 model 含 `claude` → `anthropic`;model 含 `gpt` → `openai`;否则 `unknown`
- 用真实 transcript 文件(`qoder-cli/transcripts.tmp.jsonl`)做 fixture 测试
- 验收:transcript.test.ts 覆盖 multi-chunk 合并 + 空 usage 容错

### T09. transcript:system_instructions + tool.definitions(Constitution C3) — `done`
- 从 transcript 第 1 条 user message(若 isMeta=true 且 content 含 system prompt 段)提取 system instruction
- qodercli 没有显式的 tool definition 列表广播,**降级方案**:从所有 assistant `tool_use` 调用中收集 `{name, input.schema?}` 推断 — 至少能采到 `name`(满足 ARMS semconv "默认仅采 type+name")
- 输出符合 util-genai 的 `FunctionToolDefinition[]` 格式
- 验收:解析后 `systemInstruction[].content` 非空 + `toolDefinitions[].name` 数量与实际 tool_use 唯一名一致

---

## Phase D — Replay 引擎

### T10. src/replay.ts:toMs() helper(Constitution C2) — `done`
- 顶层 `export function toMs(epochSec: number): number { return Math.round(epochSec * 1000); }`
- 应用边界检查:输入 < 1e9(明显是秒)正常;输入 > 1e12(明显是毫秒) 也兼容
- 验收:replay.test.ts 单测 4 个分支(秒/毫秒/0/负数)

### T11. replay:buildReactSteps(turn, transcript) — `done`
- 输入:1 个 Turn + TranscriptData
- 输出:`ReactStep[]` — 每个 step 包含 `{round, llmInvocation, toolInvocations[]}`
- 切分规则(spec §1.3):每次新 LLM 调用开 1 个 STEP,直到下一次 LLM 调用前的所有 tool_use 都属于这个 STEP
- 验收:replay.test.ts 覆盖 0 LLM / 1 LLM / 多 LLM 多 tool 三种 step 模式

### T12. replay:replayTurn 主驱动 — `done`
- 创建 ENTRY span(operation_name=enter,kind=ENTRY)→ 子 AGENT span(invoke_agent / qodercli) → STEP/LLM/TOOL 树状
- 每个 invocation 通过 util-genai 的 `createXxxInvocation` + `applyXxxFinishAttributes` 注入必采属性(spec §1.4)
- **每个时间值都用 toMs() 包装**
- 处理 SubagentStart/Stop:嵌套子 AGENT span,parent 是当前 STEP
- 处理 PreCompact:作为 sibling STEP(operation_name=react,react.finish_reason=compact)
- 处理 Notification:不创建 span,仅作为 ENTRY span 的 event(span.addEvent)
- 处理 PostToolUseFailure:TOOL span status = ERROR + 错误属性
- 验收:E2E InMemorySpanExporter 检查 span 树结构(项目1 ENTRY + 1 AGENT + N STEP + M LLM + K TOOL)

### T13. replay:agent + LLM 注入 systemInstruction + toolDefinitions — `done`
- AGENT span 上一次贴 systemInstruction + toolDefinitions
- 每个 LLM span 上重复贴(util-genai 内部按 `shouldCaptureContentInSpan()` 决定是否真正写入)
- 验收:E2E 检查 `gen_ai.system_instructions` / `gen_ai.tool.definitions` 同时出现在 AGENT 和 LLM span

---

## Phase E — Hook 命令处理

### T14. cli.ts:cmdSessionStart — `done`
- 读 stdin → JSON.parse → 初始化 SessionState(若存在则保留 events 并补 session_start) → saveStateAtomic
- 容错:stdin 空/非 JSON 时只 log 不抛(避免污染 qodercli stderr)
- 验收:单测 — mock stdin,断言 state 文件被创建

### T15. cli.ts:cmdUserPromptSubmit — `done`
- 读 stdin → 追加 `user_prompt_submit` event(含 promptId + userPromptText) → saveStateAtomic
- 验收:单测

### T16. cli.ts:cmdPreToolUse / cmdPostToolUse / cmdPostToolUseFailure — `done`
- 三个命令共享 helper:读 stdin → 追加对应 event → saveStateAtomic
- PreToolUse:存 tool_name + tool_use_id + tool_input
- PostToolUse:在已有 PreToolUse event 上 patch tool_response;若找不到 PreToolUse(乱序场景)则单独追加
- PostToolUseFailure:patch error 字段 + status=error
- 验收:单测覆盖 normal + 乱序 + 失败

### T17. cli.ts:cmdSubagentStart / cmdSubagentStop / cmdPreCompact / cmdNotification / cmdSessionEnd — `done`
- 5 个命令统一 helper:读 stdin → 追加对应 event → saveStateAtomic
- SubagentStop:额外触发 — 读子 agent transcript(若存在)并合并到主 state 的 subagentResults[] 中
- SessionEnd:与 Stop 行为重叠时,只做幂等 state 更新(不重复导出)
- 验收:单测

### T18. cli.ts:cmdStop(主回放入口) — `done`
- 读 stdin → 追加 stop event
- 调用 `splitIntoTurns(state)` → 找出未导出的 turns(state.exportedTurns 之外)
- 对每个 turn:`parseTranscript(getTranscriptPath(sessionId, cwd))` → `replayTurn(turn, transcript, tracerProvider)` → 等待 BatchSpanProcessor.forceFlush
- shutdownTelemetry()
- 标记 turns 为已导出,saveStateAtomic
- 容错:任何阶段抛错都不应让 qodercli 崩(stderr 报错 + exit 0)
- 验收:E2E 跑完整 hook 链路

### T19. cli.ts:GenAI env 顶层注入(Constitution C3) — `done`
- 文件第一段(在所有 import 之前):
  ```ts
  process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] ??= "gen_ai_latest_experimental";
  process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] ??= "SPAN_ONLY";
  ```
- 验收:加载 cli.js 后 process.env 已被设置(可单测)

---

## Phase F — Telemetry

### T20. src/telemetry.ts:configureTelemetry() — `done`
- 创建 `NodeTracerProvider`(`@opentelemetry/sdk-trace-node`)
- Resource(Constitution C4 必须):
  - `service.name`:env / config / 默认 `qodercli-agent`
  - `gen_ai.agent.system`:固定 `qodercli`
  - `acs.arms.service.feature`:固定 `genai_app`
  - `service.version`:从 package.json 读
- 配置 BatchSpanProcessor + OTLPTraceExporter(`@opentelemetry/exporter-trace-otlp-proto`)
- debug 模式(`QODERCLI_TELEMETRY_DEBUG=1`):额外加 ConsoleSpanExporter
- 空 endpoint 不报异常(C8):`if (!endpoint) skip OTLP, only console (or noop in non-debug)`
- 返回 `{ tracer, provider }`
- 验收:E2E InMemorySpanExporter 验证 resource 含必填字段(C4)

### T21. shutdownTelemetry() — `done`
- `provider.forceFlush()` await + `provider.shutdown()` await
- 容错:超时(默认 5s)后 log warn 不抛
- 验收:Stop hook 流程末尾 trace 全部 flush(E2E 验证)

---

## Phase G — Install / Uninstall

### T22. cli.ts:cmdInstall(Constitution C5) — `done`
- 生成 `~/.cache/opentelemetry.instrumentation.qodercli/hook-entry.sh`(Node 路径自动探测,绝对 + 相对 fallback,内容固定模板)
- 写入 `~/.qoder/settings.json` 的 `hooks` 段(深合并,保留用户已有的其他 hooks)
- 11 个 event 全部注册,command = `otel-qodercli-hook <subcommand>`(子命令名见 T03)
- 不需要 trust hash(C9 不适用)
- 支持 `--quiet`(抑制非错误 stderr)+ `--user`(用户级 settings.json,默认开启)+ `--project`(改为 `${cwd}/.qoder/settings.json`)
- **重装幂等**(C5 关键):删除自己注册的 11 个 hook 中所有重复项,然后重新写;**不能因为已安装而 early return**
- 验收:重复执行 N 次,settings.json 状态一致

### T23. cli.ts:cmdUninstall — `done`
- 移除 settings.json 的 `hooks` 段中由本插件注册的 11 个 event 项(其他 hooks 保留)
- 删 `~/.cache/opentelemetry.instrumentation.qodercli/hook-entry.sh`
- 支持 `--purge`(同时删除 sessions/ 目录)+ `--project`(同时清理项目级 settings)
- 容错:hook bin 已损坏 / 不存在时仍清干净配置(C5)
- 验收:卸载后 settings.json 中无残留

### T24. scripts/install.sh + uninstall.sh + pack.sh + remote-install.sh + setup-alias.sh — `done`
- 复制 claude 插件 scripts/ 版本,改名 + 路径(`~/.claude/` → `~/.qoder/`,`otel-claude-hook` → `otel-qodercli-hook`)
- install.sh:`npm install -g @loongsuite/opentelemetry-instrumentation-qodercli`(主路径)+ 失败时回退 `npm install` + 软链 bin 到 PATH
- shell profile 写入用 `# BEGIN otel-qodercli-hook` / `# END` marker(C7 强制)
- pack.sh:产出 `dist/otel-qodercli-hook.tar.gz`
- remote-install.sh:curl 下 OSS 远程入口(暂用 placeholder URL,P2 阶段补)
- setup-alias.sh:可选,向 .bashrc/.zshrc 加 `qodercli` alias 设置 OTLP env
- 验收:`bash scripts/pack.sh` 产出 tarball + tarball 解压结构正确

### T25. trust.ts — **跳过(qodercli 无 hook trust)**

---

## Phase H — 测试

### T26. test/unit/* — `done`
- state.test.ts:loadState/saveState/splitIntoTurns/原子性
- transcript.test.ts:multi-chunk 合并 + provider 推断 + tool_use/tool_result 配对
- replay.test.ts:toMs / buildReactSteps / replayTurn 各分支
- config.test.ts:JSON > env > default 优先级 + 空字符串
- hooks.test.ts:createToolTitle / createEventData / 截断
- 覆盖率门槛:lines ≥ 70% / branches ≥ 50%(参考 claude 插件)
- 验收:`npm test` 全 PASS + 覆盖率达标

### T27. test/e2e/inmemory-span.test.ts — `done`
- 用 `InMemorySpanExporter` + 固定 mock SessionState(2 个 turn,每个 turn 1 LLM + 2 tool calls)+ mock TranscriptData(对应 LLM 含 messages + usage)
- 跑 `replayTurn` ×2
- 断言 5 项(plan §3.2):span 树结构 + 必采属性 + resource + 时间(epoch sec ±60s) + 多 turn 共享 session.id
- 验收:全 PASS

### T28. 真实 ARMS 验证(对照 Constitution C6 第 5 关) — `done`
> Verified trace `136c9595376f0724a9ad051bc85f54ad` in cn-hongkong ARMS for service `qodercli-agent-v5final`. All 31 mandatory attrs across ENTRY/AGENT/STEP/LLM/TOOL present. 3 bugs found+fixed during V5: (1) telemetry.ts now appends `/v1/traces` to OTLP endpoint, (2) provider inference picks first non-unknown across token events, (3) system_instructions extraction also matches `<hook_context>` pattern + has synthetic fallback.
- 用户提供的:
  - endpoint:`https://proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry`
  - headers:`x-arms-license-key=hwx28v3j7p@672218fb660eec3,x-arms-project=proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong,x-cms-workspace=default-cms-1819385687343877-cn-hongkong`
- 流程:
  1. `npm install` 后 `bash scripts/install.sh` 把 hooks 写入 `~/.qoder/settings.json`
  2. export OTLP env(endpoint + headers + service.name=qodercli-agent)
  3. 跑 1 轮 qodercli `qodercli -p "ls /tmp"`(让它至少跑 1 个 Bash 工具)
  4. wait 60s for OTLP 批量 flush
  5. 用 `arms-genai-verify` skill SearchTraces + GetTrace 找 traceId
  6. 对照 spec §1.4 必采属性清单逐项 check
- 验收:所有规范字段(C1)在 ARMS 平台可见

---

## Phase I — 打包 + 发布

### T29. README.md + 顶层仓库 README 更新 — `done`
- 复制 claude 插件 README 结构,改 agent-specific 部分:
  - Quick Start(npm install + curl 一键)
  - 配置字段表(env vars + JSON config 字段对应 src/config.ts)
  - 完整环境变量列表(OTEL_* + QODERCLI_TELEMETRY_DEBUG + OTEL_QODERCLI_LANG 等)
  - Hook 事件表(11 个)
  - Trace 树状结构示例(spec §1.3)
  - 命令参考表(install/uninstall/check-env/show-config + 11 个 hook 子命令)
- 顶层仓库 README:在 "Plugins" 表里新增 qodercli 行 + 链接
- 验收:README 字段与 src/config.ts 实际代码一致(可手工 grep 验证 — `getXxx()` 函数名 vs README 字段名)

---

## 完成条件(Definition of Done)

- [ ] T01-T29 全部 done(T25 已跳过)
- [ ] Constitution C1-C8, C10 全部对齐(C9 不适用)
- [ ] spec §1.4 必采属性清单 100% 覆盖
- [ ] 5 道验证关全 PASS:
  - typecheck (T02 验证项)
  - build (T01 / T02)
  - unit tests (T26)
  - E2E InMemorySpanExporter (T27)
  - 真实 ARMS (T28)
- [ ] PR 创建到 alibaba/loongsuite-js-plugins
