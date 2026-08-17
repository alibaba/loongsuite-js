#!/usr/bin/env bash
# uninstall.sh — Uninstall all components of otel-qwen-hook
#
# Steps:
#   1. Remove otel-qwen-hook hooks from ~/.qwen/settings.json
#   2. Remove ~/.cache/opentelemetry.instrumentation.qwen/intercept.js
#   3. Remove qwen alias from shell profiles
#   4. Remove ~/.local/bin/otel-qwen-hook wrapper (if exists)
#   5. Print results

# Copyright 2026 Alibaba Group Holding Limited
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

CACHE_DIR="$HOME/.cache/opentelemetry.instrumentation.qwen"
SETTINGS_FILE="$HOME/.qwen/settings.json"

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

msg "==============================" \
    "=============================="
msg " otel-qwen-hook — 卸载" \
    " otel-qwen-hook — Uninstall"
msg "==============================" \
    "=============================="
echo ""

# 1. Clean up ~/.qwen/settings.json
if [ -f "$SETTINGS_FILE" ]; then
    msg "==> 清理 hooks 配置 ($SETTINGS_FILE)..." \
        "==> Cleaning up hooks config ($SETTINGS_FILE)..."
    if command -v node >/dev/null 2>&1; then
        node << 'NODE_EOF'
const fs = require("fs");
const path = process.env.HOME + "/.qwen/settings.json";
if (!fs.existsSync(path)) process.exit(0);

let settings;
try { settings = JSON.parse(fs.readFileSync(path, "utf-8")); }
catch { process.exit(0); }

let changed = false;

if (settings.hooks && typeof settings.hooks === "object") {
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    const filtered = matchers.map(matcher => {
      if (!Array.isArray(matcher.hooks)) return matcher;
      const newHooks = matcher.hooks.filter(h => !h.command || !h.command.includes("otel-qwen-hook"));
      if (newHooks.length === matcher.hooks.length) return matcher;
      changed = true;
      return newHooks.length > 0 ? { ...matcher, hooks: newHooks } : null;
    }).filter(Boolean).filter(m => m && Array.isArray(m.hooks) && m.hooks.length > 0);

    if (filtered.length === 0) {
      delete settings.hooks[event];
      changed = true;
    } else if (filtered.length !== matchers.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
    changed = true;
  }
}

const langZh = /zh/i.test(process.env.LANG || process.env.LC_ALL || "en");
if (changed) {
  fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.error(langZh ? "    ✅ hooks 配置已清理" : "    ✅ Hooks config cleaned up");
} else {
  console.error(langZh
    ? "    ℹ️  未找到 otel-qwen-hook 相关配置，跳过"
    : "    ℹ️  No otel-qwen-hook config found, skipping");
}
NODE_EOF
    else
        msg "    ⚠️  node 不可用，跳过 settings.json 清理" \
            "    ⚠️  node not available, skipping settings.json cleanup"
    fi
else
    msg "    ℹ️  $SETTINGS_FILE 不存在，跳过" \
        "    ℹ️  $SETTINGS_FILE not found, skipping"
fi
echo ""

# 2. Remove intercept.js (keep sessions/ directory)
INTERCEPT_FILE="$CACHE_DIR/intercept.js"
msg "==> 正在删除 intercept.js..." \
    "==> Removing intercept.js..."
if [ -f "$INTERCEPT_FILE" ]; then
    rm -f "$INTERCEPT_FILE"
    msg "    ✅ 已删除 $INTERCEPT_FILE" \
        "    ✅ Deleted $INTERCEPT_FILE"
else
    msg "    ℹ️  $INTERCEPT_FILE 不存在，跳过" \
        "    ℹ️  $INTERCEPT_FILE not found, skipping"
fi
echo ""

# 3. Remove shell alias
msg "==> 正在清理 shell 别名..." \
    "==> Cleaning up shell alias..."

remove_alias_from_file() {
    local file="$1"
    if [ ! -f "$file" ]; then return; fi
    if ! grep -q "# BEGIN otel-qwen-hook" "$file" 2>/dev/null; then return; fi
    local tmp
    tmp=$(mktemp)
    sed '/# BEGIN otel-qwen-hook/,/# END otel-qwen-hook/d' "$file" > "$tmp"
    mv "$tmp" "$file"
    msg "    ✅ 已从 $file 删除别名" \
        "    ✅ Removed alias from $file"
}

remove_alias_from_file "$HOME/.bashrc"
remove_alias_from_file "$HOME/.zshrc"
remove_alias_from_file "$HOME/.bash_profile"

remove_env_block_from_file() {
    local file="$1"
    [ -f "$file" ] || return
    grep -q "# BEGIN otel-qwen-hook-env" "$file" 2>/dev/null || return
    local tmp
    tmp=$(mktemp)
    sed '/# BEGIN otel-qwen-hook-env/,/# END otel-qwen-hook-env/d' "$file" > "$tmp"
    mv "$tmp" "$file"
    msg "    ✅ 已从 $file 删除 env 配置" \
        "    ✅ Removed env config from $file"
}

remove_env_block_from_file "$HOME/.bashrc"
remove_env_block_from_file "$HOME/.zshrc"
remove_env_block_from_file "$HOME/.bash_profile"
echo ""

# 4. Remove ~/.local/bin wrapper if exists
LOCAL_WRAPPER="$HOME/.local/bin/otel-qwen-hook"
if [ -f "$LOCAL_WRAPPER" ]; then
    rm -f "$LOCAL_WRAPPER"
    msg "    ✅ 已删除 $LOCAL_WRAPPER" \
        "    ✅ Deleted $LOCAL_WRAPPER"
fi

# 5. Done
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
msg "  - 重新加载 Shell 使别名失效: source ~/.bashrc" \
    "  - Reload shell to deactivate alias: source ~/.bashrc"
echo ""
