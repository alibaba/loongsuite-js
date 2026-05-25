# Plan — OTel Instrumentation Plugin: <AGENT>

> 类型 A 实施计划。从批准的 spec.md 派生。

**Feature ID**:1xx-instrumentation-<AGENT>
**对应 spec**:specs/1xx-instrumentation-<AGENT>/spec.md
**生成日期**:YYYY-MM-DD

---

## 1. 技术栈与目录结构

固定的目录结构(从 codex/claude 插件落地经验复制):

```
opentelemetry-instrumentation-<AGENT>/
├── package.json                              # 包名 / bin / scripts(参考 codex 插件)
├── tsconfig.json
├── tsup.config.ts
├── bin/
│   └── otel-<AGENT>-hook                     # CLI 入口(commander)
├── src/
│   ├── index.ts                              # 包入口,re-export
│   ├── cli.ts                                # 全部 hook 命令处理 + install/uninstall
│   ├── state.ts                              # SessionState / Turn 类型 + splitIntoTurns
│   ├── transcript.ts                         # transcript 解析(token / system / tools)
│   ├── replay.ts                             # 回放为 OTel span 树 + toMs() helper
│   ├── telemetry.ts                          # OTel TracerProvider + resource attrs
│   ├── config.ts                             # ~/.<AGENT>/otel-config.json 读取
│   ├── logger.ts                             # JSONL 日志写入(可选)
│   ├── log-records.ts                        # event_t schema 生成(可选)
│   └── trust.ts                              # hook trust hash(若需要)
├── scripts/
│   ├── install.sh                            # 本地安装入口(NPM 全局 + 回退本地 bin)
│   ├── uninstall.sh                          # 卸载脚本(含 fallback 清理)
│   ├── pack.sh                               # 打包 tarball
│   └── remote-install.sh                     # 远程安装(curl | bash)
├── tests/
│   ├── unit/                                 # 单元测试
│   └── e2e/                                  # InMemorySpanExporter E2E
└── README.md
```

参考实现:`opentelemetry-instrumentation-codex/`(直接 copy + 改 agent-specific 部分)。

---

## 2. 关键设计决策

### 2.1 数据流(对照 spec 1.2)
- 每个 hook event → stdin JSON → 追加到 SessionState 文件 → Stop hook 触发回放
- Stop hook 内:read transcript → split turns → buildReactSteps → replay 为 spans → 导出
- 同步 / 异步策略:hook 子进程独立,主进程不阻塞

### 2.2 Span 时间(Constitution C2)
- SessionState 内存 timestamp 单位:**秒**(`Date.now() / 1000`)
- 传给 OTel SDK 前用 `toMs(t) = t * 1000` helper 转换
- 验证:E2E 用 InMemorySpanExporter 检查 startTime[0] = epoch 秒部分 ≈ 当前 Unix sec

### 2.3 Content capture(Constitution C3)
- `cli.ts` 顶层 `??=` 注入两个 GenAI env 默认值
- replay.ts 在 invocation 上设置 `inputMessages` / `outputMessages` / `systemInstruction` / `toolDefinitions`

### 2.4 Hook trust(若适用,Constitution C9)
- `trust.ts` 复刻目标 agent 的 hash 算法
- install 时清理 stale state,写 BEGIN/END marker block

---

## 3. 测试策略

### 3.1 单元测试(`tests/unit/`)
- transcript.ts:覆盖 token / system / tool 解析的所有分支
- replay.ts:turn split / step build / message 构造
- trust.ts(若适用):hash 算法对照官方实现

### 3.2 E2E(`tests/e2e/`)
- 用 InMemorySpanExporter + mock SessionState + mock TranscriptData
- 断言:span 树结构 + 必采属性清单(spec 1.4)全部齐
- 时间断言:startTime 在 epoch 秒级合理范围

### 3.3 真实 ARMS 验证(P3 阶段执行)
- 用户提供的 endpoint + license
- 跑 1-2 turn 真实对话
- 用 `arms-genai-verify` skill SearchTraces 拉取后,逐属性对照

---

## 4. 与现有 util 库的复用

**必须复用,不重写**:
- `@loongsuite/opentelemetry-util-genai` 的 `ExtendedTelemetryHandler` + `createXxxInvocation` + 类型(`InputMessage` / `ToolDefinition` 等)
- `@opentelemetry/sdk-trace-node` 的 `NodeTracerProvider` / `BatchSpanProcessor`
- `@opentelemetry/exporter-trace-otlp-proto` 的 `OTLPTraceExporter`

**禁止自创**:
- 自己实现 span 属性生成(应用 util-genai 提供的 `applyXxxFinishAttributes`)
- 自己实现 messages / tool 序列化(走 util-genai 的 `getLlmMessagesAttributesForSpan` / `getToolDefinitionsForSpan`)

---

## 5. 文件清单(实施时映射到 tasks.md)

按 tasks-template.md 的 ~30 步序列展开。
