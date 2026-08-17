# Plan — OTel Instrumentation Plugin: qodercli

> 类型 A 实施计划。从批准的 spec.md 派生。

**Feature ID**:100-instrumentation-qodercli
**对应 spec**:specs/100-instrumentation-qodercli/spec.md
**生成日期**:2026-05-15
**参考代码**:
- 架构(外置 hook 脚本):`opentelemetry-instrumentation-claude/`(JavaScript;qoder hook 协议同构)
- 代码风格(TypeScript + util-genai + vitest):`opentelemetry-instrumentation-openclaw/`

---

## 1. 技术栈与目录结构

```
opentelemetry-instrumentation-qodercli/
├── package.json                              # @loongsuite/opentelemetry-instrumentation-qodercli
├── tsconfig.json
├── vitest.config.ts
├── bin/
│   └── otel-qodercli-hook                    # CLI 入口 shim,转发到 dist/cli.js
├── src/
│   ├── index.ts                              # 包入口,re-export 公共 API
│   ├── cli.ts                                # 全部 hook 命令处理 + install/uninstall + GenAI env 注入(C3)
│   ├── state.ts                              # SessionState / Turn / 切分逻辑;原子写入 ~/.cache/.../sessions/<id>.json
│   ├── transcript.ts                         # qodercli JSONL transcript 解析(token/system/tools/messages)
│   ├── replay.ts                             # 回放为 OTel span 树(ENTRY→AGENT→STEP→LLM/TOOL) + toMs() helper(C2)
│   ├── telemetry.ts                          # NodeTracerProvider + resource + OTLP exporter(C4 + C8)
│   ├── config.ts                             # ~/.qoder/otel-config.json 读取(C8 优先级 + 空字符串处理)
│   └── hooks.ts                              # Hook 事件类型 + 工具格式化函数
├── scripts/
│   ├── install.sh                            # 本地安装(NPM 全局 + 回退本地 bin)
│   ├── uninstall.sh                          # 卸载(含 fallback 清理)
│   ├── pack.sh                               # 打包 tarball(产出 dist/otel-qodercli-hook.tar.gz)
│   ├── remote-install.sh                     # 远程一键安装(curl | bash)
│   └── setup-alias.sh                        # 向 .bashrc/.zshrc 添加 qodercli alias(可选)
├── test/
│   ├── unit/
│   │   ├── state.test.ts
│   │   ├── transcript.test.ts
│   │   ├── replay.test.ts
│   │   └── config.test.ts
│   └── e2e/
│       └── inmemory-span.test.ts             # InMemorySpanExporter 端到端
└── README.md
```

参考实现:
- **架构骨架**(hook 脚本协议、SessionState 文件、cmdInstall/cmdUninstall):直接借鉴 `opentelemetry-instrumentation-claude/src/cli.js`
- **TS 组织 + util-genai 集成**:借鉴 `opentelemetry-instrumentation-openclaw/src/`

---

## 2. 关键设计决策

### 2.1 数据流(对照 spec 1.2)

```
[qodercli 进程] ──hook stdin JSON──> [otel-qodercli-hook <event>] ──appends──> [~/.cache/opentelemetry.instrumentation.qodercli/sessions/<session_id>.json]

                                                        ┌─ Stop event 触发
                                                        ▼
                                              parseTranscript(jsonl)  ──┐
                                                                        │
                                                                        ▼
                                                      replayTurn → ENTRY/AGENT/STEP/LLM/TOOL spans → OTLP exporter
```

- **每个 hook event** 由 qodercli 启动子进程(`otel-qodercli-hook <subcommand>`),从 stdin 读 JSON
- **追加事件到 SessionState 文件**:`~/.cache/opentelemetry.instrumentation.qodercli/sessions/<session_id>.json`(原子写入,防并发)
- **Stop event 触发回放**:读 transcript JSONL + SessionState → 构建 span 树 → BatchSpanProcessor.forceFlush → shutdown
- **Per-turn 切分**(spec 1.3):每个 `UserPromptSubmit` 起新 trace;同 session 多 turn 共享 `gen_ai.session.id` 但 traceId 独立。Stop 触发时,如果有未导出的 turn,把它们都导出

**为什么 transcript 而不是 hook 事件**:
- hook 事件不带 token usage / messages 内容(只有 `prompt` 文本和 `tool_input/tool_response`)
- transcript JSONL 已有 `message.usage.{input_tokens, output_tokens, cache_read_input_tokens}` + 完整 messages — 直接复用 claude 插件验证过的 replay 模式

### 2.2 Span 时间(Constitution C2)

- SessionState 内部 timestamp 单位:**秒**(`Date.now() / 1000`)— 与 transcript JSONL 的 ISO timestamp 解析后的秒级时间戳一致
- 传给 OTel SDK 之前,通过 `replay.ts` 顶层定义的 helper 转换:
  ```ts
  function toMs(epochSec: number): number { return epochSec * 1000; }
  ```
- 所有 `tracer.startSpan(name, { startTime })` 和 `span.end(endTime)` 调用必须经过 `toMs()` 包装
- E2E 验证:用 InMemorySpanExporter 检查 `span.startTime[0]`(epoch sec 部分)与系统时间差 < 60s

### 2.3 Content capture(Constitution C3)

`cli.ts` 顶部:
```ts
process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] ??= "gen_ai_latest_experimental";
process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] ??= "SPAN_ONLY";
```
默认开启;若用户显式设 `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` 仍能 opt-out。

`replay.ts` 在 invocation 上设置 `inputMessages` / `outputMessages` / `systemInstruction` / `toolDefinitions`,通过 util-genai 的 `applyXxxFinishAttributes` 注入到 ENTRY / AGENT / LLM span(util-genai 内部会调用 `shouldCaptureContentInSpan()` 决定是否真正写入)。

### 2.4 Hook trust(C9)— **不适用**

qodercli 文档未提及 hook trust hash。settings.json 直接生效,无需 hash 校验。`trust.ts` 文件 **不创建**,T25 跳过。

### 2.5 transcript 解析关键点

JSONL 字段(spec §1.2 已固定):
- 一行 = 一条 message,字段:`type`(user/system/assistant) / `uuid` / `timestamp`(ISO 字符串) / `parentUuid` / `sessionId` / `cwd` / `version` / `entrypoint`(qodercli 用 `cli`)
- `message.role`:user / assistant
- `message.id`(assistant only):**多 chunk 共享同一 id** — replay 时把 message.id 相同的多条记录合并为 1 个 LLM 调用
- `message.usage`:`{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, server_tool_use, ...}`
- `message.model`:模型名(可能是 `auto` / `claude-opus-4-x` / 等)
- `message.stop_reason`:`tool_use` / `end_turn` / null(非最后一条 chunk)
- `message.content`:array,part 类型 = `text` / `thinking` / `redacted_thinking` / `tool_use{id,name,input}` / `tool_result{tool_use_id,content,is_error}`(后者出现在 user message 中)

合并策略:
1. 按行扫 JSONL,按 `message.id` 分组所有 assistant chunks
2. 每组合并为一个 LLM invocation:把所有 chunks 的 `content[]` 串起来,取最后一个 chunk 的 `usage` + `stop_reason`
3. 由 promptId 关联 user prompt → 一组 turn
4. 在每个 turn 内,以 LLM 调用为锚点切 STEP:LLM call(N) + 接下来的 tool_use/tool_result(N) = STEP N

**provider 推断规则**:
- model 含 `claude` 或 tool_use_id 含 `toolu_bdrk_*` → `gen_ai.provider.name=anthropic`(qodercli 后端走 Anthropic Bedrock)
- model 含 `gpt` / `o1` / `o3` → `openai`
- 其他 / `auto` → `unknown`(尽力)

### 2.6 子 agent transcript

子 agent transcript 路径:`~/.qoder/projects/{slugified-cwd}/{session_id}/subagents/{subagent_id}.jsonl`。

- `SubagentStart` event:用 `agent_id` / `agent_type` 在 session state 标记一个待开启的子 span
- 子 agent 自己的 transcript 文件被独立解析为子 AGENT span
- 嵌套:在 replay 时,子 AGENT span 的 parentSpanContext = 主 STEP span(根据 SubagentStart 时父 STEP 推断)

---

## 3. 测试策略

### 3.1 单元测试(`test/unit/`)
- `state.test.ts`:loadState/saveState 原子写入;splitIntoTurns 正确边界(UserPromptSubmit / Stop)
- `transcript.test.ts`:多 chunk 合并(同 message.id)、tool_use/tool_result 配对、provider 推断、空文件处理
- `replay.test.ts`:buildReactSteps 输出顺序、toMs() 转换、message.id 顺序保持
- `config.test.ts`:env > 默认值优先级;空字符串视同未设置(C8)

### 3.2 E2E(`test/e2e/inmemory-span.test.ts`)
固定 mock SessionState + mock TranscriptData,跑 `replayTurn`,用 InMemorySpanExporter 收集,断言:
1. **Span 树结构**:1 ENTRY → 1 AGENT → ≥1 STEP →(每个 STEP 含 1 LLM + 0..N TOOL)
2. **必采属性**(spec 1.4):
   - LLM:`gen_ai.span.kind=LLM` + `gen_ai.operation.name=chat` + `gen_ai.usage.input_tokens` + `gen_ai.request.model` + `gen_ai.response.model` + `gen_ai.input.messages` + `gen_ai.output.messages` + `gen_ai.system_instructions` + `gen_ai.tool.definitions`
   - AGENT:`gen_ai.agent.name=qodercli` + 汇总 `gen_ai.usage.{input,output,total,cache_read.input}_tokens`
   - ENTRY:`gen_ai.session.id` + `gen_ai.input.messages` + `gen_ai.output.messages` + `gen_ai.span.kind=ENTRY`
   - TOOL:`gen_ai.tool.name` + `gen_ai.tool.call.id` + `gen_ai.tool.call.arguments` + `gen_ai.tool.call.result`
   - STEP:`gen_ai.span.kind=STEP` + `gen_ai.react.round`
3. **Resource**:`gen_ai.agent.system=qodercli` + `acs.arms.service.feature=genai_app` + `service.name`
4. **时间**:`startTime[0]`(秒) ≈ Date.now()/1000(±60s)
5. **多 turn**:同 session 起 2 个 turn,产生 2 条独立 traceId,但 ENTRY 上的 `gen_ai.session.id` 相同

### 3.3 真实 ARMS 验证(P3,T28)
- endpoint:`https://proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry`
- headers:`x-arms-license-key=hwx28v3j7p@672218fb660eec3,x-arms-project=proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong,x-cms-workspace=default-cms-1819385687343877-cn-hongkong`
- 流程:install → 跑 1 turn(让 qodercli 至少跑 1 个 Bash 工具)→ wait 60s for OTLP flush → 用 `arms-genai-verify` skill 找 traceId 校验

---

## 4. 与现有 util 库的复用

**必须复用,不重写**:
- `@loongsuite/opentelemetry-util-genai`:
  - 类型:`LLMInvocation` / `InvokeAgentInvocation` / `EntryInvocation` / `ReactStepInvocation` / `ExecuteToolInvocation` / `InputMessage` / `OutputMessage` / `MessagePart` / `ToolDefinition` / `FunctionToolDefinition`
  - 工厂:`createLLMInvocation` / `createInvokeAgentInvocation` / `createEntryInvocation` / `createReactStepInvocation` / `createExecuteToolInvocation`
  - Span utils:`getLlmMessagesAttributesForSpan` / `getToolDefinitionsForSpan` / `applyLlmFinishAttributes` / `applyInvokeAgentFinishAttributes` / `applyEntryFinishAttributes` / `applyReactStepFinishAttributes` / `applyExecuteToolFinishAttributes`
  - Util:`shouldCaptureContentInSpan` / `genAiJsonDumps`
- `@opentelemetry/sdk-trace-base`:`BasicTracerProvider` + `BatchSpanProcessor`
- `@opentelemetry/sdk-trace-node`:`NodeTracerProvider`(claude 用的;openclaw 用 base — 我们用 node 因为有进程上下文)
- `@opentelemetry/exporter-trace-otlp-proto`:`OTLPTraceExporter`
- `@opentelemetry/resources`:`Resource`

**禁止自创**:
- 自己手写 span 属性 key/value(必须经 `applyXxxFinishAttributes`)
- 自己序列化 messages(必须经 `getLlmMessagesAttributesForSpan`)
- 自己实现 token histogram(util-genai 已提供)

---

## 5. 文件清单(实施时映射到 tasks.md)

按 tasks.md 的固定 30 步序列展开。本 plan 已确定:
- ✅ T01-T03 脚手架
- ✅ T04-T06 类型(T06 不输出 JSONL pilot 日志,但保留通用 file logger 用于 debug)
- ✅ T07-T09 transcript 解析
- ✅ T10-T13 replay 引擎
- ✅ T14-T19 hook 命令(11 个事件,跳过 SessionEnd 简化为 Stop 别名;PostToolUseFailure / PreCompact / Notification / SubagentStart/Stop 走通用 append 路径)
- ✅ T20-T21 telemetry
- ✅ T22-T24 install/uninstall + scripts
- ⏭️ T25 trust.ts — **跳过**(qodercli 无 trust 机制)
- ✅ T26-T27 测试
- ✅ T28 真实 ARMS 验证
- ✅ T29-T30 打包 + README

实际任务数:30 - 1(T25) = 29。
