# `.specify/` 目录说明

本目录是 spec-kit 驱动的开发流程的资产存放点。详细工作流见 [`../specs/README.md`](../specs/README.md)。

---

## 目录结构

```
.specify/
├── memory/
│   └── constitution.md          # ⭐ 项目硬约束(C1-C10),review 阶段强制对齐
├── templates/
│   ├── otel-plugin/             # ⭐ 类型 A(OTel GenAI 插件)专用模板
│   ├── spec-template.md         # spec-kit 通用模板(由 spec-kit 工具链复制带来)
│   ├── plan-template.md
│   ├── tasks-template.md
│   ├── checklist-template.md
│   └── constitution-template.md
├── scripts/bash/                # spec-kit 通用 bash 脚本
├── extensions/git/              # spec-kit 的 git 扩展(可选)
├── workflows/                   # spec-kit 工作流注册
├── integrations/                # spec-kit 工具集成 manifest(见下"非依赖")
├── feature.json                 # 当前 active feature 指针
├── extensions.yml               # 扩展配置
├── init-options.json            # spec-kit init 时的选项
└── integration.json             # spec-kit 集成元信息
```

---

## ⭐ 实际驱动开发的两个文件

只需要看这两个就能理解模板:
1. **`memory/constitution.md`** — 10 条硬约束(必采字段、时间单位、内容采集、命名规范等)
2. **`templates/otel-plugin/{spec,plan,tasks,verification-checklist}-template.md`** — 类型 A 插件的 spec / 实施计划 / 任务清单 / 验收检查模板

其他文件大多是 spec-kit 工具链的元数据,**本仓库的工作流并不强依赖**。

---

## 非依赖说明(可忽略)

以下文件标记 `ai=cursor-agent` / 引用 `/speckit-*` 命令,**它们是 spec-kit 工具链的产物**,但本仓库的实际工作流(参见 `specs/README.md` 工作流 A/B)**不调用这些命令**:

- `init-options.json` / `integration.json` — 标记 `ai=cursor-agent`,只是 spec-kit init 时的元数据
- `integrations/cursor-agent.manifest.json` — 列出 `.cursor/skills/speckit-*/SKILL.md` 文件清单与哈希,但本仓库**没有 `.cursor/skills/`**,所以这些清单只是历史记录
- `integrations/speckit.manifest.json` — 同上
- `extensions/.registry` + `extensions/git/commands/speckit.git.*.md` — spec-kit 注册的 cursor-agent 命令
- `workflows/speckit/workflow.yml` — 引用 `speckit.specify` / `speckit.plan` 等命令

**为什么保留?**
1. 与 `loongsuite-pilot/.specify/` 结构一致,方便跨仓库工作
2. 未来若团队真的接 cursor IDE + spec-kit 工具链,这些元数据可直接复用
3. 删除它们对 reviewer 没好处,只是减少 noise — 但 noise 已被本 README 解释

**普通 reviewer 直接关注 `memory/constitution.md` + `templates/otel-plugin/` 即可**,其余文件可视为 spec-kit 历史包袱。

---

## 命令说明

`templates/{spec,plan,tasks,checklist}-template.md`(spec-kit 通用模板)中多次出现 `/speckit-*` 命令,这是 spec-kit 标准模板的写法。本仓库的工作流不调用这些命令,但模板内的字段说明依然适用 — 任何工作流都可以读这些模板填字段。

`templates/otel-plugin/` 下的模板是为本仓库定制的,**没有引用任何 speckit 命令**,可独立使用。
