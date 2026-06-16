#!/usr/bin/env bash
# install.sh — One-command installation for otel-claude-hook
#
# Steps:
#   1. npm install (install Node dependencies)
#   2. npm install -g . (register otel-claude-hook on PATH)
#   3. Copy intercept.js to ~/.cache/opentelemetry.instrumentation.claude/
#   4. Run otel-claude-hook install (write ~/.claude/settings.json hooks)
#   5. Set up claude alias in shell profiles
#   6. Print success message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"   # scripts/ → package root
INTERCEPT_DEST="$HOME/.cache/opentelemetry.instrumentation.claude/intercept.js"

# ---------------------------------------------------------------------------
# 语言检测 / Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${OTEL_CLAUDE_LANG:-}" ]; then echo "$OTEL_CLAUDE_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local apple_lang
        apple_lang=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$apple_lang" ]; then echo "zh"; return; fi
        local apple_locale
        apple_locale=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$apple_locale" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    if [ "$(uname -o 2>/dev/null || true)" = "Msys" ] || [ "$(uname -o 2>/dev/null || true)" = "Cygwin" ]; then
        local locale
        locale=$(reg query "HKCU\\Control Panel\\International" /v LocaleName 2>/dev/null | grep -o "zh[^[:space:]]*" | head -1 || true)
        if [ -n "$locale" ]; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)

# 双语输出 / Bilingual output helper
msg() {
    local zh="$1"
    local en="$2"
    if [ "$LANG_MODE" = "zh" ]; then
        echo "$zh"
    else
        echo "$en"
    fi
}

# ---------------------------------------------------------------------------

msg "==============================================" \
    "=============================================="
msg " otel-claude-hook — OpenTelemetry for Claude" \
    " otel-claude-hook — OpenTelemetry for Claude"
msg "==============================================" \
    "=============================================="
echo ""

# 1. Install Node.js dependencies
msg "==> 正在安装 Node.js 依赖..." \
    "==> Installing Node.js dependencies..."
cd "$PKG_DIR"
if ! npm install --silent 2>/tmp/npm-install-err.log; then
    echo ""
    if grep -qi "EACCES\|permission denied" /tmp/npm-install-err.log 2>/dev/null; then
        msg "    ❌ 依赖安装失败：Node.js 目录权限不足" \
            "    ❌ Dependency install failed: Node.js directory permission denied"
        echo ""
        msg "    💡 修复方案（三选一）：" \
            "    💡 Fix options (choose one):"
        msg "       1. 使用 nvm 管理 Node（推荐）：" \
            "       1. Use nvm to manage Node (recommended):"
        echo "          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
        echo "          nvm install --lts && nvm use --lts"
        msg "       2. 修复 npm 缓存目录权限：" \
            "       2. Fix npm cache directory permissions:"
        echo "          sudo chown -R \$(whoami) \$(npm config get prefix)/{lib/node_modules,bin,share}"
        msg "       3. 配置 npm 使用用户目录（无需 sudo）：" \
            "       3. Configure npm to use user directory (no sudo needed):"
        echo "          npm config set prefix '\$HOME/.local'"
        echo "          export PATH=\"\$HOME/.local/bin:\$PATH\""
    else
        msg "    ❌ 依赖安装失败，详细错误：" \
            "    ❌ Dependency install failed. Details:"
        cat /tmp/npm-install-err.log
    fi
    echo ""
    exit 1
fi
msg "    ✅ 依赖安装完成" \
    "    ✅ Dependencies installed"
echo ""

# 2. Install package globally so otel-claude-hook is on PATH
msg "==> 正在全局注册 otel-claude-hook..." \
    "==> Registering otel-claude-hook globally..."
if npm install -g . --silent 2>/dev/null; then
    msg "    ✅ 已通过 npm install -g 全局安装" \
        "    ✅ Installed globally via npm install -g"
elif npm link --silent 2>/dev/null; then
    msg "    ✅ 已通过 npm link 全局链接" \
        "    ✅ Linked globally via npm link"
else
    msg "    ⚠️  全局安装失败，尝试本地 wrapper 方案..." \
        "    ⚠️  Global install failed; trying local wrapper fallback..."
    msg "       （通常是 npm 全局目录权限不足，可用 nvm 或配置 npm prefix 解决）" \
        "       (Usually caused by npm global dir permission issues — use nvm or set npm prefix)"
    LOCAL_BIN="$HOME/.local/bin"
    mkdir -p "$LOCAL_BIN"
    cat > "$LOCAL_BIN/otel-claude-hook" << WRAPPER
#!/usr/bin/env bash
exec node "$PKG_DIR/bin/otel-claude-hook" "\$@"
WRAPPER
    chmod +x "$LOCAL_BIN/otel-claude-hook"
    msg "    ✅ Wrapper 已安装至 $LOCAL_BIN/otel-claude-hook" \
        "    ✅ Wrapper installed at $LOCAL_BIN/otel-claude-hook"
    msg "       请确认 $LOCAL_BIN 在 PATH 中" \
        "       Make sure $LOCAL_BIN is on your PATH."
fi
echo ""

# 3. Copy intercept.js to cache directory
msg "==> 正在安装 intercept.js..." \
    "==> Installing intercept.js..."
mkdir -p "$(dirname "$INTERCEPT_DEST")"
cp "$PKG_DIR/src/intercept.js" "$INTERCEPT_DEST"
msg "    ✅ intercept.js 已安装至 $INTERCEPT_DEST" \
    "    ✅ intercept.js installed to $INTERCEPT_DEST"
echo ""

# 4. Register hooks in ~/.claude/settings.json + enable built-in telemetry
msg "==> 正在注册 Claude Code Hook 并启用内置遥测..." \
    "==> Registering Claude Code hooks and enabling built-in telemetry..."
node "$PKG_DIR/bin/otel-claude-hook" install --user
echo ""

# 5. Set up claude alias in shell profiles
msg "==> 正在设置 claude 别名..." \
    "==> Setting up claude alias..."
bash "$SCRIPT_DIR/setup-alias.sh"
echo ""

# 6. Done
msg "==============================================" \
    "=============================================="
msg " ✅ 安装完成！" \
    " ✅ Installation complete!"
msg "==============================================" \
    "=============================================="
echo ""

msg "后续步骤：" \
    "Next steps:"
echo ""

msg "1. 配置遥测后端（二选一）：" \
    "1. Configure your telemetry backend (choose one):"
echo ""
msg "   # 任意 OTEL 兼容后端（Sunfire、Jaeger 等）：" \
    "   # Any OTEL-compatible backend (Sunfire, Jaeger, etc.):"
echo "   export OTEL_EXPORTER_OTLP_ENDPOINT='https://your-otlp-endpoint:4318'"
echo "   export OTEL_SERVICE_NAME='my-claude-agent'"
echo ""
msg "   export OTEL_METRICS_EXPORTER=otlp" \
    "   export OTEL_METRICS_EXPORTER=otlp"
msg "   export OTEL_METRIC_EXPORT_INTERVAL=20000  # 20秒上报一次" \
    "   export OTEL_METRIC_EXPORT_INTERVAL=20000  # Export metrics every 20s"
echo ""
msg "   # 控制台调试输出（无需后端）：" \
    "   # Console debug output (no backend needed):"
echo "   export CLAUDE_TELEMETRY_DEBUG=1"
echo ""

msg "2. 重新加载 Shell：" \
    "2. Reload your shell:"
echo "   source ~/.bashrc   # or ~/.zshrc"
echo ""

msg "3. 正常使用 claude，Trace 将自动上报。" \
    "3. Use claude as normal — traces will appear in your backend automatically."
echo ""

msg "提示：" \
    "Tips:"
msg "  - 注意：已默认开启 Claude Code 内置 OTel 指标 (CLAUDE_CODE_ENABLE_TELEMETRY=1)" \
    "  - Note: Claude Code built-in OTel metrics enabled by default (CLAUDE_CODE_ENABLE_TELEMETRY=1)"
msg "  - 验证配置：otel-claude-hook check-env" \
    "  - Run 'otel-claude-hook check-env' to verify your configuration"
msg "  - 查看 Hook 配置：otel-claude-hook show-config" \
    "  - Run 'otel-claude-hook show-config' to see the hooks JSON snippet"
msg "  - intercept.js 可捕获原始 LLM API 调用的详细数据" \
    "  - intercept.js captures raw LLM API calls for detailed token-level tracing"
msg "  - 卸载请运行：otel-claude-hook uninstall" \
    "  - To uninstall: otel-claude-hook uninstall"
msg "  - 或执行脚本：bash scripts/uninstall.sh" \
    "  - Or run the script: bash scripts/uninstall.sh"

echo ""
