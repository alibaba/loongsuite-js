#!/usr/bin/env bash
# uninstall.sh — 卸载 opentelemetry-instrumentation-opencode 的所有组件
# Uninstall all components of opentelemetry-instrumentation-opencode
#
# Steps:
#   1. 从 shell profile 删除 env 配置块
#   2. 卸载全局 npm 包
#   3. 打印卸载结果

set -euo pipefail

PKG_NAME="@loongsuite/opentelemetry-instrumentation-opencode"
MARKER_BEGIN="# BEGIN opentelemetry-instrumentation-opencode"
MARKER_END="# END opentelemetry-instrumentation-opencode"

# ---------------------------------------------------------------------------
# 语言检测 / Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${OTEL_OPENCODE_LANG:-}" ]; then echo "$OTEL_OPENCODE_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local al
        al=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$al" ]; then echo "zh"; return; fi
        local aloc
        aloc=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$aloc" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)

msg() {
    local zh="$1"
    local en="$2"
    if [ "$LANG_MODE" = "zh" ]; then echo "$zh"; else echo "$en"; fi
}

# ---------------------------------------------------------------------------

msg "================================================" \
    "================================================"
msg " OpenTelemetry for OpenCode — 卸载" \
    " OpenTelemetry for OpenCode — Uninstall"
msg "================================================" \
    "================================================"
echo ""

# ---------------------------------------------------------------------------
# 1. 清理 shell profile 中的 env 配置块
# ---------------------------------------------------------------------------
msg "==> 清理 shell 环境变量配置..." \
    "==> Removing env config from shell profiles..."

remove_block_from_file() {
    local file="$1"
    [ -f "$file" ] || return 0
    if ! grep -q "${MARKER_BEGIN}" "$file" 2>/dev/null; then
        return 0
    fi
    local tmp
    tmp=$(mktemp)
    sed "/^${MARKER_BEGIN}$/,/^${MARKER_END}$/d" "$file" > "$tmp" && mv "$tmp" "$file"
    msg "    ✅ 已从 ${file} 删除配置块" \
        "    ✅ Removed config block from ${file}"
}

remove_block_from_file "$HOME/.bashrc"       || true
remove_block_from_file "$HOME/.zshrc"        || true
remove_block_from_file "$HOME/.bash_profile" || true

# 检查是否有任何 profile 里有配置 / Check if any profile had the block
if ! grep -ql "${MARKER_BEGIN}" "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" 2>/dev/null; then
    : # already cleaned
fi
echo ""

# ---------------------------------------------------------------------------
# 2. 从 opencode 配置移除插件 / Remove plugin from opencode config
# ---------------------------------------------------------------------------
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
msg "==> 从 opencode 配置移除插件..." \
    "==> Removing plugin from opencode config..."

if [ -f "$OPENCODE_CONFIG" ] && command -v node &>/dev/null; then
    node << NODEOF
const fs = require("fs");
const path = "$OPENCODE_CONFIG";
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, "utf-8")); } catch { process.exit(0); }
if (!Array.isArray(cfg.plugin)) process.exit(0);
const before = cfg.plugin.length;
cfg.plugin = cfg.plugin.filter(p => p !== "$PKG_NAME");
if (cfg.plugin.length !== before) {
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    process.stderr.write("    ✅ 已从配置移除插件\n");
} else {
    process.stderr.write("    ℹ️  配置中未找到插件，跳过\n");
}
NODEOF
else
    msg "    ℹ️  opencode 配置不存在或 node 不可用，跳过" \
        "    ℹ️  opencode config not found or node unavailable, skipping"
fi
echo ""

# ---------------------------------------------------------------------------
# 3. 删除插件入口文件 / Remove plugin entry file
# ---------------------------------------------------------------------------
msg "==> 删除插件入口文件..." \
    "==> Removing plugin entry file..."

OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_ENTRY="$OPENCODE_CONFIG_DIR/plugins/opentelemetry-instrumentation-opencode.ts"

if [ -f "$PLUGIN_ENTRY" ]; then
    rm -f "$PLUGIN_ENTRY"
    msg "    ✅ 已删除 ${PLUGIN_ENTRY}" \
        "    ✅ Deleted ${PLUGIN_ENTRY}"
else
    msg "    ℹ️  ${PLUGIN_ENTRY} 不存在，跳过" \
        "    ℹ️  ${PLUGIN_ENTRY} not found, skipping"
fi

# Also clean up stale tgz/package.json from previous install method
for tgz in "$OPENCODE_CONFIG_DIR"/loongsuite-opentelemetry-instrumentation-opencode-*.tgz; do
    [ -f "$tgz" ] && rm -f "$tgz" && msg "    ✅ 已删除旧 tgz: ${tgz}" "    ✅ Removed stale tgz: ${tgz}" || true
done
echo ""

# ---------------------------------------------------------------------------
# 4. 完成 / Done
# ---------------------------------------------------------------------------
msg "================================================" \
    "================================================"
msg " ✅ 卸载完成！" \
    " ✅ Uninstall complete!"
msg "================================================" \
    "================================================"
echo ""
msg "注意：" \
    "Notes:"
msg "  - 重新加载 shell 使环境变量失效：source ~/.bashrc" \
    "  - Reload shell to deactivate env vars: source ~/.bashrc"
msg "  - opencode 插件列表需手动从 opencode 配置中移除" \
    "  - Remove the plugin entry from your opencode config manually if needed"
echo ""
