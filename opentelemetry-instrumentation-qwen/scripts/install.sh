#!/usr/bin/env bash
# install.sh — One-command installation for otel-qwen-hook
#
# Steps:
#   1. npm install (install Node dependencies)
#   2. npm install -g . (register otel-qwen-hook on PATH)
#   3. Copy intercept.js to ~/.cache/opentelemetry.instrumentation.qwen/
#   4. Run otel-qwen-hook install (write ~/.qwen/settings.json hooks)
#   5. Set up qwen alias in shell profiles
#   6. Print success message

# Copyright 2026 Alibaba Group Holding Limited
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INTERCEPT_DEST="$HOME/.cache/opentelemetry.instrumentation.qwen/intercept.js"

# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${OTEL_QWEN_LANG:-}" ]; then echo "$OTEL_QWEN_LANG"; return; fi
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
msg " otel-qwen-hook — OpenTelemetry for Qwen Code" \
    " otel-qwen-hook — OpenTelemetry for Qwen Code"
msg "==============================================" \
    "=============================================="
echo ""

# 1. Install Node.js dependencies
msg "==> 正在安装 Node.js 依赖..." \
    "==> Installing Node.js dependencies..."
cd "$PKG_DIR"
npm install --silent
msg "    ✅ 依赖安装完成" \
    "    ✅ Dependencies installed"
echo ""

# 2. Install package globally so otel-qwen-hook is on PATH
msg "==> 正在全局注册 otel-qwen-hook..." \
    "==> Registering otel-qwen-hook globally..."
if npm install -g . --silent 2>/dev/null; then
    msg "    ✅ 已通过 npm install -g 全局安装" \
        "    ✅ Installed globally via npm install -g"
elif npm link --silent 2>/dev/null; then
    msg "    ✅ 已通过 npm link 全局链接" \
        "    ✅ Linked globally via npm link"
else
    msg "    ⚠️  全局安装失败，尝试本地 wrapper 方案..." \
        "    ⚠️  Global install failed; trying local wrapper fallback..."
    LOCAL_BIN="$HOME/.local/bin"
    mkdir -p "$LOCAL_BIN"
    cat > "$LOCAL_BIN/otel-qwen-hook" << WRAPPER
#!/usr/bin/env bash
exec node "$PKG_DIR/bin/otel-qwen-hook" "\$@"
WRAPPER
    chmod +x "$LOCAL_BIN/otel-qwen-hook"
    msg "    ✅ Wrapper 已安装至 $LOCAL_BIN/otel-qwen-hook" \
        "    ✅ Wrapper installed at $LOCAL_BIN/otel-qwen-hook"
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

# 4. Register hooks in ~/.qwen/settings.json
msg "==> 正在注册 Qwen Code Hook..." \
    "==> Registering Qwen Code hooks..."
otel-qwen-hook install --user
echo ""

# 5. Set up qwen alias in shell profiles
msg "==> 正在设置 qwen 别名..." \
    "==> Setting up qwen alias..."
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
echo "   export OTEL_RESOURCE_ATTRIBUTES='service.name=qwen-agents'"
echo ""
msg "   # 控制台调试输出（无需后端）：" \
    "   # Console debug output (no backend needed):"
echo "   export QWEN_TELEMETRY_DEBUG=1"
echo ""

msg "2. 重新加载 Shell：" \
    "2. Reload your shell:"
echo "   source ~/.bashrc   # or ~/.zshrc"
echo ""

msg "3. 正常使用 qwen，Trace 将自动上报。" \
    "3. Use qwen as normal — traces will appear in your backend automatically."
echo ""

msg "提示：" \
    "Tips:"
msg "  - 验证配置：otel-qwen-hook check-env" \
    "  - Run 'otel-qwen-hook check-env' to verify your configuration"
msg "  - 查看 Hook 配置：otel-qwen-hook show-config" \
    "  - Run 'otel-qwen-hook show-config' to see the hooks JSON snippet"
msg "  - intercept.js 可捕获原始 LLM API 调用的详细数据" \
    "  - intercept.js captures raw LLM API calls for detailed token-level tracing"
msg "  - 卸载请运行：otel-qwen-hook uninstall" \
    "  - To uninstall: otel-qwen-hook uninstall"
msg "  - 或执行脚本：bash scripts/uninstall.sh" \
    "  - Or run the script: bash scripts/uninstall.sh"
echo ""
