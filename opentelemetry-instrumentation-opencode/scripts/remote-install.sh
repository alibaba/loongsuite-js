#!/usr/bin/env bash
# remote-install.sh — One-line remote installer for opentelemetry-instrumentation-opencode
#
# Basic usage:
#   curl -fsSL <URL>/remote-install.sh | bash
#
# With OTLP backend:
#   curl -fsSL <URL>/remote-install.sh | bash -s -- \
#     --endpoint "https://your-otlp-endpoint:4318" \
#     --service-name "my-agent"
#
# Options:
#   --endpoint <url>       OTLP exporter endpoint
#   --service-name <name>  Service name (OTEL_SERVICE_NAME)
#   --headers <k=v,k=v>    OTLP headers
#   --tarball-url <url>    Override the default tarball download URL
#   --lang zh|en           Force output language (default: auto-detect)
#   --debug                Enable verbose OTLP debug logging after install

set -euo pipefail

# ============================================================
# Defaults
# ============================================================
DEFAULT_TARBALL_URL="https://arms-apm-cn-hangzhou-pre.oss-cn-hangzhou.aliyuncs.com/agenttrack/opencode/opentelemetry-instrumentation-opencode.tar.gz"
TARBALL_URL="${OTEL_OPENCODE_TARBALL_URL:-$DEFAULT_TARBALL_URL}"
PLUGIN_NAME="opentelemetry-instrumentation-opencode"
INSTALL_DIR="${HOME}/.cache/opentelemetry.instrumentation.opencode/package"

ENDPOINT=""
SERVICE_NAME=""
HEADERS=""
DEBUG_FLAG=""
FORCE_LANG=""

# ============================================================
# Parse arguments
# ============================================================
while [[ $# -gt 0 ]]; do
    case "$1" in
        --endpoint)         ENDPOINT="$2"; shift 2 ;;
        --endpoint=*)       ENDPOINT="${1#--endpoint=}"; shift ;;
        --service-name|--serviceName)
                            SERVICE_NAME="$2"; shift 2 ;;
        --service-name=*|--serviceName=*)
                            SERVICE_NAME="${1#*=}"; shift ;;
        --headers)          HEADERS="$2"; shift 2 ;;
        --headers=*)        HEADERS="${1#--headers=}"; shift ;;
        --tarball-url)      TARBALL_URL="$2"; shift 2 ;;
        --tarball-url=*)    TARBALL_URL="${1#--tarball-url=}"; shift ;;
        --lang)             FORCE_LANG="$2"; shift 2 ;;
        --lang=*)           FORCE_LANG="${1#--lang=}"; shift ;;
        --debug)            DEBUG_FLAG="--debug"; shift ;;
        -h|--help)
            echo "Usage: bash remote-install.sh [--endpoint <url>] [--service-name <name>] [--headers <k=v>] [--debug]"
            exit 0 ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1 ;;
    esac
done

# ============================================================
# Language detection
# ============================================================
detect_lang() {
    if [ -n "${FORCE_LANG:-}" ]; then echo "$FORCE_LANG"; return; fi
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
msg "==> 检查依赖..." \
    "==> Checking dependencies..."

MISSING_DEPS=()
for cmd in node npm curl tar; do
    if ! command -v "$cmd" &>/dev/null; then
        MISSING_DEPS+=("$cmd")
    fi
done
if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    msg "    ❌ 缺少依赖: ${MISSING_DEPS[*]}" \
        "    ❌ Missing dependencies: ${MISSING_DEPS[*]}"
    exit 1
fi
msg "    ✅ 依赖检查通过" \
    "    ✅ Dependencies OK"
echo ""

# ============================================================
# Download tarball
# ============================================================
msg "==> 下载安装包..." \
    "==> Downloading tarball..."

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

TARBALL_FILE="$TMP_DIR/${PLUGIN_NAME}.tar.gz"

if ! curl -fsSL "$TARBALL_URL" -o "$TARBALL_FILE"; then
    msg "    ❌ 下载失败: $TARBALL_URL" \
        "    ❌ Download failed: $TARBALL_URL"
    exit 1
fi
msg "    ✅ 下载完成" \
    "    ✅ Downloaded"
echo ""

# ============================================================
# Extract to permanent location
# ============================================================
msg "==> 解压到 ${INSTALL_DIR}..." \
    "==> Extracting to ${INSTALL_DIR}..."

mkdir -p "$INSTALL_DIR"
tar -xzf "$TARBALL_FILE" -C "$INSTALL_DIR" --strip-components=0
msg "    ✅ 解压完成" \
    "    ✅ Extracted"
echo ""

# ============================================================
# Run install.sh with forwarded arguments
# ============================================================
msg "==> 执行安装脚本..." \
    "==> Running install.sh..."
echo ""

INSTALL_ARGS=()
[ -n "$ENDPOINT" ]     && INSTALL_ARGS+=("--endpoint" "$ENDPOINT")
[ -n "$SERVICE_NAME" ] && INSTALL_ARGS+=("--service-name" "$SERVICE_NAME")
[ -n "$HEADERS" ]      && INSTALL_ARGS+=("--headers" "$HEADERS")
[ -n "$DEBUG_FLAG" ]   && INSTALL_ARGS+=("--debug")
[ -n "$FORCE_LANG" ]   && INSTALL_ARGS+=("--lang" "$FORCE_LANG")

bash "$INSTALL_DIR/scripts/install.sh" "${INSTALL_ARGS[@]}"
