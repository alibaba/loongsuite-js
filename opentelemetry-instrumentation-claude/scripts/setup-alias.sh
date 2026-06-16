#!/usr/bin/env bash
# setup-alias.sh — Add the claude alias to shell profiles.
# Called by install.sh. Can also be run standalone.
#
# LLM trace data is obtained from Claude Code's transcript files via hooks.
# NODE_OPTIONS / intercept.js is no longer needed.

set -euo pipefail

MINIMAL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --minimal) MINIMAL=1; shift ;;
        *) shift ;;
    esac
done

# If claude_identity is set at invocation time, it takes priority over OTEL_SERVICE_NAME.
# The alias uses a shell substitution so the check happens each time claude is run,
# not at install time — no code changes required.
ALIAS_LINE="alias claude='CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_METRIC_EXPORT_INTERVAL=20000 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta OTEL_SERVICE_NAME=\"\${claude_identity:-\${OTEL_SERVICE_NAME:-}}\" npx -y @anthropic-ai/claude-code@latest'"

# ---------------------------------------------------------------------------
# 语言检测 / Language detection
# ---------------------------------------------------------------------------
# install 阶段只执行一次，可以使用系统命令做完整检测，延迟可接受。
# 频繁执行的 hook 子进程不调用此脚本，不受影响。
detect_lang() {
    # 1. 显式 override 最优先
    if [ -n "${OTEL_CLAUDE_LANG:-}" ]; then
        echo "$OTEL_CLAUDE_LANG"; return
    fi
    # 2. 标准 POSIX locale 变量
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    # 3. macOS：系统语言偏好（UI 语言不一定反映在 $LANG 中）
    if [ "$(uname)" = "Darwin" ]; then
        local apple_lang
        apple_lang=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$apple_lang" ]; then echo "zh"; return; fi
        local apple_locale
        apple_locale=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$apple_locale" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    # 4. Windows Git Bash / MSYS2
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

ADDED=0

upgrade_old_alias() {
    local file="$1"
    if [ ! -f "$file" ] || [ ! -w "$file" ]; then return; fi
    if grep -q "# BEGIN otel-claude-hook" "$file" 2>/dev/null && \
       grep -q "intercept\.js" "$file" 2>/dev/null; then
        # Old alias contains intercept.js — remove the block so it gets re-created
        sed -i.otel-bak '/# BEGIN otel-claude-hook/,/# END otel-claude-hook/d' "$file"
        rm -f "${file}.otel-bak"
        msg "  ↳ 已清理旧版 alias（含 intercept.js）于 $file" \
            "  ↳ Cleaned up legacy alias (with intercept.js) in $file"
    fi
}

add_alias_to_file() {
    local file="$1"
    if [ ! -f "$file" ]; then
        return
    fi
    if [ ! -w "$file" ]; then
        msg "  ↳ $file 不可写，跳过" \
            "  ↳ $file is not writable, skipping"
        return
    fi
    # Upgrade: remove old alias block that contains intercept.js
    upgrade_old_alias "$file"
    if grep -q "# BEGIN otel-claude-hook" "$file" 2>/dev/null; then
        msg "  ↳ 已存在于 $file" \
            "  ↳ Already present in $file"
        return
    fi
    # Ensure file ends with a newline before appending
    [ -s "$file" ] && [ "$(tail -c1 "$file" | wc -l)" -eq 0 ] && echo "" >> "$file"
    if cat >> "$file" << ALIAS_BLOCK
# BEGIN otel-claude-hook
$ALIAS_LINE
# END otel-claude-hook
ALIAS_BLOCK
    then
        msg "  ✅ 已添加别名到 $file" \
            "  ✅ Added alias to $file"
        ADDED=1
    else
        msg "  ↳ 写入 $file 失败，跳过" \
            "  ↳ Failed to write $file, skipping"
    fi
}

if [ "$MINIMAL" -eq 1 ]; then
    upgrade_old_alias "$HOME/.bashrc"
    upgrade_old_alias "$HOME/.zshrc"
    upgrade_old_alias "$HOME/.bash_profile"
    msg "已清理旧版别名（minimal 模式，不写入新别名）" \
        "Legacy alias cleaned up (minimal mode, no new alias written)"
    exit 0
fi

msg "==> 正在设置 claude 别名..." \
    "==> Setting up claude alias in shell profiles..."
add_alias_to_file "$HOME/.bashrc"
add_alias_to_file "$HOME/.zshrc"
add_alias_to_file "$HOME/.bash_profile"

if [ "$ADDED" -eq 1 ]; then
    echo ""
    msg "别名已添加。重载 Shell 或运行：" \
        "Alias added. Reload your shell or run:"
    echo "  source ~/.bashrc   # or ~/.zshrc"
    echo ""
    msg "重载后，claude 命令将自动使用：" \
        "After reloading, the 'claude' command will automatically use:"
    echo "  $ALIAS_LINE"
else
    msg "别名已在所有 Shell 配置文件中存在。" \
        "Alias already configured in all found shell profiles."
fi
