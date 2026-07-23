# GenAI Skill 属性与自动识别

`@loongsuite/otel-util-genai` 使用现有 `execute_tool` TOOL span 表达 Skill
相关操作，不新增 Skill span 或 operation。

当某次工具执行能够确定与一个 Skill 相关时，TOOL span 可携带：

| 属性 | 类型 | 说明 |
|---|---|---|
| `gen_ai.skill.name` | string | Skill 名称 |
| `gen_ai.skill.id` | string | Skill 标识；没有真实 ID 时回退为 name |
| `gen_ai.skill.version` | string | Skill 版本（如果可用） |
| `gen_ai.skill.description` | string | Skill 描述（如果可用） |

这里的“Skill 相关操作”包括一等公民 Skill 工具调用、读取 Skill 定义、
读取 Skill 目录资源，以及执行 Skill 目录中的脚本。一个 Skill 在一次任务中
可能对应多个带 Skill 属性的 TOOL span；这些 span 不等同于 Skill 调用次数。

## 直接使用 Handler

插件已经知道 Skill 元数据时，应直接设置 invocation 字段：

```ts
import {
  ExtendedTelemetryHandler,
  createExecuteToolInvocation,
} from "@loongsuite/otel-util-genai";

const handler = new ExtendedTelemetryHandler();
const invocation = createExecuteToolInvocation("Skill", {
  toolCallId: "call-1",
  skillName: "code-review",
  skillId: "skill-29bbe8a7",
  skillVersion: "1.2.3",
  skillDescription: "Review repository changes",
});

handler.startExecuteTool(invocation);
// 执行工具
handler.stopExecuteTool(invocation);
```

## Event Log 自动识别

`convertEventLogToTrace`、`convertEventLogToReadableSpans` 和
`createTurnStreamSession` 默认启用 Skill 自动识别。

识别优先级按字段独立合并：

1. `tool.result` 上显式的 `gen_ai.skill.*`
2. `tool.call` 上显式的 `gen_ai.skill.*`
3. 自定义 `detect`
4. 一等公民 Skill 工具
5. tool arguments 中的 Skill 路径
6. 有 name、无 id 时，`id = name`

高优先级只覆盖自己提供的字段。例如显式 name 可以与自定义 detector 提供的
id、内置检测提供的 version 组合。

### 显式字段

显式字段最可靠，并且在 `skillDetection: false` 时仍会保留：

```json
{
  "event.name": "tool.call",
  "gen_ai.tool.name": "Bash",
  "gen_ai.skill.name": "deploy-service",
  "gen_ai.skill.id": "skill-deploy-01"
}
```

### 一等公民 Skill 工具

默认工具名匹配不区分大小写：

```text
Skill
load_skill
read_skill
skill_view
skill_manage
```

Claude Code 示例：

```json
{
  "event.name": "tool.call",
  "gen_ai.tool.name": "Skill",
  "gen_ai.tool.call.arguments": {
    "skill": "arms-genai-verify",
    "args": "检查 trace"
  }
}
```

对应 TOOL span：

```text
execute_tool Skill
  gen_ai.skill.name = arms-genai-verify
  gen_ai.skill.id   = arms-genai-verify
```

结构化成功结果可以补充真实 ID、版本与描述；`success: false` 的结果元数据不参与
识别，但调用参数中已经识别出的 Skill 仍会保留。

### 路径启发式

默认从 `gen_ai.tool.call.arguments` 的字符串字段递归查找以下路径：

```text
.../skills/<name>/...
.../skills-<variant>/<name>/...
.../skills/.system/<name>/...
```

支持 `/` 和 `\` 路径分隔符。常见示例：

| TOOL | 参数中的路径 | Skill |
|---|---|---|
| `Read` | `~/.codex/skills/hatch-pet/SKILL.md` | `hatch-pet` |
| `exec` | `node ~/.codex/skills/hatch-pet/scripts/build.js` | `hatch-pet` |
| `Shell` | `python ~/.cursor/skills/bmi-calculator/scripts/x.py` | `bmi-calculator` |
| `Read` | `~/.cursor/skills-cursor/create-hook/SKILL.md` | `create-hook` |
| `exec` | `~/.codex/skills/.system/imagegen/SKILL.md` | `imagegen` |

检测要求 `skills` 是独立路径段，且后面存在具名子目录。因此：

```text
/tmp/hatch-pet-users-codex-skills-3/out  // 不匹配
ls ~/.codex/skills/                     // 不匹配，无法确定 Skill
```

路径检测只扫描 tool-call arguments，不扫描普通 result、stdout 或文件内容。
这避免工具输出只是提到某个 Skill 路径时产生误报。

如果同一工具参数中出现多个 Skill 路径，由于语义属性是标量，只采用第一个。

## 配置

### 关闭自动识别

```ts
convertEventLogToTrace(records, {
  handler,
  skillDetection: false,
});
```

关闭后不会根据工具名或路径推断，但显式 `gen_ai.skill.*` 仍会写入 TOOL span。
不要把 `gen_ai.skill.*` 加入 `passthroughKeys`；Skill 字段已有专用映射，
而 passthrough 的 turn-level 广播语义不适合 TOOL 专属属性。

### 自定义工具名

`toolNames` 会替换默认名单；空数组表示关闭工具名检测：

```ts
convertEventLogToTrace(records, {
  handler,
  skillDetection: {
    toolNames: ["InvokeSkill"],
    pathHeuristic: true,
  },
});
```

### 关闭路径启发式

```ts
convertEventLogToTrace(records, {
  handler,
  skillDetection: {
    pathHeuristic: false,
  },
});
```

### 自定义 detector

```ts
convertEventLogToTrace(records, {
  handler,
  skillDetection: {
    detect(call, result) {
      const internalId = call?.["company.skill.id"];
      if (typeof internalId !== "string") return undefined;
      return {
        name: `internal-${internalId}`,
        id: internalId,
      };
    },
  },
});
```

自定义 detector 是同步函数。异常被视为配置或编程错误并直接抛出。

## Streaming 与 Subagent

流式转换使用相同配置：

```ts
const session = createTurnStreamSession({
  handler,
  skillDetection: {
    pathHeuristic: true,
  },
});
session.push(records);
session.end();
```

配置会继续传播到 TOOL 下嵌套的 Subagent，因此父 Agent、子 Agent 的 TOOL span
采用完全相同的识别规则。

## 边界

- Skill 属性只写到具备直接证据的 TOOL span。
- Skill 被加载后，不会自动给后续所有 TOOL span 继承 Skill 属性。
- 例如读取项目源码、修改项目文件等操作，如果自身没有显式字段、Skill 路径或
  自定义 detector 命中，就不会被标记。
- `event.name="skill.use"` 目前不会单独生成 span，也不会自动关联 TOOL span。
- `skill.id = skill.name` 是缺少真实 ID 时的稳定回退，不保证跨来源全局唯一。
