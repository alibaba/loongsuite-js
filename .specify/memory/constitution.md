# LoongSuite JS Plugins — 项目宪法

> 本文件是 OTel GenAI 插件实现的硬约束,由 spec-kit 流程的 review 阶段引用。
> 任何插件实现违反以下条款,视为缺陷。

**版本**:1.0.0
**适用范围**:`opentelemetry-instrumentation-<agent>` 系列(claude / codex / 未来新增)
**最后更新**:2026-05-14

---

## C1. 必须遵循 OTel GenAI semconv(含 LoongSuite 扩展)

参考规范:
- 公开标准:[OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- LoongSuite 扩展:[loongsuite-semantic-conventions-genai](https://github.com/alibaba/loongsuite-semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)(在 OTel 标准基础上加入 ENTRY / STEP 等 agent 场景需要的扩展 span 类型)

### C1.1 公共属性(每个 span 都应当含)

| 字段 | 等级 | 示例 |
|---|---|---|
| `gen_ai.span.kind` | 必须 | `ENTRY` / `AGENT` / `STEP` / `LLM` / `TOOL` |
| `gen_ai.operation.name` | 必须 | `enter` / `invoke_agent` / `react` / `chat` / `execute_tool` |
| `gen_ai.session.id` | 有条件必须 | 同一 session 内所有 turn / span 共享 |
| `gen_ai.user.id` | 有条件必须 | C 端用户标识 |
| `gen_ai.framework` | 有条件必须 | 如 `langchain` / `claude-code` / `codex` |

### C1.2 LLM span(`gen_ai.span.kind=LLM`)必采

| 字段 | 等级 |
|---|---|
| `gen_ai.provider.name`(如 `openai` / `anthropic`) | 必须 |
| `gen_ai.request.model` / `gen_ai.response.model` | 必须 / 推荐 |
| `gen_ai.response.finish_reasons` | 推荐 |
| `gen_ai.usage.input_tokens` / `output_tokens` / `total_tokens` | 推荐(三个都要) |
| `gen_ai.usage.cache_creation.input_tokens` / `cache_read.input_tokens` | 推荐(若 provider 支持) |
| `gen_ai.input.messages` / `gen_ai.output.messages` | 内容采集开启时(C3) |
| `gen_ai.system_instructions` / `gen_ai.tool.definitions` | 内容采集开启时(C3) |
| `gen_ai.conversation.id` | 有条件必须(可与 session.id 同) |

### C1.3 AGENT span(`gen_ai.span.kind=AGENT`)必采

| 字段 | 等级 |
|---|---|
| `gen_ai.agent.name` | 必须(`<agent_id>`) |
| `gen_ai.agent.description` / `gen_ai.agent.id` | 有条件必须 |
| 汇总的 `gen_ai.usage.{input,output,total,cache_read.input}_tokens` | 推荐 |
| `gen_ai.system_instructions` / `gen_ai.tool.definitions` | 内容采集开启时(C3) |

### C1.4 ENTRY span(`gen_ai.span.kind=ENTRY`,**LoongSuite 扩展**)必采

每个 user turn 一个独立 trace(独立 traceId);所有 turn 共享同一个 `gen_ai.session.id`。

| 字段 | 等级 |
|---|---|
| `gen_ai.session.id` | 必须 |
| `gen_ai.user.id` | 有条件必须 |
| `gen_ai.input.messages` / `gen_ai.output.messages` | 内容采集开启时(C3) |

### C1.5 STEP span(`gen_ai.span.kind=STEP`,**LoongSuite 扩展**,ReAct 一轮)

| 字段 | 等级 |
|---|---|
| `gen_ai.react.round` | 推荐(从 1 起) |
| `gen_ai.react.finish_reason` | 推荐 |

### C1.6 TOOL span(`gen_ai.span.kind=TOOL`)

| 字段 | 等级 |
|---|---|
| `gen_ai.tool.name` | 推荐 |
| `gen_ai.tool.call.id` | 推荐 |
| `gen_ai.tool.type`(`function` / `extension` / `datastore`) | 推荐 |
| `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` | 内容采集开启时(C3) |

**反例**:不符合规范的字段名(如自创 `tokens` / `model_name`)— 会被 ARMS / cms2.0 平台无法解析。

---

## C2. 时间字段以毫秒传给 OTel SDK

OTel JS SDK 的 `tracer.startSpan(name, { startTime: number })` 把 `number` **解释为毫秒**。SessionState 内部如以"秒"存储 timestamp,**必须**在调用 SDK 前 ×1000 转换。

**踩过的坑**:codex 插件早期把 `Date.now() / 1000`(秒)直接传给 SDK,导致持久化的纳秒时间戳少 3 位,看起来像微秒,cms2.0 / ARMS 查不到 trace。

**强制做法**:`replay.ts` 添加 `toMs(epochSec)` helper,所有 `handler.startXxx/stopXxx` 调用统一包装。

---

## C3. 默认开启内容采集,保留 opt-out

`@loongsuite/opentelemetry-util-genai` 的 `shouldCaptureContentInSpan()` 要求两个 env 同时存在才会序列化 messages / system / tool 内容到 span:
- `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`
- `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY`

普通用户不会主动设置。**强制做法**:在 hook 进程顶层用 `??=` 注入默认值,显式 `NO_CONTENT` 仍能 opt-out。

```ts
if (!process.env["OTEL_SEMCONV_STABILITY_OPT_IN"]) {
  process.env["OTEL_SEMCONV_STABILITY_OPT_IN"] = "gen_ai_latest_experimental";
}
if (!process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"]) {
  process.env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"] = "SPAN_ONLY";
}
```

需采集的属性:`gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` / `gen_ai.tool.definitions`,在 AGENT 和每个 LLM span 都贴。

---

## C4. resource 必须含 agent 标识

每个插件的 OTel TracerProvider 创建时,resource 必须含:
- `service.name`:用户配置或默认 `<agent>-agent`
- `gen_ai.agent.system`:`<agent_id>`(如 `codex` / `claude-code`)— 平台用此识别 agent 类型
- `acs.arms.service.feature`:`genai_app`(标识为 AI 应用)

---

## C5. install / uninstall 幂等且健壮

`install` 命令:
- 必须支持 `--quiet`(抑制非错误 stderr,避免污染 pilot 安装日志)
- 必须支持 `--user`(仅修改用户级配置)
- 重装幂等:执行 N 次结果一致,**不能因为已安装而 early return 跳过 hooks 注册**(否则 pilot 重装时 hooks 会丢)
- 必须清理老版本残留(如 stale `[hooks.state]` 段)避免 TOML duplicate key

`uninstall` 命令:
- 必须能在 hook bin 已损坏 / 不存在时仍清干净配置(deploy 脚本侧 fallback 路径)
- 不依赖 install 时写入的状态文件

---

## C6. 五道验证关(完成标准)

每个插件 PR 合并前必须通过:

1. **Typecheck**:`npm run typecheck` 零错
2. **Build**:`npm run build` 成功产出 dist/
3. **Unit tests**(若插件含):`npm test` 全 PASS
4. **E2E InMemorySpanExporter**:模拟一次完整 turn,断言 span 树结构 + 必采属性完整
5. **真实 ARMS 验证**:在用户提供的 ARMS endpoint 上跑一次真实 agent → 用 `arms-genai-verify` skill 拉 trace 对照属性,确认所有规范字段齐全

---

## C7. shell profile 写入保护

向 `~/.bashrc` / `~/.zshrc` 追加内容前,必须保证文件尾部有换行,否则 `cat >>` 会把新内容拼到用户最后一行上,卸载时 `sed '/# BEGIN/,/# END/d'` 还会连带删掉用户原最后一行。

**强制做法**:
```bash
[ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
cat >> "$file" <<EOF
# BEGIN otel-<agent>-hook
...
# END otel-<agent>-hook
EOF
```

---

## C8. 配置优先级与空字符串处理

配置优先级:**配置文件 > 环境变量 > 默认值**。

空字符串视同未设置:`OTEL_EXPORTER_OTLP_ENDPOINT=""` 不应让插件初始化崩溃,应回退到默认行为(无 OTLP 导出)。

**踩过的坑**:codex 插件曾因空 endpoint 在 telemetry.ts 中报 `NO TELEMETRY BACKEND` 异常,被 pilot 安装脚本误设空值时炸掉。

---

## C9. hook trust 机制(若 agent 启用)

如目标 agent 启用了 hook trust(如 codex >= 2026-04-22 stable hooks):

- trust hash 必须在**目标机器**动态计算(包含绝对路径),**不能**在打包时预计算
- install 时清理裸的 stale `[hooks.state."<our hooks.json>:<event>:0:0"]` 段(防 duplicate key)
- 用 `# BEGIN/END otel-<agent>-hook trust` marker 包裹自己写入的 trust block,便于幂等清理
- 不动其他 group_index(如 `:1:0`)的 trust state(那是用户/其他工具的)

---

## C10. 命名规范

| 资产 | 命名 |
|---|---|
| npm 包名 | `@loongsuite/opentelemetry-instrumentation-<agent>` |
| CLI bin 名 | `otel-<agent>-hook` |
| Debug env | `<AGENT>_TELEMETRY_DEBUG`(如 `CODEX_TELEMETRY_DEBUG`,大写,不混用 `CLAUDE_*`) |
| Log env | `OTEL_<AGENT>_LOG_{ENABLED,DIR,FILENAME_FORMAT}` |
| 共享配置文件 | `~/.<agent>/otel-config.json` |
| Hook entry 缓存 | `~/.cache/opentelemetry.instrumentation.<agent>/hook-entry.sh` |
| 插件解压目录(pilot 部署) | `~/.loongsuite-pilot/plugins/otel-<agent>-hook/` |
| JSONL 日志输出 | `~/.loongsuite-pilot/logs/<agent>/<agent>-YYYY-MM-DD.jsonl` |

---

## 修订流程

宪法本身有变更时,需以独立 PR 提交,且必须在 PR 描述中说明:
- 哪条新增/修订
- 反向影响:已有插件需要如何对齐
- 不兼容变更的迁移路径

新增条款编号顺延(C11 / C12 / ...),不复用历史编号。
