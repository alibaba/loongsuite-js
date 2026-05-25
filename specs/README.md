# Specs

本目录存放 spec-kit 驱动的开发任务。每个任务一个独立子目录。

## 编号约定

```
specs/
├── 001-platform-base/                 # 平台基础设施(预留)
├── 1xx-instrumentation-<AGENT>/       # 类型 A:新 agent 的 OTel 插件
│   ├── spec.md                        # 用户 review 的规格(从 .specify/templates/otel-plugin/spec-template.md 派生)
│   ├── plan.md                        # 实施计划
│   ├── tasks.md                       # 任务清单(每条带 status: pending / in_progress / done)
│   ├── decisions.md                   # 自动决策日志(便于审计)
│   └── state.json                     # 单文件权威状态机(含 phase / current_task / retry_budget / verification / pr)
└── 2xx-xxx/                           # 其他类型(预留)
```

**关于 state.json**:它是单文件权威。verification 各 gate 结果(typecheck/build/unit/e2e/arms)+ PR 元数据(url/number/state/commit/head/base)都嵌入 `state.json`,无需独立的 `verification.json` / `pr.json`(早期模板曾要求这两个文件,首例实施 [`100-instrumentation-qodercli`](100-instrumentation-qodercli/) 证明分文件冗余且易不一致;已合并到 state.json)。完整 schema 由配套工具仓库的 skill 维护(本仓库不强依赖,任何 spec-kit 兼容工具均可消费这些文件)。

`<AGENT>` 用目标 agent 短名:`gemini` / `aider` / 等。

编号从 100 起步,每个新 agent 顺延 +1(101 / 102 / 103 ...)。已落地的 claude / codex 不需要回填 spec(它们早于本流程)。

## 工作流

模板按 spec-kit 标准组织,可由两类工作流驱动:

**工作流 A(推荐)— 配套 skill 自驱动**:配套工具仓库提供一个 Claude Code skill(命名 `auto-dev-otel-plugin`),用户输入开发背景后 skill 自动 elicit + plan + implement + verify + push。

**工作流 B — 手工跑模板**:不依赖任何 skill,任何开发者(含 cursor IDE / 手工写代码)都可以直接读 `.specify/templates/otel-plugin/` 下的模板按字段填空,产出 `specs/1xx-instrumentation-<agent>/spec.md`,然后按 `tasks-template.md` 列出的 30 步执行实现 + 验证。

两种工作流产出的 `specs/<id>/` 目录结构一致(spec.md / plan.md / tasks.md / decisions.md / state.json)。无论哪种,都需要在 review 阶段对齐 `.specify/memory/constitution.md` 的 10 条硬约束。

## 模板与宪法

- 模板:`.specify/templates/otel-plugin/{spec,plan,tasks,verification-checklist}-template.md`
- 通用模板:`.specify/templates/{spec,plan,tasks,checklist}-template.md`(spec-kit 标准)
- 宪法:`.specify/memory/constitution.md`(C1-C10 硬约束,review 阶段强制对齐)
