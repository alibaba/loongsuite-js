#!/usr/bin/env bash
# uninstall.sh — Uninstall all components of otel-codex-hook
#
# Steps:
#   1. Remove hooks + codex_hooks from ~/.codex/config.toml
#   2. npm uninstall -g otel-codex-hook
#   3. Remove ~/.local/bin/otel-codex-hook wrapper (if exists)
#   4. Print uninstall result

set -euo pipefail

CACHE_DIR="$HOME/.cache/opentelemetry.instrumentation.codex"
CONFIG_FILE="$HOME/.codex/config.toml"

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

msg "==============================" \
    "=============================="
msg " otel-codex-hook — 卸载" \
    " otel-codex-hook — Uninstall"
msg "==============================" \
    "=============================="
echo ""

# 0. Clean up ~/.codex/hooks.json
HOOKS_JSON="$HOME/.codex/hooks.json"
msg "==> 清理 hooks.json ($HOOKS_JSON)..." \
    "==> Cleaning up hooks.json ($HOOKS_JSON)..."
if [ -f "$HOOKS_JSON" ] && grep -qE "otel-codex-hook|hook-entry\.sh" "$HOOKS_JSON" 2>/dev/null; then
    if command -v node >/dev/null 2>&1; then
        node -e "
const fs = require('fs');
const f = process.argv[1];
const isOurs = c => c.includes('otel-codex-hook') || c.includes('hook-entry.sh');
try {
  const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
  if (d && d.hooks) {
    for (const ev of Object.keys(d.hooks)) {
      d.hooks[ev] = d.hooks[ev].filter(g => {
        if (!g.hooks) return true;
        g.hooks = g.hooks.filter(h => !(h.command && isOurs(h.command)));
        return g.hooks.length > 0;
      });
      if (d.hooks[ev].length === 0) delete d.hooks[ev];
    }
    if (Object.keys(d.hooks).length === 0) {
      fs.unlinkSync(f);
    } else {
      fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
    }
  }
} catch {}
" "$HOOKS_JSON"
        msg "    ✅ hooks.json 已清理" "    ✅ hooks.json cleaned"
    else
        msg "    ⚠️  Node.js 不可用，请手动编辑 $HOOKS_JSON" \
            "    ⚠️  Node.js not available, please manually edit $HOOKS_JSON"
    fi
else
    msg "    ℹ️  hooks.json 无需清理" "    ℹ️  hooks.json: nothing to clean"
fi
echo ""

# 1. Clean up ~/.codex/config.toml
msg "==> 清理 hooks 配置 ($CONFIG_FILE)..." \
    "==> Cleaning up hooks config ($CONFIG_FILE)..."

if [ -f "$CONFIG_FILE" ]; then
    if command -v otel-codex-hook >/dev/null 2>&1; then
        otel-codex-hook uninstall 2>/dev/null || true
        msg "    ✅ hooks 配置已清理 (via otel-codex-hook uninstall)" \
            "    ✅ Hooks config cleaned up (via otel-codex-hook uninstall)"
    elif grep -q "otel-codex-hook" "$CONFIG_FILE" 2>/dev/null; then
        local marker="# OpenTelemetry instrumentation hooks"
        local end_str='command = "otel-codex-hook stop"'
        if grep -q "$marker" "$CONFIG_FILE" 2>/dev/null && grep -qF "$end_str" "$CONFIG_FILE" 2>/dev/null; then
            local tmp
            tmp=$(mktemp)
            awk -v m="$marker" -v e="$end_str" '
                BEGIN { skip=0 }
                skip==0 && index($0, m) { skip=1; next }
                skip==1 { if (index($0, e)) { skip=2 }; next }
                skip==2 && /^[[:space:]]*$/ { next }
                { skip=0; print }
            ' "$CONFIG_FILE" > "$tmp"
            mv "$tmp" "$CONFIG_FILE"
        else
            local tmp
            tmp=$(mktemp)
            grep -v "otel-codex-hook" "$CONFIG_FILE" > "$tmp" || true
            mv "$tmp" "$CONFIG_FILE"
        fi
        msg "    ✅ hooks 配置已清理 (via sed)" \
            "    ✅ Hooks config cleaned up (via sed)"
    else
        msg "    ℹ️  未找到 otel-codex-hook 相关配置，跳过" \
            "    ℹ️  No otel-codex-hook config found, skipping"
    fi
else
    msg "    ℹ️  $CONFIG_FILE 不存在，跳过" \
        "    ℹ️  $CONFIG_FILE not found, skipping"
fi

# Clean up codex_hooks = true from [features] section
if [ -f "$CONFIG_FILE" ] && grep -q "codex_hooks" "$CONFIG_FILE" 2>/dev/null; then
    local tmp
    tmp=$(mktemp)
    grep -v '^\s*codex_hooks\s*=' "$CONFIG_FILE" > "$tmp" || true
    # Remove empty [features] section
    awk '
        /^\[features\]\s*$/ {
            hold = $0; next
        }
        hold != "" {
            if (/^[[:space:]]*$/) { next }
            if (/^\[/) { hold = ""; print; next }
            print hold; hold = ""; print; next
        }
        { print }
    ' "$tmp" > "${tmp}.2"
    mv "${tmp}.2" "$CONFIG_FILE"
    rm -f "$tmp"
    msg "    ✅ codex_hooks 配置已清理" "    ✅ codex_hooks config cleaned"
fi
echo ""

# 2. Uninstall npm global package
msg "==> 清理全局 npm 包..." \
    "==> Cleaning up global npm package..."
if npm ls -g otel-codex-hook &>/dev/null; then
    npm uninstall -g otel-codex-hook 2>/dev/null || true
    msg "    ✅ npm uninstall -g otel-codex-hook" \
        "    ✅ npm uninstall -g otel-codex-hook"
else
    msg "    ℹ️  未找到全局 npm 包，跳过" \
        "    ℹ️  No global npm package found, skipping"
fi
echo ""

# 3. Remove ~/.local/bin wrapper (if exists)
LOCAL_WRAPPER="$HOME/.local/bin/otel-codex-hook"
msg "==> 检查本地 wrapper..." \
    "==> Checking local wrapper..."
if [ -f "$LOCAL_WRAPPER" ]; then
    rm -f "$LOCAL_WRAPPER"
    msg "    ✅ 已删除 $LOCAL_WRAPPER" \
        "    ✅ Deleted $LOCAL_WRAPPER"
else
    msg "    ℹ️  $LOCAL_WRAPPER 不存在，跳过" \
        "    ℹ️  $LOCAL_WRAPPER not found, skipping"
fi
echo ""

# 4. Done
msg "==============================" \
    "=============================="
msg " ✅ 卸载完成！" \
    " ✅ Uninstall complete!"
msg "==============================" \
    "=============================="
echo ""
msg "注意：" \
    "Notes:"
msg "  - Session 数据仍保留在: $CACHE_DIR/sessions/" \
    "  - Session data retained at: $CACHE_DIR/sessions/"
msg "  - 完全删除缓存请运行: rm -rf $CACHE_DIR" \
    "  - To fully remove cache: rm -rf $CACHE_DIR"
echo ""
