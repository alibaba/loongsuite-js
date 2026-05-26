# Verification Checklist — OTel Instrumentation Plugin: <AGENT>

> 5 类验证 fail-fast 顺序执行;失败 → self-correct(累计 ≥3 次失败则停下报告)。

**Feature ID**:1xx-instrumentation-<AGENT>

---

## V1. Typecheck(`npm run typecheck`)

**通过条件**:0 错误,0 warning。

**常见失败点**:
- 漏 import util-genai 类型(`MessagePart` / `ToolDefinition` / `InvocationXxx`)
- `process.env[X]` 取出的是 `string | undefined`,赋给 `string` 字段需先判 null

**自我修复策略**:
- 报错位置贴上对应 import / 类型 narrowing
- 仍失败 → 检查 tsconfig.json 是否漏 `lib: ["es2022"]` / `moduleResolution: "node16"`

---

## V2. Build(`npm run build`)

**通过条件**:tsup 产出 `dist/cli.js` + `dist/index.js`,无错误。

**常见失败点**:
- `tsup.config.ts` 的 entry 路径错
- 依赖未 install

---

## V3. Unit tests(`npm test`)

**通过条件**:全部 PASS,覆盖率达到 codex 插件水平(transcript / replay / config 各 80%+)

**常见失败点**:
- transcript 解析对边界 case(空文件 / 损坏 JSON 行)处理不当
- replay 的 turn split 算法对单 turn / 多 turn / 含 tool calls / 末尾无 last_assistant_message 等模式覆盖不全
- `alignWithHookEvents` 在历史 transcript 场景(llmEvents 数量 > 实际 turn 内 LLM 调用数)产生 ghost span — 需验证只有最近 N 条被配对,历史事件标记 `_discarded`
- Anthropic provider 下 `input_tokens` 未加 `cache_read + cache_creation`(C11)
- 多 turn session 中 transcript 数据归属错位 — 第二个 turn 起 token 字段固定为 turn 1 的值;根因是 cmdStop 删 state 后 transcript 仍累加,从队列头部取永远拿到旧值(C14)

---

## V4. E2E InMemorySpanExporter

**位置**:`tests/e2e/inmemory-span.test.js`(参考 `/tmp/codex-trace-fix-test.js`)

**步骤**:
1. 创建 `InMemorySpanExporter` + `SimpleSpanProcessor` 注册到 NodeTracerProvider
2. 加载 cli.js(触发顶层 GenAI env 注入)
3. 构造 mock SessionState + mock TranscriptData(含 systemInstruction + toolDefinitions)
4. 调 replaySession → forceFlush
5. `exporter.getFinishedSpans()` → 断言

**6 项必须断言**:

| # | 断言 | 对应 Constitution |
|---|---|---|
| 1 | `spans[0].startTime[0]` ≈ 当前 Unix 秒(差不超过 2s) | C2 |
| 2 | LLM span attrs 含 `gen_ai.input.messages` + `gen_ai.output.messages` | C3 |
| 3 | resource attrs 含 `gen_ai.agent.system=<AGENT>` | C4 |
| 4 | `gen_ai.system_instructions` 同时出现在 AGENT 和至少 1 个 LLM span,parsed 为 array | C3 |
| 5 | `gen_ai.tool.definitions` 同上,parsed function 项 name 与 mock 一致 | C3 |
| **6** | **每个 LLM/TOOL/STEP/AGENT/ENTRY span 的 `endTime - startTime > 0`,且与 mock 事件时间差对应**(防止 hardcoded `endMs = startMs + 1` 类 bug) | **C2** |

| **7** | **JSONL 每条 record 含非 null 的 `trace_id`(32位hex)、`span_id`(16位hex)、`parent_span_id`(16位hex);同一 turn 内 trace_id 一致** | **C12** |
| **8** | **含 cache token 的 LLM 事件,`usage.input_tokens` = api_input + cache_read + cache_creation(不是仅 api_input)** | **C11** |
| **9** | **多 turn 场景:同一 session 连续 N≥3 个 turn,每个 turn 的 LLM span `gen_ai.usage.input_tokens` / `output_tokens` 与 transcript 真实值 1:1 对齐(各值不同,不固定)** | **C14** |

**通过条件**:9/9 PASS。

> ⚠️ **加 V4.6 的背景**:首例实施 `100-instrumentation-qodercli` 在 V5 PASS 后才被用户发现 LLM span 全是 1ms duration,根因是 `replay.ts:renderLlm` 把 `endMs = startMs + 1` 硬编码(误以为每个 LLM event 只有一个时间戳)。如果 V4 当时就检查了 duration 就能在 e2e 阶段抓到。现已固化为模板要求。

> ⚠️ **加 V4.7 的背景**:`opentelemetry-instrumentation-claude` 早期 logOnly 模式所有 record 的 `trace_id` 为 null,非 logOnly 模式完全缺少 `span_id`/`parent_span_id` 字段,导致 JSONL 数据无法与 trace 关联。现固化为模板要求。

> ⚠️ **加 V4.8 的背景**:`opentelemetry-instrumentation-claude` 直接使用 Anthropic API 的 `usage.input_tokens`(仅非缓存部分),实际上报值比真实值低 10-100 倍。Anthropic 开启 prompt caching 时必须累加全部 token 类别。

> ⚠️ **加 V4.9 的背景**:`opentelemetry-instrumentation-codex` 在 cmdStop 末尾 `clearState` 删整个 state 文件,但 codex transcript 是 session 级持久累加的;每次 cmdStop 全量重读 transcript + 从队列头部 splice,导致同一 session 内**第二个 turn 起**的 LLM span token 字段全部固定为 turn 1 的值。修复后必须靠多 turn 回归测试持续锁定该行为(参考 codex 插件的 `test/cli.test.ts`)。

### V4.7 详细测试方法 — JSONL span_id 完整性

**logOnly 模式测试**:
1. 配置仅 `log_enabled=true`,无 `otlp_endpoint`
2. 构造含 ≥2 个 LLM 调用 + ≥1 个 tool 调用的 mock transcript
3. 调用 `exportSessionTrace()` 产生 JSONL 文件
4. 逐行解析,断言每条 record:
   - `trace_id`: 非 null,`/^[0-9a-f]{32}$/`
   - `span_id`: 非 null,`/^[0-9a-f]{16}$/`
   - `parent_span_id`: 非 null,`/^[0-9a-f]{16}$/`
5. 同一 turn 内所有 record 共享相同 `trace_id`
6. LLM record 的 `parent_span_id` 指向 STEP span
7. TOOL record 的 `parent_span_id` 指向 STEP span

**非 logOnly 模式追加验证**:
1. 配置 `otlp_endpoint`(InMemoryExporter) + `log_enabled=true`
2. 执行后对比:JSONL 中的 `span_id` 与 `InMemoryExporter.getFinishedSpans()` 导出的 span 的 `spanContext().spanId` 一致
3. `trace_id` 与导出的 traceId 一致

### V4.8 详细测试方法 — input_token 全量值(Anthropic provider)

1. 构造含 cache token 的 mock LLM 事件:
   ```js
   { input_tokens: 200, cache_read_input_tokens: 15000, cache_creation_input_tokens: 3000 }
   ```
2. 调用 `exportSessionTrace()` 产生 JSONL
3. 解析 `event.name == "llm.response"` 的 record,断言:
   - `usage.input_tokens` = 18200(不是 200)
   - `usage.total_tokens` = 18200 + output_tokens
4. 对 OTel span 属性同样验证:
   - `gen_ai.usage.input_tokens` = 18200

### V4.9 详细测试方法 — 多 turn 数据对齐(C14)

**前提**:本插件**同时**消费 hook 事件流 + transcript 文件(仅消费一种数据源的插件可跳过此项)。

**单元层(必做)**:
1. 准备一份 fixture transcript,含 N≥3 个 turn,每个 turn 的 LLM token 字段**互不相同**(避免误报通过)。fixture 必须含真实场景里出现过的"心跳/快照"重发事件(同一 last_token_usage 在 turn 间重发一次),以验证去重
2. 模拟 N 次连续 cmdStop 调用(每次喂 stdin = 当前 turn 的 user_prompt_submit + stop event,transcript 文件按 turn 边界递进追加),断言:
   - 每个 turn 写出的 JSONL 中 `usage.input_tokens` / `output_tokens` / `cache_read_tokens` / `total_tokens` **与 fixture 真实值 1:1 对齐**
   - state 文件**未被 clearState 删除**(`fs.existsSync(stateFile) === true`)
   - state.events 长度为 0(已消费,但其他对齐水位线字段保留)
   - 跨调用持久化字段(如 `transcript_offset` / `last_emitted_usage`)随调用单调推进

**E2E 层(强烈推荐)**:
3. 用 `InMemorySpanExporter` 把 N 次 cmdStop 产生的 spans 全部捕获,断言:
   - 每个 turn 的 LLM span `gen_ai.usage.input_tokens` 与 fixture 真实值对齐
   - AGENT span 的汇总 token 等于本 turn 内各 LLM step 的 token 之和

**反例锁定**:测试断言**必须**包含"turn 2 / turn 3 的 token != turn 1 的 token"——这是直接锁定本类回归的核心断言;只断言"等于真实值"在 fixture 三个 turn 都恰巧相同的情况下也会过,无法防止退化。

---

## V5. 真实 ARMS Trace 验证

**前置条件**(用户在 spec review 阶段已提供):
- ARMS endpoint URL(OTLP HTTP)
- ARMS 鉴权 headers(license key + project + workspace)
- 用户已在测试机器安装好目标 `<AGENT>`

**通用步骤(任何路径都先跑这几步产生 trace)**:
1. 跑 `<AGENT>-hook install`(走完整安装流程)
2. 写 `~/.<AGENT>/otel-config.json` 配 OTLP endpoint(用户提供的 ARMS endpoint)
3. 在测试机用 `<AGENT>` 跑 1-2 turn 真实对话(如 "list files in /tmp")
4. 记下当前的 `service.name` + 时间(用作 SearchTraces 过滤)
5. 等待 ~30 秒 trace flush 到 ARMS

**接下来按 trace 拉取方式选两条路径之一**:

### 路径 A — `arms-genai-verify` skill(优先,内部用户)

**前置**:Claude Code session 中可调用 `arms-genai-verify` skill。

```
/arms-genai-verify <service.name> <agent>
```

skill 会:
- `SearchTraces` 按 service.name + 最近 5 分钟时间窗 → 找最新 traceId
- `GetTrace` 拉完整 span 树
- 对照 spec §1.4 必采属性清单,逐字段自动 check
- 输出 PASS/FAIL 报告 + 缺失属性列表

**优点**:全自动,可被 skill 在 verify 阶段编排,失败时反馈精确。

### 路径 B — ARMS 控制台手工验证(任何用户都可用)

**适用**:`arms-genai-verify` skill 不可用、不在 Claude Code session 中、或外部社区用户。

1. 登录 ARMS 控制台 → 应用监控 → 链路分析(Trace Explorer)
2. 按 `service.name=<spec.5 中的服务名>` + 时间窗(刚才的对话时间 ± 5min)搜索
3. 点开最新 trace,在右侧详情页手工对照 spec §1.4 必采属性清单:
   - Resource 含 `gen_ai.agent.system=<AGENT>` + `acs.arms.service.feature=genai_app`
   - Span 树结构:`ENTRY` → `AGENT` → `STEP*` → `LLM` / `TOOL`
   - LLM span 含 token 数据 + messages / system_instructions / tool_definitions
   - 时间字段是合理纳秒(span duration > 0)
4. 检查每条必采字段是否齐全 → 全部 √ 即 PASS

---

**通过条件(两路径同)**:
- ARMS 平台可见对应 trace(traceId 已知)
- ENTRY → AGENT → STEP → LLM/TOOL 树结构完整
- spec §1.4 列出的所有必采属性在对应 span 都能找到
- token 数据数量级合理(input / output 都 > 0)
- 每个 span 的 endTime - startTime > 0(防 hardcoded 时间 bug)

**自我修复策略**:
- 找不到 trace → 检查 endpoint / headers / OTLP protocol(`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`)/ endpoint 是否含 `/v1/traces` 后缀
- 树结构不对 → 回到 V4 检查 InMemoryExporter 是否同步暴露问题
- 字段缺失 → 检查 replay.ts 是否真的设置了对应字段(可加 console.log 临时观察)
- LLM duration = 1ms → 检查 replay.ts 的 LLM startMs/endMs 是否正确推导(参考 `examples/otel-plugin-qodercli/` 第 3 节 case 3)

---

## 总验收

5 道关全 PASS → 进 PR/CR 创建阶段(`gh pr create --repo alibaba/loongsuite-js-plugins`)。
