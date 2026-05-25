# Spec — OTel Instrumentation Plugin: <AGENT>

> 类型 A spec 模板。`<AGENT>` 用目标 agent 短名(如 `gemini` / `aider`)。
> 字段标 ⭐ 必填,标 ⚪ 可选/有默认。

**Feature ID**:1xx-instrumentation-<AGENT>(从 specs/ 现有最大编号 +1)
**目标仓库**:`alibaba/loongsuite-js-plugins`
**插件包名**:`@loongsuite/opentelemetry-instrumentation-<AGENT>`
**创建日期**:YYYY-MM-DD
**状态**:Draft / Reviewed / Implementing / Done
**Constitution 版本**:1.0.0

---

## 1. 概述

### 1.1 目标 agent ⭐
- **名称**:<完整名,如 OpenAI Codex CLI / Anthropic Claude Code>
- **官方仓库**:<URL>
- **CLI 名称**:<目标 agent 启动命令>
- **支持版本**:>= <version>(如有 hook trust 等机制要求,必须列出最低版本)
- **运行时**:Node.js / Python / Go / Rust(只有 NodeJS-compatible hook 机制才属类型 A 范围)

### 1.2 数据采集机制 ⭐

| 维度 | 选择 | 说明 |
|---|---|---|
| Hook 机制 | 目标 agent 是否原生支持 hook? | 类似 codex hooks.json 或 claude settings.json hooks |
| Hook 配置文件 | `~/.<agent>/...` 路径 | 必填具体路径 |
| Hook 事件清单 | `<event-name-1>` / `<event-name-2>` / ... | 列出本插件订阅的全部事件 |
| Transcript | 目标 agent 是否持久化对话 transcript? | 文件路径 + 格式(JSONL / SQLite / 其他) |
| 进程内拦截 | 是否需要 intercept.js? | 仅当 transcript 不足时启用 |
| Hook trust | 是否需要 trust hash? | yes → 引用 Constitution C9 |

### 1.3 Span 树设计 ⭐

```
ENTRY (每个 user turn)
  └── AGENT (<AGENT>)
        ├── STEP #1 (ReAct 推理)
        │     ├── LLM (chat <model>)
        │     └── TOOL (<tool-name>)
        └── STEP #N
              └── LLM
```

注:必须严格符合 Constitution C1。

### 1.4 必采属性清单 ⭐

按 ARMS GenAI semconv,**至少**必须采集:
- LLM span:`gen_ai.usage.{input,output,cache_read.input}_tokens` / `gen_ai.request.model` / `gen_ai.response.model` / `gen_ai.response.finish_reasons` / `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` / `gen_ai.tool.definitions`
- AGENT span:`gen_ai.agent.name` / 汇总 `usage.*` / `gen_ai.system_instructions` / `gen_ai.tool.definitions`
- ENTRY span:`gen_ai.session.id` / `gen_ai.input.messages` / `gen_ai.output.messages`
- TOOL span:`gen_ai.tool.{name,call.id,call.arguments,call.result,type}`
- Resource:`service.name` / `gen_ai.agent.system=<AGENT>` / `acs.arms.service.feature=genai_app`

填表说明各字段从 transcript / hook stdin 哪里取(做 spec 的人必须填全)。

### 1.5 JSONL 日志输出 ⚪ 可选

如计划同时支持 pilot 集成,需输出 event_t schema(参见 ARMS LLM Logs 规范):
- 文件名:`<AGENT>-YYYY-MM-DD.jsonl`
- `event.name` ∈ `{llm.request, llm.response, tool.call, tool.result}`
- 必填字段:`time_unix_nano` / `event.id` / `event.name` / `session.id` / `user.id` / `agent.type=<AGENT>`

---

## 2. 用户场景

### 2.1 用户故事 — 基础 trace 采集(P1)
作为 `<AGENT>` 用户,我希望我每轮对话都能在 OTLP 后端看到完整 trace,包括我说了什么、agent 调了什么工具、用了多少 token。

**验收标准**:
1. 安装插件后无需改动 agent 启动方式即可生效
2. 每轮 trace 完整(span 树符合 1.3 节)
3. token 数据准确(误差 ≤ 1%,以 transcript 数据为准)
4. 在 ARMS / cms2.0 平台上可查到 trace

### 2.2 用户故事 — pilot 集成(P2,可选)
作为运维方,我希望该插件可以集成到 loongsuite-pilot,把数据汇集到 SLS / JSONL。

**验收标准**:见类型 B 模板。

---

## 3. 与已有插件的差异

| 维度 | 本插件 | claude(参考) | codex(参考) |
|---|---|---|---|
| 配置文件位置 | | `~/.claude/settings.json` | `~/.codex/hooks.json` + `config.toml` |
| LLM 数据来源 | | transcript + intercept.js | transcript |
| Hook trust | | 无 | 需要 |
| Hook 事件数 | | 8 | 5 |
| 进程内拦截 | | 有 | 无 |

(填表对齐:本插件落在哪一类、为什么)

---

## 4. 远程安装与分发 ⭐

- OSS bucket / 路径:<URL>
- `remote-install.sh` 入口:<URL>
- pilot tarball 同步路径(若类型 B):`loongsuite-pilot/plugins/otel-<AGENT>-hook.tar.gz`

---

## 5. ARMS 端到端验证配置 ⭐(用于 P3 真实 ARMS 关)

填以下信息(由用户提供,不能猜):
- ARMS endpoint URL:<URL>
- ARMS license key / project / workspace:<由用户在 review 时填入>
- 验证通过标准:run 1 turn → SearchTraces 找到对应 traceId → 校验 1.4 节所有必采属性齐全

---

## 6. 范围外(Out of Scope)

明确**不**做的事(避免 spec 蔓延):
- (如目标 agent 的"伪工具"无结构化定义,声明不采)
- (如不支持的 OS 平台)
- ...

---

## 7. 假设与依赖

- 依赖 `@loongsuite/opentelemetry-util-genai` 提供的 `LLMInvocation` / `InvokeAgentInvocation` 等类型
- 依赖 `@opentelemetry/sdk-trace-node` 1.x
- Node.js >= 18.0.0
- 用户已在目标机器安装 `<AGENT>` 并能跑通基础对话

---

## 8. 风险

- (列出已知技术风险,如 hook 机制可能变更、transcript 格式不稳定等)
- (列出已知合规风险,如默认采集 messages 可能有隐私顾虑 → 需在 README 明确 opt-out 路径)

---

## Acceptance Gate(由 review 阶段勾选)

- [ ] 1.1 / 1.2 / 1.3 / 1.4 / 4 / 5 全部填实(无占位)
- [ ] 不与 Constitution 冲突
- [ ] OSS / ARMS 凭证已就绪(在 review 阶段就告知用户输入)
- [ ] 用户已 sign off(对应 spec 进入 Implementing 状态)
