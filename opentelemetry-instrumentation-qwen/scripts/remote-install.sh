#!/usr/bin/env bash
# remote-install.sh — One-line remote installer for otel-qwen-hook
#
# Basic usage (install only):
#   curl -fsSL <URL>/remote-install.sh | bash
#
# With OTLP backend (recommended):
#   curl -fsSL <URL>/remote-install.sh | bash -s -- \
#     --endpoint "https://your-otlp-endpoint:4318" \
#     --service-name "my-qwen-agent"
#
# With authentication headers:
#   curl -fsSL <URL>/remote-install.sh | bash -s -- \
#     --endpoint "https://your-otlp-endpoint:4318" \
#     --headers "x-api-key=your-key,x-project=my-project" \
#     --service-name "my-qwen-agent"
#
# Other options:
#   --tarball-url <url>   Override the default tarball download URL
#   --lang zh|en          Force output language (default: auto-detect)
#   --debug               Enable verbose OTLP debug logging after install

# Copyright 2026 Alibaba Group Holding Limited
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# ============================================================
# Defaults
# ============================================================
DEFAULT_TARBALL_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/otel-qwen-hook.tar.gz"
TARBALL_URL="${OTEL_QWEN_TARBALL_URL:-$DEFAULT_TARBALL_URL}"
PLUGIN_NAME="otel-qwen-hook"

ENDPOINT=""
SERVICE_NAME=""
HEADERS=""
DEBUG_MODE=0
SEMCONV_DIALECT="ALIBABA_CLOUD"

# ============================================================
# Parse arguments
# ============================================================
while [[ $# -gt 0 ]]; do
    case "$1" in
        --endpoint)
            ENDPOINT="$2"; shift 2 ;;
        --endpoint=*)
            ENDPOINT="${1#--endpoint=}"; shift ;;
        --service-name|--serviceName)
            SERVICE_NAME="$2"; shift 2 ;;
        --service-name=*|--serviceName=*)
            SERVICE_NAME="${1#*=}"; shift ;;
        --headers)
            HEADERS="$2"; shift 2 ;;
        --headers=*)
            HEADERS="${1#--headers=}"; shift ;;
        --tarball-url)
            TARBALL_URL="$2"; shift 2 ;;
        --tarball-url=*)
            TARBALL_URL="${1#--tarball-url=}"; shift ;;
        --lang)
            export OTEL_QWEN_LANG="$2"; shift 2 ;;
        --lang=*)
            export OTEL_QWEN_LANG="${1#--lang=}"; shift ;;
        --debug)
            DEBUG_MODE=1; shift ;;
        --semconv-dialect)
            SEMCONV_DIALECT="$2"; shift 2 ;;
        --semconv-dialect=*)
            SEMCONV_DIALECT="${1#--semconv-dialect=}"; shift ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

# Auto-detect semconv dialect from endpoint
if [ "$SEMCONV_DIALECT" = "ALIBABA_CLOUD" ] && echo "$ENDPOINT" | grep -qi "sunfire"; then
    SEMCONV_DIALECT="ALIBABA_GROUP"
    echo "Sunfire endpoint detected — defaulting semconv dialect to ALIBABA_GROUP"
fi

# ============================================================
# Language detection
# ============================================================
detect_lang() {
    if [ -n "${OTEL_QWEN_LANG:-}" ]; then echo "$OTEL_QWEN_LANG"; return; fi
    for v in "${LANGUAGE:-}" "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
        if echo "$v" | grep -qi "zh"; then echo "zh"; return; fi
    done
    if [ "$(uname)" = "Darwin" ]; then
        local al
        al=$(defaults read -g AppleLanguages 2>/dev/null | grep -i "zh" | head -1 || true)
        if [ -n "$al" ]; then echo "zh"; return; fi
        local loc
        loc=$(defaults read -g AppleLocale 2>/dev/null || true)
        if echo "$loc" | grep -qi "zh"; then echo "zh"; return; fi
    fi
    if [ "$(uname -o 2>/dev/null || true)" = "Msys" ] || [ "$(uname -o 2>/dev/null || true)" = "Cygwin" ]; then
        local wloc
        wloc=$(reg query "HKCU\\Control Panel\\International" /v LocaleName 2>/dev/null | grep -o "zh[^[:space:]]*" | head -1 || true)
        if [ -n "$wloc" ]; then echo "zh"; return; fi
    fi
    echo "en"
}
LANG_MODE=$(detect_lang)
msg() { [ "$LANG_MODE" = "zh" ] && echo "$1" || echo "$2"; }

# ============================================================
# Start
# ============================================================
msg "🚀 开始安装 $PLUGIN_NAME ..." \
    "🚀 Installing $PLUGIN_NAME ..."
echo ""

# ============================================================
# Check dependencies
# ============================================================
msg "==> 检查依赖..." "==> Checking dependencies..."

for cmd in node npm; do
    if ! command -v "$cmd" &>/dev/null; then
        msg "❌ 缺少依赖: $cmd，请先安装后重试" \
            "❌ Missing dependency: $cmd — please install it first"
        exit 1
    fi
done

if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
    msg "❌ 需要 curl 或 wget，请先安装" \
        "❌ curl or wget is required — please install one first"
    exit 1
fi

msg "    ✅ node $(node --version)  npm $(npm --version)" \
    "    ✅ node $(node --version)  npm $(npm --version)"
echo ""

# ============================================================
# Download tarball
# ============================================================
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

msg "📦 下载安装包: $TARBALL_URL" \
    "📦 Downloading: $TARBALL_URL"

if command -v curl &>/dev/null; then
    curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/plugin.tar.gz"
else
    wget -q "$TARBALL_URL" -O "$TMP_DIR/plugin.tar.gz"
fi
msg "    ✅ 下载完成" "    ✅ Downloaded"
echo ""

# ============================================================
# Extract
# ============================================================
msg "==> 解压安装包..." "==> Extracting..."
if tar --warning=no-unknown-keyword -xzf "$TMP_DIR/plugin.tar.gz" -C "$TMP_DIR" 2>/dev/null; then
  :
else
  tar -xzf "$TMP_DIR/plugin.tar.gz" -C "$TMP_DIR"
fi

if [ -d "$TMP_DIR/$PLUGIN_NAME" ]; then
    INSTALL_SRC="$TMP_DIR/$PLUGIN_NAME"
elif [ -f "$TMP_DIR/scripts/install.sh" ]; then
    INSTALL_SRC="$TMP_DIR"
else
    INSTALL_SRC=$(find "$TMP_DIR" -name "install.sh" -path "*/scripts/install.sh" -exec dirname {} \; | head -1 | xargs dirname 2>/dev/null || true)
    if [ -z "$INSTALL_SRC" ]; then
        msg "❌ 解压后未找到 scripts/install.sh，tarball 结构异常" \
            "❌ scripts/install.sh not found in tarball — unexpected structure"
        exit 1
    fi
fi
msg "    ✅ 解压完成" "    ✅ Extracted"
echo ""

# ============================================================
# Copy package to a permanent location before running installer
# ============================================================
PERMANENT_DIR="$HOME/.cache/opentelemetry.instrumentation.qwen/package"
msg "==> 拷贝到永久目录 $PERMANENT_DIR ..." \
    "==> Copying to permanent directory $PERMANENT_DIR ..."
mkdir -p "$(dirname "$PERMANENT_DIR")"
rm -rf "$PERMANENT_DIR"
cp -r "$INSTALL_SRC" "$PERMANENT_DIR"
msg "    ✅ 拷贝完成" "    ✅ Copied"
echo ""

msg "==> 运行安装程序..." "==> Running installer..."
echo ""
cd "$PERMANENT_DIR"
chmod +x scripts/install.sh bin/otel-qwen-hook scripts/setup-alias.sh scripts/uninstall.sh 2>/dev/null || true
bash scripts/install.sh

# ============================================================
# Write OTLP environment config (if --endpoint was provided)
# ============================================================
if [ -n "$ENDPOINT" ]; then
    echo ""
    msg "==> 写入 OTLP 环境配置..." "==> Writing OTLP environment config..."

    ENV_LINES="export OTEL_EXPORTER_OTLP_ENDPOINT=\"${ENDPOINT}\""
    if [ -n "$SERVICE_NAME" ]; then
        ENV_LINES="${ENV_LINES}"$'\n'"export OTEL_SERVICE_NAME=\"${SERVICE_NAME}\""
    fi
    if [ -n "$HEADERS" ]; then
        ENV_LINES="${ENV_LINES}"$'\n'"export OTEL_EXPORTER_OTLP_HEADERS=\"${HEADERS}\""
    fi
    if [ "$DEBUG_MODE" -eq 1 ]; then
        ENV_LINES="${ENV_LINES}"$'\n'"export QWEN_TELEMETRY_DEBUG=1"
    fi
    if [ "$SEMCONV_DIALECT" != "ALIBABA_CLOUD" ]; then
        ENV_LINES="${ENV_LINES}"$'\n'"export LOONGSUITE_SEMCONV_DIALECT_NAME=\"${SEMCONV_DIALECT}\""
    fi

    write_env_block() {
        local file="$1"
        [ -f "$file" ] || return
        if grep -q "# BEGIN otel-qwen-hook-env" "$file" 2>/dev/null; then
            local tmp_clean
            tmp_clean=$(mktemp)
            sed '/# BEGIN otel-qwen-hook-env/,/# END otel-qwen-hook-env/d' "$file" > "$tmp_clean"
            mv "$tmp_clean" "$file"
        fi
        cat >> "$file" << ENVBLOCK

# BEGIN otel-qwen-hook-env
${ENV_LINES}
# END otel-qwen-hook-env
ENVBLOCK
        msg "    ✅ 已写入 $file" "    ✅ Written to $file"
    }

    write_env_block "$HOME/.bashrc"
    write_env_block "$HOME/.zshrc"
    write_env_block "$HOME/.bash_profile"
fi

# ============================================================
# Done
# ============================================================
echo ""
msg "✅ 安装完成！请执行以下命令使配置生效：" \
    "✅ Installation complete! Reload your shell to apply changes:"
echo "   source ~/.bashrc   # or source ~/.zshrc"
echo ""

if [ -z "$ENDPOINT" ]; then
    msg "⚠️  未配置遥测后端，请手动设置：" \
        "⚠️  No telemetry backend configured. Set one manually:"
    echo ""
    echo "   export OTEL_EXPORTER_OTLP_ENDPOINT='https://your-otlp-endpoint:4318'"
    echo "   export OTEL_SERVICE_NAME='my-qwen-agent'"
    echo ""
    msg "   或本地调试（无需后端）：" \
        "   Or for local debugging (no backend needed):"
    echo "   export QWEN_TELEMETRY_DEBUG=1"
    echo ""
else
    msg "📊 遥测后端: $ENDPOINT" "📊 Telemetry backend: $ENDPOINT"
    if [ -n "$SERVICE_NAME" ]; then
        msg "   服务名: $SERVICE_NAME" "   Service name: $SERVICE_NAME"
    fi
    echo ""
fi
