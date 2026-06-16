#!/usr/bin/env bash
# uninstall.sh — 卸载 otel-claude-hook 的所有组件
# Uninstall all components of otel-claude-hook
#
# Steps:
#   1. 从 ~/.claude/settings.json 删除 otel-claude-hook 相关 hook + enableTelemetry
#   2. 删除 ~/.cache/opentelemetry.instrumentation.claude/intercept.js
#   3. npm uninstall -g otel-claude-hook
#   4. 从 shell profile 删除 claude alias 及注释行
#   5. 打印卸载结果

set -euo pipefail

CACHE_DIR="$HOME/.cache/opentelemetry.instrumentation.claude"
SETTINGS_FILE="$HOME/.claude/settings.json"

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
msg " otel-claude-hook — 卸载" \
    " otel-claude-hook — Uninstall"
msg "==============================" \
    "=============================="
echo ""

# 1. 清理 ~/.claude/settings.json
if [ -f "$SETTINGS_FILE" ]; then
    msg "==> 清理 hooks 配置 ($SETTINGS_FILE)..." \
        "==> Cleaning up hooks config ($SETTINGS_FILE)..."
    if command -v node >/dev/null 2>&1; then
        node << 'NODE_EOF'
const fs = require("fs");
const path = process.env.HOME + "/.claude/settings.json";
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
      const isOurs = c => c.includes('otel-claude-hook') || c.includes('hook-entry.sh');
    const newHooks = matcher.hooks.filter(h => !h.command || !isOurs(h.command));
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

if ("enableTelemetry" in settings) {
  delete settings.enableTelemetry;
  changed = true;
}

const langZh = /zh/i.test(process.env.LANG || process.env.LC_ALL || "en");
if (changed) {
  fs.writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.error(langZh ? "    ✅ hooks 配置已清理" : "    ✅ Hooks config cleaned up");
} else {
  console.error(langZh
    ? "    ℹ️  未找到 otel-claude-hook 相关配置，跳过"
    : "    ℹ️  No otel-claude-hook config found, skipping");
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

# 2. 删除 intercept.js（保留 sessions/ 目录）
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

# 3. 清理全局 npm 包
msg "==> 清理全局 npm 包..." \
    "==> Cleaning up global npm package..."
if npm ls -g otel-claude-hook &>/dev/null; then
    npm uninstall -g otel-claude-hook 2>/dev/null || true
    msg "    ✅ npm uninstall -g otel-claude-hook" \
        "    ✅ npm uninstall -g otel-claude-hook"
else
    msg "    ℹ️  未找到全局 npm 包，跳过" \
        "    ℹ️  No global npm package found, skipping"
fi
echo ""

# 4. 从 shell profile 删除 claude alias 及注释行
msg "==> 正在清理 shell 别名..." \
    "==> Cleaning up shell alias..."

remove_alias_from_file() {
    local file="$1"
    if [ ! -f "$file" ]; then
        return
    fi
    if ! grep -q "# BEGIN otel-claude-hook" "$file" 2>/dev/null; then
        return
    fi
    local tmp
    tmp=$(mktemp)
    # 删除 BEGIN 到 END 之间的所有行（包含边界行）
    sed '/# BEGIN otel-claude-hook/,/# END otel-claude-hook/d' "$file" > "$tmp"
    mv "$tmp" "$file"
    msg "    ✅ 已从 $file 删除别名" \
        "    ✅ Removed alias from $file"
}

remove_alias_from_file "$HOME/.bashrc"
remove_alias_from_file "$HOME/.zshrc"
remove_alias_from_file "$HOME/.bash_profile"

# Remove env block written by remote-install.sh (ENDPOINT, SEMCONV_DIALECT, etc.)
remove_env_block_from_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    grep -q "# BEGIN otel-claude-hook-env" "$file" 2>/dev/null || return 0
    local tmp
    tmp=$(mktemp)
    sed '/# BEGIN otel-claude-hook-env/,/# END otel-claude-hook-env/d' "$file" > "$tmp"
    mv "$tmp" "$file"
    msg "    ✅ 已从 $file 删除 env 配置" \
        "    ✅ Removed env config from $file"
}

remove_env_block_from_file "$HOME/.bashrc"       || true
remove_env_block_from_file "$HOME/.zshrc"        || true
remove_env_block_from_file "$HOME/.bash_profile" || true
echo ""

# 5. 完成
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
