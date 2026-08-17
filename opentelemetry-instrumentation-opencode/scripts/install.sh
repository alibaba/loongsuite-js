#!/usr/bin/env bash
# install.sh — Install opentelemetry-instrumentation-opencode as a local file plugin
#
# How it works:
#   opencode supports local TS plugins: a single .ts file in ~/.config/opencode/plugins/
#   that re-exports the Plugin function. Dependencies are resolved from the source
#   directory's node_modules.
#
# Usage:
#   bash scripts/install.sh [options]
#
# Options:
#   --endpoint <url>         OTLP exporter endpoint (base URL, appended with /v1/traces etc.)
#   --traces-endpoint <url>  Per-signal OTLP traces endpoint (full URL, overrides --endpoint for traces)
#   --metrics-endpoint <url> Per-signal OTLP metrics endpoint (full URL, overrides --endpoint for metrics)
#   --logs-endpoint <url>    Per-signal OTLP logs endpoint (full URL, overrides --endpoint for logs)
#   --headers <k=v,k=v>      OTLP headers (comma-separated key=value)
#   --service-name <name>    Service name (written to OTEL_SERVICE_NAME)
#   --debug                  Enable debug mode (console output, no backend needed)
#   --lang zh|en             Force output language

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PKG_NAME="@loongsuite/opentelemetry-instrumentation-opencode"
PLUGIN_ENTRY_NAME="opentelemetry-instrumentation-opencode.ts"
MARKER_BEGIN="# BEGIN opentelemetry-instrumentation-opencode"
MARKER_END="# END opentelemetry-instrumentation-opencode"

OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGINS_DIR="$OPENCODE_CONFIG_DIR/plugins"
PLUGIN_ENTRY="$PLUGINS_DIR/$PLUGIN_ENTRY_NAME"

# ---------------------------------------------------------------------------
# 参数解析 / Argument parsing
# ---------------------------------------------------------------------------
ENDPOINT=""
TRACES_ENDPOINT=""
METRICS_ENDPOINT=""
LOGS_ENDPOINT=""
HEADERS=""
SERVICE_NAME=""
DEBUG_MODE="false"
FORCE_LANG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint)       ENDPOINT="$2"; shift 2 ;;
    --endpoint=*)     ENDPOINT="${1#--endpoint=}"; shift ;;
    --traces-endpoint)   TRACES_ENDPOINT="$2"; shift 2 ;;
    --traces-endpoint=*) TRACES_ENDPOINT="${1#--traces-endpoint=}"; shift ;;
    --metrics-endpoint)   METRICS_ENDPOINT="$2"; shift 2 ;;
    --metrics-endpoint=*) METRICS_ENDPOINT="${1#--metrics-endpoint=}"; shift ;;
    --logs-endpoint)   LOGS_ENDPOINT="$2"; shift 2 ;;
    --logs-endpoint=*) LOGS_ENDPOINT="${1#--logs-endpoint=}"; shift ;;
    --headers)        HEADERS="$2"; shift 2 ;;
    --headers=*)      HEADERS="${1#--headers=}"; shift ;;
    --service-name)   SERVICE_NAME="$2"; shift 2 ;;
    --service-name=*) SERVICE_NAME="${1#--service-name=}"; shift ;;
    --debug)          DEBUG_MODE="true"; shift ;;
    --lang)           FORCE_LANG="$2"; shift 2 ;;
    --lang=*)         FORCE_LANG="${1#--lang=}"; shift ;;
    -h|--help)
      echo "Usage: bash scripts/install.sh [--endpoint <url>] [--traces-endpoint <url>] [--metrics-endpoint <url>] [--logs-endpoint <url>] [--headers <k=v>] [--service-name <name>] [--debug]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# 语言检测 / Language detection
# ---------------------------------------------------------------------------
detect_lang() {
    if [ -n "${FORCE_LANG:-}" ]; then echo "$FORCE_LANG"; return; fi
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
msg " OpenTelemetry for OpenCode — 安装" \
    " OpenTelemetry for OpenCode — Install"
msg "================================================" \
    "================================================"
echo ""

# ---------------------------------------------------------------------------
# 1. 检查 opencode / Check opencode
# ---------------------------------------------------------------------------
msg "==> 检查 opencode..." \
    "==> Checking opencode..."
if ! command -v opencode &>/dev/null; then
    msg "    ⚠️  未检测到 opencode，请先安装：" \
        "    ⚠️  opencode not found. Install it first:"
    echo "       npm install -g @opencode-ai/cli"
    echo "       # or: https://opencode.ai/docs/installation"
    echo ""
else
    OPENCODE_VER=$(opencode --version 2>/dev/null || echo "unknown")
    msg "    ✅ opencode 已安装 (${OPENCODE_VER})" \
        "    ✅ opencode detected (${OPENCODE_VER})"
fi
echo ""

# ---------------------------------------------------------------------------
# 2. 安装源码依赖 / Install source dependencies
# ---------------------------------------------------------------------------
msg "==> 安装插件依赖（npm install）..." \
    "==> Installing plugin dependencies (npm install)..."

cd "$PKG_DIR"
if npm install --silent 2>/tmp/npm-install-opencode-err.log; then
    msg "    ✅ 依赖安装完成" \
        "    ✅ Dependencies installed"
else
    if grep -qi "EACCES\|permission denied" /tmp/npm-install-opencode-err.log 2>/dev/null; then
        msg "    ❌ 安装失败：目录权限不足" \
            "    ❌ Install failed: permission denied"
        echo ""
        msg "    💡 修复：使用 nvm 管理 Node" \
            "    💡 Fix: use nvm to manage Node"
        echo "       curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
        echo "       nvm install --lts && nvm use --lts"
    else
        msg "    ❌ npm install 失败，详情：" \
            "    ❌ npm install failed. Details:"
        cat /tmp/npm-install-opencode-err.log
    fi
    exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# 3. 写入口文件到 plugins/ / Write plugin entry file
# ---------------------------------------------------------------------------
msg "==> 写入插件入口文件..." \
    "==> Writing plugin entry file..."

mkdir -p "$PLUGINS_DIR"

# Remove stale loose files that may have been left by previous installs
for stale in index.ts config.ts util.ts otel.ts probe.ts types.ts; do
    rm -f "$PLUGINS_DIR/$stale"
done
for stale_dir in handlers; do
    rm -rf "${PLUGINS_DIR:?}/$stale_dir"
done

# Build env-injection lines (only for non-empty values)
# These are embedded as process.env ||= defaults so the plugin works
# even in shells where the profile (bashrc/zshenv) wasn't sourced yet.
_ENV_LINES=""
if [ -n "$ENDPOINT" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_EXPORTER_OTLP_ENDPOINT\"] ||= \"${ENDPOINT}\";"
fi
if [ -n "$TRACES_ENDPOINT" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT\"] ||= \"${TRACES_ENDPOINT}\";"
fi
if [ -n "$METRICS_ENDPOINT" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT\"] ||= \"${METRICS_ENDPOINT}\";"
fi
if [ -n "$LOGS_ENDPOINT" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT\"] ||= \"${LOGS_ENDPOINT}\";"
fi
if [ -n "$SERVICE_NAME" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_SERVICE_NAME\"] ||= \"${SERVICE_NAME}\";"
fi
if [ -n "$HEADERS" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_EXPORTER_OTLP_HEADERS\"] ||= \"${HEADERS}\";"
fi
if [ -n "${LOONGSUITE_SEMCONV_DIALECT_NAME:-}" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"LOONGSUITE_SEMCONV_DIALECT_NAME\"] ||= \"${LOONGSUITE_SEMCONV_DIALECT_NAME}\";"
fi
if [ "$DEBUG_MODE" = "true" ]; then
    _ENV_LINES="${_ENV_LINES}
process.env[\"CLAUDE_TELEMETRY_DEBUG\"] ||= \"1\";"
fi
_ENV_LINES="${_ENV_LINES}
process.env[\"OTEL_LOGS_EXPORTER\"] ||= \"otlp\";"

cat > "$PLUGIN_ENTRY" << ENTRY
// Auto-generated by install.sh — do not edit manually.
// Dependencies are resolved from: ${PKG_DIR}/node_modules
// Env defaults below are applied only if not already set in the shell environment,
// ensuring the plugin works regardless of whether the shell profile was sourced.
${_ENV_LINES}
import { OtelPlugin } from "${PKG_DIR}/src/index.ts"
export default OtelPlugin
ENTRY

msg "    ✅ 已写入 ${PLUGIN_ENTRY}" \
    "    ✅ Written to ${PLUGIN_ENTRY}"
echo ""

# ---------------------------------------------------------------------------
# 4. 确保 opencode.json 中不包含此包名 / Ensure pkg not in opencode.json plugin array
# ---------------------------------------------------------------------------
msg "==> 检查 opencode.json 配置..." \
    "==> Checking opencode.json..."

OPENCODE_JSON="$OPENCODE_CONFIG_DIR/opencode.json"
mkdir -p "$OPENCODE_CONFIG_DIR"

if [ ! -f "$OPENCODE_JSON" ]; then
    echo '{"$schema":"https://opencode.ai/config.json"}' > "$OPENCODE_JSON"
fi

if command -v node &>/dev/null; then
    node << NODEOF
const fs = require("fs");
const path = "$OPENCODE_JSON";
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, "utf-8")); } catch { cfg = {}; }
const pkg = "$PKG_NAME";
let changed = false;
if (Array.isArray(cfg.plugin) && cfg.plugin.includes(pkg)) {
    cfg.plugin = cfg.plugin.filter(p => p !== pkg);
    if (cfg.plugin.length === 0) delete cfg.plugin;
    changed = true;
}
if (changed) {
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    process.stderr.write("    ℹ️  已从 opencode.json plugin 数组移除包名（本地文件插件不需要声明）\n");
} else {
    process.stderr.write("    ✅ opencode.json 无需修改\n");
}
NODEOF
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Sunfire 自动检测 / Sunfire endpoint auto-detection
# ---------------------------------------------------------------------------
if [ -n "$ENDPOINT" ] && echo "$ENDPOINT" | grep -qi "sunfire"; then
    if [ -z "${LOONGSUITE_SEMCONV_DIALECT_NAME:-}" ]; then
        LOONGSUITE_SEMCONV_DIALECT_NAME="ALIBABA_GROUP"
        msg "    💡 检测到 Sunfire 端点，自动设置 LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP" \
            "    💡 Sunfire endpoint detected — auto-setting LOONGSUITE_SEMCONV_DIALECT_NAME=ALIBABA_GROUP"
    fi
fi

# ---------------------------------------------------------------------------
# 6. 写 env 块到 shell profile / Write env block to shell profiles
# ---------------------------------------------------------------------------
msg "==> 写入环境变量到 shell 配置文件..." \
    "==> Writing environment variables to shell profiles..."

build_env_block() {
    echo ""
    echo "${MARKER_BEGIN}"
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "export CLAUDE_TELEMETRY_DEBUG=1"
    fi
    if [ -n "$ENDPOINT" ]; then
        echo "export OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\""
    fi
    if [ -n "$TRACES_ENDPOINT" ]; then
        echo "export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=\"${TRACES_ENDPOINT}\""
    fi
    if [ -n "$METRICS_ENDPOINT" ]; then
        echo "export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=\"${METRICS_ENDPOINT}\""
    fi
    if [ -n "$LOGS_ENDPOINT" ]; then
        echo "export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=\"${LOGS_ENDPOINT}\""
    fi
    if [ -n "$HEADERS" ]; then
        echo "export OTEL_EXPORTER_OTLP_HEADERS=\"${HEADERS}\""
    fi
    if [ -n "$SERVICE_NAME" ]; then
        echo "export OTEL_SERVICE_NAME=\"${SERVICE_NAME}\""
    fi
    echo "export OTEL_LOGS_EXPORTER=otlp"
    if [ -n "${LOONGSUITE_SEMCONV_DIALECT_NAME:-}" ]; then
        echo "export LOONGSUITE_SEMCONV_DIALECT_NAME=\"${LOONGSUITE_SEMCONV_DIALECT_NAME}\""
    fi
    echo "${MARKER_END}"
}

write_env_to_profile() {
    local file="$1"
    [ -f "$file" ] || return 0
    if grep -q "${MARKER_BEGIN}" "$file" 2>/dev/null; then
        local tmp
        tmp=$(mktemp)
        sed "/^${MARKER_BEGIN}$/,/^${MARKER_END}$/d" "$file" > "$tmp" && mv "$tmp" "$file"
    fi
    build_env_block >> "$file"
    msg "    ✅ 已写入 ${file}" \
        "    ✅ Written to ${file}"
}

write_env_to_profile "$HOME/.bashrc"       || true
write_env_to_profile "$HOME/.zshrc"        || true
write_env_to_profile "$HOME/.bash_profile" || true

echo ""

# ---------------------------------------------------------------------------
# 7. 完成 / Done
# ---------------------------------------------------------------------------
msg "================================================" \
    "================================================"
msg " ✅ 安装完成！" \
    " ✅ Installation complete!"
msg "================================================" \
    "================================================"
echo ""
msg "后续步骤：" \
    "Next steps:"
echo ""
msg "1. 重新加载 shell 配置：" \
    "1. Reload your shell config:"
echo "   source ~/.bashrc   # or ~/.zshrc"
echo ""
msg "2. 启动 opencode（插件将自动加载）：" \
    "2. Start opencode (plugin loads automatically):"
echo "   opencode"
echo ""
msg "卸载：bash scripts/uninstall.sh" \
    "To uninstall: bash scripts/uninstall.sh"
echo ""
