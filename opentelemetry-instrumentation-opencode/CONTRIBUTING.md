# 参与贡献

感谢你对 `@loongsuite/opentelemetry-instrumentation-opencode` 的关注。本仓库为 [loongsuite-js-plugins](https://github.com/alibaba/loongsuite-js-plugins) 中的子包，贡献流程与 monorepo 其它包一致。

## 开发环境

1. 克隆仓库并进入本包目录：

   ```bash
   git clone https://github.com/alibaba/loongsuite-js-plugins.git
   cd loongsuite-js-plugins/opentelemetry-instrumentation-opencode
   ```

2. 安装依赖（任选其一）：

   ```bash
   npm install
   # 或
   bun install
   ```

3. 类型检查：

   ```bash
   npm run typecheck
   ```

4. 运行单元测试（Bun）：

   ```bash
   npm run test
   ```

提交前请确保 `typecheck` 与 `test` 均通过。

## 代码风格

- 使用 **TypeScript strict** 模式，避免无必要的 `any`。
- 与现有目录结构一致：配置与类型放在 `src/`，按领域拆到 `handlers/` 等子目录。
- 新增行为应附带或更新对应测试（`tests/`）。

## 本地联调（OpenTelemetry）

插件在设置了 OTLP 相关环境变量后才会启用遥测（详见 `src/config.ts`）。本地开发时可设置例如：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
# 或兼容旧变量：OPENCODE_ENABLE_TELEMETRY=1 等
```

将 OpenCode 指向该插件并按你的 OpenCode 插件加载方式接入后，可在 OTLP 后端观察指标、日志与链路（具体取决于你的环境变量与 exporter 配置）。

## 提交与 Pull Request

- 从 `main` 拉取功能分支，提交信息建议遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:`、`fix:`、`docs:`、`chore:`、`refactor:` 等。
- PR 描述中说明**动机**、**变更摘要**；若涉及行为变更，请说明对用户或迁移的影响。
- 若修改了对外行为或配置，请同步更新 `CHANGELOG.md`。

## 报告问题

提交 Issue 时建议包含：

- 本包版本（`package.json` 的 `version`）
- 运行环境（Node.js / Bun 版本、操作系统）
- 相关环境变量（可打码敏感信息）与复现步骤
- 报错或异常日志全文
