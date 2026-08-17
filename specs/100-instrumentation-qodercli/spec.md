# Spec — OTel Instrumentation Plugin: qodercli

**Feature ID**:100-instrumentation-qodercli
**目标仓库**:`alibaba/loongsuite-js-plugins`
**插件包名**:`@loongsuite/opentelemetry-instrumentation-qodercli`
**创建日期**:2026-05-15
**状态**:Draft
**Constitution 版本**:1.0.0
**参考插件**:`opentelemetry-instrumentation-claude`(qoder-cli 的 hook 协议与 Claude Code 几乎同构,可同模板复用)

---

## 1. 概述

### 1.1 目标 agent ⭐
- **名称**:Qoder CLI(`@qoder-ai/qodercli`)
- **官方文档**:https://docs.qoder.com/
- **CLI 名称**:`qodercli`
- **支持版本**:>= 任意已支持 hooks 的版本(qoder-cli `~/.qoder/settings.json hooks` 段已 GA)
- **运行时**:Node.js (>= 18)
- **安装方式**:`npm install -g @qoder-ai/qodercli` / `curl -fsSL https://qoder.com/install | bash` / `brew install qoderai/qoder/qodercli --cask`

### 1.2 数据采集机制 ⭐

| 维度 | 选择 | 说明 |
|---|---|---|
| Hook 机制 | **是**,qoder-cli 原生支持 hooks | 配置在 settings.json,通过 stdin JSON + exit code 通信 |
| Hook 配置文件 | `~/.qoder/settings.json`(用户级)+ `${project}/.qoder/settings.json`(项目级) + `${project}/.qoder/settings.local.json`(项目本地,优先级最高) | 三级 hooks 段被合并执行 |
| Hook 事件清单 | `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `Stop` / `SubagentStart` / `SubagentStop` / `PreCompact` / `Notification` / `SessionEnd` | 共 11 个,覆盖会话/用户输入/工具/agent stop/压缩/通知/会话结束 |
| Transcript | **是**,JSONL 格式,与 Claude Code 同构 | 主路径:`~/.qoder/projects/{slugified-project-path}/{session_id}.jsonl`(slug 规则:cwd 路径分隔符 `/` → `-`,前导 `-`)。子 agent:`~/.qoder/projects/{slugified-project-path}/{session_id}/subagents/{subagent_id}.jsonl`。每行一条 message,字段含 `type`(user/system/assistant)/`uuid`/`timestamp`/`parentUuid`/`sessionId`/`cwd`/`message.{role,model,id,usage,stop_reason,content[]}` 等;assistant 多 chunk 共享 `message.id`,可用此聚合。详见 `qoder-cli/transcripts.md` + `transcripts.tmp.jsonl` |
| 进程内拦截 | **否**(默认),依赖 transcript | transcript 已含 `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`,无需 intercept.js |
| Hook trust | **否** | qoder-cli 文档未提及 hook trust hash,无需(Constitution C9 不适用) |

### 1.3 Span 树设计 ⭐

**策略**:per-turn — 每次 `UserPromptSubmit` 起一个新 trace,`Stop` 时关闭并导出;所有 turn 共享同一个 `gen_ai.session.id`。

```
ENTRY (UserPromptSubmit, 每个 user turn 独立 traceId)
  └── AGENT (qodercli)
        ├── STEP #1 (ReAct 推理 — UserPromptSubmit→第一个 PostToolUse 之间的工具调用集合)
        │     ├── LLM (chat <model>)            ← 从 transcript 重放
        │     ├── TOOL (Bash / Read / Write / Edit / Grep / Glob / mcp__*)
        │     └── ...
        └── STEP #N
              ├── LLM
              └── TOOL
```

附加 span(在主 ENTRY trace 之外或挂在 AGENT 子树):
- `🗜️ Context compaction`(PreCompact hook 触发,作为兄弟 STEP)
- `🤖 Subagent: <descr>`(SubagentStart→SubagentStop,作为子 AGENT span,父子上下文完整)
- `🔔 Notification: ...`(可选,挂为 event 不单独 span)
- `❌ ToolFailure: <tool>`(PostToolUseFailure,作为 TOOL span 但 status=ERROR)

**Step 划分规则**(qoder-cli 没有显式 ReAct 边界事件,采用启发式):
- 每个 `UserPromptSubmit` 之后到下一次 `UserPromptSubmit` 或 `Stop` 之间为 1 个 turn(即 1 个 ENTRY trace)
- 在一个 turn 内,以"LLM 响应 → 1 组 PreToolUse/PostToolUse → 下一次 LLM 响应"为 1 个 STEP
- Step 边界识别:每次新 LLM 调用开启一个 STEP,该 STEP 持续到下一次 LLM 调用之前

注:严格符合 Constitution C1 的 span.kind / operation.name 枚举要求。

### 1.4 必采属性清单 ⭐

按 ARMS GenAI semconv,必须采集:

**LLM span**(从 transcript 或 intercept.js 取):
- `gen_ai.span.kind=LLM` / `gen_ai.operation.name=chat`
- `gen_ai.provider.name`(`anthropic` / `openai` / 自动从 model 推断)
- `gen_ai.request.model` / `gen_ai.response.model` / `gen_ai.response.finish_reasons`
- `gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens` / `cache_read.input_tokens` / `cache_creation.input_tokens`
- `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` / `gen_ai.tool.definitions`(C3 默认开启;可 opt-out)

**AGENT span**:
- `gen_ai.span.kind=AGENT` / `gen_ai.operation.name=invoke_agent`
- `gen_ai.agent.name`(默认 `qodercli`)
- 汇总 `gen_ai.usage.{input,output,total,cache_read.input}_tokens`(子 LLM span 求和)
- `gen_ai.system_instructions` / `gen_ai.tool.definitions`(C3 默认开启)

**ENTRY span**:
- `gen_ai.span.kind=ENTRY` / `gen_ai.operation.name=enter`
- `gen_ai.session.id`(取 hook stdin 的 `session_id`)
- `gen_ai.user.id`(若 qodercli 提供,否则空)
- `gen_ai.input.messages`(取 UserPromptSubmit 的 `prompt`)
- `gen_ai.output.messages`(取 Stop 时 transcript 中最后一条 assistant 消息)

**TOOL span**:
- `gen_ai.span.kind=TOOL` / `gen_ai.operation.name=execute_tool`
- `gen_ai.tool.name`(取 hook stdin 的 `tool_name`,如 `Bash` / `Read` / `Write` / `mcp__server__tool`)
- `gen_ai.tool.call.id`(取 hook stdin 的 `tool_use_id`,如 `toolu_01ABC123`)
- `gen_ai.tool.call.arguments`(序列化 `tool_input`,JSON 字符串;C3 控制)
- `gen_ai.tool.call.result`(序列化 `tool_response`,失败时为 `error` 字段;C3 控制)
- `gen_ai.tool.type=function`(默认;mcp__ 前缀工具标 `extension`)

**STEP span**:
- `gen_ai.span.kind=STEP` / `gen_ai.operation.name=react`
- `gen_ai.react.round`(从 1 开始)
- `gen_ai.react.finish_reason`(若有)

**Resource**(Constitution C4):
- `service.name`:env `OTEL_SERVICE_NAME` 或默认 `qodercli-agent`
- `gen_ai.agent.system=qodercli`
- `acs.arms.service.feature=genai_app`

### 1.5 JSONL 日志输出 ⚪ 可选(P2)

支持 pilot 集成的 event_t schema 输出(范围外 — 由后续 pilot 集成 PR 处理,见 4.3)。

---

## 2. 用户场景

### 2.1 用户故事 — 基础 trace 采集(P1)
作为 qodercli 用户,我希望我每轮对话都能在 OTLP 后端看到完整 trace,包括我说了什么、qodercli 调了什么工具、用了多少 token。

**验收标准**:
1. 安装插件后(`npm install -g @loongsuite/opentelemetry-instrumentation-qodercli` 或 `bash scripts/install.sh`)无需修改 qodercli 启动方式即可生效
2. 每轮 trace 完整(span 树符合 1.3 节)
3. token 数据准确(误差 ≤ 1%,以 transcript / intercept 数据为准)
4. 在 ARMS / cms2.0 平台上可查到 trace

### 2.2 用户故事 — debug 模式(P1)
作为开发/调试用户,可以设置 `QODERCLI_TELEMETRY_DEBUG=1` 把 span 输出到 console,无需配置 OTLP 后端。

### 2.3 用户故事 — pilot 集成(P2,本轮范围外)
后续以独立类型 B PR 接入 loongsuite-pilot。

---

## 3. 与已有插件的差异

| 维度 | 本插件 (qodercli) | claude(参考) | codex(参考) |
|---|---|---|---|
| 配置文件位置 | `~/.qoder/settings.json` | `~/.claude/settings.json` | `~/.codex/hooks.json` + `config.toml` |
| LLM 数据来源 | transcript(用户已确认存在;实际路径 TBD) | transcript + intercept.js | transcript |
| Hook trust | 无 | 无 | 需要 |
| Hook 事件数 | 11(SessionStart/End + UserPromptSubmit + Pre/Post/PostFail-ToolUse + Stop + Subagent× 2 + PreCompact + Notification) | 8 | 5 |
| 进程内拦截 | 暂无(若后续发现 transcript 不含 token,降级到 intercept.js) | 有(intercept.js) | 无 |
| Span 切分粒度 | per-turn(每个 UserPromptSubmit 起一个 trace) | per-turn(最新行为) | per-turn |

**结论**:与 claude 插件结构最接近,可作为代码骨架克隆并改造(改路径、改 hook 事件名、改 transcript 解析)。

---

## 4. 远程安装与分发 ⭐

### 4.1 npm 全局安装(主路径)
```bash
npm install -g @loongsuite/opentelemetry-instrumentation-qodercli
# postinstall 自动跑 `otel-qodercli-hook install --user --quiet`
source ~/.bashrc   # 或 source ~/.zshrc
```

### 4.2 远程一键脚本(备选,与 claude 一致)
- OSS bucket:复用 `arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/`
- 入口:`remote-install.sh`(本插件首次发布时附带,⚪ 可选,P2)

### 4.3 pilot tarball 同步路径(类型 B,本轮范围外)
`loongsuite-pilot/plugins/otel-qodercli-hook.tar.gz` — 留待后续独立 PR(由 `auto-dev-pilot-integration` skill 驱动)。

---

## 5. ARMS 端到端验证配置 ⭐(用于 P3 真实 ARMS 关)

- **ARMS endpoint URL**:`https://proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry`
- **ARMS 认证 headers**:
  - `x-arms-license-key=hwx28v3j7p@672218fb660eec3`
  - `x-arms-project=proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong`
  - `x-cms-workspace=default-cms-1819385687343877-cn-hongkong`
- **service.name**:`qodercli-agent`(可由用户通过 `OTEL_SERVICE_NAME` 覆盖)
- **验证通过标准**:
  1. 跑 1 个 turn(给 qodercli 提个简单问题让它至少跑 1 个 Bash 工具)
  2. 用 `arms-genai-verify` skill / aliyun-cli `SearchTraces` 查到对应 traceId
  3. 校验 1.4 节所有必采属性齐全(LLM span 有 token,AGENT span 有汇总 usage,ENTRY/AGENT/LLM 都有 messages,TOOL span 有 args+result)
  4. Resource 字段 `service.name` / `gen_ai.agent.system=qodercli` / `acs.arms.service.feature=genai_app` 全部存在
  5. `gen_ai.session.id` 在 ENTRY span 中;一个 session 内多 turn 共享同一 session_id 但 traceId 不同

---

## 6. 范围外(Out of Scope)

明确**不**做的事:
- ❌ pilot 集成(类型 B,后续独立 PR)
- ❌ 本地模型推理引擎细节(`gen_ai.latency.time_in_model_*` 字段) — qodercli 是 LLM client,不是推理服务
- ❌ Multimodal 多模态字段(`gen_ai.input.multimodal_metadata` 等) — 首版只覆盖文本
- ❌ Reranker / Retriever / Embedding span — qodercli 不直接使用这些组件
- ❌ Windows arm64 支持(qodercli 官方未支持)

---

## 7. 假设与依赖

- 依赖 `@loongsuite/opentelemetry-util-genai` 提供的 `LLMInvocation` / `InvokeAgentInvocation` 等类型
- 依赖 `@opentelemetry/sdk-trace-node` 1.x / `@opentelemetry/exporter-trace-otlp-http` 0.57.x
- Node.js >= 18.0.0
- 用户已在测试机安装 `qodercli` 并能跑通基础对话(`qodercli --version` 正常)
- transcript 已确认存在且含 `message.usage.{input_tokens, output_tokens, cache_read_input_tokens}`,无需进程内拦截
- transcript JSONL 字段命名与 Claude Code 同构(可大量复用 claude 插件的 replay 逻辑)

---

## 8. 风险

- **qodercli hook 协议演进**:目前 `tool_use_id` 用 `toolu_` 前缀(与 Claude Code 一致),未来可能变更 — 需要在 plan 阶段加入版本探测
- **transcript 格式漂移**:首次实现以用户给出的格式为准,后续 qodercli 升级若改格式,需通过单元测试快速发现
- **隐私/合规**:默认采集 input/output messages,需在 README 明确写明 opt-out 路径(`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT`)
- **重装幂等**(C5):`otel-qodercli-hook install` 多次执行必须结果一致,且不丢失 hooks 注册
- **用户原 settings.json 中已有 hooks**:必须 merge 而非覆盖(参考 claude 插件做法)

---

## Acceptance Gate(由 review 阶段勾选)

- [x] 1.1 / 1.2 / 1.3 / 1.4 / 4 全部填实(无占位)
- [x] 5(ARMS 凭证)用户已提供
- [x] 1.2 transcript 路径与格式已确认(JSONL 同 Claude Code,见 `qoder-cli/transcripts.md`)
- [x] 不与 Constitution 冲突(C1-C10 已逐条对齐:✅ C1 semconv / ✅ C2 ms 时间 / ✅ C3 默认采集 / ✅ C4 resource / ✅ C5 幂等 / ✅ C6 五道关 / ✅ C7 shell profile / ✅ C8 配置优先级 / ⚠️ C9 trust 不适用 / ✅ C10 命名)
- [ ] 用户已 sign off(spec 进入 Implementing 状态)

---

## ⭐ Review 必填项已收齐

| 项 | 值 |
|---|---|
| transcript 路径 | `~/.qoder/projects/{slugified-cwd}/{session_id}.jsonl`,JSONL,字段同 Claude Code |
| 子 agent transcript | `~/.qoder/projects/{slugified-cwd}/{session_id}/subagents/{subagent_id}.jsonl` |
| ARMS endpoint | `https://proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong.cn-hongkong.log.aliyuncs.com/apm/trace/opentelemetry` |
| ARMS headers | `x-arms-license-key=hwx28v3j7p@672218fb660eec3,x-arms-project=proj-xtrace-ee483ec157740929c4cb92d4ff85f-cn-hongkong,x-cms-workspace=default-cms-1819385687343877-cn-hongkong` |

确认后回复 `/spec-ok` 即可进入 Phase 2(plan + tasks)。
