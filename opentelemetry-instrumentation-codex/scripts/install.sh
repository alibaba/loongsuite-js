#!/usr/bin/env bash
# install.sh — One-command installation for otel-codex-hook
#
# Steps:
#   0. Check if codex CLI is installed (warn if not, but continue)
#   1. npm install (install Node dependencies)
#   2. npm install -g . (register otel-codex-hook on PATH)
#   3. Run otel-codex-hook install (write ~/.codex/config.toml hooks)
#   4. Print success message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${OTEL_CODEX_LANG:-}" ]; then echo "$OTEL_CODEX_LANG"; return; fi
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
msg " otel-codex-hook — OpenTelemetry for Codex" \
    " otel-codex-hook — OpenTelemetry for Codex"
msg "==============================================" \
    "=============================================="
echo ""

# 0. Check if Codex is installed (CLI or Desktop — both create ~/.codex)
if [ ! -d "$HOME/.codex" ]; then
    msg "⚠️  未检测到 Codex（~/.codex 目录不存在，可稍后安装）" \
        "⚠️  Codex not detected (~/.codex not found, can be installed later)"
    echo ""
fi

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

# 2. Install package globally so otel-codex-hook is on PATH
msg "==> 正在全局注册 otel-codex-hook..." \
    "==> Registering otel-codex-hook globally..."
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
    cat > "$LOCAL_BIN/otel-codex-hook" << WRAPPER
#!/usr/bin/env bash
exec node "$PKG_DIR/bin/otel-codex-hook" "\$@"
WRAPPER
    chmod +x "$LOCAL_BIN/otel-codex-hook"
    msg "    ✅ Wrapper 已安装至 $LOCAL_BIN/otel-codex-hook" \
        "    ✅ Wrapper installed at $LOCAL_BIN/otel-codex-hook"
    msg "       请确认 $LOCAL_BIN 在 PATH 中" \
        "       Make sure $LOCAL_BIN is on your PATH."
fi
echo ""

# 3. Register hooks in ~/.codex/hooks.json
msg "==> 正在注册 Codex Hook..." \
    "==> Registering Codex hooks..."
node "$PKG_DIR/bin/otel-codex-hook" install
echo ""

# 4. Done
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
echo "   编辑 ~/.codex/otel-config.json:"
echo '   { "otlp_endpoint": "https://your-otlp-endpoint:4318", "service_name": "my-codex-agent" }'
echo ""
msg "   # 控制台调试输出（无需后端）：" \
    "   # Console debug output (no backend needed):"
echo '   { "debug": true }'
echo ""

msg "2. 正常使用 codex，Trace 将自动上报。" \
    "2. Use codex as normal — traces will appear in your backend automatically."
msg "   如果正在使用 Codex 桌面版，请重启 App 以使 hooks 生效。" \
    "   If using Codex Desktop, restart the app for hooks to take effect."
echo ""

msg "提示：" \
    "Tips:"
msg "  - 验证配置：otel-codex-hook check-env" \
    "  - Run 'otel-codex-hook check-env' to verify your configuration"
msg "  - 查看 Hook 配置：otel-codex-hook show-config" \
    "  - Run 'otel-codex-hook show-config' to see the hooks snippet"
msg "  - 卸载请运行：otel-codex-hook uninstall" \
    "  - To uninstall: otel-codex-hook uninstall"
msg "  - 或执行脚本：bash scripts/uninstall.sh" \
    "  - Or run the script: bash scripts/uninstall.sh"

echo ""
